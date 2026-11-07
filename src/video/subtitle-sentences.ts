import type { SubtitleCue } from "./subtitles";
import { estimateSubtitleWords, subtitleWords } from "./subtitle-timing";

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
export function subtitleSentences(cues: readonly SubtitleCue[], withWordTimings = false): SubtitleCue[] {
  const output: SubtitleCue[] = [];
  let current: SubtitleCue | undefined;
  let count = 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  // Some authored tracks put several sentences in a single cue. Its timestamps
  // only bound the whole cue; distribute those sentences by reading length.
  const split = (cue: SubtitleCue): SubtitleCue[] => {
    const text = cue.text.replace(/\s+/gu, " ").trim();
    const words = withWordTimings ? subtitleWords(cue).map(word => ({ ...word,
      endOffset: cue.text.slice(0, word.endOffset).replace(/\s+/gu, " ").trim().length })) : [];
    const parts = [...segmenter.segment(text)].map(part => ({ text: part.segment.trim(),
      offset: part.index + part.segment.length - part.segment.trimStart().length })).filter(part => part.text);
    const total = parts.reduce((sum, part) => sum + part.text.length, 0);
    let used = 0;
    const result = parts.map(({ text, offset }, index) => {
      const start = cue.start + (cue.end - cue.start) * used / total;
      used += text.length;
      const end = index === parts.length - 1 ? cue.end : cue.start + (cue.end - cue.start) * used / total;
      const partWords = words.filter(word => word.endOffset > offset && word.endOffset <= offset + text.length)
        .map(word => ({ ...word, endOffset: word.endOffset - offset }));
      // A space-delimited token can span several unspaced sentences. Each
      // sentence must still have a visible source even without word alignment.
      return { start, end, text, ...(withWordTimings ? { words: partWords.length ? partWords : estimateSubtitleWords(text, start, end) } : {}) };
    });
    if (withWordTimings) for (let index = 1; index < result.length; index++) {
      const wordStart = result[index].words?.[0]?.start;
      const boundary = wordStart !== undefined && wordStart > result[index - 1].start && wordStart < cue.end ? wordStart : result[index].start;
      result[index].start = boundary; result[index - 1].end = boundary;
    }
    return result;
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
    if (current) {
      if (withWordTimings) current.words!.push(...(cue.words ?? []).map(word => ({ ...word, endOffset: joined.length - text.length + word.endOffset })));
      current.text = joined; current.end = cue.end;
    } else current = { start: cue.start, end: cue.end, text, ...(withWordTimings ? { words: [...(cue.words ?? [])] } : {}) };
    count++;
  }
  if (current) output.push(current);
  return output;
}
