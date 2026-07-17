export function renderTemplate(
  template: string,
  context: Record<string, string | string[]>
): string {
  return template.replace(/\{\{\s*(json\s+)?([a-zA-Z0-9_]+)\s*\}\}/g, (_, asJson, key) => {
    const value = context[key];
    if (asJson) return JSON.stringify(value ?? "");
    return Array.isArray(value) ? value.join("\n") : String(value ?? "");
  });
}

export function readPath(value: unknown, path: string): unknown {
  if (!path.trim()) return value;
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current == null) return undefined;
    if (/^\d+$/.test(segment) && Array.isArray(current)) return current[Number(segment)];
    if (typeof current === "object" && segment in current) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, value);
}
