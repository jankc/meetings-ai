## ADDED Requirements

### Requirement: Template-assisted context editing via the annotate command

The system SHALL provide a `murmur annotate <name>` command that lets the user enrich a finished
recording's context in an editor and regenerate its summary in one step. The command MUST resolve
the recording wherever it currently sits in the lifecycle (inbox, failed, or processed), the same
way `reprocess` does, and MUST require an existing transcript (failing with a clear message
pointing at `transcribe`/`reprocess` when there is none).

When the recording has no stored context yet, the command MUST first write a pre-filled template
into the recording's `context.md`: headings for the project and participants, one `SPEAKER_NN = `
line per distinct speaker label found in the transcript (in first-appearance order; none when the
transcript is undiarized), and a free-form notes section. When the recording's existing summary
carries machine-readable speaker-name annotations (`SPEAKER_NN (Jméno)` — see the requirement
below), the template MUST pre-fill each matching line as `SPEAKER_NN = Jméno`; labels without an
annotation stay blank. An existing `context.md` MUST be opened as-is, never overwritten by the
template.

The command SHALL open `context.md` in the user's editor (`$EDITOR`, with a sensible fallback) and
wait for it to exit. It MUST fail with a clear message when no interactive terminal is available.

#### Scenario: First annotate pre-fills the template from the transcript
- **WHEN** the user runs `murmur annotate <base>` for a diarized recording with no `context.md`
- **THEN** `<base>/context.md` is created containing project/participants headings, one
  `SPEAKER_NN = ` line for each speaker label appearing in the transcript, and a notes section
- **AND** that file is opened in the user's editor

#### Scenario: Template pre-fills names the summary already inferred
- **WHEN** the user runs `murmur annotate <base>` with no `context.md` and `<base>/summary.md`
  contains `SPEAKER_00 (Petr)`
- **THEN** the template's speaker line reads `SPEAKER_00 = Petr`, while unannotated labels get an
  empty `SPEAKER_NN = ` line

#### Scenario: Annotate on a recording with existing context
- **WHEN** the user runs `murmur annotate <base>` and `<base>/context.md` already exists
- **THEN** the existing file is opened unchanged (no template is applied over it)

#### Scenario: Annotate without a transcript fails clearly
- **WHEN** the user runs `murmur annotate <base>` and the recording has no transcript
- **THEN** the command exits with an error explaining a transcript is required first

### Requirement: Annotate regenerates the summary after editing

After the editor exits, the command SHALL re-run the existing summary path for the recording —
summary regeneration using the stored context, followed by the Obsidian vault re-archive (which
replaces the prior note) — without re-running transcription. When the edited `context.md` is empty
or whitespace-only, the command MUST skip regeneration and say so, leaving the previous summary
untouched.

#### Scenario: Saved context produces a refreshed summary and vault note
- **WHEN** the user fills in the template, saves, and closes the editor
- **THEN** the summary is regenerated using the stored context and the vault note for the
  recording is replaced, with no transcription re-run

#### Scenario: Emptied context skips regeneration
- **WHEN** the user leaves `context.md` empty (or deletes all content) and closes the editor
- **THEN** no summary regeneration happens and the command reports it was skipped

### Requirement: Summaries mark evident speaker identities machine-readably

When a speaker's identity is evident from the transcript itself (they introduce themselves, or
others address them by name), the generated summary SHALL refer to them as `SPEAKER_NN (Jméno)` —
the label kept, the name appended in parentheses — rather than replacing the label. This keeps the
inference visible/correctable and gives tooling (the annotate template) a parseable form. When the
identity is not evident, the bare label MUST be kept and no name invented. User-supplied context
remains authoritative: a `SPEAKER_NN = Jméno` mapping in the context overrides transcript-derived
inference.

#### Scenario: Evident identity is annotated, not substituted
- **WHEN** a recording is summarized and the transcript makes clear who `SPEAKER_01` is (e.g. "já
  jsem Petr")
- **THEN** the summary refers to that speaker as `SPEAKER_01 (Petr)`

#### Scenario: Unclear identity stays a bare label
- **WHEN** nothing in the transcript reveals a speaker's identity
- **THEN** the summary keeps `SPEAKER_NN` with no invented name
