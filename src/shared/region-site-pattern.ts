import { RE2JS } from "re2js";
import { hasSitePatternProtocol, matchesSitePattern, normalizeSitePattern } from "./auto-translation";
import { t } from "./i18n";

interface CompiledPattern { pattern: string; matches: (url: URL) => boolean }
const compiled = new Map<string, CompiledPattern>();

/** Region rules additionally accept all sites, host/protocol globs and /regex/i. */
export function normalizeRegionSitePattern(value: string): string {
  return compile(value).pattern;
}

export function matchesRegionSitePattern(pattern: string, address: string): boolean {
  try {
    const url = new URL(address);
    return ["http:", "https:"].includes(url.protocol) && compile(pattern).matches(url);
  } catch { return false; }
}

function compile(value: string): CompiledPattern {
  const input = value.trim();
  if (input.length > 2048) throw new Error(t("enterAValidSiteDomainOrUrl"));
  const cached = compiled.get(input);
  if (cached) return cached;
  const rule = parse(input);
  // Bound retained programs when users edit or import many different rules.
  if (compiled.size >= 256) compiled.delete(compiled.keys().next().value!);
  compiled.set(input, rule);
  return rule;
}

function parse(input: string): CompiledPattern {
  if (!input || input === "*") return { pattern: "*", matches: () => true };
  if (input.startsWith("/")) {
    try {
      const end = input.lastIndexOf("/");
      if (end <= 1 || !["", "i"].includes(input.slice(end + 1))) throw new Error();
      const regex = RE2JS.compile(input.slice(1, end), input.endsWith("/i") ? RE2JS.CASE_INSENSITIVE : 0);
      if (regex.programSize() > 10000) throw new Error();
      return { pattern: input, matches: url => regex.test(url.href) };
    } catch { throw new Error(t("invalidRegionSiteRegex")); }
  }

  const anyProtocol = input.startsWith("*://");
  const address = anyProtocol ? input.slice(4) : input;
  const explicitProtocol = hasSitePatternProtocol(address);
  if (anyProtocol && explicitProtocol) throw new Error(t("invalidRegionSiteGlob"));
  const authorityStart = explicitProtocol ? address.indexOf("://") + 3 : 0;
  const end = address.slice(authorityStart).search(/[/?#]/u);
  const authority = address.slice(authorityStart, end < 0 ? undefined : authorityStart + end);
  // Chromium percent-encodes stars in URL hostnames. Mask only authority stars
  // before URL parsing; a marker absent from the input cannot alter real labels.
  let marker = "wupage-wildcard";
  let decodedAuthority = authority;
  try { decodedAuthority = decodeURIComponent(authority); } catch { /* URL validation reports invalid host escapes below. */ }
  while (`${input} ${decodedAuthority}`.toLowerCase().includes(marker)) marker += "x";
  const masked = address.slice(0, authorityStart) + authority.replaceAll("*", marker) + address.slice(authorityStart + authority.length);
  let url: URL;
  try { url = new URL(explicitProtocol ? masked : `https://${masked}`); }
  catch { throw new Error(t("enterAValidSiteDomainOrHttpHttps")); }
  const parsedHost = authority.includes("*") ? url.hostname.replaceAll(marker, "*") : url.hostname;
  if (!anyProtocol && !parsedHost.includes("*")) {
    const pattern = normalizeSitePattern(input);
    return { pattern, matches: target => matchesSitePattern(pattern, target.href) };
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(t("enterAnHttpHttpsDomainOrPathWithout"));
  }
  const hostname = parsedHost.replace(/\.$/u, "").replace(/\*+/gu, "*");
  // Validate the non-wildcard host with the existing domain/IPv6 checks.
  if (!hostname.includes("*")) normalizeSitePattern(hostname);
  else if (hostname.split(".").some(part => !/^[a-z\d*](?:[a-z\d*-]*[a-z\d*])?$/iu.test(part))) {
    throw new Error(t("invalidRegionSiteGlob"));
  }
  if (/^\*\.[^*]+$/u.test(hostname) && (/^\*\.(?:\d+\.){3}\d+$/u.test(hostname) || hostname === "*.localhost")) {
    throw new Error(t("invalidRegionSiteGlob"));
  }
  const port = url.port || (authority.match(/:(\d+)$/u)?.[1] ?? "").replace(/^0+(?=\d)/u, "");
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\*+/gu, "*");
  const prefix = anyProtocol ? "*://" : explicitProtocol ? `${url.protocol}//` : "";
  const pattern = `${prefix}${hostname}${port ? `:${port}` : ""}${path}`;
  const hostGlob = hostname.includes("*") ? glob(hostname) : undefined;
  const pathGlob = path ? glob(path) : undefined;
  return { pattern, matches: target => {
    if ((explicitProtocol && target.protocol !== url.protocol)
      || (port && port !== (target.port || (target.protocol === "https:" ? "443" : "80")))
      || (explicitProtocol && !port && target.port)) return false;
    const actual = target.hostname.replace(/\.$/u, "");
    const hostMatches = hostGlob ? hostGlob.test(actual) : actual === hostname
      || (!/^(?:\d+\.){3}\d+$|^\[/u.test(hostname) && actual.endsWith(`.${hostname}`));
    return hostMatches && (!pathGlob || pathGlob.test(target.pathname));
  } };
}

function glob(pattern: string): RE2JS {
  return RE2JS.compile(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`);
}
