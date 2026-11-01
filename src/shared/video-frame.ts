export interface VideoFrameArea {
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
}

/** Screenshots must contain the entire frame, without silently clipping its text. */
export function validVideoFrameArea(area: VideoFrameArea): boolean {
  const rect = area?.rect, viewport = area?.viewport;
  return !!rect && !!viewport
    && [rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height].every(Number.isFinite)
    && viewport.width > 0 && viewport.height > 0 && viewport.width <= 20000 && viewport.height <= 20000
    && rect.width >= 1 && rect.height >= 1 && rect.x >= 0 && rect.y >= 0
    && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height;
}
