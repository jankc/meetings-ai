// Load configuration, layered env > murmur.toml > defaults. murmur.toml (gitignored) is the one
// config file; an environment variable always wins (e.g. the launchd plist, or HF_TOKEN if you'd
// rather not keep it in the file). Produces one frozen Config.
import { join, dirname, delimiter } from "node:path";
import { buildPaths, type Paths } from "./paths.ts";
import { truthy, parseNum } from "./util.ts";
import { readMurmurToml, expandHome } from "./tomlconfig.ts";
import { log } from "./log.ts";

export interface Config {
  repoDir: string;
  meetingsBase: string;
  paths: Paths;
  port: number;
  // ASR — transcription (mlx-whisper) + optional diarization (pyannote community-1),
  // both run by asr/asr.py in one venv.
  pythonBin: string; // python of the asr venv
  asrModel: string; // mlx-whisper model (hf repo)
  language: string;
  trimSilence: boolean; // trim leading/trailing near-silence before ASR (keeps language auto-detect on real speech)
  trimThresholdDb: number; // dBFS below which audio counts as silence for the head/tail trim
  diarize: boolean;
  numSpeakers: number; // hint for diarization; 0 = auto-detect
  hfToken: string;
  // summarization LLM — provider picks the transport (see engines/llm.ts)
  summaryProvider: "ollama" | "omlx";
  ollamaHost: string;
  omlxBaseUrl: string; // OpenAI-compatible base URL incl. /v1 (oMLX default port 8000)
  omlxApiKey: string; // empty = no Authorization header
  modelSummary: string;
  promptsDir: string; // dir holding base.md, triage.md, types/<type>.md
  // Obsidian vault archiving (optional — empty vaultRoot disables it)
  vaultRoot: string;
  vaultFolder: string;
  // recording
  recordBackend: "ffmpeg" | "ownscribe"; // see README → Recording backends
  recordDeviceIndex: string; // ffmpeg backend: avfoundation index of the Aggregate Device
  ownscribeBin: string; // ownscribe backend: path to the ownscribe-audio binary (synced system+mic)
  maxDurationSeconds: number;
  processTimeoutSeconds: number; // per-stage wall-clock backstop — kills a wedged ASR/ollama job
  panFilter: string; // ffmpeg backend: filter that downmixes the Aggregate Device to mono
  silenceDb: number; // warn after stop if a track's peak dBFS is at/below this

  // Meeting auto-detection (mur003): the daemon watches the mic going live (via the ownscribe
  // helper's `watch-mic`) and nudges a one-click recording when the app holding the mic is a known
  // meeting app. Opt-in — `mode: "off"` disables it entirely (the default).
  autorecord: {
    mode: "off" | "notify"; // off = no detection; notify = detect + one-click nudge
    apps: string[]; // allowlist of meeting-app bundle ids that qualify a mic-on edge as a meeting
    ignoreApps: string[]; // denylist of bundle ids that must never nudge (e.g. dictation tools)
    debounceSeconds: number; // confirm the mic is still live this long before nudging
    cooldownSeconds: number; // suppress nudges for this long after a recording stops
  };

  // PATH handed to spawned children so ffmpeg/python/ollama/terminal-notifier resolve.
  childPath: string;
}

const REPO_DIR = join(import.meta.dir, "..");

// The config keys, mapped between murmur.toml's grouped tables (tomlToRawEnv) and the resolved
// Config (configAsEnv). The matching env-var name is the override for each.
const KEYS = [
  "MEETINGS_BASE",
  "SUMMARY_PROVIDER",
  "MODEL_SUMMARY",
  "OMLX_BASE_URL",
  "OMLX_API_KEY",
  "MURMUR_PORT",
  "MURMUR_PYTHON",
  "ASR_MODEL",
  "ASR_LANG",
  "TRIM_SILENCE",
  "TRIM_THRESHOLD_DB",
  "DIARIZE",
  "DIARIZE_NUM_SPEAKERS",
  "HF_TOKEN",
  "OLLAMA_HOST",
  "PROMPTS_DIR",
  "RECORD_BACKEND",
  "RECORD_DEVICE_INDEX",
  "OWNSCRIBE_BIN",
  "MAX_DURATION_SECONDS",
  "PROCESS_TIMEOUT_SECONDS",
  "RECORD_PAN_FILTER",
  "RECORD_SILENCE_DB",
  "OBSIDIAN_VAULT",
  "VAULT_FOLDER",
  "AUTORECORD_MODE",
  "AUTORECORD_APPS",
  "AUTORECORD_IGNORE_APPS",
  "AUTORECORD_DEBOUNCE_SECONDS",
  "AUTORECORD_COOLDOWN_SECONDS",
] as const;

// Default meeting-app allowlist (bundle ids): Microsoft Teams, Slack, Zoom. Editable via
// [autorecord].apps. Matched against the bundle id of whatever process actually holds the mic.
const DEFAULT_AUTORECORD_APPS = ["com.microsoft.teams2", "com.tinyspeck.slackmacgap", "us.zoom.xos"];

// Downmix the 3-channel Aggregate Device to mono for transcription. Channel layout (from
// Audio MIDI Setup): c0+c1 = BlackHole 2ch (system audio — the other participants), c2 =
// MacBook Pro Microphone (your own voice). The stereo system pair (0.35+0.35 ≈ 0.7 for
// centred speech) is balanced against the single mono mic at 0.7, and alimiter prevents
// clipping when both are loud. Override with RECORD_PAN_FILTER if your Aggregate Device
// orders its sub-devices differently (the mic landing on a different channel is the usual
// reason a capture comes out mute or lopsided).
const DEFAULT_PAN_FILTER = "pan=mono|c0=0.35*c0+0.35*c1+0.7*c2,alimiter";

function pickBackend(v: string): Config["recordBackend"] {
  return v === "ownscribe" ? v : "ffmpeg";
}

function pickProvider(v: string): Config["summaryProvider"] {
  return v === "omlx" ? v : "ollama";
}

type RawEnv = Partial<Record<(typeof KEYS)[number], string>>;

// murmur.toml uses grouped, idiomatic tables; map them onto the flat KEYS used throughout
// loadConfig. Path-valued keys get a leading "~/" expanded (TOML does no shell expansion). An
// empty value means "unset" (→ default).
function tomlToRawEnv(toml: Record<string, any>): RawEnv {
  const asr = (toml.asr ?? {}) as Record<string, any>;
  const summary = (toml.summary ?? {}) as Record<string, any>;
  const vault = (toml.vault ?? {}) as Record<string, any>;
  const rec = (toml.recording ?? {}) as Record<string, any>;
  const auto = (toml.autorecord ?? {}) as Record<string, any>;
  const path = (v: unknown) => (typeof v === "string" ? expandHome(v) : v);
  const bool = (v: unknown) => (typeof v === "boolean" ? (v ? "1" : "0") : v);
  // A TOML array → the comma-joined string the flat env layer carries (bundle ids contain no commas).
  const list = (v: unknown) => (Array.isArray(v) ? v.join(",") : v);
  const mapping: Record<(typeof KEYS)[number], unknown> = {
    MEETINGS_BASE: path(toml.meetings_base),
    SUMMARY_PROVIDER: summary.provider,
    MODEL_SUMMARY: summary.model,
    OMLX_BASE_URL: summary.omlx_base_url,
    OMLX_API_KEY: summary.omlx_api_key,
    MURMUR_PORT: toml.port,
    MURMUR_PYTHON: path(asr.python),
    ASR_MODEL: asr.model,
    ASR_LANG: asr.language,
    TRIM_SILENCE: bool(asr.trim_silence),
    TRIM_THRESHOLD_DB: asr.trim_threshold_db,
    DIARIZE: bool(asr.diarize),
    DIARIZE_NUM_SPEAKERS: asr.num_speakers,
    HF_TOKEN: asr.hf_token,
    OLLAMA_HOST: summary.ollama_host,
    PROMPTS_DIR: path(summary.prompts_dir),
    RECORD_BACKEND: rec.backend,
    RECORD_DEVICE_INDEX: rec.device_index,
    OWNSCRIBE_BIN: path(rec.ownscribe_bin),
    MAX_DURATION_SECONDS: rec.max_duration_seconds,
    PROCESS_TIMEOUT_SECONDS: toml.process_timeout_seconds,
    RECORD_PAN_FILTER: rec.pan_filter,
    RECORD_SILENCE_DB: rec.silence_db,
    OBSIDIAN_VAULT: path(vault.root),
    VAULT_FOLDER: vault.folder,
    AUTORECORD_MODE: auto.mode,
    AUTORECORD_APPS: list(auto.apps),
    AUTORECORD_IGNORE_APPS: list(auto.ignore_apps),
    AUTORECORD_DEBOUNCE_SECONDS: auto.debounce_seconds,
    AUTORECORD_COOLDOWN_SECONDS: auto.cooldown_seconds,
  };
  const raw: RawEnv = {};
  for (const k of KEYS) {
    const v = mapping[k];
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s !== "") raw[k] = s;
  }
  return raw;
}

function buildChildPath(pythonBin: string): string {
  const home = process.env.HOME ?? "";
  const wanted = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? join(home, ".local/bin") : "",
    dirname(pythonBin),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter(Boolean);
  const existing = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...wanted, ...existing])].join(delimiter);
}

export function loadConfig(repoDir: string = REPO_DIR): Config {
  // Layered: env > murmur.toml > defaults. murmur.toml is the one config file; an environment
  // variable overrides it (e.g. the launchd plist, or `HF_TOKEN` if you'd rather not store it).
  const parsedToml = readMurmurToml(repoDir);
  const tomlRaw: RawEnv = parsedToml ? tomlToRawEnv(parsedToml) : {};
  const pick = (key: (typeof KEYS)[number], fallback: string): string =>
    process.env[key] ?? tomlRaw[key] ?? fallback;
  // Split a comma-delimited list (the flat-env encoding of a TOML array), trimming and dropping
  // empties — so "a, b," → ["a","b"]. Used for the [autorecord] app allow/ignore lists.
  const parseList = (raw: string): string[] => raw.split(",").map((s) => s.trim()).filter(Boolean);

  const home = process.env.HOME ?? "";
  const meetingsBase = pick("MEETINGS_BASE", join(home, "Recordings/Meetings"));
  const pythonBin = pick("MURMUR_PYTHON", join(home, ".local/share/murmur/asr-venv/bin/python"));
  // Numeric config with a guard: a non-numeric value falls back (with a warning) rather
  // than silently becoming NaN (which would, e.g., break the control-API port bind).
  const num = (key: (typeof KEYS)[number], fallback: number): number => {
    const raw = pick(key, String(fallback));
    if (!Number.isFinite(Number(raw))) log.warn("config", `${key}="${raw}" is not a number — using ${fallback}`);
    return parseNum(raw, fallback);
  };

  const cfg: Config = {
    repoDir,
    meetingsBase,
    paths: buildPaths(meetingsBase),
    port: num("MURMUR_PORT", 7461),
    pythonBin,
    asrModel: pick("ASR_MODEL", "mlx-community/whisper-large-v3-turbo"),
    language: pick("ASR_LANG", "auto"), // "auto" = let whisper detect; forcing a wrong language drops that speech
    trimSilence: truthy(pick("TRIM_SILENCE", "1")), // on by default — makes "auto" robust to a silent lead-in
    trimThresholdDb: num("TRIM_THRESHOLD_DB", -30),
    diarize: truthy(pick("DIARIZE", "0")),
    numSpeakers: num("DIARIZE_NUM_SPEAKERS", 0),
    hfToken: pick("HF_TOKEN", ""),
    summaryProvider: pickProvider(pick("SUMMARY_PROVIDER", "ollama")),
    ollamaHost: pick("OLLAMA_HOST", "http://localhost:11434"),
    omlxBaseUrl: pick("OMLX_BASE_URL", "http://localhost:8000/v1"),
    omlxApiKey: pick("OMLX_API_KEY", ""),
    modelSummary: pick("MODEL_SUMMARY", "gemma4:26b-mlx"),
    promptsDir: pick("PROMPTS_DIR", join(repoDir, "prompts")),
    vaultRoot: pick("OBSIDIAN_VAULT", ""),
    vaultFolder: pick("VAULT_FOLDER", "Murmur"),
    recordBackend: pickBackend(pick("RECORD_BACKEND", "ffmpeg")),
    recordDeviceIndex: pick("RECORD_DEVICE_INDEX", "0"),
    ownscribeBin: pick("OWNSCRIBE_BIN", join(home, ".local/bin/ownscribe-audio")),
    maxDurationSeconds: num("MAX_DURATION_SECONDS", 7200),
    processTimeoutSeconds: num("PROCESS_TIMEOUT_SECONDS", 7200),
    panFilter: pick("RECORD_PAN_FILTER", DEFAULT_PAN_FILTER),
    silenceDb: num("RECORD_SILENCE_DB", -80),
    autorecord: {
      mode: pick("AUTORECORD_MODE", "off") === "notify" ? "notify" : "off",
      apps: parseList(pick("AUTORECORD_APPS", DEFAULT_AUTORECORD_APPS.join(","))),
      ignoreApps: parseList(pick("AUTORECORD_IGNORE_APPS", "")),
      debounceSeconds: num("AUTORECORD_DEBOUNCE_SECONDS", 4),
      cooldownSeconds: num("AUTORECORD_COOLDOWN_SECONDS", 30),
    },
    childPath: buildChildPath(pythonBin),
  };

  if (cfg.diarize && !cfg.hfToken) {
    log.warn("config", "DIARIZE=1 but HF_TOKEN is empty — diarization disabled (plain transcript)");
  }
  return Object.freeze(cfg);
}

// The resolved config as shell `export KEY='value'` lines, for `murmur print-env` (consumed by
// launchd/run-daemon.sh to locate the log dir, whichever config file is in use). The inverse of
// the KEYS mapping; empty values are omitted so re-importing them can't clobber a default.
export function configAsEnv(cfg: Config): Record<string, string> {
  const all: Record<(typeof KEYS)[number], string> = {
    MEETINGS_BASE: cfg.meetingsBase,
    SUMMARY_PROVIDER: cfg.summaryProvider,
    MODEL_SUMMARY: cfg.modelSummary,
    OMLX_BASE_URL: cfg.omlxBaseUrl,
    OMLX_API_KEY: cfg.omlxApiKey,
    MURMUR_PORT: String(cfg.port),
    MURMUR_PYTHON: cfg.pythonBin,
    ASR_MODEL: cfg.asrModel,
    ASR_LANG: cfg.language,
    TRIM_SILENCE: cfg.trimSilence ? "1" : "0",
    TRIM_THRESHOLD_DB: String(cfg.trimThresholdDb),
    DIARIZE: cfg.diarize ? "1" : "0",
    DIARIZE_NUM_SPEAKERS: String(cfg.numSpeakers),
    HF_TOKEN: cfg.hfToken,
    OLLAMA_HOST: cfg.ollamaHost,
    PROMPTS_DIR: cfg.promptsDir,
    RECORD_BACKEND: cfg.recordBackend,
    RECORD_DEVICE_INDEX: cfg.recordDeviceIndex,
    OWNSCRIBE_BIN: cfg.ownscribeBin,
    MAX_DURATION_SECONDS: String(cfg.maxDurationSeconds),
    PROCESS_TIMEOUT_SECONDS: String(cfg.processTimeoutSeconds),
    RECORD_PAN_FILTER: cfg.panFilter,
    RECORD_SILENCE_DB: String(cfg.silenceDb),
    OBSIDIAN_VAULT: cfg.vaultRoot,
    VAULT_FOLDER: cfg.vaultFolder,
    AUTORECORD_MODE: cfg.autorecord.mode,
    AUTORECORD_APPS: cfg.autorecord.apps.join(","),
    AUTORECORD_IGNORE_APPS: cfg.autorecord.ignoreApps.join(","),
    AUTORECORD_DEBOUNCE_SECONDS: String(cfg.autorecord.debounceSeconds),
    AUTORECORD_COOLDOWN_SECONDS: String(cfg.autorecord.cooldownSeconds),
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) if (v !== "") out[k] = v;
  return out;
}
