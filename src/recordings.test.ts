// Folder-based locate / resolveWav / move — the folder-as-state lifecycle, against a throwaway
// temp $MEETINGS_BASE. A recording is a folder named by its basename holding recording.<ext>.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaths } from "./paths.ts";
import { locate, resolveWav, move, folderAudio, folderAudioRanked, currentAudioFor, recordingBase, isManagedRecording } from "./recordings.ts";
import type { Config } from "./config.ts";

let base: string;
let cfg: Config;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "murmur-rec-"));
  cfg = { paths: buildPaths(base) } as unknown as Config;
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Create a recording folder <lifecycleDir>/<name>/recording.<ext> and return the folder dir. */
async function makeRecording(lifecycleDir: string, name: string, ext = ".flac"): Promise<string> {
  const folder = join(lifecycleDir, name);
  mkdirSync(folder, { recursive: true });
  await Bun.write(join(folder, `recording${ext}`), "audio-bytes");
  return folder;
}

const STAMP = "meeting-2026-06-18_10-00-00"; // parses to month 2026-06

describe("locate", () => {
  test("finds a recording folder in inbox", async () => {
    const folder = await makeRecording(cfg.paths.inboxDir, STAMP);
    expect(await locate(cfg, STAMP)).toBe(folder);
  });

  test("finds a recording folder in failed", async () => {
    const folder = await makeRecording(cfg.paths.failedDir, STAMP);
    expect(await locate(cfg, STAMP)).toBe(folder);
  });

  test("finds a recording folder in processed/<YYYY-MM>", async () => {
    const folder = await makeRecording(join(cfg.paths.processedDir, "2026-06"), STAMP);
    expect(await locate(cfg, STAMP)).toBe(folder);
  });

  test("returns null when the recording does not exist", async () => {
    expect(await locate(cfg, "meeting-nope")).toBeNull();
  });
});

describe("resolveWav", () => {
  test("resolveWav resolves a bare basename to the in-folder recording file", async () => {
    const folder = await makeRecording(join(cfg.paths.processedDir, "2026-06"), STAMP);
    expect(await resolveWav(cfg, STAMP)).toBe(join(folder, "recording.flac"));
  });

  test("resolveWav returns an existing absolute path as-is", async () => {
    const folder = await makeRecording(cfg.paths.inboxDir, STAMP);
    const abs = join(folder, "recording.flac");
    expect(await resolveWav(cfg, abs)).toBe(abs);
  });

  test("resolveWav returns null for an unknown basename", async () => {
    expect(await resolveWav(cfg, "meeting-nope")).toBeNull();
  });
});

describe("folderAudio", () => {
  test("finds the single recording regardless of extension", async () => {
    const folder = await makeRecording(cfg.paths.inboxDir, STAMP, ".m4a");
    expect(await folderAudio(folder)).toBe(join(folder, "recording.m4a"));
  });

  test("finds an audio file saved under a different name (not the recording.<ext> stem)", async () => {
    const folder = join(cfg.paths.inboxDir, STAMP);
    mkdirSync(folder, { recursive: true });
    await Bun.write(join(folder, "trimmed.m4a"), "audio-bytes"); // a QuickTime "save as"
    expect(await folderAudio(folder)).toBe(join(folder, "trimmed.m4a"));
  });

  test("prefers the newest audio when a trimmed copy sits beside the untrimmed original", async () => {
    const folder = join(cfg.paths.inboxDir, STAMP);
    mkdirSync(folder, { recursive: true });
    const orig = join(folder, "recording.flac");
    const trimmed = join(folder, "recording.m4a");
    await Bun.write(orig, "old-untrimmed");
    await Bun.write(trimmed, "new-trimmed");
    // Make the flac older and the m4a newer, deterministically (don't rely on write order).
    utimesSync(orig, new Date(1_000_000), new Date(1_000_000));
    utimesSync(trimmed, new Date(2_000_000), new Date(2_000_000));
    expect(await folderAudio(folder)).toBe(trimmed);
  });

  test("ignores non-audio artifacts and returns null when there's no audio", async () => {
    const folder = join(cfg.paths.inboxDir, STAMP);
    mkdirSync(folder, { recursive: true });
    await Bun.write(join(folder, "transcript.txt"), "hello");
    await Bun.write(join(folder, "summary.md"), "# x");
    expect(await folderAudio(folder)).toBeNull();
  });

  test("returns null for a missing folder", async () => {
    expect(await folderAudio(join(cfg.paths.inboxDir, "meeting-nope"))).toBeNull();
  });

  // folderAudioRanked is what the watcher polls (quietly); folderAudio is the logging one-shot.
  // Both must agree on the winner, or a folder could be enqueued as one file and processed as
  // another.
  test("folderAudioRanked ranks newest-first and leads with folderAudio's pick", async () => {
    const folder = join(cfg.paths.inboxDir, STAMP);
    mkdirSync(folder, { recursive: true });
    const orig = join(folder, "recording.flac");
    const split = join(folder, "part-2.m4a");
    await Bun.write(orig, "old");
    await Bun.write(split, "new");
    utimesSync(orig, new Date(1_000_000), new Date(1_000_000));
    utimesSync(split, new Date(2_000_000), new Date(2_000_000));
    expect(await folderAudioRanked(folder)).toEqual([split, orig]);
    expect(await folderAudio(folder)).toBe(split);
  });

  test("folderAudioRanked is empty for a folder with no audio and for a missing folder", async () => {
    const folder = join(cfg.paths.inboxDir, STAMP);
    mkdirSync(folder, { recursive: true });
    await Bun.write(join(folder, "transcript.txt"), "hello");
    expect(await folderAudioRanked(folder)).toEqual([]);
    expect(await folderAudioRanked(join(cfg.paths.inboxDir, "meeting-nope"))).toEqual([]);
  });

  test("resolveWav resolves a trim-renamed recording by basename", async () => {
    const folder = join(cfg.paths.inboxDir, STAMP);
    mkdirSync(folder, { recursive: true });
    await Bun.write(join(folder, "trimmed.m4a"), "audio-bytes");
    expect(await resolveWav(cfg, STAMP)).toBe(join(folder, "trimmed.m4a"));
  });
});

describe("currentAudioFor (worker re-resolution)", () => {
  test("resolves a job queued as recording.flac to the trimmed recording.m4a now on disk", async () => {
    const folder = await makeRecording(cfg.paths.inboxDir, STAMP, ".m4a"); // the re-saved file
    const stalePath = join(folder, "recording.flac"); // what the queue froze; now missing
    expect(await currentAudioFor(cfg, STAMP, stalePath)).toBe(join(folder, "recording.m4a"));
  });

  test("resolves a trim saved under a different name (not the recording.<ext> stem)", async () => {
    const folder = join(cfg.paths.inboxDir, STAMP);
    mkdirSync(folder, { recursive: true });
    await Bun.write(join(folder, "trimmed.m4a"), "audio-bytes");
    const stalePath = join(folder, "recording.flac");
    expect(await currentAudioFor(cfg, STAMP, stalePath)).toBe(join(folder, "trimmed.m4a"));
  });

  test("leaves a normal, unedited recording's queued path unchanged", async () => {
    const folder = await makeRecording(cfg.paths.inboxDir, STAMP);
    const flac = join(folder, "recording.flac");
    expect(await currentAudioFor(cfg, STAMP, flac)).toBe(flac);
  });

  test("falls back to the queued path when the folder has no audio (never invents a file)", async () => {
    const folder = join(cfg.paths.inboxDir, STAMP);
    mkdirSync(folder, { recursive: true }); // empty
    const stalePath = join(folder, "recording.flac");
    expect(await currentAudioFor(cfg, STAMP, stalePath)).toBe(stalePath);
  });

  test("leaves an external one-off path untouched (not resolved by basename)", async () => {
    const external = "/tmp/somewhere/audio.m4a";
    expect(await currentAudioFor(cfg, "audio", external)).toBe(external);
  });
});

describe("move", () => {
  test("moves the whole folder inbox → processed/<YYYY-MM>", async () => {
    await makeRecording(cfg.paths.inboxDir, STAMP);
    const dest = await move(cfg, STAMP, "processed");
    expect(dest).toBe(join(cfg.paths.processedDir, "2026-06", STAMP));
    expect(existsSync(join(dest!, "recording.flac"))).toBe(true);
    expect(existsSync(join(cfg.paths.inboxDir, STAMP))).toBe(false); // source gone
  });

  test("moves sibling artifacts with the folder (single rename)", async () => {
    const folder = await makeRecording(cfg.paths.inboxDir, STAMP);
    await Bun.write(join(folder, "transcript.txt"), "hello");
    await Bun.write(join(folder, "summary.md"), "# x");
    const dest = await move(cfg, STAMP, "processed");
    expect(existsSync(join(dest!, "transcript.txt"))).toBe(true);
    expect(existsSync(join(dest!, "summary.md"))).toBe(true);
  });

  test("is idempotent in the terminal home (no-op, no error)", async () => {
    const folder = await makeRecording(join(cfg.paths.processedDir, "2026-06"), STAMP);
    const dest = await move(cfg, STAMP, "processed");
    expect(dest).toBe(folder); // src === dest → returned unchanged
    expect(existsSync(join(folder, "recording.flac"))).toBe(true);
  });

  test("replaces a stale folder already in the terminal home (reprocess overwrites)", async () => {
    // A prior processed run sits in the terminal home...
    const home = join(cfg.paths.processedDir, "2026-06", STAMP);
    mkdirSync(home, { recursive: true });
    await Bun.write(join(home, "recording.flac"), "STALE");
    await Bun.write(join(home, "summary.md"), "old summary");
    // ...and a fresh re-drop with new content is processed in inbox/.
    await makeRecording(cfg.paths.inboxDir, STAMP);
    await Bun.write(join(cfg.paths.inboxDir, STAMP, "summary.md"), "new summary");

    const dest = await move(cfg, STAMP, "processed");
    expect(dest).toBe(home);
    expect(await Bun.file(join(home, "recording.flac")).text()).toBe("audio-bytes"); // fresh wins
    expect(await Bun.file(join(home, "summary.md")).text()).toBe("new summary");
    expect(existsSync(join(cfg.paths.inboxDir, STAMP))).toBe(false); // source consumed, not stranded
  });

  test("moves to failed", async () => {
    await makeRecording(cfg.paths.inboxDir, STAMP);
    const dest = await move(cfg, STAMP, "failed");
    expect(dest).toBe(join(cfg.paths.failedDir, STAMP));
    expect(existsSync(join(dest!, "recording.flac"))).toBe(true);
  });

  test("returns null when there's nothing to move", async () => {
    expect(await move(cfg, "meeting-nope", "processed")).toBeNull();
  });
});

describe("recordingBase / isManagedRecording", () => {
  test("managed lifecycle recordings key on the folder name", () => {
    const inbox = join(cfg.paths.inboxDir, "meeting-x", "recording.flac");
    expect(recordingBase(cfg, inbox)).toBe("meeting-x");
    expect(isManagedRecording(cfg, inbox)).toBe(true);

    const processed = join(cfg.paths.processedDir, "2026-06", "meeting-y", "recording.m4a");
    expect(recordingBase(cfg, processed)).toBe("meeting-y");
    expect(isManagedRecording(cfg, processed)).toBe(true);

    const failed = join(cfg.paths.failedDir, "meeting-z", "recording.wav");
    expect(recordingBase(cfg, failed)).toBe("meeting-z");
    expect(isManagedRecording(cfg, failed)).toBe(true);
  });

  test("external one-off paths key on the filename stem and are not managed", () => {
    expect(recordingBase(cfg, "/tmp/somewhere/audio.m4a")).toBe("audio");
    expect(isManagedRecording(cfg, "/tmp/somewhere/audio.m4a")).toBe(false);
  });

  test("an external file literally named recording.<ext> is NOT treated as a folder artifact", () => {
    const external = "/tmp/somewhere/recording.wav"; // outside the store
    expect(recordingBase(cfg, external)).toBe("recording");
    expect(isManagedRecording(cfg, external)).toBe(false);
  });

  test("a recording-shaped path under a …-backup sibling is not managed (no prefix-match trap)", () => {
    // Mirrors the store's layout exactly but lives under "<base>-backup" — a plain startsWith()
    // guard would wrongly accept it; the location check rejects it.
    const lookalike = join(`${base}-backup`, "recordings", "inbox", "meeting-x", "recording.flac");
    expect(isManagedRecording(cfg, lookalike)).toBe(false);
    expect(recordingBase(cfg, lookalike)).toBe("recording"); // falls back to stem, not "meeting-x"
  });
});
