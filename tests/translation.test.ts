import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionSettings } from "../src/shared/types";
import { getTranslationDebugSnapshot, groupTexts, translateWithSettings } from "../src/background/translation";

describe("groupTexts", () => {
  it("groups texts without exceeding max chars when possible", () => {
    expect(groupTexts(["aa", "bbb", "c", "dddd"], 5)).toEqual([["aa", "bbb"], ["c", "dddd"]]);
  });

  it("keeps oversized individual texts as their own group", () => {
    expect(groupTexts(["abcdef", "g"], 3)).toEqual([["abcdef"], ["g"]]);
  });

  it("caps the number of short texts in each group", () => {
    expect(groupTexts(["a", "b", "c", "d", "e"], 100, 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"]
    ]);
  });
});

describe("contextual machine translation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("translates adjacent page items together so ambiguous terms share context", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const source = new URL(url).searchParams.get("q") ?? "";
      expect(source).toContain("Why variance matters");
      expect(source).toContain("⟪WUPAGESEGMENT0⟫");
      expect(source).toContain("⟪WUPAGESEGMENT1⟫");
      return {
        ok: true,
        json: async () => [[[
          "⟪WUPAGESEGMENT0⟫\n为什么型变很重要\n⟪WUPAGESEGMENT1⟫\n型变涉及用一种类型替换另一种类型的能力。",
          source,
          null,
          null
        ]]]
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const settings: ExtensionSettings = {
      targetLang: "zh-CN",
      sourceLang: "en",
      activeProviderId: "google-context",
      chunkSize: 1200,
      concurrency: 1,
      cacheEnabled: false,
      floatingBallEnabled: true,
      translateCodeComments: true,
      translationDisplayMode: "bilingual",
      providers: [{
        type: "google-web-translate",
        id: "google-context",
        label: "Google Web"
      }]
    };

    await expect(translateWithSettings(settings, {
      texts: [
        "Why variance matters",
        "Variance is about our ability to substitute types for other types."
      ],
      context: "Page title: Why variance matters\nDocument excerpts:\nVariance is about type substitution and subtyping.",
      sourceLang: "en",
      targetLang: "zh-CN",
      providerId: "google-context"
    })).resolves.toEqual({
      translations: [
        "为什么型变很重要",
        "型变涉及用一种类型替换另一种类型的能力。"
      ],
      cached: 0
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("LLM provider queue", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("limits concurrent LLM batch requests per provider without a fixed start interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];

    const fetchMock = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      starts.push(Date.now());
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
      inFlight -= 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "[\"译文\"]" } }]
        })
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const settings = createLlmSettings("zhipu-glm-queue", 4, 2);
    const first = translateWithSettings(settings, {
      texts: ["hello"],
      sourceLang: "en",
      targetLang: "zh-CN",
      providerId: "zhipu-glm-queue"
    });
    const second = translateWithSettings(settings, {
      texts: ["world"],
      sourceLang: "en",
      targetLang: "zh-CN",
      providerId: "zhipu-glm-queue"
    });
    const third = translateWithSettings(settings, {
      texts: ["again"],
      sourceLang: "en",
      targetLang: "zh-CN",
      providerId: "zhipu-glm-queue"
    });

    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([first, second, third]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(2);
    expect(starts).toEqual([0, 0, 100]);
  });

  it("limits total requests across providers with the global concurrency cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
      inFlight -= 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "[\"译文\"]" } }] })
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const settings = createLlmSettings("zhipu-global-a", 2, 2);
    settings.providers.push({
      ...settings.providers[0],
      id: "zhipu-global-b",
      label: "Zhipu GLM B"
    });
    const requests = [
      translateWithSettings(settings, {
        texts: ["one"], targetLang: "zh-CN", providerId: "zhipu-global-a"
      }),
      translateWithSettings(settings, {
        texts: ["two"], targetLang: "zh-CN", providerId: "zhipu-global-a"
      }),
      translateWithSettings(settings, {
        texts: ["three"], targetLang: "zh-CN", providerId: "zhipu-global-b"
      }),
      translateWithSettings(settings, {
        texts: ["four"], targetLang: "zh-CN", providerId: "zhipu-global-b"
      })
    ];

    await vi.advanceTimersByTimeAsync(300);
    await Promise.all(requests);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBe(2);
  });

  it("records debug task state and speed metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "[\"译文\"]" } }]
        })
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = translateWithSettings(createLlmSettings("zhipu-glm-debug", 1), {
      texts: ["hello"],
      sourceLang: "en",
      targetLang: "zh-CN",
      providerId: "zhipu-glm-debug"
    });

    await vi.runAllTimersAsync();
    await request;

    const task = getTranslationDebugSnapshot().tasks.find(
      (entry) => entry.providerId === "zhipu-glm-debug"
    );
    expect(task).toBeDefined();
    if (!task) throw new Error("Missing debug task.");
    expect(task).toMatchObject({
      providerId: "zhipu-glm-debug",
      status: "succeeded",
      textCount: 1,
      charCount: 5
    });
    expect(task.startedAt).toBeDefined();
    expect(task.finishedAt).toBeDefined();
  });

  it("recovers from an LLM response count mismatch by splitting the failed batch", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ content: string }>;
      };
      const input = JSON.parse(body.messages[1].content) as { texts: string[] };
      const translations = input.texts.length === 1
        ? [`译文：${input.texts[0]}`]
        : ["模型漏掉了部分条目"];
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(translations) } }]
        })
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(translateWithSettings(createLlmSettings("zhipu-recovery", 2), {
      texts: ["first", "second", "third"],
      sourceLang: "en",
      targetLang: "zh-CN",
      providerId: "zhipu-recovery"
    })).resolves.toEqual({
      translations: ["译文：first", "译文：second", "译文：third"],
      cached: 0
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("does not reuse a cached translation from a different document context", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: stored.get(key) })),
          set: vi.fn(async (items: Record<string, string>) => {
            Object.entries(items).forEach(([key, value]) => stored.set(key, value));
          })
        }
      }
    });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      const input = JSON.parse(body.messages[1].content) as { context: string };
      const translation = input.context.includes("type system") ? "型变" : "方差";
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify([translation]) } }] })
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const settings = createLlmSettings("zhipu-context-cache", 1);
    settings.cacheEnabled = true;

    const typeTheory = await translateWithSettings(settings, {
      texts: ["variance"],
      context: "This article is about a type system and subtyping.",
      targetLang: "zh-CN",
      providerId: "zhipu-context-cache"
    });
    const statistics = await translateWithSettings(settings, {
      texts: ["variance"],
      context: "This article is about statistics and probability.",
      targetLang: "zh-CN",
      providerId: "zhipu-context-cache"
    });

    expect(typeTheory.translations).toEqual(["型变"]);
    expect(statistics.translations).toEqual(["方差"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached output after model, prompt, or source language changes", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("chrome", { storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: stored.get(key) })),
      set: vi.fn(async (items: Record<string, string>) => {
        Object.entries(items).forEach(([key, value]) => stored.set(key, value));
      })
    } } });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '["译文"]' } }] })
    }));
    vi.stubGlobal("fetch", fetchMock);
    const settings = createLlmSettings("cache-config", 1);
    settings.cacheEnabled = true;
    const request = { texts: ["Original text"], sourceLang: "en", targetLang: "zh-CN" };
    await translateWithSettings(settings, request);
    expect((await translateWithSettings(settings, request)).cached).toBe(1);
    const provider = settings.providers[0];
    if (provider.type !== "zhipu-glm") throw new Error("Unexpected provider");
    provider.model = "another-model";
    expect((await translateWithSettings(settings, request)).cached).toBe(0);
    provider.systemPrompt = "Translate formal emails into {{targetLang}}";
    expect((await translateWithSettings(settings, request)).cached).toBe(0);
    expect((await translateWithSettings(settings, { ...request, sourceLang: "auto" })).cached).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("recovers empty LLM items instead of caching them as successful translations", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const { texts } = JSON.parse(body.messages[1].content) as { texts: string[] };
      return { ok: true, json: async () => ({ choices: [{ message: {
        content: JSON.stringify(texts.length > 1 ? ["译文", ""] : texts.map((text) => `译文：${text}`))
      } }] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const settings = createLlmSettings("empty-recovery", 1);
    await expect(translateWithSettings(settings, {
      texts: ["First paragraph", "Second paragraph"], targetLang: "zh-CN"
    })).resolves.toMatchObject({ translations: ["译文：First paragraph", "译文：Second paragraph"] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function createLlmSettings(
  providerId: string,
  concurrency: number,
  providerConcurrency = concurrency
): ExtensionSettings {
  return {
    targetLang: "zh-CN",
    sourceLang: "auto",
    activeProviderId: providerId,
    chunkSize: 1200,
    concurrency,
    cacheEnabled: false,
    floatingBallEnabled: true,
    translateCodeComments: true,
    translationDisplayMode: "bilingual",
    providers: [
      {
        type: "zhipu-glm",
        id: providerId,
        label: "Zhipu GLM",
        performanceMode: "custom",
        chunkSize: 3200,
        concurrency: providerConcurrency,
        baseURL: "https://open.bigmodel.cn/api/paas/v4",
        apiKey: "secret",
        model: "glm-4-flash-250414",
        systemPrompt: "Translate to {{targetLang}}"
      }
    ]
  };
}
