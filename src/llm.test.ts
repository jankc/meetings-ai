// Tests for the pure LLM request-body builders — the exact wire shapes both local servers
// expect. No network: llmGenerate itself is a thin fetch around these. The omlx shape mirrors
// oMLX's OpenAI-compatible endpoint with its extensions (XGrammar structured_outputs; Qwen
// thinking disabled via chat_template_kwargs) — a drift here silently degrades summaries.
import { test, expect, describe } from "bun:test";
import { ollamaBody, omlxBody } from "./engines/llm.ts";

const SCHEMA = { type: "object", properties: { type: { type: "string" } } };

describe("ollamaBody", () => {
  test("plain generation: no format, greedy, thinking off", () => {
    expect(ollamaBody("gemma3:12b", { prompt: "P" })).toEqual({
      model: "gemma3:12b",
      prompt: "P",
      stream: false,
      think: false,
      options: { temperature: 0 },
    });
  });

  test("a schema requests ollama's generic JSON mode", () => {
    expect(ollamaBody("m", { prompt: "P", schema: SCHEMA })).toMatchObject({ format: "json" });
  });
});

describe("omlxBody", () => {
  test("chat-completions shape: prompt as user message, thinking disabled, greedy", () => {
    expect(omlxBody("unsloth/Qwen3.6-35B-A3B-UD-MLX-4bit", { prompt: "P" })).toEqual({
      model: "unsloth/Qwen3.6-35B-A3B-UD-MLX-4bit",
      temperature: 0,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "user", content: "P" }],
    });
  });

  test("a schema is enforced via XGrammar structured_outputs (and omitted otherwise)", () => {
    expect(omlxBody("m", { prompt: "P", schema: SCHEMA })).toMatchObject({
      structured_outputs: { json: SCHEMA },
    });
    expect(omlxBody("m", { prompt: "P" })).not.toHaveProperty("structured_outputs");
  });
});
