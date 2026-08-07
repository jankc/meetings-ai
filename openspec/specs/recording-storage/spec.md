# recording-storage

## Purpose

Every artifact for a single recording (audio, transcript, summary, ASR log) is stored together in
one folder named by the recording's basename, making each recording self-describing. The folder is
the unit that moves through the processing lifecycle (`inbox` → `processed/<YYYY-MM>` → `failed`),
preserving the "location is state" model. This capability covers the per-recording folder layout,
the folder-as-state lifecycle, and folder-based `locate`/`move`/`resolveWav` — including how the
recorder, import, watcher, and pipeline produce and consume the folder.

## Requirements

### Requirement: Per-recording folder layout

All artifacts for a single recording SHALL be stored together in one folder named by the
recording's basename. The folder MUST contain role-named files rather than basename-keyed files
scattered across separate trees: `recording.<ext>` (the audio, preserving its original extension),
`transcript.txt`, `summary.md`, and `asr.log`. No standalone `transcripts/` or `summaries/`
top-level directory SHALL be used. Absent artifacts (e.g. a not-yet-transcribed recording) simply
have no corresponding file in the folder.

#### Scenario: A processed recording's artifacts live in one folder
- **WHEN** a recording named `meeting-2026-06-23_11-28-34` has been transcribed and summarized
- **THEN** its audio, transcript, summary, and ASR log are all files inside a single folder named
  `meeting-2026-06-23_11-28-34/` (`recording.flac`, `transcript.txt`, `summary.md`, `asr.log`)
- **AND** no `transcripts/meeting-2026-06-23_11-28-34.txt` or
  `summaries/meeting-2026-06-23_11-28-34.md` exists outside that folder

#### Scenario: Original audio extension is preserved
- **WHEN** an imported recording arrives as `.m4a`
- **THEN** its audio file inside the folder is named `recording.m4a` (the extension is not forced to
  `.flac`)

### Requirement: Folder-as-state lifecycle

A recording's processing state SHALL be encoded by the lifecycle directory that contains its
folder, preserving the existing "location is state" model. The folder MUST move as a single unit
`recordings/inbox/<base>/` → `recordings/processed/<YYYY-MM>/<base>/` on success, or →
`recordings/failed/<base>/` on non-retryable failure. The `<YYYY-MM>` partition MUST be derived from
the recording's timestamp exactly as today.

#### Scenario: Successful processing moves the folder to processed
- **WHEN** the worker finishes transcribing and summarizing a recording in `inbox/<base>/`
- **THEN** the entire `<base>/` folder is moved to `processed/<YYYY-MM>/<base>/`
- **AND** the move is atomic (a single rename, not a per-file copy)

#### Scenario: Non-retryable failure moves the folder to failed
- **WHEN** processing a recording fails non-retryably
- **THEN** the entire `<base>/` folder is moved to `failed/<base>/` with its partial artifacts intact

### Requirement: Producers create the recording folder

Both the recorder and the importer SHALL deliver a new recording into `inbox/` as a folder
containing `recording.<ext>`. The recorder MUST still stage the in-progress capture under
`.partial/` and only publish the completed folder into `inbox/`, and its `start()` MUST expose the
recording's basename to the caller. The importer MUST keep its existing dedup guarantees (ledger +
`locate()` backstop) so re-running it never double-imports.

#### Scenario: A finished local recording is published as a folder
- **WHEN** a `murmur record` session is stopped and finalized
- **THEN** the result appears as `inbox/<base>/recording.flac`
- **AND** `start()` returned the `<base>` so the caller can associate per-recording data with it

#### Scenario: Import places audio inside a per-recording folder
- **WHEN** `murmur import` pulls a new external recording
- **THEN** it is written as `inbox/<base>/recording.<ext>`
- **AND** re-running `murmur import` does not import it a second time

### Requirement: Watcher detects a complete recording inside a new folder

The daemon watcher SHALL enqueue a recording when a new `inbox/<base>/` folder contains a complete,
size-stable audio file, rather than watching for bare audio files at the inbox root. A folder whose
audio is still growing MUST NOT be enqueued until it stabilizes.

The watcher (both the live watch and the boot reconcile) MUST identify a folder's audio by the same
rule the pipeline applies when it re-resolves a job at process time — any file with a supported
audio extension, most recently modified wins — and MUST NOT require the `recording.<ext>` stem. A
stricter gate at the watcher would make a hand-edited folder processable only if it were already
queued, while never letting it enter the queue.

A folder that never yields a supported audio file within the grace window SHALL be reported rather
than dropped silently, since nothing re-examines it until the next daemon start. A folder that has
vanished (moved on to `processed/`, or deleted) is not an anomaly and MUST NOT be reported.

#### Scenario: A stable recording folder is enqueued
- **WHEN** an `inbox/<base>/recording.flac` stops changing size for the stability window
- **THEN** the watcher enqueues `<base>` for processing

#### Scenario: A still-writing recording is not enqueued early
- **WHEN** `inbox/<base>/recording.flac` is still being written (size changing)
- **THEN** the watcher does not enqueue `<base>` until the file stabilizes

#### Scenario: A hand-split recording under its own filename is enqueued
- **WHEN** a user splits one capture into two meetings and drops the second half into a new folder
  as `inbox/<base>/part-2.m4a` (no `recording.<ext>` present)
- **THEN** the watcher enqueues `<base>` for processing, and the boot reconcile finds it too

#### Scenario: The newest audio wins when an edit sits beside the original
- **WHEN** `inbox/<base>/` holds both the original `recording.flac` and a newer trimmed `vsem.m4a`
- **THEN** the watcher enqueues the recording resolved to `vsem.m4a`

#### Scenario: A folder that yields no audio is reported, a vanished folder is not
- **WHEN** a folder in `inbox/` still holds no supported audio at the end of the grace window
- **THEN** the watcher logs a warning naming the folder instead of ignoring it silently
- **AND** no warning is logged for a folder that was moved to `processed/` or deleted

### Requirement: Folder-based locate, move, and resolve

`locate`, `move`, and `resolveWav` SHALL operate on recording folders. `locate(base)` MUST find the
`<base>/` folder across `inbox`, `failed`, and `processed/<YYYY-MM>`. `resolveWav` MUST resolve a
name or path to the `recording.<ext>` inside the located folder. `move(base, to)` MUST relocate the
whole folder and MUST be idempotent — a no-op when the folder is already in its terminal home.

#### Scenario: locate finds a recording wherever it is in the lifecycle
- **WHEN** `locate("meeting-2026-06-23_11-28-34")` is called and the recording is in
  `processed/2026-06/`
- **THEN** it resolves to that recording's folder (and `resolveWav` to its `recording.<ext>`)

#### Scenario: move is idempotent in the terminal home
- **WHEN** `move(base, "processed")` is called for a folder already at
  `processed/<YYYY-MM>/<base>/`
- **THEN** it is a no-op and does not error

### Requirement: Pipeline and cleanup use folder-relative paths

The transcription, summarization, archiving, and purge steps SHALL read and write artifacts at
folder-relative paths. ASR MUST write `transcript.txt` and its per-job log `asr.log` inside the
folder; summarization MUST write `summary.md` inside the folder; `murmur purge` MUST remove the
entire recording folder (not individual scattered files).

#### Scenario: ASR and summary write into the recording folder
- **WHEN** the worker processes `<base>`
- **THEN** the transcript is written to `<base>/transcript.txt`, the summary to `<base>/summary.md`,
  and the ASR log to `<base>/asr.log`

#### Scenario: Purge removes the whole folder
- **WHEN** `murmur purge --apply` flags `<base>` as empty/junk
- **THEN** the entire `<base>/` folder and all its artifacts are removed
