// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSelectionSource, replaceSelectionSource, selectionReplacementAvailable, selectionSourceUnchanged } from "../src/content/selection-source";

beforeEach(() => { document.body.innerHTML = '<input value="before selected phrase after"><p>public prose</p>'; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

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

describe("component selection sources", () => {
  it.each(["open", "closed", "legacy-options"])("resolves an unfocused nested %s selection without collecting surrounding text", mode => {
    const host = document.createElement("bili-comments"); document.body.append(host);
    const first = host.attachShadow({ mode: mode === "closed" ? "closed" : "open" });
    const inner = document.createElement("bili-rich-text"); first.append(inner);
    const second = inner.attachShadow({ mode: mode === "closed" ? "closed" : "open" });
    second.innerHTML = '<p>before <span>selected comment text</span> after</p><p>Unselected private text</p>';
    const text = second.querySelector("span")!.firstChild!;
    const knownRoots = new Map<Element, ShadowRoot>([[host, first], [inner, second]]);
    vi.stubGlobal("chrome", { runtime: { id: "test" }, dom: { openOrClosedShadowRoot: (element: Element) => knownRoots.get(element) ?? null } });
    const scopes: ShadowRoot[][] = [];
    const read = vi.fn((...args: unknown[]) => {
      if (mode === "legacy-options" && !(args[0] instanceof ShadowRoot) && args.length) throw new TypeError("Expected ShadowRoot");
      const roots = mode === "legacy-options" ? args as ShadowRoot[] : (args[0] as GetComposedRangesOptions).shadowRoots!;
      scopes.push([...roots]);
      if (roots.includes(second)) return [new StaticRange({ startContainer: text, startOffset: 0, endContainer: text, endOffset: text.textContent!.length })];
      if (roots.includes(first)) return [new StaticRange({ startContainer: first, startOffset: 0, endContainer: first, endOffset: 1 })];
      const index = [...document.body.childNodes].indexOf(host);
      return [new StaticRange({ startContainer: document.body, startOffset: index, endContainer: document.body, endOffset: index + 1 })];
    });
    const oldRange = document.createRange(); oldRange.setStartBefore(host); oldRange.collapse(true);
    const getRangeAt = vi.fn(() => oldRange);
    vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: true, rangeCount: 1, getRangeAt, getComposedRanges: read } as unknown as Selection);
    const source = captureSelectionSource();
    expect(source).toMatchObject({ kind: "range", text: "selected comment text", startNode: text, endNode: text });
    expect(scopes).toEqual([[], [first], [first, second]]);
    expect(getRangeAt).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    expect(second.querySelector("p")!.textContent).toBe("before selected comment text after");
  });

  it("retains precise offsets and formatting inside a component", () => {
    const host = document.createElement("comment-content"); document.body.append(host);
    const tree = host.attachShadow({ mode: "open" }); tree.innerHTML = '<p>before <b>selected phrase</b> after</p>';
    const start = tree.querySelector("b")!.firstChild!, end = tree.querySelector("p")!.lastChild!;
    const snapshot = new StaticRange({ startContainer: start, startOffset: 3, endContainer: end, endOffset: 3 });
    vi.spyOn(window, "getSelection").mockReturnValue({ rangeCount: 1, isCollapsed: true, getComposedRanges: () => [snapshot] } as unknown as Selection);
    expect(captureSelectionSource()?.text).toBe("ected phrase af");
    expect(tree.innerHTML).toBe('<p>before <b>selected phrase</b> after</p>');
  });

  it("rejects endpoints in different component trees instead of collapsing or broadening the selection", () => {
    const one = document.createElement("comment-one"), two = document.createElement("comment-two"); document.body.append(one, two);
    const a = one.attachShadow({ mode: "open" }), b = two.attachShadow({ mode: "open" });
    a.textContent = "First comment"; b.textContent = "Second comment";
    const snapshot = new StaticRange({ startContainer: a.firstChild!, startOffset: 2, endContainer: b.firstChild!, endOffset: 4 });
    vi.spyOn(window, "getSelection").mockReturnValue({ rangeCount: 1, getComposedRanges: () => [snapshot] } as unknown as Selection);
    expect(captureSelectionSource()).toBeUndefined();
  });

  it("does not fall back to surrounding prose if the composed selection is unavailable", () => {
    const range = document.createRange(); range.selectNodeContents(document.body);
    const getRangeAt = vi.fn(() => range);
    vi.spyOn(window, "getSelection").mockReturnValue({ rangeCount: 1, isCollapsed: false, getRangeAt,
      getComposedRanges: () => { throw new Error("Selection changed"); } } as unknown as Selection);
    expect(captureSelectionSource()).toBeUndefined(); expect(getRangeAt).not.toHaveBeenCalled();
  });

  it("keeps password controls and multiple selections excluded before reading component text", () => {
    const read = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({ rangeCount: 2, getComposedRanges: read } as unknown as Selection);
    expect(captureSelectionSource()).toBeUndefined();
    control().type = "password"; control().focus(); control().select();
    expect(captureSelectionSource()).toBeUndefined(); expect(read).not.toHaveBeenCalled();
  });
});
