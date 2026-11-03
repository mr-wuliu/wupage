// Runtime mocks must preserve the same format protocol as real providers.
export function structuredTranslation(source: string, text: string): string {
  if (!source.includes("⟪WUPAGEOPEN")) return text;
  return source.split(/(⟪WUPAGE(?:OPEN|CLOSE)\d+⟫)/gu)
    .map(part => /^⟪WUPAGE/u.test(part) || !/\p{L}/u.test(part) ? part : text).join("");
}

export function withoutMarkup(text: string): string {
  return text.replace(/⟪WUPAGE(?:OPEN|CLOSE)\d+⟫/gu, "");
}
