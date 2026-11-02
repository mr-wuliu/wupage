// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyboardShortcutController, initKeyboardShortcuts } from "../src/content/keyboard-shortcuts";
import { DEFAULT_SHORTCUTS } from "../src/shared/shortcuts";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/defaults";
import { sendRuntimeRequest } from "../src/content/runtime";
vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));

let controller: KeyboardShortcutController;
const execute = vi.fn();
function press(target: EventTarget = document.body, properties: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Y", code: "KeyY", altKey: true, shiftKey: true,
    bubbles: true, composed: true, cancelable: true, ...properties });
  target.dispatchEvent(event); return event;
}
beforeEach(() => {
  document.body.innerHTML = '<p id="text">Readable text</p><textarea></textarea><input><select></select><div contenteditable="true"><span id="edit">Editable text</span></div><div role="textbox" id="textbox"></div>';
  controller = new KeyboardShortcutController(execute);
});
afterEach(() => {
  controller.dispose(); window.dispatchEvent(new Event("pagehide")); document.body.replaceChildren();
  vi.resetAllMocks(); vi.unstubAllGlobals();
});

describe("configurable page keyboard shortcuts", () => {
  it("executes a configured browser or editing combination despite its advisory warning", () => {
    controller.update({ ...DEFAULT_SHORTCUTS, "toggle-page-translation": "Ctrl+C" });
    expect(press(document.body, { key: "c", code: "KeyC", ctrlKey: true, altKey: false, shiftKey: false }).defaultPrevented).toBe(true);
    expect(execute).toHaveBeenCalledWith("toggle-page-translation");
  });
  it("leaves a disabled key untouched and preserves its binding for reactivation", () => {
    controller.update(DEFAULT_SHORTCUTS, { "toggle-page-translation": false });
    expect(press().defaultPrevented).toBe(false); expect(execute).not.toHaveBeenCalled();
    press(document.body, { key: "Q", code: "KeyQ" });
    expect(execute).toHaveBeenLastCalledWith("translate-selection");
    controller.update(DEFAULT_SHORTCUTS, { "toggle-page-translation": true });
    expect(press().defaultPrevented).toBe(true);
    expect(execute).toHaveBeenLastCalledWith("toggle-page-translation");
  });
  it("waits for configuration and consumes only a matching combination", () => {
    expect(press().defaultPrevented).toBe(false); expect(execute).not.toHaveBeenCalled();
    controller.update(DEFAULT_SHORTCUTS);
    expect(press().defaultPrevented).toBe(true);
    expect(execute).toHaveBeenCalledWith("toggle-page-translation");
    expect(press(document.body, { code: "KeyJ", key: "J" }).defaultPrevented).toBe(false);
    expect(press(document.body, { altKey: false }).defaultPrevented).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("changes and clears bindings without leaving the old shortcut active", () => {
    controller.update({ ...DEFAULT_SHORTCUTS, "toggle-page-translation": "Alt+Shift+J" });
    expect(press().defaultPrevented).toBe(false);
    expect(press(document.body, { key: "J", code: "KeyJ" }).defaultPrevented).toBe(true);
    controller.update({ ...DEFAULT_SHORTCUTS, "toggle-page-translation": "" });
    expect(press(document.body, { key: "J", code: "KeyJ" }).defaultPrevented).toBe(false);
    expect(press().defaultPrevented).toBe(false); expect(execute).toHaveBeenCalledOnce();
  });
  it("uses physical letter keys and ignores held keys and composition", () => {
    controller.update(DEFAULT_SHORTCUTS);
    press(document.body, { key: "译" }); expect(execute).toHaveBeenCalledOnce();
    expect(press(document.body, { repeat: true }).defaultPrevented).toBe(true);
    expect(press(document.body, { isComposing: true }).defaultPrevented).toBe(false);
    const altGraph = new KeyboardEvent("keydown", { key: "Y", code: "KeyY", altKey: true, shiftKey: true, bubbles: true });
    vi.spyOn(altGraph, "getModifierState").mockReturnValue(true); document.body.dispatchEvent(altGraph);
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each(["textarea", "input", "select", "#edit", "#textbox"])("does not intercept typing in %s", selector => {
    controller.update(DEFAULT_SHORTCUTS);
    expect(press(document.querySelector(selector)!).defaultPrevented).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it("protects editable controls inside shadow roots and events the page already handled", () => {
    controller.update(DEFAULT_SHORTCUTS);
    const host = document.createElement("div"); const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<textarea></textarea>"; document.body.append(host);
    expect(press(root.querySelector("textarea")!).defaultPrevented).toBe(false);
    const event = new KeyboardEvent("keydown", { key: "Y", code: "KeyY", altKey: true, shiftKey: true, bubbles: true, cancelable: true });
    event.preventDefault(); document.body.dispatchEvent(event);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["textarea", "input", "#edit", "#textbox"])("runs only the input translation shortcut while typing in %s", selector => {
    controller.update(DEFAULT_SHORTCUTS);
    expect(press(document.querySelector(selector)!, { key: "K", code: "KeyK" }).defaultPrevented).toBe(true);
    expect(execute).toHaveBeenCalledWith("translate-input");
    expect(press(document.querySelector(selector)!).defaultPrevented).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("leaves the input translation key to the page when the feature or its shortcut is off", () => {
    controller.update(DEFAULT_SHORTCUTS, undefined, { enabled: false });
    expect(press(document.querySelector("textarea")!, { key: "K", code: "KeyK" }).defaultPrevented).toBe(false);
    controller.update(DEFAULT_SHORTCUTS, { "translate-input": false });
    expect(press(document.querySelector("textarea")!, { key: "K", code: "KeyK" }).defaultPrevented).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not run input translation inside the extension's own panels", () => {
    controller.update(DEFAULT_SHORTCUTS);
    document.body.insertAdjacentHTML("beforeend", '<div id="wupage-selection-tools"><textarea></textarea></div>');
    expect(press(document.querySelector("#wupage-selection-tools textarea")!, { key: "K", code: "KeyK" }).defaultPrevented).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it("stops listening when disposed", () => {
    controller.update(DEFAULT_SHORTCUTS); controller.dispose(); press(); expect(execute).not.toHaveBeenCalled();
  });
  it("does not replace a saved update with an older initial settings response", async () => {
    controller.dispose();
    let changed!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
    let finish!: (value: unknown) => void;
    vi.mocked(sendRuntimeRequest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal("chrome", { runtime: { id: "test" }, storage: { onChanged: {
      addListener: (listener: typeof changed) => { changed = listener; }, removeListener: vi.fn()
    } } });
    initKeyboardShortcuts(execute);
    changed({ [SETTINGS_KEY]: { newValue: { shortcuts: { ...DEFAULT_SHORTCUTS, "toggle-page-translation": "Alt+Shift+J" } } } }, "local");
    finish(DEFAULT_SETTINGS); await Promise.resolve();
    press(); expect(execute).not.toHaveBeenCalled();
    press(document.body, { key: "J", code: "KeyJ" }); expect(execute).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("pagehide"));
    press(document.body, { key: "J", code: "KeyJ" }); expect(execute).toHaveBeenCalledOnce();
  });
});
