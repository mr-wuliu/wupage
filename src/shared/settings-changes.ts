import type { ExtensionSettings } from "./types";
import { normalizeVideoTranslation } from "./video";

const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Apply only the fields edited since the caller read its settings. */
export function mergeSettingsChanges(
  latest: ExtensionSettings, draft: ExtensionSettings, previous: ExtensionSettings
): ExtensionSettings {
  // The first player save materializes optional video defaults. Compare those
  // defaults rather than treating the entire new object as an intentional edit.
  let baseline = previous;
  if (latest.videoTranslation && draft.videoTranslation) {
    const video = { ...(previous.videoTranslation ?? normalizeVideoTranslation(undefined)) };
    if (latest.videoTranslation.siteLayouts && draft.videoTranslation.siteLayouts && !video.siteLayouts) video.siteLayouts = [];
    baseline = { ...previous, videoTranslation: video };
  }
  return mergeValue(latest, draft, baseline) as ExtensionSettings;
}

function mergeValue(latest: unknown, draft: unknown, previous: unknown): unknown {
  if (equal(draft, previous)) return latest;
  if (record(latest) && record(draft) && record(previous)) {
    const merged = { ...latest };
    for (const key of new Set([...Object.keys(previous), ...Object.keys(draft)])) {
      if (equal(draft[key], previous[key])) continue;
      if (!Object.hasOwn(draft, key)) delete merged[key];
      else Object.defineProperty(merged, key, {
        value: mergeValue(latest[key], draft[key], previous[key]),
        enumerable: true, writable: true, configurable: true
      });
    }
    return merged;
  }
  if (identifiedList(latest) && identifiedList(draft) && identifiedList(previous)) {
    const before = new Map(previous.map(entry => [entry.id, entry]));
    const after = new Map(draft.map(entry => [entry.id, entry]));
    const current = new Set(latest.map(entry => entry.id));
    return [
      ...latest.filter(entry => !before.has(entry.id) || after.has(entry.id)).map(entry =>
        after.has(entry.id) ? mergeValue(entry, after.get(entry.id), before.get(entry.id)) : entry),
      ...draft.filter(entry => !before.has(entry.id) && !current.has(entry.id))
    ];
  }
  return draft;
}

function identifiedList(value: unknown): value is Array<Record<string, unknown> & { id: string }> {
  return Array.isArray(value) && value.every(entry => record(entry) && typeof entry.id === "string");
}
