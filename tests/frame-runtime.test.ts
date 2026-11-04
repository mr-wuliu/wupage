// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { emptyDocumentState, type FrameSessionSnapshot } from "../src/shared/frame-session";
import type { PageTranslationCoordinator } from "../src/content/page-translation";
import type { RuntimeRequest } from "../src/shared/types";

const f = vi.hoisted(() => ({
  local: { active: false },
  configure: vi.fn(), start: vi.fn(), hide: vi.fn(), notify: vi.fn(), send: vi.fn()
}));
vi.mock("../src/content/runtime", () => ({ sendRuntimeRequest: f.send }));
vi.mock("../src/content/dom", () => ({ hasPageTranslations: () => false }));
vi.mock("../src/content/frame-visibility", () => ({ frameIsRendered: () => true }));
vi.mock("../src/content/page-translation", () => ({
  configurePageTranslationCoordinator: f.configure,
  getLocalPageTranslationState: () => ({ active: f.local.active }),
  hideLocalPageTranslation: f.hide, startLocalPageTranslation: f.start,
  notifyCoordinatedPageState: f.notify, setLocalPageTranslationDisplayMode: vi.fn(),
  setPageRequestIdentity: vi.fn(), subscribePageTranslationState: vi.fn()
}));
import { installFrameRuntime } from "../src/content/frame-runtime";

const snapshot = (revision: number, active: boolean): FrameSessionSnapshot => ({
  id: `session-${revision}`, revision, active, topDocument: "document",
  settings: structuredClone(DEFAULT_SETTINGS), frames: [], state: { ...emptyDocumentState(), active }
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe("document session control ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers(); f.local.active = false;
    f.hide.mockImplementation(() => { f.local.active = false; });
    f.start.mockImplementation(async () => { f.local.active = true; return { ...emptyDocumentState(), translated: 1 }; });
    f.send.mockImplementation(async (request: RuntimeRequest) => request.type === "FRAME_REGISTER" ? snapshot(1, false) : snapshot(2, true));
    vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    vi.stubGlobal("chrome", { runtime: { onMessage: { addListener: vi.fn() } } });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
  const controls = () => f.configure.mock.calls.at(-1)![0] as PageTranslationCoordinator;

  it("identifies the live document without waiting for its pending background registration", () => {
    f.send.mockReturnValueOnce(new Promise(() => {}));
    installFrameRuntime("document", { top: true });
    const receive = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
    const respond = vi.fn();
    receive({ type: "FRAME_IDENTIFY" }, {}, respond);
    expect(respond).toHaveBeenCalledWith({ ok: true, data: { documentKey: "document", sessionId: undefined,
      state: { active: false, documentHidden: false } } });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("identifies an activated embedded document with its current generation and failure", async () => {
    const runtime = installFrameRuntime("embedded", { top: false });
    f.start.mockRejectedValueOnce(new Error("Document initialization failed"));
    await expect(runtime.apply(snapshot(2, true))).rejects.toThrow("Document initialization failed");
    expect(runtime.identify()).toMatchObject({ documentKey: "embedded", sessionId: "session-2",
      state: { error: "Document initialization failed" } });
  });

  it("clears pending activity after registration fails and permits a later retry", async () => {
    f.send.mockRejectedValueOnce(new Error("Background unavailable"));
    installFrameRuntime("document", { top: true });
    f.send.mockRejectedValueOnce(new Error("Background unavailable"));
    f.send.mockRejectedValueOnce(new Error("Background unavailable"));
    await expect(controls().start(DEFAULT_SETTINGS, true)).rejects.toThrow("Background unavailable");
    expect(controls().state().active).toBe(false);
    await controls().start(DEFAULT_SETTINGS, true);
    expect(controls().state().active).toBe(true);
  });

  it("does not send an obsolete stop after registration and a newer start", async () => {
    const registration = deferred<FrameSessionSnapshot>();
    f.send.mockImplementationOnce(() => registration.promise);
    installFrameRuntime("document", { top: true });
    const first = controls().start(DEFAULT_SETTINGS, true);
    const stopping = controls().stop();
    const latest = controls().start(DEFAULT_SETTINGS, true);
    registration.resolve(snapshot(1, false));
    expect(await first).toMatchObject({ cancelled: true });
    await stopping; await latest;
    expect(f.send.mock.calls.map(([request]) => request).filter(request => request.type === "FRAME_SESSION_ACTION"))
      .toEqual([{ type: "FRAME_SESSION_ACTION", action: "start", reuseResults: true }]);
  });

  it("does not revive work from a delayed route snapshot while stopping", async () => {
    const runtime = installFrameRuntime("document", { top: true });
    await Promise.resolve(); await Promise.resolve();
    await runtime.apply(snapshot(2, true));
    expect(f.local.active).toBe(true);
    const ack = deferred<FrameSessionSnapshot>();
    f.send.mockImplementationOnce(() => ack.promise);
    const stopping = controls().stop();
    await Promise.resolve();
    await runtime.apply(snapshot(3, true));
    expect(f.local.active).toBe(false);
    expect(f.start).toHaveBeenCalledTimes(1);
    ack.resolve(snapshot(4, false)); await stopping;
    expect(controls().state().active).toBe(false);
  });

  it("marks a superseded start as cancelled instead of a successful empty result", async () => {
    installFrameRuntime("document", { top: true });
    await Promise.resolve(); await Promise.resolve();
    const reply = deferred<FrameSessionSnapshot>();
    f.send.mockImplementationOnce(() => reply.promise);
    const starting = controls().start(DEFAULT_SETTINGS, true);
    await Promise.resolve(); await Promise.resolve();
    const stopping = controls().stop();
    reply.resolve(snapshot(2, true));
    expect(await starting).toMatchObject({ cancelled: true, translated: 0 });
    await stopping;
  });
  it("retains initialization errors in delayed reports and clears them when stopped", async () => {
    const runtime = installFrameRuntime("document", { top: false });
    f.start.mockRejectedValueOnce(new Error("Document initialization failed"));
    await expect(runtime.apply(snapshot(2, true))).rejects.toThrow("Document initialization failed");
    await vi.advanceTimersByTimeAsync(60);
    expect(f.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "FRAME_REPORT", state: expect.objectContaining({ error: "Document initialization failed" }) }));
    const stopped = await runtime.apply(snapshot(3, false));
    expect(stopped).not.toHaveProperty("error");
    await vi.advanceTimersByTimeAsync(60);
    const reports = f.send.mock.calls.map(([request]) => request as RuntimeRequest).filter(request => request.type === "FRAME_REPORT");
    expect(reports.at(-1)).toMatchObject({ type: "FRAME_REPORT", sessionId: "session-3", state: { active: false } });
  });
  it("does not let a late initialization failure overwrite a newer session", async () => {
    const runtime = installFrameRuntime("document", { top: false });
    let reject!: (error: Error) => void;
    f.start.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const old = runtime.apply(snapshot(2, true));
    await runtime.apply(snapshot(3, true));
    const rejected = expect(old).rejects.toThrow("Old initialization failed");
    reject(new Error("Old initialization failed")); await rejected;
    await vi.advanceTimersByTimeAsync(60);
    const report = f.send.mock.calls.at(-1)![0];
    expect(report).toMatchObject({ type: "FRAME_REPORT", sessionId: "session-3", state: { active: true } });
    expect(report.state).not.toHaveProperty("error");
  });
});
