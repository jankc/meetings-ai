// Tests for the pure terminal-notifier argv assembly: the click-action (-execute) is appended only
// when an execute command is supplied, leaving a plain notification's argv unchanged.
import { test, expect, describe } from "bun:test";
import { notifyArgs, openInFinderCmd, shq } from "./notify.ts";

describe("notifyArgs", () => {
  test("a plain notification carries no -execute", () => {
    const args = notifyArgs("hello");
    expect(args).toContain("-message");
    expect(args).toContain("hello");
    expect(args).not.toContain("-execute");
  });

  test("an execute option appends `-execute <command>`", () => {
    const cmd = "/path/to/bun /repo/src/cli.ts record";
    const args = notifyArgs("Click to record — ignore to skip", { execute: cmd });
    const i = args.indexOf("-execute");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(cmd);
  });

  test("a subtitle option appends `-subtitle <text>`", () => {
    const args = notifyArgs("Click to record — ignore to skip", { subtitle: "Meeting detected" });
    const i = args.indexOf("-subtitle");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("Meeting detected");
  });
});

describe("openInFinderCmd", () => {
  test("opens the given directory in Finder", () => {
    expect(openInFinderCmd("/Users/jank/Murmur/recordings/processed/2026-07/meeting-2026-07-03_09-30-27")).toBe(
      "open '/Users/jank/Murmur/recordings/processed/2026-07/meeting-2026-07-03_09-30-27'",
    );
  });

  test("single-quotes a path with spaces so `open` gets one argument", () => {
    expect(openInFinderCmd("/Users/jank/My Recordings/processed/2026-07/mtg")).toBe(
      "open '/Users/jank/My Recordings/processed/2026-07/mtg'",
    );
  });

  test("shq escapes an embedded single quote", () => {
    expect(shq("/Users/jank/o'brien")).toBe("'/Users/jank/o'\\''brien'");
  });
});
