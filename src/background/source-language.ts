/** Uses the browser's local detector, shared by providers that need a source language. */
export async function detectSourceLanguage(texts: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  if (!texts.length) return undefined;
  const sample = texts.join("\n").replace(/⟪WUPAGE(?:OPEN|CLOSE|BREAK)?\d+⟫/gu, "").slice(0, 12000);
  if (!sample.trim()) return undefined;
  const detection = chrome.i18n.detectLanguage(sample);
  let onAbort: (() => void) | undefined;
  try {
    const result = signal ? await new Promise<chrome.i18n.LanguageDetectionResult>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      // The detector cannot be cancelled, but callers need not wait for it after
      // their task is aborted. Both handlers also consume a late API rejection.
      detection.then(resolve, reject);
      if (signal.aborted) onAbort();
    }) : await detection;
    signal?.throwIfAborted();
    const best = result.languages[0];
    return !best || best.language === "und" || best.percentage < 50 ? undefined : best.language;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
