export interface TextSegment {
  id: string;
  text: string;
  element: Element;
}

export interface ProgressiveScanOptions {
  signal?: AbortSignal;
  onSegments?: (segments: TextSegment[]) => void;
  onPendingRoots?: (roots: Element[]) => void;
  observeChanges?: boolean;
}
