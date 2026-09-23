import { getSettings, saveSettings } from "../shared/settings";
import type { RuntimeRequest, RuntimeResponse } from "../shared/types";
import { createProvider } from "./providers";
import { loadImageData, translateImageWithSettings } from "./image-translation";
import { clearTranslationCache, getTranslationDebugSnapshot, translateWithSettings } from "./translation";
import { requestOcr } from "./ocr";
import { installedRevision } from "../ocr/model-store";
import { initImageContextMenu } from "./image-context-menu";

initImageContextMenu();

chrome.runtime.onMessage.addListener((request: RuntimeRequest, _sender, sendResponse) => {
  if ("target" in request) return;
  handleMessage(request)
    .then((data): RuntimeResponse => ({ ok: true, data }))
    .catch((error: unknown): RuntimeResponse => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    .then(sendResponse);

  return true;
});

async function handleMessage(request: RuntimeRequest): Promise<unknown> {
  switch (request.type) {
    case "GET_SETTINGS": {
      const settings = await getSettings();
      if (settings.imageTranslationEnabled && !await installedRevision()) {
        settings.imageTranslationEnabled = false;
        await saveSettings(settings);
      }
      return settings;
    }
    case "SAVE_SETTINGS":
      if (request.settings.imageTranslationEnabled && !await installedRevision()) throw new Error("请先点击图片翻译旁的扳手安装 OCR 模型。");
      await saveSettings(request.settings);
      return null;
    case "GET_OCR_STATUS":
      return requestOcr("status");
    case "INSTALL_OCR":
      return requestOcr("install");
    case "REMOVE_OCR": {
      const result = await requestOcr("remove");
      const settings = await getSettings();
      await saveSettings({ ...settings, imageTranslationEnabled: false });
      return result;
    }
    case "TRANSLATE_BATCH": {
      const settings = await getSettings();
      return translateWithSettings(settings, request);
    }
    case "LOAD_IMAGE": {
      const settings = await getSettings();
      if (!settings.imageTranslationEnabled) throw new Error("请先开启图片翻译。");
      return loadImageData(request.url);
    }
    case "TRANSLATE_IMAGE":
      return translateImageWithSettings(await getSettings(), request);
    case "GET_TRANSLATION_DEBUG":
      return getTranslationDebugSnapshot();
    case "CLEAR_CACHE":
      return clearTranslationCache();
    case "TEST_PROVIDER": {
      const settings = await getSettings();
      const providerConfig = settings.providers.find(
        (provider) => provider.id === (request.providerId ?? settings.activeProviderId)
      );
      if (!providerConfig) throw new Error("Provider not found.");
      if (providerConfig.enabled === false) throw new Error("Provider is disabled.");
      const provider = createProvider(providerConfig);
      const validation = provider.validateConfig();
      if (!validation.ok) throw new Error(validation.message);
      const [translation] = await provider.translateBatch({
        texts: ["Hello world"],
        sourceLang: "en",
        targetLang: settings.targetLang
      });
      return { translation };
    }
    case "TRANSLATE_PAGE":
    case "TRANSLATE_CONTEXT_IMAGE":
    case "CLEAR_TRANSLATION":
    case "GET_TRANSLATION_STATE":
    case "GET_PARAGRAPH_MODE":
    case "SET_PARAGRAPH_MODE":
    case "GET_FLOATING_BALL":
    case "SET_FLOATING_BALL":
    case "OPEN_TRANSLATION_DEBUG":
      throw new Error(`${request.type} must be sent to the active tab.`);
    default:
      return assertNever(request);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
