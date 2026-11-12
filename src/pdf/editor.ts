import { t } from "../shared/i18n";
import { readFormulaText, renderFormulaText, type PdfFormulaImage } from "./math-rendering";
import { uiIconMarkup, type UiIconName } from "../shared/ui-icons";

export interface TranslationBlockGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface EditableTranslationBlockOptions extends TranslationBlockGeometry {
  id: string;
  text: string;
  color: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  textAlign?: "left" | "center" | "right";
  hangingIndent?: number;
  fontSizeStep?: number;
  maximumAutoHeight?: number;
  formulaImages?: PdfFormulaImage[];
  onDelete?: () => void;
  onTextChange?: (text: string) => void;
}

export function createEditableTranslationBlock(
  layer: HTMLElement,
  options: EditableTranslationBlockOptions
): HTMLElement {
  const block = document.createElement("div");
  block.className = "translation-block";
  block.dataset.blockId = options.id;
  block.dataset.testid = "pdf-translation-block";
  block.dataset.preferredFontSize = String(options.fontSize);
  if (options.maximumAutoHeight !== undefined) block.dataset.maximumAutoHeight = String(options.maximumAutoHeight);
  setGeometry(block, options);

  const text = document.createElement("div");
  text.className = "translation-block-text";
  text.contentEditable = "true";
  text.spellcheck = false;
  text.setAttribute("role", "textbox");
  text.setAttribute("aria-label", t("editableTranslation"));
  text.setAttribute("aria-multiline", "true");
  text.style.color = options.color;
  text.style.fontFamily = options.fontFamily;
  text.style.fontSize = `${options.fontSize}px`;
  text.style.fontWeight = String(options.fontWeight);
  text.style.lineHeight = `${options.lineHeight}px`;
  text.style.textAlign = options.textAlign ?? "left";
  if (options.hangingIndent) {
    text.style.paddingLeft = `${options.hangingIndent}px`;
    text.style.textIndent = `${-options.hangingIndent}px`;
  }
  if (options.formulaImages?.length || /⟪WUPAGEOPEN\d+⟫/u.test(options.text)) {
    renderFormulaText(text, options.text, options.formulaImages ?? [], options.fontSize);
  }
  else text.textContent = options.text;
  text.addEventListener("input", () => {
    refreshTranslationBlockOverflow(block);
    options.onTextChange?.(readFormulaText(text));
  });

  const moveHandle = createControl("translation-block-move", t("moveTranslationBlock"), "cursor-move");
  bindPointerGesture(moveHandle, block, layer, "move");

  const deleteButton = createControl("translation-block-delete", t("deleteTranslationBlock"), "trash");
  deleteButton.addEventListener("click", () => {
    options.onDelete?.();
    block.remove();
  });

  const resizeHandle = createControl("translation-block-resize", t("resizeTranslationBlock"));
  bindPointerGesture(resizeHandle, block, layer, "resize");

  const decreaseButton = createControl("translation-block-font-decrease", t("decreaseFontSize"), "minus");
  const increaseButton = createControl("translation-block-font-increase", t("increaseFontSize"), "plus");
  for (const [button, direction] of [[decreaseButton, -1], [increaseButton, 1]] as const) {
    button.addEventListener("click", () => {
      const size = numericStyle(text.style.fontSize);
      const minimum = Number(layer.dataset.coordinateScale) || 1;
      setTranslationFontSize(block, Math.max(minimum, size + direction * (options.fontSizeStep ?? 1)));
      if (direction > 0) growTranslationBlock(block, layer, options.maximumAutoHeight);
      refreshTranslationBlockOverflow(block);
    });
  }

  const toolbar = document.createElement("div");
  toolbar.className = "translation-block-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", t("translationBlockTools"));
  toolbar.append(moveHandle, decreaseButton, increaseButton, deleteButton);
  block.append(text, toolbar, resizeHandle);
  return block;
}

export function fitTranslationBlock(block: HTMLElement): void {
  const text = block.querySelector<HTMLElement>(".translation-block-text");
  if (!text || !text.clientWidth || !text.clientHeight) return;
  const initialSize = numericStyle(text.style.fontSize);
  const coordinateScale = Number(block.parentElement?.dataset.coordinateScale) || 1;
  setTranslationBlockOverflow(block, false);
  const range = document.createRange();
  let fittedInset = 0;
  const legacyFits = (size: number): boolean => {
    setTranslationFontSize(block, size);
    text.style.paddingTop = "0px";
    const bounds = text.getBoundingClientRect();
    const scale = bounds.width / text.clientWidth;
    if (!scale) return true;
    range.selectNodeContents(text);
    const content = range.getBoundingClientRect();
    // Tall superscripts/formulas can extend above the first CSS line box.
    const measuredInset = Math.max(0, (bounds.top - content.top) / scale);
    // Empty/stale range rectangles do not describe a font overhang. In
    // particular, their zero origin must not become a page-sized top inset.
    const inset = content.width > 0 && content.height > 0 && measuredInset <= size * 2 ? measuredInset : 0;
    if (inset) text.style.paddingTop = `${inset}px`;
    fittedInset = inset;
    return text.scrollHeight <= text.clientHeight + 1 && text.scrollWidth <= text.clientWidth + 1;
  };
  const fits = (size: number): boolean => {
    // Some engines defer restyling an existing editable text frame until the
    // next paint, even when range/scroll metrics are read synchronously. A new
    // measuring frame starts with the candidate's complete style and cannot
    // return the preceding candidate's cached font metrics.
    let probe = text.cloneNode(true) as HTMLElement;
    scaleTranslationText(probe, size);
    Object.assign(probe.style, { position: "absolute", left: "0px", top: "0px", visibility: "hidden", pointerEvents: "none",
      width: block.style.width, height: block.style.height, paddingTop: "0px" });
    block.append(probe);
    if (!probe.clientWidth || !probe.clientHeight) { probe.remove(); return legacyFits(size); }
    const bounds = probe.getBoundingClientRect(), scale = bounds.width / probe.clientWidth;
    range.selectNodeContents(probe);
    const content = range.getBoundingClientRect();
    const inset = scale ? Math.max(0, (bounds.top - content.top) / scale) : 0;
    fittedInset = content.width > 0 && content.height > 0 && inset <= size * 2 ? inset : 0;
    if (fittedInset) {
      const adjusted = probe.cloneNode(true) as HTMLElement;
      adjusted.style.paddingTop = `${fittedInset}px`;
      probe.remove(); probe = adjusted; block.append(probe);
    }
    const fit = probe.scrollHeight <= probe.clientHeight + 1 && probe.scrollWidth <= probe.clientWidth + 1;
    probe.remove();
    return fit;
  };
  const apply = (size: number): void => { setTranslationFontSize(block, size); text.style.paddingTop = `${fittedInset}px`; };
  if (fits(initialSize)) { apply(initialSize); return; }
  const maximumHeight = Number(block.dataset.maximumAutoHeight);
  if (maximumHeight > numericStyle(block.style.height)) {
    growTranslationBlock(block, block.parentElement!, maximumHeight);
    if (fits(initialSize)) { apply(initialSize); return; }
  }
  // A single extra wrapped line does not mean the font should be halved.
  // Find the largest size that fits, including the browser's font metrics.
  const preferredSize = Number(block.dataset.preferredFontSize) || initialSize;
  let low = Math.max(Math.min(coordinateScale, initialSize), Math.min(initialSize, preferredSize * 0.6));
  let high = initialSize;
  if (!fits(low)) {
    // There is no valid lower bound: committing it leaves a 1px line box
    // around a larger glyph (or bad inset) and can make all text disappear.
    fits(initialSize);
    apply(initialSize);
    setTranslationBlockOverflow(block, true);
    return;
  }
  for (let attempt = 0; attempt < 12 && high - low > 0.02 * coordinateScale; attempt += 1) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  fits(low);
  apply(low);
}

export function refreshTranslationBlockOverflow(block: HTMLElement): boolean {
  const text = block.querySelector<HTMLElement>(".translation-block-text");
  if (!text?.clientWidth || !text.clientHeight) return Boolean(block.dataset.layoutOverflow);
  // Firefox can retain the preceding font candidate's scroll metrics until
  // paint. Measure a fresh frame, as fitTranslationBlock does.
  const probe = text.cloneNode(true) as HTMLElement;
  Object.assign(probe.style, { position: "absolute", left: "0px", top: "0px", visibility: "hidden", pointerEvents: "none",
    width: block.style.width, height: block.style.height });
  block.append(probe);
  const measured = probe.clientWidth && probe.clientHeight ? probe : text;
  const overflow = measured.scrollHeight > measured.clientHeight + 1 || measured.scrollWidth > measured.clientWidth + 1;
  probe.remove();
  setTranslationBlockOverflow(block, overflow);
  return overflow;
}

function setTranslationBlockOverflow(block: HTMLElement, overflow: boolean): void {
  const text = block.querySelector<HTMLElement>(".translation-block-text");
  if (overflow) {
    block.dataset.layoutOverflow = "true";
    block.title = t("someTranslatedTextDoesNotFitAtA");
    text?.setAttribute("aria-invalid", "true");
  } else {
    delete block.dataset.layoutOverflow;
    block.removeAttribute("title");
    text?.removeAttribute("aria-invalid");
  }
}

export function setTranslationFontSize(block: HTMLElement, size: number): void {
  const text = block.querySelector<HTMLElement>(".translation-block-text");
  if (text) scaleTranslationText(text, size);
}

function scaleTranslationText(text: HTMLElement, size: number): void {
  const current = numericStyle(text?.style.fontSize ?? "");
  if (!current || !Number.isFinite(size) || size <= 0) return;
  const ratio = size / current;
  text.style.fontSize = `${size}px`;
  text.style.lineHeight = `${numericStyle(text.style.lineHeight) * ratio}px`;
  text.style.paddingTop = `${numericStyle(text.style.paddingTop) * ratio}px`;
  text.style.paddingLeft = `${numericStyle(text.style.paddingLeft) * ratio}px`;
  text.style.textIndent = `${numericStyle(text.style.textIndent) * ratio}px`;
  for (const image of text.querySelectorAll<HTMLElement>(".pdf-inline-formula")) {
    image.style.width = `${numericStyle(image.style.width) * ratio}px`;
    image.style.height = `${numericStyle(image.style.height) * ratio}px`;
    image.style.verticalAlign = `${numericStyle(image.style.verticalAlign) * ratio}px`;
  }
}

function growTranslationBlock(block: HTMLElement, layer: HTMLElement, maximumHeight?: number): void {
  const text = block.querySelector<HTMLElement>(".translation-block-text");
  if (!text) return;
  const left = numericStyle(block.style.left);
  const right = left + numericStyle(block.style.width);
  const top = numericStyle(block.style.top);
  const height = numericStyle(block.style.height);
  let bottom = numericStyle(layer.style.height) || layer.clientHeight;
  if (maximumHeight !== undefined) bottom = Math.min(bottom, top + maximumHeight);
  for (const other of layer.querySelectorAll<HTMLElement>(".translation-block")) {
    if (other === block) continue;
    const otherLeft = numericStyle(other.style.left);
    const otherTop = numericStyle(other.style.top);
    if (otherTop >= top + height && otherLeft < right && otherLeft + numericStyle(other.style.width) > left) {
      bottom = Math.min(bottom, otherTop - 1);
    }
  }
  block.style.height = `${Math.max(height, Math.min(text.scrollHeight, bottom - top))}px`;
}

function createControl(className: string, label: string, icon?: UiIconName): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `translation-block-control ${className}`;
  button.setAttribute("aria-label", label);
  button.title = label;
  if (icon) button.innerHTML = uiIconMarkup(icon);
  return button;
}

function setGeometry(element: HTMLElement, geometry: TranslationBlockGeometry): void {
  element.style.left = `${geometry.left}px`;
  element.style.top = `${geometry.top}px`;
  element.style.width = `${geometry.width}px`;
  element.style.height = `${geometry.height}px`;
}

function bindPointerGesture(
  handle: HTMLElement,
  block: HTMLElement,
  layer: HTMLElement,
  mode: "move" | "resize"
): void {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = numericStyle(block.style.left);
    const startTop = numericStyle(block.style.top);
    const startWidth = numericStyle(block.style.width);
    const startHeight = numericStyle(block.style.height);
    const layerWidth = numericStyle(layer.style.width) || layer.offsetWidth;
    const layerHeight = numericStyle(layer.style.height) || layer.offsetHeight;
    const visualWidth = layer.getBoundingClientRect().width;
    const scale = visualWidth > 0 && layerWidth > 0 ? visualWidth / layerWidth : 1;
    const ownerWindow = block.ownerDocument.defaultView;
    if (!ownerWindow) return;

    block.classList.add("is-interacting");
    const onMove = (moveEvent: PointerEvent): void => {
      const deltaX = (moveEvent.clientX - startX) / scale;
      const deltaY = (moveEvent.clientY - startY) / scale;
      if (mode === "move") {
        block.style.left = `${clamp(startLeft + deltaX, 0, Math.max(0, layerWidth - startWidth))}px`;
        block.style.top = `${clamp(startTop + deltaY, 0, Math.max(0, layerHeight - startHeight))}px`;
        return;
      }
      block.style.width = `${clamp(startWidth + deltaX, 32, Math.max(32, layerWidth - startLeft))}px`;
      block.style.height = `${clamp(startHeight + deltaY, 18, Math.max(18, layerHeight - startTop))}px`;
    };
    const onEnd = (): void => {
      block.classList.remove("is-interacting");
      refreshTranslationBlockOverflow(block);
      ownerWindow.removeEventListener("pointermove", onMove);
      ownerWindow.removeEventListener("pointerup", onEnd);
      ownerWindow.removeEventListener("pointercancel", onEnd);
    };

    ownerWindow.addEventListener("pointermove", onMove);
    ownerWindow.addEventListener("pointerup", onEnd);
    ownerWindow.addEventListener("pointercancel", onEnd);
  });
}

function numericStyle(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
