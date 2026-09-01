// The LLM transport for the summary stage, dispatched on [summary].provider. One llmGenerate()
// call abstracts the two local servers so summary.ts stays provider-neutral:
//   ollama — native /api/generate (think:false; format:"json" when a schema is requested)
//   omlx   — OpenAI-compatible /chat/completions; the schema is enforced server-side via oMLX's
//            XGrammar structured_outputs, and chat_template_kwargs.enable_thinking=false keeps
//            Qwen-style reasoning tokens out of the output regardless of server defaults.
// Both run greedy (temperature 0) — follows the prompt's rules far more reliably and avoids the
// random "empty/test" misclassification of real transcripts.
import type { Config } from "../config.ts";
import { sleep } from "../util.ts";
import { log } from "../log.ts";
import { AbortError, EngineError } from "./errors.ts";

export interface LlmOpts {
  prompt: string;
  // When set, constrain the model to JSON output. Ollama uses plain format:"json" (parseTriage
  // tolerates near-misses); oMLX enforces the schema itself.
  schema?: Record<string, unknown>;
}

/** Pure request-body builders (exported for tests — no network in the test suite). */
export function ollamaBody(model: string, opts: LlmOpts): Record<string, unknown> {
  return {
    model,
    prompt: opts.prompt,
    stream: false,
    think: false,
    ...(opts.schema ? { format: "json" } : {}),
    options: { temperature: 0 },
  };
}

export function omlxBody(model: string, opts: LlmOpts): Record<string, unknown> {
  return {
    model,
    temperature: 0,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
    ...(opts.schema ? { structured_outputs: { json: opts.schema } } : {}),
    messages: [{ role: "user", content: opts.prompt }],
  };
}

function omlxHeaders(cfg: Config): Record<string, string> {
  return cfg.omlxApiKey ? { authorization: `Bearer ${cfg.omlxApiKey}` } : {};
}

/** One completion. Throws EngineError on HTTP failure (detail = response-body tail, so the
 *  caller can persist it next to the recording); native fetch/abort errors propagate for the
 *  caller's abort/timeout mapping. */
export async function llmGenerate(cfg: Config, opts: LlmOpts, signal: AbortSignal): Promise<string> {
  const omlx = cfg.summaryProvider === "omlx";
  const res = await fetch(omlx ? `${cfg.omlxBaseUrl}/chat/completions` : `${cfg.ollamaHost}/api/generate`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...(omlx ? omlxHeaders(cfg) : {}) },
    body: JSON.stringify(omlx ? omlxBody(cfg.modelSummary, opts) : ollamaBody(cfg.modelSummary, opts)),
  });
  if (!res.ok) {
    throw new EngineError(`${cfg.summaryProvider} HTTP ${res.status}`, res.status, (await res.text()).slice(-4000));
  }
  if (omlx) {
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new EngineError("omlx returned no message content", 1);
    return content;
  }
  const { response } = (await res.json()) as { response: string };
  return response;
}

/** Is the configured server up? (oMLX authenticates even the model list.) */
export function llmPing(cfg: Config): Promise<boolean> {
  const omlx = cfg.summaryProvider === "omlx";
  return fetch(omlx ? `${cfg.omlxBaseUrl}/models` : `${cfg.ollamaHost}/api/tags`, {
    headers: omlx ? omlxHeaders(cfg) : undefined,
    signal: AbortSignal.timeout(2000),
  })
    .then((r) => r.ok)
    .catch(() => false);
}

/** Ensure the server is reachable before the first real call. Ollama is a Mac app we can start
 *  ourselves (launch + poll); the oMLX server's lifecycle isn't ours to manage, so an unreachable
 *  oMLX fails fast with a pointer instead of polling for a launch that will never happen. */
export async function llmPreflight(cfg: Config, signal: AbortSignal, timeout: AbortSignal): Promise<void> {
  if (await llmPing(cfg)) return;
  if (cfg.summaryProvider === "omlx") {
    throw new EngineError(`omlx not reachable at ${cfg.omlxBaseUrl} — start the oMLX server`, 1);
  }
  log.info("summary", "ollama not reachable — launching Ollama.app");
  try {
    await Bun.spawn(["open", "-a", "Ollama"], { env: { ...process.env, PATH: cfg.childPath } }).exited;
  } catch {
    /* `open` may be unavailable in some contexts; fall through to polling */
  }
  for (let i = 0; i < 60; i++) {
    if (signal.aborted) throw new AbortError("summary preflight aborted");
    if (timeout.aborted) throw new EngineError(`summarize timed out after ${cfg.processTimeoutSeconds}s`, 124);
    if (await llmPing(cfg)) return;
    await sleep(1000);
  }
  throw new EngineError("ollama not reachable after 60s", 1);
}
