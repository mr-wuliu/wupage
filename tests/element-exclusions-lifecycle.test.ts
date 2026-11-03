// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.com/articles/one"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { ExtensionSettings, TranslateBatchResponse } from "../src/shared/types";
import { clearPageTranslation, startPageTranslation, updatePageTranslationSettings } from "../src/content/page-translation";
import { configureElementExclusions } from "../src/content/element-exclusions";
import { sendRuntimeRequest } from "../src/content/runtime";

vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));
let settings: ExtensionSettings;
const excludedSettings = (): ExtensionSettings => ({ ...settings, elementExclusions: [{ id: "region", name: "Excluded region",
  pattern: "example.com/articles/*", selectors: ["#excluded", "[data-region='ads']"], enabled: true }] });
const output = (id: string) => document.querySelector(`#${id} .wupage-translation`);
beforeEach(() => {
  configureElementExclusions(undefined);
  settings = { ...structuredClone(DEFAULT_SETTINGS), translationDisplayMode: "replace" };
  document.body.innerHTML = '<main><p id="public">Readable public article.</p><p id="excluded">Excluded recommendation text.</p></main>';
  vi.spyOn(window, "getComputedStyle").mockReturnValue({ display: "block", visibility: "visible", opacity: "1" } as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 30));
  vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === "TRANSLATE_BATCH"
    ? { translations: request.texts.map(text => `译文：${text}`), cached: 0 } : settings);
});
afterEach(() => { clearPageTranslation(); configureElementExclusions(undefined); vi.restoreAllMocks(); vi.mocked(sendRuntimeRequest).mockReset(); document.body.replaceChildren(); });

describe("live exclusion settings", () => {
  it("restores newly excluded output and continues translating permitted content", async () => {
    await startPageTranslation(settings);
    expect(output("excluded")).not.toBeNull();
    updatePageTranslationSettings(excludedSettings());
    await vi.waitFor(() => expect(output("public")).not.toBeNull());
    expect(output("excluded")).toBeNull();
    expect(document.querySelector("#excluded")!.textContent).toBe("Excluded recommendation text.");
  });

  it("does not render an old response after a rule changes while the request is pending", async () => {
    let finish!: (response: TranslateBatchResponse) => void;
    vi.mocked(sendRuntimeRequest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = startPageTranslation(settings);
    await vi.waitFor(() => expect(finish).toBeDefined());
    updatePageTranslationSettings(excludedSettings());
    await vi.waitFor(() => expect(output("public")).not.toBeNull());
    finish({ translations: ["迟到的公开译文", "迟到的排除区域译文"], cached: 0 }); await old;
    expect(output("excluded")).toBeNull();
    expect(document.querySelector("#excluded")!.textContent).toBe("Excluded recommendation text.");
    expect(document.body.textContent).not.toContain("迟到");
  });

  it("observes custom selector attributes when a live region becomes excluded", async () => {
    await startPageTranslation(excludedSettings());
    const post = document.querySelector("#public")!;
    expect(output("public")).not.toBeNull();
    post.setAttribute("data-region", "ads");
    await vi.waitFor(() => expect(output("public")).toBeNull());
    expect(post.textContent).toBe("Readable public article.");
  });

  it("keeps excluded source out of outgoing text and contextual excerpts", async () => {
    await startPageTranslation(excludedSettings());
    const batches = vi.mocked(sendRuntimeRequest).mock.calls.map(([request]) => request).filter(request => request.type === "TRANSLATE_BATCH");
    expect(batches).toHaveLength(1);
    expect(batches[0].texts).toEqual(["Readable public article."]);
    expect(batches[0].context).not.toContain("Excluded recommendation text.");
  });
});
