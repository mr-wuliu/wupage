// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";
vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));
import { sendRuntimeRequest } from "../src/content/runtime";
import {
  clearTranslations,
  collectAdditionalTextSegmentsProgressive,
  collectTextSegmentsProgressive,
  renderTranslations
} from "../src/content/dom";
import { clearPageTranslation, getLocalPageTranslationState, hideLocalPageTranslation, startLocalPageTranslation, setPageTranslationDisplayMode, updatePageTranslationSettings } from "../src/content/page-translation";
const settings: ExtensionSettings = {
  targetLang: "zh-CN", sourceLang: "auto", activeProviderId: "test", chunkSize: 1200, concurrency: 2,
  pdfTranslationPageRadius: 5, cacheEnabled: false, floatingBallEnabled: true,
  translateCodeComments: true, translationDisplayMode: "bilingual", providers: []
};
beforeEach(() => {
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({
    display: element.closest(".hidden") ? "none" : "block", visibility: "visible", opacity: "1"
  }) as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 600, height: 24, top: 0, right: 600, bottom: 24, left: 0, x: 0, y: 0, toJSON: () => ({})
  });
  vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
    if (request.type !== "TRANSLATE_BATCH") throw new Error("unexpected request");
    return { translations: request.texts.map(text => `translated: ${text}`), cached: 0 };
  });
});
afterEach(() => {
  clearPageTranslation(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  vi.mocked(sendRuntimeRequest).mockReset(); document.body.innerHTML = "";
  Reflect.deleteProperty(document, "elementFromPoint");
});
function pauseFirstSlice(): () => void {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  vi.stubGlobal("scheduler", { yield: () => { if (!first) return Promise.resolve(); first = false; return gate; } });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now += 20);
  return release;
}
it("does not resume node tracking after a yielding scan was cleared", async () => {
  document.body.innerHTML = "<p>First paragraph.</p><p>Second paragraph.</p>";
  const release = pauseFirstSlice();
  const scan = collectTextSegmentsProgressive();
  clearTranslations(); release();
  expect(await scan).toEqual([]);
  expect((await collectAdditionalTextSegmentsProgressive([document.body])).map(segment => segment.text)).toEqual(["First paragraph.", "Second paragraph."]);
});
it("reports stopped immediately while an initial scan is paused", async () => {
  document.body.innerHTML = "<p>Source paragraph.</p>";
  const release = pauseFirstSlice();
  const starting = startLocalPageTranslation(settings);
  hideLocalPageTranslation();
  const stopped = getLocalPageTranslationState();
  release(); await starting;
  expect(stopped).toMatchObject({ active: false, pending: 0 });
  expect(sendRuntimeRequest).not.toHaveBeenCalled();
});
it("keeps the latest scan active when an older scan finishes", async () => {
  document.body.innerHTML = "<p>Source paragraph.</p>";
  const releases: Array<() => void> = [];
  vi.stubGlobal("scheduler", { yield: () => new Promise<void>(resolve => releases.push(resolve)) });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now += 20);
  const first = startLocalPageTranslation(settings);
  const second = startLocalPageTranslation({ ...settings, targetLang: "ja" });
  releases[0](); await first;
  const state = getLocalPageTranslationState();
  releases[1](); await second;
  expect(state).toMatchObject({ active: true, pending: 1 });
  expect(vi.mocked(sendRuntimeRequest).mock.calls.flatMap(([request]) => request.type === "TRANSLATE_BATCH" ? request.targetLang : [])).toEqual(["ja"]);
});
it("does not render unchanged text collected directly from body", async () => {
  document.body.textContent = "Direct body paragraph.";
  const segments = await collectTextSegmentsProgressive();
  renderTranslations(segments.map(segment => ({ id: segment.id, text: segment.text })));
  expect(document.querySelector(".wupage-translation")).toBeNull();
});
it("captures visibility changes made during a yielding scan", async () => {
  document.body.innerHTML = "<p id='first' class='hidden'>Newly visible paragraph.</p><p>Second paragraph.</p>";
  const release = pauseFirstSlice();
  const scan = collectTextSegmentsProgressive();
  document.querySelector("#first")!.classList.remove("hidden");
  release();
  expect((await scan).map(segment => segment.text)).toContain("Newly visible paragraph.");
});
it("keeps mutations beyond the original 200-root tracking limit", async () => {
  document.body.innerHTML = `<main>${Array.from({ length: 220 }, (_, index) => `<p id='p-${index}'>Original paragraph ${index}.</p>`).join("")}</main>`;
  let lastCollected = false;
  vi.spyOn(performance, "now").mockImplementation(() => lastCollected ? 20 : 0);
  let release!: () => void;
  let first = true;
  vi.stubGlobal("scheduler", { yield: () => { if (!first) return Promise.resolve(); first = false; return new Promise<void>(resolve => { release = resolve; }); } });
  const scan = collectTextSegmentsProgressive(true, { onSegments: segments => {
    lastCollected ||= segments.some(segment => segment.element.id === "p-219");
  } });
  expect(release).toBeTypeOf("function");
  for (let index = 0; index < 220; index++) document.querySelector(`#p-${index}`)!.textContent = `Updated paragraph ${index}.`;
  release();
  const texts = (await scan).map(segment => segment.text);
  expect(texts).toContain("Updated paragraph 219.");
  expect(texts).not.toContain("Original paragraph 219.");
});

it("yields an incremental full-root scan and cancels before processing the rest", async () => {
  document.body.innerHTML = `<main>${Array.from({ length: 500 }, (_, index) => `<p>Incremental paragraph ${index}.</p>`).join("")}</main>`;
  const controller = new AbortController();
  const sources: string[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => sources.length ? 20 : 0);
  vi.stubGlobal("scheduler", { yield: () => new Promise<void>(() => {}) });
  const scan = collectAdditionalTextSegmentsProgressive([document.body], true, {
    signal: controller.signal, onSegments: segments => sources.push(...segments.map(segment => segment.text))
  });
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.length).toBeLessThan(500);
  const before = sources.length;
  controller.abort();
  expect(await scan).toEqual([]);
  expect(sources).toHaveLength(before);
});
it("preserves completed translations during an incremental full-root scan", async () => {
  document.body.innerHTML = "<main><p id='kept'>Keep this paragraph.</p><p>New paragraph.</p></main>";
  const kept = (await collectAdditionalTextSegmentsProgressive([document.querySelector("#kept")!]));
  renderTranslations(kept.map(segment => ({ id: segment.id, text: "已有译文。" })));
  const found = await collectAdditionalTextSegmentsProgressive([document.body]);
  expect(found.map(segment => segment.text)).toEqual(["New paragraph."]);
  expect(document.querySelector("#kept .wupage-translation")?.textContent).toBe("已有译文。");
});
it("uses language changes made while the initial scan is paused", async () => {
  document.body.innerHTML = "<p>Source paragraph.</p>";
  const release = pauseFirstSlice();
  const starting = startLocalPageTranslation(settings);
  updatePageTranslationSettings({ ...settings, targetLang: "ja" });
  release(); await starting;
  await vi.waitFor(() => expect(sendRuntimeRequest).toHaveBeenCalled());
  expect(vi.mocked(sendRuntimeRequest).mock.calls.flatMap(([request]) => request.type === "TRANSLATE_BATCH" ? request.targetLang : [])).toEqual(["ja"]);
});
it("keeps a display-mode change made while the initial scan is paused", async () => {
  document.body.innerHTML = "<p>Source paragraph.</p>";
  const release = pauseFirstSlice();
  const starting = startLocalPageTranslation(settings);
  setPageTranslationDisplayMode("replace");
  release(); await starting;
  expect(document.querySelector<HTMLElement>(".wupage-translation")?.dataset.wupageDisplayMode).toBe("replace");
});

it("reconciles host changes while restoring an incremental scan", async () => {
  document.body.innerHTML = "<p id='changed'>Old source paragraph.</p><p>Second paragraph.</p>";
  const release = pauseFirstSlice();
  const scan = collectAdditionalTextSegmentsProgressive([document.body]);
  document.querySelector("#changed")!.textContent = "Updated source paragraph.";
  release();
  const texts = (await scan).map(segment => segment.text);
  expect(texts).toContain("Updated source paragraph.");
  expect(texts).not.toContain("Old source paragraph.");
});
