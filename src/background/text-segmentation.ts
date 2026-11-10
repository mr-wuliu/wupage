const ATOM = /⟪WUPAGE(?:OPEN|CLOSE|BREAK)?\d+⟫|[\s\S]/gu;
const WHITESPACE = /^\s$/u;

/** Keep exact source boundaries, preferring sentences and then whitespace. */
export function splitTranslationText(source: string, maxChars: number): string[] | undefined {
  if (source.length <= maxChars) return [source];
  const atoms = source.match(ATOM) ?? [];
  const chunks: string[] = [];
  for (let start = 0; start < atoms.length;) {
    let end = start;
    let size = 0;
    let sentenceEnd = start;
    let whitespaceEnd = start;
    while (end < atoms.length && size + atoms[end].length <= maxChars) {
      const atom = atoms[end++];
      size += atom.length;
      if (WHITESPACE.test(atom)) {
        whitespaceEnd = end;
        if (atom === "\n" || atom === "\r") sentenceEnd = end;
      } else if (/^[。！？；]$/u.test(atom)
        || (/^[.!?;]$/u.test(atom) && (end === atoms.length || WHITESPACE.test(atoms[end])))) {
        sentenceEnd = end;
      }
    }
    // Splitting a placeholder or UTF-16 surrogate pair would corrupt it.
    if (end === start) return;
    if (end < atoms.length) end = sentenceEnd > start ? sentenceEnd : whitespaceEnd > start ? whitespaceEnd : end;
    chunks.push(atoms.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}
