interface SourceRange { start: number; end: number }

/** Google's response includes the original text for each translated segment.
 * Use those spans to recover paragraphs without asking MT to preserve markers.
 */
export function googleContextSource(context: string, texts: string[]): { source: string; ranges: SourceRange[] } {
  const length = texts.reduce((sum, text) => sum + text.length, 0);
  const hint = length < 300 ? context.slice(0, 800) : context.split("\n", 1)[0].slice(0, 240);
  let source = hint.trim();
  const ranges = texts.map(text => {
    if (source) source += "\n\n";
    const start = source.length;
    source += text;
    return { start, end: source.length };
  });
  return { source, ranges };
}

export function alignGoogleContext(payload: unknown, source: string, ranges: SourceRange[]): Array<string | undefined> {
  const output = ranges.map(() => "");
  const covered = ranges.map(() => "");
  const invalid = new Set<number>();
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return ranges.map(() => undefined);
  let cursor = 0;
  for (const segment of payload[0]) {
    if (!Array.isArray(segment) || typeof segment[0] !== "string" || typeof segment[1] !== "string" || !segment[1]) {
      return ranges.map(() => undefined);
    }
    // Accept whitespace differences only at segment edges. Searching ahead for
    // repeated text would risk assigning a translation to the wrong paragraph.
    const original = segment[1].trim();
    while (/\s/u.test(source[cursor] ?? "") && cursor < source.length) cursor++;
    if (!original) continue;
    if (!source.startsWith(original, cursor)) return ranges.map(() => undefined);
    const start = cursor, end = cursor + original.length;
    cursor = end;
    const overlapping = ranges.flatMap((range, index) => start < range.end && end > range.start ? [index] : []);
    if (!overlapping.length) continue; // Reference context is never displayed.
    const index = overlapping[0], range = ranges[index];
    if (overlapping.length !== 1 || start < range.start || end > range.end) {
      overlapping.forEach(index => invalid.add(index));
      continue;
    }
    output[index] += segment[0];
    covered[index] += original;
  }
  const compact = (value: string) => value.replace(/\s+/gu, "");
  return output.map((value, index) => !invalid.has(index) && value.trim()
    && compact(covered[index]) === compact(source.slice(ranges[index].start, ranges[index].end)) ? value.trim() : undefined);
}
