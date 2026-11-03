import { ProviderError } from "../shared/errors";
import type { TranslateBatchResponse } from "../shared/types";

export interface PdfQueuePage {
  pageNumber: number;
  items: Array<{ index: number; text: string }>;
  values: Array<string | undefined>;
}
export interface PdfQueuePageStatus {
  completed: number;
  total: number;
  running: boolean;
  pending: boolean;
  retrying: boolean;
  error?: unknown;
}
interface Job {
  page: PdfQueuePage;
  indexes: number[];
  attempt: number;
  readyAt: number;
  state: "pending" | "running" | "done" | "failed";
  error?: unknown;
}
interface Options {
  concurrency: number;
  maxChars: number;
  translate: (page: PdfQueuePage, indexes: number[], signal: AbortSignal) => Promise<TranslateBatchResponse>;
  restore: (page: PdfQueuePage, index: number, value: string) => string;
  onChange: (page: PdfQueuePage, status: PdfQueuePageStatus) => void;
  onIdle: () => void;
}

/** Small, resumable requests: the viewport owns priority, not an entire page. */
export class PdfTranslationQueue {
  private pages = new Map<number, PdfQueuePage>();
  private jobs: Job[] = [];
  private running = new Map<Job, AbortController>();
  private scope = new Set<number>();
  private readingPage = 1;
  private direction = 0;
  private stopped = false;
  private scrolling = false;
  private timer?: ReturnType<typeof setTimeout>;
  private limit: number;
  private successes = 0;
  private consecutiveFailures = 0;
  private failedWaitMs = 0;
  pauseError?: ProviderError;
  cached = 0;

  constructor(private options: Options) { this.limit = Math.max(1, options.concurrency); }

  get activePages(): number[] { return [...new Set([...this.running.keys()].map(job => job.page.pageNumber))]; }
  get activeCount(): number { return this.running.size; }
  get busy(): boolean { return !this.stopped && (this.running.size > 0 || (!this.pauseError && this.jobs.some(job => this.eligible(job)))); }

  setScope(pages: PdfQueuePage[], readingPage: number): void {
    this.scrolling = false;
    this.direction = Math.sign(readingPage - this.readingPage) || this.direction;
    this.readingPage = readingPage;
    this.scope = new Set(pages.map(page => page.pageNumber));
    for (const page of pages) {
      if (this.pages.has(page.pageNumber)) continue;
      this.pages.set(page.pageNumber, page);
      let indexes: number[] = [], length = 0;
      const flush = () => {
        if (indexes.length) this.jobs.push({ page, indexes, attempt: 0, readyAt: 0, state: "pending" });
        indexes = []; length = 0;
      };
      for (const item of page.items) {
        if (page.values[item.index] !== undefined) continue;
        if (indexes.length && (indexes.length >= 4 || length + item.text.length > this.options.maxChars)) flush();
        indexes.push(item.index); length += item.text.length;
      }
      flush();
    }
    // Cancel obsolete in-flight prefetch after a settled jump. Completed
    // paragraphs are already retained; only unfinished work returns to pending.
    for (const [job, controller] of this.running) if (!this.scope.has(job.page.pageNumber)) controller.abort();
    if (this.jobs.some(job => this.eligible(job) && job.page.pageNumber === readingPage)
      && ![...this.running.keys()].some(job => job.page.pageNumber === readingPage)
      && this.running.size >= this.limit) {
      const farthest = [...this.running.keys()].sort((a, b) => this.priority(b) - this.priority(a))[0];
      if (farthest) this.running.get(farthest)!.abort();
    }
    for (const page of pages) this.changed(page);
    this.pump();
  }

  cancel(): void {
    this.stopped = true; clearTimeout(this.timer);
    for (const controller of this.running.values()) controller.abort();
  }

  suspend(): void { this.scrolling = true; clearTimeout(this.timer); }

  retryPage(pageNumber: number): void {
    if (this.stopped || this.pauseError) return;
    const page = this.pages.get(pageNumber);
    if (!page) return;
    for (const job of this.jobs) if (job.page === page && job.state === "failed") {
      job.state = "pending"; job.attempt = 0; job.readyAt = 0; job.error = undefined;
    }
    this.changed(page); this.pump();
  }

  status(page: PdfQueuePage): PdfQueuePageStatus {
    const jobs = this.jobs.filter(job => job.page === page);
    return {
      completed: page.items.filter(item => page.values[item.index] !== undefined).length,
      total: page.items.length,
      running: jobs.some(job => job.state === "running"),
      pending: !this.pauseError && jobs.some(job => this.eligible(job)),
      retrying: jobs.some(job => job.state === "pending" && job.attempt > 0),
      error: jobs.find(job => job.state === "failed")?.error
    };
  }

  private eligible(job: Job): boolean { return job.state === "pending" && this.scope.has(job.page.pageNumber); }
  private priority(job: Job): number {
    const distance = Math.abs(job.page.pageNumber - this.readingPage);
    return distance + (this.direction && Math.sign(job.page.pageNumber - this.readingPage) !== this.direction ? 0.25 : 0);
  }
  private changed(page: PdfQueuePage): void { if (!this.stopped) this.options.onChange(page, this.status(page)); }

  private pump(): void {
    if (this.stopped || (this.scrolling && !this.pauseError)) return;
    clearTimeout(this.timer);
    if (!this.pauseError) {
      while (this.running.size < this.limit) {
        const next = this.jobs.filter(job => this.eligible(job) && job.readyAt <= Date.now())
          .sort((a, b) => this.priority(a) - this.priority(b) || a.attempt - b.attempt)[0];
        if (!next) break;
        const controller = new AbortController();
        next.state = "running"; this.running.set(next, controller);
        this.changed(next.page);
        void this.run(next, controller);
      }
      const waiting = this.jobs.filter(job => this.eligible(job) && job.readyAt > Date.now());
      if (waiting.length && this.running.size < this.limit) {
        this.timer = setTimeout(() => this.pump(), Math.max(1, Math.min(...waiting.map(job => job.readyAt)) - Date.now()));
      }
    }
    if (!this.busy) this.options.onIdle();
  }

  private async run(job: Job, controller: AbortController): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.options.translate(job.page, job.indexes, controller.signal);
      if (this.stopped) return;
      if (controller.signal.aborted) { job.state = "pending"; return; }
      this.cached += result.cached;
      this.consecutiveFailures = this.failedWaitMs = 0;
      for (const [position, index] of job.indexes.entries()) {
        try {
          const value = result.translations[position];
          if (!value?.trim()) throw new Error("翻译服务返回的译文不完整，请重试。");
          job.page.values[index] = this.options.restore(job.page, index, value);
        } catch (error) {
          // A malformed item cannot discard the other usable items in a batch.
          this.jobs.push({ ...job, indexes: [index], state: "failed", error });
        }
      }
      job.state = "done";
      if (++this.successes >= 4) { this.limit = Math.min(this.options.concurrency, this.limit + 1); this.successes = 0; }
    } catch (error) {
      if (this.stopped) return;
      if (controller.signal.aborted) { job.state = "pending"; return; }
      const transient = error instanceof ProviderError && ["service-unavailable", "network-error", "timeout"].includes(error.errorCode);
      if (transient) { this.consecutiveFailures++; this.failedWaitMs += Date.now() - startedAt; }
      if (transient && this.consecutiveFailures >= 3 && this.failedWaitMs >= 60_000) {
        job.state = "failed"; job.error = error;
        this.pauseError = new ProviderError("翻译服务多次中断，已暂停后续请求。请检查连接后重试；已完成译文已保留。", "service-unavailable");
        return;
      }
      if (transient && job.attempt === 0) {
        // Retry only this small failed group, one paragraph per request. A
        // transient failure also reduces pressure on the provider immediately.
        this.limit = 1; this.successes = 0; job.state = "done";
        for (const index of job.indexes) this.jobs.push({ ...job, indexes: [index], attempt: 1, state: "pending", readyAt: Date.now() + 1000 });
      } else {
        job.state = "failed"; job.error = error;
        if (error instanceof ProviderError && ["login-required", "service-rejected", "rate-limited", "permission-required",
          "unsupported-browser", "unsupported-language", "protocol-changed"].includes(error.errorCode)) this.pauseError ??= error;
      }
    } finally {
      this.running.delete(job);
      this.changed(job.page);
      this.pump();
    }
  }
}
