// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSelectionSource, replaceSelectionSource, selectionReplacementAvailable, selectionSourceUnchanged } from "../src/content/selection-source";

beforeEach(() => { document.body.innerHTML = '<input value="before selected phrase after"><p>public prose</p>'; });
afterEach(() => { vi.restoreAllMocks(); window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

function control() { return document.querySelector("input")!; }
function capture(start = 7, end = 22) {
  control().focus(); control().setSelectionRange(start, end);
  return captureSelectionSource()!;
}

describe("editable selection sources", () => {
  it.each(["text", "search", "url", "tel"])("captures %s inputs independently of the document selection", type => {
    control().type = type;
    expect(capture().text).toBe("selected phrase");
  });
  it.each(["password", "number", "email"])("does not fall back to stale prose when a %s input is focused", type => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector("p")!);
    window.getSelection()!.addRange(range); control().type = type; control().focus();
    expect(captureSelectionSource()).toBeUndefined();
  });
  it("uses native field edits without invoking an overridden value setter and emits one input notification", () => {
    const source = capture();
    const setter = vi.fn();
    Object.defineProperty(control(), "value", { configurable: true,
      get: () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.get!.call(control()), set: setter });
    const input = vi.fn(); control().addEventListener("input", input);
    replaceSelectionSource(source, "译文");
    expect(control().value).toBe("before 译文 after");
    expect(setter).not.toHaveBeenCalled(); expect(input).toHaveBeenCalledOnce();
    expect(input.mock.calls[0][0]).toMatchObject({ data: "译文", inputType: "insertReplacementText", bubbles: true, composed: true });
  });
  it("retains surrounding selected whitespace and converts single-line translation breaks to spaces", () => {
    const source = capture(6, 23);
    replaceSelectionSource(source, "第一行\n第二行");
    expect(control().value).toBe("before 第一行 第二行 after");
  });
  it("preserves text-area newlines outside and inside the replacement", () => {
    document.body.innerHTML = '<textarea>before\nselected phrase\nafter</textarea>';
    const field = document.querySelector("textarea")!;
    field.focus(); field.setSelectionRange(7, 22);
    replaceSelectionSource(captureSelectionSource()!, "第一行\n第二行");
    expect(field.value).toBe("before\n第一行\n第二行\nafter");
  });
  it("rejects programmatic changes, read-only transitions and sensitive type changes", () => {
    const source = capture();
    control().value = "new draft";
    expect(() => replaceSelectionSource(source, "译文")).toThrow("原文已变化");
    control().value = "before selected phrase after"; control().readOnly = true;
    expect(selectionReplacementAvailable(source)).toBe(false);
    control().readOnly = false; control().type = "password";
    expect(selectionSourceUnchanged(source)).toBe(false);
  });
  it("checks maxlength before changing the field", () => {
    const source = capture(); control().maxLength = 14;
    expect(() => replaceSelectionSource(source, "很长的译文")).toThrow("长度限制");
    expect(control().value).toBe("before selected phrase after");
  });
  it("allows beforeinput cancellation without writing or sending an input event", () => {
    const source = capture(); const input = vi.fn();
    control().addEventListener("beforeinput", event => event.preventDefault()); control().addEventListener("input", input);
    expect(() => replaceSelectionSource(source, "译文")).toThrow("阻止了替换");
    expect(control().value).toBe("before selected phrase after"); expect(input).not.toHaveBeenCalled();
  });
  it("rechecks focus, selected offsets and content after page event handlers", () => {
    const source = capture();
    control().addEventListener("beforeinput", () => control().setSelectionRange(0, 2));
    expect(() => replaceSelectionSource(source, "译文")).toThrow("原文已变化");
    expect(control().value).toBe("before selected phrase after");
  });
  it("restores saved offsets even if card focus or keyboard navigation moved the caret", () => {
    const source = capture(); control().setSelectionRange(0, 0); control().blur();
    replaceSelectionSource(source, "译文");
    expect(control().value).toBe("before 译文 after");
  });
  it("keeps complex editor selections available for translation while disabling replacement", () => {
    document.body.innerHTML = '<div contenteditable="true" class="ProseMirror"><p>selected phrase</p></div>';
    const range = document.createRange(); range.selectNodeContents(document.querySelector("p")!);
    window.getSelection()!.addRange(range);
    const source = captureSelectionSource()!;
    expect(source.text).toBe("selected phrase"); expect(selectionReplacementAvailable(source)).toBe(false);
  });
  it("invalidates saved ranges after editor formatting changes", () => {
    document.body.innerHTML = '<div contenteditable="true"><span>selected phrase</span></div>';
    const range = document.createRange(); range.selectNodeContents(document.querySelector("span")!);
    window.getSelection()!.addRange(range);
    const source = captureSelectionSource()!;
    expect(selectionSourceUnchanged(source)).toBe(true);
    document.querySelector("span")!.setAttribute("style", "font-weight:bold");
    expect(selectionSourceUnchanged(source)).toBe(false);
  });
});
