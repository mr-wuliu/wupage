import type { RuntimeRequest, RuntimeResponse } from "./types";

export async function sendRuntimeMessage<T = unknown>(request: RuntimeRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as RuntimeResponse | undefined;
  if (!response) throw new Error("No response from extension runtime.");
  if (!response.ok) throw new Error(response.error);
  return response.data as T;
}

export async function sendTabMessage<T = unknown>(
  tabId: number,
  request: RuntimeRequest
): Promise<T> {
  const response = (await chrome.tabs.sendMessage(tabId, request)) as RuntimeResponse | undefined;
  if (!response) throw new Error("No response from page content script.");
  if (!response.ok) throw new Error(response.error);
  return response.data as T;
}
