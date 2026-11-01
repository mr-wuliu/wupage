// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionTranslationController } from "../src/content/selection-translation";
import { sendRuntimeRequest } from "../src/content/runtime";
import type { DictionaryEntry } from "../src/shared/dictionary";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";

vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: vi.fn() }));
let controller: SelectionTranslationController;
const entry: DictionaryEntry = { provider: "youdao", query: "example", word: "example", sourceUrl: "https://dict.youdao.com/result?word=example",
  pronunciations: [{ accent: "uk", phonetic: "ɪɡˈzɑːmpəl", audioUrl: "https://dict.youdao.com/dictvoice?audio=example&type=1" }],
  meanings: [{ partOfSpeech: "n.", definition: "例子；范例" }] };
const translationSettings = { ...DEFAULT_SETTINGS, sourceLang: "en" };

function root() { return document.getElementById("wupage-selection-tools")!.shadowRoot!; }
function card() { return root().querySelector<HTMLElement>(".card")!; }
function source() { return root().querySelector<HTMLTextAreaElement>(".word")!; }
function edit(value: string) { source().focus(); source().value = value; source().dispatchEvent(new Event("input", { bubbles: true, composed: true })); }
function submit() { root().querySelector<HTMLButtonElement>(".submit-source")!.click(); }
function select(id = "first") {
  const range = document.createRange(); range.selectNodeContents(document.getElementById(id)!);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
}
async function show() { select(); await vi.waitFor(() => expect(root().querySelector(".trigger-dot,.trigger-line")).not.toBeNull()); }
function open() { root().querySelector<HTMLButtonElement>(".trigger-dot,.trigger-line")!.click(); }

beforeEach(() => {
  document.body.innerHTML = '<p id="first">example</p><p id="second">running</p><textarea></textarea><p id="editable" contenteditable="true">secret</p>';
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: vi.fn(() => [new DOMRect(100, 50, 70, 20)]) });
  vi.mocked(sendRuntimeRequest).mockImplementation(async request => {
    if (request.type === "GET_SETTINGS") return translationSettings;
    if (request.type === "TRANSLATE_BATCH") return { translations: ["翻译结果"], cached: 0 };
    return entry;
  });
  controller = new SelectionTranslationController({ enabled: true, provider: "youdao", style: "dot" });
});
afterEach(() => {
  controller.dispose(); window.getSelection()?.removeAllRanges(); document.body.replaceChildren();
  delete (Range.prototype as Partial<Range>).getClientRects; vi.restoreAllMocks(); vi.mocked(sendRuntimeRequest).mockReset();
});

describe("selection dictionary UI", () => {
  it("rejects a selection that crosses an editor even when both endpoints are ordinary prose", () => {
    document.body.innerHTML = '<main><p id="start">Public introduction.</p><div contenteditable="plaintext-only">Private unsent draft.</div><p id="end">Public conclusion.</p></main>';
    const range = document.createRange();
    range.setStart(document.querySelector("#start")!.firstChild!, 0);
    range.setEnd(document.querySelector("#end")!.firstChild!, 18);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    expect(() => controller.openFromShortcut()).toThrow("输入框和编辑区");
    expect(sendRuntimeRequest).not.toHaveBeenCalled();
  });
  it("applies custom submission and dismissal immediately without intercepting normal editor input", async () => {
    await show(); open(); await vi.waitFor(() => expect(card().hidden).toBe(false));
    controller.updateShortcuts(undefined, { "selection-submit": "Alt+Enter", "dismiss-overlays": "Alt+Escape" });
    edit("Another sentence for translation.");
    vi.mocked(sendRuntimeRequest).mockClear();
    source().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(sendRuntimeRequest).not.toHaveBeenCalled();
    source().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(sendRuntimeRequest).toHaveBeenCalledWith(expect.objectContaining({ type: "TRANSLATE_BATCH" })));
    source().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(card().hidden).toBe(false);
    source().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", altKey: true, isComposing: true, bubbles: true }));
    expect(card().hidden).toBe(false);
    source().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", altKey: true, bubbles: true }));
    expect(card().hidden).toBe(true);
  });
  it("opens directly from an immediate keyboard selection without waiting for entry points", async () => {
    select(); controller.openFromShortcut();
    await vi.waitFor(() => expect(root().querySelector(".meanings")?.textContent).toContain("例子"));
    expect(sendRuntimeRequest).toHaveBeenCalledWith({ type: "LOOKUP_DICTIONARY", provider: "youdao", query: "example" });
    const count = vi.mocked(sendRuntimeRequest).mock.calls.length;
    controller.openFromShortcut();
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(count);
    expect(root().activeElement).toBe(card());
  });
  it("rejects missing selections, editable text and disabled selection shortcuts", () => {
    window.getSelection()?.removeAllRanges();
    expect(() => controller.openFromShortcut()).toThrow("请先选中");
    select("editable"); expect(() => controller.openFromShortcut()).toThrow("输入框");
    controller.update({ enabled: false, provider: "youdao", style: "dot" });
    select(); expect(() => controller.openFromShortcut()).toThrow("启用划词翻译");
    expect(sendRuntimeRequest).not.toHaveBeenCalled();
  });
  it("only queries after activation, retains the browser selection and renders pronunciation and meanings", async () => {
    await show(); expect(sendRuntimeRequest).not.toHaveBeenCalled();
    const event = new MouseEvent("pointerdown", { bubbles: true, composed: true, cancelable: true });
    root().querySelector("button")!.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    expect(window.getSelection()?.toString()).toBe("example");
    open(); await vi.waitFor(() => expect(root().querySelector(".meanings")?.textContent).toContain("例子"));
    expect(sendRuntimeRequest).toHaveBeenCalledWith({ type: "LOOKUP_DICTIONARY", provider: "youdao", query: "example" });
    expect(root().querySelector(".phonetics")?.textContent).toContain("ɪɡˈzɑːmpəl");
    expect(root().querySelector(".speak")?.getAttribute("aria-label")).toBe("播放英式发音");
  });
  it("draws one underline per line without modifying the selected page nodes", async () => {
    controller.update({ enabled: true, provider: "bing", style: "underline" });
    vi.mocked(Range.prototype.getClientRects).mockReturnValue([new DOMRect(10, 10, 30, 20), new DOMRect(40, 10, 20, 20), new DOMRect(10, 35, 40, 20)] as unknown as DOMRectList);
    await show();
    expect(root().querySelectorAll(".trigger-line")).toHaveLength(2);
    expect(document.getElementById("first")?.innerHTML).toBe("example");
    expect(root().querySelector<HTMLButtonElement>(".trigger-line")?.style.width).toBe("50px");
  });
  it("ignores editable selections, stale text selections in form fields, oversized text and a disabled feature", async () => {
    select("editable"); await new Promise(resolve => setTimeout(resolve, 60));
    expect(root().querySelector(".trigger-dot")).toBeNull();
    document.querySelector("textarea")!.focus(); select(); await new Promise(resolve => setTimeout(resolve, 60));
    expect(root().querySelector(".trigger-dot")).toBeNull();
    document.querySelector("textarea")!.blur(); document.getElementById("first")!.textContent = "a".repeat(5001);
    select(); await new Promise(resolve => setTimeout(resolve, 60)); expect(root().querySelector(".trigger-dot")).toBeNull();
    controller.update({ enabled: false, provider: "youdao", style: "dot" }); document.getElementById("first")!.textContent = "hello";
    select(); await new Promise(resolve => setTimeout(resolve, 60)); expect(root().querySelector(".trigger-dot")).toBeNull();
    expect(sendRuntimeRequest).not.toHaveBeenCalled();
  });
  it("does not let a late result replace the newly selected word", async () => {
    let finish!: (value: DictionaryEntry) => void;
    vi.mocked(sendRuntimeRequest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    await show(); open();
    document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    select("second"); await vi.waitFor(() => expect(root().querySelector(".trigger-dot")).not.toBeNull());
    vi.mocked(sendRuntimeRequest).mockResolvedValue({ ...entry, query: "running", word: "running" });
    open(); await vi.waitFor(() => expect(source().value).toBe("running"));
    finish(entry); await Promise.resolve(); await Promise.resolve();
    expect(source().value).toBe("running");
  });
  it("switches dictionaries manually and retries a failed dictionary request", async () => {
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".meanings")).not.toBeNull());
    const provider = root().querySelector("select")!;
    vi.mocked(sendRuntimeRequest).mockRejectedValueOnce(new Error("请求频繁"));
    provider.value = "bing"; provider.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(root().querySelector(".notice")?.textContent).toContain("请求频繁"));
    vi.mocked(sendRuntimeRequest).mockResolvedValueOnce({ ...entry, provider: "bing" });
    root().querySelector<HTMLButtonElement>(".retry")!.click();
    await vi.waitFor(() => expect(root().querySelector(".meanings")?.textContent).toContain("例子"));
    expect(sendRuntimeRequest).toHaveBeenLastCalledWith({ type: "LOOKUP_DICTIONARY", provider: "bing", query: "example" });
    expect(root().querySelector("footer a")?.getAttribute("href")).toContain("cn.bing.com/dict/search");
  });
  it("translates multiple words directly with the active service and configured languages", async () => {
    document.getElementById("first")!.textContent = "take off";
    await show(); expect(sendRuntimeRequest).not.toHaveBeenCalled(); open();
    await vi.waitFor(() => expect(root().querySelector(".selection-translation")?.textContent).toBe("翻译结果"));
    expect(sendRuntimeRequest).toHaveBeenCalledWith({ type: "TRANSLATE_BATCH", texts: ["take off"],
      providerId: translationSettings.activeProviderId, sourceLang: "en", targetLang: translationSettings.targetLang });
    expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([request]) => request.type === "LOOKUP_DICTIONARY")).toBe(false);
    expect(card().dataset.mode).toBe("translation");
    expect(root().querySelector<HTMLSelectElement>("select")?.hidden).toBe(true);
    expect(root().querySelector<HTMLElement>("footer")?.hidden).toBe(true);
    expect(root().querySelector(".translation-service")?.textContent).toBe("Microsoft 翻译");
    expect(root().querySelector(".phonetics")).toBeNull();
  });
  it("falls back to translation only when the single word has no dictionary meanings", async () => {
    vi.mocked(sendRuntimeRequest).mockResolvedValueOnce({ ...entry, meanings: [], pronunciations: [] });
    await show(); open();
    await vi.waitFor(() => expect(root().querySelector(".selection-translation")?.textContent).toBe("翻译结果"));
    expect(vi.mocked(sendRuntimeRequest).mock.calls.map(([request]) => request.type))
      .toEqual(["LOOKUP_DICTIONARY", "GET_SETTINGS", "TRANSLATE_BATCH"]);
    expect(root().querySelector(".notice")).toBeNull();
  });
  it("uses the Firefox local provider without choosing another online translation service", async () => {
    const settings = { ...translationSettings, activeProviderId: "firefox-local", sourceLang: "fr", targetLang: "en" };
    vi.mocked(sendRuntimeRequest).mockResolvedValueOnce(settings).mockResolvedValueOnce({ translations: ["hello world"], cached: 0 });
    document.getElementById("first")!.textContent = "bonjour le monde";
    await show(); open();
    await vi.waitFor(() => expect(root().querySelector(".selection-translation")?.textContent).toBe("hello world"));
    expect(sendRuntimeRequest).toHaveBeenLastCalledWith({ type: "TRANSLATE_BATCH", texts: ["bonjour le monde"],
      providerId: "firefox-local", sourceLang: "fr", targetLang: "en" });
  });
  it("accepts paragraphs longer than the dictionary limit and preserves line breaks", async () => {
    const paragraph = "Read this paragraph.\n".repeat(10).trim();
    document.getElementById("first")!.textContent = paragraph;
    vi.mocked(sendRuntimeRequest).mockResolvedValueOnce(translationSettings).mockResolvedValueOnce({ translations: ["第一行\n第二行"], cached: 0 });
    await show(); open();
    await vi.waitFor(() => expect(root().querySelector(".selection-translation")?.textContent).toBe("第一行\n第二行"));
    expect(sendRuntimeRequest).toHaveBeenLastCalledWith(expect.objectContaining({ type: "TRANSLATE_BATCH", texts: [paragraph] }));
    expect(source().value).toBe(paragraph);
  });
  it("retries a failed fallback translation without querying the empty dictionary again", async () => {
    vi.mocked(sendRuntimeRequest).mockResolvedValueOnce({ ...entry, meanings: [] })
      .mockResolvedValueOnce(translationSettings).mockRejectedValueOnce(new Error("本地模型未安装"));
    await show(); open();
    await vi.waitFor(() => expect(root().querySelector(".notice")?.textContent).toContain("本地模型未安装"));
    root().querySelector<HTMLButtonElement>(".retry")!.click();
    await vi.waitFor(() => expect(root().querySelector(".selection-translation")?.textContent).toBe("翻译结果"));
    expect(vi.mocked(sendRuntimeRequest).mock.calls.filter(([request]) => request.type === "LOOKUP_DICTIONARY")).toHaveLength(1);
  });
  it("reports dictionary outages without interpreting them as an unlisted word", async () => {
    vi.mocked(sendRuntimeRequest).mockRejectedValueOnce(new Error("词典请求过于频繁"));
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".notice")?.textContent).toContain("请求过于频繁"));
    expect(sendRuntimeRequest).toHaveBeenCalledOnce();
    expect(card().dataset.mode).toBe("dictionary");
  });
  it("ignores a translation that finishes after a different word is selected", async () => {
    let finish!: (value: unknown) => void;
    document.getElementById("first")!.textContent = "old selected phrase";
    vi.mocked(sendRuntimeRequest).mockResolvedValueOnce(translationSettings)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await show(); open();
    await vi.waitFor(() => expect(sendRuntimeRequest).toHaveBeenCalledWith(expect.objectContaining({ type: "TRANSLATE_BATCH" })));
    document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    select("second"); await vi.waitFor(() => expect(root().querySelector(".trigger-dot")).not.toBeNull());
    vi.mocked(sendRuntimeRequest).mockResolvedValue({ ...entry, word: "running", query: "running" });
    open(); await vi.waitFor(() => expect(source().value).toBe("running"));
    finish({ translations: ["旧译文"], cached: 0 }); await Promise.resolve(); await Promise.resolve();
    expect(root().querySelector(".selection-translation")).toBeNull();
    expect(source().value).toBe("running");
  });
  it("provides a concise recovery message for an outdated background", async () => {
    vi.mocked(sendRuntimeRequest).mockRejectedValueOnce(new Error('Unhandled message: {"type":"LOOKUP_DICTIONARY"}'));
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".notice")?.textContent).toContain("重新加载扩展"));
    expect(root().querySelector(".body")?.textContent).not.toContain("LOOKUP_DICTIONARY");
  });
  it("plays audio through the extension and cancels it when dismissed", async () => {
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".speak")).not.toBeNull());
    root().querySelector<HTMLButtonElement>(".speak")!.click();
    await vi.waitFor(() => expect(sendRuntimeRequest).toHaveBeenCalledWith({ type: "PLAY_DICTIONARY_AUDIO", provider: "youdao", url: entry.pronunciations[0].audioUrl }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(card().hidden).toBe(true);
    expect(sendRuntimeRequest).toHaveBeenLastCalledWith({ type: "STOP_DICTIONARY_AUDIO" });
  });
  it("keeps the card open while copying its text and closes on an outside scroll", async () => {
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".meanings")).not.toBeNull());
    root().querySelector(".meanings")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true }));
    expect(card().hidden).toBe(false);
    document.dispatchEvent(new Event("scroll")); expect(card().hidden).toBe(true);
  });
  it("renders dictionary strings as text rather than page markup", async () => {
    vi.mocked(sendRuntimeRequest).mockResolvedValue({ ...entry, word: '<img src=x onerror="alert(1)">', meanings: [{ partOfSpeech: "n.", definition: "<script>bad()</script>" }] });
    await show(); open(); await vi.waitFor(() => expect(source().value).toContain("<img"));
    expect(root().querySelector("img,script")).toBeNull();
  });
});

describe("editing selected text in the card", () => {
  it("independently disables keyboard submission and Escape without disabling buttons", async () => {
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".meanings")).not.toBeNull());
    controller.updateShortcuts({ "selection-submit": false, "dismiss-overlays": false });
    edit("edited sentence"); const calls = vi.mocked(sendRuntimeRequest).mock.calls.length;
    source().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, composed: true }));
    source().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(card().hidden).toBe(false); expect(sendRuntimeRequest).toHaveBeenCalledTimes(calls);
    expect(root().querySelector(".submit-source")?.getAttribute("title")).toBe("翻译");
    submit(); await vi.waitFor(() => expect(root().querySelector(".selection-translation")).not.toBeNull());
    controller.updateShortcuts(undefined);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(card().hidden).toBe(true);
  });
  it("keeps editor keystrokes away from page shortcuts and still supports Escape", async () => {
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".meanings")).not.toBeNull());
    const listener = vi.fn();
    const events = new AbortController();
    document.addEventListener("keydown", listener, { signal: events.signal });
    document.addEventListener("keyup", listener, { signal: events.signal });
    try {
      edit("draft sentence");
      source().dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true, composed: true }));
      source().dispatchEvent(new KeyboardEvent("keyup", { key: "g", bubbles: true, composed: true }));
      expect(listener).not.toHaveBeenCalled();
      source().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, composed: true }));
      expect(card().hidden).toBe(false);
      source().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
      expect(card().hidden).toBe(true);
    } finally { events.abort(); }
  });
  it("submits an edited word without modifying or reselecting the original page text", async () => {
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".meanings")).not.toBeNull());
    const calls = vi.mocked(sendRuntimeRequest).mock.calls.length;
    edit("running");
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(calls);
    expect(root().querySelector<HTMLElement>(".body")?.hidden).toBe(true);
    expect(root().querySelector(".submit-source")?.textContent).toBe("查词");
    vi.mocked(sendRuntimeRequest).mockResolvedValueOnce({ ...entry, query: "running", word: "running" });
    submit(); await vi.waitFor(() => expect(root().querySelector(".meanings")).not.toBeNull());
    expect(sendRuntimeRequest).toHaveBeenLastCalledWith({ type: "LOOKUP_DICTIONARY", provider: "youdao", query: "running" });
    expect(source().value).toBe("running");
    expect(document.getElementById("first")?.textContent).toBe("example");
    expect(card().hidden).toBe(false);
  });
  it("translates an edited multiline source with Ctrl+Enter and lets ordinary Enter remain a newline", async () => {
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".meanings")).not.toBeNull());
    edit("first line\nsecond line");
    const calls = vi.mocked(sendRuntimeRequest).mock.calls.length;
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true });
    source().dispatchEvent(enter); expect(enter.defaultPrevented).toBe(false);
    source().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true, composed: true }));
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(calls);
    source().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, composed: true, cancelable: true }));
    await vi.waitFor(() => expect(root().querySelector(".selection-translation")?.textContent).toBe("翻译结果"));
    expect(sendRuntimeRequest).toHaveBeenLastCalledWith(expect.objectContaining({ type: "TRANSLATE_BATCH", texts: ["first line\nsecond line"] }));
    expect(source().value).toBe("first line\nsecond line");
    expect(card().dataset.mode).toBe("translation");
  });
  it("routes an edited sentence back to the selected dictionary when changed to one word", async () => {
    controller.update({ enabled: true, provider: "bing", style: "dot" });
    document.getElementById("first")!.textContent = "selected sentence";
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".selection-translation")).not.toBeNull());
    edit("example"); submit();
    await vi.waitFor(() => expect(root().querySelector(".meanings")).not.toBeNull());
    expect(sendRuntimeRequest).toHaveBeenLastCalledWith({ type: "LOOKUP_DICTIONARY", provider: "bing", query: "example" });
    expect(card().dataset.mode).toBe("dictionary");
    expect(root().querySelector<HTMLSelectElement>("select")?.hidden).toBe(false);
  });
  it.each(["dictionary", "translation"])("does not overwrite an editor draft with a late %s result", async mode => {
    let finish!: (value: unknown) => void;
    if (mode === "translation") {
      document.getElementById("first")!.textContent = "old sentence";
      vi.mocked(sendRuntimeRequest).mockResolvedValueOnce(translationSettings);
    }
    vi.mocked(sendRuntimeRequest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await show(); open(); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    edit("new selected sentence");
    finish(mode === "dictionary" ? entry : { translations: ["旧译文"], cached: 0 });
    await Promise.resolve(); await Promise.resolve();
    expect(source().value).toBe("new selected sentence");
    expect(root().querySelector<HTMLElement>(".body")?.hidden).toBe(true);
    expect(root().querySelector<HTMLElement>(".source-actions")?.hidden).toBe(false);
    submit(); await vi.waitFor(() => expect(root().querySelector(".selection-translation")?.textContent).toBe("翻译结果"));
  });
  it.each(["", "  ", "a".repeat(5001)])("blocks invalid editor text without sending a request", async value => {
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".meanings")).not.toBeNull());
    const calls = vi.mocked(sendRuntimeRequest).mock.calls.length;
    edit(value); submit();
    expect(sendRuntimeRequest).toHaveBeenCalledTimes(calls);
    expect(source().getAttribute("aria-invalid")).toBe("true");
    expect(root().querySelector(".source-actions [role='alert']")?.textContent).not.toBe("");
    expect(card().hidden).toBe(false);
  });
  it("uses the current draft when switching dictionaries and keeps internal editor scrolling open", async () => {
    await show(); open(); await vi.waitFor(() => expect(root().querySelector(".meanings")).not.toBeNull());
    edit("running");
    source().dispatchEvent(new Event("scroll", { bubbles: true, composed: true }));
    expect(card().hidden).toBe(false);
    const provider = root().querySelector<HTMLSelectElement>("select")!;
    provider.value = "bing"; provider.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(sendRuntimeRequest).toHaveBeenLastCalledWith({ type: "LOOKUP_DICTIONARY", provider: "bing", query: "running" }));
  });
});
