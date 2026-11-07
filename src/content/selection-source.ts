import { t } from "../shared/i18n";
import { componentShadowRoot, composedParent } from "./dom-roots";

const OWNED = "#wupage-selection-tools,#wupage-floating-hitbox,#wupage-floating-menu,#wupage-debug-panel,#wupage-image-tools,#wupage-touch-paragraph,#wupage-touch-hint";
const CONTROLS = "input,textarea,select,button";
const EDITORS = "[contenteditable]:not([contenteditable='false']),[role='textbox']";
const COMPLEX_EDITORS = ".ProseMirror,.monaco-editor,.cm-editor,[data-slate-editor],[data-lexical-editor]";
type TextControl = HTMLInputElement | HTMLTextAreaElement;

function supportedControl(element: TextControl): boolean {
  return !element.matches(":disabled") && (!(element instanceof HTMLInputElement) || ["text", "search", "url", "tel"].includes(element.type));
}

export type SelectionSource = {
  kind: "control"; element: TextControl; value: string; start: number; end: number; text: string;
} | {
  kind: "range"; range: Range; text: string; editor?: HTMLElement; markup?: string;
  startNode: Node; start: number; endNode: Node; end: number;
};

function closest(element: Element | null, selector: string): Element | null {
  for (let current = element; current; current = composedParent(current)) {
    if (current.matches(selector)) return current;
  }
  return null;
}

function activeElement(): Element | null {
  let element = document.activeElement;
  while (element) {
    const nested = componentShadowRoot(element)?.activeElement;
    if (!nested) break;
    element = nested;
  }
  return element;
}

function editingHost(node: Node): HTMLElement | undefined {
  let host: HTMLElement | undefined;
  for (let element = node instanceof Element ? node : node.parentElement; element; element = composedParent(element)) {
    const value = element.getAttribute("contenteditable")?.toLowerCase();
    if (value === "false") break;
    if (element instanceof HTMLElement && (value === "" || value === "true" || value === "plaintext-only")) host = element;
  }
  return host;
}

/** Capture only an explicit selection inside one field/editor, never a draft crossed by a prose selection. */
export function captureSelectionSource(): SelectionSource | undefined {
  const active = activeElement();
  if (closest(active, OWNED)) return;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (!supportedControl(active)) return;
    const start = active.selectionStart, end = active.selectionEnd;
    if (start === null || end === null || start === end) return;
    return { kind: "control", element: active, value: active.value, start, end, text: active.value.slice(start, end) };
  }
  if (closest(active, CONTROLS)) return;
  const root = active?.getRootNode() as (ShadowRoot & { getSelection?: () => Selection | null }) | undefined;
  const selection = root?.getSelection?.() ?? window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const editor = editingHost(range.startContainer);
  if (editor !== editingHost(range.endContainer)) return;
  if (active && editingHost(active) && editingHost(active) !== editor) return;
  for (const node of [range.startContainer, range.endContainer, range.commonAncestorContainer]) {
    const element = node instanceof Element ? node : node.parentElement;
    if (!node.isConnected || closest(element, `${OWNED},${CONTROLS}`)
      || !editor && closest(element, EDITORS)) return;
  }
  if (editor && (!editor.contains(range.startContainer) || !editor.contains(range.endContainer))) return;
  const common = range.commonAncestorContainer;
  if (common instanceof Element && [...common.querySelectorAll(`${OWNED},${CONTROLS},${EDITORS},[contenteditable='false']`)]
    .some(element => element !== editor && !element.contains(editor ?? common) && range.intersectsNode(element))) return;
  return { kind: "range", range: range.cloneRange(), text: range.toString(), editor, markup: editor?.innerHTML,
    startNode: range.startContainer, start: range.startOffset, endNode: range.endContainer, end: range.endOffset };
}

export function selectionSourceConnected(source: SelectionSource): boolean {
  return source.kind === "control" ? source.element.isConnected
    : source.range.startContainer.isConnected && source.range.endContainer.isConnected;
}

export function selectionSourceRects(source: SelectionSource): DOMRect[] {
  return source.kind === "control" ? [source.element.getBoundingClientRect()] : Array.from(source.range.getClientRects());
}

export function isEditorSelection(source: SelectionSource): boolean {
  return source.kind === "control" || !!source.editor;
}

export function selectionReplacementAvailable(source: SelectionSource): boolean {
  if (source.kind === "control") return supportedControl(source.element) && !source.element.readOnly;
  return !!source.editor && !closest(source.editor, `${COMPLEX_EDITORS},[aria-readonly='true'],[aria-disabled='true']`);
}

export function selectionSourceUnchanged(source: SelectionSource): boolean {
  if (!selectionSourceConnected(source) || !selectionReplacementAvailable(source)) return false;
  if (source.kind === "control") return source.element.value === source.value;
  return source.editor?.innerHTML === source.markup && editingHost(source.startNode) === source.editor
    && editingHost(source.endNode) === source.editor && source.range.startContainer === source.startNode
    && source.range.endContainer === source.endNode && source.range.startOffset === source.start
    && source.range.endOffset === source.end && source.range.toString() === source.text;
}

/** Prefer a browser edit so native undo and framework input handlers see the same operation as typing. */
export function replaceSelectionSource(source: SelectionSource, translation: string): void {
  const changed = () => new Error(t("theSourceTextHasChangedSelectItAgain"));
  if (!selectionSourceUnchanged(source)) throw changed();
  const element = source.kind === "control" ? source.element : source.editor!;
  let text = (source.text.match(/^\s*/u)?.[0] ?? "") + translation + (source.text.match(/\s*$/u)?.[0] ?? "");
  if (element instanceof HTMLInputElement) text = text.replace(/[\r\n]+/g, " ");
  if (source.kind === "control") {
    if (source.element.maxLength >= 0 && source.value.length - (source.end - source.start) + text.length > source.element.maxLength) {
      throw new Error(t("theReplacementExceedsTheInputSCharacterLimit"));
    }
  }
  element.focus({ preventScroll: true });
  if (!selectionSourceUnchanged(source)) throw changed();
  if (source.kind === "control") source.element.setSelectionRange(source.start, source.end);
  else {
    const selection = window.getSelection();
    if (!selection) throw new Error(t("couldNotRestoreTheSelectionSelectTheText"));
    selection.removeAllRanges(); selection.addRange(source.range.cloneRange());
  }
  // Let the page reject an edit, and recheck after its handlers run.
  if (!element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, cancelable: true,
    inputType: "insertReplacementText", data: text }))) throw new Error(t("thisEditorBlockedReplacementCopyTheTranslationManually"));
  if (!selectionSourceUnchanged(source)) throw changed();
  if (activeElement() !== element || source.kind === "control"
    && (source.element.selectionStart !== source.start || source.element.selectionEnd !== source.end)) throw changed();
  if (source.kind === "range") {
    const current = window.getSelection();
    if (current?.rangeCount !== 1) throw changed();
    const range = current.getRangeAt(0);
    if (range.startContainer !== source.startNode || range.startOffset !== source.start
      || range.endContainer !== source.endNode || range.endOffset !== source.end) throw changed();
  }
  let notified = false;
  const onInput = () => { notified = true; };
  element.addEventListener("input", onInput, true);
  let executed = false;
  try {
    try { executed = document.execCommand?.("insertText", false, text) ?? false; } catch { /* Fall back only if no edit occurred. */ }
  } finally { element.removeEventListener("input", onInput, true); }
  const modified = source.kind === "control" ? source.element.value !== source.value : source.editor!.innerHTML !== source.markup;
  if (!modified && text !== source.text) {
    if (executed || notified) throw new Error(t("thePageDeclinedTheReplacementCopyTheTranslation"));
    if (!selectionSourceUnchanged(source)) throw changed();
    if (source.kind === "control") source.element.setRangeText(text, source.start, source.end, "end");
    else {
      // Arbitrary DOM writes bypass rich editors' state and undo history.
      throw new Error(t("thisEditorDoesNotSupportReplacementCopyThe"));
    }
  }
  if (!notified) element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: text }));
}
