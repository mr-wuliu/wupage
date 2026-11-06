const SETTLE_MS = 250;
const ROLLING_MS = 900;
const CARRY_MS = 1500;
const EMPTY_MS = 180;

/** Recognize growing/rolling ASR windows without joining unrelated captions. */
function continues(previous: string, next: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const a = normalize(previous), b = normalize(next);
  if (!a || !b) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const words = a.split(" "), following = b.split(" ");
  for (let count = Math.min(words.length, following.length); count >= 2; count--) {
    const overlap = words.slice(-count).join(" ");
    if (overlap.length >= 10 && overlap === following.slice(0, count).join(" ")) return true;
  }
  // Unspaced captions also roll, notably Chinese/Japanese native subtitles.
  if (!a.includes(" ") && !b.includes(" ")) {
    for (let count = Math.min(a.length, b.length); count >= 4; count--) if (a.slice(-count) === b.slice(0, count)) return true;
  }
  return false;
}

function accumulatedCaption(previous: string, next: string): string {
  const words = (text: string) => [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  const a = words(previous), b = words(next);
  let joined = next;
  for (let count = Math.min(a.length, b.length); count >= 2; count--) {
    if (a.slice(-count).every((word, index) => word[0].toLowerCase() === b[index][0].toLowerCase())) {
      const end = b[count - 1].index! + b[count - 1][0].length;
      const previousEnd = a.at(-1)!.index! + a.at(-1)![0].length;
      joined = previous.slice(0, previousEnd) + next.slice(end);
      break;
    }
  }
  if (!previous.includes(" ") && !next.includes(" ")) {
    for (let count = Math.min(previous.length, next.length); count >= 4; count--) {
      if (previous.slice(-count) === next.slice(0, count)) { joined = previous + next.slice(count); break; }
    }
  }
  if (joined.length <= 320) return joined;
  const tail = joined.slice(-320);
  // Keep a bounded rolling utterance without cutting through a Latin word.
  return /\s/u.test(tail) ? tail.slice(tail.indexOf(" ") + 1) : tail;
}

/** Show matching completed snapshots while an ASR utterance continues to evolve. */
export class LiveSubtitleTranslator {
  private cache = new Map<string, string>();
  private text = "";
  private visibleText = "";
  private shown?: { source: string; translation: string };
  private carryUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private emptyTimer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private busy = false;
  private disposed = false;
  private stableAt = 0;
  private lastChanged = 0;
  private revision = 0;
  private carryMs = CARRY_MS;
  error = "";

  constructor(private translate: (texts: string[], signal?: AbortSignal) => Promise<string[]>, private changed: () => void) {}
  current(): { source: string; translation: string } {
    if (this.shown && (this.shown.source === this.text || Date.now() < this.carryUntil)) return this.shown;
    return { source: this.visibleText, translation: "" };
  }

  update(value: string): void {
    value = value.replace(/\s+/gu, " ").trim();
    if (this.disposed) return;
    this.visibleText = value;
    if (value === this.text) return;
    const previous = this.text, now = Date.now();
    // A rendered ASR window can drop its first words before translation returns.
    // Retain verified overlap so later requests still contain the whole thought.
    if (value && previous && continues(previous, value)) value = accumulatedCaption(previous, value);
    if (value === previous) return;
    this.text = value; this.lastChanged = now;
    clearTimeout(this.timer); clearTimeout(this.emptyTimer);
    if (!value) {
      // Caption nodes are briefly empty while YouTube replaces visual lines.
      this.carryUntil = Math.min(this.carryUntil || now + EMPTY_MS, now + EMPTY_MS);
      this.emptyTimer = setTimeout(() => { if (!this.text) this.reset(); }, EMPTY_MS);
    } else {
      const continuation = continues(previous || this.shown?.source || "", value);
      if (!continuation) { this.revision++; this.shown = undefined; this.carryUntil = 0; this.stableAt = now; this.controller?.abort(); }
      const cached = this.cache.get(value);
      if (cached) { this.shown = { source: value, translation: cached }; this.carryUntil = 0; }
      else if (this.shown && continuation) {
        if (!previous || !this.carryUntil) this.carryUntil = now + this.carryMs;
      } else { this.shown = undefined; this.carryUntil = 0; }
      this.schedule();
    }
    this.changed();
  }

  reset(): void {
    this.controller?.abort(); clearTimeout(this.timer); clearTimeout(this.emptyTimer);
    this.revision++; this.text = ""; this.visibleText = ""; this.shown = undefined; this.carryUntil = 0; this.stableAt = 0; this.changed();
  }
  retry(): void { this.error = ""; void this.pump(); }
  dispose(): void {
    this.disposed = true; this.controller?.abort(); clearTimeout(this.timer); clearTimeout(this.emptyTimer);
    this.shown = undefined; this.cache.clear();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.disposed || this.error || !this.text || this.cache.has(this.text)) return;
    const now = Date.now();
    const delay = Math.max(0, Math.min(SETTLE_MS - (now - this.lastChanged), ROLLING_MS - (now - this.stableAt)));
    this.timer = setTimeout(() => { void this.pump(); }, delay);
  }

  private async pump(): Promise<void> {
    if (this.disposed || this.busy || this.error || !this.text || this.cache.has(this.text)) return;
    const text = this.text, started = Date.now(), revision = this.revision;
    this.busy = true; this.stableAt = started;
    const controller = new AbortController(); this.controller = controller;
    try {
      const result = await this.translate([text], controller.signal);
      if (this.disposed || controller.signal.aborted) return;
      if (result.length !== 1 || !result[0]?.trim()) throw new Error("翻译结果不完整，请重试。");
      this.cache.delete(text); this.cache.set(text, result[0]);
      if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
      this.carryMs = Math.min(2500, Math.max(CARRY_MS, Date.now() - started + 300));
      if (this.text === text) { this.shown = { source: text, translation: result[0] }; this.carryUntil = 0; }
      else if (this.text && revision === this.revision && Date.now() - started < 5000) {
        this.shown = { source: text, translation: result[0] };
        this.carryUntil = Date.now() + this.carryMs;
      }
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      if (!this.disposed) { this.changed(); this.schedule(); }
    }
  }
}
