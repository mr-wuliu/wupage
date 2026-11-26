import { glossaryWebsite, type GlossaryGroup, type GlossaryMatch } from "../shared/glossary";
import { protectedTextTokens } from "../shared/protected-text";

const MARKER = /⟪WUPAGE(?:OPEN|CLOSE|BREAK)?\d+⟫/gu;

export async function glossaryWebsiteForSender(sender: chrome.runtime.MessageSender, groups: GlossaryGroup[] | undefined): Promise<string | undefined> {
  const { tab, frameId, documentId, url } = sender;
  if (frameId === 0) return glossaryWebsite(tab?.url, url);
  const fallback = glossaryWebsite(url, tab?.url);
  if (tab?.id === undefined || frameId === undefined
    || !groups?.some(group => group.enabled && group.entries.some(entry => entry.site !== "*"))) return fallback;
  // MessageSender.url can stay at the document's initial URL after pushState.
  const current = await chrome.webNavigation?.getFrame?.({ tabId: tab.id, frameId }).catch(() => undefined);
  if (!current || documentId && current.documentId && current.documentId !== documentId) return fallback;
  return glossaryWebsite(current.url, tab.url);
}

/** Reserve the same atomic placeholders used for formulas and inline content. */
export function protectGlossary(text: string, match: (text: string) => GlossaryMatch[]) {
  const replacements = new Map<string, string>();
  const used = new Set(protectedTextTokens(text));
  let id = 0;
  const parts = text.split(/(⟪WUPAGE(?:OPEN|CLOSE|BREAK)?\d+⟫)/gu);
  for (let index = 0; index < parts.length; index += 2) {
    const part = parts[index];
    const chunks: string[] = [];
    let cursor = 0;
    for (const entry of match(part)) {
      let token: string;
      do { token = `⟪WUPAGE${id++}⟫`; } while (used.has(token));
      replacements.set(token, entry.target);
      chunks.push(part.slice(cursor, entry.start), token);
      cursor = entry.end;
    }
    if (cursor) parts[index] = chunks.join("") + part.slice(cursor);
  }
  if (!replacements.size) return undefined;
  const masked = parts.join("");
  return {
    masked,
    needsTranslation: /\p{L}/u.test(masked.replace(MARKER, "")),
    restore: (translation: string) => translation.replace(MARKER, token => replacements.get(token) ?? token)
  };
}
