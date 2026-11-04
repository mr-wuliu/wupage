import type { ExtensionSettings, RuntimeRequest } from "../shared/types";
import type { FrameDocumentIdentity, FrameSessionSnapshot } from "../shared/frame-session";
import { emptyDocumentState } from "../shared/frame-session";
import {
  clearPageTranslation, configurePageTranslationCoordinator, getLocalPageTranslationState, hideLocalPageTranslation,
  notifyCoordinatedPageState, setLocalPageTranslationDisplayMode, setPageRequestIdentity,
  startLocalPageTranslation, subscribePageTranslationState
} from "./page-translation";
import type { PageTranslationCoordinator } from "./page-translation";
import { sendRuntimeRequest } from "./runtime";
import { sampleDocumentText } from "./frame-sample";
import { hasPageTranslations } from "./dom";
import { frameIsRendered } from "./frame-visibility";
import { configureElementExclusions } from "./element-exclusions";

export function installFrameRuntime(documentKey: string, options: { top: boolean }) {
  let snapshot: FrameSessionSnapshot | undefined;
  let appliedId: string | undefined;
  let appliedRevision = -1;
  let reportTimer: ReturnType<typeof setTimeout> | undefined;
  let lastReport = "";
  let intent = 0;
  let initial!: Promise<unknown>;
  let registered = false;
  let desiredActive: boolean | undefined;
  let resumeAfterRestore = false;
  let applyError: string | undefined;
  let applyVersion = 0;
  const documentState = () => ({ ...getLocalPageTranslationState(), ...(applyError ? { error: applyError } : {}), documentHidden: !frameIsRendered() });
  // This must stay synchronous: the background may be rebuilding its registry
  // while a document is itself waiting for a runtime request to finish.
  const identify = (): FrameDocumentIdentity => ({ documentKey, sessionId: appliedId, state: documentState() });
  const updateSnapshot = (value: FrameSessionSnapshot) => {
    if (options.top && value.topDocument && value.topDocument !== documentKey) return;
    if (!snapshot || value.revision >= snapshot.revision) { snapshot = value; if (options.top) notifyCoordinatedPageState(); }
  };
  const report = () => {
    if (reportTimer || !appliedId) return;
    reportTimer = setTimeout(() => {
      reportTimer = undefined;
      const state = documentState();
      const signature = JSON.stringify([appliedId, state]);
      if (signature === lastReport) return;
      lastReport = signature;
      void sendRuntimeRequest({ type: "FRAME_REPORT", documentKey, sessionId: appliedId!, state }).catch(() => { lastReport = ""; });
    }, 60);
  };
  subscribePageTranslationState(report);

  async function apply(value: FrameSessionSnapshot, allowed = true, reuseResults = true) {
    if (value.revision < appliedRevision) return documentState();
    appliedRevision = value.revision;
    updateSnapshot(value);
    if (configureElementExclusions(value.settings.elementExclusions)) clearPageTranslation();
    // An earlier route update can reach this document after a local stop.
    // Wait for that stop's acknowledgement instead of reviving its old work.
    if (desiredActive === false && value.active) return documentState();
    if (!allowed || !value.active) {
      appliedId = value.id;
      applyVersion++;
      applyError = undefined;
      if (getLocalPageTranslationState().active || hasPageTranslations()) hideLocalPageTranslation(false);
      setPageRequestIdentity(undefined); report();
      return documentState();
    }
    if (appliedId === value.id && getLocalPageTranslationState().active) {
      setLocalPageTranslationDisplayMode(value.settings.translationDisplayMode); report(); return documentState();
    }
    appliedId = value.id;
    const version = ++applyVersion;
    applyError = undefined;
    setPageRequestIdentity({ id: value.id, documentKey });
    try {
      await startLocalPageTranslation(value.settings, reuseResults);
    } catch (error) {
      if (version === applyVersion) {
        applyError = error instanceof Error ? error.message : String(error);
        report();
      }
      throw error;
    }
    report(); return documentState();
  }

  async function register() {
    const value = await sendRuntimeRequest<FrameSessionSnapshot>({ type: "FRAME_REGISTER", documentKey, url: location.href });
    if (!value || typeof value.id !== "string") return;
    registered = true;
    updateSnapshot(value);
    const diagnostic = value.frames.find(frame => frame.frameId === (options.top ? 0 : -1));
    if (options.top) await apply(value, diagnostic?.status !== "excluded");
  }

  if (options.top) {
    const controls: PageTranslationCoordinator = {
      state: () => {
        const state = snapshot?.state ?? getLocalPageTranslationState();
        return desiredActive === undefined ? state : { ...state, active: desiredActive };
      },
      start: async (_settings: ExtensionSettings, reuseResults: boolean) => {
        const version = ++intent;
        desiredActive = true;
        if (snapshot) { snapshot = { ...snapshot, active: true, state: { ...snapshot.state, active: true } }; notifyCoordinatedPageState(); }
        try {
          await initial;
          if (!registered) await register();
          if (version !== intent) return { ...emptyDocumentState(), cancelled: true };
          const value = await sendRuntimeRequest<FrameSessionSnapshot>({ type: "FRAME_SESSION_ACTION", action: "start", reuseResults });
          if (version !== intent) return { ...emptyDocumentState(), cancelled: true };
          desiredActive = undefined; updateSnapshot(value); notifyCoordinatedPageState();
          return value.active ? value.state : { ...value.state, cancelled: true };
        } catch (error) {
          if (version === intent) {
            desiredActive = undefined;
            const value = await sendRuntimeRequest<FrameSessionSnapshot>({ type: "FRAME_SESSION_GET" }).catch(() => undefined);
            if (value) updateSnapshot(value);
            else if (snapshot) snapshot = { ...snapshot, active: false, state: emptyDocumentState() };
            notifyCoordinatedPageState();
          }
          throw error;
        }
      },
      stop: () => {
        const version = ++intent;
        desiredActive = false;
        hideLocalPageTranslation();
        if (snapshot) { snapshot = { ...snapshot, active: false, state: emptyDocumentState() }; notifyCoordinatedPageState(); }
        return initial.then(() => version === intent
          ? sendRuntimeRequest<FrameSessionSnapshot>({ type: "FRAME_SESSION_ACTION", action: "stop" }) : undefined).then(value => {
          if (!value || version !== intent) return;
          desiredActive = undefined; updateSnapshot(value); notifyCoordinatedPageState();
        }).catch(() => {});
      },
      display: mode => {
        setLocalPageTranslationDisplayMode(mode);
        void initial.then(() => sendRuntimeRequest({ type: "FRAME_SESSION_MODE", mode })).catch(() => {});
      }
    };
    configurePageTranslationCoordinator(controls);
    chrome.runtime.onMessage.addListener((request: RuntimeRequest, _sender, respond) => {
      if (request.type === "FRAME_IDENTIFY") { respond({ ok: true, data: identify() }); return; }
      if (request.type === "FRAME_SNAPSHOT") { updateSnapshot(request.snapshot); respond({ ok: true }); return; }
      if (request.type === "FRAME_SAMPLE") { respond({ ok: true, data: sampleDocumentText() }); return; }
      if (request.type !== "FRAME_APPLY" || request.documentKey !== documentKey) return;
      void apply(request.snapshot, request.allowed, request.reuseResults).then(data => respond({ ok: true, data }),
        error => respond({ ok: false, error: String(error) }));
      return true;
    });
    initial = register().catch(() => {});
    window.addEventListener("pageshow", event => {
      if (!event.persisted) return;
      const version = ++intent;
      desiredActive = resumeAfterRestore ? true : undefined;
      appliedRevision = -1; snapshot = undefined; registered = false; initial = register().catch(() => {});
      if (resumeAfterRestore) void initial.then(() => {
        if (version !== intent) return;
        if (snapshot) return controls.start(snapshot.settings, true);
        desiredActive = false; notifyCoordinatedPageState();
      }).catch(() => {});
    });
  }
  window.addEventListener("pagehide", () => {
    if (options.top) resumeAfterRestore = desiredActive ?? snapshot?.state.active ?? getLocalPageTranslationState().active;
    hideLocalPageTranslation(false);
    void sendRuntimeRequest({ type: "FRAME_LEAVE", documentKey }).catch(() => {});
  });
  return { apply, updateSnapshot, identify };
}
