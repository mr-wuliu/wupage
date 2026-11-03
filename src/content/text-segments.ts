export interface TextSegment {
  id: string;
  text: string;
  /** Validated format markers for transport; plain text stays available for scheduling. */
  readonly requestText?: string;
  element: Element;
}

export interface ProgressiveScanOptions {
  signal?: AbortSignal;
  onSegments?: (segments: TextSegment[]) => void;
  onPendingRoots?: (roots: Element[]) => void;
  observeChanges?: boolean;
}
