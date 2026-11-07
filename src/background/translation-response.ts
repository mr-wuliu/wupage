import { t } from "../shared/i18n";
// Only malformed translation content is recoverable by splitting a batch.
// Transport, authentication and endpoint errors must retain their own meaning.
export class TranslationResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationResponseError";
  }
}

export function assertTranslationResponse(result: unknown, expectedLength: number): asserts result is string[] {
  if (!Array.isArray(result) || result.length !== expectedLength
    || Array.from(result).some((text) => typeof text !== "string" || !text.trim())) {
    throw new TranslationResponseError(t("responseItemsMissing"));
  }
}
