import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSubtitleTranslator } from "../src/video/live-subtitles";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("rendered subtitle scheduling", () => {
  it("retains the beginning of an utterance when the visible ASR window rolls forward", async () => {
    const translate = vi.fn(async (texts: string[]) => texts.map(text => `译:${text}`));
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    session.update("This tool can save you"); await vi.advanceTimersByTimeAsync(150);
    session.update("can save you a lot of time."); await vi.advanceTimersByTimeAsync(320);
    expect(translate.mock.calls.map(call => call[0])).toEqual([["This tool can save you a lot of time."]]);
    expect(session.current().source).toBe("This tool can save you a lot of time.");
    session.update("A different speaker starts."); await vi.advanceTimersByTimeAsync(320);
    expect(session.current().source).toBe("A different speaker starts.");
    session.dispose();
  });
  it("bounds accumulated unpunctuated live speech", async () => {
    const translate = vi.fn(async (texts: string[]) => texts.map(text => `译:${text}`));
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    for (let index = 0; index < 80; index++) {
      session.update(Array.from({ length: 8 }, (_, word) => `word${index + word}`).join(" "));
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(320);
    expect(translate.mock.calls.length).toBeGreaterThan(0);
    expect(translate.mock.calls.every(([texts]) => texts[0].length <= 320 && /^word\d/u.test(texts[0]))).toBe(true);
    session.dispose();
  });
  it("does not duplicate punctuation where rolling windows overlap", async () => {
    const translate = vi.fn(async (texts: string[]) => texts.map(text => `译:${text}`));
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    session.update("We saved a lot of time."); await vi.advanceTimersByTimeAsync(150);
    session.update("a lot of time. Try this."); await vi.advanceTimersByTimeAsync(320);
    expect(translate.mock.calls.map(call => call[0])).toEqual([["We saved a lot of time. Try this."]]);
    session.dispose();
  });
  it("shows translated snapshots while slow ASR captions keep growing, wrapping and rolling", async () => {
    const translate = vi.fn(async (texts: string[]) => {
      await new Promise(resolve => setTimeout(resolve, 700)); return texts.map(text => `译:${text}`);
    });
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    const rolling = ["that auto generates", "that auto generates this", "that auto generates\nthis new",
      "that auto generates this new\nsupport", "this new support structure", "this new support structure that",
      "this new support structure\nthat saves", "support structure that saves time", "support structure that saves time when",
      "structure that saves time when 3D", "structure that saves time when 3D printing"];
    let translatedWhileRolling = 0;
    for (const text of rolling) {
      session.update(text); await vi.advanceTimersByTimeAsync(180);
      if (session.current().translation) translatedWhileRolling++;
    }
    expect(translatedWhileRolling).toBeGreaterThan(0);
    session.dispose();
  });
  it("treats visual line wrapping as the same text and keeps its translation", async () => {
    const translate = vi.fn(async (texts: string[]) => texts.map(text => `译:${text}`));
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    session.update("Hello brave\nnew world"); await vi.advanceTimersByTimeAsync(320);
    session.update("Hello brave new\nworld");
    expect(session.current()).toEqual({ source: "Hello brave new world", translation: "译:Hello brave new world" });
    expect(translate).toHaveBeenCalledTimes(1); session.dispose();
  });
  it("keeps a coherent translated snapshot with 2.2-second replies during continuous rolling", async () => {
    const translate = vi.fn(async (texts: string[]) => {
      await new Promise(resolve => setTimeout(resolve, 2200)); return texts.map(text => `译:${text}`);
    });
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    let visible = false, missingAfterFirst = 0;
    for (let index = 0; index < 55; index++) {
      session.update(Array.from({ length: 8 }, (_, word) => `word${index + word}`).join(' '));
      await vi.advanceTimersByTimeAsync(100);
      if (session.current().translation) visible = true;
      else if (visible) missingAfterFirst++;
    }
    expect(visible).toBe(true); expect(missingAfterFirst).toBe(0);
    session.update('A completely unrelated sentence.'); expect(session.current().translation).toBe(''); session.dispose();
  });
  it("debounces rolling source text, and removes stale translations immediately", async () => {
    const translate = vi.fn(async (texts: string[]) => texts.map(text => `译:${text}`));
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    session.update("Hello"); await vi.advanceTimersByTimeAsync(150); session.update("Hello world");
    await vi.advanceTimersByTimeAsync(320);
    expect(translate.mock.calls.map(call => call[0])).toEqual([["Hello world"]]);
    expect(session.current().translation).toBe("译:Hello world");
    session.update("Later"); expect(session.current().translation).toBe("");
    session.dispose();
  });
  it("cancels an obsolete caption, ignores its late result and reuses completed text", async () => {
    let finish!: (texts: string[]) => void;
    const translate = vi.fn().mockImplementationOnce(() => new Promise<string[]>(resolve => { finish = resolve; }))
      .mockImplementation(async (texts: string[]) => texts.map(text => text === "Hello" ? "你好" : "稍后"));
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    session.update("Hello"); await vi.advanceTimersByTimeAsync(320); session.update("Later");
    finish(["你好"]); await vi.advanceTimersByTimeAsync(320);
    expect(session.current()).toEqual({ source: "Later", translation: "稍后" });
    expect(translate.mock.calls[0][1].aborted).toBe(true);
    session.update("Hello"); expect(session.current().translation).toBe("");
    await vi.advanceTimersByTimeAsync(320); expect(session.current().translation).toBe("你好");
    session.update("Later"); expect(session.current().translation).toBe("稍后");
    expect(translate).toHaveBeenCalledTimes(3); session.dispose();
  });
  it("bridges a brief empty DOM replacement but clears a real subtitle gap", async () => {
    const translate = vi.fn(async () => ["你好"]);
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    session.update("Hello"); await vi.advanceTimersByTimeAsync(320);
    session.update(""); await vi.advanceTimersByTimeAsync(120); expect(session.current().translation).toBe("你好");
    session.update("Hello"); expect(session.current().translation).toBe("你好");
    expect(translate).toHaveBeenCalledTimes(1);
    session.update(""); await vi.advanceTimersByTimeAsync(200);
    expect(session.current()).toEqual({ source: "", translation: "" }); session.dispose();
  });
  it("bounds how long a translated snapshot can remain during continued updates", async () => {
    const translate = vi.fn().mockResolvedValueOnce(["你好，世界"]).mockImplementation(() => new Promise(() => {}));
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    session.update("Hello world"); await vi.advanceTimersByTimeAsync(320);
    session.update("Hello world again");
    expect(session.current()).toEqual({ source: "Hello world", translation: "你好，世界" });
    await vi.advanceTimersByTimeAsync(1501); expect(session.current().translation).toBe("");
    session.reset(); expect(session.current()).toEqual({ source: "", translation: "" }); session.dispose();
  });
  it("cancels in-flight work on empty cues and retries the same source after a seek", async () => {
    const translate = vi.fn().mockImplementationOnce((_texts: string[], signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
    })).mockResolvedValue(["你好"]);
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    session.update("Hello"); await vi.advanceTimersByTimeAsync(320); session.reset(); session.update("Hello");
    await vi.advanceTimersByTimeAsync(640);
    expect(session.error).toBe(""); expect(session.current().translation).toBe("你好"); session.dispose();
  });
  it("does not hammer a failed provider on every source change and supports explicit retry", async () => {
    const translate = vi.fn().mockRejectedValueOnce(new Error("rate limit")).mockResolvedValue(["你好"]);
    const session = new LiveSubtitleTranslator(translate, vi.fn());
    session.update("Hello"); await vi.advanceTimersByTimeAsync(320);
    session.update("Hello world"); await vi.advanceTimersByTimeAsync(1000); expect(translate).toHaveBeenCalledTimes(1);
    session.retry(); await vi.advanceTimersByTimeAsync(0); expect(session.current().translation).toBe("你好"); session.dispose();
  });
});
