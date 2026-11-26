import type { InputDraft } from "./selection-source";

const TEXT_LAYOUT_PROPERTIES = [
  "font-family", "font-size", "font-style", "font-weight", "font-stretch", "font-variant",
  "font-kerning", "font-feature-settings", "font-variation-settings", "font-optical-sizing",
  "letter-spacing", "word-spacing", "line-height", "text-align", "text-align-last", "text-indent",
  "text-transform", "direction", "unicode-bidi", "tab-size", "white-space", "overflow-wrap", "word-break", "line-break",
  "padding-top", "padding-right", "padding-bottom", "padding-left"
];

interface CaretAnchor {
  x: number;
  top: number;
  bottom: number;
  rtl: boolean;
}

export function inputDraftCaret(draft: InputDraft, root: ShadowRoot, field: DOMRect): CaretAnchor | undefined {
  const style = getComputedStyle(draft.element);
  const rtl = style.direction === "rtl";
  const rect = draft.source.kind === "control"
    ? measureControlCaret(draft.source.element, draft.source.value, style, field, root)
    : draft.caret?.getBoundingClientRect();
  if (!rect?.height) return;
  return {
    x: clamp(rtl ? rect.left : rect.right, field.left, field.right),
    top: clamp(rect.top, field.top, field.bottom),
    bottom: clamp(rect.bottom, field.top, field.bottom),
    rtl
  };
}

// Native text controls do not expose their caret range. Lay out the same text in
// a temporary, invisible element using the control's client box and typography.
function measureControlCaret(
  element: HTMLInputElement | HTMLTextAreaElement, value: string, style: CSSStyleDeclaration, field: DOMRect, root: ShadowRoot
): DOMRect | undefined {
  if (!element.clientWidth || !element.clientHeight) return;
  const doc = element.ownerDocument;
  const mirror = doc.createElement("div");
  mirror.style.cssText = "position:fixed;inset:0 auto auto 0;visibility:hidden;pointer-events:none;box-sizing:border-box;";
  for (const property of TEXT_LAYOUT_PROPERTIES) mirror.style.setProperty(property, style.getPropertyValue(property));
  mirror.style.width = element.clientWidth + "px";
  const singleLine = element instanceof HTMLInputElement;
  if (singleLine) mirror.style.whiteSpace = "pre";
  // A final line break needs a zero-width character to create the empty line.
  const text = doc.createTextNode(value.endsWith("\n") ? value + "\u200b" : value);
  mirror.append(text);
  root.append(mirror);
  try {
    const range = doc.createRange();
    range.setStart(text, text.length);
    range.collapse(true);
    const caret = range.getBoundingClientRect();
    const box = mirror.getBoundingClientRect();
    const mirrorScale = box.width / element.clientWidth || 1;
    const scaleX = field.width / element.offsetWidth || 1;
    const scaleY = field.height / element.offsetHeight || 1;
    const height = caret.height / mirrorScale;
    const x = (caret.left - box.left) / mirrorScale - element.scrollLeft;
    const y = singleLine
      ? (element.clientHeight + parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - height) / 2
      : (caret.top - box.top) / mirrorScale - element.scrollTop;
    return new DOMRect(
      field.left + (element.clientLeft + clamp(x, 0, element.clientWidth)) * scaleX,
      field.top + (element.clientTop + y) * scaleY,
      0,
      height * scaleY
    );
  } finally {
    mirror.remove();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
