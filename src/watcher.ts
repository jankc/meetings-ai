// Watches recordings/inbox/ for new recording FOLDERS. Each recording is a folder named by its
// basename holding an audio file. Our producers publish atomically (folder-rename into inbox/), so
// a folder appearing here is complete by construction — but macOS fs.watch (FSEvents) is coarse and
// can coalesce/miss events, so we still (a) debounce + wait for the folder's audio to stabilize
// (defensive cover for a hand-dropped folder written incrementally), and (b) do a reconcile scan on
// boot to catch folders created while the daemon was down.
//
// What counts as "the folder's audio" is `folderAudioRanked` — ANY supported audio file, newest
// wins — the SAME rule the worker applies when it re-resolves a job at process time. The two must
// not diverge: a stricter gate here (once: only a literal `recording.<ext>`) meant a hand-edited
// folder could be processed correctly if it was already queued, yet could never ENTER the queue —
// so splitting one recording into two folders left the new folder stranded in inbox/ forever, since
// the boot reconcile applied the same strict gate.
import { existsSync, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Config } from "./config.ts";
import { folderAudioRanked } from "./recordings.ts";
import { sleep } from "./util.ts";
import { log } from "./log.ts";

// Stability poll: re-probe the folder every POLL_MS, and give a folder that has no audio yet
// MAX_MISSES polls for one to land before giving up on it.
const POLL_MS = 2000;
const MAX_MISSES = 15;

export interface WatcherHandle {
  close(): void;
}

export function startWatcher(cfg: Config, onStable: (wav: string) => void): WatcherHandle {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  // Debounce a folder, then verify its audio is size-stable before enqueuing. Shared by the live
  // watch AND the boot reconcile, so neither path can enqueue a still-being-written file.
  const schedule = (folder: string) => {
    const existing = pending.get(folder);
    if (existing) clearTimeout(existing);
    pending.set(folder, setTimeout(() => void debounceStable(folder, pending, onStable), 1000));
  };

  void reconcile(cfg, schedule);

  // recursive: a hand-dropped folder may be created first and its audio written later; recursive
  // watching delivers that inner-file event (as "<base>/<file>"), so a slow copy re-arms the
  // debounce instead of being missed. Our own producers publish atomically (whole folder renamed
  // in), so for them the folder is complete on the first event regardless.
  const watcher = watch(cfg.paths.inboxDir, { persistent: true, recursive: true }, (_event, fname) => {
    if (!fname) return;
    // The first path segment under inbox/ is the recording FOLDER (fs.watch may hand us the folder
    // name or a path inside it). Skip dotfiles / staging leftovers (never a recording folder).
    const top = fname.toString().split("/")[0];
    if (!top || top.startsWith(".")) return;
    schedule(join(cfg.paths.inboxDir, top));
  });
  log.info("watcher", `watching ${cfg.paths.inboxDir}`);
  return { close: () => watcher.close() };
}

async function debounceStable(
  folder: string,
  pending: Map<string, ReturnType<typeof setTimeout>>,
  onStable: (wav: string) => void,
): Promise<void> {
  let prev = -1;
  let prevPath: string | null = null;
  let misses = 0;
  let rec: string | null = null;
  for (;;) {
    // Newest audio wins, and we take it from the ranked list rather than via folderAudio() so this
    // 2s poll doesn't repeat folderAudio's "ignoring stale sibling" warning — that log belongs to
    // the worker's one-shot resolve, which reports the choice actually processed.
    rec = (await folderAudioRanked(folder))[0] ?? null;
    if (!rec) {
      // Folder gone: it was moved on (the worker's own inbox → processed rename is itself an event
      // that wakes us here) or deleted. Nothing to wait for, and nothing worth reporting.
      if (!existsSync(folder)) {
        pending.delete(folder);
        return;
      }
      // Folder is there but holds no audio yet. For an atomic publish it's present on the first
      // poll; give a hand-dropped folder a bounded grace for the file to land, then give up.
      if (++misses > MAX_MISSES) {
        pending.delete(folder);
        // Say so instead of dropping silently: nothing retries this until the next daemon boot, so
        // a stalled copy or a folder holding an unsupported format would otherwise just sit in
        // inbox/ looking queued with no trace of why it never ran.
        log.warn(
          "watcher",
          `${basename(folder)}: no supported audio after ${(MAX_MISSES * POLL_MS) / 1000}s — ignoring (unsupported format, or the copy never finished; re-drop the folder to retry)`,
        );
        return;
      }
      await sleep(POLL_MS);
      continue;
    }
    // A different file leads than on the last poll (a second audio landed, or one was swapped in):
    // restart the measurement against the new winner instead of comparing sizes across two files,
    // which could otherwise read as "stable" when they happen to match.
    if (rec !== prevPath) {
      prevPath = rec;
      prev = -1;
    }
    const size = Bun.file(rec).size;
    if (size > 0 && size === prev) break; // producer done writing
    prev = size;
    await sleep(POLL_MS);
  }
  pending.delete(folder);
  log.info("watcher", `stable: ${rec}`);
  onStable(rec);
}

// On boot, scan only inbox/ for recording folders — processed/ recordings are done by definition
// (the folder IS the state), so they're never re-examined. This is the whole point of the move
// model, and it rebuilds the work-list (incl. after a layout migration) from the actual inbox.
// Each folder goes through the same `schedule` (debounce + size-stability) as a live event, so a
// folder still being copied when the daemon boots is not enqueued until it stops growing.
async function reconcile(cfg: Config, schedule: (folder: string) => void): Promise<void> {
  try {
    const entries = await readdir(cfg.paths.inboxDir, { withFileTypes: true });
    const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
    let found = 0;
    for (const e of folders) {
      const folder = join(cfg.paths.inboxDir, e.name);
      if ((await folderAudioRanked(folder)).length > 0) {
        schedule(folder);
        found++;
      }
    }
    if (found) log.info("watcher", `reconcile: ${found} recording(s) in inbox`);
  } catch (err) {
    log.warn("watcher", `reconcile scan failed: ${String(err)}`);
  }
}
