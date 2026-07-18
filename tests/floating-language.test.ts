// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";

vi.mock("../src/content/runtime", () => ({
  sendRuntimeRequest: vi.fn()
}));

import { initFloatingBall, openDebugPanel } from "../src/content/floating";
import { sendRuntimeRequest } from "../src/content/runtime";
import { injectContentStyles } from "../src/content/styles";

describe("floating language controls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(sendRuntimeRequest).mockReset();
    document.documentElement.replaceChildren();
  });

  it("renders and saves the source-to-target language pair", async () => {
    let stored: ExtensionSettings = structuredClone(DEFAULT_SETTINGS);
    vi.mocked(sendRuntimeRequest).mockImplementation(async (request: RuntimeRequest) => {
      if (request.type === "GET_SETTINGS") return stored;
      if (request.type === "SAVE_SETTINGS") {
        stored = structuredClone(request.settings);
        return undefined;
      }
      return undefined;
    });
    vi.stubGlobal("chrome", {
      runtime: { id: "test" },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } }
    });

    initFloatingBall();
    const source = query<HTMLSelectElement>("[data-role='source-lang']");
    const target = query<HTMLSelectElement>("[data-role='target-lang']");
    const sourceValue = query<HTMLElement>("[data-role='source-lang-value']");
    const targetValue = query<HTMLElement>("[data-role='target-lang-value']");
    expect(source.options[0]?.textContent).toBe("自动检测");
    expect(target.value).toBe("zh-CN");
    expect(sourceValue.textContent).toBe("自动检测");
    expect(targetValue.textContent).toBe("中文");

    source.value = "en";
    target.value = "ko";
    source.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(stored).toMatchObject({ sourceLang: "en", targetLang: "ko" });
      expect(sourceValue.textContent).toBe("English");
      expect(targetValue.textContent).toBe("한국어");
    });
  });

  it("isolates the floating label from host button typography", () => {
    vi.mocked(sendRuntimeRequest).mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
    vi.stubGlobal("chrome", {
      runtime: { id: "test" },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } }
    });
    const hostStyle = document.createElement("style");
    hostStyle.textContent = `
      button { font-style: italic; transform: skewX(-18deg); text-transform: uppercase; }
      button > span { font-style: italic !important; transform: rotate(-12deg) !important; }
    `;
    document.documentElement.append(hostStyle);

    injectContentStyles();
    initFloatingBall();

    const ball = query<HTMLElement>("#wupage-floating-ball");
    const label = query<HTMLElement>(".wupage-floating-label");
    expect(ball.textContent).toBe("译");
    expect(getComputedStyle(label).fontStyle).toBe("normal");
    expect(getComputedStyle(label).transform).toBe("none");
    expect(getComputedStyle(label).writingMode).toBe("horizontal-tb");
  });

  it("isolates the floating menu from host form styles", () => {
    vi.mocked(sendRuntimeRequest).mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
    vi.stubGlobal("chrome", {
      runtime: { id: "test" },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } }
    });
    const hostStyle = document.createElement("style");
    hostStyle.textContent = `
      label {
        float: left;
        width: 180px;
        padding-top: 6px;
        text-align: right;
      }
      select {
        width: 160px !important;
        min-width: 160px !important;
        max-width: calc(100% - 20px) !important;
        padding: 4px !important;
        box-shadow: inset 0 1px 3px #000 !important;
        transform: translateY(8px) !important;
      }
      span {
        position: relative !important;
        top: 7px !important;
        margin-left: 12px !important;
      }
      button {
        text-align: center;
        text-shadow: 0 1px #fff;
        background: linear-gradient(#fff, #ddd);
      }
    `;
    document.documentElement.append(hostStyle);

    injectContentStyles();
    initFloatingBall();

    const menu = query<HTMLElement>("#wupage-floating-menu");
    const languageLabel = query<HTMLElement>(".wupage-language-select");
    const languageSelect = query<HTMLSelectElement>("[data-role='source-lang']");
    const languageValue = query<HTMLElement>("[data-role='source-lang-value']");
    const direction = query<HTMLElement>(".wupage-language-direction");
    const chevron = query<HTMLElement>(".wupage-language-chevron");
    const menuButton = query<HTMLButtonElement>("[data-action='page-toggle']");
    menu.hidden = false;

    expect(getComputedStyle(menu).boxSizing).toBe("border-box");
    expect(getComputedStyle(menu).width).toBe("240px");
    expect(getComputedStyle(languageLabel).float).toBe("none");
    expect(getComputedStyle(languageLabel).width).toBe("auto");
    expect(getComputedStyle(languageLabel).paddingTop).toBe("0px");
    expect(getComputedStyle(languageLabel).textAlign).toBe("left");
    expect(getComputedStyle(languageSelect).maxWidth).toBe("none");
    expect(getComputedStyle(languageSelect).boxShadow).toBe("none");
    expect(getComputedStyle(languageSelect).height).toBe("40px");
    expect(getComputedStyle(languageSelect).transform).toBe("none");
    expect(getComputedStyle(languageSelect).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(languageSelect).color).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(languageValue).display).toBe("flex");
    expect(getComputedStyle(languageValue).alignItems).toBe("center");
    expect(getComputedStyle(languageValue).justifyContent).toBe("center");
    expect(getComputedStyle(languageValue).textAlign).toBe("center");
    expect(getComputedStyle(direction).position).toBe("static");
    expect(getComputedStyle(direction).width).toBe("24px");
    expect(getComputedStyle(direction).height).toBe("40px");
    expect(getComputedStyle(direction).transform).toBe("none");
    expect(getComputedStyle(chevron).position).toBe("absolute");
    expect(getComputedStyle(chevron).marginLeft).toBe("0px");
    expect(getComputedStyle(menuButton).textAlign).toBe("left");
    expect(["none", "rgba(0, 0, 0, 0)"]).toContain(getComputedStyle(menuButton).textShadow);
  });

  it("resizes the debug panel from its bottom-right handle", async () => {
    vi.mocked(sendRuntimeRequest).mockResolvedValue({
      tasks: [],
      activeCount: 0,
      queuedCount: 0
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });

    await openDebugPanel();
    const panel = query<HTMLElement>("#wupage-debug-panel");
    const handle = query<HTMLElement>(".wupage-debug-resize");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 100,
      width: 360,
      height: 300,
      right: 460,
      bottom: 400,
      x: 100,
      y: 100,
      toJSON: () => ({})
    } as DOMRect);

    handle.dispatchEvent(pointerEvent("pointerdown", 460, 400));
    window.dispatchEvent(pointerEvent("pointermove", 560, 500));

    expect(panel.style.width).toBe("460px");
    expect(panel.style.height).toBe("400px");
    window.dispatchEvent(pointerEvent("pointerup", 560, 500));
    query<HTMLButtonElement>("[data-action='close-debug']").click();
  });
});

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function pointerEvent(type: string, clientX: number, clientY: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY }
  });
  return event;
}
