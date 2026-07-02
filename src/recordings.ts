// Recording lifecycle: a recording's FOLDER is its state. This module is the single place that
// knows where a recording's folder currently lives and how it moves between lifecycle dirs:
//   .partial → inbox → processed/<YYYY-MM>   (success)
//                    → failed                 (non-retryable failure)
// The folder (named by basename) holds every artifact (recording.<ext>, transcript.txt, …) and
// moves as one unit. Reused by the worker, the inline CLI path, the control API, and the
// archiver — so the folder-as-state rules live in exactly one file.
import { statSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename as pathBasename, dirname, isAbsolute, join } from "node:path";
import type { Config } from "./config.ts";
import { ARTIFACTS, KNOWN_AUDIO_EXTS, isRecordingFile, stripAudioExt } from "./paths.ts";
import { monthOf } from "./stamp.ts";
import { log } from "./log.ts";

/** True if `p` exists and is a directory (sync stat — cheap, used inside the async locate glob). */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Locate a recording's FOLDER by bare basename, wherever it currently sits in its lifecycle
 *  (inbox → failed → processed/<month>). Returns the folder dir or null. */
export async function locate(cfg: Config, base: string): Promise<string | null> {
  for (const dir of [cfg.paths.inboxDir, cfg.paths.failedDir]) {
    const folder = join(dir, base);
    if (isDir(folder)) return folder;
  }
  // processed/ is partitioned by month — glob for the <base>/ folder. The dir may not exist yet
  // (a fresh base, or `murmur import` before the daemon's first run) — treat that as "not there".
  try {
    const glob = new Bun.Glob(`*/${base}`);
    for await (const rel of glob.scan({ cwd: cfg.paths.processedDir, onlyFiles: false })) {
      const folder = join(cfg.paths.processedDir, rel);
      if (isDir(folder)) return folder;
    }
  } catch {
    /* processed/ absent → not found */
  }
  return null;
}

/** The recording audio file (`recording.<ext>`) inside a folder, or null. Imports keep their
 *  original extension, so probe each known ext (case-sensitive, lowercase — see paths.ts). */
export async function recordingFileIn(folder: string): Promise<string | null> {
  for (const ext of KNOWN_AUDIO_EXTS) {
    const p = join(folder, ARTIFACTS.recording(ext));
    if (await Bun.file(p).exists()) return p;
  }
  return null;
}

/** The recording audio in a folder — ANY single `KNOWN_AUDIO_EXTS` file, not just the
 *  `recording.<ext>` stem, so a recording trimmed and re-saved under a different name/extension
 *  (e.g. a QuickTime "save as" → `trimmed.m4a`, or `flac`→`m4a`) is still found. When several
 *  audio files coexist — the classic case being a trimmed copy left beside the untrimmed original
 *  — the most recently modified one wins (that's the edit the user just made) and the stale
 *  sibling(s) are logged so the choice is visible. Returns the path, or null if the folder holds
 *  no audio (or is gone). The folder's other artifacts (transcript.txt, summary.md, asr.log,
 *  context.md) are non-audio and excluded by the extension filter. */
export async function folderAudio(folder: string): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(folder)).filter((n) => !n.startsWith(".") && isRecordingFile(n));
  } catch {
    return null; // folder gone
  }
  // Newest mtime wins; a failed stat sorts last (mtime 0) so it's never chosen over a readable
  // file. Ties (rare) keep readdir order, deterministic enough here.
  const ranked = names
    .map((n) => {
      const p = join(folder, n);
      let mtimeMs = 0;
      try { mtimeMs = statSync(p).mtimeMs; } catch { /* unreadable → sorts last */ }
      return { p, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const winner = ranked[0];
  if (!winner) return null; // no audio in the folder
  const stale = ranked.slice(1);
  if (stale.length > 0) {
    log.warn(
      "recordings",
      `${pathBasename(folder)}: ${ranked.length} audio files — using newest ${pathBasename(winner.p)}, ignoring ${stale.map((s) => pathBasename(s.p)).join(", ")}`,
    );
  }
  return winner.p;
}

/** If `recordingFile` is a managed recording — a `recording.<ext>` directly inside a lifecycle
 *  folder (`<inbox|failed|processed/<month>>/<base>/`) — return its `<base>` folder name, else null
 *  (an external one-off path). This is LOCATION-based, not name-based, so a file literally named
 *  `recording.wav` that lives outside the store is correctly treated as external. */
function managedFolderOf(cfg: Config, recordingFile: string): string | null {
  const parent = dirname(recordingFile); // <base>/
  const grandparent = dirname(parent); // the lifecycle dir
  const managed =
    grandparent === cfg.paths.inboxDir ||
    grandparent === cfg.paths.failedDir ||
    dirname(grandparent) === cfg.paths.processedDir; // processed/<month>/<base>/recording.<ext>
  return managed ? pathBasename(parent) : null;
}

/** The recording's key (folder name) for a recording file: the `<base>` folder for a managed
 *  recording, otherwise the filename stem (an external one-off path). Use this — never
 *  `basename(dirname(...))` — so external paths and files named `recording.<ext>` key correctly. */
export function recordingBase(cfg: Config, recordingFile: string): string {
  return managedFolderOf(cfg, recordingFile) ?? stripAudioExt(pathBasename(recordingFile));
}

/** True when `recordingFile` is a managed recording under the lifecycle dirs — i.e. it's safe to
 *  resolve it by basename via `locate`/`move`/`logFailure`. False for an external one-off path
 *  (which must not be moved/relocated by a basename that could collide with a managed recording). */
export function isManagedRecording(cfg: Config, recordingFile: string): boolean {
  return managedFolderOf(cfg, recordingFile) !== null;
}

/** Re-resolve a queued job's recording file from its folder — location is the state. A recording
 *  edited while queued (trimmed & re-saved as flac→m4a, or under a new name) resolves to the file
 *  that's actually on disk now, so the worker processes it on the FIRST run instead of failing on
 *  the stale queued path and only succeeding after a manual retry-failed/reprocess. Managed
 *  recordings resolve by basename via `locate` + `folderAudio`; an external one-off path, or a
 *  folder with no audio, returns `queuedPath` unchanged (the caller then fails on the missing path,
 *  exactly as it does today — resolution never invents a wrong file). */
export async function currentAudioFor(cfg: Config, base: string, queuedPath: string): Promise<string> {
  if (!isManagedRecording(cfg, queuedPath)) return queuedPath;
  const folder = await locate(cfg, base);
  const fresh = folder ? await folderAudio(folder) : null;
  return fresh ?? queuedPath;
}

/** Resolve an /enqueue or CLI argument (absolute path, cwd-relative path, or bare basename) to an
 *  existing recording file. An absolute/cwd path is returned as-is if it exists; otherwise the
 *  argument is treated as a basename and resolved to the `recording.<ext>` inside its located
 *  folder. Returns the path or null if not found. */
export async function resolveWav(cfg: Config, input: string): Promise<string | null> {
  if (isAbsolute(input)) return (await Bun.file(input).exists()) ? input : null;
  const cwd = join(process.cwd(), input);
  if (await Bun.file(cwd).exists()) return cwd;
  const folder = await locate(cfg, stripAudioExt(pathBasename(input)));
  return folder ? folderAudio(folder) : null;
}

/** Move a recording's whole FOLDER to its terminal lifecycle dir (location = state). Atomic
 *  (a single directory rename) within one filesystem, with a copy+unlink fallback on EXDEV.
 *  Best-effort: a move failure is logged but never turns a successful job into a failed one.
 *  Idempotent — a no-op when the folder is already in its terminal home. Returns the destination
 *  folder, or null if there was nothing to move. */
export async function move(cfg: Config, base: string, to: "processed" | "failed"): Promise<string | null> {
  const src = await locate(cfg, base);
  if (!src) return null; // already moved, or recorded elsewhere
  const dest =
    to === "processed"
      ? join(cfg.paths.processedDir, monthOf(base, statSync(src).mtime), base)
      : join(cfg.paths.failedDir, base);
  if (src === dest) return dest; // already in its terminal home
  try {
    await mkdir(dirname(dest), { recursive: true });
    // Reprocessing re-drops a recording into inbox/ even when a prior run already sits in its
    // terminal home; replace that stale folder so the fresh artifacts win. (The flat model got
    // this for free — rename() overwrote the file.) A directory rename onto a non-empty dir would
    // otherwise fail and strand the folder in inbox/ for an endless reprocess loop. rm is a no-op
    // when dest is absent (the common case).
    await rm(dest, { recursive: true, force: true });
    try {
      await rename(src, dest); // atomic within the same filesystem
    } catch (err) {
      // Cross-device rename (MEETINGS_BASE spanning filesystems): copy into a temp on the dest fs,
      // atomically swap it in, then drop the source — so a failed copy never leaves a partial dest
      // under a live lifecycle path, and src stays intact until the copy is fully in place. Rare:
      // the lifecycle dirs normally all live under recordingsDir (one fs).
      if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
      const tmp = `${dest}.copying-${process.pid}`;
      await rm(tmp, { recursive: true, force: true });
      try {
        await cp(src, tmp, { recursive: true });
        await rename(tmp, dest);
        await rm(src, { recursive: true, force: true });
      } catch (err2) {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
        throw err2;
      }
    }
    log.info("recordings", `moved ${base} → ${to}`);
    return dest;
  } catch (err) {
    log.warn("recordings", `could not move ${base} → ${to}: ${String(err)}`);
    return null;
  }
}
