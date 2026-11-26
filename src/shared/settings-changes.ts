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
  const merged = mergeValue(latest, draft, baseline) as ExtensionSettings;
  if (draft.inputTranslation && previous.inputTranslation && merged.inputTranslation) {
    const before = previous.inputTranslation.templates.map(template => template.id);
    const after = draft.inputTranslation.templates.map(template => template.id);
    const ordinaryOrder = [...before.filter(id => after.includes(id)), ...after.filter(id => !before.includes(id))];
    if (!equal(after, ordinaryOrder)) {
      const templates = new Map(merged.inputTranslation.templates.map(template => [template.id, template]));
      merged.inputTranslation = { ...merged.inputTranslation,
        templates: [...new Set([...after, ...templates.keys()])].flatMap(id => templates.get(id) ?? []) };
    }
  }
  // Apply individual site edits so simultaneous exclusions from different tabs both survive.
  for (const field of ["floatingBallExcludedSites", "videoFloatingExcludedSites"] as const) {
    if (equal(draft[field], previous[field])) continue;
    const before = new Set(previous[field]);
    const after = new Set(draft[field]);
    const sites = new Set(latest[field]);
    for (const site of before) if (!after.has(site)) sites.delete(site);
    for (const site of after) if (!before.has(site)) sites.add(site);
    merged[field] = [...sites];
  }
  return merged;
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
