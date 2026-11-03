import type { ExtensionSettings } from "./types";

function credentialName(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return /^(?:x|proxy)?(?:authorization|auth|apikey|accesskey(?:id|secret)?|secret(?:accesskey|key)?|clientsecret|(?:access|refresh|auth|id|security)?token|password|passwd|signature\d*|sig|cookie|setcookie)$/u.test(key)
    || /^(?:ocpapimsubscriptionkey|subscriptionkey|xgoogapikey|xrapidapikey)$/u.test(key)
    || /^(?:x)?(?:amz|goog)(?:credential|signature|securitytoken)$/u.test(key);
}

/** Transform decoded JSON string values and raw template text without touching property names. */
function mapRequestText(value: string, transform: (text: string) => string): string {
  let result = "", offset = 0;
  for (const match of value.matchAll(/"(?:\\.|[^"\\])*"/gu)) {
    result += transform(value.slice(offset, match.index));
    const raw = match[0]; offset = match.index + raw.length;
    if (/^\s*:/u.test(value.slice(offset))) { result += raw; continue; }
    try {
      const parsed = JSON.parse(raw) as string, cleaned = transform(parsed);
      result += cleaned === parsed ? raw : JSON.stringify(cleaned);
    } catch { result += transform(raw); }
  }
  return result + transform(value.slice(offset));
}

/** Preserve configuration and template syntax; redact credential values only. */
export function withoutSettingsKeys(settings: ExtensionSettings): ExtensionSettings {
  const result = structuredClone(settings);
  const secrets = new Set<string>();
  const credential = (value: string, allowReference = true): string => {
    // A reference to a key is configuration, not a saved key value.
    if (/^(?:(?:Bearer|Basic|Token|ApiKey)\s+)?\{\{[^{}\r\n]+\}\}$/iu.test(value.trim())) return allowReference ? value : "";
    if (value) secrets.add(value);
    return "";
  };
  function decode(value: string): string {
    try { return decodeURIComponent(value.replace(/\+/gu, " ")); } catch { return value; }
  }
  function text(value: string): string {
    // This also handles JSON templates whose placeholders are not valid JSON.
    value = value.replace(/("(?:\\.|[^"\\])*")(\s*:\s*)("(?:\\.|[^"\\])*")/gu, (match, name: string, separator: string, raw: string) => {
      try {
        if (!credentialName(JSON.parse(name) as string)) return match;
        const parsed = JSON.parse(raw) as string, cleaned = credential(parsed);
        return cleaned === parsed ? match : name + separator + JSON.stringify(cleaned);
      } catch { return match; }
    });
    return mapRequestText(value, plain => plain
      .replace(/([a-z][a-z\d+.-]*:\/\/[^:/?#@\s]*:)([^/?#@\s]*)(@)/giu,
        (match, prefix: string, password: string, suffix: string) =>
          credential(decode(password)) === decode(password) ? match : prefix + suffix)
      .replace(/(^|[?&#;\s])([\w.%+-]+)=((?:\{\{[^{}]*\}\}|[^&#;\s"'<>])*)/gu, (match, prefix: string, name: string, raw: string) =>
        credentialName(decode(name)) && credential(decode(raw)) !== decode(raw) ? `${prefix}${name}=` : match)
      .replace(/<([\w:.-]+)>([^<>]*)<\/\1>/gu, (match, name: string, raw: string) =>
        credentialName(name) && credential(raw) !== raw ? `<${name}></${name}>` : match));
  }
  for (const provider of result.providers) {
    if ("apiKey" in provider) provider.apiKey = credential(provider.apiKey, false);
    if ("api" in provider && provider.api) {
      for (const key of ["apiKey", "accessKeyId", "secretAccessKey"] as const) {
        if (provider.api[key] !== undefined) provider.api[key] = credential(provider.api[key], false);
      }
      if (provider.api.endpoint !== undefined) provider.api.endpoint = text(provider.api.endpoint);
    }
    if ("baseURL" in provider) provider.baseURL = text(provider.baseURL);
    if ("endpoint" in provider) provider.endpoint = text(provider.endpoint);
    if ("systemPrompt" in provider) provider.systemPrompt = text(provider.systemPrompt);
    if ("requestTemplate" in provider && provider.requestTemplate) {
      provider.requestTemplate.headers = text(provider.requestTemplate.headers);
      provider.requestTemplate.body = text(provider.requestTemplate.body);
    }
    if (provider.type === "http-template") {
      provider.url = text(provider.url);
      provider.headers = Object.fromEntries(Object.entries(provider.headers).map(([name, value]) =>
        [name, credentialName(name) ? credential(value) : text(value)]));
      provider.bodyTemplate = text(provider.bodyTemplate);
    }
  }
  // Also remove copies of known credentials in otherwise opaque request fields.
  const known = [...secrets].sort((a, b) => b.length - a.length);
  function scrubValue(value: string): string {
    for (const secret of known) {
      if (value === secret) return "";
      if (secret.length < 8) continue; // Short substrings would corrupt ordinary text.
      value = value.split(secret).join("");
      try { value = value.split(encodeURIComponent(secret)).join(""); } catch { /* A raw key may contain an unpaired surrogate. */ }
    }
    return value;
  }
  const scrub = (value: string): string => mapRequestText(value, scrubValue);
  for (const provider of result.providers) {
    for (const field of ["baseURL", "endpoint", "url", "systemPrompt", "bodyTemplate"] as const) {
      if (field in provider) {
        const record = provider as unknown as Record<string, string>;
        record[field] = scrub(record[field]);
      }
    }
    if ("api" in provider && provider.api?.endpoint !== undefined) provider.api.endpoint = scrub(provider.api.endpoint);
    if ("requestTemplate" in provider && provider.requestTemplate) {
      provider.requestTemplate.headers = scrub(provider.requestTemplate.headers);
      provider.requestTemplate.body = scrub(provider.requestTemplate.body);
    }
    if (provider.type === "http-template") provider.headers = Object.fromEntries(Object.entries(provider.headers).map(([name, value]) => [name, scrub(value)]));
  }
  return result;
}
