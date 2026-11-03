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

  it.each([undefined, "auto"])("retries unchanged mixed-language items separately with source language %s", async (sourceLang) => {
    const translations = new Map([
      ["游戏版本", "游戏版本"],
      ["A lightweight library for game extensions.", "用于游戏扩展的轻量级库。"],
      ["Download the latest release.", "下载最新版本。"]
    ]);
    const fetchMock = vi.fn(async (url: string) => {
      const source = new URL(url).searchParams.get("q")!;
      if (source.startsWith("Page title:")) return { ok: true, json: async () => [[
        ["页面标题：模组列表\n\n", "Page title: 模组列表\n\n"],
        ["游戏版本\n\n", "游戏版本\n\n"],
        ["A lightweight library for game extensions.\n\n", "A lightweight library for game extensions.\n\n"],
        ["下载最新版本。", "Download the latest release."]
      ]] };
      const translated = translations.get(source);
      expect(translated).toBeDefined();
      return { ok: true, json: async () => [[[translated, source, null, null]]] };
    });
    vi.stubGlobal("fetch", fetchMock);
    const settings = createLlmSettings("google-mixed", 1);
    settings.providers = [{ id: "google-mixed", type: "google-web-translate", label: "Google" }];
    await expect(translateWithSettings(settings, {
      texts: [...translations.keys()], sourceLang, targetLang: "zh-CN", context: "Page title: 模组列表"
    })).resolves.toEqual({ translations: [...translations.values()], cached: 0 });
    const sources = fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("q"));
    expect(sources).toHaveLength(3);
    expect(sources.slice(1)).toEqual(["游戏版本", "A lightweight library for game extensions."]);
  });

  it("translates adjacent page items together so ambiguous terms share context", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const source = new URL(url).searchParams.get("q") ?? "";
      expect(source).toContain("Why variance matters");
      expect(source).not.toContain("WUPAGESEGMENT");
      return {
        ok: true,
        json: async () => [[
          ["参考内容。\n\n", source.slice(0, source.indexOf("\n\n") + 2)],
          ["为什么型变很重要\n\n", "Why variance matters\n\n"],
          ["型变涉及用一种类型替换另一种类型的能力。", "Variance is about our ability to substitute types for other types."]
        ]]
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const settings: ExtensionSettings = {
      targetLang: "zh-CN",
      sourceLang: "en",
      activeProviderId: "google-context",
      chunkSize: 1200,
      concurrency: 1,
      pdfTranslationPageRadius: 5,
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
  it("keeps imported provider IDs separate from the global limiter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '["译文"]' } }] }))));
    await expect(translateWithSettings(createLlmSettings("__wupage_global__", 1), {
      texts: ["Hello"], targetLang: "zh-CN"
    })).resolves.toMatchObject({ translations: ["译文"] });
  });

  it("stops scheduling remaining groups after one worker fails", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { texts } = JSON.parse(JSON.parse(String(init.body)).messages.at(-1).content) as { texts: string[] };
      if (texts[0].startsWith("first")) return new Response("Invalid credentials", { status: 401 });
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    vi.stubGlobal("fetch", fetch);
    const settings = createLlmSettings("stop-on-failure", 2);
    const request = translateWithSettings(settings, {
      texts: ["first", "second", "third", "fourth"].map(text => `${text} ${"a".repeat(3190)}`), targetLang: "zh-CN"
    });
    await expect(request).rejects.toMatchObject({ errorCode: "login-required" });
    finish(new Response(JSON.stringify({ choices: [{ message: { content: '["成功完成的并行结果"]' } }] })));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("serves an explicit request before queued page prefetch without interrupting running work", async () => {
    const order: string[] = [];
    let finish!: () => void;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const { texts } = JSON.parse(body.messages[1].content) as { texts: string[] };
      order.push(texts[0]);
      if (texts[0] === "running") await new Promise<void>(resolve => { finish = resolve; });
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(texts.map(text => `译文 ${text}`)) } }] }) };
    }));
    const settings = createLlmSettings("priority-test", 1);
    const pageSession = { id: "page", documentKey: "document" };
    const first = translateWithSettings(settings, { texts: ["running"], targetLang: "zh-CN", pageSession });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const prefetch = translateWithSettings(settings, { texts: ["prefetch"], targetLang: "zh-CN", pageSession });
    const explicit = translateWithSettings(settings, { texts: ["explicit"], targetLang: "zh-CN" });
    await vi.waitFor(() => expect(getTranslationDebugSnapshot().tasks.filter(task => task.providerId === "priority-test" && task.status === "queued")).toHaveLength(2));
    finish(); await Promise.all([first, prefetch, explicit]);
    expect(order).toEqual(["running", "explicit", "prefetch"]);
  });
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
          get: vi.fn(async (key: string | string[]) => {
            const keys = Array.isArray(key) ? key : [key];
            return Object.fromEntries(keys.filter((item) => stored.has(item)).map((item) => [item, stored.get(item)!]));
          }),
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

  it("invalidates cached output after model, prompt, source language, or academic style changes", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("chrome", { storage: { local: {
      get: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((item) => stored.has(item)).map((item) => [item, stored.get(item)!]));
      }),
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
    const academic = { ...request, translationStyle: "academic" as const };
    expect((await translateWithSettings(settings, academic)).cached).toBe(0);
    expect((await translateWithSettings(settings, academic)).cached).toBe(1);
    expect((await translateWithSettings(settings, request)).cached).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
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

  it("avoids legacy PDF caches and revalidates protected cache entries before reuse", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("chrome", { storage: { local: {
      get: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((item) => stored.has(item)).map((item) => [item, stored.get(item)!]));
      }),
      set: vi.fn(async (items: Record<string, string>) => {
        Object.entries(items).forEach(([key, value]) => stored.set(key, value));
      })
    } } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '["旧的损坏译文"]' } }] }) })
      .mockImplementation(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '["设 《wupage 0》 为常数。"]' } }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const settings = createLlmSettings("pdf-cache-validation", 1);
    settings.cacheEnabled = true;
    const source = { texts: ["Let ⟪WUPAGE0⟫ be fixed."], targetLang: "zh-CN" };
    await translateWithSettings(settings, source);
    const legacyKey = [...stored.keys()][0];
    const protectedRequest = { ...source, preservePlaceholders: true };
    expect(await translateWithSettings(settings, protectedRequest)).toEqual({ translations: ["设 ⟪WUPAGE0⟫ 为常数。"], cached: 0 });
    const protectedKey = [...stored.keys()].find((key) => key !== legacyKey)!;
    expect(stored.get(protectedKey)).toBe("设 ⟪WUPAGE0⟫ 为常数。");
    expect((await translateWithSettings(settings, protectedRequest)).cached).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stored.set(protectedKey, "标记丢失的缓存");
    expect((await translateWithSettings(settings, protectedRequest)).cached).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stored.get(protectedKey)).toBe("设 ⟪WUPAGE0⟫ 为常数。");
  });

  it("caches only the locally repaired result after persistent marker loss", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("chrome", { storage: { local: {
      get: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((item) => stored.has(item)).map((item) => [item, stored.get(item)!]));
      }),
      set: vi.fn(async (items: Record<string, string>) => { Object.entries(items).forEach(([key, value]) => stored.set(key, value)); })
    } } });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const { texts } = JSON.parse(JSON.parse(String(init.body)).messages[1].content) as { texts: string[] };
      const translations = texts.map((text) => text.includes("WUPAGE") ? "持续缺少公式的译文" : `译文：${text}`);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(translations) } }] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const settings = createLlmSettings("pdf-cache-recovery", 1);
    settings.cacheEnabled = true;
    const request = { texts: ["Let ⟪WUPAGE0⟫ be fixed."], targetLang: "zh-CN", preservePlaceholders: true };
    const first = await translateWithSettings(settings, request);
    expect(first.translations).toEqual(["译文：Let ⟪WUPAGE0⟫ 译文：be fixed."]);
    expect([...stored.values()]).toEqual(first.translations);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await translateWithSettings(settings, request)).cached).toBe(1);
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
    pdfTranslationPageRadius: 5,
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
