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

    const settings = createLlmSettings("zhipu-glm-queue", 2);
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
});

function createLlmSettings(providerId: string, concurrency: number): ExtensionSettings {
  return {
    targetLang: "zh-CN",
    sourceLang: "auto",
    activeProviderId: providerId,
    chunkSize: 1200,
    concurrency,
    cacheEnabled: false,
    floatingBallEnabled: true,
    providers: [
      {
        type: "zhipu-glm",
        id: providerId,
        label: "Zhipu GLM",
        baseURL: "https://open.bigmodel.cn/api/paas/v4",
        apiKey: "secret",
        model: "glm-4-flash-250414",
        systemPrompt: "Translate to {{targetLang}}"
      }
    ]
  };
}
