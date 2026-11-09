import { normalizeProtectedText } from "../shared/protected-text";
import type { TranslateBatchRequest } from "../shared/types";
import { assertTranslationResponse, TranslationResponseError } from "./translation-response";
import { splitTranslationText } from "./text-segmentation";

type Translate = (request: TranslateBatchRequest) => Promise<string[]>;
const MARKER = /^⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫$/u;

export async function translateTextWithRecovery(
  request: TranslateBatchRequest, translate: Translate, maxChars = Number.POSITIVE_INFINITY
): Promise<string[]> {
  const fitting = request.texts.filter(text => text.length <= maxChars);
  const initial = fitting.length ? await translate({ ...request, texts: fitting }) : [];
  assertTranslationResponse(initial, fitting.length);
  const output: string[] = [];
  let cursor = 0;
  for (const source of request.texts) {
    if (source.length > maxChars) {
      output.push(await translateProseFragments(source, request, translate, maxChars));
      continue;
    }
    const translation = initial[cursor++];
    const accepted = request.preservePlaceholders ? normalizeProtectedText(source, translation) : translation;
    if (accepted !== undefined) { output.push(accepted); continue; }
    // Retry only the damaged paragraph. Keep these calls sequential inside the
    // existing provider limiter instead of creating unbounded nested requests.
    const retry = await tryTranslate({ ...request, texts: [source] }, translate);
    const repaired = retry && normalizeProtectedText(source, retry[0]);
    output.push(repaired ?? await translateProseFragments(source, request, translate, maxChars));
  }
  return output;
}

async function translateProseFragments(
  source: string, request: TranslateBatchRequest, translate: Translate, maxChars: number
): Promise<string> {
  const protect = request.preservePlaceholders === true;
  const fragments = protect ? source.split(/(⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫)/gu) : [source];
  const parts = fragments.flatMap(part => {
    if (protect && MARKER.test(part)) return [part];
    const chunks = splitTranslationText(part, maxChars);
    if (!chunks) throw new TranslationResponseError("Could not split text within the provider's length limit.");
    return chunks;
  });
  const indexes = parts.flatMap((part, index) => (protect && MARKER.test(part)) || !/\p{L}/u.test(part) ? [] : [index]);
  const redact = (text: string) => text.replace(/⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫/gu, "[protected content]");
  const context = protect
    ? [request.context && redact(request.context), source.length <= maxChars && `Source paragraph (protected content withheld): ${redact(source)}`]
      .filter(Boolean).join("\n") || undefined
    : request.context;
  const validated = (sourceText: string, translated: string): string | undefined =>
    protect ? normalizeProtectedText(sourceText, translated) : translated;
  for (let start = 0; start < indexes.length; start += 16) {
    const group = indexes.slice(start, start + 16);
    const texts = group.map((index) => parts[index].trim());
    // No formula IDs are sent in this request or its context. Reinsert their
    // original sequence locally, even when a model keeps omitting them.
    const translated = await tryTranslate({ ...request, texts, context }, translate);
    for (let position = 0; position < group.length; position++) {
      const index = group[position];
      let text = translated && validated(texts[position], translated[position]);
      if (!text?.trim()) {
        const single = await tryTranslate({ ...request, texts: [texts[position]], context }, translate);
        text = single && validated(texts[position], single[0]);
      }
      if (!text?.trim()) throw new TranslationResponseError("Translation response did not include a usable translation for protected text.");
      const prefix = /^\s*/u.exec(parts[index])![0];
      const suffix = /\s*$/u.exec(parts[index])![0];
      parts[index] = prefix + text.trim() + suffix;
    }
  }
  const result = parts.join("");
  if (protect && normalizeProtectedText(source, result) === undefined) throw new TranslationResponseError("Translation response changed protected text.");
  return result;
}

async function tryTranslate(request: TranslateBatchRequest, translate: Translate): Promise<string[] | undefined> {
  try {
    const result = await translate(request);
    assertTranslationResponse(result, request.texts.length);
    return result;
  } catch (error) {
    // Do not multiply HTTP/authentication failures into per-fragment retries.
    if (!(error instanceof TranslationResponseError)) throw error;
    return undefined;
  }
}
