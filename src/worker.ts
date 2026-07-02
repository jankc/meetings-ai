// The serial GPU worker — exactly one transcribe+summarize job at a time.
// Honors soft/hard pause, auto-defers while a recording is in progress, processes each job
// unconditionally (location is the state — re-dropping a wav into inbox/ reprocesses it,
// overwriting outputs), and uses peek-then-commit so a crash mid-job replays cleanly.
import type { Config } from "./config.ts";
import type { Queue, QueueItem } from "./queue.ts";
import { basename } from "node:path";
import { artifactsFor } from "./paths.ts";
import { move, currentAudioFor } from "./recordings.ts";
import type { Recorder } from "./recorder.ts";
import { PauseStore, writeCurrent, clearCurrent, readCurrent } from "./jobstate.ts";
import { transcribe } from "./engines/asr.ts";
import { summarize, EMPTY_MARKER } from "./engines/ollama.ts";
import { archiveSummary } from "./archive.ts";
import { EngineError, isAbort } from "./engines/errors.ts";
import { logFailure } from "./failures.ts";
import { notify } from "./notify.ts";
import { log } from "./log.ts";

const IDLE_POLL_MS = 5000;

export class Worker {
  private running = false;
  private current: { ac: AbortController; job: QueueItem } | null = null;
  private wakeResolve: (() => void) | null = null;

  constructor(
    private cfg: Config,
    private queue: Queue,
    private recorder: Recorder,
    private pause: PauseStore,
  ) {}

  /** Wake the idle loop immediately (called when queue/pause/recording state changes). */
  notifyChange(): void {
    this.wakeResolve?.();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        this.wakeResolve = null;
        resolve();
      };
    });
  }

  async loop(): Promise<void> {
    this.running = true;
    await this.recover();
    log.info("worker", "loop started");
    while (this.running) {
      const blocked = this.pause.isPaused() || this.recorder.isRecording() || this.queue.size() === 0;
      if (blocked) {
        await this.wait(IDLE_POLL_MS);
        continue;
      }
      const job = this.queue.peek();
      if (!job) {
        await this.wait(IDLE_POLL_MS); // defensive: don't busy-spin if the head is gone
        continue;
      }
      await this.runOne(job);
    }
    log.info("worker", "loop stopped");
  }

  /** On startup, clear any stale current-job marker; the job itself is still queued
   *  (peek-then-commit) and will be retried — it just reruns from the top, overwriting outputs. */
  private async recover(): Promise<void> {
    const cur = await readCurrent(this.cfg);
    if (cur) {
      log.info("worker", `recovering interrupted job ${cur.basename} (was at stage ${cur.stage})`);
      await clearCurrent(this.cfg);
    }
  }

  /** Re-resolve the job's recording from its folder at process time (see `currentAudioFor`), so a
   *  recording edited while queued is processed on the first run rather than failing on the stale
   *  queued path. Logs when the resolved file differs from what was queued. */
  private async resolveAudio(job: QueueItem): Promise<QueueItem> {
    const fresh = await currentAudioFor(this.cfg, job.basename, job.wavPath);
    if (fresh === job.wavPath) return job;
    log.info("worker", `${job.basename}: recording resolved to ${basename(fresh)} (queued as ${basename(job.wavPath)})`);
    return { ...job, wavPath: fresh };
  }

  private async runOne(queued: QueueItem): Promise<void> {
    const ac = new AbortController();
    const job = await this.resolveAudio(queued);
    this.current = { ac, job };
    try {
      // The job is in inbox/<base>/ → process it unconditionally, overwriting any prior outputs.
      // (Re-dropping a recording into inbox is the supported way to reprocess; there are no
      // transcript/summary existence checks — location is the state.) Every artifact path is
      // derived from the recording file the job points at — its folder is its home.
      const { folder, transcript: txt, summary: summaryPath } = artifactsFor(job.wavPath);
      await writeCurrent(this.cfg, { basename: job.basename, stage: "transcribe", startedAt: Date.now() });
      await transcribe(this.cfg, job, ac.signal);

      await writeCurrent(this.cfg, { basename: job.basename, stage: "summarize", startedAt: Date.now() });
      const result = await summarize(this.cfg, txt, ac.signal);

      // Copy into the Obsidian vault (no-op if unconfigured). Abort propagates → requeue;
      // a vault error is logged but must not fail a job whose summary is already written locally.
      await writeCurrent(this.cfg, { basename: job.basename, stage: "archive", startedAt: Date.now() });
      try {
        await archiveSummary(this.cfg, folder, job.basename, ac.signal, result);
      } catch (err) {
        if (isAbort(err) || ac.signal.aborted) throw err;
        log.warn("worker", `archive failed for ${job.basename}: ${String(err)}`);
      }

      // A no-speech recording produces an empty-marker summary and no vault note. Read it from
      // the in-folder summary BEFORE the terminal move (which relocates the whole folder), so a
      // silent capture isn't reported as a misleading "Summary ready".
      const summaryText = await Bun.file(summaryPath).text().catch(() => "");

      // Done: the folder's home is now processed/<month>/ — that move IS the "processed"
      // signal (the watcher never looks outside inbox/ again).
      // Dequeue BEFORE the terminal move: if we crash in between, the folder stays in inbox/ and
      // the boot reconcile re-enqueues it (a harmless reprocess) — rather than staying
      // queued-but-already-moved, which would retry a now-missing path and misfile a completed
      // job into failed/.
      await this.queue.commitDequeue(job.basename);
      await move(this.cfg, job.basename, "processed");
      await clearCurrent(this.cfg);
      if (summaryText.trimStart().startsWith(EMPTY_MARKER)) {
        log.warn("worker", `${job.basename}: no speech detected — empty summary, no vault note`);
        notify(this.cfg, `⚠️ ${job.basename}: no speech detected (empty recording)`);
      } else {
        log.info("worker", `completed ${job.basename}`);
        notify(this.cfg, `Summary ready: ${job.basename}`);
      }
    } catch (err) {
      if (isAbort(err) || ac.signal.aborted) {
        await this.queue.requeueFront(job.basename, job.wavPath);
        await clearCurrent(this.cfg);
        log.warn("worker", `aborted ${job.basename} (hard pause) — requeued`);
      } else {
        const stage = (await readCurrent(this.cfg))?.stage ?? "process";
        const code = err instanceof EngineError ? err.exitCode : 1;
        if (err instanceof EngineError && err.detail) log.error("worker", `${job.basename} stderr: ${err.detail}`);
        await logFailure(this.cfg, job.basename, stage, code, job.wavPath);
        // Move out of inbox/ so a poison recording doesn't get re-enqueued every restart.
        await move(this.cfg, job.basename, "failed");
        await this.queue.commitDequeue(job.basename);
        await clearCurrent(this.cfg);
      }
    } finally {
      this.current = null;
    }
  }

  currentBasename(): string | null {
    return this.current?.job.basename ?? null;
  }

  async softPause(): Promise<void> {
    await this.pause.set("soft");
    this.notifyChange();
    log.info("worker", "soft pause (will finish current job, then idle)");
  }

  async hardPause(): Promise<void> {
    await this.pause.set("hard");
    this.current?.ac.abort();
    this.notifyChange();
    log.info("worker", "hard pause (aborting current job)");
  }

  async resume(): Promise<void> {
    await this.pause.set("none");
    this.notifyChange();
    log.info("worker", "resumed");
  }

  /** Graceful shutdown: stop the loop and abort any in-flight child. */
  shutdown(): void {
    this.running = false;
    this.current?.ac.abort();
    this.notifyChange();
  }
}
