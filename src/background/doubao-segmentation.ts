import { t } from "../shared/i18n";
import { ProviderError } from "../shared/errors";
import { splitTranslationText } from "./text-segmentation";

export interface DoubaoSegment {
  sourceIndex: number;
  text: string;
  translate: boolean;
}

const PROTECTED_TOKEN = /⟪WUPAGE(?:OPEN|CLOSE|BREAK)?\d+⟫/gu;

function validateLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError("Expected a positive integer.");
}

function tooLong(): ProviderError {
  return new ProviderError(t("aProtectedMarkerExceedsDoubaoSLengthLimit"), "input-too-long");
}

function needsTranslation(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replace(PROTECTED_TOKEN, ""));
}

function appendChunk(output: DoubaoSegment[], sourceIndex: number, text: string): void {
  const prefix = /^\s*/u.exec(text)![0];
  const suffix = /\s*$/u.exec(text)![0];
  if (prefix.length === text.length) {
    if (text) output.push({ sourceIndex, text, translate: false });
    return;
  }
  if (prefix) output.push({ sourceIndex, text: prefix, translate: false });
  const middle = text.slice(prefix.length, text.length - suffix.length);
  if (middle) output.push({ sourceIndex, text: middle, translate: needsTranslation(middle) });
  if (suffix) output.push({ sourceIndex, text: suffix, translate: false });
}

/** Splits without losing any source characters or cutting a placeholder/surrogate pair. */
export function segmentDoubaoTexts(texts: string[], maxChars = 2000): DoubaoSegment[] {
  validateLimit(maxChars);
  const output: DoubaoSegment[] = [];
  for (const [sourceIndex, source] of texts.entries()) {
    const chunks = splitTranslationText(source, maxChars);
    if (!chunks) throw tooLong();
    for (const chunk of chunks) appendChunk(output, sourceIndex, chunk);
  }
  return output;
}

/** Returns indexes into the flat segments list; local fragments never enter requests. */
export function groupDoubaoSegments(
  segments: DoubaoSegment[],
  maxChars = 2000,
  maxItems = 10
): number[][] {
  validateLimit(maxChars);
  validateLimit(maxItems);
  const groups: number[][] = [];
  let group: number[] = [];
  let size = 0;
  for (const [index, segment] of segments.entries()) {
    if (!segment.translate) continue;
    if (!segment.text.trim()) {
      throw new ProviderError(t("theTextSegmentForDoubaoIsEmpty"), "incomplete");
    }
    if (segment.text.length > maxChars) throw tooLong();
    if (group.length && (size + segment.text.length > maxChars || group.length === maxItems)) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(index);
    size += segment.text.length;
  }
  if (group.length) groups.push(group);
  return groups;
}

export function reassembleDoubaoSegments(
  sourceCount: number,
  segments: DoubaoSegment[],
  translations: Map<number, string>
): string[] {
  if (!Number.isInteger(sourceCount) || sourceCount < 0) throw new RangeError("Invalid source count.");
  const output = Array<string>(sourceCount).fill("");
  for (const [index, segment] of segments.entries()) {
    if (!Number.isInteger(segment.sourceIndex) || segment.sourceIndex < 0 || segment.sourceIndex >= sourceCount) {
      throw new ProviderError(t("doubaoSTranslationDoesNotMatchTheSource"), "protocol-changed");
    }
    if (!segment.translate) {
      output[segment.sourceIndex] += segment.text;
      continue;
    }
    const translated = translations.get(index);
    if (typeof translated !== "string" || !translated.trim()) {
      throw new ProviderError(t("doubaoReturnedAnIncompleteTranslationTryAgain"), "incomplete");
    }
    // Source boundary whitespace is already represented by local fragments.
    output[segment.sourceIndex] += translated.trim();
  }
  return output;
}
