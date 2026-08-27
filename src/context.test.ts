// Tests for per-recording context: resolveContext (literal / @file / absent) and saveContext
// (write / no-op / replace), plus a persist→reuse sanity check proving a stored context.md is what
// a later summary would inject — without re-supplying --context and without hitting Ollama.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext, saveContext } from "./context.ts";
import { ARTIFACTS } from "./paths.ts";
import { assembleSummaryPrompt, CONTEXT_OPEN } from "./engines/summary.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "murmur-ctx-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("resolveContext", () => {
  test("an absent flag resolves to undefined (distinct from empty)", async () => {
    expect(await resolveContext(undefined)).toBeUndefined();
  });

  test("a literal value passes through unchanged", async () => {
    expect(await resolveContext("SPEAKER_00 = Petr; téma: AI")).toBe("SPEAKER_00 = Petr; téma: AI");
  });

  test("@<path> reads the file contents", async () => {
    const dir = tmp();
    const file = join(dir, "notes.md");
    writeFileSync(file, "from a file\n");
    expect(await resolveContext(`@${file}`)).toBe("from a file\n");
  });
});

describe("saveContext", () => {
  test("writes <folder>/context.md (trimmed + newline) and returns its path", async () => {
    const dir = tmp();
    const path = await saveContext(dir, "  hello context  ");
    expect(path).toBe(join(dir, ARTIFACTS.context));
    expect(await Bun.file(path!).text()).toBe("hello context\n");
  });

  test("empty/whitespace input is a no-op: no file written, existing left untouched", async () => {
    const dir = tmp();
    // Pre-existing context.md must survive an empty re-supply.
    await saveContext(dir, "original");
    expect(await saveContext(dir, "   \n  ")).toBeNull();
    expect(await Bun.file(join(dir, ARTIFACTS.context)).text()).toBe("original\n");

    // And into a fresh folder, empty input writes nothing at all.
    const dir2 = tmp();
    expect(await saveContext(dir2, "")).toBeNull();
    expect(existsSync(join(dir2, ARTIFACTS.context))).toBe(false);
  });

  test("a new non-empty value replaces the stored context", async () => {
    const dir = tmp();
    await saveContext(dir, "first");
    await saveContext(dir, "second");
    expect(await Bun.file(join(dir, ARTIFACTS.context)).text()).toBe("second\n");
  });
});

describe("persist → reuse (no re-supplied flag)", () => {
  test("a stored context.md is what a later summary injects", async () => {
    const folder = tmp();
    // Simulate `summarize <base> --context "…"` persisting context.
    await saveContext(folder, "SPEAKER_00 = Petr");
    // A later run (e.g. `reprocess <base>` with no --context) reads it the way summarize() does…
    const stored = (await Bun.file(join(folder, ARTIFACTS.context)).text().catch(() => "")).trim();
    const prompt = assembleSummaryPrompt({
      baseRules: "B",
      typePrompt: "T",
      context: stored,
      transcript: "words",
    });
    // …and the stored context appears in the prompt, no flag re-specified.
    expect(prompt).toContain(CONTEXT_OPEN);
    expect(prompt).toContain("SPEAKER_00 = Petr");
  });
});
