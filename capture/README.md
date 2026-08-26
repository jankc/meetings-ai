# capture/ — vendored audio-capture helper

This is the macOS audio-capture helper for the `ownscribe` recording backend, vendored
into murmur so the recorder no longer depends on cloning and building an external repo.

It builds the `ownscribe-audio` binary: one process that captures system audio
(ScreenCaptureKit) **and** the mic (AVFAudio) and, on SIGINT, merges them
host-time-aligned into a single 24 kHz mono-float WAV. No output routing, so the macOS
volume keys keep working. `src/recorder.ts` (`startOwnscribe`) spawns it as:

```
ownscribe-audio capture -o <file>.oa.wav --mic --capture-mode-all
```

and stops it with SIGINT, then ffmpeg-transcodes the result to 16 kHz s16le.

## Provenance

- **Upstream:** https://github.com/paberr/ownscribe (the `swift/` subproject)
- **Pinned commit:** see [`UPSTREAM`](UPSTREAM) — the single source of truth, updated by the sync tooling below
- **License:** MIT, © 2026 Pascal Berrang — see `LICENSE` (kept per the MIT terms)

`Sources/AudioCapture.swift` tracks upstream with **five local patches** (search the file for
`LOCAL PATCH`):

1. A `--max-duration N` flag (a one-shot timer that fires the normal merge+exit), so a
   `murmur record` capture self-caps like the ffmpeg backend without depending on the daemon.
2. A `request-mic` subcommand that triggers the microphone TCC prompt and exits (used by
   `murmur grant-mic`). macOS only *shows* a mic prompt for a process that declares
   `NSMicrophoneUsageDescription` (embedded — see [`Info.plist`](Info.plist)).
3. A `watch-mic` subcommand for permission-free meeting detection (used by the daemon's
   `src/meetwatch.ts`): it observes `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default
   input device and, on a rising edge, attributes the mic owner(s) by bundle id via the macOS 14.4+
   process-object API (`kAudioHardwarePropertyProcessObjectList` + `kAudioProcessPropertyIsRunningInput`
   + `kAudioProcessPropertyBundleID`), emitting `mic on <bundleids>` / `mic off` to stdout. It only
   *reads* run-state (never creates a process tap), so it needs **no** TCC grant and is deliberately
   **not** in the self-disclaim list below.
4. **Self-disclaim** of the mic-touching subcommands (`capture`, `request-mic`). macOS attributes
   a child's mic/screen request to its *responsible* GUI app. Launched from the SwiftBar menubar
   that resolves to SwiftBar.app — which has **no** `NSMicrophoneUsageDescription` and no mic
   grant — so the request is silently denied and the mic records **silence** (verified via
   `launchctl procinfo`). Using the `responsibility_spawnattrs_setdisclaim` SPI, the binary
   re-execs itself once as its **own** responsible process, so the request is judged against *this
   binary* (which has the usage string) — letting it prompt and hold its **own** Microphone +
   Screen Recording grants, independent of the launcher. The original process stays as a thin
   supervisor that forwards stop/mute signals (SIGINT/SIGTERM/SIGUSR1) so the recorder's
   pid-tracking and SIGINT-merge-on-stop are unaffected.

5. **Echo cancellation** of speaker audio from the mic. On speakers the mic re-captures the
   system audio 30–100 ms late (output + input latency, which changes with devices and OS
   updates), so the merged file carried a second delayed copy of every remote word — host-time
   sync of the two tracks can't remove that. The mic runs through macOS's voice-processing IO
   (`AVAudioInputNode.setVoiceProcessingEnabled`), which cancels the device output from the mic
   signal (~35 dB in testing) and applies noise suppression. Two consequences: the processed input
   comes out as 9 identical channels, so the mic track is written mono from channel 0; and macOS
   **ducks other apps by ~8 dB while voice processing is active** (the `.min` ducking level is the
   floor — there is no off switch), so the meeting sounds quieter to you while a recording runs.
   If voice processing fails to start the capture falls back to the plain mic and logs a warning;
   `--no-aec` disables it explicitly.

Because the disclaimed binary is self-responsible, it needs its **own** TCC grants (not the
launcher's): grant once via **`murmur grant-mic`** (Microphone) and by enabling `ownscribe-audio`
under **System Settings ▸ Privacy ▸ Screen Recording**.

`build.sh` deviates from upstream `swift/build.sh` in three ways: `BIN_DIR` → `capture/bin/`
(gitignored, so the artifact lands next to its source); it embeds [`Info.plist`](Info.plist) into
the binary via `-sectcreate __TEXT __info_plist`; and it **code-signs** — with the stable
self-signed identity `murmur-ownscribe-codesign` when present (so the binary's code identity, and
therefore its TCC grants, survive rebuilds), else ad-hoc (grants reset on every rebuild). Create
the identity once in Keychain Access (Certificate Assistant → *Create a Certificate*, type *Code
Signing*) or override the name with `OWNSCRIBE_CODESIGN_IDENTITY`. Upstream's `Package.swift` is
**not** vendored: it under-links frameworks (only CoreAudio + AudioToolbox) and `swift build`
fails — `build.sh`'s direct `swiftc` call is the real, supported build path.

## Keeping in sync

[`UPSTREAM`](UPSTREAM) pins the exact commit this mirror is taken from. Two ways to update:

- **On demand (the updater):** `scripts/sync-capture.sh` fetches upstream and prints the
  diff; re-run with `--apply` to copy the new source, bump `UPSTREAM`, and rebuild. Pass a
  ref to target a specific branch/tag/commit (default: upstream `main`).
- **Notification (optional):** `.github/workflows/check-capture-upstream.yml` runs weekly
  and opens an issue when upstream moves past the pinned commit. Delete it if unwanted.

`LICENSE` tracks upstream verbatim. `Sources/AudioCapture.swift` carries the local
`--max-duration`, `request-mic`, `watch-mic`, self-disclaim, and echo-cancellation patches and `build.sh` deviates on
`BIN_DIR` + the `Info.plist` embedding + stable code-signing, so after a sync **re-apply the patches**
(search `LOCAL PATCH`); `scripts/sync-capture.sh` warns about this on `--apply`. If the `--max-duration`
patch is ever lost, `murmur record` fails loudly with `Unknown option: --max-duration` rather than
silently dropping the cap; if the `request-mic`/self-disclaim patch is lost, menubar-launched
recordings silently lose the mic again; if the `watch-mic` patch is lost, meeting auto-detection
no-ops and `murmur doctor` warns (it never breaks recording). The stable code-signing means a rebuild does **not** reset
the Microphone/Screen Recording grants — but only while the `murmur-ownscribe-codesign` identity
stays in your keychain; lose it and the build falls back to ad-hoc and the grants reset.

After any sync, redeploy the binary: `install -m755 capture/bin/ownscribe-audio ~/.local/bin/` (`install` replaces the file rather than overwriting in place — a plain `cp` over the old signed binary gets the new one SIGKILLed by the code-signature cache).

## Build

```sh
bash capture/build.sh                              # → capture/bin/ownscribe-audio
install -m755 capture/bin/ownscribe-audio ~/.local/bin/       # the default OWNSCRIBE_BIN path
```

Requires the Xcode Command Line Tools (`xcode-select --install`) and macOS 14.2+.
First run prompts for Screen Recording (and, with `--mic`, Microphone) permission — but the
mic prompt is attributed to the **launching app**. From a terminal that already has Microphone
access it just works; launched from the **SwiftBar menubar** the prompt is swallowed (detached
capture), so run **`murmur grant-mic`** once from the menubar item and Allow the prompt. The
grant then sticks to SwiftBar and every later menubar recording captures the mic.
