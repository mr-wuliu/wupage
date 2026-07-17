import type { RuntimeRequest, RuntimeResponse } from "../shared/types";

export function hasRuntimeContext(): boolean {
  return Boolean(chrome?.runtime?.id);
}

export function addRuntimeMessageListener(
  listener: (
    request: RuntimeRequest,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: RuntimeResponse) => void
  ) => void | boolean
): void {
  if (!hasRuntimeContext()) return;
  chrome.runtime.onMessage.addListener(listener);
}

export async function sendRuntimeRequest<T>(request: RuntimeRequest): Promise<T> {
  if (!hasRuntimeContext()) {
    throw new Error("Extension context invalidated. Refresh this page after reloading the extension.");
  }

  try {
    const response = (await chrome.runtime.sendMessage(request)) as RuntimeResponse | undefined;
    if (!response) throw new Error("No response from extension runtime.");
    if (!response.ok) throw new Error(response.error);
    return response.data as T;
  } catch (error) {
    if (!hasRuntimeContext() || isContextInvalidatedError(error)) {
      throw new Error("Extension context invalidated. Refresh this page after reloading the extension.");
    }
    throw error;
  }
}

function isContextInvalidatedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Extension context invalidated");
}
