import { t } from "../shared/i18n";
import type { OpenAICompatibleConfig } from "../shared/types";

// Reserve a session-rule range for requests currently owned by this module.
const FIRST_RULE_ID = 100_000;
const LAST_RULE_ID = 104_999;
const activeRules = new Map<string, { id: number; users: number }>();
let initialized = false;
let mutations: Promise<void> = Promise.resolve();

export function chatCompletionsEndpoint(baseURL: string, ollama = false): string {
  const url = new URL(baseURL.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(t("baseUrlMustUseHttpOrHttps"));
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/chat/completions")) {
    url.pathname = `${path || (ollama || url.port === "11434" ? "/v1" : "")}/chat/completions`;
  } else {
    url.pathname = path;
  }
  url.hash = "";
  return url.toString();
}

export function usesOllamaCompatibility(config: OpenAICompatibleConfig): boolean {
  return config.ollamaCompatibility !== false;
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutations.then(operation);
  mutations = result.then(() => undefined, () => undefined);
  return result;
}

export async function initializeOllamaCompatibility(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.declarativeNetRequest) return;
  await serialize(async () => {
    const api = chrome.declarativeNetRequest;
    if (!initialized) {
      // A service worker may have been terminated before its request finished.
      // Remove only our abandoned rules, keeping other features' rules intact.
      const stale = (await api.getSessionRules()).filter((rule) => rule.id >= FIRST_RULE_ID && rule.id <= LAST_RULE_ID);
      if (stale.length) await api.updateSessionRules({ removeRuleIds: stale.map((rule) => rule.id) });
      initialized = true;
    }
  });
}

async function acquireRule(endpoint: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.id || !chrome.declarativeNetRequest) {
    throw new Error(t("reloadTheUpdatedExtensionForOllamaCompatibilityOr"));
  }
  await initializeOllamaCompatibility();
  await serialize(async () => {
    const api = chrome.declarativeNetRequest;
    const current = activeRules.get(endpoint);
    if (current) {
      current.users++;
      return;
    }
    const used = new Set([...activeRules.values()].map((rule) => rule.id));
    let id = FIRST_RULE_ID;
    while (used.has(id)) id++;
    if (id > LAST_RULE_ID) throw new Error(t("tooManyConcurrentOllamaConnectionsTryAgainLater"));
    const rule: chrome.declarativeNetRequest.Rule = {
      id,
      priority: 1,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [{ header: "origin", operation: "remove" as chrome.declarativeNetRequest.HeaderOperation }]
      },
      condition: {
        regexFilter: `^${endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        isUrlFilterCaseSensitive: true,
        // Firefox's manifest ID differs from its moz-extension UUID hostname.
        initiatorDomains: [new URL(chrome.runtime.getURL("/")).hostname],
        requestMethods: ["post" as chrome.declarativeNetRequest.RequestMethod],
        resourceTypes: ["xmlhttprequest" as chrome.declarativeNetRequest.ResourceType]
      }
    };
    await api.updateSessionRules({ addRules: [rule] });
    activeRules.set(endpoint, { id, users: 1 });
  });
}

async function releaseRule(endpoint: string): Promise<void> {
  await serialize(async () => {
    const current = activeRules.get(endpoint);
    if (!current || --current.users > 0) return;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [current.id] });
    activeRules.delete(endpoint);
  });
}

export async function withOllamaCompatibility<T>(endpoint: string, request: () => Promise<T>): Promise<T> {
  // Ollama accepts requests without Origin. Do this only for WuPage's own POST
  // to the configured endpoint, and only while that request is in flight.
  await acquireRule(endpoint);
  try {
    return await request();
  } finally {
    await releaseRule(endpoint);
  }
}
