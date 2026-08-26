// Tests for the pure summary-prompt assembly: the optional user-context section is injected only
// when context is non-empty, sits between the type prompt and the transcript, and never leaves
// empty delimiters when absent. No Ollama/network — assembleSummaryPrompt is pure.
import { test, expect, describe } from "bun:test";
import { assembleSummaryPrompt, CONTEXT_OPEN, CONTEXT_CLOSE } from "./engines/ollama.ts";

const PARTS = {
  baseRules: "BASE RULES",
  typePrompt: "TYPE PROMPT",
  transcript: "the spoken words",
};

describe("assembleSummaryPrompt", () => {
  test("injects a delimited context section before the transcript when context is present", () => {
    const prompt = assembleSummaryPrompt({ ...PARTS, context: "SPEAKER_00 = Petr" });
    expect(prompt).toContain(CONTEXT_OPEN);
    expect(prompt).toContain("SPEAKER_00 = Petr");
    expect(prompt).toContain(CONTEXT_CLOSE);
    // The context block precedes the transcript block.
    expect(prompt.indexOf(CONTEXT_OPEN)).toBeLessThan(prompt.indexOf("--- TRANSCRIPT ---"));
    expect(prompt.indexOf(CONTEXT_CLOSE)).toBeLessThan(prompt.indexOf("--- TRANSCRIPT ---"));
    // And after the type prompt (between type prompt and transcript).
    expect(prompt.indexOf("TYPE PROMPT")).toBeLessThan(prompt.indexOf(CONTEXT_OPEN));
  });

  test("omits the context section entirely when context is absent (no empty delimiters)", () => {
    const prompt = assembleSummaryPrompt({ ...PARTS, context: "" });
    expect(prompt).not.toContain(CONTEXT_OPEN);
    expect(prompt).not.toContain(CONTEXT_CLOSE);
    expect(prompt).toContain("--- TRANSCRIPT ---");
    expect(prompt).toContain("the spoken words");
  });

  test("whitespace-only context is treated as absent", () => {
    const prompt = assembleSummaryPrompt({ ...PARTS, context: "   \n\t  " });
    expect(prompt).not.toContain(CONTEXT_OPEN);
  });
});
