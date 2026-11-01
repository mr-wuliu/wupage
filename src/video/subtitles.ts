import { subtitleSentences } from "./subtitle-sentences";

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

const MAX_CUES = 20_000;
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
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) throw new Error("字幕时间格式无效。");
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
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
    if (!match) throw new Error("字幕时间格式无效。");
    const start = timestamp(match[1]);
    const end = timestamp(match[2]);
    const text = subtitleText(lines.slice(index + 1).join("\n"));
    if (end <= start) throw new Error("字幕结束时间必须晚于开始时间。");
    if (text.length > 4000) throw new Error("单条字幕过长，请拆分后重新导入。");
    if (text) cues.push({ start, end, text });
    if (cues.length > MAX_CUES) throw new Error("字幕条数超过 20,000 条，请拆分文件。");
  }
  if (!cues.length) throw new Error("没有找到可用字幕，请选择 UTF-8 编码的 SRT 或 VTT 文件。");
  return cues.sort((a, b) => a.start - b.start);
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
    private readonly translate: (texts: string[], signal?: AbortSignal) => Promise<string[]>,
    private readonly changed: () => void
  ) {}

  update(time: number): void {
    if (this.disposed) return;
    if (Math.abs(time - this.time) > 2) this.controller?.abort();
    this.time = time;
    this.changed();
    void this.pump();
  }

  current(): { source: string; translation: string } {
    const active = this.readSentences().filter(cue => cue.start <= this.time && cue.end > this.time).slice(0, 8);
    const texts = [...new Set(active.map(cue => cue.text))];
    return { source: texts.join("\n"), translation: texts.every(text => this.cache.has(text)) ? texts.map(text => this.cache.get(text)!).join("\n") : "" };
  }

  retry(): void { this.error = ""; this.update(this.time); }
  dispose(): void { this.disposed = true; this.controller?.abort(); this.cache.clear(); }

  private readSentences(): SubtitleCue[] {
    const cues = this.readCues();
    if (cues !== this.sourceCues || cues.length !== this.sourceLength) {
      this.sourceCues = cues; this.sourceLength = cues.length;
      this.sentences = subtitleSentences(cues);
    }
    return this.sentences;
  }

  private async pump(): Promise<void> {
    if (this.disposed || this.busy || this.error) return;
    const cues = this.readSentences();
    const active = cues.filter(cue => cue.start <= this.time && cue.end > this.time);
    const future = cues.filter(cue => cue.start > this.time && cue.start <= this.time + 15);
    const texts: string[] = [];
    let size = 0;
    for (const cue of [...active, ...future].slice(0, 128)) {
      if (this.cache.has(cue.text) || texts.includes(cue.text)) continue;
      if (texts.length && (size + cue.text.length > 3000 || texts.length >= 8)) break;
      texts.push(cue.text); size += cue.text.length;
    }
    if (!texts.length) return;
    this.busy = true;
    const controller = new AbortController(); this.controller = controller;
    try {
      const result = await this.translate(texts, controller.signal);
      if (this.disposed || controller.signal.aborted) return;
      if (result.length !== texts.length || result.some(text => typeof text !== "string" || !text.trim())) {
        throw new Error("翻译服务返回的字幕不完整，请重试。");
      }
      texts.forEach((text, index) => { this.cache.delete(text); this.cache.set(text, result[index]); });
      while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
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
