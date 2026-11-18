import { t } from "../shared/i18n";
import { ProviderError } from "../shared/errors";
import type { TranslateBatchResponse } from "../shared/types";

export interface PdfQueuePage {
  pageNumber: number;
  items: Array<{ index: number; text: string; targetPages?: number[] }>;
  incoming?: Array<{ pageNumber: number; index: number }>;
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
  targetPages?: number[];
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
  private jobsByPage = new Map<number, Set<Job>>();
  private pending = new Set<Job>();
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

  get activePages(): number[] { return [...new Set([...this.running.keys()].flatMap(job => job.targetPages ?? [job.page.pageNumber]))]; }
  get activeCount(): number { return this.running.size; }
  get busy(): boolean { return !this.stopped && (this.running.size > 0 || (!this.pauseError && this.pending.size > 0)); }

  setScope(pages: PdfQueuePage[], readingPage: number, dependencies: PdfQueuePage[] = []): void {
    this.scrolling = false;
    this.direction = Math.sign(readingPage - this.readingPage) || this.direction;
    this.readingPage = readingPage;
    this.scope = new Set(pages.map(page => page.pageNumber));
    for (const page of [...pages, ...dependencies]) {
      if (this.pages.has(page.pageNumber)) continue;
      this.pages.set(page.pageNumber, page);
      let indexes: number[] = [], length = 0;
      const flush = () => {
        if (indexes.length) this.addJob({ page, indexes, attempt: 0, readyAt: 0, state: "pending" });
        indexes = []; length = 0;
      };
      for (const item of page.items) {
        if (page.values[item.index] !== undefined) continue;
        if (item.targetPages && item.targetPages.length > 1) {
          flush();
          this.addJob({ page, indexes: [item.index], targetPages: item.targetPages, attempt: 0, readyAt: 0, state: "pending" });
          continue;
        }
        if (indexes.length && (indexes.length >= 4 || length + item.text.length > this.options.maxChars)) flush();
        indexes.push(item.index); length += item.text.length;
      }
      flush();
    }
    this.pending.clear();
    for (const number of this.scope) for (const job of this.jobsByPage.get(number) ?? []) {
      if (job.state === "pending") this.pending.add(job);
    }
    // Cancel obsolete in-flight prefetch after a settled jump. Completed
    // paragraphs are already retained; only unfinished work returns to pending.
    for (const [job, controller] of this.running) if (!this.inScope(job)) controller.abort();
    if ([...this.jobsByPage.get(readingPage) ?? []].some(job => this.pending.has(job))
      && ![...this.running.keys()].some(job => this.touchesPage(job, readingPage))
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
    if (!this.pages.has(pageNumber)) return;
    for (const job of this.jobsByPage.get(pageNumber) ?? []) if (job.state === "failed") {
      job.attempt = 0; job.readyAt = 0; job.error = undefined;
      this.requeue(job);
      this.changedJob(job);
    }
    this.pump();
  }

  status(page: PdfQueuePage): PdfQueuePageStatus {
    const jobs = [...this.jobsByPage.get(page.pageNumber) ?? []];
    const incoming = page.incoming ?? [];
    return {
      completed: page.items.filter(item => page.values[item.index] !== undefined).length
        + incoming.filter(item => this.pages.get(item.pageNumber)?.values[item.index] !== undefined).length,
      total: page.items.length + incoming.length,
      running: jobs.some(job => job.state === "running"),
      pending: !this.pauseError && jobs.some(job => this.pending.has(job)),
      retrying: jobs.some(job => job.state === "pending" && job.attempt > 0),
      error: jobs.find(job => job.state === "failed")?.error
    };
  }

  private touchesPage(job: Job, pageNumber: number): boolean { return (job.targetPages ?? [job.page.pageNumber]).includes(pageNumber); }
  private inScope(job: Job): boolean { return (job.targetPages ?? [job.page.pageNumber]).some(page => this.scope.has(page)); }

  private addJob(job: Job): void {
    for (const number of job.targetPages ?? [job.page.pageNumber]) {
      let jobs = this.jobsByPage.get(number);
      if (!jobs) { jobs = new Set(); this.jobsByPage.set(number, jobs); }
      jobs.add(job);
    }
    if (job.state === "pending") this.requeue(job);
  }

  private requeue(job: Job): void {
    job.state = "pending";
    if (this.inScope(job)) this.pending.add(job);
  }

  private complete(job: Job): void {
    job.state = "done";
    for (const number of job.targetPages ?? [job.page.pageNumber]) this.jobsByPage.get(number)?.delete(job);
  }

  private priority(job: Job): number {
    let priority = Infinity;
    for (const page of job.targetPages ?? [job.page.pageNumber]) {
      const distance = page - this.readingPage;
      priority = Math.min(priority, Math.abs(distance) + (this.direction && Math.sign(distance) !== this.direction ? 0.25 : 0));
    }
    return priority;
  }
  private changed(page: PdfQueuePage): void { if (!this.stopped) this.options.onChange(page, this.status(page)); }
  private changedJob(job: Job): void {
    for (const number of job.targetPages ?? [job.page.pageNumber]) {
      const page = this.pages.get(number);
      if (page) this.changed(page);
    }
  }

  private pump(): void {
    if (this.stopped || (this.scrolling && !this.pauseError)) return;
    clearTimeout(this.timer);
    if (!this.pauseError) {
      while (this.running.size < this.limit) {
        let next: Job | undefined;
        let nextPriority = Infinity, wakeAt = Infinity;
        const now = Date.now();
        for (const job of this.pending) {
          if (job.readyAt > now) { wakeAt = Math.min(wakeAt, job.readyAt); continue; }
          const priority = this.priority(job);
          if (!next || priority < nextPriority || (priority === nextPriority && job.attempt < next.attempt)) {
            next = job; nextPriority = priority;
          }
        }
        if (!next) {
          if (Number.isFinite(wakeAt)) this.timer = setTimeout(() => this.pump(), Math.max(1, wakeAt - Date.now()));
          break;
        }
        const controller = new AbortController();
        this.pending.delete(next);
        next.state = "running"; this.running.set(next, controller);
        this.changedJob(next);
        void this.run(next, controller);
      }
    }
    if (!this.busy) this.options.onIdle();
  }

  private async run(job: Job, controller: AbortController): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.options.translate(job.page, job.indexes, controller.signal);
      if (this.stopped) return;
      if (controller.signal.aborted) { this.requeue(job); return; }
      this.cached += result.cached;
      this.consecutiveFailures = this.failedWaitMs = 0;
      for (const [position, index] of job.indexes.entries()) {
        try {
          const value = result.translations[position];
          if (!value?.trim()) throw new Error(t("theServiceReturnedAnIncompleteTranslationTryAgain"));
          job.page.values[index] = this.options.restore(job.page, index, value);
        } catch (error) {
          // A malformed item cannot discard the other usable items in a batch.
          this.addJob({ ...job, indexes: [index], state: "failed", error });
        }
      }
      this.complete(job);
      if (++this.successes >= 4) { this.limit = Math.min(this.options.concurrency, this.limit + 1); this.successes = 0; }
    } catch (error) {
      if (this.stopped) return;
      if (controller.signal.aborted) { this.requeue(job); return; }
      const transient = error instanceof ProviderError && ["service-unavailable", "network-error", "timeout"].includes(error.errorCode);
      if (transient) { this.consecutiveFailures++; this.failedWaitMs += Date.now() - startedAt; }
      if (transient && this.consecutiveFailures >= 3 && this.failedWaitMs >= 60_000) {
        job.state = "failed"; job.error = error;
        this.pauseError = new ProviderError(t("translationWasInterruptedRepeatedlyFurtherRequestsArePaused"), "service-unavailable");
        return;
      }
      if (transient && job.attempt === 0) {
        // Retry only this small failed group, one paragraph per request. A
        // transient failure also reduces pressure on the provider immediately.
        this.limit = 1; this.successes = 0; this.complete(job);
        for (const index of job.indexes) this.addJob({ ...job, indexes: [index], attempt: 1, state: "pending", readyAt: Date.now() + 1000 });
      } else {
        job.state = "failed"; job.error = error;
        if (error instanceof ProviderError && ["login-required", "service-rejected", "rate-limited", "permission-required",
          "unsupported-browser", "unsupported-language", "protocol-changed"].includes(error.errorCode)) this.pauseError ??= error;
      }
    } finally {
      this.running.delete(job);
      this.changedJob(job);
      this.pump();
    }
  }
}
