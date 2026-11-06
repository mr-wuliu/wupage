import { describe, expect, it } from "vitest";
import { subtitlePages, subtitlePagePair } from "../src/video/subtitle-display";

const measure = (value: string) => [...value].length;
describe("subtitle presentation pages", () => {
  it.each(["one two three four five six seven eight nine", "这是很长的一段中文字幕需要分屏显示而且不能丢失内容", "👩‍👩‍👧‍👦é你好👩‍👩‍👧‍👦é你好"])("keeps all text in bounded two-line pages: %s", text => {
    const pages = subtitlePages(text, 8, measure);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every(page => page.split("\n").length <= 2)).toBe(true);
    expect(pages.join("").replace(/\s/gu, "")).toBe(text.replace(/\s/gu, ""));
  });
  it("keeps Latin words and composed emoji together and respects authored newlines", () => {
    expect(subtitlePages("one two three four", 8, measure, 1)).toEqual(["one two", "three", "four"]);
    expect(subtitlePages("one two three four", 8, measure)).toEqual(["one two\nthree", "four"]);
    expect(subtitlePages("👩‍👩‍👧‍👦👩‍👩‍👧‍👦", 2, measure)).toEqual(["👩‍👩‍👧‍👦\n👩‍👩‍👧‍👦"]);
    expect(subtitlePages("first\nsecond\nthird", 20, measure)).toEqual(["first\nsecond", "third"]);
  });
  it("advances both languages together, seeks deterministically, and never loses the final page", () => {
    const source = ["A", "B"], translation = ["一", "二", "三"];
    expect(subtitlePagePair(source, translation, 0)).toEqual({ source: "A", translation: "一" });
    expect(subtitlePagePair(source, translation, .5)).toEqual({ source: "A", translation: "二" });
    expect(subtitlePagePair(source, translation, .9)).toEqual({ source: "B", translation: "三" });
    expect(subtitlePagePair(source, translation, 1)).toEqual({ source: "B", translation: "三" });
    expect(subtitlePagePair([], translation, .5)).toEqual({ source: "", translation: "二" });
    expect(subtitlePagePair(source, translation, 0)).toEqual({ source: "A", translation: "一" });
  });
});
