import { getSettings, saveSettings } from "../shared/settings";
import { mergeSettingsChanges } from "../shared/settings-changes";
import { clearStatistics, getStatistics, initStatistics, statisticsPageKey } from "./statistics";
import type { RuntimeRequest, RuntimeResponse } from "../shared/types";
import { createProvider } from "./providers";
import { loadImageData, translateImageWithSettings } from "./image-translation";
import { clearTranslationCache, getTranslationDebugSnapshot, translateWithSettings } from "./translation";
import { requestOcr } from "./ocr";
import { installedRevision } from "../ocr/model-store";
import { initImageContextMenu } from "./image-context-menu";
import { initPageContextMenu, refreshPageContextMenu } from "./page-context-menu";
import { initializeOllamaCompatibility } from "./ollama-compatibility";
import { requestLocal } from "./local";
import { lookupDictionary, playDictionaryAudio, stopDictionaryAudio } from "./dictionary";
import { normalizeSelectionTranslation } from "../shared/dictionary";
import { cancelVideo, clearVideoTab, initVideoSettings, openVideoInTab, registerVideoFrame, translateVideo } from "./video";
import { checkDoubao, getDoubaoStatus } from "./doubao";
import { initializeDoubaoCompatibility } from "./doubao-compatibility";
import { runtimeErrorResponse } from "../shared/errors";
import { frameSessions } from "./frame-sessions";
import type { FrameSessionRequest } from "../shared/frame-session";
import { readParagraphMode } from "../shared/paragraph-mode";
import { saveParagraphMode } from "./paragraph-mode";
import { captureVideoFrame } from "./video-frame";

chrome.runtime.onMessage.addListener((request: RuntimeRequest, sender, sendResponse) => {
  if ("target" in request) return;
  handleMessage(request, sender)
    .then((data): RuntimeResponse => ({ ok: true, data }))
    .catch(runtimeErrorResponse)
    .then(sendResponse);

  return true;
});

try { frameSessions.install(); }
catch (error) { console.warn("WuPage frame integration:", error); }
initStatistics();
try { initVideoSettings(); chrome.tabs?.onRemoved?.addListener(clearVideoTab); }
catch (error) { console.warn("WuPage video integration:", error); }

// Auxiliary browser integrations must not prevent settings and translation
// messages from being handled when a Chromium fork lacks one of these APIs.
try {
  initImageContextMenu();
} catch (error: unknown) {
  console.warn("WuPage image menu:", error);
}
void initializeOllamaCompatibility().catch((error: unknown) => console.warn("WuPage Ollama compatibility:", error));
void initializeDoubaoCompatibility().catch((error: unknown) => console.warn("WuPage Doubao compatibility:", error));
try {
  initPageContextMenu();
} catch (error: unknown) {
  console.warn("WuPage page menu:", error);
}

async function handleMessage(request: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (isFrameRequest(request)) return frameSessions.handle(request, sender);
  switch (request.type) {
    case "GET_PARAGRAPH_MODE":
      return { enabled: await readParagraphMode() };
    case "SET_PARAGRAPH_MODE":
      return saveParagraphMode(request.enabled);
    case "PAGE_TRANSLATION_STATE_CHANGED":
      await refreshPageContextMenu(sender);
      return null;
    case "VIDEO_FRAME_STATUS":
      registerVideoFrame(request, sender); return null;
    case "CAPTURE_VIDEO_FRAME":
      return captureVideoFrame(request, sender);
    case "TRANSLATE_VIDEO_SUBTITLES":
      return translateVideo(request, sender);
    case "CANCEL_VIDEO_SUBTITLES":
      cancelVideo(request, sender); return null;
    case "OPEN_VIDEO_SUBTITLES":
      return openVideoInTab(request.tabId ?? sender.tab?.id);
    case "LOOKUP_DICTIONARY":
    case "PLAY_DICTIONARY_AUDIO": {
      const settings = normalizeSelectionTranslation((await getSettings()).selectionTranslation);
      if (!settings.enabled) throw new Error("请先在设置中开启划词翻译。");
      if (request.type === "LOOKUP_DICTIONARY") return lookupDictionary(request.provider, request.query);
      return playDictionaryAudio(request.provider, request.url, `${sender.tab?.id ?? "extension"}:${sender.frameId ?? 0}`);
    }
    case "STOP_DICTIONARY_AUDIO":
      return stopDictionaryAudio(`${sender.tab?.id ?? "extension"}:${sender.frameId ?? 0}`);
    case "GET_DOUBAO_STATUS":
      return getDoubaoStatus();
    case "CHECK_DOUBAO": {
      const settings = await getSettings();
      if (!settings.providers.some((entry) => entry.type === "doubao-web" && entry.enabled !== false)) {
        throw new Error("请先启用豆包翻译服务。");
      }
      return checkDoubao();
    }
    case "GET_LOCAL_MODEL_STATUS":
      return requestLocal("status");
    case "INSTALL_LOCAL_MODEL":
      return requestLocal("install", request.modelId);
    case "CANCEL_LOCAL_MODEL_DOWNLOAD":
      return requestLocal("cancel");
    case "REMOVE_LOCAL_MODEL":
      return requestLocal("remove", request.modelId);
    case "OPEN_OPTIONS_PAGE":
      await chrome.runtime.openOptionsPage();
      return null;
    case "OPEN_EMBEDDED_PDF": {
      const source = new URL(request.url);
      if (!["http:", "https:"].includes(source.protocol)) throw new Error("此 PDF 地址不支持打开。");
      const target = new URL(chrome.runtime.getURL("pdf.html"));
      target.searchParams.set("url", source.href); target.searchParams.set("translate", "1");
      await chrome.tabs.create({ url: target.href }); return { opened: true };
    }
    case "GET_SETTINGS": {
      let settings = await getSettings();
      if (settings.imageTranslationEnabled) {
        // OCR cache availability must not take down page translation/settings.
        // Only a successful check can establish that a model is missing.
        let installed: string | undefined;
        try { installed = await installedRevision(); }
        catch { return getSettings(); }
        // Model checks may finish after another page has saved new settings.
        // Return that version and only change its image toggle when needed.
        settings = await getSettings();
        if (!installed && settings.imageTranslationEnabled) {
          settings = await saveSettings(latest => ({ ...latest, imageTranslationEnabled: false }));
        }
      }
      return settings;
    }
    case "SAVE_SETTINGS":
      // Checking a new opt-in is required. An unavailable optional cache must
      // not prevent changing languages or services while OCR is already on.
      await saveSettings(async latest => {
        const next = request.previousSettings
          ? mergeSettingsChanges(latest, request.settings, request.previousSettings) : request.settings;
        if (next.imageTranslationEnabled && !latest.imageTranslationEnabled
          && !await installedRevision()) throw new Error("请先点击图片翻译旁的扳手安装 OCR 模型。");
        return next;
      });
      return null;
    case "GET_OCR_STATUS":
      return requestOcr("status");
    case "INSTALL_OCR":
      return requestOcr("install");
    case "REMOVE_OCR": {
      const result = await requestOcr("remove");
      await saveSettings(latest => ({ ...latest, imageTranslationEnabled: false }));
      return result;
    }
    case "TRANSLATE_BATCH": {
      const settings = await getSettings();
      return frameSessions.translate(request, sender, signal => translateWithSettings(settings, request, { signal, statisticsPageKey: statisticsPageKey(sender) }));
    }
    case "LOAD_IMAGE": {
      const settings = await getSettings();
      if (!settings.imageTranslationEnabled) throw new Error("请先开启图片翻译。");
      return loadImageData(request.url);
    }
    case "TRANSLATE_IMAGE":
      return translateImageWithSettings(await getSettings(), request, statisticsPageKey(sender));
    case "GET_STATISTICS":
      return getStatistics();
    case "CLEAR_STATISTICS":
      return clearStatistics();
    case "GET_TRANSLATION_DEBUG":
      return { ...getTranslationDebugSnapshot(),
        ...(sender.tab?.id !== undefined ? { frames: await frameSessions.diagnostics(sender.tab.id) } : {}) };
    case "CLEAR_CACHE":
      return clearTranslationCache();
    case "TEST_PROVIDER": {
      const settings = await getSettings();
      const providerConfig = settings.providers.find(
        (provider) => provider.id === (request.providerId ?? settings.activeProviderId)
      );
      if (!providerConfig) throw new Error("Provider not found.");
      // An explicit settings test can validate a service before it is enabled.
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
    case "EXECUTE_TRANSLATION_SHORTCUT":
    case "TRANSLATE_CONTEXT_IMAGE":
    case "CLEAR_TRANSLATION":
    case "GET_TRANSLATION_STATE":
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

function isFrameRequest(request: RuntimeRequest): request is FrameSessionRequest {
  return request.type.startsWith("FRAME_");
}
