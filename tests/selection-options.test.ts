// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupSelectionTranslationControls } from "../src/options/selection-translation";
import { DEFAULT_SELECTION_TRANSLATION, formatSelectionShortcut } from "../src/shared/selection-translation";

function query<T extends Element>(selector: string): T {
  return document.querySelector<T>(selector)!;
}

function key(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  query<HTMLInputElement>("#selectionTranslationShortcut").dispatchEvent(event);
  return event;
}

describe("selection translation options", () => {
  let controls: ReturnType<typeof setupSelectionTranslationControls>;
  let input: HTMLInputElement;
  let showIcon: HTMLInputElement;
  let status: HTMLElement;
  let container: HTMLElement;

  beforeEach(() => {
    document.open();
    document.write(readFileSync(resolve(process.cwd(), "options.html"), "utf8"));
    document.close();
    container = query("#selectionTranslationSettings");
    controls = setupSelectionTranslationControls(container);
    input = query("#selectionTranslationShortcut");
    showIcon = query("#selectionTranslationShowIcon");
    status = query("#selectionTranslationStatus");
  });

  afterEach(() => { document.body.replaceChildren(); });

  it("keeps controls disabled until settings render and exposes accessible capture help", () => {
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(true);
    expect(showIcon.disabled).toBe(true);
    expect(query<HTMLButtonElement>("#clearSelectionTranslationShortcut").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#resetSelectionTranslationShortcut").disabled).toBe(true);
    expect(container.getAttribute("aria-busy")).toBe("true");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(input.getAttribute("aria-describedby")).toContain("selectionTranslationHelp");
    expect(query("#selectionTranslationHelp").textContent).toMatch(/浏览器或系统快捷键可能冲突/);
    expect(query("#selectionTranslationHelp").textContent).toContain("页面底部“保存”");
    expect(controls.read()).toEqual(DEFAULT_SELECTION_TRANSLATION);

    controls.render(undefined);
    expect(input.disabled).toBe(false);
    expect(showIcon.disabled).toBe(false);
    expect(container.getAttribute("aria-busy")).toBe("false");
    expect(container.hasAttribute("data-loading")).toBe(false);
    expect(controls.read()).toEqual(DEFAULT_SELECTION_TRANSLATION);
  });

  it("normalizes unknown values and renders the supplied icon and shortcut settings", () => {
    controls.render(null);
    expect(controls.read()).toEqual(DEFAULT_SELECTION_TRANSLATION);
    controls.render({ showIcon: false, shortcut: "Ctrl+Alt+Shift+Meta+9" });
    expect(showIcon.checked).toBe(false);
    expect(input.value).toBe(formatSelectionShortcut("Ctrl+Alt+Shift+Meta+9"));
    expect(controls.read()).toEqual({ showIcon: false, shortcut: "Ctrl+Alt+Shift+Meta+9" });
    showIcon.click();
    expect(controls.read().showIcon).toBe(true);
  });

  it("records canonical shortcuts only when focused and returns independent settings", () => {
    controls.render(undefined);
    key({ key: "k", ctrlKey: true });
    expect(controls.read().shortcut).toBe(DEFAULT_SELECTION_TRANSLATION.shortcut);
    input.focus();
    expect(key({ key: "k", ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }).defaultPrevented).toBe(true);
    expect(controls.read().shortcut).toBe("Ctrl+Alt+Shift+Meta+K");
    expect(input.value).toBe(formatSelectionShortcut("Ctrl+Alt+Shift+Meta+K"));
    const draft = controls.read();
    draft.shortcut = "";
    expect(controls.read().shortcut).toBe("Ctrl+Alt+Shift+Meta+K");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(status.textContent).toContain("保存");
  });

  it.each([
    { key: "k" },
    { key: "K", shiftKey: true },
    { key: "F2", altKey: true },
    { key: "t", ctrlKey: true }
  ])("rejects invalid or reserved captures without losing the prior value: %j", (init) => {
    controls.render(undefined);
    input.focus();
    key(init);
    expect(controls.read().shortcut).toBe(DEFAULT_SELECTION_TRANSLATION.shortcut);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(status.textContent).toContain("不可用");
  });

  it("waits for the rest of a chord without showing a modifier-only error", () => {
    controls.render(undefined);
    input.focus();
    key({ key: "Control", ctrlKey: true });
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(controls.read().shortcut).toBe(DEFAULT_SELECTION_TRANSLATION.shortcut);
    key({ key: "E", code: "KeyE", ctrlKey: true, shiftKey: true });
    expect(controls.read().shortcut).toBe("Ctrl+Shift+E");
  });

  it("allows Tab normally and Escape blurs without changing the shortcut", () => {
    controls.render(undefined);
    input.focus();
    expect(key({ key: "Tab" }).defaultPrevented).toBe(false);
    expect(key({ key: "Tab", shiftKey: true }).defaultPrevented).toBe(false);
    expect(key({ key: "Escape" }).defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(input);
    expect(controls.read()).toEqual(DEFAULT_SELECTION_TRANSLATION);
  });

  it.each(["Backspace", "Delete"])("clears with %s and removes validation errors", (name) => {
    controls.render(undefined);
    input.focus();
    key({ key: "k" });
    key({ key: name });
    expect(controls.read().shortcut).toBe("");
    expect(input.value).toBe(formatSelectionShortcut(""));
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(status.textContent).toContain("已清除");
  });

  it("clear and restore-default buttons update only local shortcut controls", () => {
    const settings = { showIcon: false, shortcut: "Ctrl+Alt+K" };
    controls.render(settings);
    input.focus();
    key({ key: "k" });
    query<HTMLButtonElement>("#clearSelectionTranslationShortcut").click();
    expect(controls.read()).toEqual({ showIcon: false, shortcut: "" });
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    input.focus();
    key({ key: "k" });
    query<HTMLButtonElement>("#resetSelectionTranslationShortcut").click();
    expect(controls.read()).toEqual({ showIcon: false, shortcut: DEFAULT_SELECTION_TRANSLATION.shortcut });
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(settings).toEqual({ showIcon: false, shortcut: "Ctrl+Alt+K" });
  });

  it("clears validation on valid capture and on render", () => {
    controls.render(undefined);
    input.focus();
    key({ key: "k" });
    key({ key: "7", altKey: true, shiftKey: true });
    expect(controls.read().shortcut).toBe("Alt+Shift+7");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    key({ key: "k" });
    controls.render({ showIcon: false, shortcut: "" });
    expect(controls.read()).toEqual({ showIcon: false, shortcut: "" });
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(status.textContent).toBe("");
  });
});
