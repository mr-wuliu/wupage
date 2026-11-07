import { t } from "./i18n";
import type { RuntimeRequest, RuntimeResponse } from "./types";
import { restoreRuntimeError } from "./errors";

export async function sendRuntimeMessage<T = unknown>(request: RuntimeRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as RuntimeResponse | undefined;
  if (!response) throw new Error("No response from extension runtime.");
  if (!response.ok) throw restoreRuntimeError(response);
  return response.data as T;
}

export async function sendTabMessage<T = unknown>(
  tabId: number,
  request: RuntimeRequest
): Promise<T> {
  let response: RuntimeResponse | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tabId, request, { frameId: 0 })) as RuntimeResponse | undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/receiving end does not exist|could not establish connection|message port closed|extension context invalidated/iu.test(message)) {
      throw new Error(t("noConnectionToThisPageYetIfYou"));
    }
    throw error;
  }
  if (!response) throw new Error(t("noConnectionToThisPageYetIfYou"));
  if (!response.ok) throw restoreRuntimeError(response);
  return response.data as T;
}
