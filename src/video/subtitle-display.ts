/** A presentation page has at most two measured lines. Translation text stays
 * intact in the cache; paging never feeds fragments back to the translator. */
export function subtitlePages(text: string, width: number, measure: (text: string) => number, maxLines = 2): string[] {
  if (!text) return [];
  width = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  const flush = () => { if (line.trim()) lines.push(line.trim()); line = ""; };
  for (const token of text.match(/\n|[^\S\n]+|[^\s]+/gu) ?? []) {
    if (token === "\n") { flush(); continue; }
    if (!token.trim()) { if (line) line += " "; continue; }
    if (measure(line + token) <= width) { line += token; continue; }
    flush();
    if (measure(token) <= width) { line = token; continue; }
    // CJK and long unbroken words need grapheme boundaries, never UTF-16 slices.
    const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(token);
    for (const { segment } of graphemes) {
      if (line && measure(line + segment) > width) flush();
      line += segment;
    }
  }
  flush();
  const pages: string[] = [];
  const count = Math.max(1, Math.min(2, Math.floor(maxLines)));
  for (let index = 0; index < lines.length; index += count) pages.push(lines.slice(index, index + count).join("\n"));
  return pages;
}

/** Both languages advance together. Pages are spread across the original media
 * interval, including when translation arrives late or playback seeks backward.
 * This is reading-time allocation, not a claim of word-level alignment. */
export function subtitlePagePair(source: string[], translation: string[], progress: number): { source: string; translation: string } {
  const count = Math.max(source.length, translation.length, 1);
  const index = Math.min(count - 1, Math.floor(Math.max(0, Math.min(1, progress)) * count));
  const at = (pages: string[]) => pages[Math.min(pages.length - 1, Math.floor(index * pages.length / count))] ?? "";
  return { source: at(source), translation: at(translation) };
}
