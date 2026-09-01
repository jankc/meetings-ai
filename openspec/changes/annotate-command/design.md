## Context

See proposal.md for motivation. Everything downstream already exists: `context.md` persistence
(`src/context.ts`), context injection into the summary prompt (`src/engines/summary.ts`), and vault
re-archive with note replacement (`src/archive.ts`). The `summarize` CLI case already chains
`applyContext → summarize → archiveSummary` inline. Transcripts carry speaker labels as
`[SPEAKER_NN]` markers (see `src/archive.ts:countSpeakers`, which extracts them with
`/SPEAKER_\d+/g`). `resolveWav` (`src/recordings.ts`) resolves a basename across
inbox/failed/processed.

## Goals / Non-Goals

**Goals:**
- One new CLI case that composes existing pieces; the only genuinely new logic is template
  generation and spawning `$EDITOR`.

**Non-Goals:**
- No daemon involvement, no queueing — annotate runs inline like `summarize` (same GPU-contention
  characteristics; acceptable, unchanged).
- No Obsidian-side trigger, no split/trim (separate feature).
- No structured parsing of the template — `context.md` stays free-form text injected verbatim.

## Decisions

1. **Reuse the `summarize` code path rather than `reprocess`.** Re-summarize + re-archive is
   exactly what annotate needs; `reprocess` would re-run ASR (minutes of GPU) for no benefit.
   Extract the summarize case's body into a small local helper or just duplicate the ~6 lines —
   whichever yields the shorter diff in `cli.ts`.

2. **Template generation lives in `src/context.ts`** as a pure function
   `contextTemplate(transcript: string, summary?: string): string` — testable without I/O, next to
   the existing context helpers. Speaker labels: `new Set(transcript.match(/SPEAKER_\d+/g))`
   preserves first-appearance order (Set iterates in insertion order) — same idiom `countSpeakers`
   uses. Name guesses come from the prior summary via `/SPEAKER_(\d+)\s*\(([^)]+)\)/g` (last
   occurrence wins), pre-filling `SPEAKER_NN = Jméno`.

3. **Template content is plain text with Czech labels** (the user's summaries are predominantly
   Czech, and context is injected verbatim into the prompt — the model handles either language):

   ```
   Projekt:
   Účastníci:
   SPEAKER_00 =
   SPEAKER_01 =

   Poznámky:
   ```

   Undiarized transcript → no `SPEAKER_` lines, just the headings. No comment syntax or
   instructions in the template: whatever the user leaves is what the model sees, and mostly-empty
   headings are harmless.

4. **Editor: `$EDITOR`, fallback `vi`**, spawned with `stdio: "inherit"` (`Bun.spawn`, await
   `exited`) — same pattern as the `logs -f` tail. Non-zero editor exit aborts without
   summarizing. No TTY (`!process.stdout.isTTY`) → `die()` with a hint to use
   `murmur summarize <name> --context @file` instead.

5. **Template is written only when `context.md` is absent** — an existing file opens as-is. The
   spec's empty-file check reuses the same trim-empty semantics as `saveContext` (whitespace-only
   → skip regeneration, report it).

6. **Speaker-name inference happens in the summary call that already runs — no extra LLM
   anywhere.** One instruction added to `prompts/base.md`: when a speaker's identity is evident
   from the transcript (self-introduction, being addressed), write `SPEAKER_NN (Jméno)`; otherwise
   keep the bare label and invent nothing. Appending the name (instead of replacing the label)
   keeps wrong guesses visible and gives annotate a regex-parseable form. Annotate itself stays
   purely algorithmic and instant — it only reads what the last summary already inferred.

## Risks / Trade-offs

- [User closes editor without editing → template headings go to the LLM] → Acceptable: the prompt
  already tells the model to use context only for accuracy; near-empty headings add nothing but
  cost a few tokens. Not worth diffing against the pristine template.
- [Annotate while the daemon is mid-job on the same GPU] → Same pre-existing behavior as
  `murmur summarize`; user-invoked, user-visible, unchanged.
- [Model hallucinates a name into `SPEAKER_NN (Jméno)`] → The label stays alongside the name, so a
  wrong guess is visible and one `context.md` edit away from corrected; prompt says "only when
  evident", temperature is already 0. Revert = deleting one prompt line.
