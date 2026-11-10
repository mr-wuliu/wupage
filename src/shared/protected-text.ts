const BREAK_TOKEN = /⟪WUPAGEBREAK\d+⟫/gu;

export function protectedTextTokens(text: string): string[] {
  return text.match(/⟪WUPAGE(?:OPEN|CLOSE|BREAK)?\d+⟫/gu) ?? [];
}

// Accept only unambiguous changes to a token's typography. Missing, repeated
// or substituted IDs must never be guessed from their positions in a sentence.
export function normalizeProtectedText(source: string, translation: string): string | undefined {
  const normalized = translation.replace(
    /[⟪《〈<【\[{«「『]+\s*WUPAGE\s*(OPEN|CLOSE|BREAK)?\s*(\d+)\s*[⟫》〉>】\]}»」』]+/giu,
    (_match, kind: string | undefined, id: string) => `⟪WUPAGE${kind?.toUpperCase() ?? ""}${Number(id)}⟫`
  );
  const expected = protectedTextTokens(source).sort();
  const actual = protectedTextTokens(normalized).sort();
  if (expected.length !== actual.length || expected.some((token, index) => token !== actual[index])
    || !sameMarkupParents(source, normalized)) return undefined;
  if (!expected.some(token => token.startsWith("⟪WUPAGEBREAK"))) return normalized;
  const before = source.match(BREAK_TOKEN)!;
  const after = normalized.match(BREAK_TOKEN)!;
  if (before.some((token, index) => token !== after[index])) return undefined;
  const hasText = (line: string) => Boolean(line.replace(/⟪WUPAGE(?:OPEN|CLOSE)\d+⟫/gu, "").trim());
  const lines = normalized.split(BREAK_TOKEN);
  if (source.split(BREAK_TOKEN).some((line, index) => hasText(line) !== hasText(lines[index]))) return undefined;
  // Providers sometimes add physical newlines around a break marker. The
  // marker itself supplies the line break when rendered.
  return normalized.replace(/\r\n?|\n/gu, " ");
}

// Paired format IDs may move among siblings with translated word order, but
// must remain balanced, unique and inside their original parent format.
function sameMarkupParents(source: string, translation: string): boolean {
  interface Scope { parent?: string; line?: number; endLine?: number; text: boolean; directWords?: boolean }
  const parents = (text: string): Map<string, Scope> | undefined => {
    const result = new Map<string, Scope>([["ROOT", { text: false }]]);
    const stack: Array<{ id: string; start: number }> = [];
    let cursor = 0;
    let line = 0;
    const readDirect = (end: number) => {
      if (/[\p{L}\p{N}]/u.test(text.slice(cursor, end))) result.get(stack.at(-1)?.id ?? "ROOT")!.directWords = true;
    };
    for (const match of text.matchAll(/⟪WUPAGE(OPEN|CLOSE|BREAK)?(\d+)⟫/gu)) {
      readDirect(match.index!);
      const [, kind, id] = match;
      if (!kind || kind === "BREAK") {
        result.set(`${kind ?? "ATOM"}${id}`, { parent: stack.at(-1)?.id, line, text: true });
        if (kind === "BREAK") line += 1;
      } else if (kind === "OPEN") {
        if (result.has(id)) return undefined;
        result.set(id, { parent: stack.at(-1)?.id, line, text: false });
        stack.push({ id, start: match.index! + match[0].length });
      } else {
        const open = stack.pop();
        if (open?.id !== id) return undefined;
        const scope = result.get(id)!;
        scope.endLine = line;
        scope.text = Boolean(text.slice(open.start, match.index).replace(/⟪WUPAGE(?:OPEN|CLOSE|BREAK)\d+⟫/gu, "").trim());
      }
      cursor = match.index! + match[0].length;
    }
    readDirect(text.length);
    return stack.length ? undefined : result;
  };
  const before = parents(source), after = parents(translation);
  return Boolean(before && after && before.size === after.size
    && [...before].every(([id, entry]) => {
      const translated = after.get(id);
      return translated && translated.parent === entry.parent && translated.line === entry.line && translated.endLine === entry.endLine
        && (!entry.text || translated.text) && (!translated.directWords || entry.directWords);
    }));
}
