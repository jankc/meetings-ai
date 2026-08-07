// Watcher folder detection. The deterministic part — the boot reconcile that enumerates inbox/*/
// folders and enqueues the complete ones — is exercised here; the live fs.watch debounce is timing
// dependent and covered by the end-to-end verification instead.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaths } from "./paths.ts";
import { startWatcher, type WatcherHandle } from "./watcher.ts";
import { sleep } from "./util.ts";
import type { Config } from "./config.ts";

let base: string;
let cfg: Config;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "murmur-watch-"));
  cfg = { paths: buildPaths(base) } as unknown as Config;
  mkdirSync(cfg.paths.inboxDir, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

async function makeRecording(name: string, ext = ".flac"): Promise<string> {
  return makeAudio(name, `recording${ext}`);
}

/** Put an arbitrarily named audio file inside an inbox folder, returning its path. */
async function makeAudio(folder: string, file: string): Promise<string> {
  const dir = join(cfg.paths.inboxDir, folder);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, file);
  await Bun.write(p, "audio-bytes");
  return p;
}

/** Start the watcher, collect onStable calls until `want` of them arrive (or timeout), then close.
 *  Reconcile now routes through the size-stability debounce (~3s), so allow a generous budget;
 *  the poll returns as soon as `want` callbacks land. */
async function collectReconcile(want: number): Promise<string[]> {
  const seen: string[] = [];
  let handle: WatcherHandle | null = null;
  try {
    handle = startWatcher(cfg, (wav) => seen.push(wav));
    for (let i = 0; i < 400 && seen.length < want; i++) await sleep(25); // up to ~10s
  } finally {
    handle?.close();
  }
  return seen.sort();
}

describe("watcher boot reconcile", () => {
  test("enqueues complete recording folders, preserving each extension", async () => {
    const a = await makeRecording("meeting-1");
    const b = await makeRecording("meeting-2", ".m4a");
    expect(await collectReconcile(2)).toEqual([a, b].sort());
  }, 15000);

  test("ignores a folder with no recording file", async () => {
    mkdirSync(join(cfg.paths.inboxDir, "not-a-recording"), { recursive: true });
    const a = await makeRecording("meeting-1");
    // Only the real recording should be enqueued (the empty folder is never scheduled).
    expect(await collectReconcile(1)).toEqual([a]);
  }, 15000);

  // The regression: hand-editing a recording (splitting one capture into two meetings) produces a
  // folder whose audio is NOT named recording.<ext>. It used to be invisible to both the live watch
  // and this reconcile, so it sat in inbox/ forever — while the worker, which resolves any audio at
  // process time, would have handled it fine had it ever been queued.
  test("enqueues a folder whose audio is not named recording.<ext>", async () => {
    const a = await makeAudio("meeting-split-b", "kuba.m4a");
    expect(await collectReconcile(1)).toEqual([a]);
  }, 15000);

  test("enqueues the newest audio when a split half sits beside the original", async () => {
    const orig = await makeAudio("meeting-1", "recording.flac");
    const split = await makeAudio("meeting-1", "vsem.m4a");
    utimesSync(orig, new Date(1_000_000), new Date(1_000_000));
    utimesSync(split, new Date(2_000_000), new Date(2_000_000));
    expect(await collectReconcile(1)).toEqual([split]);
  }, 15000);

  test("ignores a folder holding only non-audio artifacts", async () => {
    const junk = join(cfg.paths.inboxDir, "notes");
    mkdirSync(junk, { recursive: true });
    await Bun.write(join(junk, "transcript.txt"), "not audio");
    const a = await makeRecording("meeting-1");
    expect(await collectReconcile(1)).toEqual([a]);
  }, 15000);
});
