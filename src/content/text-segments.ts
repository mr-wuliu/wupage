export interface TextSegment {
  id: string;
  text: string;
  /** Validated format markers for transport; plain text stays available for scheduling. */
  readonly requestText?: string;
  element: Element;
  /** The exact layout range when the containing element has no box. */
  anchor?: Text;
}

export interface ProgressiveScanOptions {
  signal?: AbortSignal;
  onSegments?: (segments: TextSegment[]) => void;
  onPendingRoots?: (roots: Element[]) => void;
  observeChanges?: boolean;
}
