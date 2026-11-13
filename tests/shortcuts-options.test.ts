// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupShortcutSettings } from "../src/options/shortcuts";
import { DEFAULT_SHORTCUTS, DEFAULT_SHORTCUT_ENABLED, TRANSLATION_SHORTCUTS, type TranslationShortcut } from "../src/shared/shortcuts";

let root: HTMLElement;
let controls: ReturnType<typeof setupShortcutSettings>;
beforeEach(() => {
  const html = new DOMParser().parseFromString(readFileSync(resolve(process.cwd(), "options.html"), "utf8"), "text/html");
  document.body.replaceChildren(html.querySelector("#shortcutSettings")!);
  root = document.querySelector("#shortcutSettings")!; root.hidden = false;
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.restoreAllMocks(); document.body.replaceChildren();
});
const binding = (name: TranslationShortcut = "toggle-page-translation") => root.querySelector<HTMLInputElement>(`[data-command='${name}']`)!;
function mount(value: unknown = DEFAULT_SHORTCUTS): void { controls = setupShortcutSettings(root); controls.render(value); }
function press(key: string, code = key, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...modifiers });
  document.activeElement!.dispatchEvent(event); return event;
}
const altShift = { altKey: true, shiftKey: true };

describe("in-page shortcut editor", () => {
  it("switches every action independently, preserves bindings and restores defaults", () => {
    mount(); expect(root.querySelectorAll("[role='switch']")).toHaveLength(8);
    const toggle = root.querySelector<HTMLButtonElement>("[data-shortcut-toggle='toggle-page-translation']")!;
    toggle.click();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(controls.read()["toggle-page-translation"]).toBe("Alt+Shift+Y");
    expect(controls.readEnabled()["translate-selection"]).toBe(true);
    controls.render(controls.read(), controls.readEnabled());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click(); expect(toggle.getAttribute("aria-checked")).toBe("true");
    root.querySelector<HTMLButtonElement>("[data-shortcut-toggle='selection-submit']")!.click();
    expect(controls.readEnabled()["selection-submit"]).toBe(false);
    controls.reset();
    expect(controls.readEnabled()).toEqual(DEFAULT_SHORTCUT_ENABLED);
  });
  it.each(TRANSLATION_SHORTCUTS)("keeps an empty $name disabled until a binding is explicitly assigned", ({ name }) => {
    mount(); binding(name).focus(); press("Delete");
    const toggle = root.querySelector<HTMLButtonElement>(`[data-shortcut-toggle='${name}']`)!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toContain("请先设置快捷键");
    toggle.click(); toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(controls.read()[name]).toBe("");
    expect(controls.readEnabled()[name]).toBe(false);
    binding(name).focus(); press("j", "KeyJ", altShift);
    expect(toggle.disabled).toBe(false);
    expect(controls.read()[name]).toBe("Alt+Shift+J");
    toggle.click(); expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click(); expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
  it("does not restore or validate a conflicting default when an empty switch is clicked", () => {
    mount({ ...DEFAULT_SHORTCUTS, "translate-selection": "Alt+Shift+L", "toggle-paragraph-mode": "" });
    const toggle = root.querySelector<HTMLButtonElement>("[data-shortcut-toggle='toggle-paragraph-mode']")!;
    expect(toggle.disabled).toBe(true);
    toggle.click();
    expect(controls.read()["toggle-paragraph-mode"]).toBe("");
    expect(binding("toggle-paragraph-mode").hasAttribute("aria-invalid")).toBe(false);
    expect(root.querySelector("#shortcut-error-toggle-paragraph-mode")?.textContent).toBe("");
    controls.render(controls.read(), { ...DEFAULT_SHORTCUT_ENABLED, "toggle-paragraph-mode": true });
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
  it("loads saved values, supports explicit empty bindings and waits for settings before editing", () => {
    controls = setupShortcutSettings(root);
    expect(binding().disabled).toBe(true);
    controls.render({ ...DEFAULT_SHORTCUTS, "toggle-page-translation": "Alt+Shift+J", "translate-selection": "" });
    expect(binding().value).toBe("Alt＋Shift＋J");
    expect(binding("translate-selection").value).toBe("");
    expect(binding("translate-selection").placeholder).toBe("未设置");
    expect(root.querySelectorAll("#shortcutBindings .shortcut-row")).toHaveLength(4);
    expect(root.querySelector("#manageShortcuts")).toBeNull();
  });
  it("records a physical key into a draft without calling browser APIs", () => {
    mount(); binding().focus();
    expect(binding().placeholder).toContain("按下");
    const event = press("j", "KeyJ", altShift);
    expect(event.defaultPrevented).toBe(true);
    expect(binding().value).toBe("Alt＋Shift＋J");
    expect(controls.read()["toggle-page-translation"]).toBe("Alt+Shift+J");
    expect(root.querySelector("#shortcutStatus")?.textContent).toContain("保存");
  });
  it("rejects duplicates and lets Escape cancel without changing the original value", () => {
    mount(); binding().focus(); press("Q", "KeyQ", altShift);
    expect(root.querySelector("#shortcutStatus")?.textContent).toContain("已用于");
    expect(binding().getAttribute("aria-invalid")).toBe("true");
    expect(controls.read()["toggle-page-translation"]).toBe(DEFAULT_SHORTCUTS["toggle-page-translation"]);
    press("Escape");
    expect(binding().value).toBe("Alt＋Shift＋Y");
    expect(binding().hasAttribute("aria-invalid")).toBe(false);
  });
  it("clears with Delete and restores an individual default", () => {
    mount(); binding().focus(); press("Delete");
    expect(controls.read()["toggle-page-translation"]).toBe("");
    root.querySelector<HTMLButtonElement>('[aria-label="恢复翻译全文 / 恢复原文默认快捷键"]')!.click();
    expect(binding().value).toBe("Alt＋Shift＋Y");
    expect(root.querySelector<HTMLButtonElement>("[data-shortcut-toggle='toggle-page-translation']")!.disabled).toBe(false);
    binding().focus(); press("Delete");
    expect(binding().value).toBe("");
  });
  it.each([
    ["y", "KeyY", {}, "Y", "Y"],
    ["?", "Slash", { shiftKey: true }, "Shift+Slash", "Shift＋/"],
    ["Delete", "NumpadDecimal", {}, "NumpadDecimal", "Num Decimal"],
    ["K", "KeyK", { ctrlKey: true, shiftKey: true, altKey: true, metaKey: true }, "Ctrl+Alt+Shift+Meta+K", "Ctrl＋Alt＋Shift＋Win＋K"]
  ])("records %s from %s with %j", (key, code, modifiers, value, label) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    mount(); binding().focus(); press(key, code, modifiers);
    expect(binding().hasAttribute("aria-invalid")).toBe(false);
    expect(binding().value).toBe(label);
    expect(controls.read()["toggle-page-translation"]).toBe(value);
  });
  it("allows special keys to be assigned while keeping Tab navigation and Delete clearing in the normal recorder", () => {
    mount(); const input = binding();
    const special = input.parentElement!.querySelector<HTMLButtonElement>(".shortcut-special-keys")!;
    expect(special.hidden).toBe(true);
    input.focus();
    expect(press("Tab").defaultPrevented).toBe(false);
    special.focus(); expect(special.hidden).toBe(false);
    special.click(); expect(document.activeElement).toBe(input);
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(controls.read()["toggle-page-translation"]).toBe("Tab");
    expect(special.hidden).toBe(true);
    input.focus(); special.click(); press("Delete");
    expect(controls.read()["toggle-page-translation"]).toBe("Delete");
    input.focus(); press("Delete");
    expect(controls.read()["toggle-page-translation"]).toBe("");
  });
  it.each([
    ["c", "KeyC", { ctrlKey: true }, "Ctrl+C"],
    ["t", "KeyT", { ctrlKey: true }, "Ctrl+T"],
    ["j", "KeyJ", { ctrlKey: true, altKey: true }, "Ctrl+Alt+J"]
  ])("accepts %s with a persistent inline warning instead of an error", (key, code, modifiers, value) => {
    mount(); binding().focus(); press(key, code, modifiers);
    expect(binding().hasAttribute("aria-invalid")).toBe(false);
    expect(controls.read()["toggle-page-translation"]).toBe(value);
    const message = root.querySelector("#shortcut-error-toggle-page-translation")!;
    expect(message.textContent).toContain("可能与");
    expect(document.activeElement).not.toBe(binding());
    controls.render(controls.read(), controls.readEnabled());
    expect(controls.read()["toggle-page-translation"]).toBe(value);
    expect(message.textContent).toContain("可能与");
    binding().focus(); press("j", "KeyJ", altShift);
    expect(message.textContent).toBe("");
  });
  it("ignores modifier-only, composition and repeat events and allows Tab navigation", () => {
    mount(); binding().focus();
    press("Alt", "AltLeft", { altKey: true });
    press("j", "KeyJ", { ...altShift, isComposing: true });
    press("j", "KeyJ", { ...altShift, repeat: true });
    expect(controls.read()).toEqual(DEFAULT_SHORTCUTS);
    expect(press("Tab").defaultPrevented).toBe(false);
    expect(binding().hasAttribute("aria-invalid")).toBe(false);
  });
  it("restores all defaults and returns independent draft snapshots", () => {
    mount({ ...DEFAULT_SHORTCUTS, "translate-selection": "" });
    const snapshot = controls.read(); snapshot["toggle-page-translation"] = "";
    expect(controls.read()["toggle-page-translation"]).not.toBe("");
    controls.reset();
    expect(controls.read()).toEqual(DEFAULT_SHORTCUTS);
  });
  it("checks conflicts even when restoring one default", () => {
    mount({ ...DEFAULT_SHORTCUTS, "toggle-page-translation": "Alt+Shift+J", "translate-selection": "Alt+Shift+Y" });
    root.querySelector<HTMLButtonElement>('[aria-label="恢复翻译全文 / 恢复原文默认快捷键"]')!.click();
    expect(controls.read()["toggle-page-translation"]).toBe("Alt+Shift+J");
    expect(root.querySelector("#shortcutStatus")?.textContent).toContain("已用于");
  });
  it("displays platform modifiers on macOS", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    mount({ ...DEFAULT_SHORTCUTS, "toggle-page-translation": "Shift+Meta+Y" });
    expect(binding().value).toBe("Shift＋Command＋Y");
    expect(root.querySelector<HTMLInputElement>('[data-local-command="selection-submit"]')?.value).toBe("Command＋Enter");
  });
  it("edits paragraph modifiers and scoped bindings, validates conflicts, clears and restores defaults", () => {
    mount();
    const modifier = root.querySelector<HTMLSelectElement>('[data-local-command="paragraph-click"]')!;
    modifier.value = "Alt+Shift"; modifier.dispatchEvent(new Event("change"));
    expect(controls.readLocal()["paragraph-click"]).toBe("Alt+Shift");
    const submit = root.querySelector<HTMLInputElement>('[data-local-command="selection-submit"]')!;
    submit.focus(); press("Enter", "Enter", { altKey: true });
    expect(controls.readLocal()["selection-submit"]).toBe("Alt+Enter");
    submit.focus(); press("Y", "KeyY", altShift);
    expect(submit.getAttribute("aria-invalid")).toBe("true"); press("Escape");
    expect(controls.readLocal()["selection-submit"]).toBe("Alt+Enter");
    submit.focus(); press("Delete");
    expect(controls.readEnabled()["selection-submit"]).toBe(false);
    root.querySelector<HTMLButtonElement>('[aria-label="恢复提交划词原文默认快捷键"]')!.click();
    expect(controls.readLocal()["selection-submit"]).toBe("Primary+Enter");
    expect(controls.readEnabled()["selection-submit"]).toBe(true);
    const dismiss = root.querySelector<HTMLInputElement>('[data-local-command="dismiss-overlays"]')!;
    dismiss.focus(); press("Enter", "Enter", { altKey: true });
    dismiss.focus(); dismiss.parentElement!.querySelector<HTMLButtonElement>(".shortcut-special-keys")!.click(); press("Escape");
    expect(controls.readLocal()["dismiss-overlays"]).toBe("Escape");
    controls.reset();
    expect(controls.readLocal()["paragraph-click"]).toBe("Ctrl");
  });
});
