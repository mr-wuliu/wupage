import { t } from "../shared/i18n";
import { subtitleSentences } from "./subtitle-sentences";
import { estimateSubtitleWords, revealedSubtitle } from "./subtitle-timing";

export interface SubtitleWord {
  start: number;
  /** Exclusive UTF-16 offset in the cue's plain text. */
  endOffset: number;
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
  words?: SubtitleWord[];
}

export const MAX_SUBTITLE_CUES = 20_000;
export const MAX_SUBTITLE_FILE_BYTES = 2 * 1024 * 1024;

export function subtitleText(value: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", nbsp: " ", quot: '"', apos: "'" };
  return value.replace(/<[^>]*>/gu, "").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|nbsp|quot|apos);/giu, (entity, name: string) => {
    if (!name.startsWith("#")) return entities[name.toLowerCase()] ?? entity;
    const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  }).replace(/\r/gu, "").trim();
}

function timestamp(value: string): number {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/u.exec(value);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) throw new Error(t("invalidSubtitleTimeFormat"));
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

/** Preserve WebVTT karaoke timestamps before removing cue markup. */
export function subtitleCue(start: number, end: number, raw: string): SubtitleCue {
  const text = subtitleText(raw);
  const marks = [...raw.matchAll(/<((?:\d+:)?\d{2}:\d{2}\.\d{3})>/gu)];
  if (!marks.length) return { start, end, text };
  const words: SubtitleWord[] = [];
  let offset = 0, time = start;
  for (const mark of marks) {
    let next: number;
    try { next = timestamp(mark[1]); } catch { continue; }
    if (next < time || next >= end) continue;
    const boundary = subtitleText(raw.slice(0, mark.index)).length;
    words.push(...estimateSubtitleWords(text.slice(offset, boundary), time, next)
      .map(word => ({ ...word, endOffset: word.endOffset + offset })));
    offset = boundary; time = next;
  }
  words.push(...estimateSubtitleWords(text.slice(offset), time, end).map(word => ({ ...word, endOffset: word.endOffset + offset })));
  return { start, end, text, words };
}

export function nativeSubtitleCues(list: TextTrackCueList | null): SubtitleCue[] {
  return list ? Array.from(list).slice(0, MAX_SUBTITLE_CUES).map(cue => subtitleCue(cue.startTime, cue.endTime,
    "text" in cue ? String(cue.text) : "")).filter(cue => cue.text && cue.text.length <= 4000) : [];
}

export async function waitForNativeSubtitleTrack(element: HTMLTrackElement, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (element.readyState === element.LOADED) return;
  if (element.readyState === element.ERROR) throw new Error(t("fullSubtitleTrackUnavailable"));
  await new Promise<void>((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error(t("fullSubtitleTrackUnavailable"))); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(failed, 8000);
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener("load", done);
      element.removeEventListener("error", failed);
      signal.removeEventListener("abort", abort);
    };
    element.addEventListener("load", done);
    element.addEventListener("error", failed);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Read SRT and WebVTT, including cue identifiers and WebVTT cue settings. */
export function parseSubtitles(source: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split(/\n[\t ]*\n/gu)) {
    const lines = block.trim().split("\n");
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/u.test(lines[0])) continue;
    const index = lines.findIndex(line => line.includes("-->"));
    if (index < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s.*)?$/u.exec(lines[index].trim());
    if (!match) throw new Error(t("invalidSubtitleTimeFormat"));
    const start = timestamp(match[1]);
    const end = timestamp(match[2]);
    const cue = subtitleCue(start, end, lines.slice(index + 1).join("\n"));
    const { text } = cue;
    if (end <= start) throw new Error(t("subtitleEndTimeMustBeLaterThanStart"));
    if (text.length > 4000) throw new Error(t("aSubtitleCueIsTooLongSplitIt"));
    if (text) cues.push(cue);
    if (cues.length > MAX_SUBTITLE_CUES) throw new Error(t("moreThan20000SubtitleCuesSplitThe"));
  }
  if (!cues.length) throw new Error(t("noUsableSubtitlesFoundChooseAUtf8"));
  return cues.sort((a, b) => a.start - b.start);
}

function srtTimestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const time = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
  return `${time},${String(milliseconds % 1000).padStart(3, "0")}`;
}

export function serializeSrt(cues: readonly SubtitleCue[], offset = 0): string {
  const blocks: string[] = [];
  for (const cue of [...cues].sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, Math.round((cue.start + offset) * 1000));
    const end = Math.round((cue.end + offset) * 1000);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || cue.end <= cue.start || cue.end + offset <= 0) continue;
    const text = cue.text.replace(/\r\n?/gu, "\n").split("\n").filter(line => line.trim()).join("\n").trim()
      .replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
    if (text) blocks.push(`${blocks.length + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(Math.max(start + 1, end))}\n${text}\n`);
  }
  return blocks.join("\n");
}

const MAX_BATCH_CUES = 8;
const MAX_BATCH_CHARS = 3000;
type TranslateSubtitles = (texts: string[], signal?: AbortSignal) => Promise<string[]>;

function storeTranslations(cache: Map<string, string>, texts: string[], result: string[]): void {
  if (result.length !== texts.length || texts.some((_, index) => typeof result[index] !== "string" || !result[index].trim())) {
    throw new Error(t("theServiceReturnedIncompleteSubtitlesTryAgain"));
  }
  texts.forEach((text, index) => cache.set(text, result[index]));
}

export async function translateSubtitleTrack(
  cues: readonly SubtitleCue[], translate: TranslateSubtitles, signal: AbortSignal,
  progress: (done: number, total: number) => void, cached?: (text: string) => string | undefined
): Promise<SubtitleCue[]> {
  const sentences = subtitleSentences(cues, true);
  const texts = [...new Set(sentences.map(cue => cue.text))];
  const translations = new Map<string, string>();
  const pending: string[] = [];
  for (const text of texts) {
    const existing = cached?.(text);
    if (existing) translations.set(text, existing);
    else pending.push(text);
  }
  progress(translations.size, texts.length);
  for (let index = 0; index < pending.length;) {
    const batch: string[] = [];
    let size = 0;
    while (index < pending.length && batch.length < MAX_BATCH_CUES) {
      const text = pending[index];
      if (batch.length && size + text.length > MAX_BATCH_CHARS) break;
      batch.push(text); size += text.length; index++;
    }
    signal.throwIfAborted();
    const result = await translate(batch, signal);
    signal.throwIfAborted();
    storeTranslations(translations, batch, result);
    progress(translations.size, texts.length);
  }
  return sentences.map(({ start, end, text }) => ({ start, end, text: translations.get(text)! }));
}

/** The scheduler is independent of playback events, so late responses never select a stale cue. */
export class SubtitleTranslator {
  private readonly cache = new Map<string, string>();
  private sourceCues?: SubtitleCue[];
  private sourceLength = -1;
  private sentences: SubtitleCue[] = [];
  private time = 0;
  private busy = false;
  private disposed = false;
  private controller?: AbortController;
  error = "";

  constructor(
    private readonly readCues: () => SubtitleCue[],
    private readonly translate: TranslateSubtitles,
    private readonly changed: () => void
  ) {}

  update(time: number): void {
    if (this.disposed) return;
    if (Math.abs(time - this.time) > 2) this.controller?.abort();
    this.time = time;
    this.changed();
    void this.pump();
  }

  current(progressive = false): { source: string; translation: string } {
    const active = this.readSentences().filter(cue => cue.start <= this.time && cue.end > this.time).slice(0, 8);
    const texts = [...new Set(active.map(cue => cue.text))];
    return { source: progressive ? [...new Set(active.map(cue => revealedSubtitle(cue, this.time)))].filter(Boolean).join("\n") : texts.join("\n"),
      translation: texts.every(text => this.cache.has(text)) ? texts.map(text => this.cache.get(text)!).join("\n") : "" };
  }

  /** Media time, not request completion time, controls long-caption paging. */
  progress(): number {
    const active = this.readSentences().filter(cue => cue.start <= this.time && cue.end > this.time).slice(0, 8);
    if (!active.length) return 0;
    const start = Math.min(...active.map(cue => cue.start)), end = Math.max(...active.map(cue => cue.end));
    return Math.max(0, Math.min(1, (this.time - start) / (end - start)));
  }

  cachedTranslation(text: string): string | undefined { return this.cache.get(text); }

  retry(): void { this.error = ""; this.update(this.time); }
  dispose(): void { this.disposed = true; this.controller?.abort(); this.cache.clear(); }

  private readSentences(): SubtitleCue[] {
    const cues = this.readCues();
    if (cues !== this.sourceCues || cues.length !== this.sourceLength) {
      this.sourceCues = cues; this.sourceLength = cues.length;
      this.sentences = subtitleSentences(cues, true);
      // Keep completed translations for the whole current track, including
      // cues that already left the playback window.
      if (this.cache.size) {
        const texts = new Set(this.sentences.map(cue => cue.text));
        for (const text of this.cache.keys()) if (!texts.has(text)) this.cache.delete(text);
      }
    }
    return this.sentences;
  }

  private async pump(): Promise<void> {
    if (this.disposed || this.busy || this.error) return;
    const cues = this.readSentences();
    const active = cues.filter(cue => cue.start <= this.time && cue.end > this.time);
    const future = cues.filter(cue => cue.start > this.time && cue.start <= this.time + 45);
    const texts: string[] = [];
    let size = 0;
    for (const cue of [...active, ...future].slice(0, 128)) {
      if (this.cache.has(cue.text) || texts.includes(cue.text)) continue;
      if (texts.length && (size + cue.text.length > MAX_BATCH_CHARS || texts.length >= MAX_BATCH_CUES)) break;
      texts.push(cue.text); size += cue.text.length;
    }
    if (!texts.length) return;
    this.busy = true;
    const controller = new AbortController(); this.controller = controller;
    try {
      const result = await this.translate(texts, controller.signal);
      if (this.disposed || controller.signal.aborted) return;
      storeTranslations(this.cache, texts, result);
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      if (!this.disposed) {
        this.changed();
        // A seek may have changed the desired window while this request was pending.
        if (!this.error) void this.pump();
      }
    }
  }
}
