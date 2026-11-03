export function protectedTextTokens(text: string): string[] {
  return text.match(/⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫/gu) ?? [];
}

// Accept only unambiguous changes to a token's typography. Missing, repeated
// or substituted IDs must never be guessed from their positions in a sentence.
export function normalizeProtectedText(source: string, translation: string): string | undefined {
  const normalized = translation.replace(
    /[⟪《〈<【\[{«「『]+\s*WUPAGE\s*(OPEN|CLOSE)?\s*(\d+)\s*[⟫》〉>】\]}»」』]+/giu,
    (_match, kind: string | undefined, id: string) => `⟪WUPAGE${kind?.toUpperCase() ?? ""}${Number(id)}⟫`
  );
  const expected = protectedTextTokens(source).sort();
  const actual = protectedTextTokens(normalized).sort();
  return expected.length === actual.length && expected.every((token, index) => token === actual[index])
    && sameMarkupParents(source, normalized)
    ? normalized
    : undefined;
}

// Paired format IDs may move among siblings with translated word order, but
// must remain balanced, unique and inside their original parent format.
function sameMarkupParents(source: string, translation: string): boolean {
  const parents = (text: string): Map<string, { parent?: string; text: boolean; directWords?: boolean }> | undefined => {
    const result = new Map<string, { parent?: string; text: boolean; directWords?: boolean }>([["ROOT", { text: false }]]);
    const stack: Array<{ id: string; start: number }> = [];
    let cursor = 0;
    const readDirect = (end: number) => {
      if (/[\p{L}\p{N}]/u.test(text.slice(cursor, end))) result.get(stack.at(-1)?.id ?? "ROOT")!.directWords = true;
    };
    for (const match of text.matchAll(/⟪WUPAGE(OPEN|CLOSE)?(\d+)⟫/gu)) {
      readDirect(match.index!);
      const [, kind, id] = match;
      if (!kind) {
        result.set(`ATOM${id}`, { parent: stack.at(-1)?.id, text: true });
      } else if (kind === "OPEN") {
        if (result.has(id)) return undefined;
        result.set(id, { parent: stack.at(-1)?.id, text: false });
        stack.push({ id, start: match.index! + match[0].length });
      } else {
        const open = stack.pop();
        if (open?.id !== id) return undefined;
        result.get(id)!.text = Boolean(text.slice(open.start, match.index).replace(/⟪WUPAGE(?:OPEN|CLOSE)\d+⟫/gu, "").trim());
      }
      cursor = match.index! + match[0].length;
    }
    readDirect(text.length);
    return stack.length ? undefined : result;
  };
  const before = parents(source), after = parents(translation);
  return Boolean(before && after && before.size === after.size
    && [...before].every(([id, entry]) => after.has(id) && after.get(id)!.parent === entry.parent
      && (!entry.text || after.get(id)!.text)
      && (!after.get(id)!.directWords || entry.directWords)));
}
