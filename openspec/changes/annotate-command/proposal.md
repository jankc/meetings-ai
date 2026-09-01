## Why

Adding context to a finished recording (who each `SPEAKER_NN` is, the project, extra notes) already
works via `murmur summarize <name> --context @file`, but the workflow is clumsy: the user must
hand-craft the context text from scratch, remember the speaker labels used in the transcript, and
know to re-run summarize. There is no "fill in a template, hit save, get a better summary" path —
which is how the post-meeting enrichment step is actually used.

## What Changes

- New CLI command `murmur annotate <name>`:
  - Resolves the recording wherever it sits (inbox/failed/processed), like `reprocess`.
  - If the recording has no `context.md` yet, writes a pre-filled template into it: project /
    participants headings, one `SPEAKER_NN = ` line per speaker label found in the transcript, and
    a free-form notes section.
  - Opens `context.md` in `$EDITOR` and waits for the editor to exit.
  - Then re-runs the existing summarize path (summary regeneration + Obsidian vault re-archive),
    reusing all existing machinery — no new pipeline code.
- Summary prompt (`prompts/base.md`) gains one instruction: when a speaker's identity is evident
  from the transcript, refer to them as `SPEAKER_NN (Jméno)` — machine-readable, so the annotate
  template pre-fills those names algorithmically. No extra LLM call anywhere; annotate stays
  instant.
- No changes to recording, ASR, triage, or archiving behavior. The command is a thin ergonomic
  wrapper over the existing `summary-context` capability.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `summary-context`: add requirements for the `annotate` command — template-assisted context
  editing with automatic re-summary + re-archive after the editor closes — and for summaries
  marking evident speaker identities as `SPEAKER_NN (Jméno)`.

## Impact

- `prompts/base.md`: one added instruction (speaker-name annotation).
- `src/cli.ts`: new `annotate` case + help text.
- `src/context.ts`: template generation helper (speaker-label extraction from a transcript).
- `src/context.test.ts` (or `pure.test.ts`): unit test for template generation.
- `README.md`: document the command.
- No config, daemon, API, or storage changes.
