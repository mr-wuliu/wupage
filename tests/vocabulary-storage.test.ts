import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VocabularyEntry, VocabularySnapshot } from "../src/shared/vocabulary";

let stored: Record<string, unknown>;
let handleVocabularyRequest: typeof import("../src/background/vocabulary").handleVocabularyRequest;

const sender = { id: "wupage-test", url: "chrome-extension://wupage-test/vocabulary.html" } as chrome.runtime.MessageSender;

async function request(type: string, values: Record<string, unknown> = {}): Promise<unknown> {
  return handleVocabularyRequest({ type, ...values }, sender);
}

function largeMeanings() {
  return Array.from({ length: 4 }, () => ({ partOfSpeech: "n.", definition: "a".repeat(10_000) }));
}

function largeExamples() {
  return Array.from({ length: 4 }, () => ({ sentence: "b".repeat(10_000) }));
}

beforeEach(async () => {
  vi.resetModules();
  stored = {};
  vi.stubGlobal("chrome", {
    runtime: { id: "wupage-test", getURL: (path: string) => `chrome-extension://wupage-test/${path}` },
    storage: { local: {
      get: async (keys: string | string[] | null) => {
        if (keys === null) return structuredClone(stored);
        const names = typeof keys === "string" ? [keys] : keys;
        return Object.fromEntries(names.filter(key => key in stored).map(key => [key, structuredClone(stored[key])]));
      },
      set: async (values: Record<string, unknown>) => { Object.assign(stored, structuredClone(values)); },
      remove: async (keys: string | string[]) => { for (const key of typeof keys === "string" ? [keys] : keys) delete stored[key]; }
    } }
  });
  ({ handleVocabularyRequest } = await import("../src/background/vocabulary"));
});

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("vocabulary storage writes", () => {
  it("replaces dictionary data on provider change and can still list and delete the word", async () => {
    const youdao: VocabularySnapshot = {
      term: "taxi", dictionaryProvider: "youdao",
      pronunciations: [{ accent: "uk", phonetic: "ˈtæksi", audioUrl: "https://dict.youdao.com/dictvoice?audio=taxi&type=1" }],
      meanings: [{ partOfSpeech: "n.", definition: "有道释义" }],
      examples: [{ sentence: "Youdao example.", translation: "有道例句" }],
      translation: "有道翻译"
    };
    const bing: VocabularySnapshot = {
      term: "taxi", dictionaryProvider: "bing", pronunciations: [],
      meanings: [{ partOfSpeech: "n.", definition: "Bing definition" }], examples: []
    };

    const first = await request("VOCABULARY_SAVE", { entry: youdao }) as VocabularyEntry;
    const updated = await request("VOCABULARY_SAVE", { entry: bing }) as VocabularyEntry;

    expect(updated).toMatchObject({
      id: first.id, savedAt: first.savedAt, dictionaryProvider: "bing",
      pronunciations: [], meanings: [{ definition: "Bing definition" }], examples: []
    });
    expect(updated).not.toHaveProperty("translation");
    expect(await request("VOCABULARY_LIST")).toEqual([updated]);
    expect(await request("VOCABULARY_DELETE", { id: first.id })).toEqual({ deleted: true });
    expect(await request("VOCABULARY_LIST")).toEqual([]);
  });

  it("replaces rather than combines large snapshots for the same word", async () => {
    const first: VocabularySnapshot = { term: "example", dictionaryProvider: "bing", meanings: largeMeanings() };
    const second: VocabularySnapshot = { term: "example", dictionaryProvider: "bing", examples: largeExamples() };

    await request("VOCABULARY_SAVE", { entry: first });
    const updated = await request("VOCABULARY_SAVE", { entry: second }) as VocabularyEntry;

    expect(updated.meanings).toEqual([]);
    expect(updated.examples).toEqual(second.examples);
    expect(await request("VOCABULARY_LIST")).toEqual([updated]);
  });

  it("keeps the previous word when the replacement snapshot exceeds the entry limit", async () => {
    const first: VocabularySnapshot = { term: "example", dictionaryProvider: "bing", meanings: [{ partOfSpeech: "n.", definition: "saved" }] };
    const oversized: VocabularySnapshot = {
      term: "example", dictionaryProvider: "bing",
      meanings: Array.from({ length: 6 }, () => ({ partOfSpeech: "n.", definition: "x".repeat(12_000) }))
    };
    const saved = await request("VOCABULARY_SAVE", { entry: first }) as VocabularyEntry;

    await expect(request("VOCABULARY_SAVE", { entry: oversized })).rejects.toThrow(/too large/i);

    expect(await request("VOCABULARY_GET", { term: "example" })).toEqual(saved);
    expect(await request("VOCABULARY_LIST")).toEqual([saved]);
  });
});
