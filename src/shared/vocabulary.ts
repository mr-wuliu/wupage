import { isDictionaryAudioUrl, type DictionaryPronunciation, type DictionaryProvider } from "./dictionary";

export const VOCABULARY_SCHEMA_VERSION = 2 as const;
export const VOCABULARY_STORAGE_KEY = "wupage.vocabulary.v2";
export const VOCABULARY_VERSION_KEY = "wupage.vocabulary.currentVersion";
export const VOCABULARY_MAX_ENTRY_BYTES = 64_000;
export const VOCABULARY_MAX_COLLECTION_BYTES = 2_000_000;
const MAX_TEXT_LENGTH = 12_000;

export interface VocabularyExample { sentence: string; translation?: string }
export interface VocabularyMeaning { partOfSpeech: string; definition: string; pronunciation?: string }

export interface VocabularyEntry {
  id: string;
  term: string;
  normalizedTerm: string;
  dictionaryProvider?: string;
  pronunciations: DictionaryPronunciation[];
  meanings: VocabularyMeaning[];
  examples: VocabularyExample[];
  translation?: string;
  savedAt: number;
  updatedAt: number;
}

export interface VocabularyCollectionV2 { version: typeof VOCABULARY_SCHEMA_VERSION; entries: VocabularyEntry[] }
export interface VocabularySnapshot {
  term: string;
  dictionaryProvider?: string;
  pronunciations?: unknown;
  meanings?: unknown;
  examples?: unknown;
  translation?: string;
}

export function normalizeVocabularyTerm(value: unknown): string {
  if (typeof value !== "string" || value.length > 4000) return "";
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized || Array.from(normalized).length > 1000 || /[\u0000-\u001f\u007f]/u.test(normalized)) return "";
  return /\p{Script=Latin}/u.test(normalized) ? normalized.toLocaleLowerCase("und") : normalized;
}

function boundedText(value: unknown, label: string, max = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`The saved ${label} is invalid or too long.`);
  }
  return value;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`${label} contains fields from an unsupported vocabulary version. It has been kept for recovery.`);
  }
}

function normalizePronunciations(value: unknown, provider: unknown): DictionaryPronunciation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error("The pronunciation data is invalid.");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("The pronunciation data is invalid.");
    const candidate = item as Record<string, unknown>;
    rejectUnknownFields(candidate, ["accent", "phonetic", "audioUrl"], "Pronunciation data");
    if (!["uk", "us", "default", "pinyin"].includes(String(candidate.accent))) throw new Error("The pronunciation data is invalid.");
    const pronunciation: DictionaryPronunciation = { accent: candidate.accent as DictionaryPronunciation["accent"] };
    if (candidate.phonetic !== undefined) pronunciation.phonetic = boundedText(candidate.phonetic, "pronunciation", 500);
    if (candidate.audioUrl !== undefined) {
      if ((provider !== "youdao" && provider !== "bing") || !isDictionaryAudioUrl(provider, candidate.audioUrl)) throw new Error("The pronunciation audio address is invalid.");
      pronunciation.audioUrl = candidate.audioUrl;
    }
    return pronunciation;
  });
}

function normalizeMeanings(value: unknown): VocabularyMeaning[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new Error("The dictionary definitions are invalid.");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("The dictionary definitions are invalid.");
    const candidate = item as Record<string, unknown>;
    rejectUnknownFields(candidate, ["partOfSpeech", "definition", "pronunciation"], "Dictionary definitions");
    const meaning: VocabularyMeaning = { partOfSpeech: boundedText(candidate.partOfSpeech, "part of speech", 300), definition: boundedText(candidate.definition, "definition") };
    if (candidate.pronunciation !== undefined) meaning.pronunciation = boundedText(candidate.pronunciation, "pronunciation", 500);
    return meaning;
  });
}

function normalizeExamples(value: unknown): VocabularyExample[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error("The dictionary examples are invalid.");
  return value.map(item => {
    if (!item || typeof item !== "object") throw new Error("The dictionary examples are invalid.");
    const candidate = item as Record<string, unknown>;
    rejectUnknownFields(candidate, ["sentence", "translation"], "Dictionary examples");
    const example: VocabularyExample = { sentence: boundedText(candidate.sentence, "example") };
    if (candidate.translation !== undefined) example.translation = boundedText(candidate.translation, "example translation");
    return example;
  });
}

export function normalizeVocabularySnapshot(input: unknown): Omit<VocabularyEntry, "id" | "savedAt" | "updatedAt"> {
  if (!input || typeof input !== "object") throw new Error("The vocabulary entry is invalid.");
  const value = input as Record<string, unknown>;
  rejectUnknownFields(value, ["term", "dictionaryProvider", "pronunciations", "meanings", "examples", "translation"], "Vocabulary entry");
  const term = boundedText(value.term, "word", 4000).normalize("NFC").replace(/\s+/gu, " ").trim();
  const normalizedTerm = normalizeVocabularyTerm(term);
  if (!normalizedTerm) throw new Error("Enter a word to save.");
  const entry: Omit<VocabularyEntry, "id" | "savedAt" | "updatedAt"> = {
    term, normalizedTerm,
    pronunciations: normalizePronunciations(value.pronunciations, value.dictionaryProvider),
    meanings: normalizeMeanings(value.meanings),
    examples: normalizeExamples(value.examples)
  };
  if (value.dictionaryProvider !== undefined) {
    if (typeof value.dictionaryProvider !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/iu.test(value.dictionaryProvider)) throw new Error("The dictionary provider is invalid.");
    entry.dictionaryProvider = value.dictionaryProvider;
  }
  if (value.translation !== undefined) {
    const translation = boundedText(value.translation, "translation");
    if (translation.trim()) entry.translation = translation;
  }
  if (new TextEncoder().encode(JSON.stringify(entry)).byteLength > VOCABULARY_MAX_ENTRY_BYTES) throw new Error("This vocabulary entry is too large to save.");
  return entry;
}

export function replaceVocabularySnapshot(existing: VocabularyEntry, incoming: Omit<VocabularyEntry, "id" | "savedAt" | "updatedAt">, now = Date.now()): VocabularyEntry {
  return { ...incoming, id: existing.id, savedAt: existing.savedAt, updatedAt: now };
}

function validateRecord(item: Record<string, unknown>, version: 1 | 2): VocabularyEntry {
  const fields = version === 1
    ? ["id", "term", "normalizedTerm", "language", "targetLang", "dictionaryProvider", "pronunciations", "meanings", "translation", "savedAt", "updatedAt"]
    : ["id", "term", "normalizedTerm", "dictionaryProvider", "pronunciations", "meanings", "examples", "translation", "savedAt", "updatedAt"];
  rejectUnknownFields(item, fields, "Vocabulary record");
  const snapshot = normalizeVocabularySnapshot({ term: item.term, dictionaryProvider: item.dictionaryProvider,
    pronunciations: item.pronunciations, meanings: item.meanings, examples: version === 2 ? item.examples : [], translation: item.translation });
  if (item.normalizedTerm !== snapshot.normalizedTerm || typeof item.id !== "string" || !/^[\w-]{1,100}$/u.test(item.id)
    || !Number.isSafeInteger(item.savedAt) || (item.savedAt as number) <= 0 || (item.savedAt as number) > Date.now() + 31_536_000_000
    || !Number.isSafeInteger(item.updatedAt) || (item.updatedAt as number) <= 0 || (item.updatedAt as number) > Date.now() + 31_536_000_000) {
    throw new Error("Vocabulary data could not be read. It has been kept for recovery.");
  }
  return { ...snapshot, id: item.id, savedAt: item.savedAt as number, updatedAt: item.updatedAt as number };
}

function validateCollection(value: unknown, version: 1 | 2): VocabularyEntry[] {
  if (!value || typeof value !== "object") throw new Error("Vocabulary data could not be read. It has been kept for recovery.");
  const candidate = value as Record<string, unknown>;
  rejectUnknownFields(candidate, ["version", "entries"], "Vocabulary data");
  if (candidate.version !== version || !Array.isArray(candidate.entries) || candidate.entries.length > 20_000) throw new Error("This vocabulary data version is not supported. It has been kept for recovery.");
  return candidate.entries.map(raw => {
    if (!raw || typeof raw !== "object") throw new Error("Vocabulary data could not be read. It has been kept for recovery.");
    return validateRecord(raw as Record<string, unknown>, version);
  });
}

export function validateVocabularyCollection(value: unknown): VocabularyCollectionV2 {
  const entries = validateCollection(value, 2);
  const normalized = { version: VOCABULARY_SCHEMA_VERSION, entries } satisfies VocabularyCollectionV2;
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > VOCABULARY_MAX_COLLECTION_BYTES) throw new Error("Vocabulary data exceeds the local storage limit.");
  return normalized;
}

/** Migrates the previous language-aware schema to a term-only collection. */
export function migrateVocabularyV1(value: unknown): VocabularyCollectionV2 {
  const legacyEntries = validateCollection(value, 1);
  const merged = new Map<string, VocabularyEntry>();
  for (const entry of legacyEntries) {
    const existing = merged.get(entry.normalizedTerm);
    if (!existing) { merged.set(entry.normalizedTerm, { ...entry, examples: [] }); continue; }
    const newest = entry.updatedAt > existing.updatedAt ? entry : existing;
    const oldest = Math.min(existing.savedAt, entry.savedAt);
    const mergedEntry = replaceVocabularySnapshot({ ...existing, examples: [] }, {
      ...newest, examples: [], pronunciations: newest.pronunciations.length ? newest.pronunciations : existing.pronunciations,
      meanings: newest.meanings.length ? newest.meanings : existing.meanings, translation: newest.translation ?? existing.translation,
      dictionaryProvider: newest.dictionaryProvider ?? existing.dictionaryProvider
    }, Math.max(existing.updatedAt, entry.updatedAt));
    merged.set(entry.normalizedTerm, { ...mergedEntry, savedAt: oldest, id: existing.id });
  }
  const collection = { version: VOCABULARY_SCHEMA_VERSION, entries: [...merged.values()] } satisfies VocabularyCollectionV2;
  return validateVocabularyCollection(collection);
}

export function dictionaryProvider(value: unknown): DictionaryProvider | undefined {
  return value === "youdao" || value === "bing" ? value : undefined;
}
