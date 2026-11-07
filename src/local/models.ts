import { t } from "../shared/i18n";
import catalog from "./catalog.json";

export interface ModelFile {
  role: string;
  name: string;
  bytes: number;
  sha256: string;
  url: string;
}

export interface LocalModel {
  id: string;
  from: string;
  to: string;
  label: string;
  version: string;
  files: ModelFile[];
}

// Pinned Mozilla Remote Settings records. No registry request is needed at runtime.
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
export const LOCAL_MODELS: LocalModel[] = catalog.map(model => ({
  ...model,
  get label() {
    return t("interfaceLanguage") === "en"
      ? `${languageNames.of(model.from)} → ${languageNames.of(model.to)}` : model.label;
  }
}));
export const LOCAL_MODEL_CACHE = "wupage.bergamot.models.v1";

export interface LocalModelState {
  id: string;
  state: "missing" | "partial" | "ready" | "downloading" | "error";
  downloaded: number;
  total: number;
  error?: string;
}

export interface LocalModelStatus {
  models: LocalModelState[];
  downloading?: string;
}

export function modelBytes(model: LocalModel): number {
  return model.files.reduce((sum, file) => sum + file.bytes, 0);
}

export function getLocalModel(id: string): LocalModel {
  const model = LOCAL_MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error(t("localLanguageModelNotFound"));
  return model;
}

export function normalizeLocalLanguage(language: string): string {
  const normalized = language.toLowerCase().replaceAll("_", "-");
  if (["zh", "zh-cn", "zh-sg", "zh-hans", "zh-hans-cn"].includes(normalized)) return "zh-Hans";
  if (normalized.startsWith("zh")) return normalized;
  return normalized.split("-")[0];
}

export function getLocalRoute(source: string, target: string): LocalModel[] {
  const from = normalizeLocalLanguage(source);
  const to = normalizeLocalLanguage(target);
  const supported = new Set(LOCAL_MODELS.flatMap((model) => [model.from, model.to]));
  if (!supported.has(from) || !supported.has(to)) {
    throw new Error(t("theExperimentalLocalServiceSupportsEnglishSimplifiedChinese"));
  }
  if (from === to) return [];
  const direct = LOCAL_MODELS.find((model) => model.from === from && model.to === to);
  if (direct) return [direct];
  return [getLocalModel(`${from}-en`), getLocalModel(`en-${to}`)];
}
