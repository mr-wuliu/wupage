import { t } from "../shared/i18n";
import { ProviderError } from "../shared/errors";

const MAX_TEXT_LENGTH = 1_000_000;

export function doubaoServiceError(code: unknown): ProviderError {
  if (typeof code !== "number" && typeof code !== "string") return protocolError();
  switch (String(code)) {
    case "710012000":
    case "710012001":
    case "710022013":
      return new ProviderError(t("signInToDoubaoInThisBrowserThen"), "login-required");
    case "710012007":
    case "676010003":
      return new ProviderError(t("doubaoRateLimitReachedWaitBeforeRetryingManually"), "rate-limited", 60_000);
    case "710022002":
    case "710022004":
      return new ProviderError(t("doubaoRejectedTheRequestCheckTheDoubaoWebsite"), "service-rejected");
    default:
      return protocolError();
  }
}

function protocolError(): ProviderError {
  return new ProviderError(t("unsupportedDoubaoResponseFormatTryAgainLater"), "protocol-changed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Receives decoded UTF-8 text; the transport owns byte limits and timeouts. */
export class DoubaoSseParser {
  private readonly sources: string[];
  private readonly results: Array<string | undefined>;
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private received = 0;
  private started = false;
  private ended = false;

  constructor(sources: string[], private readonly targetLang: string) {
    this.sources = [...sources];
    this.results = Array<string | undefined>(sources.length).fill(undefined);
  }

  get done(): boolean {
    return this.ended;
  }

  push(text: string): void {
    if (this.ended || !text) return;
    if (!this.started) {
      this.started = true;
      if (text.startsWith("\uFEFF")) text = text.slice(1);
    }
    this.received += text.length;
    if (this.received > MAX_TEXT_LENGTH) throw protocolError();
    this.buffer += text;
    this.readLines(false);
  }

  /** Normal EOF may omit done. Missing slots are retried only by the caller. */
  finish(): Array<string | undefined> {
    if (!this.ended) {
      this.readLines(true);
      if (!this.ended && this.buffer) {
        const line = this.buffer;
        this.buffer = "";
        this.readLine(line);
      }
      if (!this.ended) this.dispatch();
      this.ended = true;
    }
    return [...this.results];
  }

  private readLines(final: boolean): void {
    while (!this.ended) {
      const boundary = this.buffer.search(/[\r\n]/u);
      if (boundary < 0) return;
      const character = this.buffer[boundary];
      if (character === "\r" && boundary + 1 === this.buffer.length && !final) return;
      const length = character === "\r" && this.buffer[boundary + 1] === "\n" ? 2 : 1;
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + length);
      this.readLine(line);
    }
    this.buffer = "";
  }

  private readLine(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const raw = separator < 0 ? "" : line.slice(separator + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
  }

  private dispatch(): void {
    const event = this.event;
    const data = this.data.join("\n");
    this.event = "";
    this.data = [];
    if (event === "done") {
      this.ended = true;
      return;
    }
    // Unknown events and comment-only heartbeats do not contain translations.
    if (event !== "json" && event !== "err") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw protocolError();
    }
    if (!isRecord(payload)) throw protocolError();
    if (event === "err" || payload.code !== 0) throw doubaoServiceError(payload.code);
    if (!isRecord(payload.data) || !Array.isArray(payload.data.items)) throw protocolError();
    for (const item of payload.data.items) {
      if (!isRecord(item) || !Number.isInteger(item.index) || typeof item.res !== "string"
        || (item.detect_lang !== undefined && typeof item.detect_lang !== "string")) throw protocolError();
      const index = item.index as number;
      if (index < 0 || index >= this.results.length) throw protocolError();
      // The service can omit a translation for text already in the target
      // language. This protocol fallback does not resolve the request's source
      // language or override a nonempty translation with server metadata.
      const translation = !item.res.trim() && item.detect_lang === this.targetLang ? this.sources[index] : item.res;
      if (!translation.trim()) throw protocolError();
      const previous = this.results[index];
      if (previous !== undefined && previous !== translation) throw protocolError();
      this.results[index] = translation;
    }
  }
}
