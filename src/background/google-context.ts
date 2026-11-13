/** Only extension-generated HTML is sent; source text is always escaped. */
export function googleHtmlSource(texts: string[], context?: string): string[] {
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  if (!context?.trim()) return texts.map(text => `<pre>${escape(text)}</pre>`);
  const length = texts.reduce((sum, text) => sum + text.length, 0);
  const hint = (length < 300 ? context.slice(0, 800) : context.split("\n", 1)[0].slice(0, 240)).trim();
  return [`<pre>${[hint, ...texts].map((text, index) => `<a i=${index}>${escape(text)}</a>`).join("\n\n")}</pre>`];
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (!entity.startsWith("#")) return named[entity] ?? match;
    const value = Number.parseInt(entity.slice(/^#x/i.test(entity) ? 2 : 1), /^#x/i.test(entity) ? 16 : 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : match;
  });
}

/** Parse a small, inert subset in the service worker, which has no DOMParser.
 * Never render returned markup. Google's optional <i> spans contain the source,
 * while <b> spans contain its translation. Decode entities only after parsing.
 */
function readHtml(html: string, count?: number): string[] | undefined {
  const output = Array<string>(count ?? 1).fill("");
  const seen = new Set<number>();
  let anchor: number | undefined;
  let original = false;
  let previous: number | undefined;
  const append = (text: string) => {
    const index = count === undefined ? 0 : anchor;
    // Unassigned prose could belong to either paragraph. Refuse it rather than
    // silently assigning it to the wrong paragraph or displaying the context.
    if (index === undefined) return !text.trim();
    output[index] += text;
    return true;
  };
  for (const token of html.match(/<[^>]*>|[^<]+|</g) ?? []) {
    if (/^<\/i\s*>$/i.test(token)) { if (!original) return; original = false; continue; }
    if (original) continue;
    if (!token.startsWith("<")) { if (!append(token)) return; continue; }
    if (/^<\/?(?:pre|b)\s*>$/i.test(token)) continue;
    if (/^<br\s*\/?>$/i.test(token)) { if (!append("\n")) return; continue; }
    if (/^<i\s*>$/i.test(token)) { original = true; continue; }
    if (/^<\/a\s*>$/i.test(token)) { anchor = undefined; continue; }
    const match = /^<a\s+i\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))\s*>$/i.exec(token);
    if (!match || count === undefined) return;
    const index = Number(match[1] ?? match[2] ?? match[3]);
    if (index >= count || anchor !== undefined || previous !== undefined && index < previous) return;
    previous = anchor = index;
    seen.add(index);
  }
  if (original || anchor !== undefined || count !== undefined && seen.size !== count) return;
  const decoded = output.map(value => decodeEntities(value).trim());
  return decoded.every(Boolean) ? decoded : undefined;
}

export function parseGoogleHtml(payload: unknown, count: number, contextual: boolean): string[] | undefined {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return;
  const values: unknown[] = payload[0];
  if (values.length !== (contextual ? 1 : count) || !values.every(value => typeof value === "string")) return;
  if (contextual) return readHtml(values[0] as string, count + 1)?.slice(1);
  const result = values.map(value => readHtml(value as string)?.[0]);
  return result.every((value): value is string => value !== undefined) ? result : undefined;
}
