// Mozilla's model CDN returns HTTP 406 for Chromium User-Agent strings.
// Identify this client honestly, only for downloads initiated by WuPage.
const RULE_ID = 120_000;
let prepared: Promise<void> | undefined;

export async function ensureLocalModelDownloadCompatibility(): Promise<void> {
  if (import.meta.env.MODE === "firefox" || typeof chrome.declarativeNetRequest?.updateSessionRules !== "function") return;
  prepared ??= chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [{
      id: RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [{
          header: "user-agent",
          operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
          value: `WuPage/${chrome.runtime.getManifest().version} (Bergamot model download)`
        }]
      },
      condition: {
        regexFilter: "^https://firefox-settings-attachments\\.cdn\\.mozilla\\.net/main-workspace/translations-models/[a-f0-9-]+\\.(bin|spm)$",
        isUrlFilterCaseSensitive: true,
        initiatorDomains: [new URL(chrome.runtime.getURL("/")).hostname],
        requestMethods: ["get" as chrome.declarativeNetRequest.RequestMethod],
        // Navigation/other covers the manual file links in the model controls.
        resourceTypes: ["xmlhttprequest", "main_frame", "other"] as chrome.declarativeNetRequest.ResourceType[]
      }
    }]
  }).catch(error => { prepared = undefined; throw error; });
  await prepared;
}
