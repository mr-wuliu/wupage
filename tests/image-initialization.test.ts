// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import type { ExtensionSettings } from "../src/shared/types";
import { sendRuntimeRequest } from "../src/content/runtime";

vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn(), hasRuntimeContext: () => true }));

let changed: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let finishRead: (settings: ExtensionSettings) => void;
let imageTranslation: typeof import("../src/content/image-translation");
const settings = { ...DEFAULT_SETTINGS, imageTranslationEnabled: true };
const host = () => document.getElementById("wupage-image-tools");

function update(previous: ExtensionSettings, next: ExtensionSettings): void {
  changed({ [SETTINGS_KEY]: { oldValue: previous, newValue: next } }, "local");
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("chrome", { storage: { onChanged: { addListener: vi.fn(listener => { changed = listener; }) } } });
  vi.mocked(sendRuntimeRequest).mockImplementation(() => new Promise(resolve => { finishRead = resolve; }));
  document.body.innerHTML = '<img src="https://i0.hdslb.com/bfs/archive/cover.jpg@672w_378h.avif">';
  Object.defineProperties(document.querySelector("img")!, {
    complete: { value: true }, naturalWidth: { value: 672 }, naturalHeight: { value: 378 }
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 20, top: 20, right: 420, bottom: 220, width: 400, height: 200
  } as DOMRect);
  imageTranslation = await import("../src/content/image-translation");
  imageTranslation.initImageTranslation();
});

afterEach(() => {
  imageTranslation.setImageTranslationEnabled(false);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(sendRuntimeRequest).mockReset();
  document.body.innerHTML = "";
});

describe("live image translation settings", () => {
  it("applies an unrelated storage update while the initial settings read is pending", async () => {
    update(settings, { ...settings, floatingBallEnabled: !settings.floatingBallEnabled });
    expect(host()?.shadowRoot?.querySelectorAll("button")).toHaveLength(1);
    finishRead(settings);
    await Promise.resolve();
    expect(host()).not.toBeNull();
  });

  it("enables existing images immediately and ignores an older disabled initial response", async () => {
    update({ ...settings, imageTranslationEnabled: false }, settings);
    expect(host()?.shadowRoot?.querySelectorAll("button")).toHaveLength(1);
    finishRead({ ...settings, imageTranslationEnabled: false });
    await Promise.resolve();
    expect(host()).not.toBeNull();
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 100, bubbles: true }));
    await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    expect(host()!.shadowRoot!.querySelector("button")!.hidden).toBe(false);
    update(settings, { ...settings, imageTranslationEnabled: false });
    expect(host()).toBeNull();
    update({ ...settings, imageTranslationEnabled: false }, settings);
    expect(host()?.shadowRoot?.querySelectorAll("button")).toHaveLength(1);
  });

  it("does not let an older enabled initial response undo a disable", async () => {
    update(settings, { ...settings, imageTranslationEnabled: false });
    finishRead(settings);
    await Promise.resolve();
    expect(host()).toBeNull();
  });

  it("keeps controls through unrelated updates and replaces them when translation settings change", async () => {
    finishRead(settings);
    await vi.waitFor(() => expect(host()).not.toBeNull());
    const initial = host();
    update(settings, { ...settings, floatingBallEnabled: false });
    expect(host()).toBe(initial);
    update(settings, { ...settings, targetLang: "ja" });
    expect(host()).not.toBe(initial);
    expect(host()?.shadowRoot?.querySelectorAll("button")).toHaveLength(1);
  });

  it("replaces image controls when the OCR service or model cache version changes", async () => {
    finishRead(settings);
    await vi.waitFor(() => expect(host()).not.toBeNull());
    const initial = host();
    const next = { ...settings, ocr: { mode: "http" as const, endpoint: "https://ocr.example/ocr", model: "my-ocr", apiKey: "", modelRevision: "1" } };
    update(settings, next);
    expect(host()).not.toBe(initial);
    const previous = host();
    update(next, { ...next, ocr: { ...next.ocr, modelRevision: "2" } });
    expect(host()).not.toBe(previous);
  });
});
