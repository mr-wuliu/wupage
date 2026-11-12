import { t } from "../shared/i18n";
import { fitTranslationBlock, refreshTranslationBlockOverflow } from "./editor";

interface TextRegion { block: HTMLElement; bounds: DOMRect; rects: DOMRect[] }

// Measure the rendered text, including inline formulas. Rectangular source
// bounds alone cannot detect a translated last line running into its neighbor.
export function validateTranslationLayout(layer: HTMLElement, repair = false): { collisions: string[][]; unsafe: number } {
  const blocks = [...layer.querySelectorAll<HTMLElement>(".translation-block")].filter(block => block.querySelector(".translation-block-text"));
  const unit = layer.getBoundingClientRect().width / (Number.parseFloat(layer.style.width) || 1)
    * (Number(layer.dataset.coordinateScale) || 1);
  const tolerance = Math.max(0.5, unit * 0.75);
  const measure = (block: HTMLElement): TextRegion => {
    const text = block.querySelector<HTMLElement>(".translation-block-text")!;
    const range = document.createRange(); range.selectNodeContents?.(text);
    const rects = typeof range.getClientRects === "function" ? [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0) : [];
    return { block, bounds: block.getBoundingClientRect(), rects };
  };
  const overlaps = (a: TextRegion, b: TextRegion): boolean => a.rects.some(first => b.rects.some(second => {
    const width = Math.min(first.right, second.right) - Math.max(first.left, second.left);
    const height = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
    return width > tolerance && height > tolerance && width * height > Math.min(first.width * first.height, second.width * second.height) * 0.2;
  }));
  let regions = blocks.map(measure);
  if (repair) for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let first = 0; first < regions.length; first++) for (let second = first + 1; second < regions.length; second++) {
      let a = regions[first], b = regions[second];
      if (!overlaps(a, b)) continue;
      if (a.bounds.top > b.bounds.top) [a, b] = [b, a];
      const scale = a.bounds.height / Number.parseFloat(a.block.style.height);
      const top = Math.min(...b.rects.map(rect => rect.top));
      const height = (top - a.bounds.top - tolerance) / scale;
      const text = a.block.querySelector<HTMLElement>(".translation-block-text")!;
      if (!scale || height < Number.parseFloat(text.style.fontSize) * 0.8 || height >= Number.parseFloat(a.block.style.height) - 0.5) continue;
      const oldHeight = a.block.style.height, oldMaximum = a.block.dataset.maximumAutoHeight;
      const styles = [text, ...text.querySelectorAll<HTMLElement>(".pdf-inline-formula")].map(element => [element, element.style.cssText] as const);
      a.block.style.height = `${height}px`;
      a.block.dataset.maximumAutoHeight = String(height);
      fitTranslationBlock(a.block);
      if (a.block.dataset.layoutOverflow) {
        a.block.style.height = oldHeight;
        if (oldMaximum === undefined) delete a.block.dataset.maximumAutoHeight;
        else a.block.dataset.maximumAutoHeight = oldMaximum;
        for (const [element, style] of styles) element.style.cssText = style;
        refreshTranslationBlockOverflow(a.block);
      } else changed = true;
      regions[first] = measure(regions[first].block); regions[second] = measure(regions[second].block);
    }
    if (!changed) break;
  }
  const collisions: string[][] = [], unsafe = new Set<HTMLElement>();
  for (const block of blocks) {
    delete block.dataset.layoutCollision;
    if (refreshTranslationBlockOverflow(block)) unsafe.add(block);
  }
  for (let a = 0; a < regions.length; a++) for (let b = a + 1; b < regions.length; b++) if (overlaps(regions[a], regions[b])) {
    const pair = [regions[a].block, regions[b].block];
    collisions.push(pair.map(block => block.dataset.blockId!));
    for (const block of pair) {
      block.dataset.layoutCollision = "true"; block.title = t("someTranslatedTextDoesNotFitAtA");
      block.querySelector(".translation-block-text")?.setAttribute("aria-invalid", "true"); unsafe.add(block);
    }
  }
  const panel = layer.closest(".translated-panel");
  if (panel) {
    let notice = panel.querySelector<HTMLElement>(".translation-layout-warning");
    if (!notice && unsafe.size) {
      notice = document.createElement("p"); notice.className = "translation-layout-warning"; notice.setAttribute("role", "status");
      notice.textContent = t("someTranslatedTextDoesNotFitAtA"); panel.append(notice);
    }
    if (notice) notice.hidden = unsafe.size === 0;
  }
  return { collisions, unsafe: unsafe.size };
}
