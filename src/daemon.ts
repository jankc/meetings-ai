// Daemon bootstrap: watcher → persistent queue → serial GPU-aware worker, plus the
// localhost control API. Shared by the LaunchAgent entry (main.ts) and `murmur daemon`.
import { mkdir } from "node:fs/promises";
import type { Config } from "./config.ts";
import { acquirePidLock, releasePidLock } from "./lock.ts";
import { Queue } from "./queue.ts";
import { PauseStore } from "./jobstate.ts";
import { MeetingRecorder } from "./recorder.ts";
import { Worker } from "./worker.ts";
import { startControl } from "./control.ts";
import { startWatcher } from "./watcher.ts";
import { MeetingWatcher } from "./meetwatch.ts";
import { runChecks } from "./health.ts";
import { log } from "./log.ts";

export async function runDaemon(cfg: Config): Promise<void> {
  // 1. Ensure the directory layout exists (independent dirs → create them concurrently).
  await Promise.all(
    [
      cfg.paths.partialDir,
      cfg.paths.inboxDir,
      cfg.paths.processedDir,
      cfg.paths.failedDir,
      cfg.paths.logsDir,
      cfg.paths.stateDir,
    ].map((dir) => mkdir(dir, { recursive: true })),
  );

  // 2. Single-instance lock (LaunchAgent KeepAlive + a manual run could otherwise double-run).
  if (!acquirePidLock(cfg.paths.lockFile)) {
    log.error("daemon", `another daemon is already running (lock ${cfg.paths.lockFile}); exiting`);
    process.exit(1);
  }

  // 3. Startup self-check — surfaces the #1 failure mode (binaries not on PATH).
  await selfCheck(cfg);

  // 4. Construct + wire modules.
  const queue = await Queue.load(cfg);
  const pause = await PauseStore.load(cfg);
  const recorder = new MeetingRecorder(cfg);
  const worker = new Worker(cfg, queue, recorder, pause);

  // Meeting auto-detection (mur003): opt-in, ownscribe-only. The watcher nudges a one-click
  // recording when a meeting app opens the mic; the doctor/self-check warns if enabled but unusable.
  let meetwatch: MeetingWatcher | null = null;
  if (cfg.autorecord.mode !== "off") {
    if (cfg.recordBackend === "ownscribe") meetwatch = new MeetingWatcher(cfg, recorder);
    else log.warn("daemon", `autorecord.mode=${cfg.autorecord.mode} needs the ownscribe backend (got ${cfg.recordBackend}) — meeting detection disabled`);
  }

  const server = startControl({ cfg, worker, queue, recorder, pause, meetwatch });
  meetwatch?.start();
  const watcher = startWatcher(cfg, (wav) => {
    // Fire-and-forget, but never let an enqueue error become an unhandled rejection
    // (which would crash the daemon) — log it and carry on.
    queue
      .enqueue(wav)
      .then((item) => {
        if (item) worker.notifyChange();
      })
      .catch((err) => log.warn("daemon", `enqueue ${wav} failed: ${String(err)}`));
  });

  // Move recordings that finished without an explicit stop (MAX_DURATION cap / crash)
  // from .partial/ into inbox/. Run once at boot, then poll — the watcher only sees
  // inbox/, so these stragglers need a nudge. (Normal stop() finalizes immediately.)
  const sweepOrphans = () => void recorder.finalizeOrphans().catch((e) => log.warn("daemon", `finalize: ${String(e)}`));
  sweepOrphans();
  const finalizeTimer = setInterval(sweepOrphans, 10_000);

  // 5. Graceful shutdown.
  let shuttingDown = false;
  const shutdown = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("daemon", `${sig} received — shutting down`);
    clearInterval(finalizeTimer);
    meetwatch?.stop();
    worker.shutdown();
    watcher.close();
    server.stop(true);
    releasePidLock(cfg.paths.lockFile);
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  log.info("daemon", `up — base=${cfg.meetingsBase} port=${cfg.port} pause=${pause.mode()} queueDepth=${queue.size()}`);

  // 6. Run the worker loop (resolves when shutdown() stops it).
  await worker.loop();
}

async function selfCheck(cfg: Config): Promise<void> {
  const diarize = cfg.diarize && !!cfg.hfToken;
  log.info("daemon", `asr model=${cfg.asrModel} lang=${cfg.language} diarize=${diarize}${diarize && cfg.numSpeakers ? ` num_speakers=${cfg.numSpeakers}` : ""}`);
  log.info("daemon", `summary provider=${cfg.summaryProvider} host=${cfg.summaryProvider === "omlx" ? cfg.omlxBaseUrl : cfg.ollamaHost} model=${cfg.modelSummary}`);
  log.info("daemon", `recorder backend=${cfg.recordBackend}${cfg.recordBackend === "ffmpeg" ? ` device index=${cfg.recordDeviceIndex}` : ""}`);
  // Shared with `murmur doctor`; the daemon only logs (it doesn't refuse to start).
  for (const c of await runChecks(cfg)) {
    const msg = `check ${c.name}: ${c.ok ? "ok" : c.detail}`;
    if (c.ok) log.info("daemon", msg);
    else if (c.level === "error") log.error("daemon", msg);
    else log.warn("daemon", msg);
  }
}
