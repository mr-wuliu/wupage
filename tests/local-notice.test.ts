// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { localModelNotice, renderLocalModelNotice } from "../src/shared/local-notice";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import type { LocalModelStatus } from "../src/local/models";
import type { sendRuntimeMessage } from "../src/shared/messaging";

function localSettings(sourceLang = "en", targetLang = "zh-CN") {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.activeProviderId = settings.providers.find(provider => provider.type === "firefox-local")!.id;
  return { ...settings, sourceLang, targetLang };
}
const ready = (id: string) => ({ id, state: "ready" as const, downloaded: 100, total: 100 });
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });
describe("local model menu notices", () => {
  it("does not claim that a pivot route is ready when one direction is missing", () => {
    const settings = localSettings("de", "zh-CN");
    expect(localModelNotice(settings, { models: [ready("de-en")] }).state).toBe("missing");
    expect(localModelNotice(settings, { models: [ready("de-en"), ready("en-zh-Hans")] }).state).toBe("ready");
  });
  it("distinguishes downloads, errors, unsupported directions and automatic source detection", () => {
    expect(localModelNotice(localSettings(), { models: [{ ...ready("en-zh-Hans"), state: "downloading", downloaded: 25 }] }).text).toContain("25%");
    expect(localModelNotice(localSettings(), { models: [{ ...ready("en-zh-Hans"), state: "error", error: "校验失败" }] }).text).toContain("校验失败");
    expect(localModelNotice(localSettings("ko"), { models: [] }).state).toBe("missing");
    expect(localModelNotice(localSettings("auto"), { models: [ready("en-de")] }).text).toBe("已安装 1 个语言模型");
  });
  it("ignores an older status after switching away from the local provider", async () => {
    const element = document.createElement("p"); document.body.append(element);
    let finish!: (status: LocalModelStatus) => void;
    const request = vi.fn(() => new Promise<LocalModelStatus>(resolve => { finish = resolve; }));
    const manage = vi.fn();
    renderLocalModelNotice(element, localSettings(), request as typeof sendRuntimeMessage, manage);
    element.querySelector("button")!.click(); expect(manage).toHaveBeenCalledOnce();
    renderLocalModelNotice(element, DEFAULT_SETTINGS, request as typeof sendRuntimeMessage, manage);
    element.textContent = "在线翻译服务";
    finish({ models: [ready("en-zh-Hans")] }); await Promise.resolve();
    expect(element.textContent).toBe("在线翻译服务");
    expect(request).toHaveBeenCalledExactlyOnceWith({ type: "GET_LOCAL_MODEL_STATUS" });
  });
});
