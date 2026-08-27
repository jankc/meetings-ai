// Unit tests for the deterministic, dependency-free logic — the helpers most likely to
// regress silently (timestamp parsing drives filenames; wordCount gates the empty-marker
// path that once misclassified real meetings; title parsing is new). No GPU, no network.
import { test, expect, describe } from "bun:test";
import { parseStamp, stampFromDate, monthOf } from "./stamp.ts";
import { truthy, parseNum } from "./util.ts";
import { titleFromSummary, sanitizeTitle } from "./archive.ts";
import { isRecordingFile, stripAudioExt } from "./paths.ts";
import { wordCount, parseTriage } from "./engines/summary.ts";
import { classifyTranscript } from "./purge.ts";

describe("stamp", () => {
  test("parseStamp extracts the embedded timestamp", () => {
    expect(parseStamp("meeting-2026-06-18_16-21-05")).toEqual({
      date: "2026-06-18",
      time: "16-21",
      clock: "16-21-05",
      display: "16:21",
      month: "2026-06",
    });
  });

  test("parseStamp returns null when there's no timestamp", () => {
    expect(parseStamp("notes-final")).toBeNull();
  });

  test("clock keeps seconds so same-minute recordings get distinct vault identities", () => {
    expect(parseStamp("meeting-2026-06-18_16-21-05")?.clock).toBe("16-21-05");
    expect(parseStamp("meeting-2026-06-18_16-21-42")?.clock).toBe("16-21-42");
  });

  test("stampFromDate formats a Date in local time", () => {
    const s = stampFromDate(new Date(2026, 5, 18, 16, 21, 5)); // month is 0-based → June
    expect(s).toEqual({ date: "2026-06-18", time: "16-21", clock: "16-21-05", display: "16:21", month: "2026-06" });
  });

  test("monthOf prefers the name, falls back to the date", () => {
    expect(monthOf("meeting-2026-06-18_16-21-05", new Date(2000, 0, 1))).toBe("2026-06");
    expect(monthOf("garbage", new Date(2026, 0, 5))).toBe("2026-01");
  });
});

describe("audio extension helpers", () => {
  test("isRecordingFile accepts supported audio formats, rejects others", () => {
    expect(isRecordingFile("meeting-2026-06-18_16-21-05.flac")).toBe(true); // murmur's own capture
    expect(isRecordingFile("meeting-2026-06-18_16-21-05.wav")).toBe(true);
    expect(isRecordingFile("meeting-2026-06-18_16-21-05.m4a")).toBe(true); // imported, kept as-is
    expect(isRecordingFile("meeting-2026-06-18_16-21-05.mp3")).toBe(true);
    // Case-SENSITIVE: an uppercase ext is rejected, so we never pick up a file locate() (which
    // builds lowercase paths) couldn't then find on a case-sensitive volume.
    expect(isRecordingFile("MEETING.FLAC")).toBe(false);
    expect(isRecordingFile("meeting.txt")).toBe(false);
    expect(isRecordingFile("meeting.md")).toBe(false);
    expect(isRecordingFile("meeting-2026-06-18_16-21-05.partial")).toBe(false);
    expect(isRecordingFile("meeting-2026-06-18_16-21-05")).toBe(false); // bare basename
  });

  test("stripAudioExt removes a known audio extension and nothing else", () => {
    expect(stripAudioExt("meeting-2026-06-18_16-21-05.flac")).toBe("meeting-2026-06-18_16-21-05");
    expect(stripAudioExt("meeting-2026-06-18_16-21-05.m4a")).toBe("meeting-2026-06-18_16-21-05");
    expect(stripAudioExt("meeting-2026-06-18_16-21-05")).toBe("meeting-2026-06-18_16-21-05"); // no-op
    expect(stripAudioExt("notes.txt")).toBe("notes.txt"); // not a recording extension
    expect(stripAudioExt("a.b.flac")).toBe("a.b"); // only the trailing ext is stripped
  });
});

describe("util", () => {
  test("truthy", () => {
    for (const v of ["1", "true", "TRUE", "True"]) expect(truthy(v)).toBe(true);
    for (const v of ["0", "", "false", "yes", "no"]) expect(truthy(v)).toBe(false);
  });

  test("parseNum falls back on empty / non-numeric, parses valid", () => {
    expect(parseNum("7461", 1)).toBe(7461);
    expect(parseNum("3.5", 1)).toBe(3.5);
    expect(parseNum("", 7200)).toBe(7200); // Number("") is 0 — must NOT leak through
    expect(parseNum("   ", 7200)).toBe(7200);
    expect(parseNum("abc", 5)).toBe(5);
    expect(parseNum("12abc", 5)).toBe(5);
  });
});

describe("titleFromSummary", () => {
  test("extracts a leading title H1", () => {
    expect(titleFromSummary("# Volba databáze\n\n# Shrnutí\nfoo")).toBe("Volba databáze");
  });

  test("skips leading blank lines", () => {
    expect(titleFromSummary("\n\n#   Plán nahrávání\n\ntext")).toBe("Plán nahrávání");
  });

  test("returns '' for an older title-less summary (first heading is a section)", () => {
    expect(titleFromSummary("# Shrnutí\nNěco se stalo.")).toBe("");
  });

  test("returns '' when the first non-empty line isn't a heading", () => {
    expect(titleFromSummary("Plain text\n# Later heading")).toBe("");
    expect(titleFromSummary("")).toBe("");
  });
});

describe("sanitizeTitle", () => {
  test("strips filesystem/Obsidian-unsafe characters and collapses whitespace", () => {
    expect(sanitizeTitle("Foo: bar / baz")).toBe("Foo bar baz");
    expect(sanitizeTitle("Title #1 [draft]")).toBe("Title 1 draft");
    expect(sanitizeTitle("  lots   of   space  ")).toBe("lots of space");
  });

  test("caps length at 80 characters", () => {
    expect(sanitizeTitle("x".repeat(200)).length).toBe(80);
  });
});

describe("wordCount", () => {
  test("ignores diarization + timestamp markup", () => {
    expect(wordCount("[SPEAKER_00] [00:00:01.2] ahoj jak se máš")).toBe(4);
  });

  test("empty / markup-only transcripts count as zero", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("[SPEAKER_01]   \n  ")).toBe(0);
  });

  test("counts plain spoken words", () => {
    expect(wordCount("jedna dvě tři čtyři pět")).toBe(5);
  });
});

describe("parseTriage", () => {
  test("accepts a valid type + language", () => {
    expect(parseTriage('{"type":"lecture","language":"en"}')).toEqual({ type: "lecture", language: "en" });
    expect(parseTriage('{"type":"dictation","language":"cs"}')).toEqual({ type: "dictation", language: "cs" });
  });

  test("extracts JSON from a ```json code fence (gemma *-mlx wraps it)", () => {
    expect(parseTriage('```json\n{"type": "lecture", "language": "en"}\n```')).toEqual({ type: "lecture", language: "en" });
    expect(parseTriage('Here you go:\n{"type":"summary","language":"cs"} hope that helps')).toEqual({ type: "summary", language: "cs" });
  });

  test("an unknown type falls back to summary (the safe default)", () => {
    expect(parseTriage('{"type":"podcast","language":"cs"}')).toEqual({ type: "summary", language: "cs" });
  });

  test("any language other than en is treated as cs", () => {
    expect(parseTriage('{"type":"list","language":"de"}')).toEqual({ type: "list", language: "cs" });
    expect(parseTriage('{"type":"journal"}')).toEqual({ type: "journal", language: "cs" });
  });

  test("garbage or non-JSON falls back to {summary, cs}", () => {
    expect(parseTriage("not json at all")).toEqual({ type: "summary", language: "cs" });
    expect(parseTriage("")).toEqual({ type: "summary", language: "cs" });
  });
});

describe("classifyTranscript (purge)", () => {
  test("below the 25-word gate is empty", () => {
    expect(classifyTranscript("raz dva tři haló").reason).toBe("empty");
    expect(classifyTranscript("").reason).toBe("empty");
  });

  test("a summary marked with EMPTY_MARKER is empty regardless of transcript length", () => {
    const long = Array(60).fill("slovo").join(" "); // 60 words, would otherwise be 'noise'
    expect(classifyTranscript(long, "Transcript je prázdný nebo testovací — žádné shrnutí.").reason).toBe("empty");
  });

  test("long repetitive ASR garbage is noise (low unique-word ratio)", () => {
    expect(classifyTranscript(Array(100).fill("cast").join(" ")).reason).toBe("noise");
    expect(classifyTranscript("former ".repeat(80)).reason).toBe("noise");
  });

  test("a normal long transcript is kept", () => {
    const real =
      "Musíme se rozhodnout jestli použijeme Postgres nebo SQLite. " +
      "Honza navrhuje Postgres kvůli replikaci a udělá migraci do pátku. " +
      "Ještě nevíme jak vyřešíme zálohy a kdo nasadí monitoring na produkci příští týden.";
    expect(classifyTranscript(real.repeat(2)).reason).toBeNull();
  });

  test("a genuine varied note above the gate is kept — not flagged as noise", () => {
    const note =
      "Dneska jsem byl na obědě s Petrem a probírali jsme nový projekt pro klienta. " +
      "Říkal že termín je napjatý ale zvládneme to když přidáme jednoho člověka. " +
      "Musím zítra zavolat účetní kvůli fakturám a taky připravit podklady pro pondělní schůzku s vedením.";
    expect(classifyTranscript(note).reason).toBeNull();
  });
});
