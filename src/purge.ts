// `murmur purge` — find junk recordings whose transcript is empty or noise (repetitive ASR
// garbage) and, with --apply, delete the whole recording folder (audio + transcript + summary +
// asr.log) plus any vault note. Detection is transcript-based and deterministic — no LLM call.
// Never runs in the pipeline; it's an explicit, opt-in cleanup. Dry-run unless apply=true.
import { readdirSync, type Dirent } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { wordCount, stripTranscriptMarkup, EMPTY_MARKER, MIN_WORDS } from "./engines/summary.ts";
import { ARTIFACTS } from "./paths.ts";
import { parseStamp } from "./stamp.ts";
import { log } from "./log.ts";

export type PurgeReason = "empty" | "noise";

export interface Classification {
  reason: PurgeReason | null; // null = keep
  words: number;
  uniqueRatio: number;
}

// Only apply the diversity test to transcripts long enough that a low ratio is meaningful — a
// short genuine note ("ano. ano. dobře.") shouldn't look like garbage.
const NOISE_MIN_WORDS = 40;
// Real speech (even rambly) sits well above this; ASR loops ("cast cast cast…") sit far below.
const NOISE_RATIO = 0.18;

/** Tokenize the way wordCount does (drop [HH:MM:SS] / [SPEAKER_NN] markup), then strip
 *  punctuation and lowercase so "cast," and "cast" count as one token. */
function tokens(transcript: string): string[] {
  return stripTranscriptMarkup(transcript)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Pure, deterministic classifier. `empty` = below the LLM word gate or the summary was marked
 *  empty; `noise` = a long transcript with a tiny unique-word ratio (repetitive ASR garbage). */
export function classifyTranscript(transcript: string, summaryText = ""): Classification {
  const words = wordCount(transcript);
  if (summaryText.includes(EMPTY_MARKER) || words < MIN_WORDS) {
    return { reason: "empty", words, uniqueRatio: 1 };
  }
  const toks = tokens(transcript);
  const uniqueRatio = toks.length ? new Set(toks).size / toks.length : 1;
  if (toks.length >= NOISE_MIN_WORDS && uniqueRatio < NOISE_RATIO) {
    return { reason: "noise", words, uniqueRatio };
  }
  return { reason: null, words, uniqueRatio };
}

export interface PurgeItem {
  base: string;
  reason: PurgeReason;
  words: number;
  uniqueRatio: number;
  folder: string; // the recording folder to remove wholesale
  vaultNotes: string[]; // vault notes (outside the folder) to remove too
}

/** Every recording folder across the lifecycle dirs (inbox, failed, processed/<month>), as
 *  {base, folder} pairs. Dotfiles/staging dirs are skipped. */
function listRecordingFolders(cfg: Config): { base: string; folder: string }[] {
  const out: { base: string; folder: string }[] = [];
  const dirChildren = (dir: string): Dirent[] => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return []; // dir absent → nothing here
    }
  };
  for (const dir of [cfg.paths.inboxDir, cfg.paths.failedDir]) {
    for (const e of dirChildren(dir)) {
      if (e.isDirectory() && !e.name.startsWith(".")) out.push({ base: e.name, folder: join(dir, e.name) });
    }
  }
  // processed/ is partitioned by month → recurse one level into each month dir.
  for (const m of dirChildren(cfg.paths.processedDir)) {
    if (!m.isDirectory()) continue;
    const monthDir = join(cfg.paths.processedDir, m.name);
    for (const e of dirChildren(monthDir)) {
      if (e.isDirectory() && !e.name.startsWith(".")) out.push({ base: e.name, folder: join(monthDir, e.name) });
    }
  }
  return out;
}

/** Find the vault note(s) for a recording: the second-precision note this version writes, plus
 *  any legacy minute-precision note (the dedup in archive.ts only matches the former). */
function vaultNotesFor(cfg: Config, base: string): string[] {
  if (!cfg.vaultRoot) return [];
  const when = parseStamp(base);
  if (!when) return [];
  const dir = join(cfg.vaultRoot, cfg.vaultFolder, when.month);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return []; // month folder absent → no note
  }
  const sec = `${when.date} ${when.clock}`; // "2026-06-20 17-58-25"
  const min = `${when.date} ${when.time} `; // legacy "2026-06-20 17-58 " (trailing space)
  return files
    .filter((f) => f.endsWith(".md") && (f.startsWith(sec) || f.startsWith(min)))
    .map((f) => join(dir, f));
}

/** Scan every transcribed recording folder, classify it, and collect those flagged for purge. A
 *  folder with no transcript yet (pending/failed before ASR) is NOT junk — it's skipped. */
export async function scanPurge(cfg: Config): Promise<PurgeItem[]> {
  const folders = listRecordingFolders(cfg).sort((a, b) => a.base.localeCompare(b.base));
  const items: PurgeItem[] = [];
  for (const { base, folder } of folders) {
    const transcriptPath = join(folder, ARTIFACTS.transcript);
    if (!(await Bun.file(transcriptPath).exists())) continue; // not yet transcribed → not junk
    const [transcript, summaryText] = await Promise.all([
      Bun.file(transcriptPath).text().catch(() => ""),
      Bun.file(join(folder, ARTIFACTS.summary)).text().catch(() => ""),
    ]);
    const c = classifyTranscript(transcript, summaryText);
    if (!c.reason) continue;
    items.push({ base, reason: c.reason, words: c.words, uniqueRatio: c.uniqueRatio, folder, vaultNotes: vaultNotesFor(cfg, base) });
  }
  return items;
}

/** Report (dry-run) or delete (apply=true) empty/junk recordings: the whole folder + vault notes. */
export async function purge(cfg: Config, apply: boolean): Promise<void> {
  const items = await scanPurge(cfg);
  if (items.length === 0) {
    console.log("purge: nothing to clean — no empty or junk recordings found.");
    return;
  }
  let pathCount = 0;
  for (const it of items) {
    const tag = it.reason === "empty" ? "empty" : `noise (unique-word ratio ${it.uniqueRatio.toFixed(2)})`;
    console.log(`\n${it.base}  —  ${tag}, ${it.words} words`);
    console.log(`  ${apply ? "delete" : "would delete"}: ${it.folder}/  (recording folder)`);
    pathCount++;
    for (const note of it.vaultNotes) {
      console.log(`  ${apply ? "delete" : "would delete"}: ${note}`);
      pathCount++;
    }
  }
  if (!apply) {
    console.log(`\n${items.length} recording(s), ${pathCount} path(s) flagged. Re-run with --apply to delete.`);
    return;
  }
  let removed = 0;
  for (const it of items) {
    try {
      await rm(it.folder, { recursive: true, force: true });
      removed++;
    } catch (err) {
      log.warn("purge", `failed to remove ${it.folder}: ${String(err)}`);
    }
    for (const note of it.vaultNotes) {
      try {
        await unlink(note);
        removed++;
      } catch (err) {
        log.warn("purge", `failed to remove ${note}: ${String(err)}`);
      }
    }
  }
  console.log(`\npurged ${items.length} recording(s); removed ${removed}/${pathCount} path(s).`);
}
