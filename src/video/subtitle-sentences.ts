import type { SubtitleCue } from "./subtitles";

const MAX_SENTENCE_SECONDS = 12;
const MAX_SENTENCE_CHARS = 320;
const MAX_SENTENCE_CUES = 16;
const MAX_GAP_SECONDS = .75;

function endsSentence(text: string): boolean {
  const value = text.replace(/[\s"'”’»」』）)\]]+$/gu, "");
  if (/[!?。！？…]$/u.test(value)) return true;
  // A title or initial at a cue boundary need not end the spoken sentence.
  return /\.$/u.test(value) && !/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)|\b[A-Z]|\b(?:[A-Za-z]\.)+[A-Za-z])\.$/iu.test(value);
}

function separateSpeaker(text: string): boolean {
  return /^(?:[-–—]\s|>>|\[[^\]]+\]$|[（(][^()（）]+[)）]$)/u.test(text);
}

function joinCaption(previous: string, next: string): string {
  // Do not introduce word spaces into Chinese/Japanese, or before punctuation.
  const separator = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(previous)
    && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(next)
    || /^[,.;:!?，。；：！？、]/u.test(next) ? "" : " ";
  return previous + separator + next;
}

/** Keep a complete utterance and its translation on one shared time range.
 * Never split a translated sentence by character counts: word order can change.
 */
export function subtitleSentences(cues: readonly SubtitleCue[]): SubtitleCue[] {
  const output: SubtitleCue[] = [];
  let current: SubtitleCue | undefined;
  let count = 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  // Some authored tracks put several sentences in a single cue. Its timestamps
  // only bound the whole cue; distribute those sentences by reading length.
  const split = (cue: SubtitleCue): SubtitleCue[] => {
    const text = cue.text.replace(/\s+/gu, " ").trim();
    const parts = [...segmenter.segment(text)].map(part => part.segment.trim()).filter(Boolean);
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    let used = 0;
    return parts.map((text, index) => {
      const start = cue.start + (cue.end - cue.start) * used / total;
      used += text.length;
      return { start, end: index === parts.length - 1 ? cue.end : cue.start + (cue.end - cue.start) * used / total, text };
    });
  };
  for (const cue of cues.flatMap(split)) {
    const text = cue.text.replace(/\s+/gu, " ").trim();
    if (!text) continue;
    const joined = current ? joinCaption(current.text, text) : text;
    if (current && (endsSentence(current.text) || separateSpeaker(current.text) || separateSpeaker(text)
      || cue.start < current.end - .05 || cue.start - current.end > MAX_GAP_SECONDS
      || cue.end - current.start > MAX_SENTENCE_SECONDS || joined.length > MAX_SENTENCE_CHARS
      || count >= MAX_SENTENCE_CUES)) {
      output.push(current); current = undefined; count = 0;
    }
    if (current) { current.text = joined; current.end = cue.end; }
    else current = { start: cue.start, end: cue.end, text };
    count++;
  }
  if (current) output.push(current);
  return output;
}
