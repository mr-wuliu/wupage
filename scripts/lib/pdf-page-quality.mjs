// Serialized into the isolated test browser; keep this function self-contained.
export function inspectPdfPageQuality(pageNumber, protectedRegions = []) {
  const row = document.querySelector(`article[data-page="${pageNumber}"]`);
  const shell = row.querySelector('.original-panel .canvas-shell');
  const [width, height] = shell.style.aspectRatio.split('/').map(Number);
  const canvas = row.querySelector('.translated-panel > .canvas-shell > canvas');
  const page = canvas.getBoundingClientRect(), sx = page.width / width, sy = page.height / height;
  const box = rect => ({ left: (rect.left - page.left) / sx, top: (rect.top - page.top) / sy,
    right: (rect.right - page.left) / sx, bottom: (rect.bottom - page.top) / sy });
  const blocks = [...row.querySelectorAll('.translation-block')].map(block => {
    const text = block.querySelector('.translation-block-text'), style = getComputedStyle(text);
    const range = document.createRange(); range.selectNodeContents(text);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(box);
    const bounds = box(text.getBoundingClientRect());
    const problems = [];
    if (block.dataset.layoutOverflow || text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1) problems.push('overflow');
    if (!rects.length || style.visibility === 'hidden' || Number(style.opacity) === 0) problems.push('invisible');
    if (/⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫/u.test(text.textContent)) problems.push('placeholder');
    if (rects.some(rect => rect.left < -1 || rect.top < -1 || rect.right > width + 1 || rect.bottom > height + 1)) problems.push('outside-page');
    const size = parseFloat(text.style.fontSize), preferred = Number(block.dataset.preferredFontSize);
    if (size < preferred * 0.6 - 0.05) problems.push('unreadable-size');
    return { id: block.dataset.blockId, text: text.textContent, size, preferred, bounds, rects, problems };
  });
  const intersects = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const area = Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top));
    return w > 1 && h > 1 && w * h > area * 0.2;
  };
  const collisions = [];
  for (let a = 0; a < blocks.length; a++) for (let b = a + 1; b < blocks.length; b++) {
    if (blocks[a].rects.some(first => blocks[b].rects.some(second => intersects(first, second)))) {
      collisions.push([blocks[a].id, blocks[b].id]);
    }
  }
  const protectedOverlaps = [];
  for (const region of protectedRegions.filter(region => region.page === pageNumber)) {
    const bounds = { left: region.x, right: region.x + region.width,
      top: height - region.y - region.height, bottom: height - region.y };
    for (const block of blocks) if (block.rects.some(rect => intersects(rect, bounds))) protectedOverlaps.push({ id: block.id, region });
  }
  return { page: pageNumber, width, height, blocks, collisions, protectedOverlaps };
}
