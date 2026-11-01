const pairs = new WeakMap<AbortSignal, WeakMap<AbortSignal, AbortSignal>>();

/** Keep cancellation working on Chromium versions without AbortSignal.any. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  const aborted = signals.find(signal => signal.aborted);
  if (aborted) { controller.abort(aborted.reason); return controller.signal; }
  // Page batches repeatedly combine the same tab/document lifetime. Share that
  // pair rather than retaining one listener per completed batch until tab close.
  if (signals.length === 2) {
    const cached = pairs.get(signals[0])?.get(signals[1]);
    if (cached) return cached;
    let second = pairs.get(signals[0]);
    if (!second) { second = new WeakMap(); pairs.set(signals[0], second); }
    second.set(signals[1], controller.signal);
  }
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of new Set(signals)) {
    const abort = () => {
      for (const [source, listener] of listeners) source.removeEventListener("abort", listener);
      listeners.clear();
      controller.abort(signal.reason);
    };
    listeners.set(signal, abort);
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
