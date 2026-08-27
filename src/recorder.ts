// Recording: spawn capture process(es) for the configured backend, producing a raw PCM-ish
// WAV in recordings/.partial/ (NOT the watched inbox/) so an in-progress recording never
// triggers the watcher. At finalize the capture is transcoded to the canonical 16 kHz mono
// FLAC and atomically dropped into inbox/ — by stop(), or by finalizeOrphans() if the
// recording ended on its own (MAX cap) or the host crashed.
//
// Why capture WAV but archive FLAC: raw PCM is maximally salvageable if a capture is killed
// mid-stream, whereas a FLAC truncated by SIGKILL can lose its STREAMINFO/last frame. So we
// keep crash recovery on robust PCM and encode FLAC only once the capture is complete.
//
// Two backends (RECORD_BACKEND):
//   ownscribe — one ownscribe-audio process captures system audio (ScreenCaptureKit) + the
//               mic and, on stop, merges them host-time-aligned. No output routing, so the
//               macOS volume keys keep working. Writes 24 kHz mono float; finalize runs
//               asr/aec.py offline echo cancellation on the separate sys/mic tracks (kept via
//               --keep-tracks) when available, then transcodes to the canonical 16 kHz mono FLAC.
//   ffmpeg    — one ffmpeg captures an avfoundation device (e.g. a BlackHole Aggregate
//               Device) through the pan filter, writing <base>.wav (raw PCM); finalize
//               transcodes it to FLAC.
//
// All recording state lives in state/recording.json so isRecording()/currentFile() work
// regardless of who started it (CLI or daemon) and a recording can span >1 process. Capture
// processes are detached (unref) so they outlive a short-lived `murmur record` invocation.
import { existsSync, readFileSync, writeFileSync, openSync, mkdirSync, rmSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { ARTIFACTS, CANONICAL_AUDIO_EXT, recordingFolder } from "./paths.ts";
import { notify } from "./notify.ts";
import { sleep } from "./util.ts";
import { log } from "./log.ts";
import { transcodeToFlac16k } from "./transcode.ts";
import { stampFromDate } from "./stamp.ts";

export interface Recorder {
  isRecording(): boolean;
  currentFile(): string | null;
  start(): Promise<{ ok: boolean; message: string; base?: string }>;
  stop(): Promise<{ ok: boolean; message: string }>;
  finalizeOrphans(): Promise<string | null>;
}

// The canonical FLAC artifact filename inside a recording folder (recording.flac). Imports keep
// their own extension; murmur's OWN captures are always transcoded to this.
const CANONICAL_RECORDING = ARTIFACTS.recording(CANONICAL_AUDIO_EXT);

interface RecordingPart {
  pid: number;
  file: string;
}
interface RecordingState {
  backend: "ffmpeg" | "ownscribe";
  base: string;
  startedAt: number;
  // The raw capture in .partial/ is always parts[0].file (ffmpeg: <base>.wav PCM; ownscribe:
  // <base>.oa.wav 24 kHz float). Finalize transcodes it to inbox/<base>.flac.
  parts: RecordingPart[];
}

// Outcome of finalizing a capture. "failed" means audio WAS captured but encode/rename failed:
// the raw capture is kept AND the caller must keep recording.json so the 10s orphan sweep
// retries — we never silently drop a real meeting (especially ownscribe's .oa.wav, which the
// stray-recovery path deliberately ignores).
type FinalizeResult =
  | { status: "moved"; path: string }
  | { status: "empty" } // nothing usable captured — safe to clear state
  | { status: "failed" }; // recoverable failure — keep state + raw for a retry

export class MeetingRecorder implements Recorder {
  constructor(private cfg: Config) {}

  isRecording(): boolean {
    const st = this.readState();
    return !!st && st.parts.some((p) => alive(p.pid));
  }

  currentFile(): string | null {
    return this.readState()?.parts[0]?.file ?? null;
  }

  async start(): Promise<{ ok: boolean; message: string; base?: string }> {
    if (this.isRecording()) return { ok: false, message: "already recording" };
    await this.finalizeOrphans(); // clear any crashed/stale recording first

    const ts = stamp(new Date());
    const base = `meeting-${ts}`;
    for (const d of [this.cfg.paths.partialDir, this.cfg.paths.inboxDir, this.cfg.paths.logsDir, this.cfg.paths.stateDir]) {
      mkdirSync(d, { recursive: true });
    }

    let state: RecordingState;
    try {
      state =
        this.cfg.recordBackend === "ownscribe" ? this.startOwnscribe(base)
        : this.startFfmpeg(base);
    } catch (err) {
      return { ok: false, message: `could not start recording: ${String(err)}` };
    }
    this.writeState(state);
    const capture = state.parts[0]!.file;
    notify(this.cfg, "Meeting recording started");
    log.info("recorder", `recording [${state.backend}] → ${capture}`);
    // Expose the basename so the caller can associate per-recording data with this capture
    // (the recording folder is published as inbox/<base>/ when it finalizes).
    return { ok: true, message: `recording started (${capture})`, base };
  }

  /** ffmpeg backend: one ffmpeg captures the avfoundation device through the pan filter,
   *  writing raw PCM to .partial/<base>.wav (transcoded to FLAC at finalize). */
  private startFfmpeg(base: string): RecordingState {
    const capture = join(this.cfg.paths.partialDir, `${base}.wav`);
    const logFd = openSync(join(this.cfg.paths.logsDir, `${base}.log`), "a");
    const proc = Bun.spawn(
      ["ffmpeg", "-f", "avfoundation", "-i", `:${this.cfg.recordDeviceIndex}`, "-filter_complex", this.cfg.panFilter,
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", String(this.cfg.maxDurationSeconds), capture],
      { cwd: this.cfg.meetingsBase, env: { ...process.env, PATH: this.cfg.childPath }, stdin: "ignore", stdout: logFd, stderr: logFd },
    );
    proc.unref();
    if (!proc.pid) throw new Error("ffmpeg failed to start");
    return { backend: "ffmpeg", base, startedAt: Date.now(), parts: [{ pid: proc.pid, file: capture }] };
  }

  /** ownscribe backend: one ownscribe-audio process captures system (ScreenCaptureKit) + mic
   *  (AVFAudio) and, on stop, merges them host-time-aligned into one WAV. No output routing,
   *  so volume keys keep working. It writes a 24 kHz mono float WAV; finalize transcodes it to
   *  the canonical 16 kHz mono FLAC. */
  private startOwnscribe(base: string): RecordingState {
    if (!existsSync(this.cfg.ownscribeBin)) {
      throw new Error(`ownscribe-audio not found at ${this.cfg.ownscribeBin} — build it (see README → Recording backends)`);
    }
    const raw = join(this.cfg.paths.partialDir, `${base}.oa.wav`); // ownscribe's merged output (24 kHz float)
    const logFd = openSync(join(this.cfg.paths.logsDir, `${base}.log`), "a");
    const proc = Bun.spawn(
      [this.cfg.ownscribeBin, "capture", "-o", raw, "--mic", "--capture-mode-all", "--keep-tracks",
        "--max-duration", String(this.cfg.maxDurationSeconds)],
      { cwd: this.cfg.meetingsBase, env: { ...process.env, PATH: this.cfg.childPath }, stdin: "ignore", stdout: logFd, stderr: logFd },
    );
    proc.unref();
    if (!proc.pid) throw new Error("ownscribe-audio failed to start");
    return { backend: "ownscribe", base, startedAt: Date.now(), parts: [{ pid: proc.pid, file: raw }] };
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    const st = this.readState();
    if (!st) {
      await this.finalizeOrphans(); // rescue a partial whose capture already exited
      return { ok: false, message: "not recording" };
    }
    // SIGINT lets ffmpeg finalize its WAV; ownscribe-audio merges its two tracks on SIGINT,
    // which can take a few seconds — so wait generously (we break the instant it exits; only
    // a truly hung process hits the cap).
    for (const p of st.parts) {
      try { process.kill(p.pid, "SIGINT"); } catch {}
    }
    for (let i = 0; i < 600 && st.parts.some((p) => alive(p.pid)); i++) await sleep(100); // ~60s cap
    for (const p of st.parts) if (alive(p.pid)) { try { process.kill(p.pid, "SIGKILL"); } catch {} }

    const result = await this.finalizeState(st);
    // Keep recording.json on a recoverable failure so the daemon's 10s orphan sweep retries
    // finalize (the capture pids are already dead, so isRecording() stays false meanwhile).
    if (result.status !== "failed") this.clearState();
    notify(this.cfg, "Meeting recording stopped");
    log.info("recorder", `stopped recording [${st.backend}]`);

    if (result.status === "failed") {
      const w = "recording stopped, but finalizing failed — raw capture kept; it will retry automatically (or run `murmur stop` again)";
      log.error("recorder", w);
      return { ok: false, message: w };
    }
    const moved = result.status === "moved" ? result.path : null;
    let message = moved ? `recording stopped → ${moved}` : "recording stopped (no audio captured)";
    // Both backends produce a single merged track → check the final file's level.
    if (moved) {
      const peak = await measurePeakDb(this.cfg, moved);
      if (peak !== null && peak <= this.cfg.silenceDb) {
        const w = `⚠️ recording looks silent (peak ${peak} dBFS) — check audio routing / mic`;
        log.warn("recorder", w);
        notify(this.cfg, "Recording looks silent — check audio routing");
        message += `\n${w}`;
      }
    }
    return { ok: true, message };
  }

  /** Move recordings that ended without an explicit stop into inbox/. No-op while a
   *  recording is genuinely live; auto-stops one that exceeded MAX_DURATION; recovers a
   *  crashed recording (all capture pids dead) by finalizing whatever was captured. */
  async finalizeOrphans(): Promise<string | null> {
    const st = this.readState();
    if (st) {
      if (st.parts.some((p) => alive(p.pid))) {
        if (Date.now() - st.startedAt > this.cfg.maxDurationSeconds * 1000) {
          log.info("recorder", `recording ${st.base} hit max duration — auto-stopping`);
          return (await this.stop()).ok
            ? join(recordingFolder(this.cfg.paths.inboxDir, st.base), CANONICAL_RECORDING)
            : null;
        }
        return null; // in progress
      }
      log.info("recorder", `recovering interrupted recording ${st.base}`);
      const result = await this.finalizeState(st);
      if (result.status !== "failed") this.clearState(); // keep state to retry a failed finalize
      return result.status === "moved" ? result.path : null;
    }
    // No active recording: transcode any stray raw capture left in .partial/ (defensive).
    return this.moveStrayPartial();
  }

  /** Transcode the raw capture (parts[0]) → canonical 16 kHz mono FLAC inside a per-recording
   *  folder staged in .partial/, then atomically rename the whole FOLDER into inbox/ — so the
   *  watcher only ever sees a complete recording folder. See FinalizeResult: "failed" keeps the
   *  raw capture for the caller to retry. */
  private async finalizeState(st: RecordingState): Promise<FinalizeResult> {
    const capture = st.parts[0]?.file;
    if (!capture || !existsSync(capture) || statSync(capture).size === 0) {
      log.warn("recorder", `${st.base}: no audio captured`);
      this.cleanupTemps(st);
      return { status: "empty" };
    }
    // Build the recording folder in .partial/ (not the watched inbox/): encode the FLAC into
    // .partial/<base>/recording.flac, then atomic-rename the folder. The folder appearing in
    // inbox/ is, by construction, complete. Encode runs only once the capture is complete.
    const stageFolder = recordingFolder(this.cfg.paths.partialDir, st.base);
    const stageFlac = join(stageFolder, CANONICAL_RECORDING);
    rmSync(stageFolder, { recursive: true, force: true }); // clear any stale staging folder
    mkdirSync(stageFolder, { recursive: true });
    const source = st.backend === "ownscribe" ? await this.cancelEcho(st, capture) : capture;
    if (!(await transcodeToFlac16k(this.cfg, source, stageFlac))) {
      rmSync(stageFolder, { recursive: true, force: true });
      // Keep the raw capture (and, via the caller, the state) so finalize retries — never lose
      // the only copy of the meeting on a transient ffmpeg hiccup. No cleanupTemps here.
      log.error("recorder", `${st.base}: transcode failed — kept raw capture ${capture} for retry; manual: ffmpeg -i "${capture}" -ac 1 -ar 16000 -c:a flac "<out>.flac"`);
      return { status: "failed" };
    }
    const dest = recordingFolder(this.cfg.paths.inboxDir, st.base);
    try {
      mkdirSync(this.cfg.paths.inboxDir, { recursive: true });
      renameSync(stageFolder, dest); // atomic folder publish within the same filesystem
      log.info("recorder", `finalized → inbox/${st.base}/`);
    } catch (err) {
      // Drop the staged folder but keep the raw capture + state: a retry re-encodes from the raw,
      // so an inbox rename failure can't strand the recording (esp. ownscribe's .oa.wav, which
      // the stray-recovery path doesn't pick up).
      rmSync(stageFolder, { recursive: true, force: true });
      log.error("recorder", `${st.base}: inbox rename failed — kept raw capture for retry: ${String(err)}`);
      return { status: "failed" };
    }
    this.cleanupTemps(st);
    return { status: "moved", path: join(dest, CANONICAL_RECORDING) };
  }

  /** ownscribe only: if --keep-tracks produced separate sys/mic tracks, run asr/aec.py to
   *  cancel system-audio echo out of the mic before transcoding. Returns the file to transcode
   *  — the aec output on success, otherwise the original (gated) merge. Never throws: an aec
   *  failure just falls back, it must never fail finalize. */
  private async cancelEcho(st: RecordingState, capture: string): Promise<string> {
    const sys = `${capture}.sys.wav`;
    const mic = `${capture}.mic.wav`;
    const aec = `${capture}.aec.wav`;
    const nonEmpty = (f: string) => existsSync(f) && statSync(f).size > 0;
    if (!nonEmpty(sys) || !nonEmpty(mic)) return capture;
    try {
      const script = join(this.cfg.repoDir, "asr", "aec.py");
      const proc = Bun.spawn([this.cfg.pythonBin, script, sys, mic, aec], {
        env: { ...process.env, PATH: this.cfg.childPath },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code === 0 && nonEmpty(aec)) {
        log.info("recorder", `${st.base}: echo-cancelled mic (aec.py)`);
        return aec;
      }
      const stderr = (await new Response(proc.stderr).text()).slice(-300);
      log.warn("recorder", `${st.base}: aec.py failed (${code}) — using gated merge: ${stderr}`);
    } catch (err) {
      log.warn("recorder", `${st.base}: aec.py errored — using gated merge: ${String(err)}`);
    }
    return capture;
  }

  /** Recover a stray raw capture (meeting-<stamp>.wav, PCM) left in .partial/ when state was lost
   *  (e.g. an ffmpeg orphan whose recording.json was never written): transcode it to canonical
   *  FLAC in inbox/. Crucially, skip a file that's still being written — without state we can't
   *  check pid liveness, so we use a size-stability probe; transcoding+unlinking a growing capture
   *  would truncate it to a prefix and leave ffmpeg writing to a deleted inode. Only after a clean
   *  encode of a quiescent file is the raw PCM removed. Never touches backend temp tracks
   *  (.oa.wav, *.tmp.wav). */
  private async moveStrayPartial(): Promise<string | null> {
    const dir = this.cfg.paths.partialDir;
    if (!existsSync(dir)) return null;
    let last: string | null = null;
    for (const name of readdirSync(dir)) {
      if (!/^meeting-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.wav$/.test(name)) continue;
      const src = join(dir, name);
      try {
        if (!(await this.isQuiescent(src))) {
          log.info("recorder", `stray ${name} still growing — leaving for a later sweep`);
          continue; // a live orphan is still writing; recover it once it's done
        }
        const base = name.slice(0, -".wav".length);
        // Stage the recording folder in .partial/, then atomic-rename it into inbox/ (same as
        // the normal finalize path) — the watcher only sees a complete folder.
        const stageFolder = recordingFolder(dir, base);
        const stageFlac = join(stageFolder, CANONICAL_RECORDING);
        rmSync(stageFolder, { recursive: true, force: true });
        mkdirSync(stageFolder, { recursive: true });
        if (!(await transcodeToFlac16k(this.cfg, src, stageFlac))) { rmSync(stageFolder, { recursive: true, force: true }); continue; }
        const dest = recordingFolder(this.cfg.paths.inboxDir, base);
        mkdirSync(this.cfg.paths.inboxDir, { recursive: true });
        renameSync(stageFolder, dest);
        rmSync(src, { force: true }); // raw PCM consumed (file was quiescent → no live writer)
        log.info("recorder", `finalized stray recording → inbox/${base}/`);
        last = join(dest, CANONICAL_RECORDING);
      } catch (err) {
        if (existsSync(src)) log.warn("recorder", `could not finalize ${name}: ${String(err)}`);
      }
    }
    return last;
  }

  /** True if `path` is nonempty and its size holds steady across a short interval — a proxy for
   *  "no process is still writing to it" (mirrors the watcher's stable-size debounce). */
  private async isQuiescent(path: string): Promise<boolean> {
    let first: number;
    try { first = statSync(path).size; } catch { return false; }
    if (first === 0) return false;
    await sleep(1500);
    try { return statSync(path).size === first; } catch { return false; }
  }

  private cleanupTemps(st: RecordingState): void {
    for (const p of st.parts) {
      // The raw capture has been transcoded into inbox/ (or there was no audio) — drop it.
      try { if (existsSync(p.file)) unlinkSync(p.file); } catch {}
      // ownscribe-audio's own temp tracks, in case it died before cleaning them up itself.
      if (st.backend === "ownscribe") {
        for (const suffix of [".sys.tmp.wav", ".mic.tmp.wav", ".sys.wav", ".mic.wav", ".aec.wav"]) {
          try { if (existsSync(p.file + suffix)) unlinkSync(p.file + suffix); } catch {}
        }
      }
    }
  }

  private readState(): RecordingState | null {
    const f = this.cfg.paths.recordingState;
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as RecordingState;
    } catch {
      return null;
    }
  }

  private writeState(st: RecordingState): void {
    writeFileSync(this.cfg.paths.recordingState, JSON.stringify(st, null, 2));
  }

  private clearState(): void {
    rmSync(this.cfg.paths.recordingState, { force: true });
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

function stamp(d: Date): string {
  const s = stampFromDate(d); // YYYY-MM-DD_HH-MM-SS — the one timestamp format (see stamp.ts)
  return `${s.date}_${s.clock}`;
}

/** Peak volume in dBFS via ffmpeg volumedetect, or null if unreadable. */
export async function measurePeakDb(cfg: Config, file: string): Promise<number | null> {
  try {
    if (!existsSync(file)) return null;
    const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"],
      { env: { ...process.env, PATH: cfg.childPath }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    const m = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
