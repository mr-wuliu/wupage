import { describe, expect, it, vi } from "vitest";
import { parseSubtitles, SubtitleTranslator } from "../src/video/subtitles";
import { validSubtitleCues, youtubeCues } from "../src/video/site-cues";
import { subtitleSentences } from "../src/video/subtitle-sentences";
import { revealedSubtitle } from "../src/video/subtitle-timing";

const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };

describe("progressive original subtitles", () => {
  it("keeps uneven YouTube word times through the page bridge and sentence grouping", async () => {
    const cues = validSubtitleCues(youtubeCues({ events: [
      { tStartMs: 1000, dDurationMs: 3000, segs: [
        { utf8: "This ", tOffsetMs: 0 }, { utf8: "is ", tOffsetMs: 700 }, { utf8: "stable.", tOffsetMs: 1800 }
      ] }
    ] }));
    expect(cues[0].words).toEqual([{ start: 1, endOffset: 4 }, { start: 1.7, endOffset: 7 }, { start: 2.8, endOffset: 15 }]);
    const translate = vi.fn(async () => ["这是稳定的。"]);
    const session = new SubtitleTranslator(() => cues, translate, vi.fn());
    session.update(1); await flush();
    expect(session.current()).toEqual({ source: "This is stable.", translation: "这是稳定的。" });
    for (const [time, source] of [[1, "This"], [1.69, "This"], [1.7, "This is"], [2.79, "This is"], [2.8, "This is stable."], [1.1, "This"]] as const) {
      session.update(time);
      expect(session.current(true)).toEqual({ source, translation: "这是稳定的。" });
    }
    session.update(4); expect(session.current(true)).toEqual({ source: "", translation: "" });
    expect(translate).toHaveBeenCalledExactlyOnceWith(["This is stable."], expect.any(AbortSignal));
    session.dispose();
  });

  it("does not reveal appended ASR fragments before their own start times", () => {
    const cues = youtubeCues({ events: [
      { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: "Hello" }] },
      { tStartMs: 1300, dDurationMs: 2000, aAppend: 1, segs: [{ utf8: "brave ", tOffsetMs: 0 }, { utf8: "world", tOffsetMs: 900 }] }
    ] });
    const [sentence] = subtitleSentences(cues, true);
    expect(revealedSubtitle(sentence, 1)).toBe("Hello");
    expect(revealedSubtitle(sentence, 1.3)).toBe("Hello brave");
    expect(revealedSubtitle(sentence, 2.2)).toBe("Hello brave world");
  });

  it("keeps real anchors when spaces and untimed pieces occur between timed segments", () => {
    const [cue] = youtubeCues({ events: [{ tStartMs: 0, dDurationMs: 4000, segs: [
      { utf8: "I am", tOffsetMs: 0 }, { utf8: " " }, { utf8: "here.", tOffsetMs: 1000 }
    ] }] });
    expect(cue.words).toEqual([{ start: 0, endOffset: 1 }, { start: .5, endOffset: 4 }, { start: 1, endOffset: 10 }]);
    expect(revealedSubtitle(cue, .6)).toBe("I am");
    expect(revealedSubtitle(cue, 1)).toBe("I am here.");
  });

  it("retains cue boundaries when estimating words in adjacent untimed fragments", () => {
    const [sentence] = subtitleSentences([
      { start: 0, end: 1, text: "This tool" }, { start: 1.5, end: 3.5, text: "can save time." }
    ], true);
    expect(revealedSubtitle(sentence, .4)).toBe("This");
    expect(revealedSubtitle(sentence, 1.3)).toBe("This tool");
    expect(revealedSubtitle(sentence, 1.5)).toBe("This tool can");
    expect(revealedSubtitle(sentence, 3.4)).toBe("This tool can save time.");
  });

  it("preserves WebVTT inline timestamps and decoded text, and estimates plain SRT by media time", () => {
    const [vtt] = parseSubtitles("WEBVTT\n\n00:01.000 --> 00:05.000\n<i>Hello</i> <00:02.300>world &amp; <00:04.100>friends.");
    expect(vtt.text).toBe("Hello world & friends.");
    expect(revealedSubtitle(vtt, 2.29)).toBe("Hello");
    expect(revealedSubtitle(vtt, 2.3)).toBe("Hello world");
    expect(revealedSubtitle(vtt, 4.1)).toBe("Hello world & friends.");
    const [srt] = parseSubtitles("1\n00:00:00,000 --> 00:00:04,000\nOne two three four.");
    expect(revealedSubtitle(srt, 0)).toBe("One");
    expect(revealedSubtitle(srt, 2.1)).toBe("One two three");
    expect(revealedSubtitle(srt, 1.1)).toBe("One two");
  });

  it("rejects invalid or unbounded word timing metadata without losing readable subtitle text", () => {
    const cue = { start: 1, end: 4, text: "Hello world" };
    for (const words of [
      [{ start: NaN, endOffset: 11 }], [{ start: 0, endOffset: 11 }], [{ start: 5, endOffset: 11 }],
      [{ start: 1, endOffset: 100 }], [{ start: 2, endOffset: 5 }, { start: 1, endOffset: 11 }],
      [{ start: 1, endOffset: 5 }], Array(4001).fill({ start: 1, endOffset: 11 })
    ]) expect(validSubtitleCues([{ ...cue, words }])).toEqual([cue]);
  });

  it("never drops unspaced sentences when Western layout is used with a CJK original", () => {
    const sentences = subtitleSentences([{ start: 0, end: 4, text: "第一句。第二句。" }], true);
    expect(sentences.map(cue => revealedSubtitle(cue, cue.start))).toEqual(["第一句。", "第二句。"]);
  });
});
