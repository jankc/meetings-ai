// Best-effort macOS notifications via terminal-notifier, mirroring scripts/process.sh.
// Never throws — notifications are nice-to-have, not load-bearing.
import type { Config } from "./config.ts";
import { log } from "./log.ts";

export interface NotifyOptions {
  // Second-line context under the title (terminal-notifier's -subtitle). The meeting nudge uses it
  // for "Meeting detected" so the generic "Show" button reads unambiguously.
  subtitle?: string;
  // Shell command run when the user CLICKS the notification (terminal-notifier's -execute). Used by
  // the meeting nudge to make the banner a one-click "start recording". terminal-notifier dropped
  // action buttons in v2.0.0 (the click button is always labelled "Show"), so the message itself
  // says what clicking does. For the click to reliably run, set terminal-notifier to "Alerts" in
  // System Settings ▸ Notifications.
  execute?: string;
}

/** Single-quote a value for safe interpolation into the `/bin/sh -c` command terminal-notifier
 *  runs for `-execute` (the only metachar inside '' is '). Shared by every builder of an execute
 *  command (the meeting nudge's `record`, the "Summary ready" banner's Finder open). */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** An `-execute` command that opens `dir` in Finder (showing its contents) when the banner is
 *  clicked. Used by the completion notification so its "Show" button reveals the processed folder. */
export function openInFinderCmd(dir: string): string {
  return `open ${shq(dir)}`;
}

/** Build the terminal-notifier argv (pure → unit-testable). Optional subtitle / click-action are
 *  appended only when provided, so a plain notification's argv is unchanged. */
export function notifyArgs(message: string, opts: NotifyOptions = {}): string[] {
  const args = ["-title", "murmur", "-message", message, "-sound", "default"];
  if (opts.subtitle) args.push("-subtitle", opts.subtitle);
  if (opts.execute) args.push("-execute", opts.execute);
  return args;
}

export function notify(cfg: Config, message: string, opts: NotifyOptions = {}): void {
  try {
    Bun.spawn(["terminal-notifier", ...notifyArgs(message, opts)], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, PATH: cfg.childPath },
    });
  } catch (err) {
    log.warn("notify", `terminal-notifier failed: ${String(err)}`);
  }
}
