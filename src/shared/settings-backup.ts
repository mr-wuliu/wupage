import { normalizeSettings } from "./settings";
import { supportsRequestTemplate } from "./request-template";
import { supportsServiceMode, translationApiOptions } from "./translation-service";
import type { ExtensionSettings, HttpTemplateConfig, ProviderConfig, TranslationApiOptions } from "./types";

/** Marker written into exported files so a wrong JSON file is rejected clearly. */
const BACKUP_APP = "wupage";
const BACKUP_KIND = "settings";
/** Bumped only when the file layout changes; the settings body keeps its own migration path. */
export const SETTINGS_BACKUP_VERSION = 1;
/** A real settings file is a few kilobytes; a larger one is a wrong file, and reading it would stall the options page. */
export const SETTINGS_BACKUP_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Key field names. Their values are blanked on export but the fields themselves stay,
 * because normalizeSettings drops a provider whose required string fields are missing.
 */
const PROVIDER_KEY_FIELDS = ["apiKey"] as const;
const SERVICE_KEY_FIELDS = ["apiKey", "accessKeyId", "secretAccessKey"] as const;

export interface SettingsBackupFile {
  app: typeof BACKUP_APP;
  kind: typeof BACKUP_KIND;
  version: number;
  exportedAt: string;
  /** Whether this file is allowed to carry keys; false means the keys were stripped. */
  includesKeys: boolean;
  settings: ExtensionSettings;
}

/**
 * A parsed file plus the intent recorded in it. Bare settings objects and files written
 * before the option existed report `includesKeys: true`, matching the old export behaviour.
 */
export interface ParsedSettingsBackup {
  settings: ExtensionSettings;
  includesKeys: boolean;
}

/**
 * Header names that carry a credential. Matching on the name fragment rather than on a fixed
 * list keeps an invented header such as `x-custom-auth` covered too: a carrier this export fails
 * to recognise leaves a key in a file the panel calls "without keys". Compared case-insensitively
 * because HTTP header names are not case-sensitive and the panel stores what the user typed.
 */
const CREDENTIAL_HEADER =
  /(?:^|-)(?:auth(?:orization)?|api-?key|api_?key|access-?token|token|secret|credential|signature|sig|cookie|session|subscription-?key)(?:$|-)/iu;

/** Member and query-parameter names whose value is the credential itself. */
const CREDENTIAL_MEMBER =
  /^(?:auth|api[_-]?key|api[_-]?token|access[_-]?key|access[_-]?token|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential|credentials|authorization|signature|sig)$/iu;

/** A credential pasted into a template as a literal instead of as a {{variable}}. */
const LITERAL_CREDENTIAL_SOURCE = String.raw`\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+(?!\{\{)[A-Za-z0-9._~+/=-]{8,}`;
/** Replacement form; the sticky flag keeps `replace` walking the whole value. */
const LITERAL_CREDENTIAL = new RegExp(LITERAL_CREDENTIAL_SOURCE, "gu");
/** Detection form; a shared /g state would make consecutive `test` calls disagree. */
const LITERAL_CREDENTIAL_TEST = new RegExp(LITERAL_CREDENTIAL_SOURCE, "u");

/**
 * Keeps a template value that renders the key at runtime and drops a literal one. The variable
 * form is safe because the key it expands from is blanked by this same export.
 */
function withoutCredentialValue(value: string): string {
  return value.includes("{{") ? value.replace(LITERAL_CREDENTIAL, "") : "";
}

/**
 * Blanks credential members at any depth of a parsed JSON document, keeping its shape. In a
 * header map a member whose value is shaped like a key is blanked as well, because inventing a
 * header name the word list misses is an ordinary thing for a user to do.
 */
function withoutJsonCredentials(value: unknown, headerMap = false): unknown {
  if (typeof value === "string") {
    return headerMap && looksLikeSecret(value) ? "" : value.replace(LITERAL_CREDENTIAL, "");
  }
  if (Array.isArray(value)) return value.map((entry) => withoutJsonCredentials(entry, headerMap));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([name, entry]) => {
    if (credentialName(name)) {
      return [name, typeof entry === "string" ? withoutCredentialValue(entry) : null];
    }
    if (headerMap && typeof entry === "string" && looksLikeSecret(entry)) {
      return [name, withoutCredentialValue(entry)];
    }
    return [name, withoutJsonCredentials(entry, headerMap)];
  }));
}

/**
 * Custom HTTP Template and LLM request templates keep their authentication in free-form text,
 * so a fixed field list cannot cover them. A JSON template is walked member by member; a template
 * that renders a variable is not valid JSON, so the same credential members are blanked in the
 * text instead. Only scanning for credential-shaped literals is not enough: a key named by a
 * member such as `api_key` carries no recognisable prefix and would otherwise be written to a
 * file the panel calls "without keys".
 */
function withoutTemplateCredentials(text: string, headerMap = false): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return sanitizeTemplateText(text).text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A template such as {"api_key":"…","q":{{json texts}}} is text, not JSON with bad syntax:
    // the unquoted variable makes it unparseable, but its member names are still ordinary JSON
    // keys, so they are scanned rather than falling back to credential prefixes.
    return sanitizeTemplateText(text).text;
  }
  return JSON.stringify(withoutJsonCredentials(parsed, headerMap), null, 2);
}

/** A member name in a template that is JSON-shaped but not parseable, such as `{"q":{{json texts}}}`. */
const TEMPLATE_MEMBER = /"((?:[^"\\]|\\.)*)"[ \t\r\n]*:/gu;
/** A `name=value` pair, the shape a query string or a form-encoded body uses. */
const TEMPLATE_ASSIGNMENT = /(^|[&;,\s?])([A-Za-z0-9_.\-]+)=([^&;\s]*)/gu;

/**
 * Blanks the credential members of a template that is not valid JSON. Its member names are still
 * ordinary JSON keys, so the text is scanned for `"name": value` and `name=value` pairs and a
 * credential-named value is blanked in place. A value that renders a variable survives: the key it
 * expands from is blanked by this same export, so the request still authenticates after a restore.
 * Returns whether anything was removed, which is what tells the import a provider holds a key.
 */
function sanitizeTemplateText(text: string): { text: string; changed: boolean } {
  let out = "";
  let cursor = 0;
  TEMPLATE_MEMBER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_MEMBER.exec(text)) !== null) {
    if (!credentialName(decodeMemberName(match[1] ?? ""))) continue;
    const valueStart = match.index + match[0].length;
    const value = readTemplateValue(text, valueStart);
    if (!value) continue;
    out += text.slice(cursor, valueStart) + credentialMemberReplacement(value.raw);
    cursor = value.end;
    TEMPLATE_MEMBER.lastIndex = value.end;
  }
  out += text.slice(cursor);
  const assigned = out.replace(TEMPLATE_ASSIGNMENT, (whole: string, lead: string, name: string, value: string) =>
    credentialName(name) ? `${lead}${name}=${credentialAssignmentReplacement(value)}` : whole
  );
  const stripped = assigned.replace(LITERAL_CREDENTIAL, "");
  return { text: stripped, changed: stripped !== text };
}

/** A member name arrives as the inside of a JSON string, so its escapes have to be decoded. */
function decodeMemberName(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** What replaces a credential member's value: a variable survives, a literal does not. */
function credentialMemberReplacement(raw: string): string {
  if (!raw.startsWith('"')) return raw.includes("{{") ? raw : "null";
  let decoded: string;
  try {
    decoded = JSON.parse(raw) as string;
  } catch {
    return '""';
  }
  return JSON.stringify(withoutCredentialValue(decoded));
}

/** What replaces a `name=value` credential; an empty value keeps the parameter shape. */
function credentialAssignmentReplacement(value: string): string {
  return value.includes("{{") ? value.replace(LITERAL_CREDENTIAL, "") : "";
}

/**
 * Measures the value after a member name. A string literal, a `{{variable}}`, a balanced object or
 * array and a bare token are all possible in a template that renders variables, so the end is found
 * by hand rather than by a parser that would reject the text.
 */
function readTemplateValue(text: string, from: number): { raw: string; end: number } | null {
  let start = from;
  while (start < text.length && /\s/u.test(text[start] ?? "")) start += 1;
  if (start >= text.length) return null;
  if (text.startsWith("{{", start)) {
    const close = text.indexOf("}}", start + 2);
    return close === -1 ? null : { raw: text.slice(start, close + 2), end: close + 2 };
  }
  const first = text[start] ?? "";
  if (first === '"') {
    const end = endOfString(text, start);
    return end === -1 ? null : { raw: text.slice(start, end), end };
  }
  if (first === "{" || first === "[") {
    const end = endOfBalanced(text, start);
    return end === -1 ? null : { raw: text.slice(start, end), end };
  }
  let end = start;
  while (end < text.length && !",}]".includes(text[end] ?? "")) end += 1;
  const raw = text.slice(start, end).trimEnd();
  return { raw, end: start + raw.length };
}

/** The index just past the closing quote of the JSON string starting at `start`, or -1. */
function endOfString(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"') return index + 1;
  }
  return -1;
}

/** The index just past the `}` or `]` closing the value starting at `start`, or -1. */
function endOfBalanced(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const end = endOfString(text, index);
      if (end === -1) return -1;
      index = end - 1;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Drops credentials from an endpoint while keeping the text the user wrote: the URL is edited
 * in place rather than through `URL`, which would reorder and percent-encode the request.
 * Template variables such as `{{targetLang}}` are left alone, because they are not credentials.
 */
function withoutEndpointCredentials(value: string): string {
  const cleaned = value.replace(LITERAL_CREDENTIAL, "");
  // User info in a URL is sent as basic auth on every request.
  const withoutUserInfo = cleaned.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/iu, "$1");
  const hashAt = withoutUserInfo.indexOf("#");
  const fragment = hashAt === -1 ? "" : withoutUserInfo.slice(hashAt);
  const address = hashAt === -1 ? withoutUserInfo : withoutUserInfo.slice(0, hashAt);
  const queryAt = address.indexOf("?");
  if (queryAt === -1) return withoutUserInfo;
  const query = address.slice(queryAt + 1).split("&").map((part) => {
    const name = part.split("=")[0] ?? "";
    return credentialName(name) ? `${name}=` : part;
  }).join("&");
  return `${address.slice(0, queryAt)}?${query}${fragment}`;
}

/** Query parameters and JSON members arrive percent-encoded, so compare the decoded name. */
function credentialName(name: string): boolean {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // A malformed escape is not credential-shaped, so it is left for the user to see.
  }
  return CREDENTIAL_HEADER.test(decoded) || CREDENTIAL_MEMBER.test(decoded);
}

/**
 * A value shaped like a credential rather than like a protocol constant. A header name the word
 * list does not recognise is still a likely carrier, and a key pasted as base64, hex or a bare
 * token matches none of the literal prefixes, so the shape is what has to decide. MIME types and
 * language tags are the protocol values that legitimately look like a token, so they are excluded.
 */
function looksLikeSecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 24 || trimmed.includes("{{") || /\s/u.test(trimmed)) return false;
  if (/^[a-z]+\/[a-z0-9.+-]+$/iu.test(trimmed)) return false;
  if (/^[a-z]{2}(?:-[a-z]{2})?$/iu.test(trimmed)) return false;
  return /^[A-Za-z0-9+/=_.~-]+$/u.test(trimmed);
}

/**
 * Blanks every key in place on a copy, so the provider still passes normalizeSettings. The
 * supported credential carriers are the key fields, the service-mode api block, the custom
 * HTTP Template headers and the LLM request template; a carrier this function cannot recognise
 * would leave a key in a file the panel calls "without keys", so each one is handled here.
 */
function withoutProviderKeys(provider: ProviderConfig): ProviderConfig {
  const copy = structuredClone(provider) as ProviderConfig;
  // ProviderConfig is a union, so a keyed write needs the record view the field lists describe.
  const record = copy as unknown as Record<string, unknown>;
  for (const field of PROVIDER_KEY_FIELDS) {
    if (typeof record[field] === "string") record[field] = "";
  }
  if (supportsServiceMode(copy) && copy.api) {
    const api: TranslationApiOptions = { ...copy.api };
    for (const field of SERVICE_KEY_FIELDS) {
      if (typeof api[field] === "string") api[field] = "";
    }
    copy.api = api;
  }
  if (copy.type === "http-template") {
    copy.headers = Object.fromEntries(Object.entries(copy.headers).map(([name, value]) => [
      name,
      credentialName(name) || looksLikeSecret(value)
        ? withoutCredentialValue(value)
        : value.replace(LITERAL_CREDENTIAL, "")
    ]));
    copy.url = withoutEndpointCredentials(copy.url);
    copy.bodyTemplate = withoutTemplateCredentials(copy.bodyTemplate);
  }
  if (supportsRequestTemplate(copy) && copy.requestTemplate) {
    copy.requestTemplate = {
      enabled: copy.requestTemplate.enabled,
      headers: withoutTemplateCredentials(copy.requestTemplate.headers, true),
      body: withoutTemplateCredentials(copy.requestTemplate.body)
    };
  }
  return copy;
}

/** Whether a template still holds a credential once its variables are ignored. */
function templateHasCredential(text: string, headerMap = false): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return sanitizeTemplateText(text).changed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Variable-only templates such as {"q":{{json texts}}} are text, so the same member scan the
    // export applies decides it; a credential-shaped literal alone would miss a named member.
    return sanitizeTemplateText(text).changed;
  }
  return documentHasCredential(parsed, headerMap);
}

function documentHasCredential(value: unknown, headerMap = false): boolean {
  if (typeof value === "string") {
    return LITERAL_CREDENTIAL_TEST.test(value) || (headerMap && looksLikeSecret(value));
  }
  if (Array.isArray(value)) return value.some((entry) => documentHasCredential(entry, headerMap));
  const record = asRecord(value);
  if (!record) return false;
  return Object.entries(record).some(([name, entry]) =>
    credentialName(name)
      ? typeof entry === "string" && !entry.includes("{{") && entry.trim() !== ""
      : documentHasCredential(entry, headerMap)
  );
}

/** Whether this provider currently holds a key the user may not want written to a file. */
export function providerHasStoredKey(provider: ProviderConfig): boolean {
  if (PROVIDER_KEY_FIELDS.some((field) => {
    const value = (provider as unknown as Record<string, unknown>)[field];
    return typeof value === "string" && value.trim() !== "";
  })) return true;
  if (supportsServiceMode(provider) && Boolean(provider.api)
    && SERVICE_KEY_FIELDS.some((field) => {
      const value = provider.api?.[field];
      return typeof value === "string" && value.trim() !== "";
    })) return true;
  // The custom carriers hold credentials this export cannot recognise by field name, so any
  // value left in them counts as a stored key. An HTTP Template renders only the text variables,
  // so a credential-named header there is always a literal, never a safe `{{apiKey}}`.
  if (provider.type === "http-template") {
    const headerHoldsKey = Object.entries(provider.headers).some(([name, value]) =>
      credentialName(name) || looksLikeSecret(value)
        ? value.trim() !== ""
        : templateHasCredential(value)
    );
    if (headerHoldsKey) return true;
    if (templateHasCredential(provider.bodyTemplate)) return true;
    if (provider.url.includes("{{")) {
      if (templateHasCredential(provider.url)) return true;
    } else if (provider.url !== withoutEndpointCredentials(provider.url)) return true;
  }
  if (supportsRequestTemplate(provider) && provider.requestTemplate) {
    if (templateHasCredential(provider.requestTemplate.headers, true)) return true;
    if (templateHasCredential(provider.requestTemplate.body)) return true;
  }
  return false;
}

export class SettingsBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsBackupError";
  }
}

/** Fields that identify a JSON object as extension settings rather than an unrelated document. */
const SETTINGS_MARKERS = [
  "providers",
  "activeProviderId",
  "targetLang",
  "sourceLang",
  "appearance",
  "shortcuts",
  "translationDisplayMode",
  "chunkSize",
  "concurrency"
] as const;

/**
 * Keys are stripped unless the caller explicitly opts in, so a file that leaves the browser
 * cannot leak a translation key by default. Blanking keeps each provider's shape, which is
 * what lets a key-less file still restore every other field.
 */
export function createSettingsBackup(
  settings: ExtensionSettings,
  exportedAt: Date = new Date(),
  options: { includesKeys?: boolean } = {}
): SettingsBackupFile {
  const includesKeys = options.includesKeys === true;
  const body = structuredClone(settings);
  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: SETTINGS_BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    includesKeys,
    settings: includesKeys
      ? body
      : { ...body, providers: body.providers.map(withoutProviderKeys) }
  };
}

/** Local-time stamp so consecutive exports on the same day stay distinguishable. */
export function settingsBackupFileName(exportedAt: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${exportedAt.getFullYear()}${pad(exportedAt.getMonth() + 1)}${pad(exportedAt.getDate())}`;
  const time = `${pad(exportedAt.getHours())}${pad(exportedAt.getMinutes())}`;
  return `wupage-settings-${date}-${time}.json`;
}

/**
 * Accepts both an exported backup file and a bare settings object, so a hand-edited
 * or partial file still imports. Every legacy value is migrated by normalizeSettings,
 * which is the same path used when reading storage, so validation is not duplicated
 * here; keys that survive it are written back verbatim, which is not a filter for
 * unknown fields.
 */
export function parseSettingsBackup(text: string): ParsedSettingsBackup {
  if (text.length > SETTINGS_BACKUP_MAX_BYTES) {
    throw new SettingsBackupError("导入失败：文件过大，这不是设置备份文件。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SettingsBackupError("导入失败：文件不是有效的 JSON。");
  }
  const file = asRecord(parsed);
  if (!file) throw new SettingsBackupError("导入失败：文件内容不是设置对象。");
  if (file.app !== undefined && file.app !== BACKUP_APP) {
    throw new SettingsBackupError("导入失败：这不是 WuPage 的设置备份。");
  }
  if (file.kind !== undefined && file.kind !== BACKUP_KIND) {
    throw new SettingsBackupError("导入失败：这不是设置备份。");
  }
  if (file.version !== undefined && typeof file.version !== "number") {
    throw new SettingsBackupError("导入失败：备份文件的版本无法识别。");
  }
  if (typeof file.version === "number" && file.version > SETTINGS_BACKUP_VERSION) {
    throw new SettingsBackupError(`导入失败：备份来自更新版本的 WuPage（版本 ${file.version}），请先更新扩展。`);
  }
  const candidate = file.settings === undefined ? file : asRecord(file.settings);
  if (!candidate) throw new SettingsBackupError("导入失败：文件里没有可识别的设置。");
  if (!SETTINGS_MARKERS.some((key) => key in candidate)) {
    throw new SettingsBackupError("导入失败：文件里没有可识别的 WuPage 设置。");
  }
  return {
    settings: normalizeSettings(candidate),
    // A bare settings object carries no intent marker; treat it as a full file so a
    // hand-written key still imports, which is what the old format meant.
    includesKeys: file.includesKeys !== false
  };
}

/**
 * The hosts a provider sends its credential to. A key-less file may come from another device, a
 * shared configuration or a hand edit, so matching on id alone would hand a stored key to whatever
 * address the file names; only the endpoints that receive the credential identify the service.
 */
function credentialEndpoints(provider: ProviderConfig): string[] {
  const record = provider as unknown as Record<string, unknown>;
  const endpoints: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) endpoints.push(normalizeEndpoint(value));
  };
  // Every LLM type posts its key to baseURL; it is also where a rewired HTTP Template points.
  push(record.baseURL);
  push(record.url);
  // microsoft-translator carries the translator endpoint; the other keyed types post to baseURL.
  push(record.endpoint);
  if (supportsServiceMode(provider)) {
    // The resolved options already fall back to the built-in host, so an unchanged default
    // compares equal and a rewritten api.endpoint does not.
    const api = translationApiOptions(provider);
    push(api.endpoint);
    // A region or folder selects the account inside that host, so the key does not carry over.
    push(api.region);
    push(api.folderId);
  }
  push(record.region);
  return endpoints;
}

/**
 * Compares only what identifies the receiving service: scheme, host, port and path. User info
 * carries basic-auth credentials, a query string or fragment does not address a different
 * service, and a trailing slash or host letter case is the same address, so none of them may
 * block a legitimate restore. A path is case-sensitive and is kept as written. Values that are
 * not URLs (a region or a folder id) compare as the bare scope they name.
 */
function normalizeEndpoint(value: string): string {
  const trimmed = value.trim();
  const address = trimmed.split("#")[0]?.split("?")[0] ?? trimmed;
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)/iu.exec(address)?.[1].toLowerCase() ?? "";
  const rest = scheme ? address.slice(scheme.length) : address;
  // User info is only valid in the authority, which ends at the first `/`. Reading an `@` from
  // the path instead would take the text after it as the host, so a path such as
  // `/proxy@original.example/v1` could be matched against the original host and reuse its key.
  const authorityEnd = rest.search(/[/?#]/u);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const path = authorityEnd === -1 ? "" : rest.slice(authorityEnd);
  const host = authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
  // A path is case-sensitive, so only the scheme and host are folded.
  return `${scheme}${host}${path}`.replace(/\/+$/u, "");
}

/** Whether the file keeps sending this provider's credential to the address stored here. */
function keepsCredentialEndpoint(incoming: ProviderConfig, stored: ProviderConfig): boolean {
  const next = credentialEndpoints(incoming);
  const previous = credentialEndpoints(stored);
  // A provider with no endpoint here (an unkeyed built-in) has nothing to compare, and the
  // caller only restores keys when the stored copy holds one.
  if (!previous.length) return true;
  if (!next.length) return true;
  return next.every((endpoint) => previous.includes(endpoint));
}

/**
 * Fills keys the incoming file left blank with the ones already stored here. A key that is
 * absent from the file is missing data, not a request to clear this browser's copy; without
 * this an export that strips keys would wipe them on import and the services would stop
 * working. Non-empty incoming keys always win, so editing a file still takes effect.
 *
 * The key is not restored when the file points the provider at another endpoint: a key-less
 * backup can come from another device, a shared configuration or a hand edit, and reusing the
 * stored key would send this browser's credential to the address the file names.
 */
export function mergeStoredKeys(
  incoming: ExtensionSettings,
  current: ExtensionSettings
): { settings: ExtensionSettings; restoredKeys: number; skippedKeys: number } {
  let restoredKeys = 0;
  let skippedKeys = 0;
  const providers = incoming.providers.map((provider) => {
    const existing = current.providers.find(
      (candidate) => candidate.id === provider.id && candidate.type === provider.type
    );
    if (!existing) return provider;
    if (!keepsCredentialEndpoint(provider, existing)) {
      // Report it only when a key was actually withheld, so an unchanged import stays quiet.
      if (providerHasStoredKey(existing)) skippedKeys += 1;
      return provider;
    }
    const merged = structuredClone(provider) as ProviderConfig;
    // Same union caveat as in withoutProviderKeys: index through the record view.
    const mergedRecord = merged as unknown as Record<string, unknown>;
    const existingRecord = existing as unknown as Record<string, unknown>;
    let changed = false;
    for (const field of PROVIDER_KEY_FIELDS) {
      const stored = existingRecord[field];
      if (mergedRecord[field] === "" && typeof stored === "string" && stored !== "") {
        mergedRecord[field] = stored;
        changed = true;
      }
    }
    if (supportsServiceMode(merged) && supportsServiceMode(existing)) {
      const api: TranslationApiOptions = { ...(merged.api ?? {}) };
      for (const field of SERVICE_KEY_FIELDS) {
        const stored = existing.api?.[field];
        if ((api[field] ?? "") === "" && typeof stored === "string" && stored !== "") {
          api[field] = stored;
          changed = true;
        }
      }
      if (Object.keys(api).length) merged.api = api;
    }
    // The custom carriers are blanked by the export, so restoring them here is what keeps a
    // same-device round trip working. Only a carrier that still equals this browser's own
    // stripped copy is restored: any other text means the file was edited and the file wins.
    if (merged.type === "http-template" && existing.type === "http-template") {
      const stripped = withoutProviderKeys(existing) as HttpTemplateConfig;
      if (!sameJson(merged.headers, existing.headers) && sameJson(merged.headers, stripped.headers)) {
        merged.headers = existing.headers;
        changed = true;
      }
      if (merged.bodyTemplate !== existing.bodyTemplate && merged.bodyTemplate === stripped.bodyTemplate) {
        merged.bodyTemplate = existing.bodyTemplate;
        changed = true;
      }
      if (merged.url !== existing.url && merged.url === stripped.url) {
        merged.url = existing.url;
        changed = true;
      }
    }
    if (supportsRequestTemplate(merged) && supportsRequestTemplate(existing)
      && merged.requestTemplate && existing.requestTemplate) {
      const stripped = withoutProviderKeys(existing);
      const strippedTemplate = supportsRequestTemplate(stripped) ? stripped.requestTemplate : undefined;
      if (strippedTemplate && merged.requestTemplate.headers !== existing.requestTemplate.headers
        && merged.requestTemplate.headers === strippedTemplate.headers) {
        merged.requestTemplate = { ...merged.requestTemplate, headers: existing.requestTemplate.headers };
        changed = true;
      }
      if (strippedTemplate && merged.requestTemplate.body !== existing.requestTemplate.body
        && merged.requestTemplate.body === strippedTemplate.body) {
        merged.requestTemplate = { ...merged.requestTemplate, body: existing.requestTemplate.body };
        changed = true;
      }
    }
    if (changed) restoredKeys += 1;
    return merged;
  });
  return { settings: { ...incoming, providers }, restoredKeys, skippedKeys };
}

/** Structural comparison for the free-form carriers, which are objects of strings. */
function sameJson(left: Record<string, string>, right: Record<string, string>): boolean {
  const names = Object.keys(left);
  if (names.length !== Object.keys(right).length) return false;
  return names.every((name) => left[name] === right[name]);
}

/** Whether the file actually carried any key, which decides how the import is reported. */
export function settingsBackupHasKeys(settings: ExtensionSettings): boolean {
  return settings.providers.some(providerHasStoredKey);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
