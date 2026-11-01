import { afterEach, describe, expect, it, vi } from "vitest";
import { alignGoogleContext, googleContextSource } from "../src/background/google-context";
import { createProvider } from "../src/background/providers";

afterEach(() => vi.unstubAllGlobals());
describe("Google original-segment alignment", () => {
  const texts = ["First sentence. Another sentence.", "Repeated.", "Repeated."];
  it("collects split sentences and repeated paragraphs while discarding reference text", () => {
    const { source, ranges } = googleContextSource("Page title: Test", texts);
    expect(alignGoogleContext([[
      ["页面标题：测试\n\n", "Page title: Test\n\n"],
      ["第一句。", "First sentence. "], ["另一句。\n\n", "Another sentence.\n\n"],
      ["重复一。\n\n", "Repeated.\n\n"], ["重复二。", "Repeated."]
    ]], source, ranges)).toEqual(["第一句。另一句。", "重复一。", "重复二。"]);
  });
  it("rejects rewritten original text, missing segments and translations spanning multiple paragraphs", () => {
    const { source, ranges } = googleContextSource("Topic", ["First.", "Second."]);
    for (const payload of [null, {}, [], [null], [[null]], [[["译文"]]]])
      expect(alignGoogleContext(payload, source, ranges)).toEqual([undefined, undefined]);
    expect(alignGoogleContext([[["整段", source]]], source, ranges)).toEqual([undefined, undefined]);
    expect(alignGoogleContext([[["标题", "Topic"], ["第二句", "Second."]]], source, ranges)).toEqual([undefined, undefined]);
    expect(alignGoogleContext([[["标题", "Topic"]]], source, ranges)).toEqual([undefined, undefined]);
    expect(alignGoogleContext([[["标题", "Topic"], ["第一句", "First."]]], source, ranges)).toEqual(["第一句", undefined]);
  });
  it("retries only paragraphs that cannot be aligned and never sends fragile segment markers", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const source = new URL(url).searchParams.get("q")!;
      expect(source).not.toContain("WUPAGESEGMENT");
      return new Response(JSON.stringify([source === "Second." ? [["第二句。", source]] : [
        ["话题\n\n", "Topic\n\n"], ["第一句。", "First."]
      ]]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ type: "google-web-translate", id: "google", label: "Google" });
    await expect(provider.translateBatch({ texts: ["First.", "Second."], context: "Topic", sourceLang: "en", targetLang: "zh-CN" }))
      .resolves.toEqual(["第一句。", "第二句。"]);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("q"))).toEqual(["Topic\n\nFirst.\n\nSecond.", "Second."]);
  });
  it("does not turn rate limits into extra fallback requests", async () => {
    const fetchMock = vi.fn(async () => new Response("Limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ type: "google-web-translate", id: "google", label: "Google" });
    await expect(provider.translateBatch({ texts: ["First."], context: "Topic", targetLang: "zh-CN" })).rejects.toThrow("429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("cancels an unalignable response before starting paragraph fallbacks", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return new Response(JSON.stringify([[["整段译文", "Topic\n\nFirst."]]]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProvider({ type: "google-web-translate", id: "google", label: "Google" });
    await expect(provider.translateBatch({ texts: ["First."], context: "Topic", targetLang: "zh-CN" }, controller.signal)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
