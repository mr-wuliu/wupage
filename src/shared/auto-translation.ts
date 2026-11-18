import { t } from "./i18n";
import type { AutoTranslationSettings, AutoTranslationSite } from "./types";
import { randomId } from "./random-id";

export function hasSitePatternProtocol(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(value);
}

function sitePatternUrl(value: string): URL {
  return new URL(hasSitePatternProtocol(value) ? value : `https://${value}`);
}

export const AUTO_TRANSLATION_PRESETS = [
  { domain: "github.com", label: "GitHub" },
  { domain: "stackoverflow.com", label: "Stack Overflow" },
  { domain: "en.wikipedia.org", get label() { return t("englishWikipedia"); } },
  { domain: "reddit.com", label: "Reddit" },
  { domain: "medium.com", label: "Medium" },
  { domain: "news.ycombinator.com", label: "Hacker News" }
];

export function normalizeSitePattern(value: string): string {
  const input = value.trim();
  if (!input || input.length > 2048) throw new Error(t("enterAValidSiteDomainOrUrl"));
  const explicitProtocol = hasSitePatternProtocol(input);
  let parsed: URL;
  try { parsed = sitePatternUrl(input); }
  catch { throw new Error(t("enterAValidSiteDomainOrHttpHttps")); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(t("enterAnHttpHttpsDomainOrPathWithout"));
  }
  const wildcard = parsed.hostname.startsWith("*.");
  const hostname = (wildcard ? parsed.hostname.slice(2) : parsed.hostname).replace(/\.$/, "");
  const ip = /^(?:\d+\.){3}\d+$|^\[[a-f\d:]+\]$/i.test(hostname);
  if ((!ip && hostname.split(".").some(part => !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(part)))
    || !hostname || (wildcard && (ip || hostname === "localhost"))) {
    throw new Error(t("invalidDomainUseExampleComForASubdomain"));
  }
  const port = parsed.port || explicitPort(input);
  const host = `${wildcard ? "*." : ""}${hostname}${port ? `:${port}` : ""}`;
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\*+/g, "*");
  return `${explicitProtocol ? `${parsed.protocol}//` : ""}${host}${path}`;
}

export function matchesSitePattern(pattern: string, address: string): boolean {
  try {
    const normalized = normalizeSitePattern(pattern);
    const explicitProtocol = hasSitePatternProtocol(normalized);
    const rule = sitePatternUrl(normalized);
    const url = new URL(address);
    const port = explicitPort(normalized);
    if (!["http:", "https:"].includes(url.protocol) || (explicitProtocol && rule.protocol !== url.protocol)
      || (port && port !== (url.port || (url.protocol === "https:" ? "443" : "80")))
      || (explicitProtocol && !port && Boolean(url.port))) return false;
    const wildcard = rule.hostname.startsWith("*.");
    const host = wildcard ? rule.hostname.slice(2) : rule.hostname;
    const actual = url.hostname.replace(/\.$/, "");
    const exact = actual === host;
    const subdomain = !/^(?:\d+\.){3}\d+$|^\[/u.test(host) && actual.endsWith(`.${host}`);
    if (wildcard ? !subdomain : !exact && !subdomain) return false;
    if (rule.pathname === "/") return true;
    const parts = rule.pathname.split("*");
    if (parts.length === 1) return url.pathname === rule.pathname;
    if (!url.pathname.startsWith(parts[0])) return false;
    let cursor = parts[0].length;
    for (const part of parts.slice(1, -1)) {
      const index = url.pathname.indexOf(part, cursor);
      if (index < 0) return false;
      cursor = index + part.length;
    }
    const tail = parts[parts.length - 1];
    return url.pathname.endsWith(tail) && url.pathname.length - tail.length >= cursor;
  } catch { return false; }
}

function explicitPort(pattern: string): string {
  const authority = pattern.replace(/^https?:\/\//i, "").split("/")[0];
  const match = authority.match(/:(\d+)$/u);
  return match ? String(Number(match[1])) : "";
}

export function normalizeAutoTranslation(value: unknown): AutoTranslationSettings {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const presets = new Set(AUTO_TRANSLATION_PRESETS.map(site => site.domain));
  const removed = Array.isArray(input.removedPresetSites)
    ? [...new Set(input.removedPresetSites.filter((site): site is string => typeof site === "string" && presets.has(site)))] : [];
  const excluded = new Set<string>();
  if (Array.isArray(input.excludedSites)) for (const site of input.excludedSites) {
    if (typeof site !== "string") continue;
    try {
      const pattern = normalizeSitePattern(site);
      const url = sitePatternUrl(pattern);
      if (url.pathname === "/" && !url.hostname.startsWith("*.")) excluded.add(currentWebsitePattern(url.href)!);
    } catch { /* Ignore invalid imported exclusions. */ }
  }
  const patterns = new Set<string>();
  const ids = new Set<string>();
  const customSites: AutoTranslationSite[] = [];
  if (Array.isArray(input.customSites)) for (const entry of input.customSites) {
    if (!entry || typeof entry !== "object" || typeof entry.pattern !== "string") continue;
    try {
      const pattern = normalizeSitePattern(entry.pattern);
      if (patterns.has(pattern)) continue;
      let id = typeof entry.id === "string" && entry.id.trim() ? entry.id : `site-${customSites.length}`;
      while (ids.has(id)) id += "-1";
      ids.add(id); patterns.add(pattern);
      customSites.push({ id, pattern, enabled: entry.enabled !== false });
    } catch { /* Ignore invalid imported rules without discarding other settings. */ }
  }
  return {
    enabled: input.enabled === true,
    nonTargetLanguage: input.nonTargetLanguage === true,
    presetSites: Array.isArray(input.presetSites) ? [...new Set(input.presetSites.filter((site): site is string => typeof site === "string" && presets.has(site) && !removed.includes(site)))] : [],
    customSites,
    ...(removed.length ? { removedPresetSites: removed } : {}),
    ...(excluded.size ? { excludedSites: [...excluded] } : {})
  };
}

export function matchesAutoTranslationSite(settings: AutoTranslationSettings, address: string): boolean {
  return settings.enabled && !isAutoTranslationWebsiteExcluded(settings, address) && (settings.presetSites.some(pattern => matchesSitePattern(pattern, address))
    || settings.customSites.some(rule => rule.enabled && matchesSitePattern(rule.pattern, address)));
}

export function setAutoTranslationEnabled(value: unknown, enabled: boolean): AutoTranslationSettings {
  const settings = normalizeAutoTranslation(value);
  const unconfigured = !settings.presetSites.length && !settings.customSites.length && !settings.nonTargetLanguage && !settings.removedPresetSites?.length && !settings.excludedSites?.length;
  return { ...settings, enabled, nonTargetLanguage: settings.nonTargetLanguage || (enabled && unconfigured) };
}

export function currentWebsitePattern(address: string | undefined): string | undefined {
  try {
    const url = new URL(address ?? "");
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    return normalizeSitePattern(url.host);
  } catch { return undefined; }
}

function coversWebsite(pattern: string, address: string): boolean {
  const rule = sitePatternUrl(pattern);
  return ["/", "/*"].includes(rule.pathname) && matchesSitePattern(pattern, address);
}

export function isAutoTranslationWebsiteExcluded(value: unknown, address: string | undefined): boolean {
  const pattern = currentWebsitePattern(address);
  return Boolean(pattern && normalizeAutoTranslation(value).excludedSites?.includes(pattern));
}

export function hasAutoTranslationWebsite(value: unknown, address: string | undefined): boolean {
  if (!currentWebsitePattern(address)) return false;
  const settings = normalizeAutoTranslation(value);
  return settings.enabled && !isAutoTranslationWebsiteExcluded(settings, address) && (settings.presetSites.some(pattern => coversWebsite(pattern, address!))
    || settings.customSites.some(site => site.enabled && coversWebsite(site.pattern, address!)));
}

export function addAutoTranslationWebsite(value: unknown, address: string | undefined): AutoTranslationSettings {
  const pattern = currentWebsitePattern(address);
  if (!pattern) throw new Error(t("switchToARegularWebPageToAdd"));
  let settings = normalizeAutoTranslation(value);
  if (!settings.enabled) throw new Error(t("enableAutomaticTranslationFirst"));
  if (settings.excludedSites?.includes(pattern)) {
    const excluded = settings.excludedSites.filter(site => site !== pattern);
    const { excludedSites: _excluded, ...retained } = settings;
    settings = { ...retained, ...(excluded.length ? { excludedSites: excluded } : {}) };
  }
  if (hasAutoTranslationWebsite(settings, address)) return settings;
  const hostname = new URL(address!).hostname;
  const existing = settings.customSites.find(site => {
    const rule = sitePatternUrl(site.pattern);
    return rule.hostname === hostname && coversWebsite(site.pattern, address!);
  });
  if (existing) return { ...settings, customSites: settings.customSites.map(site => site === existing ? { ...site, enabled: true } : site) };
  if (AUTO_TRANSLATION_PRESETS.some(site => site.domain === pattern)) {
    const removed = settings.removedPresetSites?.filter(site => site !== pattern);
    const { removedPresetSites: _removed, ...retained } = settings;
    return { ...retained, presetSites: [...settings.presetSites, pattern], ...(removed?.length ? { removedPresetSites: removed } : {}) };
  }
  return { ...settings, customSites: [...settings.customSites, { id: `site-${randomId()}`, pattern, enabled: true }] };
}

export function excludeAutoTranslationWebsite(value: unknown, address: string | undefined): AutoTranslationSettings {
  const pattern = currentWebsitePattern(address);
  if (!pattern) throw new Error(t("switchToARegularWebPageToExclude"));
  const settings = normalizeAutoTranslation(value);
  if (!settings.enabled) throw new Error(t("enableAutomaticTranslationFirst"));
  return { ...settings, excludedSites: [...new Set([...(settings.excludedSites ?? []), pattern])] };
}

export function languageFamily(language: string): string {
  const [family, ...subtags] = language.trim().toLowerCase().replaceAll("_", "-").split("-");
  if (family !== "zh") return family;
  if (subtags.includes("hans")) return "zh-Hans";
  if (subtags.includes("hant") || subtags.some(tag => ["tw", "hk", "mo", "cht"].includes(tag))) return "zh-Hant";
  if (subtags.some(tag => ["cn", "sg", "my", "chs"].includes(tag))) return "zh-Hans";
  return "zh";
}

export function chineseScriptFromText(text: string): "zh-Hans" | "zh-Hant" | undefined {
  // Some detectors return only "zh". Use distinct common variant characters as
  // evidence, leaving shared characters and evenly mixed passages undecided.
  const simplified = new Set(text.match(/[这国学体语写读听视网电经实应机处书观东万连续记会设关点数识话来随选个无办为见离资讯导开区际还进产从两时当场长种众发对让请问将条声图现样节频页汉简译报维护给获过扩范务总优]/gu)).size;
  const traditional = new Set(text.match(/[這國學體語寫讀聽視網電經實應機處書觀東萬連續記會設關點數識話來隨選個無辦為見離資訊導開區際還進產從兩時當場長種眾發對讓請問將條聲圖現樣節頻頁漢簡譯報維護給獲過擴範務總優]/gu)).size;
  if (simplified >= 2 && simplified > traditional * 2) return "zh-Hans";
  if (traditional >= 2 && traditional > simplified * 2) return "zh-Hant";
}
