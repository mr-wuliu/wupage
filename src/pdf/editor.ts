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
  setGeometry(block, options);

  const text = document.createElement("div");
  text.className = "translation-block-text";
  text.contentEditable = "true";
  text.spellcheck = false;
  text.setAttribute("role", "textbox");
  text.setAttribute("aria-label", "可编辑译文");
  text.setAttribute("aria-multiline", "true");
  text.style.color = options.color;
  text.style.fontFamily = options.fontFamily;
  text.style.fontSize = `${options.fontSize}px`;
  text.style.fontWeight = String(options.fontWeight);
  text.style.lineHeight = `${options.lineHeight}px`;
  text.textContent = options.text;
  text.addEventListener("input", () => options.onTextChange?.(text.textContent ?? ""));

  const moveHandle = createControl("translation-block-move", "移动译文块", "✥");
  bindPointerGesture(moveHandle, block, layer, "move");

  const deleteButton = createControl("translation-block-delete", "删除译文块", "×");
  deleteButton.addEventListener("click", () => {
    options.onDelete?.();
    block.remove();
  });

  const resizeHandle = createControl("translation-block-resize", "调整译文块大小", "");
  bindPointerGesture(resizeHandle, block, layer, "resize");

  block.append(text, moveHandle, deleteButton, resizeHandle);
  return block;
}

function createControl(className: string, label: string, glyph: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = glyph;
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
