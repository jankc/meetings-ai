#!/usr/bin/env bun
// murmur — the unified CLI. Shares the same modules as the daemon, so
// there's a single implementation of every step. Stateful actions (record/process/
// pause/status) talk to the daemon when it's running, and fall back to doing the work
// directly when it isn't; one-shot transcribe/summarize always run inline.
import { basename, dirname, join } from "node:path";
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { loadConfig, configAsEnv, type Config } from "./config.ts";
import { artifactsFor, isRecordingFile } from "./paths.ts";
import { resolveContext, saveContext } from "./context.ts";
import { runDaemon } from "./daemon.ts";
import { MeetingRecorder } from "./recorder.ts";
import { transcribe } from "./engines/asr.ts";
import { summarize } from "./engines/summary.ts";
import { archiveSummary } from "./archive.ts";
import { type QueueItem } from "./queue.ts";
import { resolveWav, folderAudio, recordingBase, isManagedRecording, move } from "./recordings.ts";
import { runImport } from "./import.ts";
import { purge } from "./purge.ts";
import { EngineError } from "./engines/errors.ts";
import { logFailure } from "./failures.ts";
import { PauseStore } from "./jobstate.ts";
import { sleep, parseNum } from "./util.ts";
import { offlineSnapshot, renderStatus, type StatusSnapshot } from "./status.ts";
import { renderSwiftBar } from "./swiftbar.ts";
import { runChecks } from "./health.ts";

const cfg = loadConfig();
const [cmd = "help", ...rest] = process.argv.slice(2);

const api = (path: string) => `http://127.0.0.1:${cfg.port}${path}`;
const daemonGet = (path: string) => fetch(api(path), { signal: AbortSignal.timeout(1500) });
const daemonPost = (path: string, body?: unknown) =>
  fetch(api(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
const daemonUp = () => daemonGet("/status").then((r) => r.ok).catch(() => false);

/** One snapshot of "what is murmur doing", from the daemon if up, else from on-disk state.
 *  Shared by the one-shot `status` and its `--watch` loop so they can't drift. */
async function fetchStatus(cfg: Config): Promise<StatusSnapshot & { daemon: string }> {
  const up = await daemonUp();
  const base = up
    ? ((await (await daemonGet("/status")).json()) as StatusSnapshot)
    : await offlineSnapshot(cfg);
  return { daemon: up ? "running" : "offline", ...base };
}

function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}
// Flags that consume the following arg as their value. positional() must skip both the flag and
// its value, else a value that doesn't start with "-" (e.g. `--context "SPEAKER_00 = Petr"`) would
// be mistaken for the positional argument.
const VALUE_FLAGS = new Set(["--context", "-c", "--device", "-d"]);
function positional(): string | undefined {
  let skipNext = false; // true right after a value-flag, to skip the value it consumes
  for (const a of rest) {
    if (skipNext) { skipNext = false; continue; }
    if (VALUE_FLAGS.has(a)) { skipNext = true; continue; }
    if (!a.startsWith("-")) return a; // first real positional
  }
  return undefined;
}

/** Read the `--context`/`-c` flag, resolve it, and persist it to the recording's folder (no-op when
 *  absent or empty), printing a confirmation on write. Shared by process/reprocess/transcribe/
 *  summarize. `record` resolves separately (before start(), so `--context -` can prompt first). */
async function applyContext(folder: string): Promise<void> {
  const path = await saveContext(folder, await resolveContext(flag("--context") ?? flag("-c")));
  if (path) console.log(`context saved → ${path}`);
}

function newestRecording(cfg: Config): string | null {
  // Newest pending in inbox/ if any (the usual "process what I just recorded"); else
  // newest already-processed recording (inbox + processed are searched, recursively).
  const dirs = [cfg.paths.inboxDir, cfg.paths.processedDir];
  let best: { path: string; mtime: number } | null = null;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!isRecordingFile(e)) continue;
      const p = `${dir}/${e}`;
      const mtime = statSync(p).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: p, mtime };
    }
    if (best && dir === cfg.paths.inboxDir) break; // prefer a pending recording
  }
  return best?.path ?? null;
}

async function runInline(wavPath: string): Promise<{ txt: string; md: string }> {
  const base = recordingBase(cfg, wavPath);
  const managed = isManagedRecording(cfg, wavPath);
  const job: QueueItem = { basename: base, wavPath, enqueuedAt: 0, attempts: 0 };
  const signal = new AbortController().signal;
  // Process unconditionally, overwriting any prior outputs — same as the daemon worker. Every
  // artifact path is derived from the recording file's own folder.
  const { folder, transcript: txt, summary: md } = artifactsFor(wavPath);
  let stage = "transcribe";
  try {
    await transcribe(cfg, job, signal);
    stage = "summarize";
    const result = await summarize(cfg, txt, signal);
    await archiveSummary(cfg, folder, base, signal, result).catch((e) => console.error(`archive: ${String(e)}`));
    // Only retire managed recordings (in a lifecycle folder) to processed/; move() resolves by
    // basename, so for an external one-off path that would risk relocating an unrelated recording
    // whose basename happens to match.
    if (managed) await move(cfg, base, "processed");
    return { txt, md };
  } catch (err) {
    const code = err instanceof EngineError ? err.exitCode : 1;
    // Only managed recordings have a failed/ home; an external one-off path (`murmur process
    // /some/file.wav`) is left where it is — move()/logFailure resolve by basename and could
    // otherwise misfile a managed recording that shares the basename.
    if (managed) {
      await logFailure(cfg, base, stage, code, wavPath);
      await move(cfg, base, "failed");
    }
    throw err;
  }
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Single-quote a value for safe `eval` in a POSIX shell (the only metachar inside '' is '). */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

const DAEMON_LABEL = "com.jank.murmur.daemon";
const IMPORT_LABEL = "com.jank.murmur.import";

// The lifecycle verbs every murmur LaunchAgent understands. One source of truth for both the
// `launchctlManage` action type and the `murmur <daemon|import> <sub>` dispatch guards.
const LAUNCH_ACTIONS = ["start", "stop", "restart", "install"] as const;
type LaunchAction = (typeof LAUNCH_ACTIONS)[number];
const isLaunchAction = (s: string | undefined): s is LaunchAction =>
  (LAUNCH_ACTIONS as readonly string[]).includes(s as string);

/** Enqueue a resolved wav via the daemon, or process it inline when the daemon is down. */
async function dispatchWav(wav: string): Promise<void> {
  if (await daemonUp()) {
    const res = await daemonPost("/enqueue", { wav });
    console.log(`enqueued via daemon: ${await res.text()}`);
  } else {
    console.error(`daemon offline — processing inline: ${basename(wav)}`);
    const { txt, md } = await runInline(wav);
    console.log(`transcript: ${txt}`);
    console.log(`summary:    ${md}`);
  }
}

/** Re-run one recording inline without colliding with a running daemon. Unlike `dispatchWav`,
 *  this never hands the job to the daemon — it runs in *this* process so the invoking
 *  environment's config wins (e.g. `ASR_LANG=cs murmur reprocess …` to fix a mis-detected
 *  language; the daemon would use its own ASR_LANG). The daemon owns a single serial GPU worker,
 *  so to avoid running a second transcribe/diarize alongside its job we soft-pause that worker
 *  (which lets any in-flight job finish and blocks new ones), wait for it to drain, run, then
 *  restore the prior pause state. A Ctrl-C mid-run restores it too, so an interrupt can't leave
 *  the daemon stuck paused. With the daemon down there's nothing to coordinate. */
async function reprocessInline(wav: string): Promise<void> {
  const runAndReport = async () => {
    const { txt, md } = await runInline(wav);
    console.log(`transcript: ${txt}`);
    console.log(`summary:    ${md}`);
  };

  if (!(await daemonUp())) {
    await runAndReport();
    return;
  }

  const snapshot = (): Promise<StatusSnapshot | null> =>
    daemonGet("/status").then((r) => r.json() as Promise<StatusSnapshot>).catch(() => null);

  const prior = (await snapshot())?.pause ?? "none";
  const weHold = prior === "none"; // never clobber a pause the user set themselves
  const restore = () => (weHold ? daemonPost("/resume").then(() => {}, () => {}) : Promise.resolve());

  const onSigint = () => void restore().finally(() => process.exit(130));
  process.once("SIGINT", onSigint);
  try {
    if (weHold) await daemonPost("/pause", { mode: "soft" }).catch(() => {});
    let announced = false;
    for (;;) {
      const snap = await snapshot();
      if (!snap || !snap.current) break; // daemon idle (or gone) — safe to run inline
      if (!announced) {
        console.error(`daemon busy with ${snap.current.basename} — waiting for it to finish…`);
        announced = true;
      }
      await sleep(1000);
    }
    await runAndReport();
  } finally {
    process.removeListener("SIGINT", onSigint);
    await restore();
  }
}

async function launchctl(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, out: (out + err).trim() };
}

/** Manage a murmur LaunchAgent so config/plist changes don't need raw launchctl. `restart`
 *  re-reads an edited plist (bootout + bootstrap — `kickstart` alone would not); `install`
 *  copies the repo plist template into ~/Library/LaunchAgents first (rendering __REPO__,
 *  __HOME__, __BUN_DIR__ from this process so there's nothing to hand-edit).
 *
 *  Shared by the daemon and the import scheduler — the two jobs differ only in label and
 *  template name; their lifecycle (start/stop/restart/install) is identical. */
async function launchctlManage(
  cfg: Config,
  label: string,
  action: LaunchAction,
  noun: string,
): Promise<void> {
  const { uid, homedir } = userInfo();
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const installed = join(homedir, "Library/LaunchAgents", `${label}.plist`);
  const bootstrap = () => launchctl("bootstrap", domain, installed);

  if (action === "install") {
    const tmpl = join(cfg.repoDir, "launchd", `${label}.plist.example`);
    if (!existsSync(tmpl)) die(`plist template not found: ${tmpl}`);
    // Render the machine paths from the running environment (process.execPath is this very
    // bun) so there's nothing to hand-edit; run-{daemon,import}.sh derives the log path via print-env.
    const rendered = readFileSync(tmpl, "utf8")
      .replaceAll("__REPO__", cfg.repoDir)
      .replaceAll("__HOME__", homedir)
      .replaceAll("__BUN_DIR__", dirname(process.execPath));
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, rendered);
    console.log(`installed → ${installed}`);
  } else if (!existsSync(installed)) {
    die(`${noun} not installed (${installed} missing) — run: murmur ${noun} install`);
  }

  if (action === "stop") {
    const r = await launchctl("bootout", target);
    console.log(r.ok ? `${noun} stopped` : `not running (${r.out || "no such service"})`);
    return;
  }
  if (action === "start") {
    const r = await bootstrap();
    if (!r.ok) die(`start failed: ${r.out || "already running?"}`);
    console.log(`${noun} started`);
    return;
  }
  // restart / install → bootstrap, after booting out any loaded instance.
  await launchctl("bootout", target); // ignore "not loaded"
  await sleep(300);
  const r = await bootstrap();
  if (!r.ok) die(`bootstrap failed: ${r.out}`);
  console.log(action === "install" ? `${noun} installed and started` : `${noun} restarted`);
}

const daemonctl = (cfg: Config, action: LaunchAction) =>
  launchctlManage(cfg, DAEMON_LABEL, action, "daemon");
const importctl = (cfg: Config, action: LaunchAction) =>
  launchctlManage(cfg, IMPORT_LABEL, action, "import");

const USAGE = `murmur — local meeting recorder / transcriber / summarizer

Usage: murmur <command> [args]

  record [--device N]      start recording (system audio + your mic)
  stop                     stop the current recording

  Add --context/-c "text" (or @file, or - for stdin) to record/process/reprocess/transcribe/
  summarize to attach notes (who SPEAKER_NN is, the topic, acronyms). Stored per recording as
  context.md, reused on later re-runs, and injected into the summary only.

  grant-mic                trigger the microphone permission prompt for the launching app
                           (ownscribe backend; run it once from the menubar — see README)
  process [audio]          transcribe + summarize (newest, or by path/basename)
  import [<sub>]           pull new recordings from external sources into inbox/
                           (sub: install|start|stop|restart manages the periodic LaunchAgent)
  reprocess <name>         re-run the pipeline for one recording inline (incl. from
                           failed/ or processed/); honors env overrides like ASR_LANG,
                           coordinating with the daemon so it never double-runs the GPU
  retry-failed             re-enqueue every recording in recordings/failed/
  purge [--apply]          find empty/junk recordings & delete all their artifacts (dry-run without --apply)
  transcribe [audio]       transcribe only → prints transcript path
  summarize <transcript>   summarize a transcript → prints summary path
  status [--json] [--watch] recording / pause / queue / failures (--json for tools; --watch [secs] for a live view)
  pause [hard]             pause processing (soft = finish current; hard = abort + requeue)
  resume                   resume processing
  doctor                   check setup (venv, ffmpeg, summary LLM+model, ownscribe, …) → non-zero on problems
  logs [failures|import] [-f]  tail daemon logs (or process-failures.log / import logs); -f to follow
  daemon <sub>             run | start | stop | restart | install (manage the LaunchAgent)
  print-env                resolved config as shell exports (used by run-daemon.sh)

Stateful commands use the daemon if it's running, else act directly.`;

switch (cmd) {
  case "daemon": {
    const sub = rest[0];
    if (sub === undefined || sub === "run") await runDaemon(cfg);
    else if (isLaunchAction(sub)) await daemonctl(cfg, sub);
    else die(`unknown: murmur daemon ${sub} (run|start|stop|restart|install)`);
    break;
  }

  case "record": {
    const dev = flag("--device") ?? flag("-d");
    // Resolve context BEFORE starting (so `--context -` lets the user type it, then recording begins).
    const ctx = await resolveContext(flag("--context") ?? flag("-c"));
    const recorder = new MeetingRecorder(dev ? { ...cfg, recordDeviceIndex: dev } : cfg);
    const r = await recorder.start();
    // start() returns the recording's basename — surface it so the caller knows the folder
    // (inbox/<base>/) this capture will publish to.
    console.log(r.base ? `${r.message} [${r.base}]` : r.message);
    // Persist context into .partial/<base>/; the atomic rename into inbox/ carries it along and the
    // daemon's later summary picks it up. Only when the capture actually started.
    if (r.ok && r.base) {
      const path = await saveContext(join(cfg.paths.partialDir, r.base), ctx);
      if (path) console.log(`context saved → ${path}`);
    }
    if (!r.ok) process.exit(1);
    break;
  }

  case "stop": {
    const r = await new MeetingRecorder(cfg).stop();
    console.log(r.message);
    if (!r.ok) process.exit(1);
    break;
  }

  case "grant-mic": {
    // Trigger the microphone TCC prompt in THIS process — a child of whatever launched the CLI
    // (e.g. the SwiftBar menubar) — and run it SYNCHRONOUSLY (no unref/detach). The recorder
    // detaches the long-lived capture, which makes macOS swallow the prompt; a launcher without
    // the Microphone grant then records a silent mic. Running the request inline lets macOS
    // attribute the prompt to the launching app so it can be authorized once. Never proxied to
    // the daemon (it's detached under launchd — the prompt would be swallowed there too).
    if (cfg.recordBackend !== "ownscribe") {
      die("grant-mic applies to the ownscribe backend; the ffmpeg backend uses the launching app's avfoundation permission directly");
    }
    if (!existsSync(cfg.ownscribeBin)) die(`ownscribe-audio not found at ${cfg.ownscribeBin}`);
    const proc = Bun.spawnSync([cfg.ownscribeBin, "request-mic"], {
      env: { ...process.env, PATH: cfg.childPath },
      stdout: "pipe", stderr: "pipe",
    });
    const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`.trim();
    // Mirror to a log file: launched from the SwiftBar menubar (terminal=false) there's no
    // visible output, so this is the only way to see whether the prompt ran / what TCC said.
    try {
      mkdirSync(cfg.paths.logsDir, { recursive: true });
      writeFileSync(join(cfg.paths.logsDir, "grant-mic.log"),
        `[${new Date().toISOString()}] exit=${proc.exitCode}\n${out}\n`, { flag: "a" });
    } catch {}
    if (out) console.log(out);
    process.exit(proc.exitCode ?? 1);
  }

  case "status": {
    const watch = rest.includes("--watch") || rest.includes("-w");
    // A live view only makes sense on a terminal — to a pipe it'd just spew escape codes,
    // so fall back to a single render there (and for --json, which is for machines).
    if (watch && process.stdout.isTTY && !rest.includes("--json")) {
      const every = Math.max(0.25, parseNum(flag("--watch") ?? flag("-w") ?? "", 2)) * 1000;
      const showCursor = () => process.stdout.write("\x1b[?25h");
      const onExit = () => { showCursor(); process.exit(0); };
      process.on("SIGINT", onExit);
      process.on("SIGTERM", onExit);
      process.stdout.write("\x1b[?25l\x1b[2J\x1b[H"); // hide cursor + clear screen for a clean canvas
      try {
        for (;;) {
          let body: string;
          try {
            body = renderStatus(await fetchStatus(cfg));
          } catch (e) {
            body = `status unavailable: ${String(e)}`;
          }
          const ts = new Date().toLocaleTimeString();
          const frame = `${body}\n\n[watching every ${every / 1000}s — Ctrl-C to exit · ${ts}]`;
          // Home, clear each line's tail (\x1b[K) as we redraw, then wipe anything below
          // (\x1b[0J) — so a line shorter than the previous frame leaves no stale characters.
          process.stdout.write(`\x1b[H${frame.replace(/\n/g, "\x1b[K\n")}\x1b[K\x1b[0J`);
          await sleep(every);
        }
      } finally {
        showCursor();
      }
    }
    const snap = await fetchStatus(cfg);
    if (rest.includes("--json")) console.log(JSON.stringify(snap, null, 2));
    else console.log(renderStatus(snap));
    break;
  }

  case "pause": {
    const mode = positional() === "hard" ? "hard" : "soft";
    if (await daemonUp()) {
      const res = await daemonPost("/pause", { mode }).catch((e) => die(`pause failed: ${String(e)}`));
      if (!res.ok) die(`pause failed: HTTP ${res.status}`);
      const body = (await res.json()) as { pause?: string };
      console.log(`paused (${body.pause ?? mode}) [daemon]`);
    } else {
      await (await PauseStore.load(cfg)).set(mode);
      console.log(`paused (${mode}) [offline — state written, no daemon to honor it]`);
    }
    break;
  }

  case "resume": {
    if (await daemonUp()) {
      const res = await daemonPost("/resume").catch((e) => die(`resume failed: ${String(e)}`));
      if (!res.ok) die(`resume failed: HTTP ${res.status}`);
      console.log("resumed [daemon]");
    } else {
      await (await PauseStore.load(cfg)).set("none");
      console.log("resumed [offline — state written]");
    }
    break;
  }

  case "swiftbar": {
    // Used by the SwiftBar plugin; renders from on-disk state (daemon-independent).
    process.stdout.write(await renderSwiftBar(cfg, process.execPath, import.meta.path));
    break;
  }

  case "doctor": {
    const checks = await runChecks(cfg);
    for (const c of checks) {
      const icon = c.ok ? "✓" : c.level === "error" ? "✗" : "⚠";
      console.log(`${icon} ${c.name}: ${c.ok ? "ok" : c.detail}`);
    }
    const failed = checks.filter((c) => !c.ok && c.level === "error");
    if (failed.length > 0) die(`\n${failed.length} check(s) failed`);
    console.log("\nall good");
    break;
  }

  case "logs": {
    const which = positional(); // "failures" → process-failures.log; "import" → import logs; else daemon
    const follow = rest.includes("-f") || rest.includes("--follow");
    const files =
      which === "failures"
        ? [cfg.paths.failureLog]
        : which === "import"
          ? [join(cfg.paths.logsDir, "import.out.log"), join(cfg.paths.logsDir, "import.err.log")]
          : [join(cfg.paths.logsDir, "daemon.out.log"), join(cfg.paths.logsDir, "daemon.err.log")];
    const existing = files.filter((f) => existsSync(f));
    if (existing.length === 0) {
      console.log(`no logs yet under ${cfg.paths.logsDir}`);
      break;
    }
    const tailArgs = follow ? ["-n", "40", "-F", ...existing] : ["-n", "80", ...existing];
    await Bun.spawn(["tail", ...tailArgs], { stdout: "inherit", stderr: "inherit", stdin: "ignore" }).exited;
    break;
  }

  case "process": {
    const arg = positional();
    const wav = arg ? await resolveWav(cfg, arg) : newestRecording(cfg);
    if (!wav) die(`no recording found${arg ? `: ${arg}` : ""}`);
    await applyContext(dirname(wav));
    try { await dispatchWav(wav); } catch (e) { die(`processing failed: ${String(e)}`); }
    break;
  }

  case "import": {
    // Subcommand (install|start|stop|restart) manages the periodic LaunchAgent — same
    // surface as `murmur daemon <sub>`. Bare `murmur import` runs once; an unrecognized sub
    // is an error, not a silent fall-through to a poll (else a typo'd `install`/`restart`
    // would look like it set up the scheduler when it only ran one import).
    const sub = rest[0];
    if (isLaunchAction(sub)) {
      await importctl(cfg, sub);
      break;
    }
    if (sub !== undefined) die(`unknown: murmur import ${sub} (install|start|stop|restart) — or bare \`murmur import\` to run once`);
    // Pure producer: pull new external recordings into inbox/. The daemon's watcher (or the
    // next boot's reconcile) picks them up exactly like a normal recording.
    const summary = await runImport(cfg).catch((e) => die(`import failed: ${String(e)}`));
    if (summary.skipped) {
      console.log("another `murmur import` is already running — skipped this run");
      break;
    }
    if (summary.sources.length === 0) {
      console.log("no enabled sources — add a [[sources]] block to murmur.toml (see murmur.toml.example)");
      break;
    }
    let totalImported = 0;
    let totalFailed = 0;
    for (const s of summary.sources) {
      const skipped = s.scanned - s.imported - s.failed;
      console.log(`${s.name}: scanned=${s.scanned} imported=${s.imported} skipped=${skipped} failed=${s.failed}`);
      totalImported += s.imported;
      totalFailed += s.failed;
    }
    if (totalImported > 0) {
      const next = (await daemonUp()) ? "the daemon will process them" : "start the daemon or run `murmur process` to process them";
      console.log(`\n${totalImported} recording(s) → inbox/ — ${next}.`);
    }
    if (totalFailed > 0) die(`\n${totalFailed} item(s) failed (will retry on the next import)`);
    break;
  }

  case "reprocess": {
    const arg = positional();
    if (!arg) die("usage: murmur reprocess <name|path>");
    const wav = await resolveWav(cfg, arg);
    if (!wav) die(`recording not found: ${arg}`);
    await applyContext(dirname(wav));
    try { await reprocessInline(wav); } catch (e) { die(`processing failed: ${String(e)}`); }
    break;
  }

  case "purge": {
    // Find empty/junk recordings (transcript-based) and delete all their artifacts.
    // Dry-run by default; --apply actually deletes. Never part of the pipeline.
    await purge(cfg, rest.includes("--apply"));
    break;
  }

  case "retry-failed": {
    let names: string[];
    try {
      names = readdirSync(cfg.paths.failedDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch {
      names = [];
    }
    if (names.length === 0) {
      console.log("no failed recordings to retry");
      break;
    }
    console.log(`retrying ${names.length} failed recording(s)…`);
    const stillFailing: string[] = [];
    for (const n of names) {
      // Don't let one bad recording (inline path) abort the rest — catch, continue, report.
      // Dispatch the in-folder recording file (any name/extension — a manual trim may have
      // re-saved it as .m4a or under a new name; folderAudio finds it, newest-wins if duplicated).
      const rec = await folderAudio(join(cfg.paths.failedDir, n));
      if (!rec) {
        stillFailing.push(n);
        console.error(`  ✗ ${n}: no recording file in failed/${n}/`);
        continue;
      }
      try {
        await dispatchWav(rec);
      } catch (e) {
        stillFailing.push(n);
        console.error(`  ✗ ${n}: ${String(e)}`);
      }
    }
    if (stillFailing.length > 0) die(`\n${stillFailing.length}/${names.length} still failing`);
    break;
  }

  case "transcribe": {
    const arg = positional() ?? newestRecording(cfg) ?? "";
    const wav = (await resolveWav(cfg, arg)) ?? (arg && (await Bun.file(arg).exists()) ? arg : null);
    if (!wav) die(`recording not found: ${arg || "(none)"}`);
    // transcribe writes no summary, but persist context for a later `summarize`/`reprocess`.
    await applyContext(dirname(wav));
    const base = recordingBase(cfg, wav);
    const { transcript: txt } = artifactsFor(wav);
    await transcribe(cfg, { basename: base, wavPath: wav, enqueuedAt: 0, attempts: 0 }, new AbortController().signal);
    console.log(txt);
    break;
  }

  case "summarize": {
    const arg = positional();
    if (!arg) die("usage: murmur summarize <transcript|basename>");
    // Accept a direct transcript path, or a recording name/basename → its folder's transcript.txt.
    let txt: string;
    if (await Bun.file(arg).exists()) {
      txt = arg;
    } else {
      const wav = await resolveWav(cfg, arg);
      txt = wav ? artifactsFor(wav).transcript : "";
    }
    if (!txt || !(await Bun.file(txt).exists())) die(`transcript not found: ${arg}`);
    const folder = dirname(txt);
    await applyContext(folder);
    const sig = new AbortController().signal;
    const result = await summarize(cfg, txt, sig);
    await archiveSummary(cfg, folder, basename(folder), sig, result).catch((e) => console.error(`archive: ${String(e)}`));
    console.log(result.summaryPath);
    break;
  }

  case "print-env": {
    // The resolved config as shell exports. launchd/run-daemon.sh evals this to find the log
    // dir (MEETINGS_BASE) without re-parsing murmur.toml in shell. Also a handy "what config is
    // actually in effect?" for debugging.
    for (const [k, v] of Object.entries(configAsEnv(cfg))) process.stdout.write(`export ${k}=${shQuote(v)}\n`);
    break;
  }

  case "help":
  case "-h":
  case "--help":
    console.log(USAGE);
    break;

  default:
    console.error(`unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
}
