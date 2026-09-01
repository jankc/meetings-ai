// Summarization stage (model configurable via [summary].model, server via [summary].provider —
// see llm.ts for the ollama/omlx transports). Preflight the LLM server, classify the recording
// (triage), assemble prompts/base.md + prompts/types/<type>.md, then write summary.md into the
// recording's own folder.
import { basename as pathBasename, dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { ARTIFACTS } from "../paths.ts";
import { log } from "../log.ts";
import { AbortError, EngineError, isAbort } from "./errors.ts";
import { llmGenerate, llmPreflight } from "./llm.ts";

// Emitted for genuinely empty/trivial recordings. Detection is done in code (word count)
// rather than left to the model, which over-classifies real rambly speech as "test audio".
// archive.ts skips notes whose summary contains "prázdný nebo testovací".
export const EMPTY_MARKER = "Transcript je prázdný nebo testovací — žádné shrnutí.";
export const MIN_WORDS = 25;

// Strip diarization markup ([00:00:01.2] timestamps, [SPEAKER_00] labels) from a transcript,
// leaving just the spoken text. Shared by wordCount() here and purge's tokenizer.
export function stripTranscriptMarkup(transcript: string): string {
  return transcript
    .replace(/\[\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\]/g, "")
    .replace(/\[SPEAKER_\d+\]/g, "");
}

// Count real spoken words, ignoring diarization markup ([00:00:01.2], [SPEAKER_00]).
export function wordCount(transcript: string): number {
  return stripTranscriptMarkup(transcript).split(/\s+/).filter(Boolean).length;
}

// The recording kinds triage routes to. "summary" is the default/fallback (meetings, notes,
// dialogues, anything ambiguous); the others each get a different treatment (see prompts/types/).
export type TriageType = "summary" | "dictation" | "list" | "journal" | "lecture";
const TRIAGE_TYPES: readonly TriageType[] = ["summary", "dictation", "list", "journal", "lecture"];

// JSON shape the triage call is constrained to (oMLX enforces it via XGrammar; ollama only gets
// generic JSON mode). parseTriage still tolerates anything that slips through.
const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...TRIAGE_TYPES] },
    language: { type: "string", enum: ["cs", "en"] },
  },
  required: ["type", "language"],
};

export interface Triage {
  type: TriageType;
  language: "cs" | "en";
}

export interface SummarizeResult {
  summaryPath: string;
  type: TriageType;
  language: "cs" | "en";
}

// Classification rarely needs the whole transcript; cap the head fed to the triage call.
const TRIAGE_HEAD_CHARS = 6000;

const basePromptPath = (cfg: Config) => join(cfg.promptsDir, "base.md");
const triagePromptPath = (cfg: Config) => join(cfg.promptsDir, "triage.md");
const typePromptPath = (cfg: Config, type: TriageType) => join(cfg.promptsDir, "types", `${type}.md`);

// Parse the triage model's JSON. Falls back to the safe default ({summary, cs}) on any miss —
// a flaky classify call can never break summarization (worst case: the generic summary template).
// Extracts the first {...} object because models (e.g. gemma *-mlx) wrap it in a ```json fence
// even when JSON output is requested.
export function parseTriage(response: string): Triage {
  try {
    const start = response.indexOf("{");
    const end = response.lastIndexOf("}");
    const json = start >= 0 && end > start ? response.slice(start, end + 1) : response;
    const obj = JSON.parse(json) as { type?: unknown; language?: unknown };
    const type = TRIAGE_TYPES.includes(obj.type as TriageType) ? (obj.type as TriageType) : "summary";
    const language = obj.language === "en" ? "en" : "cs";
    return { type, language };
  } catch {
    return { type: "summary", language: "cs" };
  }
}

// Ask the model to classify the recording (type + language). TRIAGE_SCHEMA constrains the output;
// parseTriage tolerates anything that slips through. Reuses modelSummary — no separate triage model.
async function classify(cfg: Config, transcript: string, signal: AbortSignal, timeout: AbortSignal): Promise<Triage> {
  const prompt = [
    await Bun.file(triagePromptPath(cfg)).text(),
    "",
    "--- TRANSCRIPT ---",
    transcript.slice(0, TRIAGE_HEAD_CHARS),
    "",
    "--- END ---",
    "",
  ].join("\n");
  const response = await llmGenerate(cfg, { prompt, schema: TRIAGE_SCHEMA }, AbortSignal.any([signal, timeout]));
  return parseTriage(response);
}

// Delimiters wrapping the optional user-context block in the summary prompt. base.md tells the
// model how to treat this section — keep these markers in sync with that instruction.
export const CONTEXT_OPEN = "--- KONTEXT OD UŽIVATELE ---";
export const CONTEXT_CLOSE = "--- KONEC KONTEXTU ---";

/** Pure assembly of the summary prompt: base rules + type template, an optional user-context block
 *  (included ONLY when non-empty — never empty delimiters), then the transcript. Kept pure (no
 *  fs/network) so it's unit-testable without an LLM server. */
export function assembleSummaryPrompt(parts: {
  baseRules: string;
  typePrompt: string;
  context: string;
  transcript: string;
}): string {
  const ctx = parts.context.trim();
  const lines = [parts.baseRules, parts.typePrompt, ""];
  if (ctx) lines.push(CONTEXT_OPEN, ctx, CONTEXT_CLOSE, "");
  lines.push("--- TRANSCRIPT ---", parts.transcript, "", "--- END ---", "");
  return lines.join("\n");
}

export async function summarize(cfg: Config, transcriptPath: string, signal: AbortSignal): Promise<SummarizeResult> {
  // The transcript lives in the recording's folder (<folder>/transcript.txt); the summary is its
  // sibling and the recording's key is the folder name — not the "transcript" filename.
  const folder = dirname(transcriptPath);
  const base = pathBasename(folder);
  const out = join(folder, ARTIFACTS.summary);
  const transcript = await Bun.file(transcriptPath).text();

  // Trivially short → mark empty without spending an LLM call (or risking misclassification).
  if (wordCount(transcript) < MIN_WORDS) {
    log.info("summary", `transcript ${base} below ${MIN_WORDS} words — marking empty (skipping LLM)`);
    await Bun.write(out, EMPTY_MARKER + "\n");
    return { summaryPath: out, type: "summary", language: "cs" };
  }

  // Stage-timeout backstop — created BEFORE preflight so the documented per-stage limit also
  // bounds a down/unresponsive server, not just the generate call. A user hard-pause (signal)
  // still aborts independently. Default 2h is well above any real summarize.
  const timeout = AbortSignal.timeout(cfg.processTimeoutSeconds * 1000);

  await llmPreflight(cfg, signal, timeout);

  // Classify first, then route to the matching template. A triage hiccup degrades to the generic
  // summary rather than failing the recording; an abort/timeout still propagates.
  let triage: Triage = { type: "summary", language: "cs" };
  try {
    triage = await classify(cfg, transcript, signal, timeout);
  } catch (err) {
    if (signal.aborted || isAbort(err)) throw new AbortError("summarize aborted");
    if (timeout.aborted) throw new EngineError(`summarize timed out after ${cfg.processTimeoutSeconds}s`, 124);
    log.warn("summary", `triage failed for ${base}, defaulting to summary: ${String(err)}`);
  }
  log.info("summary", `classified ${base} as ${triage.type} (${triage.language})`);

  const baseRules = (await Bun.file(basePromptPath(cfg)).text())
    .replaceAll("{{LANGUAGE}}", triage.language === "en" ? "anglicky" : "česky");
  const typePrompt = await Bun.file(typePromptPath(cfg, triage.type)).text();
  // Optional per-recording context (ARTIFACTS.context) — injected into the summary prompt only,
  // never into triage/transcription. Absent for most recordings (→ "", no context section).
  const context = (await Bun.file(join(folder, ARTIFACTS.context)).text().catch(() => "")).trim();
  if (context) log.info("summary", `applying user context for ${base} (${context.length} chars)`);
  const prompt = assembleSummaryPrompt({ baseRules, typePrompt, context, transcript });

  log.info("summary", `summarizing ${base} (${triage.type}) with ${cfg.summaryProvider}/${cfg.modelSummary}`);
  let response: string;
  try {
    response = await llmGenerate(cfg, { prompt }, AbortSignal.any([signal, timeout]));
  } catch (err) {
    if (signal.aborted || isAbort(err)) throw new AbortError("summarize aborted");
    if (timeout.aborted) throw new EngineError(`summarize timed out after ${cfg.processTimeoutSeconds}s`, 124);
    if (err instanceof EngineError && err.detail !== undefined) {
      // HTTP failure — capture the failing body into the recording's folder so it stays traceable
      // (the interleaved daemon log only keeps one truncated line).
      const logPath = join(folder, "summary.error.log");
      await Bun.write(logPath, `${err.message} for ${base} with ${cfg.modelSummary}\n\n${err.detail}\n`).catch(() => {});
      throw new EngineError(`${err.message} (see ${logPath})`, err.exitCode, err.detail.slice(-2000));
    }
    if (err instanceof EngineError) throw err;
    throw new EngineError(`${cfg.summaryProvider} request failed: ${String(err)}`, 1);
  }

  await Bun.write(out, response);
  return { summaryPath: out, type: triage.type, language: triage.language };
}

/** Generate a short meeting title from the finished summary (for the vault filename +
 *  frontmatter). Small, fast call; assumes the LLM server is already up (summarize ran first).
 *  Same timeout backstop as summarize() — a wedged title request must not hang the archive stage. */
export async function generateTitle(cfg: Config, summaryText: string, signal: AbortSignal): Promise<string> {
  const prompt = [
    "Z následujícího shrnutí schůzky vytvoř krátký výstižný název (3–6 slov).",
    "Bez uvozovek, bez data a bez koncové interpunkce. Odpověz POUZE názvem na jednom řádku.",
    "",
    summaryText.slice(0, 4000),
  ].join("\n");
  const timeout = AbortSignal.timeout(cfg.processTimeoutSeconds * 1000);
  const response = await llmGenerate(cfg, { prompt }, AbortSignal.any([signal, timeout]));
  return response.trim().split("\n")[0]?.trim() ?? "";
}
