import { describe, expect, it } from "vitest";
import { subtitleSentences } from "../src/video/subtitle-sentences";
import type { SubtitleCue } from "../src/video/subtitles";

const line = (start: number, text: string, duration = 1): SubtitleCue => ({ start, end: start + duration, text });

describe("subtitle sentences", () => {
  it("separates multiple sentences inside an authored cue while preserving its full time span", () => {
    const result = subtitleSentences([line(0, "First sentence. Second sentence!", 8)]);
    expect(result.map(cue => cue.text)).toEqual(["First sentence.", "Second sentence!"]);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(result[1].start);
    expect(result[1].end).toBe(8);
  });
  it("joins short ASR fragments without changing the input timeline", () => {
    const cues = [line(0, "This tool can"), line(1, "save you a lot"), line(2, "of time."), line(3, "Try it!")];
    expect(subtitleSentences(cues)).toEqual([line(0, "This tool can save you a lot of time.", 3), line(3, "Try it!")]);
    expect(cues[0]).toEqual(line(0, "This tool can"));
  });
  it("keeps punctuation, abbreviations, decimals and unspaced text readable", () => {
    expect(subtitleSentences([line(0, "Dr."), line(1, "Wu saved 3.5"), line(2, 'hours.”'), line(3, "Next.")]))
      .toEqual([line(0, 'Dr. Wu saved 3.5 hours.”', 3), line(3, "Next.")]);
    expect(subtitleSentences([line(0, "这个工具"), line(1, "可以节省时间。"), line(2, "下一句。")]))
      .toEqual([line(0, "这个工具可以节省时间。", 2), line(2, "下一句。")]);
  });
  it("preserves gaps, overlapping speakers, speaker markers and sound labels", () => {
    for (const cues of [
      [line(0, "First"), line(2, "Second")],
      [line(0, "First", 2), line(1, "Second")],
      [line(0, "First"), line(1, "- Another speaker")],
      [line(0, "[Music]"), line(1, "First")]
    ]) expect(subtitleSentences(cues)).toEqual(cues);
  });
  it("bounds unpunctuated speech by duration, text length and fragment count", () => {
    for (const cues of [
      Array.from({ length: 60 }, (_, i) => line(i, "a phrase")),
      Array.from({ length: 20 }, (_, i) => line(i / 10, "long text ".repeat(10), .1)),
      Array.from({ length: 40 }, (_, i) => line(i / 10, "a", .1))
    ]) {
      const sentences = subtitleSentences(cues);
      expect(sentences.length).toBeGreaterThan(1);
      expect(sentences.every(cue => cue.end - cue.start <= 12 && cue.text.length <= 320)).toBe(true);
      expect(sentences.map(cue => cue.text).join(" ")).toBe(cues.map(cue => cue.text.trim()).join(" "));
    }
  });
});
