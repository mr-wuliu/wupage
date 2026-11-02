// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { normalizeSettings } from "../src/shared/settings";
import { dictionaryProviderForQuery, dictionarySourceUrl, isChineseDictionaryQuery, isDictionaryAudioUrl, isSingleDictionaryWord, normalizeDictionaryQuery, normalizeSelectionText } from "../src/shared/dictionary";
import { parseBingDictionary, parseYoudaoDictionary } from "../src/dictionary/parsers";

const bing = `<html><head><title>example - 搜索 词典</title></head><body><div class="qdef">
<h1>example</h1><div class="hd_prUS">美 [ɪɡˈzæmpəl]</div><div class="hd_pr">英 [ɪɡˈzɑːmpəl]</div>
<a id="bigaud_us" data-mp3link="/dict/mediamp3?blob=audio%2Fus.mp3"></a>
<a id="bigaud_uk" data-mp3link="/dict/mediamp3?blob=audio%2Fuk.mp3"></a>
<ul><li><span class="pos">n.</span><span class="def">例子；范例</span></li></ul></div></body></html>`;

describe("dictionary settings and input", () => {
  it("migrates old settings and rejects unknown providers/styles", () => {
    expect(normalizeSettings({}).selectionTranslation).toEqual({ enabled: true, provider: "youdao", style: "dot" });
    expect(normalizeSettings({ selectionTranslation: { enabled: false, provider: "bing", style: "underline" } }).selectionTranslation)
      .toEqual({ enabled: false, provider: "bing", style: "underline" });
    expect(normalizeSettings({ selectionTranslation: { enabled: "true", provider: "evil", style: "unknown" } }).selectionTranslation)
      .toEqual({ enabled: true, provider: "youdao", style: "dot" });
  });
  it("normalizes phrases, preserves non-Latin words and bounds selection length", () => {
    expect(normalizeDictionaryQuery("  take\n off  ")).toBe("take off");
    expect(normalizeDictionaryQuery("你好")).toBe("你好");
    expect(normalizeDictionaryQuery("e\u0301cole")).toBe("école");
    for (const value of [" ", "123.45", "a".repeat(101), "hello\0", {}, undefined]) expect(normalizeDictionaryQuery(value)).toBe("");
  });
  it("routes alphabetic words and short Han selections to the dictionary", () => {
    for (const word of ["filesystem", "Running", "don't", "well-known", "école", "e\u0301cole"]) expect(isSingleDictionaryWord(word)).toBe(true);
    for (const word of ["齉", "垚", "生僻", "重", "漢字", "魑魅魍魉", "𠮷", "一".repeat(8)]) expect(isSingleDictionaryWord(word)).toBe(true);
    for (const text of ["take off", "first\nsecond", "feat: add selection translation", "hello!", "这是一句需要直接翻译的中文", "你好。", "中文 English", "生 僻", "翻訳する", "한국어", "123", "a".repeat(101)]) expect(isSingleDictionaryWord(text)).toBe(false);
  });
  it("uses Youdao's Chinese dictionary without changing the default for alphabetic words", () => {
    expect(isChineseDictionaryQuery("  齉  ")).toBe(true);
    expect(isChineseDictionaryQuery("𠮷".repeat(8))).toBe(true);
    for (const value of ["一".repeat(9), "𠮷".repeat(9), "你好！", "中文\n汉字", "汉字かな", "hello"]) expect(isChineseDictionaryQuery(value)).toBe(false);
    expect(dictionaryProviderForQuery("bing", "齉")).toBe("youdao");
    expect(dictionaryProviderForQuery("bing", "hello")).toBe("bing");
    expect(new URL(dictionarySourceUrl("youdao", "齉")).searchParams.get("lang")).toBe("zh");
  });
  it("allows longer selections and preserves paragraph breaks for translation", () => {
    const paragraph = "Read this paragraph.\r\n".repeat(10).trim();
    expect(normalizeSelectionText(paragraph)).toBe(paragraph.replaceAll("\r\n", "\n"));
    expect(normalizeSelectionText("a".repeat(5000))).toHaveLength(5000);
    for (const text of ["a".repeat(5001), "hello\0", "12345", undefined]) expect(normalizeSelectionText(text)).toBe("");
  });
  it("only permits HTTPS audio from the selected dictionary's fixed endpoint", () => {
    expect(isDictionaryAudioUrl("youdao", "https://dict.youdao.com/dictvoice?audio=hello&type=1")).toBe(true);
    expect(isDictionaryAudioUrl("bing", "https://cn.bing.com/dict/mediamp3?blob=audio%2Fhello.mp3")).toBe(true);
    for (const url of ["http://dict.youdao.com/dictvoice", "https://dict.youdao.com.evil.test/dictvoice", "https://dict.youdao.com/other", "https://user@dict.youdao.com/dictvoice", "https://dict.youdao.com:4433/dictvoice", "data:audio/mpeg;base64,AAAA"]) {
      expect(isDictionaryAudioUrl("youdao", url)).toBe(false);
    }
    expect(isDictionaryAudioUrl("bing", "https://dict.youdao.com/dictvoice")).toBe(false);
  });
});

describe("dictionary response adapters", () => {
  it("reads Youdao array entries, pronunciation variants and word forms", () => {
    const entry = parseYoudaoDictionary({ ec: { word: [{ "return-phrase": { l: { i: "take off" } }, ukphone: "teɪk ɒf", usphone: "teɪk ɔːf",
      ukspeech: "take+off&type=1", usspeech: "take+off&type=2", trs: [{ tr: [{ l: { i: ["v. 起飞；脱下"] } }] }] }] } }, "take off");
    expect(entry.meanings).toEqual([{ partOfSpeech: "v.", definition: "起飞；脱下" }]);
    expect(entry.pronunciations).toEqual([
      { accent: "uk", phonetic: "teɪk ɒf", audioUrl: "https://dict.youdao.com/dictvoice?audio=take+off&type=1" },
      { accent: "us", phonetic: "teɪk ɔːf", audioUrl: "https://dict.youdao.com/dictvoice?audio=take+off&type=2" }
    ]);
  });
  it("accepts Youdao object-shaped entries and extracts annotated Chinese-English definitions as plain text", () => {
    expect(parseYoudaoDictionary({ ec: { word: { "return-phrase": "example", trs: [{ pos: "n.", tran: "例子" }] } } }, "example").meanings)
      .toEqual([{ partOfSpeech: "n.", definition: "例子" }]);
    const entry = parseYoudaoDictionary({ ce: { word: [{ phone: "nǐ hǎo", trs: [{ tr: [{ l: { i: ["", { "#text": "hello", "@href": "app:ds:hello" }, " / ", { "#text": "hi" }] } }] }] }] } }, "你好");
    expect(entry.meanings).toEqual([{ partOfSpeech: "", definition: "hello / hi" }]);
    expect(entry.pronunciations).toEqual([{ accent: "pinyin", phonetic: "nǐ hǎo" }]);
  });
  it("prefers Chinese definitions to Chinese-English translations for rare characters", () => {
    const entry = parseYoudaoDictionary({ input: "齉", newhh: { word: "齉", dataList: [
      { pinyin: "nàng", cat: "形容词", sense: [{ def: ["鼻子不通气；也指因鼻子不通气而发音不清"] }] }
    ] }, ce: { word: [{ phone: "nàng", trs: [{ tr: [{ l: { i: ["nasal"] } }] }] }] } }, "齉");
    expect(entry.word).toBe("齉");
    expect(entry.pronunciations).toEqual([{ accent: "pinyin", phonetic: "nàng" }]);
    expect(entry.meanings).toEqual([{ partOfSpeech: "形容词", definition: "鼻子不通气；也指因鼻子不通气而发音不清" }]);
    expect(entry.sourceUrl).toContain("lang=zh");
  });
  it("accepts Chinese-only entries and preserves the reading for each polyphonic definition", () => {
    const entry = parseYoudaoDictionary({ newhh: { word: "重", dataList: [
      { pinyin: "chóng", sense: [{ cat: "动词", def: ["重叠；重复"] }] },
      { pinyin: "zhòng", sense: [{ cat: "形容词", def: ["重量大", "程度深"] }] },
      { pinyin: "zhòng", sense: [{ cat: "名词", def: ["分量"] }] }
    ] } }, "重");
    expect(entry.pronunciations).toEqual([{ accent: "pinyin", phonetic: "chóng" }, { accent: "pinyin", phonetic: "zhòng" }]);
    expect(entry.meanings).toEqual([
      { partOfSpeech: "动词", definition: "重叠；重复", pronunciation: "chóng" },
      { partOfSpeech: "形容词", definition: "重量大", pronunciation: "zhòng" },
      { partOfSpeech: "形容词", definition: "程度深", pronunciation: "zhòng" },
      { partOfSpeech: "名词", definition: "分量", pronunciation: "zhòng" }
    ]);
    expect(parseYoudaoDictionary({ newhh: { word: "汉字", dataList: [{ pinyin: "hànzì", sense: [{ def: ["记录汉语的文字。"] }] }] } }, "漢字"))
      .toMatchObject({ query: "漢字", word: "汉字" });
  });
  it("keeps available pinyin when Chinese definitions are absent and ignores malformed senses", () => {
    expect(parseYoudaoDictionary({ simple: { word: [{ phone: "nǐ hǎo" }] } }, "你好"))
      .toMatchObject({ pronunciations: [{ accent: "pinyin", phonetic: "nǐ hǎo" }], meanings: [] });
    const entry = parseYoudaoDictionary({ newhh: { dataList: [{ pinyin: "yáo", sense: [null, { def: [null, {}, "山势高峻。"] }] }] } }, "垚");
    expect(entry.meanings).toEqual([{ partOfSpeech: "", definition: "山势高峻。" }]);
  });
  it("uses the basic dictionary pinyin if a Chinese definition omits its reading", () => {
    const entry = parseYoudaoDictionary({ newhh: { word: "垚", dataList: [{ sense: [{ def: ["山势高峻。"] }] }] },
      simple: { word: [{ phone: "yáo" }] } }, "垚");
    expect(entry.pronunciations).toEqual([{ accent: "pinyin", phonetic: "yáo" }]);
    expect(entry.meanings).toEqual([{ partOfSpeech: "", definition: "山势高峻。" }]);
  });
  it("distinguishes a missing word from an invalid or blocked response", () => {
    expect(parseYoudaoDictionary({ input: "nonword" }, "nonword").meanings).toEqual([]);
    expect(() => parseYoudaoDictionary({ errorCode: 411 }, "example")).toThrow("无法识别");
    expect(parseBingDictionary("<title>nonword - 搜索 词典</title>", "nonword").meanings).toEqual([]);
    expect(() => parseBingDictionary("<title>Access Denied</title>", "example")).toThrow("暂时不可用");
  });
  it("extracts Bing pronunciations, audio paths and meanings without executing or attaching remote content", () => {
    const entry = parseBingDictionary(bing + '<script>window.remoteScriptRan=true</script><img src="https://evil.test/tracker">', "example");
    expect(entry.word).toBe("example");
    expect(entry.meanings).toEqual([{ partOfSpeech: "n.", definition: "例子；范例" }]);
    expect(entry.pronunciations).toHaveLength(2);
    expect(entry.pronunciations[0]).toMatchObject({ accent: "uk", phonetic: "ɪɡˈzɑːmpəl", audioUrl: "https://cn.bing.com/dict/mediamp3?blob=audio%2Fuk.mp3" });
    expect(document.querySelector("img")).toBeNull();
    expect((window as unknown as Record<string, unknown>).remoteScriptRan).toBeUndefined();
  });
  it("ignores missing phonetics and rejects unexpected audio origins in Bing HTML", () => {
    const entry = parseBingDictionary(bing.replace('/dict/mediamp3?blob=audio%2Fuk.mp3', 'https://evil.test/audio.mp3').replace('<div class="hd_prUS">美 [ɪɡˈzæmpəl]</div>', ''), "example");
    expect(entry.pronunciations[0]).toMatchObject({ accent: "uk", audioUrl: undefined });
    expect(entry.pronunciations[1]).toMatchObject({ accent: "us", phonetic: undefined });
  });
});
