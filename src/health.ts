// Setup/health checks shared by `murmur doctor` (prints a checklist, exits non-zero on a
// hard failure) and the daemon's startup selfCheck (logs them). One definition so the two
// can't drift. A check is "error" (the pipeline can't work) or "warn" (degraded/optional).
import { join } from "node:path";
import type { Config } from "./config.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  level: "error" | "warn";
}

export async function runChecks(cfg: Config): Promise<Check[]> {
  const checks: Check[] = [];
  const fileOk = (p: string) => Bun.file(p).exists();
  const add = (name: string, ok: boolean, detail: string, level: Check["level"] = "error") =>
    checks.push({ name, ok, detail, level });

  // The config file is optional (everything has a default), so a missing murmur.toml is a warn.
  const toml = `${cfg.repoDir}/murmur.toml`;
  add("config file", await fileOk(toml), `${toml} — none found, using defaults`, "warn");
  // The prompts dir is read on every non-trivial summarize (base + triage + the routed type) —
  // a missing file silently breaks it. Check the required ones.
  const promptFiles = [
    join(cfg.promptsDir, "base.md"),
    join(cfg.promptsDir, "triage.md"),
    join(cfg.promptsDir, "types", "summary.md"),
  ];
  const promptsOk = (await Promise.all(promptFiles.map(fileOk))).every(Boolean);
  add("summary prompts", promptsOk, cfg.promptsDir);
  add("asr venv python", await fileOk(cfg.pythonBin), cfg.pythonBin);

  const ffmpeg = Bun.which("ffmpeg", { PATH: cfg.childPath });
  add("ffmpeg", !!ffmpeg, ffmpeg ?? "not on PATH");

  if (cfg.recordBackend === "ownscribe") {
    const binExists = await fileOk(cfg.ownscribeBin);
    add("ownscribe-audio", binExists, cfg.ownscribeBin);
    if (binExists) {
      // The capture self-disclaims to become its own TCC responsible process (capture/README.md),
      // so it holds its OWN Microphone + Screen Recording grants — and those persist across rebuilds
      // only while the binary keeps a stable code identity. An ad-hoc signature (e.g. the stable
      // `murmur-ownscribe-codesign` cert went missing) silently resets the grants on the next
      // rebuild, so menubar (SwiftBar) recordings lose the mic. Flag it before that bites.
      const stable = await hasStableSignature(cfg.ownscribeBin, cfg.childPath);
      add("ownscribe-audio signature", stable,
        stable ? "stable identity — TCC grants survive rebuilds"
               : "ad-hoc — menubar recordings lose mic/screen grants on the next rebuild; sign with the stable cert (capture/README.md)",
        "warn");
      // Best-effort grant check: silent (null → skipped) if the TCC db can't be read.
      const home = process.env.HOME ?? "";
      const mic = await tccAllowed(join(home, "Library/Application Support/com.apple.TCC/TCC.db"), "kTCCServiceMicrophone", cfg.ownscribeBin);
      if (mic !== null) add("ownscribe-audio microphone", mic, mic ? "granted" : "not granted — run `murmur grant-mic`", "warn");
      const screen = await tccAllowed("/Library/Application Support/com.apple.TCC/TCC.db", "kTCCServiceScreenCapture", cfg.ownscribeBin);
      if (screen !== null) add("ownscribe-audio screen recording", screen, screen ? "granted" : "not granted — enable ownscribe-audio in System Settings → Screen Recording", "warn");
    }
  }

  if (cfg.summaryProvider === "omlx") {
    // oMLX: one authenticated /models call covers reachability AND the model list.
    const headers = cfg.omlxApiKey ? { authorization: `Bearer ${cfg.omlxApiKey}` } : undefined;
    const models = await fetch(`${cfg.omlxBaseUrl}/models`, { headers, signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d as { data?: { id?: string }[] } | null)?.data ?? null)
      .catch(() => null);
    add("omlx reachable", models !== null, `${cfg.omlxBaseUrl} — start the oMLX server (check omlx_api_key too)`);
    if (models !== null) {
      const present = models.some((m) => m.id === cfg.modelSummary);
      // warn only: oMLX resolves HF ids to discovered local models, so an exact-id miss can still work.
      add(`model ${cfg.modelSummary}`, present,
        present ? "available" : "not in /models — oMLX may still resolve the HF id at request time", "warn");
    }
  } else {
    const ollamaUp = await fetch(`${cfg.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);
    add("ollama reachable", ollamaUp, cfg.ollamaHost);
    if (ollamaUp) {
      const present = await fetch(`${cfg.ollamaHost}/api/show`, {
        method: "POST",
        body: JSON.stringify({ name: cfg.modelSummary }),
        signal: AbortSignal.timeout(3000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      add(`model ${cfg.modelSummary}`, present, present ? "available" : "not pulled — `ollama pull` or `ollama create` it");
    }
  }

  if (cfg.diarize) {
    add("HF_TOKEN (diarization)", !!cfg.hfToken, cfg.hfToken ? "set" : "empty — diarization will be skipped", "warn");
  }

  const tn = Bun.which("terminal-notifier", { PATH: cfg.childPath });
  add("terminal-notifier", !!tn, tn ?? "not installed — notifications are silently skipped", "warn");

  // Meeting auto-detection (mur003): only relevant when opted in. Always warn-level — detection is
  // optional and must never block the pipeline. It needs the ownscribe helper's `watch-mic`.
  if (cfg.autorecord.mode !== "off") {
    if (cfg.recordBackend !== "ownscribe") {
      add("meeting detection", false, `autorecord.mode=${cfg.autorecord.mode} needs the ownscribe backend (current: ${cfg.recordBackend})`, "warn");
    } else if (!(await fileOk(cfg.ownscribeBin))) {
      add("meeting detection", false, `ownscribe-audio not found at ${cfg.ownscribeBin} — build it (README → Recording backends)`, "warn");
    } else {
      const hasWatch = await helperHasWatchMic(cfg.ownscribeBin, cfg.childPath);
      add("meeting detection", hasWatch,
        hasWatch ? `on (mode=${cfg.autorecord.mode}; allow: ${cfg.autorecord.apps.join(", ") || "(none)"})`
                 : "installed ownscribe-audio lacks `watch-mic` — rebuild the helper (bash capture/build.sh)",
        "warn");
    }
  }

  return checks;
}

/** Cheap probe: does the installed ownscribe-audio advertise the `watch-mic` subcommand? Reads its
 *  --help (printed to stderr); false on any error so the caller just warns. */
async function helperHasWatchMic(bin: string, childPath: string): Promise<boolean> {
  try {
    const p = Bun.spawn([bin, "--help"], { env: { ...process.env, PATH: childPath }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await p.exited;
    return /\bwatch-mic\b/.test(out);
  } catch {
    return false;
  }
}

/** True if the Mach-O has a STABLE (certificate-based) designated requirement, so its TCC grants
 *  survive rebuilds. An ad-hoc / cdhash-pinned signature changes every build and resets the grants. */
async function hasStableSignature(bin: string, childPath: string): Promise<boolean> {
  try {
    const p = Bun.spawn(["codesign", "-d", "--requirements", "-", bin],
      { env: { ...process.env, PATH: childPath }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    await p.exited;
    return /certificate leaf/.test(out); // cert-based DR (vs "cdhash"/adhoc) → stable across rebuilds
  } catch {
    return false;
  }
}

/** Best-effort TCC lookup: is `binPath` (or the binary's bundle id) allowed for `service`? Returns
 *  null when the database can't be read (sqlite3 missing, unreadable db, …) so the caller skips the
 *  check rather than false-alarm. macOS-only; only reached for the ownscribe backend. */
async function tccAllowed(db: string, service: string, binPath: string): Promise<boolean | null> {
  try {
    if (!(await Bun.file(db).exists())) return null;
    const esc = binPath.replace(/'/g, "''");
    // Match either the path-keyed entry (ad-hoc/unsigned) or the bundle-id entry (signed binary).
    const q = `SELECT MAX(auth_value) FROM access WHERE service='${service}' AND (client='${esc}' OR client='com.jank.murmur.ownscribe-audio');`;
    const p = Bun.spawn(["sqlite3", db, q], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    if (p.exitCode !== 0) return null;
    return out !== "" && Number(out) >= 2; // empty = no row, 0 = denied, 2 = allowed
  } catch {
    return null;
  }
}
