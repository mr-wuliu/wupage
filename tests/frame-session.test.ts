import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { aggregateDocumentStates, emptyDocumentState, frameExclusion, normalizeFrameTranslation,
  type FrameDocumentIdentity, type FrameSessionSnapshot } from "../src/shared/frame-session";
import type { ExtensionSettings, RuntimeRequest } from "../src/shared/types";
import { ProviderError } from "../src/shared/errors";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture() {
  vi.stubGlobal("chrome", {});
  const { FrameSessionManager } = await import("../src/background/frame-sessions");
  let settings = structuredClone(DEFAULT_SETTINGS);
  const stored: Record<string, unknown> = {};
  const deliveries: Array<{ frameId?: number; documentId?: string; request: RuntimeRequest }> = [];
  const live = new Map<number, FrameDocumentIdentity>();
  const sendMessage = vi.fn(async (_tab: number, request: RuntimeRequest, target: { frameId?: number; documentId?: string }) => {
    deliveries.push({ ...target, request });
    const frameId = target.frameId ?? Number(target.documentId?.replace("document-", ""));
    if (request.type === "FRAME_IDENTIFY") return { ok: true, data: live.get(frameId) };
    if (request.type === "FRAME_APPLY") {
      const state = { ...emptyDocumentState(), active: request.allowed && request.snapshot.active,
        translated: request.allowed && request.snapshot.active ? 1 : 0 };
      live.set(frameId, { documentKey: request.documentKey, sessionId: request.snapshot.id, state });
      return { ok: true, data: state };
    }
    return { ok: true };
  });
  const api = {
    storage: { session: { get: async (key: string) => ({ [key]: stored[key] }),
      set: async (value: object) => { Object.assign(stored, structuredClone(value)); },
      remove: async (key: string) => { delete stored[key]; } } },
    tabs: { sendMessage }
  } as unknown as typeof chrome;
  const readSettings = vi.fn(async () => settings);
  const manager = new FrameSessionManager(api, readSettings);
  const sender = (frameId: number, tabId = 1): chrome.runtime.MessageSender => ({ tab: { id: tabId } as chrome.tabs.Tab,
    frameId, documentId: `document-${frameId}`, url: frameId ? `https://embed.example/${frameId}` : "https://site.example/article" });
  const register = (frameId: number, tabId = 1, documentKey = `key-${frameId}`) => {
    live.set(frameId, { documentKey });
    return manager.handle({ type: "FRAME_REGISTER", documentKey, url: sender(frameId, tabId).url! }, sender(frameId, tabId));
  };
  const discovery = () => {
    const frames = [...live.keys()].map(frameId => ({ frameId, parentFrameId: frameId ? 0 : -1,
      documentId: `document-${frameId}`, url: sender(frameId).url! }));
    Object.assign(api, { webNavigation: { getAllFrames: vi.fn(async () => frames),
      getFrame: vi.fn(async ({ frameId }: { frameId: number }) => frames.find(frame => frame.frameId === frameId)) } });
    return frames;
  };
  const action = async (action: "start" | "stop", tabId = 1) =>
    (await manager.handle({ type: "FRAME_SESSION_ACTION", action }, sender(0, tabId)) as FrameSessionSnapshot).state;
  const snapshot = () => manager.handle({ type: "FRAME_SESSION_GET" }, sender(0)) as Promise<FrameSessionSnapshot>;
  return { manager, api, sendMessage, readSettings, stored, sender, register, action, snapshot, deliveries, live, discovery,
    settings: () => settings, update: (value: ExtensionSettings) => { settings = value; } };
}

describe("iframe translation policy", () => {
  it("defaults to all permitted documents and normalizes explicit exclusions", () => {
    expect(normalizeFrameTranslation(undefined)).toEqual({ enabled: true, excludeMatches: [] });
    expect(normalizeFrameTranslation({ excludeMatches: [" a ", "a", "", null] })).toEqual({ enabled: true, excludeMatches: ["a"] });
    expect(frameExclusion(DEFAULT_SETTINGS, "https://site.example/", "https://different.example/article", 2)).toBeUndefined();
    const settings = { ...DEFAULT_SETTINGS, frameTranslation: { enabled: true,
      excludeMatches: ["https://site.example/* => https://embed.example/private/*"] } };
    expect(frameExclusion(settings, "https://site.example/a", "https://embed.example/private/b", 2)).toContain("排除规则");
    expect(frameExclusion(settings, "https://other.example/a", "https://embed.example/private/b", 2)).toBeUndefined();
    expect(frameExclusion({ ...settings, frameTranslation: { enabled: false, excludeMatches: [] } }, "", "", 0)).toBeUndefined();
  });
  it("aggregates contributing documents without counting exclusions or losing retry information", () => {
    expect(aggregateDocumentStates([
      { frameId: 0, url: "", status: "ready", state: { ...emptyDocumentState(), translated: 2 } },
      { frameId: 1, url: "", status: "excluded", state: { ...emptyDocumentState(), translated: 99 } },
      { frameId: 2, url: "", status: "failed", state: { ...emptyDocumentState(), failed: 1, error: "rate limit", retryAt: 1000 } }
    ], true)).toMatchObject({ active: true, translated: 2, failed: 1, error: "rate limit", retryAt: 1000 });
  });
  it("matches host names without changing case-sensitive paths or requiring a scheme", () => {
    const settings = { ...DEFAULT_SETTINGS, frameTranslation: { enabled: true, excludeMatches: ["EMBED.example/Private/*"] } };
    expect(frameExclusion(settings, "https://site.example/", "https://embed.example/Private/a?x=1", 1)).toBeDefined();
    expect(frameExclusion(settings, "https://site.example/", "https://embed.example/private/a", 1)).toBeUndefined();
    expect(frameExclusion(settings, "https://site.example/", "https://embed.example.evil/Private/a", 1)).toBeUndefined();
  });
});

describe("tab-wide document sessions", () => {
  it("starts static top and embedded documents after the background loses its in-memory registry", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); f.discovery();
    const { FrameSessionManager } = await import("../src/background/frame-sessions");
    const restarted = new FrameSessionManager(f.api, f.readSettings);
    const result = await restarted.handle({ type: "FRAME_SESSION_ACTION", action: "start" }, f.sender(0)) as FrameSessionSnapshot;
    expect(result.state).toMatchObject({ active: true, translated: 2 });
    expect(result.frames.map(frame => frame.frameId)).toEqual([0, 1]);
    expect(f.deliveries.filter(item => item.request.type === "FRAME_APPLY").map(item => item.documentId)).toEqual(["document-0", "document-1"]);
  });

  it("recovers current counts without translating again and stops every document after restart", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); await f.action("start"); f.discovery();
    f.deliveries.length = 0;
    const { FrameSessionManager } = await import("../src/background/frame-sessions");
    const restarted = new FrameSessionManager(f.api, f.readSettings);
    const current = await restarted.handle({ type: "FRAME_SESSION_GET" }, f.sender(0)) as FrameSessionSnapshot;
    expect(current.state).toMatchObject({ active: true, translated: 2 });
    expect(f.deliveries.every(item => item.request.type === "FRAME_IDENTIFY")).toBe(true);
    const result = await restarted.handle({ type: "FRAME_SESSION_ACTION", action: "stop" }, f.sender(0)) as FrameSessionSnapshot;
    expect(result.state).toMatchObject({ active: false, translated: 0 });
    expect(f.deliveries.filter(item => item.request.type === "FRAME_APPLY").map(item => item.documentId)).toEqual(["document-0", "document-1"]);
  });

  it("rediscovers live documents even when optional persistence was lost", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); f.discovery();
    vi.spyOn(f.api.storage.session, "get").mockRejectedValue(new Error("Session storage unavailable"));
    const { FrameSessionManager } = await import("../src/background/frame-sessions");
    const restarted = new FrameSessionManager(f.api, f.readSettings);
    const result = await restarted.handle({ type: "FRAME_SESSION_ACTION", action: "start" }, f.sender(0)) as FrameSessionSnapshot;
    expect(result.state.translated).toBe(2);
    expect(result.topDocument).toBe("key-0");
  });

  it("does not restore a saved active generation into a replacement top document", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); await f.action("start"); f.discovery();
    f.live.set(0, { documentKey: "replacement-top" });
    const { FrameSessionManager } = await import("../src/background/frame-sessions");
    const restarted = new FrameSessionManager(f.api, f.readSettings);
    const current = await restarted.handle({ type: "FRAME_SESSION_GET" }, f.sender(0)) as FrameSessionSnapshot;
    expect(current).toMatchObject({ active: false, topDocument: "replacement-top", state: { translated: 0 } });
  });

  it("preserves ancestor exclusions while rebuilding the document registry", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); await f.register(2);
    const frames = f.discovery(); frames[2].parentFrameId = 1;
    f.update({ ...f.settings(), frameTranslation: { enabled: true, excludeMatches: ["https://embed.example/1"] } });
    const { FrameSessionManager } = await import("../src/background/frame-sessions");
    const restarted = new FrameSessionManager(f.api, f.readSettings);
    const result = await restarted.handle({ type: "FRAME_SESSION_ACTION", action: "start" }, f.sender(0)) as FrameSessionSnapshot;
    expect(result.state.translated).toBe(1);
    expect(result.frames.find(frame => frame.frameId === 2)?.status).toBe("excluded");
  });

  it("reports a missing top document connection instead of successful empty translation", async () => {
    const f = await fixture(); await f.register(0); f.discovery(); f.live.delete(0);
    const { FrameSessionManager } = await import("../src/background/frame-sessions");
    const restarted = new FrameSessionManager(f.api, f.readSettings);
    await expect(restarted.handle({ type: "FRAME_SESSION_ACTION", action: "start" }, f.sender(0))).rejects.toThrow(/网页.*连接|连接.*网页/u);
  });

  it("ignores a probe response from a document replaced during discovery", async () => {
    const f = await fixture(); await f.register(0); await f.register(1);
    const frames = f.discovery();
    vi.mocked(f.api.webNavigation.getFrame).mockImplementation(async ({ frameId }) => ({ ...frames[frameId ?? 0],
      documentId: frameId ? "replacement-document" : "document-0", documentLifecycle: "active", errorOccurred: false,
      frameType: frameId ? "sub_frame" : "outermost_frame" } as chrome.webNavigation.GetFrameResultDetails));
    const { FrameSessionManager } = await import("../src/background/frame-sessions");
    const restarted = new FrameSessionManager(f.api, f.readSettings);
    const result = await restarted.handle({ type: "FRAME_SESSION_ACTION", action: "start" }, f.sender(0)) as FrameSessionSnapshot;
    expect(result.state.translated).toBe(1);
    expect(result.frames.find(frame => frame.frameId === 1)?.status).toBe("unavailable");
    expect(f.deliveries.filter(item => item.request.type === "FRAME_APPLY").map(item => item.documentId)).toEqual(["document-0"]);
  });

  it("shares cold discovery across concurrent controls and lets a later stop win", async () => {
    const f = await fixture(); await f.register(0); f.discovery();
    let release!: () => void;
    const probing = new Promise<void>(resolve => { release = resolve; });
    const original = f.sendMessage.getMockImplementation()!;
    f.sendMessage.mockImplementation(async (...args) => {
      if (args[1].type === "FRAME_IDENTIFY") await probing;
      return original(...args);
    });
    const { FrameSessionManager } = await import("../src/background/frame-sessions");
    const restarted = new FrameSessionManager(f.api, f.readSettings);
    const starting = restarted.handle({ type: "FRAME_SESSION_ACTION", action: "start" }, f.sender(0));
    const stopping = restarted.handle({ type: "FRAME_SESSION_ACTION", action: "stop" }, f.sender(0));
    release();
    const [start, stop] = await Promise.all([starting, stopping]) as FrameSessionSnapshot[];
    expect(start.active).toBe(false); expect(stop.active).toBe(false);
    expect(f.api.webNavigation.getAllFrames).toHaveBeenCalledTimes(1);
    expect(f.deliveries.filter(item => item.request.type === "FRAME_APPLY")
      .every(item => item.request.type === "FRAME_APPLY" && !item.request.snapshot.active)).toBe(true);
  });

  it("cancels pending work only in documents whose exclusion rules change", async () => {
    const f = await fixture();
    let changed!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
    Object.assign(f.api.storage, { onChanged: { addListener: (listener: typeof changed) => { changed = listener; } } });
    f.manager.install();
    await f.register(0); await f.register(1); await f.action("start");
    const { id } = await f.snapshot();
    let topSignal!: AbortSignal, childSignal!: AbortSignal;
    let finishChild!: (value: string) => void;
    const top = f.manager.translate({ texts: ["top"], targetLang: "zh-CN", pageSession: { id, documentKey: "key-0" } }, f.sender(0),
      signal => new Promise<string>((_resolve, reject) => {
        topSignal = signal!; signal!.addEventListener("abort", () => reject(new Error("cancelled excluded document")));
      })).catch(error => error);
    const child = f.manager.translate({ texts: ["child"], targetLang: "zh-CN", pageSession: { id, documentKey: "key-1" } }, f.sender(1),
      signal => { childSignal = signal!; return new Promise<string>(resolve => { finishChild = resolve; }); });
    await vi.waitFor(() => expect(topSignal && childSignal).toBeDefined());
    const settings = { ...f.settings(), elementExclusions: [{ id: "top", name: "Top region", pattern: "site.example",
      selectors: [".excluded"], enabled: true }] };
    changed({ "wupage.settings": { newValue: settings } }, "local");
    await vi.waitFor(() => expect(topSignal.aborted).toBe(true));
    expect(childSignal.aborted).toBe(false);
    expect((await f.snapshot()).id).toBe(id);
    finishChild("still active"); expect(await child).toBe("still active");
    expect(await top).toBeInstanceOf(Error);
  });

  it("keeps live sessions usable when optional session persistence fails", async () => {
    const f = await fixture();
    vi.spyOn(f.api.storage.session, "get").mockRejectedValue(new Error("Session storage unavailable"));
    vi.spyOn(f.api.storage.session, "set").mockRejectedValue(new Error("Quota exceeded"));
    vi.spyOn(f.api.storage.session, "remove").mockRejectedValue(new Error("Session storage unavailable"));
    await f.register(0);
    expect(await f.action("start")).toMatchObject({ active: true, translated: 1 });
    expect(await f.action("stop")).toMatchObject({ active: false });
  });
  it("retries a failed settings read on the next session request", async () => {
    const f = await fixture();
    f.readSettings.mockRejectedValueOnce(new Error("Storage temporarily unavailable"));
    await expect(f.register(0)).rejects.toThrow("Storage temporarily unavailable");
    await f.register(0);
    expect(await f.action("start")).toMatchObject({ active: true, translated: 1 });
  });
  it("reports a document initialization failure while translating healthy documents", async () => {
    const f = await fixture();
    await f.register(0); await f.register(1);
    const original = f.sendMessage.getMockImplementation()!;
    f.sendMessage.mockImplementation(async (tabId, request, target) => {
      if (request.type === "FRAME_APPLY" && target?.documentId === "document-1") throw new Error("Document initialization failed");
      return original(tabId, request, target!);
    });
    expect(await f.action("start")).toMatchObject({ active: true, translated: 1, failed: 0, error: "Document initialization failed" });
    await f.action("stop");
    expect((await f.snapshot()).state).toMatchObject({ active: false, failed: 0 });
  });
  it("does not turn a disconnected hidden helper into a whole-page translation failure", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); f.discovery();
    const snapshot = await f.snapshot();
    await f.manager.handle({ type: "FRAME_REPORT", sessionId: snapshot.id, documentKey: "key-1",
      state: { ...emptyDocumentState(), documentHidden: true } }, f.sender(1));
    const original = f.sendMessage.getMockImplementation()!;
    f.sendMessage.mockImplementation(async (tabId, request, target) => {
      if (target.documentId === "document-1") throw new Error("Could not establish connection. Receiving end does not exist.");
      return original(tabId, request, target);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = await f.action("start");
      expect(state.translated).toBe(1);
      expect(state.error).toBeUndefined();
      expect((await f.snapshot()).frames.find(frame => frame.frameId === 1)).toMatchObject({
        status: "unavailable", reason: expect.stringContaining("Receiving end does not exist")
      });
    }
  });
  it("drops a removed document after a failed delivery instead of retaining its error", async () => {
    const f = await fixture(); await f.register(0); await f.register(1);
    const frames = f.discovery(); frames.splice(1, 1);
    const original = f.sendMessage.getMockImplementation()!;
    f.sendMessage.mockImplementation(async (tabId, request, target) => {
      if (target.documentId === "document-1") throw new Error("Could not establish connection. Receiving end does not exist.");
      return original(tabId, request, target);
    });
    const state = await f.action("start");
    expect(state.translated).toBe(1);
    expect(state.error).toBeUndefined();
    expect((await f.snapshot()).frames.some(frame => frame.frameId === 1)).toBe(false);
  });
  it("keeps a disconnected visible document as an actionable connection failure", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); f.discovery();
    const original = f.sendMessage.getMockImplementation()!;
    f.sendMessage.mockImplementation(async (tabId, request, target) => {
      if (target.documentId === "document-1") throw new Error("Could not establish connection. Receiving end does not exist.");
      return original(tabId, request, target);
    });
    const state = await f.action("start");
    expect(state.translated).toBe(1);
    expect(state.error).toMatch(/嵌入页面.*连接/u);
    expect(state.errorCode).toBe("frame-connection-lost");
  });
  it("recovers one transient delivery failure after verifying the same document identity", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); f.discovery();
    const original = f.sendMessage.getMockImplementation()!;
    let dropped = false;
    f.sendMessage.mockImplementation(async (tabId, request, target) => {
      if (!dropped && request.type === "FRAME_APPLY" && target.documentId === "document-1") {
        dropped = true; throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return original(tabId, request, target);
    });
    expect(await f.action("start")).toMatchObject({ translated: 2 });
    expect((await f.snapshot()).state.error).toBeUndefined();
    expect(f.deliveries.some(item => item.request.type === "FRAME_IDENTIFY" && item.documentId === "document-1")).toBe(true);
  });
  it("does not suppress or retry a connected hidden document's acknowledged runtime error", async () => {
    const f = await fixture(); await f.register(0);
    await f.manager.handle({ type: "FRAME_REGISTER", documentKey: "key-1", url: f.sender(1).url!, documentHidden: true }, f.sender(1));
    const original = f.sendMessage.getMockImplementation()!;
    f.sendMessage.mockImplementation(async (tabId, request, target) => {
      if (request.type === "FRAME_APPLY" && target.documentId === "document-1") {
        return { ok: false, error: "Could not establish connection. Receiving end does not exist." };
      }
      return original(tabId, request, target);
    });
    const state = await f.action("start");
    expect(state.error).toContain("Receiving end does not exist");
    expect((await f.snapshot()).frames.find(frame => frame.frameId === 1)?.status).toBe("failed");
    expect(f.deliveries.some(item => item.request.type === "FRAME_IDENTIFY")).toBe(false);
  });
  it("never suppresses a missing main-page receiver, even when its visibility was hidden", async () => {
    const f = await fixture();
    await f.manager.handle({ type: "FRAME_REGISTER", documentKey: "key-0", url: f.sender(0).url!, documentHidden: true }, f.sender(0));
    f.sendMessage.mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
    expect(await f.action("start")).toMatchObject({ errorCode: "page-connection-lost", error: expect.stringMatching(/当前网页.*连接/u) });
  });
  it("addresses browser document identities, aggregates results, isolates tabs, and restores all documents", async () => {
    const f = await fixture();
    await f.register(0); await f.register(1); await f.register(0, 2);
    expect(await f.action("start")).toMatchObject({ active: true, translated: 2 });
    expect(f.deliveries.filter(item => item.request.type === "FRAME_APPLY").map(item => item.documentId)).toEqual(["document-0", "document-1"]);
    expect(await f.manager.handle({ type: "FRAME_SESSION_GET" }, f.sender(0, 2))).toMatchObject({ active: false });
    expect(await f.action("stop")).toMatchObject({ active: false, translated: 0 });
    expect(f.deliveries.filter(item => item.request.type === "FRAME_APPLY").slice(-2)
      .every(item => item.request.type === "FRAME_APPLY" && !item.request.snapshot.active)).toBe(true);
  });
  it("does not restart after a stop overtakes a pending settings read", async () => {
    const f = await fixture(); await f.register(0);
    let resolve!: (settings: ExtensionSettings) => void;
    f.readSettings.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const starting = f.action("start"); await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await f.action("stop"); resolve(f.settings()); await starting;
    expect(await f.snapshot()).toMatchObject({ active: false });
    expect(f.deliveries.filter(item => item.request.type === "FRAME_APPLY")
      .every(item => item.request.type === "FRAME_APPLY" && !item.request.snapshot.active)).toBe(true);
  });
  it("drops stale reports and requests after navigation or a new translation generation", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); await f.action("start");
    const old = await f.snapshot(); await f.register(1, 1, "replacement");
    await f.manager.handle({ type: "FRAME_REPORT", sessionId: old.id, documentKey: "key-1",
      state: { ...emptyDocumentState(), translated: 500 } }, f.sender(1));
    expect((await f.snapshot()).state.translated).toBeLessThan(500);
    const run = vi.fn(async () => "result");
    await expect(f.manager.translate({ texts: ["text"], targetLang: "en", pageSession: { id: old.id, documentKey: "key-1" } }, f.sender(1), run)).rejects.toThrow();
    await f.action("stop");
    await expect(f.manager.translate({ texts: ["text"], targetLang: "en", pageSession: { id: old.id, documentKey: "key-0" } }, f.sender(0), run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it("aborts running work and removes queued requests when the whole page is stopped", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); await f.action("start");
    const { id } = await f.snapshot(); const run = vi.fn((signal?: AbortSignal) => new Promise<void>((_done, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const request = (frame: number) => ({ texts: ["text"], targetLang: "en", pageSession: { id, documentKey: `key-${frame}` } });
    const work = [f.manager.translate(request(0), f.sender(0), run), f.manager.translate(request(1), f.sender(1), run),
      f.manager.translate(request(1), f.sender(1), run)].map(promise => promise.catch(error => String(error)));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await f.action("stop"); expect((await Promise.all(work)).every(value => typeof value === "string")).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("restores the desired session after background restart and admits late frames", async () => {
    const f = await fixture(); await f.register(0); await f.action("start"); const previous = await f.snapshot();
    const { FrameSessionManager } = await import("../src/background/frame-sessions");
    const restored = new FrameSessionManager(f.api, f.readSettings);
    const value = await restored.handle({ type: "FRAME_REGISTER", documentKey: "key-9", url: "https://embed.example/late" }, f.sender(9)) as FrameSessionSnapshot;
    expect(value).toMatchObject({ id: previous.id, active: true, topDocument: "key-0" });
    expect(value.frames.some(frame => frame.frameId === 9)).toBe(true);
  });
  it("aborts only the document that navigates while other frame requests continue", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); await f.action("start");
    const { id } = await f.snapshot();
    let firstSignal: AbortSignal | undefined;
    let finishOther!: () => void;
    const first = f.manager.translate({ texts: ["first"], targetLang: "en", pageSession: { id, documentKey: "key-1" } }, f.sender(1),
      signal => new Promise((_done, reject) => { firstSignal = signal; signal!.addEventListener("abort", () => reject(new Error("navigated")), { once: true }); }))
      .catch(error => String(error));
    const other = f.manager.translate({ texts: ["other"], targetLang: "en", pageSession: { id, documentKey: "key-0" } }, f.sender(0),
      signal => new Promise<string>(resolve => { finishOther = () => resolve(signal!.aborted ? "aborted" : "completed"); }));
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    await f.register(1, 1, "new-document");
    expect(await first).toContain("navigated"); finishOther(); expect(await other).toBe("completed");
    expect((await f.snapshot()).active).toBe(true);
  });
  it("pauses a rate-limited provider across documents and preserves the pause after background restart", async () => {
    const f = await fixture(); await f.register(0); await f.register(1); await f.action("start");
    await f.register(0, 2); await f.action("start", 2);
    const otherTab = await f.manager.handle({ type: "FRAME_SESSION_GET" }, f.sender(0, 2)) as FrameSessionSnapshot;
    const { id } = await f.snapshot();
    const request = (key: string) => ({ texts: ["text"], targetLang: "en", pageSession: { id, documentKey: key } });
    await expect(f.manager.translate(request("key-0"), f.sender(0), async () => { throw new ProviderError("slow down", "rate-limited", 10000); }))
      .rejects.toMatchObject({ errorCode: "rate-limited" });
    const retry = vi.fn(async () => "unexpected");
    await expect(f.manager.translate(request("key-1"), f.sender(1), retry)).rejects.toMatchObject({ errorCode: "rate-limited" });
    await expect(f.manager.translate({ ...request("key-0"), pageSession: { id: otherTab.id, documentKey: "key-0" } },
      f.sender(0, 2), retry)).rejects.toMatchObject({ errorCode: "rate-limited" });
    expect(retry).not.toHaveBeenCalled();
    const { FrameSessionManager } = await import("../src/background/frame-sessions");
    const restored = new FrameSessionManager(f.api, f.readSettings);
    expect(await restored.handle({ type: "FRAME_SESSION_GET" }, f.sender(0))).toMatchObject({ state: { errorCode: "rate-limited" } });
    await f.action("start"); const fresh = await f.snapshot();
    expect(await f.manager.translate({ ...request("key-1"), pageSession: { id: fresh.id, documentKey: "key-1" } }, f.sender(1), async () => "retried")).toBe("retried");
  });
});
