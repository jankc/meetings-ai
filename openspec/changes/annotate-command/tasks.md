## 1. Speaker-name inference in the summary prompt

- [ ] 1.1 Add one instruction to `prompts/base.md`: when a speaker's identity is evident from the
      transcript (self-introduction, being addressed by name), refer to them as
      `SPEAKER_NN (Jméno)` — label kept, name appended; otherwise keep the bare label, never invent
      a name; user context mappings override. Verify by re-running `murmur summarize` on a diarized
      recording where a name is spoken and checking the output format.

## 2. Template generation

- [ ] 2.1 Add `contextTemplate(transcript: string, summary?: string): string` to `src/context.ts`
      — Czech headings (Projekt / Účastníci / Poznámky) plus one `SPEAKER_NN = ` line per distinct
      label in first-appearance order (`/SPEAKER_\d+/g` + Set); pre-fill names parsed from the
      summary's `SPEAKER_NN (Jméno)` annotations (last occurrence wins). Verify with a unit test in
      `src/context.test.ts` covering diarized (labels, order, dedup), undiarized (headings only),
      and name-pre-fill (annotated + unannotated labels mixed) cases (`bun test context`).

## 3. The annotate command

- [ ] 3.1 Add the `annotate` case to `src/cli.ts`: resolve via `resolveWav` (die with a clear
      message when unresolved or when `transcript.txt` is missing, pointing at
      `transcribe`/`reprocess`); die when `!process.stdout.isTTY` with a hint to use
      `summarize --context @file`. Verify: `murmur annotate nonexistent` and a transcript-less
      recording both fail with the expected messages.
- [ ] 3.2 Write `contextTemplate(...)` (passing the transcript and any existing `summary.md`) to `<folder>/context.md` only when absent; spawn
      `$EDITOR` (fallback `vi`) on it with `stdio: "inherit"` and await exit; abort on non-zero
      exit. Verify manually: first run pre-fills speakers, second run opens the edited file
      unchanged.
- [ ] 3.3 After the editor exits: if `context.md` is trim-empty, print a skip message and stop;
      otherwise run the existing summarize path (`summarize()` + `archiveSummary()`, as in the
      `summarize` case). Verify on a processed recording: summary regenerated using the context,
      vault note replaced, no ASR re-run.
- [ ] 3.4 Add `annotate <name>` to the CLI help text and verify it renders in `murmur help`.

## 4. Docs & checks

- [ ] 4.1 Document `murmur annotate` and the `SPEAKER_NN (Jméno)` convention in README.md (CLI list + the context section);
      verify the command list matches the CLI help.
- [ ] 4.2 Run `bun run typecheck` and `bun test` from `src/` — both green.
