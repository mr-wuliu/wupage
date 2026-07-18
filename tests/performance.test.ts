import { describe, expect, it } from "vitest";
import { getEffectiveProviderPerformance } from "../src/shared/performance";
import { normalizeSettings } from "../src/shared/settings";

describe("provider performance", () => {
  it("inherits global values when no provider override is active", () => {
    const settings = normalizeSettings({ chunkSize: 900, concurrency: 4 });

    expect(getEffectiveProviderPerformance(settings, "google-web-translate")).toEqual({
      chunkSize: 900,
      concurrency: 4,
      performanceMode: "inherit"
    });
  });

  it("uses provider values while keeping concurrency under the global limit", () => {
    const settings = normalizeSettings({
      chunkSize: 900,
      concurrency: 2,
      providers: [
        {
          type: "zhipu-glm",
          id: "zhipu-glm",
          label: "Zhipu GLM",
          performanceMode: "custom",
          chunkSize: 3600,
          concurrency: 6,
          baseURL: "https://open.bigmodel.cn/api/paas/v4",
          apiKey: "",
          model: "glm-4-flash-250414",
          systemPrompt: "Translate to {{targetLang}}"
        }
      ]
    });

    expect(getEffectiveProviderPerformance(settings, "zhipu-glm")).toEqual({
      chunkSize: 3600,
      concurrency: 2,
      performanceMode: "custom"
    });
  });
});
