// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditableTranslationBlock } from "../src/pdf/editor";

afterEach(() => {
  document.body.replaceChildren();
});

describe("editable PDF translation blocks", () => {
  it("keeps editor scrollbars hidden until the text is focused", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/pdf/styles.css"), "utf8");

    expect(styles).toMatch(/\.translation-block-text\s*{[^}]*overflow: hidden;[^}]*scrollbar-width: none;/s);
    expect(styles).toMatch(/\.translation-block-text:focus\s*{[^}]*overflow: auto;[^}]*scrollbar-width: thin;/s);
  });

  it("does not render page labels over the PDF", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pdf/index.ts"), "utf8");
    const html = readFileSync(resolve(process.cwd(), "pdf.html"), "utf8");
    const styles = readFileSync(resolve(process.cwd(), "src/pdf/styles.css"), "utf8");

    expect(source).not.toContain("page-label");
    expect(source).not.toContain("createPageLabel");
    expect(html).not.toContain("column-headings");
    expect(styles).not.toContain(".column-headings");
  });

  it("uses compact horizontal spacing around the PDF columns", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/pdf/styles.css"), "utf8");

    expect(styles).toContain("padding: 0 clamp(6px, 0.8vw, 14px) 80px;");
    expect(styles).toContain("gap: clamp(8px, 1vw, 14px);");
  });

  it("shows the PDF filename and page count on one line", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/pdf/styles.css"), "utf8");

    expect(styles).toMatch(/\.document-summary\s*{[^}]*display: flex;[^}]*align-items: baseline;/s);
    expect(styles).toMatch(/\.document-summary span\s*{[^}]*white-space: nowrap;/s);
  });

  it("supports inline editing and deletion", () => {
    const layer = createLayer();
    const onTextChange = vi.fn();
    const onDelete = vi.fn();
    const block = createEditableTranslationBlock(layer, {
      id: "page-1-text-1",
      text: "初始译文",
      color: "#222",
      fontFamily: "Arial",
      fontSize: 18,
      fontWeight: 400,
      lineHeight: 22,
      left: 100,
      top: 120,
      width: 300,
      height: 80,
      onTextChange,
      onDelete
    });
    layer.append(block);

    const editor = block.querySelector<HTMLElement>(".translation-block-text")!;
    const moveHandle = block.querySelector<HTMLButtonElement>(".translation-block-move")!;
    expect(moveHandle.textContent).toBe("✥");
    expect(moveHandle.getAttribute("aria-label")).toBe("移动译文块");
    expect(editor.contentEditable).toBe("true");
    editor.textContent = "人工修订后的译文";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onTextChange).toHaveBeenCalledWith("人工修订后的译文");

    block.querySelector<HTMLButtonElement>(".translation-block-delete")!.click();
    expect(onDelete).toHaveBeenCalledOnce();
    expect(layer.contains(block)).toBe(false);
  });

  it("moves and resizes in PDF-layer coordinates", () => {
    const layer = createLayer();
    const block = createEditableTranslationBlock(layer, {
      id: "page-1-text-2",
      text: "可移动译文",
      color: "#222",
      fontFamily: "Arial",
      fontSize: 18,
      fontWeight: 400,
      lineHeight: 22,
      left: 100,
      top: 120,
      width: 300,
      height: 80
    });
    layer.append(block);

    dispatchPointer(block.querySelector<HTMLElement>(".translation-block-move")!, "pointerdown", 100, 100);
    dispatchPointer(window, "pointermove", 150, 125);
    dispatchPointer(window, "pointerup", 150, 125);
    expect(block.style.left).toBe("200px");
    expect(block.style.top).toBe("170px");

    dispatchPointer(block.querySelector<HTMLElement>(".translation-block-resize")!, "pointerdown", 200, 200);
    dispatchPointer(window, "pointermove", 250, 225);
    dispatchPointer(window, "pointerup", 250, 225);
    expect(block.style.width).toBe("400px");
    expect(block.style.height).toBe("130px");
  });
});

function createLayer(): HTMLElement {
  const layer = document.createElement("div");
  layer.style.width = "1000px";
  layer.style.height = "1000px";
  vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 500,
    bottom: 500,
    left: 0,
    width: 500,
    height: 500,
    toJSON: () => ({})
  });
  document.body.append(layer);
  return layer;
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  clientX: number,
  clientY: number
): void {
  target.dispatchEvent(new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX,
    clientY
  }));
}
