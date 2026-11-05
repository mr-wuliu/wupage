import { anySignal } from "../shared/abort";
import type { ExtensionSettings, RuntimeRequest, RuntimeResponse, TranslateBatchRequest } from "../shared/types";
import {
  aggregateDocumentStates, emptyDocumentState, frameExclusion, frameTranslationIdentity,
  type DocumentTranslationState, type FrameDiagnostic, type FrameDocumentIdentity, type FrameSessionRequest, type FrameSessionSnapshot
} from "../shared/frame-session";
import { getSettings } from "../shared/settings";
import { SETTINGS_KEY } from "../shared/defaults";
import { ProviderError } from "../shared/errors";
import { elementExclusionIdentity } from "../shared/element-exclusions";

const PREFIX = "wupage.frame-session.";
class FrameConnectionError extends Error {}
interface Frame extends FrameDiagnostic { documentKey: string; documentId?: string }
interface TabSession {
  id: string; revision: number; topDocument: string; topUrl: string;
  active: boolean; settings: ExtensionSettings;
  frames: Map<number, Frame>; controller: AbortController;
  queue: Array<{ frameId: number; run: () => void; reject: (error: Error) => void }>;
  running: number; lastFrame: number;
  controlVersion: number;
  settingsRevision: number;
  documents: Map<number, AbortController>;
  retired: boolean;
  paused?: { message: string; errorCode: string; retryAt?: number; identity: string };
}

/** Browser-supplied sender identity is authoritative; payload frame IDs are never accepted. */
export class FrameSessionManager {
  private tabs = new Map<number, Promise<TabSession>>();
  private publishTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private writes = new Map<number, Promise<unknown>>();
  constructor(private api: typeof chrome = chrome, private readSettings = getSettings) {}

  install(): void {
    this.api.tabs?.onRemoved?.addListener(tabId => { void this.remove(tabId); });
    this.api.webNavigation?.onCommitted?.addListener(details => {
      if (details.frameId === 0) {
        const old = this.tabs.get(details.tabId);
        this.tabs.delete(details.tabId);
        void old?.then(tab => { tab.retired = true; tab.controller.abort(); });
        clearTimeout(this.publishTimers.get(details.tabId)); this.publishTimers.delete(details.tabId);
        void this.persist(details.tabId, null);
        return;
      }
      if (!this.tabs.has(details.tabId)) return;
      void this.tabs.get(details.tabId)!.then(tab => {
        const old = tab.frames.get(details.frameId);
        if (old && (!details.documentId || old.documentId !== details.documentId)) {
          this.removeBranch(tab, details.frameId);
        }
        this.publish(details.tabId, tab);
      });
    });
    this.api.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !changes[SETTINGS_KEY]?.newValue) return;
      const settings = changes[SETTINGS_KEY].newValue as ExtensionSettings;
      for (const [id, pending] of this.tabs) void pending.then(tab => this.updateSettings(id, tab, settings));
    });
    const routeChanged = (details: { tabId: number; frameId: number; url: string }) => {
      const pending = this.tabs.get(details.tabId);
      if (!pending) return;
      void pending.then(tab => {
        const frame = tab.frames.get(details.frameId);
        if (frame) frame.url = details.url;
        if (details.frameId === 0) tab.topUrl = details.url;
        tab.revision++; void this.applyAll(details.tabId, tab, true); this.publish(details.tabId, tab);
      });
    };
    this.api.webNavigation?.onHistoryStateUpdated?.addListener(routeChanged);
    this.api.webNavigation?.onReferenceFragmentUpdated?.addListener(routeChanged);
  }

  async handle(request: FrameSessionRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
    const tabId = sender.tab?.id;
    if (tabId === undefined || sender.frameId === undefined) throw new Error("需要有效的网页文档。");
    const tab = await this.get(tabId);
    if (tab.retired) throw new Error("网页文档已经更新。");
    const frameId = sender.frameId;
    if (request.type === "FRAME_REGISTER") {
      const metadata = await this.api.webNavigation?.getFrame({ tabId, frameId }).catch(() => undefined);
      if (metadata?.documentId && sender.documentId && metadata.documentId !== sender.documentId) throw new Error("网页文档已经更新。");
      if (frameId === 0 && tab.topDocument && tab.topDocument !== request.documentKey) {
        this.reset(tab); await this.applyAll(tabId, tab, true);
      }
      if (frameId === 0) { tab.topDocument = request.documentKey; tab.topUrl = sender.url ?? request.url; }
      const previous = tab.frames.get(frameId);
      if (!previous || previous.documentKey !== request.documentKey) {
        tab.documents.get(frameId)?.abort(); tab.documents.delete(frameId);
        tab.frames.set(frameId, { frameId, documentKey: request.documentKey, documentId: sender.documentId,
          parentFrameId: metadata?.parentFrameId,
          url: this.documentUrl(sender.url ?? request.url), status: "ready" });
        await this.loadAncestors(tabId, tab, tab.frames.get(frameId)!);
      }
      if (typeof request.documentHidden === "boolean") {
        const frame = tab.frames.get(frameId)!;
        this.updateFrameState(frame, { ...(frame.state ?? emptyDocumentState()), documentHidden: request.documentHidden });
      }
      await this.persist(tabId, tab); this.publish(tabId, tab);
      return { ...this.snapshot(tab), selfFrameId: frameId };
    }
    if (request.type === "FRAME_LEAVE") {
      if (tab.frames.get(frameId)?.documentKey === request.documentKey) {
        this.removeBranch(tab, frameId);
      }
      this.publish(tabId, tab); return null;
    }
    if (request.type === "FRAME_REPORT") {
      if (request.sessionId !== tab.id) return null;
      let frame = tab.frames.get(frameId);
      // A report also re-registers a live document after an event-page/SW restart.
      if (!frame || !frame.documentKey) {
        const metadata = await this.api.webNavigation?.getFrame({ tabId, frameId }).catch(() => undefined);
        if (metadata?.documentId && metadata.documentId !== sender.documentId) return null;
        frame = { frameId, documentKey: request.documentKey, documentId: sender.documentId,
          parentFrameId: metadata?.parentFrameId, url: this.documentUrl(sender.url ?? ""), status: "ready" };
        tab.frames.set(frameId, frame);
        await this.loadAncestors(tabId, tab, frame);
      }
      if (frame.documentKey !== request.documentKey || this.exclusion(tab, frame)) return null;
      this.updateFrameState(frame, request.state);
      this.publish(tabId, tab); return null;
    }
    if (request.type === "FRAME_SESSION_GET") return this.snapshot(tab);
    if (request.type === "FRAME_SESSION_SAMPLES") {
      const samples = await Promise.all([...tab.frames.values()].filter(frame => frame.frameId !== 0
        && !this.exclusion(tab, frame))
        .map(frame => this.send(tabId, frame, { type: "FRAME_SAMPLE" }, 1500).then(value => typeof value === "string" ? value : "").catch(() => "")));
      return samples.filter(Boolean);
    }
    if (request.type === "FRAME_FORWARD_SHORTCUT") {
      return this.api.tabs.sendMessage(tabId, { type: "EXECUTE_TRANSLATION_SHORTCUT", command: request.command }, { frameId: 0 });
    }
    if (request.type === "FRAME_SESSION_ACTION") {
      const version = ++tab.controlVersion;
      if (request.action === "start") {
        if (!tab.frames.get(0)?.documentKey) throw new Error("无法连接当前网页，请刷新页面后重试。");
        const settingsRevision = tab.settingsRevision;
        const settings = await this.readSettings();
        if (version !== tab.controlVersion) return this.snapshot(tab);
        if (settingsRevision === tab.settingsRevision) tab.settings = settings;
        this.resetGeneration(tab); tab.active = true;
      } else { this.resetGeneration(tab); tab.active = false; }
      tab.revision++;
      await this.persist(tabId, tab);
      const applying = this.applyAll(tabId, tab, request.reuseResults !== false);
      this.publish(tabId, tab);
      await applying;
      return this.snapshot(tab);
    }
    if (request.type === "FRAME_SESSION_MODE") {
      tab.settingsRevision++;
      tab.settings = { ...tab.settings, translationDisplayMode: request.mode }; tab.revision++;
      await this.applyAll(tabId, tab, true); this.publish(tabId, tab); return null;
    }
    throw new Error("不支持的框架会话操作。");
  }

  async translate<T>(request: TranslateBatchRequest, sender: chrome.runtime.MessageSender,
    run: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    if (!request.pageSession) return run();
    const tabId = sender.tab?.id;
    if (tabId === undefined || sender.frameId === undefined) throw new Error("翻译文档已经失效。");
    const tab = await this.get(tabId);
    if (tab.retired) throw new Error("网页文档已经更新。");
    if (tab.paused) throw new ProviderError(tab.paused.message, tab.paused.errorCode,
      tab.paused.retryAt === undefined ? undefined : Math.max(0, tab.paused.retryAt - Date.now()));
    let frame = tab.frames.get(sender.frameId);
    if ((!frame || !frame.documentKey) && tab.active && tab.id === request.pageSession.id) {
      const current = await this.api.webNavigation?.getFrame({ tabId, frameId: sender.frameId }).catch(() => undefined);
      if (!current?.documentId || current.documentId === sender.documentId) {
        frame = { frameId: sender.frameId, documentId: sender.documentId, documentKey: request.pageSession.documentKey,
          parentFrameId: current?.parentFrameId, url: this.documentUrl(sender.url ?? ""), status: "ready" };
        tab.frames.set(sender.frameId, frame);
        await this.loadAncestors(tabId, tab, frame);
      }
    }
    if (!tab.active || tab.id !== request.pageSession.id || !frame
      || frame.documentKey !== request.pageSession.documentKey
      || frame.documentId && sender.documentId && frame.documentId !== sender.documentId
      || this.exclusion(tab, frame)) throw new Error("翻译会话已经停止。");
    let documentController = tab.documents.get(frame.frameId);
    if (!documentController) { documentController = new AbortController(); tab.documents.set(frame.frameId, documentController); }
    const signal = anySignal([tab.controller.signal, documentController.signal]);
    signal.throwIfAborted();
    const generation = tab.id;
    const frameId = sender.frameId;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { tab.queue = tab.queue.filter(item => item !== entry); reject(new Error("翻译会话已经停止。")); };
      const entry = { frameId, reject, run: () => { signal.removeEventListener("abort", abort); resolve(); } };
      signal.addEventListener("abort", abort, { once: true });
      tab.queue.push(entry); this.pump(tab);
    });
    try { signal.throwIfAborted(); return await run(signal); }
    catch (error) {
      if (!signal.aborted && tab.id === generation && error instanceof ProviderError
        && ["login-required", "rate-limited", "service-rejected", "permission-required", "protocol-changed", "service-unavailable"].includes(error.errorCode)) {
        await this.pauseProvider(tab, error);
      }
      throw error;
    }
    finally { tab.running--; this.pump(tab); }
  }

  async diagnostics(tabId: number): Promise<FrameDiagnostic[]> {
    const tab = await this.get(tabId);
    try {
      const current = await this.api.webNavigation?.getAllFrames({ tabId });
      if (current) {
        const ids = new Set(current.map(frame => frame.frameId));
        for (const id of tab.frames.keys()) if (!ids.has(id)) tab.frames.delete(id);
        for (const frame of current) if (!tab.frames.has(frame.frameId)) tab.frames.set(frame.frameId, {
          frameId: frame.frameId, documentKey: "", url: frame.url,
          status: "unavailable", reason: "文档尚未接入，或浏览器不允许访问"
        });
      }
    } catch { /* Restricted documents are reported without failing the parent. */ }
    return this.snapshot(tab).frames;
  }

  private async get(tabId: number): Promise<TabSession> {
    let value = this.tabs.get(tabId);
    if (!value) {
      value = (async () => {
        await this.writes.get(tabId)?.catch(() => {});
        // Session persistence is an optimization. Browser startup/quota errors
        // must not disable live translation in every document of this tab.
        const [settings, saved] = await Promise.all([this.readSettings(),
          this.api.storage?.session?.get(`${PREFIX}${tabId}`).catch(() => undefined)]);
        const stored = saved?.[`${PREFIX}${tabId}`] as Partial<Pick<TabSession, "id" | "revision" | "topDocument" | "topUrl" | "active" | "paused">> | undefined;
        const tab: TabSession = { id: stored?.id ?? crypto.randomUUID(), revision: Math.max(Date.now() * 1000, stored?.revision ?? 0),
          topDocument: stored?.topDocument ?? "", topUrl: stored?.topUrl ?? "",
          active: stored?.active === true,
          paused: stored?.paused?.identity === this.providerIdentity(settings) ? stored.paused : undefined,
          settings, frames: new Map<number, Frame>(), documents: new Map<number, AbortController>(),
          controller: new AbortController(), queue: [], running: 0, lastFrame: -1, controlVersion: 0, settingsRevision: 0, retired: false };
        await this.restoreFrames(tabId, tab);
        if (this.tabs.get(tabId) !== value) { tab.retired = true; tab.controller.abort(); }
        return tab;
      })();
      this.tabs.set(tabId, value);
      // Do not retain a rejected settings read forever. The next user action
      // must be able to recover after storage becomes available again.
      void value.catch(() => { if (this.tabs.get(tabId) === value) this.tabs.delete(tabId); });
    }
    return value;
  }
  private async restoreFrames(tabId: number, tab: TabSession): Promise<void> {
    // Content scripts outlive an idle MV3 worker and do not register again just
    // because it restarted. Recover identities from the browser's live frame
    // tree before serving any control/state request; an empty registry is not
    // evidence that the page has no translatable content.
    const current = await this.api.webNavigation?.getAllFrames?.({ tabId }).catch(() => undefined);
    if (!current) return;
    const documents = await Promise.all(current.map(async metadata => {
      const frame: Frame = { frameId: metadata.frameId, parentFrameId: metadata.parentFrameId,
        documentId: metadata.documentId, documentKey: "", url: this.documentUrl(metadata.url),
        status: "unavailable", reason: "文档尚未接入，或浏览器不允许访问" };
      try {
        const identity = await this.send(tabId, frame, { type: "FRAME_IDENTIFY" }, 1500) as FrameDocumentIdentity | undefined;
        if (identity?.documentKey && typeof identity.documentKey === "string") {
          // Navigation can overtake the probe. Never bind an old document's key
          // or state to a new document that happens to have the same frame ID.
          if (metadata.documentId && this.api.webNavigation?.getFrame) {
            const latest = await this.api.webNavigation.getFrame({ tabId, frameId: frame.frameId }).catch(() => null);
            if (!latest || latest.documentId !== metadata.documentId) return { frame };
          }
          frame.documentKey = identity.documentKey; frame.status = "ready"; frame.reason = undefined;
          return { frame, identity };
        }
      } catch { /* Restricted or not-yet-injected documents can register later. */ }
      return { frame };
    }));
    for (const { frame } of documents) tab.frames.set(frame.frameId, frame);
    const top = tab.frames.get(0);
    if (top?.documentKey) {
      if (tab.topDocument && tab.topDocument !== top.documentKey) this.reset(tab);
      tab.topDocument = top.documentKey; tab.topUrl = top.url;
    }
    for (const { frame, identity } of documents) {
      if (identity?.sessionId === tab.id && identity.state) this.updateFrameState(frame, identity.state);
    }
  }
  private updateFrameState(frame: Frame, state: DocumentTranslationState): void {
    frame.state = state;
    frame.reason = state.documentHidden ? "等待嵌入页面显示" : undefined;
    frame.status = state.failed || state.error ? "failed" : state.documentHidden ? "waiting-viewport" : state.pending ? "translating"
      : state.remaining ? "waiting-viewport" : state.translated ? "ready" : "empty";
  }
  private resetGeneration(tab: TabSession): void {
    tab.controller.abort(); tab.controller = new AbortController(); tab.id = crypto.randomUUID();
    tab.paused = undefined;
    for (const frame of tab.frames.values()) {
      // Visibility belongs to the document, not to a translation generation.
      // Losing it turns dormant helper frames into apparently visible failures.
      frame.state = frame.state?.documentHidden === undefined ? undefined
        : { ...emptyDocumentState(), documentHidden: frame.state.documentHidden };
      if (frame.documentKey) frame.status = "ready";
    }
  }
  private providerIdentity(settings: ExtensionSettings): string {
    return JSON.stringify(settings.providers.find(provider => provider.id === settings.activeProviderId));
  }
  private async pauseProvider(source: TabSession, error: ProviderError): Promise<void> {
    const identity = this.providerIdentity(source.settings);
    const paused = { message: error.message, errorCode: error.errorCode, identity,
      ...(error.retryAfterMs === undefined ? {} : { retryAt: Date.now() + error.retryAfterMs }) };
    await Promise.all([...this.tabs].map(async ([tabId, pending]) => {
      const tab = await pending;
      if (!tab.active || tab.retired || this.providerIdentity(tab.settings) !== identity) return;
      tab.paused = paused; tab.controller.abort();
      await this.persist(tabId, tab).catch(() => {}); this.publish(tabId, tab);
    }));
  }
  private removeBranch(tab: TabSession, frameId: number): void {
    const removed = new Set([frameId]);
    let size = 0;
    while (size !== removed.size) {
      size = removed.size;
      for (const frame of tab.frames.values()) if (frame.parentFrameId !== undefined && removed.has(frame.parentFrameId)) removed.add(frame.frameId);
    }
    for (const id of removed) {
      tab.documents.get(id)?.abort(); tab.documents.delete(id); tab.frames.delete(id);
    }
  }
  private documentUrl(url: string): string {
    return url.startsWith("data:") ? `${url.slice(0, Math.min(url.indexOf(",") + 1 || 64, 64))}…` : url;
  }
  private async loadAncestors(tabId: number, tab: TabSession, frame: Frame): Promise<void> {
    const seen = new Set<number>([frame.frameId]);
    let parentId = frame.parentFrameId;
    while (parentId !== undefined && parentId >= 0 && !seen.has(parentId)) {
      seen.add(parentId);
      const existing = tab.frames.get(parentId);
      if (existing) { parentId = existing.parentFrameId; continue; }
      const parent = await this.api.webNavigation?.getFrame({ tabId, frameId: parentId }).catch(() => undefined);
      if (!parent) break;
      tab.frames.set(parentId, { frameId: parentId, parentFrameId: parent.parentFrameId, documentKey: "",
        documentId: parent.documentId, url: this.documentUrl(parent.url), status: "unavailable", reason: "等待文档接入" });
      if (parentId === 0 && !tab.topUrl) tab.topUrl = parent.url;
      parentId = parent.parentFrameId;
    }
  }
  private reset(tab: TabSession): void {
    this.resetGeneration(tab); tab.active = false; tab.revision++;
  }
  private snapshot(tab: TabSession): FrameSessionSnapshot {
    const frames = [...tab.frames.values()].map(({ documentKey: _key, documentId: _id, ...frame }): FrameDiagnostic => {
      const reason = this.exclusion(tab, frame);
      return reason ? { ...frame, status: "excluded", reason } : frame;
    });
    const state = aggregateDocumentStates(frames, tab.active);
    if (tab.paused) { state.error = tab.paused.message; state.errorCode = tab.paused.errorCode; state.retryAt = tab.paused.retryAt; }
    return { id: tab.id, revision: tab.revision, active: tab.active, topDocument: tab.topDocument,
      settings: tab.settings, frames, state };
  }
  private exclusion(tab: TabSession, frame: FrameDiagnostic): string | undefined {
    const chain: FrameDiagnostic[] = [];
    const seen = new Set<number>();
    let current: FrameDiagnostic | undefined = frame;
    while (current && !seen.has(current.frameId)) {
      chain.push(current); seen.add(current.frameId);
      current = current.parentFrameId !== undefined ? tab.frames.get(current.parentFrameId) : undefined;
    }
    for (let index = 0; index < chain.length; index++) {
      const ancestor = chain[index];
      const effectiveUrl = /^https?:/u.test(ancestor.url) ? ancestor.url
        : chain.slice(index + 1).find(item => /^https?:/u.test(item.url))?.url ?? tab.topUrl;
      const reason = frameExclusion(tab.settings, tab.topUrl, effectiveUrl, ancestor.frameId);
      if (reason) return index ? `上级嵌入页面已排除：${reason}` : reason;
    }
  }
  private send(tabId: number, frame: Frame, request: RuntimeRequest, timeout = 25000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("框架响应超时")), timeout);
      this.api.tabs.sendMessage(tabId, request, frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId })
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          // Only a rejected browser delivery is a connection failure. An error
          // envelope from a connected document is a real runtime/provider error.
          if (/receiving end does not exist|could not establish connection|message (?:port|channel) closed/iu.test(message)) {
            throw new FrameConnectionError(message);
          }
          throw error;
        })
        .then((response: RuntimeResponse) => {
          if (!response?.ok) throw new Error(response?.ok === false ? response.error : "框架没有响应");
          resolve(response.data);
        }).catch(reject).finally(() => clearTimeout(timer));
    });
  }
  private async applyFrame(tabId: number, tab: TabSession, frame: Frame,
    snapshot: FrameSessionSnapshot, allowed: boolean, reuseResults: boolean): Promise<DocumentTranslationState | undefined> {
    const request = { type: "FRAME_APPLY", documentKey: frame.documentKey, snapshot, allowed, reuseResults } as const;
    try { return await this.send(tabId, frame, request) as DocumentTranslationState; }
    catch (error) {
      if (!(error instanceof FrameConnectionError)) throw error;
      const current = () => !tab.retired && tab.id === snapshot.id && tab.frames.get(frame.frameId) === frame;
      if (!current()) return;
      const documents = await this.api.webNavigation?.getAllFrames?.({ tabId }).catch(() => undefined);
      if (!current()) return;
      if (documents) {
        const document = documents.find(document => document.frameId === frame.frameId);
        if (!document || frame.documentId && document.documentId && frame.documentId !== document.documentId) {
          if (frame.frameId === 0) throw error;
          // A removed/replaced document is no longer a translation target.
          this.removeBranch(tab, frame.frameId); return;
        }
      }
      const identity = await this.send(tabId, frame, { type: "FRAME_IDENTIFY" }, 1500)
        .catch(() => undefined) as FrameDocumentIdentity | undefined;
      if (!current()) return;
      if (identity?.documentKey === frame.documentKey) {
        // Recover a transient missing receiver once, after proving that this is
        // still the same document. Never retry an acknowledged translation error.
        return await this.send(tabId, frame, request) as DocumentTranslationState;
      }
      throw error;
    }
  }
  private async applyAll(tabId: number, tab: TabSession, reuseResults: boolean): Promise<void> {
    const snapshot = this.snapshot(tab);
    await Promise.all([...tab.frames.values()].filter(frame => frame.documentKey).map(async frame => {
      const allowed = !this.exclusion(tab, frame);
      frame.status = allowed ? "loading" : "excluded";
      frame.reason = undefined;
      try {
        const value = await this.applyFrame(tabId, tab, frame, snapshot, allowed, reuseResults);
        if (tab.id === snapshot.id && tab.frames.get(frame.frameId) === frame && value) {
          this.updateFrameState(frame, value);
        }
      } catch (error) {
        if (tab.id === snapshot.id && tab.frames.get(frame.frameId) === frame) {
          const connectionLost = error instanceof FrameConnectionError;
          const documentHidden = frame.state?.documentHidden;
          frame.status = connectionLost ? "unavailable" : "failed";
          frame.reason = error instanceof Error ? error.message : String(error);
          // Keep inaccessible hidden helpers in diagnostics. Actual visible
          // document and provider failures must still be reported to the user.
          const reportError = tab.active && allowed && !(connectionLost && frame.frameId !== 0 && documentHidden);
          const failure = connectionLost ? {
            error: frame.frameId === 0 ? "当前网页的翻译连接已中断。" : "嵌入页面的翻译连接已中断，可在 Debug 查看具体文档。",
            errorCode: frame.frameId === 0 ? "page-connection-lost" : "frame-connection-lost"
          } : { error: frame.reason };
          frame.state = { ...emptyDocumentState(), documentHidden,
            ...(reportError ? failure : {}) };
        }
      }
    }));
    this.publish(tabId, tab);
  }
  private publish(tabId: number, tab: TabSession): void {
    tab.revision++;
    if (this.publishTimers.has(tabId)) return;
    this.publishTimers.set(tabId, setTimeout(() => {
      this.publishTimers.delete(tabId);
      void this.tabs.get(tabId)?.then(current => {
        if (current !== tab) return;
        const top = tab.frames.get(0);
        return this.api.tabs.sendMessage(tabId, { type: "FRAME_SNAPSHOT", snapshot: this.snapshot(tab) },
          top?.documentId ? { documentId: top.documentId } : { frameId: 0 }).catch(() => {});
      });
    }, 40));
  }
  private async updateSettings(tabId: number, tab: TabSession, settings: ExtensionSettings): Promise<void> {
    tab.settingsRevision++;
    const changed = frameTranslationIdentity(tab.settings) !== frameTranslationIdentity(settings);
    const modeChanged = tab.settings.translationDisplayMode !== settings.translationDisplayMode;
    const exclusionsChanged = elementExclusionIdentity(tab.settings.elementExclusions) !== elementExclusionIdentity(settings.elementExclusions);
    if (exclusionsChanged) for (const frame of tab.frames.values()) {
      if (elementExclusionIdentity(tab.settings.elementExclusions, frame.url) === elementExclusionIdentity(settings.elementExclusions, frame.url)) continue;
      tab.documents.get(frame.frameId)?.abort(); tab.documents.delete(frame.frameId);
    }
    tab.settings = settings;
    if (changed && tab.active) this.resetGeneration(tab);
    if (changed || modeChanged || exclusionsChanged) {
      tab.revision++; await this.persist(tabId, tab); await this.applyAll(tabId, tab, !changed); this.publish(tabId, tab);
    }
  }
  private pump(tab: TabSession): void {
    while (tab.running < 2 && tab.queue.length) {
      let index = tab.queue.findIndex(item => item.frameId !== tab.lastFrame);
      if (index < 0) index = 0;
      const [entry] = tab.queue.splice(index, 1); tab.lastFrame = entry.frameId; tab.running++; entry.run();
    }
  }
  private persist(tabId: number, tab: TabSession | null): Promise<unknown> {
    const value = tab ? { id: tab.id, revision: tab.revision, topDocument: tab.topDocument, topUrl: tab.topUrl,
      active: tab.active, ...(tab.paused ? { paused: tab.paused } : {}) } : null;
    const write = (this.writes.get(tabId) ?? Promise.resolve()).catch(() => {}).then(() => tab?.retired ? undefined : value
      ? this.api.storage?.session?.set({ [`${PREFIX}${tabId}`]: value }) : this.api.storage?.session?.remove(`${PREFIX}${tabId}`));
    const persisted = write.catch(() => undefined);
    this.writes.set(tabId, persisted); return persisted;
  }
  private async remove(tabId: number): Promise<void> {
    const tab = await this.tabs.get(tabId); tab?.controller.abort(); this.tabs.delete(tabId);
    clearTimeout(this.publishTimers.get(tabId)); this.publishTimers.delete(tabId);
    await this.persist(tabId, null); this.writes.delete(tabId);
  }
}

export const frameSessions = new FrameSessionManager();
