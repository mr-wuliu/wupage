import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { getSettings } from "../src/shared/settings";
import { installedRevision } from "../src/ocr/model-store";
import { handleImageMenuClick, IMAGE_MENU_ID, initImageContextMenu, refreshImageContextMenu } from "../src/background/image-context-menu";

vi.mock("../src/shared/settings", () => ({ getSettings: vi.fn() }));
vi.mock("../src/ocr/model-store", () => ({ installedRevision: vi.fn() }));
const info = { menuItemId: IMAGE_MENU_ID, srcUrl: "https://pbs.twimg.com/media/test?format=jpg&name=large", frameId: 3, editable: false };
const tab = { id: 42 } as chrome.tabs.Tab;
const queryTabs = vi.fn<() => Promise<chrome.tabs.Tab[]>>();
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, imageTranslationEnabled: true });
  vi.mocked(installedRevision).mockResolvedValue("v1");
  vi.stubGlobal("navigator", { userAgent: "Chrome/130 Edg/130" });
  queryTabs.mockResolvedValue([{ ...tab, url: "https://example.com/", active: true }]);
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    tabs: { sendMessage: vi.fn(async () => ({ ok: true, data: { started: true } })), create: vi.fn(),
      query: queryTabs,
      onActivated: { addListener: vi.fn() }, onUpdated: { addListener: vi.fn() } },
    windows: { onFocusChanged: { addListener: vi.fn() } },
    storage: { onChanged: { addListener: vi.fn() } },
    contextMenus: { update: vi.fn((_id, _properties, callback) => { callback?.(); }),
      create: vi.fn((_properties, callback) => { Reflect.deleteProperty(chrome.runtime, "lastError"); callback?.(); }), onClicked: { addListener: vi.fn() } }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("image context menu", () => {
  it("registers an image-only menu without duplicating it on worker restart", async () => {
    initImageContextMenu();
    expect(chrome.contextMenus.onClicked.addListener).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(chrome.contextMenus.update).toHaveBeenCalledWith(IMAGE_MENU_ID, expect.objectContaining({
      contexts: ["image"], documentUrlPatterns: ["http://*/*", "https://*/*"]
    }), expect.any(Function)));
    expect(chrome.contextMenus.create).not.toHaveBeenCalled();
    vi.mocked(chrome.contextMenus.update).mockImplementationOnce((_id, _properties, callback) => {
      Object.assign(chrome.runtime, { lastError: { message: "missing" } });
      callback?.();
      Reflect.deleteProperty(chrome.runtime, "lastError");
      return undefined as never;
    });
    initImageContextMenu();
    await vi.waitFor(() => expect(chrome.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: IMAGE_MENU_ID }), expect.any(Function)));
  });
  it("routes the exact source URL to the clicked tab and frame", async () => {
    await handleImageMenuClick(info, tab);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { type: "TRANSLATE_CONTEXT_IMAGE", srcUrl: info.srcUrl }, { frameId: 3 });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it("disables the image menu on the Edge store and restores it when switching to a normal page", async () => {
    const store = "https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home";
    queryTabs.mockResolvedValue([{ ...tab, url: store, active: true }]);
    initImageContextMenu(); await refreshImageContextMenu();
    expect(chrome.contextMenus.update).toHaveBeenLastCalledWith(IMAGE_MENU_ID,
      expect.objectContaining({ visible: true, enabled: false, title: "图片翻译（此页面不支持）" }), expect.any(Function));
    queryTabs.mockResolvedValue([{ ...tab, url: "https://example.com/", active: true }]);
    vi.mocked(chrome.tabs.onActivated.addListener).mock.calls[0][0]({ tabId: 42, windowId: 1 });
    await vi.waitFor(() => expect(chrome.contextMenus.update).toHaveBeenLastCalledWith(IMAGE_MENU_ID,
      expect.objectContaining({ enabled: true, title: "使用 WuPage 翻译图片" }), expect.any(Function)));
    queryTabs.mockResolvedValue([{ ...tab, url: store, active: true }]);
    vi.mocked(chrome.tabs.onUpdated.addListener).mock.calls[0][0](42, { status: "complete" }, { ...tab, active: true });
    await vi.waitFor(() => expect(chrome.contextMenus.update).toHaveBeenLastCalledWith(IMAGE_MENU_ID,
      expect.objectContaining({ enabled: false }), expect.any(Function)));
  });
  it.each(["tab", "page", "frame"])("does not redirect a restricted %s to OCR setup or refresh", async source => {
    const store = "https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home";
    vi.mocked(installedRevision).mockResolvedValue(undefined);
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
    await handleImageMenuClick({ ...info, ...(source === "page" ? { pageUrl: store } : source === "frame" ? { frameUrl: store } : {}) },
      { ...tab, ...(source === "tab" ? { url: store } : {}) });
    expect(installedRevision).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it.each([
    [true, true, true], [true, false, false], [false, true, false], [false, false, false]
  ])("shows the image menu with master=%s and context control=%s: %s", async (master, menu, visible) => {
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, imageTranslationEnabled: master,
      imageTranslationContextMenuEnabled: menu, imageTranslationFloatingEnabled: false });
    await refreshImageContextMenu();
    expect(chrome.contextMenus.update).toHaveBeenLastCalledWith(IMAGE_MENU_ID, expect.objectContaining({ visible }), expect.any(Function));
  });
  it("updates an existing menu when the saved image controls change", async () => {
    initImageContextMenu();
    await refreshImageContextMenu();
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, imageTranslationEnabled: true, imageTranslationContextMenuEnabled: false });
    vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0]({ "wupage.settings": { newValue: {} } }, "local");
    await vi.waitFor(() => expect(chrome.contextMenus.update).toHaveBeenLastCalledWith(IMAGE_MENU_ID,
      expect.objectContaining({ visible: false }), expect.any(Function)));
  });
  it("ignores a stale menu click when its own control has been disabled", async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, imageTranslationEnabled: true, imageTranslationContextMenuEnabled: false });
    await handleImageMenuClick(info, tab);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it("opens setup when models are missing instead of uploading an image", async () => {
    vi.mocked(installedRevision).mockResolvedValue(undefined);
    await handleImageMenuClick(info, tab);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://test/options.html?imageTranslationNotice=setup" });
  });
  it("ignores unrelated menus and missing image targets", async () => {
    await handleImageMenuClick({ ...info, menuItemId: "other" }, tab);
    await handleImageMenuClick({ ...info, srcUrl: undefined }, tab);
    expect(getSettings).not.toHaveBeenCalled();
  });
  it("guides a stale tab to refresh when no content listener responds", async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValueOnce(undefined);
    await handleImageMenuClick(info, tab);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://test/options.html?imageTranslationNotice=refresh" });
  });
  it("keeps the refresh guidance for a rejected connection on an ordinary page", async () => {
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
    await handleImageMenuClick({ ...info, pageUrl: "https://example.com/" }, tab);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://test/options.html?imageTranslationNotice=refresh" });
  });
  it("accepts inherited-origin frames on an ordinary page", async () => {
    await handleImageMenuClick({ ...info, pageUrl: "https://example.com/", frameUrl: "about:blank" }, tab);
    expect(chrome.tabs.sendMessage).toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});
