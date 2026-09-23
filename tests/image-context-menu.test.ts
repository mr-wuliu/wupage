import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { getSettings } from "../src/shared/settings";
import { installedRevision } from "../src/ocr/model-store";
import { handleImageMenuClick, IMAGE_MENU_ID, initImageContextMenu } from "../src/background/image-context-menu";

vi.mock("../src/shared/settings", () => ({ getSettings: vi.fn() }));
vi.mock("../src/ocr/model-store", () => ({ installedRevision: vi.fn() }));
const info = { menuItemId: IMAGE_MENU_ID, srcUrl: "https://pbs.twimg.com/media/test?format=jpg&name=large", frameId: 3, editable: false };
const tab = { id: 42 } as chrome.tabs.Tab;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, imageTranslationEnabled: true });
  vi.mocked(installedRevision).mockResolvedValue("v1");
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    tabs: { sendMessage: vi.fn(async () => ({ ok: true, data: { started: true } })), create: vi.fn() },
    contextMenus: { update: vi.fn(async () => {}), create: vi.fn(), onClicked: { addListener: vi.fn() } }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("image context menu", () => {
  it("registers an image-only menu without duplicating it on worker restart", async () => {
    initImageContextMenu(); await Promise.resolve();
    expect(chrome.contextMenus.update).toHaveBeenCalledWith(IMAGE_MENU_ID, expect.objectContaining({ contexts: ["image"], documentUrlPatterns: ["http://*/*", "https://*/*"] }));
    expect(chrome.contextMenus.create).not.toHaveBeenCalled();
    expect(chrome.contextMenus.onClicked.addListener).toHaveBeenCalledTimes(1);
    vi.mocked(chrome.contextMenus.update).mockRejectedValueOnce(new Error("missing"));
    initImageContextMenu(); await Promise.resolve();
    expect(chrome.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: IMAGE_MENU_ID }), expect.any(Function));
  });
  it("routes the exact source URL to the clicked tab and frame", async () => {
    await handleImageMenuClick(info, tab);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { type: "TRANSLATE_CONTEXT_IMAGE", srcUrl: info.srcUrl }, { frameId: 3 });
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
});
