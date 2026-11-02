// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRequest } from "../src/shared/types";

const send = vi.hoisted(() => vi.fn());
vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: send }));

let translateFocusedInput: typeof import("../src/content/input-translation").translateFocusedInput;
const notice = () => document.getElementById("wupage-shortcut-notice")?.shadowRoot?.querySelector("p");
const execCommand = vi.fn((_command: string, _ui?: boolean, _value?: string) => false);
const sent = () => send.mock.calls.map(([request]) => request as RuntimeRequest);

// jsdom has no isContentEditable, execCommand, DataTransfer or ClipboardEvent.
const editable = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "isContentEditable");
class FakeDataTransfer {
  private items = new Map<string, string>();
  setData(type: string, value: string): void { this.items.set(type, value); }
  getData(type: string): string { return this.items.get(type) ?? ""; }
}
class FakeClipboardEvent extends Event {
  clipboardData: FakeDataTransfer | null;
  constructor(type: string, init: EventInit & { clipboardData?: FakeDataTransfer }) { super(type, init); this.clipboardData = init.clipboardData ?? null; }
}
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", { configurable: true, get(this: HTMLElement) {
    const host = this.closest("[contenteditable]"); return Boolean(host) && host!.getAttribute("contenteditable") !== "false";
  } });
});
afterAll(() => { if (editable) Object.defineProperty(HTMLElement.prototype, "isContentEditable", editable); else delete (HTMLElement.prototype as { isContentEditable?: boolean }).isContentEditable; });

beforeEach(async () => {
  vi.resetModules();
  send.mockReset();
  execCommand.mockReset().mockReturnValue(false);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  vi.stubGlobal("DataTransfer", FakeDataTransfer);
  vi.stubGlobal("ClipboardEvent", FakeClipboardEvent);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  translateFocusedInput = (await import("../src/content/input-translation")).translateFocusedInput;
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  document.body.replaceChildren(); document.getElementById("wupage-shortcut-notice")?.remove();
  window.getSelection()?.removeAllRanges();
});

function translateTo(translation: string): void {
  send.mockImplementation(async () => ({ translation, providerLabel: "OA" }));
}
function selectContents(node: Node): void {
  const range = document.createRange(); range.selectNodeContents(node);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
}

describe("text fields", () => {
  it("translates only the selected part of a textarea and writes through the native setter when insertText is unavailable", async () => {
    document.body.innerHTML = "<textarea>keep 你好 keep</textarea>";
    const field = document.querySelector("textarea")!;
    field.focus(); field.setSelectionRange(5, 7);
    const input = vi.fn(); field.addEventListener("input", input);
    translateTo("Hello");
    await translateFocusedInput();
    expect(sent()).toEqual([{ type: "TRANSLATE_INPUT", text: "你好" }]);
    expect(field.value).toBe("keep Hello keep");
    expect(input).toHaveBeenCalledOnce();
    expect(notice()?.textContent).toContain("已用 OA 翻译");
  });
  it("uses insertText over the whole value without a selection so the browser undo stack is kept", async () => {
    document.body.innerHTML = '<input type="text" value="你好世界">';
    const field = document.querySelector("input")!;
    field.focus(); field.setSelectionRange(4, 4);
    execCommand.mockImplementation(() => { expect([field.selectionStart, field.selectionEnd]).toEqual([0, 4]); return true; });
    translateTo("Hello world");
    await translateFocusedInput();
    expect(sent()).toEqual([{ type: "TRANSLATE_INPUT", text: "你好世界" }]);
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "Hello world");
  });
  it("skips non-text fields and explains what to do without falling back to page translation", async () => {
    document.body.innerHTML = '<input type="password" value="secret">';
    document.querySelector("input")!.focus();
    await translateFocusedInput();
    expect(send).not.toHaveBeenCalled();
    expect(notice()?.textContent).toContain("请先点击要翻译的输入框");
    expect(notice()?.dataset.error).toBe("true");
  });
  it("rejects empty and oversized text before sending it", async () => {
    document.body.innerHTML = "<textarea>   </textarea>";
    document.querySelector("textarea")!.focus();
    await translateFocusedInput();
    expect(notice()?.textContent).toContain("没有可翻译");
    document.querySelector("textarea")!.value = "x".repeat(8001);
    await translateFocusedInput();
    expect(notice()?.textContent).toContain("上限 8000 字符");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("rich-text editors", () => {
  const slate = '<div id="editor" contenteditable="true" tabindex="0"><div>第一行​</div><div><br></div><div>第三行 <img alt=":smile:"></div></div>';

  it("keeps the line structure of one-div-per-line editors", async () => {
    document.body.innerHTML = slate;
    document.getElementById("editor")!.focus();
    translateTo("Line 1\n\nLine 3");
    vi.useFakeTimers();
    const pending = translateFocusedInput();
    await vi.advanceTimersByTimeAsync(200); await pending;
    expect(sent()).toEqual([{ type: "TRANSLATE_INPUT", text: "第一行\n\n第三行 :smile:" }]);
  });
  it("hands the translation to an editor's paste handler after the selection settles, without execCommand", async () => {
    document.body.innerHTML = slate;
    const editor = document.getElementById("editor")!;
    editor.focus();
    const pasted: string[] = [];
    editor.addEventListener("paste", event => {
      pasted.push((event as unknown as FakeClipboardEvent).clipboardData!.getData("text/plain"));
      // The editor reads the selection it will replace.
      expect(window.getSelection()!.toString()).toContain("第一行");
      event.preventDefault();
    });
    translateTo("Line 1\n\nLine 3");
    vi.useFakeTimers();
    const pending = translateFocusedInput();
    await vi.advanceTimersByTimeAsync(100);
    expect(pasted).toEqual([]);
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(pasted).toEqual(["Line 1\n\nLine 3"]);
    expect(execCommand).not.toHaveBeenCalled();
  });
  it("falls back to insertText when the page leaves the paste unhandled", async () => {
    document.body.innerHTML = '<div id="editor" contenteditable="true" tabindex="0"><p>hello <b>world</b></p></div>';
    const editor = document.getElementById("editor")!;
    editor.focus(); selectContents(editor.querySelector("b")!);
    execCommand.mockReturnValue(true);
    translateTo("世界");
    vi.useFakeTimers();
    const pending = translateFocusedInput();
    await vi.advanceTimersByTimeAsync(200); await pending;
    expect(sent()).toEqual([{ type: "TRANSLATE_INPUT", text: "world" }]);
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "世界");
  });
  it("edits the DOM directly when neither paste nor insertText is handled", async () => {
    document.body.innerHTML = '<div id="editor" contenteditable="true" tabindex="0">bonjour</div>';
    const editor = document.getElementById("editor")!;
    editor.focus();
    const input = vi.fn(); editor.addEventListener("input", input);
    vi.stubGlobal("DataTransfer", undefined);
    translateTo("你好");
    vi.useFakeTimers();
    const pending = translateFocusedInput();
    await vi.advanceTimersByTimeAsync(200); await pending;
    expect(editor.textContent).toBe("你好");
    expect(input).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith("[wupage] synthetic paste unavailable", expect.anything());
  });
});

describe("request lifecycle", () => {
  it("does not write into a field the page removed while the model was answering", async () => {
    document.body.innerHTML = "<textarea>你好</textarea>";
    const field = document.querySelector("textarea")!;
    field.focus();
    send.mockImplementation(async () => { field.remove(); return { translation: "Hello", providerLabel: "OA" }; });
    await translateFocusedInput();
    expect(field.value).toBe("你好");
    expect(notice()?.textContent).toContain("输入框已被移除");
  });
  it("ignores a second press while a translation is running", async () => {
    document.body.innerHTML = "<textarea>你好</textarea>";
    document.querySelector("textarea")!.focus();
    let finish!: (value: unknown) => void;
    send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = translateFocusedInput();
    await translateFocusedInput();
    expect(send).toHaveBeenCalledOnce();
    finish({ translation: "Hello", providerLabel: "OA" }); await first;
    expect(document.querySelector("textarea")!.value).toBe("Hello");
  });
  it("shows the service error, such as a missing LLM", async () => {
    document.body.innerHTML = "<textarea>你好</textarea>";
    document.querySelector("textarea")!.focus();
    send.mockRejectedValue(new Error("输入框翻译需要大模型服务，请先在设置中配置。"));
    await translateFocusedInput();
    expect(notice()?.textContent).toContain("需要大模型服务");
    expect(document.querySelector("textarea")!.value).toBe("你好");
  });
});
