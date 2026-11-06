// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { translateWithSettings } from "../src/background/translation";
import { clearPageTranslation } from "../src/content/page-translation";
import { translateParagraph } from "../src/content/paragraph-translation";
import { sendRuntimeRequest } from "../src/content/runtime";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { structuredTranslation } from "./helpers/structured-translation";

vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));

const detectLanguage = vi.fn();
const articleTexts: string[][] = [];

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: 600, bottom: 30, width: 600, height: 30, x: 0, y: 0, toJSON: () => ({})
  });
  articleTexts.length = 0;
  detectLanguage.mockReset().mockResolvedValue({ languages: [{ language: "und", percentage: 0 }] });
  const stored: Record<string, unknown> = {};
  let rules: chrome.declarativeNetRequest.Rule[] = [];
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://wupage-test${path}` },
    i18n: { detectLanguage },
    storage: { local: {
      get: async (key: string) => ({ [key]: stored[key] }),
      set: async (values: Record<string, unknown>) => { Object.assign(stored, values); }
    } },
    declarativeNetRequest: {
      getSessionRules: async () => [...rules],
      updateSessionRules: async (options: Parameters<typeof chrome.declarativeNetRequest.updateSessionRules>[0]) => {
        rules = rules.filter(rule => !options.removeRuleIds?.includes(rule.id));
        rules.push(...(options.addRules ?? []));
      }
    }
  });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (!init.body) return Response.json({ code: 0, data: { config: { ttwid: true, web_id: "test-device" }, country: "CN" } });
    const { raw_text: texts } = JSON.parse(String(init.body)) as { raw_text: string[] };
    articleTexts.push(texts);
    const items = texts.map((text, index) => ({ index, res: structuredTranslation(text, "请先阅读安装指南。"), detect_lang: "en" }));
    return new Response(`event: json\ndata: ${JSON.stringify({ code: 0, data: { items } })}\n\nevent: done\n\n`, {
      headers: { "Content-Type": "text/event-stream" }
    });
  }));
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS), activeProviderId: "doubao-paragraph", cacheEnabled: false,
    sourceLang: "auto", targetLang: "zh-CN", translationDisplayMode: "bilingual" as const,
    providers: [{ id: "doubao-paragraph", type: "doubao-web" as const, label: "豆包" }]
  };
  vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
    if (request.type === "GET_SETTINGS") return settings;
    if (request.type === "TRANSLATE_BATCH") return translateWithSettings(settings, request);
    throw new Error(`Unexpected request: ${request.type}`);
  });
});

afterEach(() => {
  clearPageTranslation(); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(sendRuntimeRequest).mockReset();
});

it.each([
  "Read the installation guide before continuing.",
  'Read <a href="/guide"><em>the installation guide</em></a> before continuing.'
])("renders the first Doubao paragraph result and restores the original when language detection is uncertain: %s", async markup => {
  document.body.innerHTML = `<main><p id="paragraph" data-wupage-paragraph-active="true">${markup}</p><p id="other">Leave this paragraph alone.</p></main>`;
  const paragraph = document.querySelector("#paragraph")!;
  await translateParagraph(paragraph);
  expect(detectLanguage).not.toHaveBeenCalled();
  expect(articleTexts).toHaveLength(1);
  expect(document.querySelectorAll(".wupage-translation")).toHaveLength(1);
  expect(document.querySelector(".wupage-translation")!.textContent).toContain("请先阅读安装指南。");
  expect(document.querySelector(".wupage-translation-pending")).toBeNull();
  expect(document.querySelector("#other")!.textContent).toBe("Leave this paragraph alone.");
  await translateParagraph(paragraph);
  expect(document.querySelector(".wupage-translation")).toBeNull();
  expect(paragraph.innerHTML).toBe(markup);
  expect(articleTexts).toHaveLength(1);
});
