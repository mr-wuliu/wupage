import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { translateWithSettings } from "../src/background/translation";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { applicableGlossary, createGlossaryMatcher, lookupGlossary, type GlossaryGroup } from "../src/shared/glossary";
import { createSettingsBackup, parseSettingsBackup, serializeSettingsBackup } from "../src/shared/settings-backup";

const site = "https://api.example.com/docs/start";
const groups: GlossaryGroup[] = [
  { id: "general", name: "常用", enabled: true, entries: [
    { id: "server", site: "*", source: "server", target: "服务端" },
    { id: "private", site: "*", source: "private server", target: "私人服务器" }
  ] },
  { id: "product", name: "产品文档", enabled: true, entries: [
    { id: "server", site: "*://*.example.com/docs/*", source: "server", target: "服务器" },
    { id: "client", site: "example.com", source: "client", target: "客户端" }
  ] },
  { id: "game", name: "游戏", enabled: false, entries: [
    { id: "server", site: "example.com", source: "server", target: "区服" }
  ] }
];

const settings = {
  ...DEFAULT_SETTINGS,
  glossaryGroups: groups,
  activeProviderId: "test-http",
  providers: [{ type: "http-template" as const, id: "test-http", label: "Test", url: "https://example.invalid/translate",
    method: "POST" as const, headers: {}, bodyTemplate: '{"texts":{{json texts}}}', responsePath: "translations" }]
};

beforeEach(() => {
  const cache: Record<string, unknown> = {};
  vi.stubGlobal("chrome", { storage: { local: {
    get: async (keys: string | string[]) => Object.fromEntries([keys].flat().map(key => [key, cache[key]])),
    set: async (values: Record<string, unknown>) => { Object.assign(cache, values); }
  } } });
});
afterEach(() => vi.unstubAllGlobals());

it("combines enabled groups, respects site and path bounds and matches longest terms at each position", () => {
  const terms = applicableGlossary(groups, site);
  const text = "private  SERVER, Client, SERVER，给server组件，observer serverless";
  expect(createGlossaryMatcher(terms)(text).map(match => [text.slice(match.start, match.end), match.target]))
    .toEqual([["private  SERVER", "私人服务器"], ["Client", "客户端"], ["SERVER", "服务器"], ["server", "服务器"]]);
  expect(lookupGlossary(applicableGlossary(groups, "https://api.example.com/blog"), "SERVER")).toBe("服务端");
  expect(lookupGlossary(applicableGlossary(groups, "https://example.com.evil.invalid/docs/"), "client")).toBeUndefined();
  expect(lookupGlossary(applicableGlossary(groups), "  private server  ")).toBe("私人服务器");
});

it("uses local exact results and isolates cache entries by website and glossary edits", async () => {
  const fetch = vi.fn(async () => Response.json({ translations: ["unexpected"] }));
  vi.stubGlobal("fetch", fetch);
  const request = { texts: ["Server"], targetLang: "zh-CN" };
  expect(await translateWithSettings(settings, request, { websiteUrl: site })).toEqual({ translations: ["服务器"], cached: 0 });
  expect(await translateWithSettings(settings, request, { websiteUrl: site })).toEqual({ translations: ["服务器"], cached: 1 });
  expect(await translateWithSettings(settings, request, { websiteUrl: "https://api.example.com/blog" }))
    .toEqual({ translations: ["服务端"], cached: 0 });
  const edited = structuredClone(settings);
  edited.glossaryGroups[1].entries[0].target = "伺服器";
  expect(await translateWithSettings(edited, request, { websiteUrl: site })).toEqual({ translations: ["伺服器"], cached: 0 });
  expect(fetch).not.toHaveBeenCalled();
});

it("recovers terms and keeps existing formula, format and line-break tokens when a provider strips the markers", async () => {
  const calls: string[][] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { texts } = JSON.parse(String(init.body)) as { texts: string[] };
    calls.push(texts);
    return Response.json({ translations: texts.map(text => text.replace(/⟪[^⟫]*⟫/gu, "").replace("Open", "打开").replace("formula", "公式")) });
  }));
  const source = "Open ⟪WUPAGEOPEN0⟫server⟪WUPAGECLOSE0⟫ ⟪WUPAGEBREAK0⟫formula ⟪WUPAGE0⟫";
  const result = await translateWithSettings(settings, { texts: [source], targetLang: "zh-CN", preservePlaceholders: true },
    { websiteUrl: site, persistentCache: false });
  expect(calls.slice(0, 2)).toEqual([
    [source.replace("server", "⟪WUPAGE1⟫")],
    [source.replace("server", "⟪WUPAGE1⟫")]
  ]);
  expect(calls.at(-1)).toEqual(["Open", "formula"]);
  expect(calls.slice(2).flat().join("")).not.toMatch(/⟪WUPAGE(?:OPEN|CLOSE|BREAK)?\d+⟫/u);
  expect(result.translations).toEqual(["打开 ⟪WUPAGEOPEN0⟫服务器⟪WUPAGECLOSE0⟫ ⟪WUPAGEBREAK0⟫公式 ⟪WUPAGE0⟫"]);
});

it("round-trips the configured groups through a settings backup", () => {
  const configured = { ...DEFAULT_SETTINGS, glossaryGroups: groups };
  const imported = parseSettingsBackup(serializeSettingsBackup(createSettingsBackup(configured, "1.24.1")));
  expect(imported.settings.glossaryGroups).toEqual(groups);
});
