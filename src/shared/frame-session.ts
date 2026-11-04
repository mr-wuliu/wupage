import type { ExtensionSettings, TranslationDisplayMode } from "./types";

export interface DocumentTranslationState {
  documentHidden?: boolean;
  active: boolean;
  translated: number;
  cached: number;
  failed: number;
  remaining: number;
  pending: number;
  error?: string;
  errorCode?: string;
  retryAt?: number;
}

export interface FrameTranslationSettings {
  enabled: boolean;
  /** URL glob, or `top-level URL glob => frame URL glob`. */
  excludeMatches: string[];
}

export type FrameStatus = "ready" | "loading" | "translating" | "waiting-viewport" | "empty" | "excluded" | "unavailable" | "failed";
export interface FrameDiagnostic {
  parentFrameId?: number;
  frameId: number;
  url: string;
  status: FrameStatus;
  reason?: string;
  state?: DocumentTranslationState;
}

export interface FrameSessionSnapshot {
  selfFrameId?: number;
  revision: number;
  id: string;
  active: boolean;
  topDocument: string;
  settings: ExtensionSettings;
  frames: FrameDiagnostic[];
  state: DocumentTranslationState;
}

export interface FrameDocumentIdentity {
  documentKey: string;
  sessionId?: string;
  state?: DocumentTranslationState;
}

export type FrameSessionRequest =
  | { type: "FRAME_IDENTIFY" }
  | { type: "FRAME_REGISTER"; documentKey: string; url: string }
  | { type: "FRAME_REPORT"; documentKey: string; sessionId: string; state: DocumentTranslationState }
  | { type: "FRAME_LEAVE"; documentKey: string }
  | { type: "FRAME_SESSION_GET" }
  | { type: "FRAME_SESSION_ACTION"; action: "start" | "stop"; settings?: ExtensionSettings; reuseResults?: boolean }
  | { type: "FRAME_SESSION_MODE"; mode: TranslationDisplayMode }
  | { type: "FRAME_SESSION_SAMPLES" }
  | { type: "FRAME_FORWARD_SHORTCUT"; command: import("./shortcuts").TranslationShortcut }
  | { type: "FRAME_APPLY"; documentKey: string; snapshot: FrameSessionSnapshot; allowed: boolean; reuseResults: boolean }
  | { type: "FRAME_SNAPSHOT"; snapshot: FrameSessionSnapshot }
  | { type: "FRAME_SAMPLE" };

export const emptyDocumentState = (): DocumentTranslationState => ({
  active: false, translated: 0, cached: 0, failed: 0, remaining: 0, pending: 0
});

/** randomUUID is unavailable in ordinary HTTP and opaque data documents. */
export function createDocumentKey(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, "0")).join("");
}

export function normalizeFrameTranslation(value: unknown): FrameTranslationSettings {
  const input = value && typeof value === "object" ? value as Partial<FrameTranslationSettings> : {};
  return {
    enabled: input.enabled !== false,
    excludeMatches: Array.isArray(input.excludeMatches)
      ? [...new Set(input.excludeMatches.filter((entry): entry is string => typeof entry === "string")
        .map(entry => entry.trim()).filter(Boolean))] : []
  };
}

function matchesGlob(url: string, pattern: string): boolean {
  if (pattern === "<all_urls>" || pattern === "*") return true;
  let normalized = pattern.includes("://") ? pattern : `*://${pattern}`;
  if (!normalized.slice(normalized.indexOf("://") + 3).includes("/")) normalized += "/*";
  const canonical = (value: string) => value.replace(/^[^/]+:\/\/[^/]+/u, origin => origin.toLowerCase());
  const source = canonical(url);
  const glob = canonical(normalized);
  // A literal/star matcher avoids regex backtracking on long imported rules.
  let position = 0, rule = 0, star = -1, retry = 0;
  while (position < source.length) {
    if (rule < glob.length && glob[rule] === source[position]) { rule++; position++; }
    else if (glob[rule] === "*") { star = rule++; retry = position; }
    else if (star >= 0) { rule = star + 1; position = ++retry; }
    else return false;
  }
  while (glob[rule] === "*") rule++;
  return rule === glob.length;
}

export function frameExclusion(settings: ExtensionSettings, topUrl: string, frameUrl: string, frameId: number): string | undefined {
  if (frameId === 0) return;
  const config = normalizeFrameTranslation(settings.frameTranslation);
  if (!config.enabled) return "已关闭嵌入页面翻译";
  const rule = config.excludeMatches.find(entry => {
    const parts = entry.split(/\s*=>\s*/u);
    return parts.length === 1 ? matchesGlob(frameUrl, parts[0])
      : parts.length === 2 && matchesGlob(topUrl, parts[0]) && matchesGlob(frameUrl, parts[1]);
  });
  return rule ? `排除规则：${rule}` : undefined;
}

/** Everything affecting translated source/results; presentation changes reuse results. */
export function frameTranslationIdentity(settings: ExtensionSettings): string {
  return JSON.stringify([settings.sourceLang, settings.targetLang, settings.activeProviderId,
    settings.providers.find(provider => provider.id === settings.activeProviderId), settings.translateCodeComments,
    normalizeFrameTranslation(settings.frameTranslation)]);
}

export function aggregateDocumentStates(frames: FrameDiagnostic[], active: boolean): DocumentTranslationState {
  const result = { ...emptyDocumentState(), active };
  for (const frame of frames) {
    if (frame.status === "excluded") continue;
    const state = frame.state;
    if (!state) continue;
    for (const key of ["translated", "cached", "failed", "remaining", "pending"] as const) result[key] += state[key];
    result.error ??= state.error;
    result.errorCode ??= state.errorCode;
    if (state.retryAt !== undefined) result.retryAt = Math.max(result.retryAt ?? 0, state.retryAt);
  }
  return result;
}
