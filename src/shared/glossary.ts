import { containsProtectedTextToken } from "./protected-text";
import { matchesRegionSitePattern, normalizeRegionSitePattern } from "./region-site-pattern";

export interface GlossaryEntry {
  id: string;
  site: string;
  source: string;
  target: string;
}

export interface GlossaryGroup {
  id: string;
  name: string;
  enabled: boolean;
  entries: GlossaryEntry[];
}

export const MAX_GLOSSARY_GROUPS = 32;
export const MAX_GLOSSARY_ENTRIES = 100;
export const MAX_GLOSSARY_NAME = 80;
export const MAX_GLOSSARY_TEXT = 256;

export function validGlossaryText(value: string): boolean {
  return Boolean(value.trim()) && value.length <= MAX_GLOSSARY_TEXT && !/[\r\n\0]/u.test(value)
    && !containsProtectedTextToken(value);
}

function identifiedRows(value: unknown): Array<Record<string, unknown> & { id: string }> {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.filter(row => {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id.trim() || ids.has(row.id)) return false;
    ids.add(row.id);
    return true;
  });
}

export function normalizeGlossaryGroups(value: unknown): GlossaryGroup[] {
  return identifiedRows(value).slice(0, MAX_GLOSSARY_GROUPS).flatMap(group => {
    const name = typeof group.name === "string" ? group.name.trim() : "";
    if (!name || name.length > MAX_GLOSSARY_NAME || /[\r\n\0]/u.test(name)) return [];
    const entries = identifiedRows(group.entries).slice(0, MAX_GLOSSARY_ENTRIES).flatMap(entry => {
      if (typeof entry.site !== "string" || typeof entry.source !== "string" || typeof entry.target !== "string") return [];
      const source = entry.source.trim(), target = entry.target.trim();
      if (!validGlossaryText(source) || !validGlossaryText(target)) return [];
      try { return [{ id: entry.id, site: normalizeRegionSitePattern(entry.site), source, target }]; }
      catch { return []; }
    });
    return [{ id: group.id, name, enabled: group.enabled === true, entries }];
  });
}

export type GlossaryTerm = Pick<GlossaryEntry, "source" | "target">;

export function applicableGlossary(groups: GlossaryGroup[] | undefined, address?: string): GlossaryTerm[] {
  const entries = groups?.flatMap(group => group.enabled ? group.entries : []) ?? [];
  const local = address ? entries.filter(entry => entry.site !== "*" && matchesRegionSitePattern(entry.site, address)) : [];
  const chosen = new Set<string>();
  return [...local, ...entries.filter(entry => entry.site === "*")].flatMap(({ source, target }) => {
    const key = source.toLowerCase();
    if (chosen.has(key)) return [];
    chosen.add(key);
    return [{ source, target }];
  });
}

export function glossaryIdentity(groups: GlossaryGroup[] | undefined, address?: string): string {
  return JSON.stringify(applicableGlossary(groups, address));
}

/** Frames such as about:blank inherit the enclosing page's website. */
export function glossaryWebsite(documentUrl?: string, tabUrl?: string): string | undefined {
  return documentUrl && /^(?:https?):\/\//iu.test(documentUrl) ? documentUrl : tabUrl;
}

const WORD_CHARACTER = "[\\p{L}\\p{M}\\p{N}_]";
const UNSEGMENTED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const needsBoundary = (character: string) => /[\p{L}\p{M}\p{N}_]/u.test(character) && !UNSEGMENTED.test(character);

function literalTerm(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
}

export function lookupGlossary(terms: GlossaryTerm[], text: string): string | undefined {
  return terms.find(({ source }) => new RegExp(`^${literalTerm(source)}$`, "iu").test(text.trim()))?.target;
}

export interface GlossaryMatch { start: number; end: number; target: string }

export function createGlossaryMatcher(terms: GlossaryTerm[]): (text: string) => GlossaryMatch[] {
  const rules = terms.map(({ source, target }) => {
    const characters = Array.from(source);
    const before = needsBoundary(characters[0]) ? `(?:(?<!${WORD_CHARACTER})|(?<=${UNSEGMENTED.source}))` : "";
    const after = needsBoundary(characters.at(-1)!) ? `(?:(?!${WORD_CHARACTER})|(?=${UNSEGMENTED.source}))` : "";
    return { pattern: new RegExp(`${before}${literalTerm(source)}${after}`, "giu"), target };
  });
  return text => {
    const bestAtStart = new Map<number, GlossaryMatch>();
    for (const { pattern, target } of rules) {
      for (const match of text.matchAll(pattern)) {
        const start = match.index, end = start + match[0].length;
        if ((bestAtStart.get(start)?.end ?? start) < end) bestAtStart.set(start, { start, end, target });
      }
    }
    let cursor = 0;
    return [...bestAtStart.values()].sort((a, b) => a.start - b.start).filter(match => {
      if (match.start < cursor) return false;
      cursor = match.end;
      return true;
    });
  };
}
