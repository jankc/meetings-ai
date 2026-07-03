// Meeting auto-detection (mur003). Spawns the ownscribe helper's `watch-mic` (a permission-free
// CoreAudio sensor that emits `mic on <bundleid,…>` / `mic off` as the mic goes live), classifies
// the mic owner against the meeting allowlist / ignore-list, and — subject to debounce, an
// already-recording guard, and a post-stop cooldown — nudges a one-click recording via notify().
//
// The helper is a dumb sensor; ALL policy lives here in TypeScript so it's unit-testable (see the
// exported pure helpers below). Detection runs only inside the daemon (the long-lived LaunchAgent),
// only when [autorecord].mode !== "off" and the backend is ownscribe.
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { Config } from "./config.ts";
import type { Recorder } from "./recorder.ts";
import { notify, shq } from "./notify.ts";
import { setMeetingDetected, clearMeetingDetected } from "./jobstate.ts";
import { log } from "./log.ts";
import { sleep } from "./util.ts";

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────────────────────────

export type MicEdge = { kind: "on"; owners: string[] } | { kind: "off" };

/** Parse one line of `watch-mic` output. `mic on a,b` → owners ["a","b"]; `mic on` → []; `mic off`
 *  → off; anything else (blank, stderr noise) → null. */
export function parseWatchLine(line: string): MicEdge | null {
  const t = line.trim();
  if (t === "mic off") return { kind: "off" };
  if (t === "mic on" || t.startsWith("mic on ")) {
    const rest = t.slice("mic on".length).trim();
    return { kind: "on", owners: rest ? rest.split(",").map((s) => s.trim()).filter(Boolean) : [] };
  }
  return null;
}

/** Does `owner` match a configured bundle id — exactly, or as a helper sub-process of it? Electron/
 *  WebView meeting apps open the mic from a helper whose bundle id is the app's id plus a dotted
 *  suffix (e.g. `com.microsoft.teams2` → `com.microsoft.teams2.modulehost`), so we match on the
 *  dot-delimited prefix. The `+ "."` boundary keeps `com.microsoft.teams2x` from matching. */
export function matchesApp(owner: string, ids: string[]): boolean {
  return ids.some((id) => owner === id || owner.startsWith(id + "."));
}

/** Whether a mic-on edge looks like a meeting: at least one owner matches the allowlist AND none
 *  matches the ignore-list (a hard veto). Empty/unknown owners → false (fail closed — never nudge
 *  on a guess). Matching is prefix-aware so an app's helper processes count (see matchesApp). */
export function isMeetingEdge(owners: string[], allow: string[], ignore: string[]): boolean {
  if (owners.some((o) => matchesApp(o, ignore))) return false;
  return owners.some((o) => matchesApp(o, allow));
}

/** The non-timing guards, as a pure predicate so they're testable without real clocks/timers.
 *  Debounce is handled by the caller (it schedules this check after the debounce window). */
export function shouldNudge(args: {
  isRecording: boolean;
  armed: boolean; // false once we've nudged for the current call; re-armed on mic-off
  now: number;
  lastStopAt: number; // epoch ms of the last recording stop (0 = never)
  cooldownMs: number;
}): boolean {
  if (args.isRecording) return false; // already capturing — nothing to nudge
  if (!args.armed) return false; // at most one nudge per call
  if (args.lastStopAt && args.now - args.lastStopAt < args.cooldownMs) return false; // post-stop cooldown
  return true;
}

// ── Watcher ─────────────────────────────────────────────────────────────────────────────────────

export class MeetingWatcher {
  private proc: Subprocess<"ignore", "pipe", "ignore"> | null = null;
  private stopped = false;
  private micOn = false;
  private owners: string[] = [];
  private armed = true; // may nudge for the current call
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStopAt = 0;
  private readonly executeCmd: string;

  constructor(private cfg: Config, private recorder: Recorder) {
    // The one-click action terminal-notifier runs when the banner is clicked. Use THIS daemon's own
    // bun + the repo's cli.ts (both absolute) so it doesn't depend on PATH at click time.
    const cli = join(cfg.repoDir, "src", "cli.ts");
    this.executeCmd = `${shq(process.execPath)} ${shq(cli)} record`;
  }

  /** Start the watcher loop (auto-respawns the sensor with backoff until stop()). */
  start(): void {
    this.stopped = false;
    void this.runLoop();
    log.info("meetwatch", `meeting detection on — mode=notify allow=[${this.cfg.autorecord.apps.join(", ")}]${this.cfg.autorecord.ignoreApps.length ? ` ignore=[${this.cfg.autorecord.ignoreApps.join(", ")}]` : ""}`);
  }

  /** Stop the watcher and tear down the sensor process + any pending timer. */
  stop(): void {
    this.stopped = true;
    this.clearDebounce();
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }

  /** Tell the watcher a recording just stopped, so the cooldown suppresses an immediate re-nudge.
   *  Called by the daemon's control API on /record/stop. */
  markRecordingStopped(): void {
    this.lastStopAt = Date.now();
  }

  /** Respawn the sensor on unexpected exit, with bounded backoff — a dead sensor must never crash
   *  the daemon or busy-loop. */
  private async runLoop(): Promise<void> {
    let backoffMs = 1000;
    while (!this.stopped) {
      try {
        await this.runOnce();
        backoffMs = 1000; // clean read → reset backoff
      } catch (err) {
        log.warn("meetwatch", `watch-mic error: ${String(err)}`);
      }
      if (this.stopped) break;
      log.warn("meetwatch", `watch-mic exited — restarting in ${backoffMs}ms`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  /** Spawn one sensor process and consume its stdout until it exits. */
  private async runOnce(): Promise<void> {
    const proc = Bun.spawn([this.cfg.ownscribeBin, "watch-mic"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, PATH: this.cfg.childPath },
    });
    this.proc = proc;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const edge = parseWatchLine(line);
        if (edge) this.onEdge(edge);
      }
    }
    await proc.exited;
  }

  private onEdge(edge: MicEdge): void {
    if (edge.kind === "off") {
      this.micOn = false;
      this.owners = [];
      this.clearDebounce();
      this.armed = true; // re-arm: the next call may nudge again
      void clearMeetingDetected(this.cfg).catch(() => {});
      return;
    }
    // Rising edge (or owner refresh while on).
    this.micOn = true;
    this.owners = edge.owners;
    const { apps, ignoreApps } = this.cfg.autorecord;
    if (!this.armed) return; // already nudged for this call
    if (!isMeetingEdge(edge.owners, apps, ignoreApps)) return; // not a meeting (e.g. dictation) → ignore
    // Debounce: only nudge if the mic is still live after the window (filters dings / quick blips).
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => this.maybeNudge(), this.cfg.autorecord.debounceSeconds * 1000);
  }

  private maybeNudge(): void {
    this.debounceTimer = null;
    if (!this.micOn) return; // mic went off during the debounce window
    const ok = shouldNudge({
      isRecording: this.recorder.isRecording(),
      armed: this.armed,
      now: Date.now(),
      lastStopAt: this.lastStopAt,
      cooldownMs: this.cfg.autorecord.cooldownSeconds * 1000,
    });
    if (!ok) return;
    this.armed = false; // one nudge per call
    const meetingApp = this.owners.find((o) => this.cfg.autorecord.apps.includes(o));
    log.info("meetwatch", `meeting detected (${meetingApp ?? this.owners.join(",")}) — nudging`);
    notify(this.cfg, "Click to record — ignore to skip", { subtitle: "Meeting detected", execute: this.executeCmd });
    void setMeetingDetected(this.cfg, meetingApp).catch(() => {});
  }

  private clearDebounce(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }
}
