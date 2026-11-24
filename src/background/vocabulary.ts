import {
  VOCABULARY_SCHEMA_VERSION, VOCABULARY_STORAGE_KEY, VOCABULARY_VERSION_KEY,
  migrateVocabularyV1, normalizeVocabularySnapshot, normalizeVocabularyTerm, replaceVocabularySnapshot,
  validateVocabularyCollection, type VocabularyCollectionV2, type VocabularyEntry, type VocabularySnapshot
} from "../shared/vocabulary";

const RECOVERY_KEY = "wupage.vocabulary.recovery.v1";
let writeQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function ensureCurrentSchema(): Promise<VocabularyCollectionV2> {
  const all = await chrome.storage.local.get(null);
  const version = all[VOCABULARY_VERSION_KEY];
  const dataKeys = Object.keys(all).filter(key => /^wupage\.vocabulary\.v\d+$/u.test(key));
  const versions = dataKeys.map(key => Number(key.slice("wupage.vocabulary.v".length)));
  const highestKnownKey = versions.slice().sort((a, b) => b - a)[0];
  if (typeof version === "number" && version > VOCABULARY_SCHEMA_VERSION) {
    throw new Error("This vocabulary data was written by a newer WuPage version. Reload an updated extension before making changes.");
  }
  if (version !== undefined && version !== 1 && version !== VOCABULARY_SCHEMA_VERSION) {
    throw new Error("The vocabulary version pointer is invalid. Its data has been kept for recovery.");
  }
  if (versions.some(item => item !== 1 && item !== VOCABULARY_SCHEMA_VERSION)) {
    throw new Error(highestKnownKey && highestKnownKey > VOCABULARY_SCHEMA_VERSION
      ? "A newer vocabulary data version was found. Reload an updated extension before making changes."
      : "An unsupported vocabulary data version was found. Its data has been kept for recovery.");
  }
  const raw = all[VOCABULARY_STORAGE_KEY];
  if (version === VOCABULARY_SCHEMA_VERSION && raw === undefined) {
    throw new Error("Vocabulary data is missing. It has been kept for recovery; no empty collection was created.");
  }
  if (raw === undefined && all["wupage.vocabulary.v1"] !== undefined) {
    let migrated: VocabularyCollectionV2;
    try { migrated = migrateVocabularyV1(all["wupage.vocabulary.v1"]); }
    catch (error) {
      await chrome.storage.local.set({ [RECOVERY_KEY]: all["wupage.vocabulary.v1"] });
      throw error;
    }
    await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: migrated });
    const staged = await chrome.storage.local.get(VOCABULARY_STORAGE_KEY);
    const verified = validateVocabularyCollection(staged[VOCABULARY_STORAGE_KEY]);
    if (JSON.stringify(verified) !== JSON.stringify(migrated)) throw new Error("Vocabulary migration could not be verified. The previous data has been kept for recovery.");
    await chrome.storage.local.set({ [VOCABULARY_VERSION_KEY]: VOCABULARY_SCHEMA_VERSION });
    // The user asked to remove all language metadata. Once the clean copy is
    // verified and active, discard the old language-aware version.
    await chrome.storage.local.remove("wupage.vocabulary.v1");
    return verified;
  }
  if (raw === undefined && version !== undefined) {
    throw new Error("Vocabulary data is missing. It has been kept for recovery; no empty collection was created.");
  }
  if (raw === undefined) {
    const empty: VocabularyCollectionV2 = { version: VOCABULARY_SCHEMA_VERSION, entries: [] };
    await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: empty, [VOCABULARY_VERSION_KEY]: VOCABULARY_SCHEMA_VERSION });
    return empty;
  }
  let collection: VocabularyCollectionV2;
  try { collection = validateVocabularyCollection(raw); }
  catch (error) {
    // Keep an untouched local copy before any future migration or write path can run.
    await chrome.storage.local.set({ [RECOVERY_KEY]: raw });
    throw error;
  }
  if (version !== VOCABULARY_SCHEMA_VERSION) {
    await chrome.storage.local.set({ [VOCABULARY_VERSION_KEY]: VOCABULARY_SCHEMA_VERSION });
  }
  if (all["wupage.vocabulary.v1"] !== undefined) await chrome.storage.local.remove("wupage.vocabulary.v1");
  return collection;
}

function assertExtensionSender(sender: chrome.runtime.MessageSender): void {
  if (sender.id !== chrome.runtime.id) throw new Error("Vocabulary actions must come from WuPage.");
}

function assertId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[\w-]{1,100}$/u.test(value)) throw new Error("The vocabulary entry could not be found.");
}

async function commit(collection: VocabularyCollectionV2): Promise<void> {
  const validated = validateVocabularyCollection(collection);
  await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: validated, [VOCABULARY_VERSION_KEY]: VOCABULARY_SCHEMA_VERSION });
}

export async function handleVocabularyRequest(request: {
  type: string;
  [key: string]: unknown;
}, sender: chrome.runtime.MessageSender): Promise<unknown> {
  assertExtensionSender(sender);
  return serialized(async () => {
    if (request.type === "VOCABULARY_EXPORT_RECOVERY") {
      if (sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL("vocabulary.html")) throw new Error("Open the vocabulary page to export recovery data.");
      const recovery = await chrome.storage.local.get(null);
      if (RECOVERY_KEY in recovery) return recovery[RECOVERY_KEY];
      const preserved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(recovery)) {
        if (key === VOCABULARY_VERSION_KEY || /^wupage\.vocabulary\.v\d+$/u.test(key)) preserved[key] = value;
      }
      if (!Object.keys(preserved).length) throw new Error("No vocabulary recovery copy is available.");
      return preserved;
    }
    const collection = await ensureCurrentSchema();
    switch (request.type) {
      case "VOCABULARY_LIST":
        return collection.entries.slice().sort((a, b) => b.savedAt - a.savedAt || b.updatedAt - a.updatedAt);
      case "VOCABULARY_GET": {
        const normalizedTerm = normalizeVocabularyTerm(request.term);
        if (!normalizedTerm) throw new Error("Enter a word to search for.");
        return collection.entries.find(entry => entry.normalizedTerm === normalizedTerm) ?? null;
      }
      case "VOCABULARY_SAVE": {
        const incoming = normalizeVocabularySnapshot(request.entry as VocabularySnapshot);
        const existingIndex = collection.entries.findIndex(entry => entry.normalizedTerm === incoming.normalizedTerm);
        const now = Date.now();
        if (existingIndex >= 0) {
          collection.entries[existingIndex] = replaceVocabularySnapshot(collection.entries[existingIndex], incoming, now);
          await commit(collection);
          return collection.entries[existingIndex];
        }
        const entry: VocabularyEntry = { ...incoming, id: crypto.randomUUID(), savedAt: now, updatedAt: now };
        collection.entries.push(entry);
        await commit(collection);
        return entry;
      }
      case "VOCABULARY_DELETE": {
        assertId(request.id);
        const next = collection.entries.filter(entry => entry.id !== request.id);
        if (next.length !== collection.entries.length) await commit({ ...collection, entries: next });
        return { deleted: true };
      }
      default:
        throw new Error("Unsupported vocabulary action.");
    }
  });
}

chrome.runtime.onInstalled?.addListener(() => {
  void serialized(() => ensureCurrentSchema()).catch(() => undefined);
});
