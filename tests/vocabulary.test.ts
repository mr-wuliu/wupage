import { describe, expect, it } from "vitest";
import { migrateVocabularyV1, normalizeVocabularySnapshot, normalizeVocabularyTerm, validateVocabularyCollection } from "../src/shared/vocabulary";

describe("vocabulary data", () => {
  it("normalizes Latin terms consistently while retaining non-Latin case", () => {
    expect(normalizeVocabularyTerm("  Hello\tWORLD  ")).toBe("hello world");
    expect(normalizeVocabularyTerm("日本語")).toBe("日本語");
    expect(normalizeVocabularyTerm("\u0000")).toBe("");
  });

  it("rejects audio addresses outside the selected dictionary provider", () => {
    expect(() => normalizeVocabularySnapshot({
      term: "example", dictionaryProvider: "youdao",
      pronunciations: [{ accent: "uk", audioUrl: "https://evil.example/audio.mp3" }]
    })).toThrow("pronunciation audio address is invalid");
  });

  it("migrates old language-aware records into a deduplicated term-only collection", () => {
    const oldTime = 1_700_000_000_000;
    const newTime = oldTime + 1000;
    const collection = migrateVocabularyV1({ version: 1, entries: [
      { id: "first", term: "Hello", normalizedTerm: "hello", language: "en", targetLang: "zh", dictionaryProvider: "youdao",
        pronunciations: [], meanings: [{ partOfSpeech: "n.", definition: "问候" }], translation: "你好", savedAt: oldTime, updatedAt: oldTime },
      { id: "second", term: "HELLO", normalizedTerm: "hello", language: "en", targetLang: "fr", dictionaryProvider: "bing",
        pronunciations: [], meanings: [{ partOfSpeech: "interj.", definition: "打招呼" }], savedAt: newTime, updatedAt: newTime }
    ] });

    expect(collection.entries).toHaveLength(1);
    expect(collection.entries[0]).toMatchObject({ id: "first", term: "HELLO", normalizedTerm: "hello",
      savedAt: oldTime, updatedAt: newTime, dictionaryProvider: "bing", translation: "你好",
      meanings: [{ partOfSpeech: "interj.", definition: "打招呼" }], examples: [] });
    expect(collection.entries[0]).not.toHaveProperty("language");
    expect(collection.entries[0]).not.toHaveProperty("targetLang");
    expect(validateVocabularyCollection(collection)).toEqual(collection);
  });
});
