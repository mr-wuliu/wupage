import { t } from "../shared/i18n";
import { ProviderError } from "../shared/errors";

export const DOUBAO_LAUNCH_ENDPOINT = "https://www.doubao.com/alice/user/launch";
export const DOUBAO_TRANSLATE_ENDPOINT = "https://www.doubao.com/samantha/plugin/stream_article_translate";
const COMPATIBILITY_ORIGIN = "chrome-extension://dbjibobgilijgolhjdcbdebjhejelffo";
const FIRST_RULE_ID = 110_000;
const LAST_RULE_ID = 110_015;
const ENDPOINT_IDS = new Map([[DOUBAO_LAUNCH_ENDPOINT, FIRST_RULE_ID], [DOUBAO_TRANSLATE_ENDPOINT, FIRST_RULE_ID + 1]]);
const references = new Map<string, number>();
let initialized = false;
let mutations: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutations.then(operation);
  mutations = result.then(() => undefined, () => undefined);
  return result;
}

function permissionError(): ProviderError {
  return new ProviderError(t("couldNotPrepareTheDoubaoRequestCheckSite"), "permission-required");
}

function doubaoEndpoint(url: string): string {
  const parsed = new URL(url);
  const endpoint = parsed.origin + parsed.pathname;
  if (!ENDPOINT_IDS.has(endpoint) || parsed.username || parsed.password || parsed.hash) {
    throw new ProviderError(t("unsupportedDoubaoRequestAddress"), "protocol-changed");
  }
  return endpoint;
}

export async function initializeDoubaoCompatibility(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.declarativeNetRequest) return;
  await serialize(async () => {
    if (initialized) return;
    try {
      const api = chrome.declarativeNetRequest;
      const stale = (await api.getSessionRules()).filter((rule) => rule.id >= FIRST_RULE_ID && rule.id <= LAST_RULE_ID);
      if (stale.length) await api.updateSessionRules({ removeRuleIds: stale.map((rule) => rule.id) });
      initialized = true;
    } catch {
      throw permissionError();
    }
  });
}

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function acquire(endpoint: string, signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  if (typeof chrome === "undefined" || !chrome.runtime?.getURL || !chrome.declarativeNetRequest) {
    throw permissionError();
  }
  await initializeDoubaoCompatibility();
  await serialize(async () => {
    checkSignal(signal);
    const current = references.get(endpoint) ?? 0;
    if (current > 0) {
      references.set(endpoint, current + 1);
      return;
    }
    const id = ENDPOINT_IDS.get(endpoint)!;
    const rule: chrome.declarativeNetRequest.Rule = {
      id,
      priority: 1,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [{
          header: "origin",
          operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
          value: COMPATIBILITY_ORIGIN
        }]
      },
      condition: {
        regexFilter: `^${endpoint.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&")}(\\?[^#]*)?$`,
        isUrlFilterCaseSensitive: true,
        initiatorDomains: [new URL(chrome.runtime.getURL("/")).hostname],
        requestMethods: ["post" as chrome.declarativeNetRequest.RequestMethod],
        resourceTypes: ["xmlhttprequest" as chrome.declarativeNetRequest.ResourceType]
      }
    };
    try {
      // Replace our own ID atomically if a previous cleanup was interrupted.
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id], addRules: [rule] });
      references.set(endpoint, 1);
    } catch {
      throw permissionError();
    }
  });
}

async function release(endpoint: string): Promise<void> {
  await serialize(async () => {
    const current = references.get(endpoint);
    if (current === undefined) return;
    if (current > 1) {
      references.set(endpoint, current - 1);
      return;
    }
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ENDPOINT_IDS.get(endpoint)!] });
    } catch {
      throw permissionError();
    } finally {
      references.delete(endpoint);
    }
  });
}

export async function withDoubaoCompatibility<T>(
  url: string,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const endpoint = doubaoEndpoint(url);
  await acquire(endpoint, signal);
  let failed = false;
  try {
    checkSignal(signal);
    return await operation();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await release(endpoint);
    } catch (error) {
      if (!failed) throw error;
      // Never log the URL, body, or browser credentials.
      console.warn("WuPage: 豆包临时请求规则清理失败，下次请求会重新检查。");
    }
  }
}
