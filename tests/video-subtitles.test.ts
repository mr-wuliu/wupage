import { describe, expect, it, vi } from "vitest";
import { parseSubtitles, SubtitleTranslator, type SubtitleCue } from "../src/video/subtitles";

const cues: SubtitleCue[] = [
  { start: 0, end: 3, text: "Hello" }, { start: 20, end: 24, text: "Later" }
];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("subtitle files", () => {
  it("parses BOM/CRLF SRT, formatting, entities and overlapping cues", () => {
    expect(parseSubtitles('\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\n<i>Hello &amp; bye</i>\r\nSecond line\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,000\r\n&#x4f60;&#22909;'))
      .toEqual([{ start: 1.25, end: 3.5, text: "Hello & bye\nSecond line" }, { start: 2, end: 4, text: "你好" }]);
  });
  it("reads VTT identifiers and cue settings, ignoring metadata blocks", () => {
    expect(parseSubtitles('WEBVTT\nKind: captions\n\nNOTE a note\nignored\n\nSTYLE\n::cue { color: red }\n\nsecond\n00:02.000 --> 00:04.000 align:start\n<v John><c.highlight>Later</c></v>\n\nfirst\n00:00.000 --> 00:01.000\nHi'))
      .toEqual([{ start: 0, end: 1, text: "Hi" }, { start: 2, end: 4, text: "Later" }]);
  });
  it.each(["", "hello", "WEBVTT\n\nNOTE no cues", "1\n00:60:00,000 --> 01:00:01,000\nBad", "1\n00:00:02,000 --> 00:00:01,000\nBad"])("rejects invalid or empty files: %s", source => {
    expect(() => parseSubtitles(source)).toThrow();
  });
  it("rejects oversized cues instead of sending unbounded provider requests", () => {
    expect(() => parseSubtitles(`00:00.000 --> 00:01.000\n${"a".repeat(4001)}`)).toThrow("过长");
  });
});

describe("subtitle translation scheduling", () => {
  it("translates a complete sentence once and shows the same bilingual unit across its original cue times", async () => {
    const fragments = [
      { start: 0, end: 1, text: "This tool can" }, { start: 1, end: 2, text: "save you a lot" },
      { start: 2, end: 3, text: "of time." }, { start: 4, end: 5, text: "Try it!" }
    ];
    const translate = vi.fn(async (texts: string[]) => texts.map(text => text.startsWith("This") ? "这个工具能为你节省很多时间。" : "试试看！"));
    const session = new SubtitleTranslator(() => fragments, translate, vi.fn());
    session.update(0); await flush();
    expect(translate.mock.calls.map(call => call[0])).toEqual([["This tool can save you a lot of time.", "Try it!"]]);
    const sentence = { source: "This tool can save you a lot of time.", translation: "这个工具能为你节省很多时间。" };
    expect(session.current()).toEqual(sentence);
    session.update(2.5); expect(session.current()).toEqual(sentence);
    session.update(3); expect(session.current()).toEqual({ source: "", translation: "" });
    session.update(1); await flush(); expect(session.current()).toEqual(sentence);
    expect(translate).toHaveBeenCalledTimes(1); session.dispose();
  });
  it("rebuilds sentence groups when a native track appends more cues during a request", async () => {
    const fragments = [{ start: 0, end: 1, text: "This tool can" }];
    let finish!: (texts: string[]) => void;
    const translate = vi.fn().mockImplementationOnce(() => new Promise<string[]>(resolve => { finish = resolve; }))
      .mockResolvedValue(["这个工具能节省时间。"]);
    const session = new SubtitleTranslator(() => fragments, translate, vi.fn());
    session.update(0);
    fragments.push({ start: 1, end: 2, text: "save time." });
    session.update(.5); finish(["这个工具可以"]); await flush();
    expect(translate.mock.calls[1][0]).toEqual(["This tool can save time."]);
    expect(session.current()).toEqual({ source: "This tool can save time.", translation: "这个工具能节省时间。" });
    session.dispose();
  });
  it("prefetches only the nearby window, uses end-exclusive cue times, and reuses translations", async () => {
    const translate = vi.fn(async (texts: string[]) => texts.map(text => `译:${text}`));
    const session = new SubtitleTranslator(() => cues, translate, vi.fn());
    session.update(0); await flush();
    expect(translate.mock.calls.map(call => call[0])).toEqual([["Hello"]]);
    expect(session.current()).toEqual({ source: "Hello", translation: "译:Hello" });
    session.update(3); expect(session.current().source).toBe("");
    session.update(20); await flush();
    expect(session.current().translation).toBe("译:Later");
    session.update(0); await flush(); expect(translate).toHaveBeenCalledTimes(2);
  });
  it("does not display a late response for the cue before a seek", async () => {
    let finish!: (texts: string[]) => void;
    const translate = vi.fn().mockImplementationOnce(() => new Promise<string[]>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(["稍后"]);
    const session = new SubtitleTranslator(() => cues, translate, vi.fn());
    session.update(0); session.update(20);
    expect(translate).toHaveBeenCalledTimes(1);
    finish(["你好"]); await flush();
    expect(translate.mock.calls[1][0]).toEqual(["Later"]);
    expect(session.current()).toEqual({ source: "Later", translation: "稍后" });
  });
  it("ignores late results and stops queueing after disposal", async () => {
    let finish!: (texts: string[]) => void;
    const translate = vi.fn(() => new Promise<string[]>(resolve => { finish = resolve; }));
    const changed = vi.fn();
    const session = new SubtitleTranslator(() => cues, translate, changed);
    session.update(0); session.dispose(); changed.mockClear(); finish(["你好"]); await flush();
    expect(changed).not.toHaveBeenCalled(); expect(translate).toHaveBeenCalledTimes(1);
    expect(session.current().translation).toBe("");
  });
  it("does not retry failures on every playback tick and supports explicit retry", async () => {
    const translate = vi.fn().mockRejectedValueOnce(new Error("Quota exceeded")).mockResolvedValueOnce(["你好"]);
    const session = new SubtitleTranslator(() => cues, translate, vi.fn());
    session.update(0); await flush();
    for (let i = 0; i < 20; i++) session.update(1);
    await flush(); expect(translate).toHaveBeenCalledTimes(1); expect(session.error).toBe("Quota exceeded");
    session.retry(); await flush(); expect(session.error).toBe(""); expect(session.current().translation).toBe("你好");
  });
  it("validates response completeness and deduplicates overlapping identical text", async () => {
    const translate = vi.fn(async () => []);
    const session = new SubtitleTranslator(() => [...cues, cues[0]], translate, vi.fn());
    session.update(0); await flush(); expect(translate.mock.calls).toHaveLength(1);
    expect(session.current().source).toBe("Hello"); expect(session.error).toContain("不完整");
  });
  it("bounds dense lookahead windows so the bounded cache cannot cause an endless refill", async () => {
    const dense = Array.from({ length: 300 }, (_, i) => ({ start: 1, end: 3, text: `Line ${i}` }));
    const translate = vi.fn(async (texts: string[]) => texts.map(text => `译:${text}`));
    const session = new SubtitleTranslator(() => dense, translate, vi.fn());
    session.update(0); await flush(); await flush(); await flush();
    expect(translate).toHaveBeenCalledTimes(16);
    expect(translate.mock.calls.every(([texts]) => texts.length <= 8)).toBe(true);
    session.update(0); await flush(); expect(translate).toHaveBeenCalledTimes(16);
  });
});
