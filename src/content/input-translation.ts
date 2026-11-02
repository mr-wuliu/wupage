import { INPUT_TRANSLATION_MAX_CHARS } from "../shared/input-translation";
import { sendRuntimeRequest } from "./runtime";
import { showShortcutNotice } from "./shortcut-notice";

type TextField = HTMLInputElement | HTMLTextAreaElement;
/** Free-text input types; email, URL and similar fields have no text to translate (and email has no selection API). */
const TEXT_INPUT_TYPES = new Set(["text", "search"]);
const EDITABLE_HOST = "[contenteditable]:not([contenteditable='false'])";
/** Slate/Lexical-style editors read the DOM selection on a delayed selectionchange; writing earlier replaces nothing. */
const EDITOR_SELECTION_SYNC_MS = 150;
const BLOCK_TAGS = new Set(["DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "TR"]);

interface InputSource { text: string; apply: (translation: string) => void | Promise<void> }

/** The focused element, looking through open shadow roots. */
function deepActiveElement(): Element | null {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

function isTextField(element: Element | null): element is TextField {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  return element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type) && !element.readOnly && !element.disabled;
}

/** The outermost editable root of a rich-text editor around `node`. */
function editableRoot(node: Node | null | undefined): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  let root = element?.closest<HTMLElement>(EDITABLE_HOST);
  if (!root?.isContentEditable) return null;
  while (root.parentElement?.isContentEditable && root.parentElement !== document.body) root = root.parentElement;
  return root;
}

/** The focused text field or rich-text editor (contenteditable), if any. */
export function findInputTarget(): TextField | HTMLElement | null {
  const active = deepActiveElement();
  if (isTextField(active)) return active;
  return editableRoot(active) ?? editableRoot(window.getSelection()?.anchorNode);
}

/**
 * Plain text with line breaks. Range.toString() glues the blocks of Slate/Draft editors
 * (one div per line, `<br>` for an empty line) into one line, and the translation would lose them.
 */
export function textWithLineBreaks(range: Range): string {
  const lines: string[] = [];
  let line = "";
  const walk = (parent: Node): void => {
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) { line += (node as Text).data.replace(/[﻿​]/gu, ""); continue; }
      if (!(node instanceof Element)) continue;
      if (node.tagName === "BR") {
        // A lone or trailing <br> is only the editor's placeholder for an empty line.
        if (node.nextSibling) { lines.push(line); line = ""; }
        continue;
      }
      if (node.tagName === "IMG") { line += node.getAttribute("alt") ?? ""; continue; }
      if (!BLOCK_TAGS.has(node.tagName)) { walk(node); continue; }
      if (line) { lines.push(line); line = ""; }
      walk(node);
      // A wrapper around block children has already emitted its lines.
      if (line || !node.querySelector([...BLOCK_TAGS].join(","))) { lines.push(line); line = ""; }
    }
  };
  walk(range.cloneContents());
  if (line || !lines.length) lines.push(line);
  return lines.join("\n");
}

const insertText = (text: string): boolean => typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Editors with their own document model (Discord, Slate, Lexical, Draft) ignore DOM edits from execCommand and
 * send the old text. They handle paste through their model; a plain contenteditable leaves it unhandled.
 */
function pasteText(target: HTMLElement, text: string): boolean {
  try {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    return !target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  } catch (error) {
    console.info("[wupage] synthetic paste unavailable", error);
    return false;
  }
}

function readTextField(target: TextField): InputSource {
  const start = target.selectionStart ?? 0, end = target.selectionEnd ?? 0;
  const from = end > start ? start : 0, to = end > start ? end : target.value.length;
  return { text: target.value.slice(from, to), apply: translation => {
    target.focus();
    target.setSelectionRange(from, to);
    // execCommand keeps the browser undo stack; frameworks still see the native setter and input event.
    if (insertText(translation)) return;
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, target.value.slice(0, from) + translation + target.value.slice(to));
    target.setSelectionRange(from + translation.length, from + translation.length);
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: translation }));
  } };
}

function readEditor(target: HTMLElement): InputSource {
  const selection = window.getSelection();
  const inside = selection && selection.rangeCount > 0 && !selection.isCollapsed
    && target.contains(selection.anchorNode) && target.contains(selection.focusNode);
  const range = inside ? selection.getRangeAt(0).cloneRange() : document.createRange();
  if (!inside) range.selectNodeContents(target);
  return { text: textWithLineBreaks(range), apply: async translation => {
    target.focus();
    const current = window.getSelection()!;
    current.removeAllRanges(); current.addRange(range);
    await wait(EDITOR_SELECTION_SYNC_MS);
    if (pasteText(target, translation)) { console.info("[wupage] input translation written through the editor's paste handler"); return; }
    console.info("[wupage] paste not handled by the page; falling back to insertText");
    if (insertText(translation)) return;
    range.deleteContents(); range.insertNode(document.createTextNode(translation));
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: translation }));
  } };
}

let running = false;

/** Translate the focused field (or its selection) with the configured LLM and replace the text in place. */
export async function translateFocusedInput(): Promise<void> {
  if (running) return;
  const target = findInputTarget();
  if (!target) { showShortcutNotice("请先点击要翻译的输入框，再按快捷键。", true); return; }
  const source = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? readTextField(target) : readEditor(target);
  if (!source.text.trim()) { showShortcutNotice("输入框里没有可翻译的文字。", true); return; }
  if (source.text.length > INPUT_TRANSLATION_MAX_CHARS) {
    showShortcutNotice(`文字过长（上限 ${INPUT_TRANSLATION_MAX_CHARS} 字符），请选中一部分后再翻译。`, true); return;
  }
  running = true;
  showShortcutNotice("正在翻译输入框…");
  try {
    const { translation, providerLabel } = await sendRuntimeRequest<{ translation: string; providerLabel: string }>({ type: "TRANSLATE_INPUT", text: source.text });
    // The page may have removed the field while the model was answering.
    if (!target.isConnected) throw new Error("输入框已被移除，译文未写入。");
    await source.apply(translation);
    showShortcutNotice(`已用 ${providerLabel} 翻译并替换原文。`);
  } catch (error) {
    showShortcutNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    running = false;
  }
}
