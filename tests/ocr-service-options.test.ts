// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupOcrSettings } from "../src/options/ocr-service";
import { DEFAULT_OCR_SETTINGS } from "../src/shared/ocr-service";
import type { RuntimeRequest } from "../src/shared/types";

const config = { ...DEFAULT_OCR_SETTINGS, mode: "http" as const, endpoint: "https://ocr.example/v1/ocr", model: "my-ocr", apiKey: "private" };
const query = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  document.open(); document.write(readFileSync("options.html", "utf8")); document.close();
  send = vi.fn(async (request: RuntimeRequest): Promise<unknown> => request.type === "GET_OCR_STATUS"
    ? { ok: true, data: { state: "missing", total: 100, downloaded: 0 } } : { ok: true });
  vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), lineTo: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(), stroke: vi.fn()
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,aGVsbG8=");
});
afterEach(() => { window.dispatchEvent(new Event("pagehide")); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.documentElement.replaceChildren(); });

it("opens an HTTP configuration without starting local OCR and can restore edited fields", async () => {
  const controls = setupOcrSettings(query("imageTranslationEnabled"), vi.fn(), config);
  controls.render(config);
  await vi.waitFor(() => expect(query<HTMLInputElement>("imageTranslationEnabled").disabled).toBe(false));
  expect(send).not.toHaveBeenCalled();
  expect(query("ocrServiceFields").hidden).toBe(false);
  expect(query("ocrModelAction").title).toContain("配置");
  query<HTMLInputElement>("ocrServiceModel").value = "draft";
  query("ocrServiceModel").dispatchEvent(new Event("input", { bubbles: true }));
  expect(controls.read().model).toBe("draft");
  controls.render(config);
  expect(controls.read()).toEqual(config);
});

it("tests the unsaved draft with a built-in image and renders returned text safely", async () => {
  send.mockImplementation(async (request: RuntimeRequest) => request.type === "TEST_OCR_SERVICE" ? { ok: true, data: {
    revision: "test", lines: [{ text: "<img src=x onerror=alert(1)>", poly: [[10, 10], [300, 10], [300, 80], [10, 80]] }]
  } } : { ok: true });
  setupOcrSettings(query("imageTranslationEnabled"), vi.fn(), config).render(config);
  query("testOcrService").click();
  await vi.waitFor(() => expect(query("ocrServiceTestStatus").textContent).toContain("识别完成"));
  expect(query("ocrServiceTestText").textContent).toContain("<img");
  expect(query("ocrServiceTestText").querySelector("img")).toBeNull();
  const calls = send.mock.calls.map(([request]) => request as RuntimeRequest);
  expect(calls.some(r => r.type === "SAVE_SETTINGS" || r.type === "TEST_PROVIDER")).toBe(false);
  expect(calls.find(r => r.type === "TEST_OCR_SERVICE")).toMatchObject({ config, image: { width: 640, height: 160 } });
});

it("cancels tests when fields change and ignores a late response", async () => {
  let finish!: (response: unknown) => void;
  send.mockImplementation(async (request: RuntimeRequest) => request.type === "TEST_OCR_SERVICE"
    ? new Promise(resolve => { finish = resolve; }) : { ok: true });
  setupOcrSettings(query("imageTranslationEnabled"), vi.fn(), config).render(config);
  query("testOcrService").click();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  query<HTMLInputElement>("ocrServiceModel").value = "changed";
  query("ocrServiceModel").dispatchEvent(new Event("input", { bubbles: true }));
  expect(send.mock.calls.some(([request]) => request.type === "CANCEL_OCR_TEST")).toBe(true);
  finish({ ok: true, data: { revision: "old", lines: [{ text: "Old", poly: [[0, 0], [10, 0], [10, 10], [0, 10]] }] } });
  await Promise.resolve(); await Promise.resolve();
  expect(query("ocrServiceTestStatus").textContent).toBe("");
  expect(query("ocrServiceTestText").hidden).toBe(true);
});
