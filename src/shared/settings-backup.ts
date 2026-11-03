import { normalizeSettings } from "./settings";
import { BUILT_IN_PROVIDER_IDS, DEFAULT_SETTINGS } from "./defaults";
import { COLOR_FIELDS } from "./appearance";
import { LOCAL_BINDINGS } from "./local-shortcuts";
import { LOCAL_SHORTCUTS, TRANSLATION_SHORTCUTS } from "./shortcuts";
import type { ExtensionSettings, ProviderConfig } from "./types";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";
import { withoutSettingsKeys } from "./settings-backup-credentials";

export const SETTINGS_BACKUP_MAX_BYTES = 5 * 1024 * 1024;
export const SETTINGS_BACKUP_KIND = "wupage-settings-backup";
export const SETTINGS_BACKUP_MIME = "application/toml";
export interface SettingsBackup {
  kind: typeof SETTINGS_BACKUP_KIND;
  version: 1;
  includesKeys: boolean;
  extensionVersion: string;
  createdAt: string;
  settings: ExtensionSettings;
}
export interface SettingsImportResult {
  settings: ExtensionSettings;
  imageTranslationDisabled: boolean;
}

export function createSettingsBackup(settings: ExtensionSettings, extensionVersion: string, now = new Date(),
  options: { includeKeys?: boolean } = {}): SettingsBackup {
  const includesKeys = options.includeKeys === true;
  const saved = readSettings(normalizeSettings(settings), false);
  const backup: SettingsBackup = {
    kind: SETTINGS_BACKUP_KIND, version: 1, includesKeys, extensionVersion, createdAt: now.toISOString(),
    settings: includesKeys ? saved : withoutSettingsKeys(saved)
  };
  checkTree(backup);
  serializeSettingsBackup(backup);
  return backup;
}

export function serializeSettingsBackup(backup: SettingsBackup): string {
  // TOML has no null. Keep the internal null meaning explicit on disk.
  const document = { ...backup, settings: { ...backup.settings,
    pdfTranslationPageRadius: backup.settings.pdfTranslationPageRadius ?? "all" } };
  const text = "# WuPage 设置备份\n"
    + (backup.includesKeys ? "# 包含密钥，文件未加密，请妥善保管。\n" : "# 已清空密钥及可识别的认证值，其余配置保留。分享前请检查自定义内容。\n")
    + '# settings.pdfTranslationPageRadius = "all" 表示整份 PDF。\n\n'
    + formatMultilineStrings(stringifyToml(document));
  checkSize(text);
  return text;
}

export function parseSettingsBackup(text: string): SettingsBackup {
  checkSize(text);
  let value: unknown;
  try { value = parseToml(text.replace(/^\uFEFF/u, ""), { unsafeKeyBehaviour: "throw", maxDepth: 24 }); }
  catch (error) {
    const position = error instanceof TomlError ? `（第 ${error.line} 行，第 ${error.column} 列）` : "";
    // Parser messages contain source excerpts, which may contain credentials.
    throw new Error(`无法读取备份，请选择有效的 TOML 文件${position}。`);
  }
  checkTree(value);
  if (!isRecord(value) || value.kind !== SETTINGS_BACKUP_KIND) throw new Error("这不是 WuPage 设置备份文件。");
  if (value.version !== 1) throw new Error("不支持此备份格式版本，请使用支持该格式的 WuPage。");
  if (typeof value.includesKeys !== "boolean") invalid("includesKeys");
  if (typeof value.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value.createdAt)
    || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.extensionVersion !== "string"
    || !/^\d+\.\d+\.\d+(?:[.\-+][\w.\-]+)?$/u.test(value.extensionVersion)) invalid("备份信息");
  if (!isRecord(value.settings)) invalid("settings");
  const settings = readSettings({ ...value.settings,
    pdfTranslationPageRadius: value.settings.pdfTranslationPageRadius === "all" ? null : value.settings.pdfTranslationPageRadius }, true);
  const includesKeys = value.includesKeys;
  if (!includesKeys && !sameValue(settings, withoutSettingsKeys(settings))) invalid("settings.credentials");
  return { kind: SETTINGS_BACKUP_KIND, version: value.version, includesKeys, extensionVersion: value.extensionVersion,
    createdAt: value.createdAt, settings };
}

/** Keep the library's escaping, expanding only escaped newlines into TOML
 * multiline basic strings. Escaped backslashes and quote delimiters stay safe. */
function formatMultilineStrings(text: string): string {
  return text.split("\n").map(line => {
    const match = /^(systemPrompt|bodyTemplate|headers|body) = (".*")$/u.exec(line);
    if (!match || !(parseToml(line)[match[1]] as string).includes("\n")) return line;
    const escaped = match[2].slice(1, -1);
    let body = "";
    for (let i = 0; i < escaped.length; i++) {
      if (escaped[i] !== "\\") body += escaped[i];
      else { const next = escaped[++i]; body += next === "n" ? "\n" : `\\${next}`; }
    }
    return `${match[1]} = """\n${body}"""`;
  }).join("\n");
}

export function settingsBackupFilename(backup: SettingsBackup): string {
  return `wupage-settings-${backup.createdAt.replace(/[:.]/gu, "-")}.toml`;
}

function checkSize(text: string): void {
  if (typeof text !== "string" || text.length > SETTINGS_BACKUP_MAX_BYTES
    || new TextEncoder().encode(text).byteLength > SETTINGS_BACKUP_MAX_BYTES) {
    throw new Error("设置备份不能超过 5 MiB。");
  }
}

function checkTree(value: unknown, depth = 0): void {
  if (depth > 24) throw new Error("备份结构过于复杂。");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("备份包含不安全的属性。");
    checkTree(child, depth + 1);
  }
}

type Rule = (value: unknown, path: string, strict: boolean) => unknown;
const string: Rule = (v, p) => typeof v === "string" ? v : invalid(p);
const boolean: Rule = (v, p) => typeof v === "boolean" ? v : invalid(p);
const optional = (rule: Rule): Rule => (v, p, s) => v === undefined ? undefined : rule(v, p, s);
const oneOf = (...values: unknown[]): Rule => (v, p) => values.includes(v) ? v : invalid(p);
const number = (min: number, max: number): Rule => (v, p) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : invalid(p);
const array = (rule: Rule, max = 10000): Rule => (v, p, s) =>
  Array.isArray(v) && v.length <= max ? v.map(entry => rule(entry, `${p}[]`, s)) : invalid(p);
const strings = array(string);
const object = (shape: Record<string, Rule>): Rule => (v, p, s) => {
  if (!isRecord(v) || s && Object.keys(v).some(key => !Object.hasOwn(shape, key))) invalid(p);
  const result: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(shape)) {
    const parsed = rule(v[key], `${p}.${key}`, s);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
};
const stringMap: Rule = (v, p, s) => {
  if (!isRecord(v)) invalid(p);
  return Object.fromEntries(Object.entries(v).map(([key, value]) => [key, string(value, `${p}.*`, s)]));
};
const fields = (keys: readonly string[], rule: Rule): Record<string, Rule> => Object.fromEntries(keys.map(key => [key, rule]));

const providerBase = {
  id: string, label: string, enabled: optional(boolean), performanceMode: optional(oneOf("inherit", "custom")),
  chunkSize: optional(number(200, 4000)), concurrency: optional(number(1, 8)), customModels: optional(strings)
};
const service = {
  ...providerBase, serviceMode: optional(oneOf("free", "api")),
  api: optional(object(fields(["apiKey", "endpoint", "region", "folderId", "accessKeyId", "secretAccessKey", "model"], optional(string))))
};
const llm = {
  ...providerBase, baseURL: string, apiKey: string, model: string, systemPrompt: string,
  requestTemplate: optional(object({ enabled: boolean, headers: string, body: string }))
};
// Mapped keys make adding a provider or a settings field a compile-time reminder
// to update the backup format as well. Only declared configuration is exported.
const providerShapes = {
  "google-web-translate": service, "microsoft-web-translate": service,
  "tencent-transmart": service, "yandex-web-translate": service, "volcengine-web-translate": service, mymemory: service,
  "doubao-web": providerBase, "firefox-local": providerBase,
  "microsoft-translator": { ...providerBase, endpoint: string, apiKey: string, region: string },
  "google-cloud-translation": { ...providerBase, apiKey: string },
  "openai-compatible": { ...llm, ollamaCompatibility: optional(boolean) },
  "anthropic-compatible": llm, deepseek: llm, "zhipu-glm": llm,
  "http-template": { ...providerBase, method: oneOf("GET", "POST"), url: string, headers: stringMap, bodyTemplate: string, responsePath: string }
} satisfies { [K in ProviderConfig["type"]]: Record<Exclude<keyof Extract<ProviderConfig, { type: K }>, "type">, Rule> };
const provider: Rule = (v, p, s) => {
  if (!isRecord(v) || typeof v.type !== "string" || !Object.hasOwn(providerShapes, v.type)) invalid(p);
  const type = v.type as ProviderConfig["type"];
  return object({ type: oneOf(type), ...providerShapes[type] })(v, p, s);
};

const settingsShape = {
  targetLang: string, sourceLang: string, activeProviderId: string, chunkSize: number(200, 4000), concurrency: number(1, 8),
  pdfTranslationPageRadius: (v, p, s) => v === null ? null : number(0, 1000)(v, p, s),
  cacheEnabled: boolean, floatingBallEnabled: boolean, translateCodeComments: boolean,
  statisticsEnabled: optional(boolean), contextMenuTranslationEnabled: optional(boolean), imageTranslationEnabled: optional(boolean),
  translationDisplayMode: oneOf("replace", "bilingual", "bilingual-accent"), providers: array(provider, 1000),
  shortcuts: optional(object(fields(TRANSLATION_SHORTCUTS.map(entry => entry.name), string))),
  localShortcuts: optional(object(fields(LOCAL_BINDINGS.map(entry => entry.name), string))),
  shortcutEnabled: optional(object(fields([...TRANSLATION_SHORTCUTS, ...LOCAL_SHORTCUTS].map(entry => entry.name), boolean))),
  selectionTranslation: optional(object({ enabled: boolean, provider: oneOf("youdao", "bing"), style: oneOf("dot", "underline") })),
  frameTranslation: optional(object({ enabled: boolean, excludeMatches: strings })),
  autoTranslation: optional(object({ enabled: boolean, nonTargetLanguage: boolean, presetSites: strings,
    customSites: array(object({ id: string, pattern: string, enabled: boolean })),
    removedPresetSites: optional(strings), excludedSites: optional(strings) })),
  elementExclusions: optional(array(object({ id: string, name: string, pattern: string, enabled: boolean, selectors: strings }), 100)),
  videoTranslation: optional(object({ enabled: boolean, showOriginal: boolean, fontSize: oneOf(18, 22, 26),
    background: oneOf("soft", "none"), preferredSource: string, enabledSites: strings,
    siteLayouts: optional(array(object({ id: string, x: number(2, 98), bottom: number(2, 98), width: number(20, 96), fontSize: number(14, 48) }), 100)) })),
  appearance: optional(object({ mode: oneOf("system", "light", "dark"), floatingOpacity: number(0, 100),
    lightSchemeId: string, darkSchemeId: string,
    popupMenu: object({ order: strings, hidden: strings, rows: array(strings) }),
    customSchemes: array(object({ id: string, name: string, tone: oneOf("light", "dark"),
      colors: object(fields(COLOR_FIELDS.map(field => field.key), (v, p) =>
        typeof v === "string" && /^#[a-f\d]{6}$/iu.test(v) ? v : invalid(p))) }), 32) }))
} satisfies Record<keyof Required<ExtensionSettings>, Rule>;

function readSettings(value: unknown, strict: boolean): ExtensionSettings {
  const parsed = object(settingsShape)(value, "settings", strict) as ExtensionSettings;
  const ids = new Set<string>();
  for (const entry of parsed.providers) {
    if (!entry.id.trim() || ids.has(entry.id)) throw new Error("备份中的翻译服务 ID 为空或重复。");
    if (BUILT_IN_PROVIDER_IDS.has(entry.id)
      && DEFAULT_SETTINGS.providers.find(p => p.id === entry.id)?.type !== entry.type) invalid("settings.providers.type");
    ids.add(entry.id);
  }
  if (!parsed.providers.some(p => p.id === parsed.activeProviderId && p.enabled !== false)) {
    throw new Error("备份中的当前翻译服务不存在或已停用。");
  }
  const normalized = normalizeSettings(parsed);
  // Reject malformed rules and shortcuts rather than silently replacing them
  // with defaults. New built-in providers may still be added by normalization.
  for (const key of ["autoTranslation", "elementExclusions", "shortcuts", "localShortcuts", "appearance", "frameTranslation", "videoTranslation"] as const) {
    if (parsed[key] !== undefined && !sameValue(parsed[key], normalized[key])) invalid(`settings.${key}`);
  }
  return normalized;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((entry, i) => sameValue(entry, b[i]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length
    && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(path: string): never { throw new Error(`备份字段无效或不受支持：${path}。`); }
