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
