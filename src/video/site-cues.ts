import { t } from "../shared/i18n";
import { subtitleText, type SubtitleCue, type SubtitleWord } from "./subtitles";
import { estimateSubtitleWords, subtitleWords } from "./subtitle-timing";

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

export function validSubtitleCues(value: unknown): SubtitleCue[] {
  if (!Array.isArray(value) || value.length > 20_000) throw new Error(t("subtitleDataExceedsTheSupportedLimit"));
  const cues: SubtitleCue[] = [];
  for (const item of value) {
    if (!record(item) || typeof item.start !== "number" || typeof item.end !== "number" || typeof item.text !== "string"
      || !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start || item.end > 864_000
      || item.text.length > 4000) continue;
    const text = subtitleText(item.text);
    let words: SubtitleWord[] | undefined;
    const end = item.end;
    if (text === item.text && Array.isArray(item.words) && item.words.length > 0 && item.words.length <= Math.min(4000, text.length)) {
      let time = item.start, offset = 0;
      if (item.words.every(word => {
        if (!record(word) || typeof word.start !== "number" || !Number.isFinite(word.start) || word.start < time || word.start >= end
          || typeof word.endOffset !== "number" || !Number.isInteger(word.endOffset) || word.endOffset <= offset || word.endOffset > text.length
          || /[\uDC00-\uDFFF]/u.test(text[word.endOffset] ?? "")) return false;
        time = word.start; offset = word.endOffset; return true;
      }) && offset === text.length) words = item.words.map(word => ({ start: word.start, endOffset: word.endOffset }));
    }
    if (text) cues.push({ start: item.start, end: item.end, text, ...(words ? { words } : {}) });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function youtubeCues(payload: unknown): SubtitleCue[] {
  if (!record(payload) || !Array.isArray(payload.events) || payload.events.length > 30_000) return [];
  const cues: SubtitleCue[] = [];
  for (const event of payload.events) {
    if (!record(event) || !Array.isArray(event.segs) || typeof event.tStartMs !== "number") continue;
    const text = subtitleText(event.segs.map(segment => record(segment) && typeof segment.utf8 === "string" ? segment.utf8 : "").join(""));
    if (!text) continue;
    const start = event.tStartMs / 1000;
    const duration = typeof event.dDurationMs === "number" ? event.dDurationMs / 1000 : 4;
    const end = start + Math.max(.01, duration);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || text.length > 4000 || event.segs.length > 4000) continue;
    const words: SubtitleWord[] = [];
    let raw = "", offset = 0, time = start;
    for (const segment of event.segs) {
      if (!record(segment) || typeof segment.utf8 !== "string") continue;
      if (typeof segment.tOffsetMs === "number" && Number.isFinite(segment.tOffsetMs) && segment.tOffsetMs >= 0) {
        const next = Math.min(end - .001, start + segment.tOffsetMs / 1000);
        if (next >= time) {
          const boundary = subtitleText(raw).length;
          words.push(...estimateSubtitleWords(text.slice(offset, boundary), time, next).map(word => ({ ...word, endOffset: word.endOffset + offset })));
          offset = boundary; time = next;
        }
      }
      raw += segment.utf8;
    }
    words.push(...estimateSubtitleWords(text.slice(offset), time, end).map(word => ({ ...word, endOffset: word.endOffset + offset })));
    const previous = cues.at(-1);
    if (event.aAppend === 1 && previous && start <= previous.end + .15) {
      const joined = `${previous.text}${/^[\p{P}\s]/u.test(text) ? "" : " "}${text}`;
      previous.words = [...subtitleWords(previous).map(word => ({ ...word, start: Math.min(start, word.start) })),
        ...words.map(word => ({ ...word, endOffset: joined.length - text.length + word.endOffset }))];
      previous.text = joined;
      previous.end = Math.max(previous.end, start + duration);
    } else {
      if (previous && previous.end > start && start > previous.start) {
        previous.end = start;
        previous.words = previous.words?.map(word => ({ ...word, start: Math.min(word.start, start - .001) }));
      }
      cues.push({ start, end, text, words });
    }
  }
  return validSubtitleCues(cues);
}

export function bilibiliCues(payload: unknown): SubtitleCue[] {
  if (!record(payload) || !Array.isArray(payload.body)) return [];
  return validSubtitleCues(payload.body.map(item => record(item) ? { start: item.from, end: item.to, text: item.content } : null));
}

export interface PageSubtitleTrack { id: string; label: string; language: string; automatic?: boolean }
export interface PageSubtitleCatalogue { key: string; tracks: PageSubtitleTrack[]; selected?: string }
export const VIDEO_BRIDGE_CHANNEL = "wupage-video-subtitles-v1";

export function parseCatalogue(value: unknown): PageSubtitleCatalogue | undefined {
  if (!record(value) || typeof value.key !== "string" || value.key.length > 2048 || !Array.isArray(value.tracks) || value.tracks.length > 200) return;
  const tracks = value.tracks.filter((track): track is unknown & PageSubtitleTrack => record(track)
    && typeof track.id === "string" && track.id.length <= 128 && typeof track.label === "string" && track.label.length <= 200
    && typeof track.language === "string" && track.language.length <= 32);
  return { key: value.key, tracks: tracks.map(track => track.label ? track : { ...track, label: t("subtitleTrackFallback") }), ...(typeof value.selected === "string" ? { selected: value.selected } : {}) };
}
