import type { SubtitleCue, SubtitleWord } from "./subtitles";

/** Sentence-only tracks have no word alignment. Distribute whole words across
 * their own cue interval; supplied word timestamps always take precedence. */
export function estimateSubtitleWords(text: string, start: number, end: number): SubtitleWord[] {
  const words = [...text.matchAll(/\S+/gu)];
  return words.map((word, index) => ({ start: start + (end - start) * index / words.length,
    endOffset: word.index + word[0].length }));
}

export function subtitleWords(cue: SubtitleCue): SubtitleWord[] {
  return cue.words ?? estimateSubtitleWords(cue.text, cue.start, cue.end);
}

/** Always derive visible text from media time, including pause, seek and replay. */
export function revealedSubtitle(cue: SubtitleCue, time: number): string {
  let end = 0;
  for (const word of subtitleWords(cue)) {
    if (word.start > time) break;
    end = word.endOffset;
  }
  return cue.text.slice(0, end).trimEnd();
}
