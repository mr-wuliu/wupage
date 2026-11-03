import { normalizeProtectedText } from "../shared/protected-text";
import type { TranslateBatchRequest } from "../shared/types";
import { assertTranslationResponse, TranslationResponseError } from "./translation-response";

type Translate = (request: TranslateBatchRequest) => Promise<string[]>;

export async function translateProtectedText(request: TranslateBatchRequest, translate: Translate): Promise<string[]> {
  const initial = await translate(request);
  assertTranslationResponse(initial, request.texts.length);
  const output = initial.map((text, index) => normalizeProtectedText(request.texts[index], text));
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== undefined) continue;
    const source = request.texts[index];
    // Retry only the damaged paragraph. Keep these calls sequential inside the
    // existing provider limiter instead of creating unbounded nested requests.
    const retry = await tryTranslate({ ...request, texts: [source] }, translate);
    const repaired = retry && normalizeProtectedText(source, retry[0]);
    output[index] = repaired ?? await translateProseFragments(source, request, translate);
  }
  return output as string[];
}

async function translateProseFragments(source: string, request: TranslateBatchRequest, translate: Translate): Promise<string> {
  const parts = source.split(/(⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫)/gu);
  const indexes = parts.flatMap((part, index) => /^⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫$/u.test(part) || !/\p{L}/u.test(part) ? [] : [index]);
  const redact = (text: string) => text.replace(/⟪WUPAGE(?:OPEN|CLOSE)?\d+⟫/gu, "[protected content]");
  const context = [request.context && redact(request.context), `Source paragraph (protected content withheld): ${redact(source)}`]
    .filter(Boolean).join("\n");
  for (let start = 0; start < indexes.length; start += 16) {
    const group = indexes.slice(start, start + 16);
    const texts = group.map((index) => parts[index].trim());
    // No formula IDs are sent in this request or its context. Reinsert their
    // original sequence locally, even when a model keeps omitting them.
    const translated = await tryTranslate({ ...request, texts, context }, translate);
    for (let position = 0; position < group.length; position++) {
      const index = group[position];
      let text = translated && normalizeProtectedText(texts[position], translated[position]);
      if (!text?.trim()) {
        const single = await tryTranslate({ ...request, texts: [texts[position]], context }, translate);
        text = single && normalizeProtectedText(texts[position], single[0]);
      }
      if (!text?.trim()) throw new TranslationResponseError("Translation response did not include a usable translation for protected text.");
      const prefix = /^\s*/u.exec(parts[index])![0];
      const suffix = /\s*$/u.exec(parts[index])![0];
      parts[index] = prefix + text.trim() + suffix;
    }
  }
  const result = parts.join("");
  if (normalizeProtectedText(source, result) === undefined) throw new TranslationResponseError("Translation response changed protected text.");
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
