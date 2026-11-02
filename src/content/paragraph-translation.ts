import type { ExtensionSettings, TranslateBatchResponse } from "../shared/types";
import {
  clearTranslationsIn, collectParagraphTextSegments, hasTranslationsIn, invalidateStaleSegments,
  renderTranslationPlaceholders, renderTranslations
} from "./dom";
import { clearPageTranslation, getPageTranslationDisplayMode } from "./page-translation";
import { sendRuntimeRequest } from "./runtime";
import { buildTranslationContext } from "./translation-context";
import { documentTranslationRevision } from "./translation-lifecycle";
import { configureElementExclusions } from "./element-exclusions";

const pending = new WeakMap<Element, object>();

/** All paragraph entry points share rendering, deduplication, and restoration. */
export async function translateParagraph(target: Element, action: "toggle" | "translate" | "restore" = "toggle"): Promise<void> {
  if (!target.isConnected) throw new Error("该段落已发生变化，请重新右键选择。");
  if (action === "restore" || (action === "toggle" && hasTranslationsIn(target))) {
    pending.delete(target);
    clearTranslationsIn(target);
    return;
  }
  if (pending.has(target) || hasTranslationsIn(target)) return;
  const task = {};
  let revision = documentTranslationRevision();
  pending.set(target, task);
  try {
    const settings = await sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" });
    if (pending.get(target) !== task || revision !== documentTranslationRevision() || !target.isConnected) return;
    if (configureElementExclusions(settings.elementExclusions)) { clearPageTranslation(); revision = documentTranslationRevision(); }
    if (!target.isConnected) return;
    const segments = collectParagraphTextSegments(target, settings.translateCodeComments);
    if (!segments.length) throw new Error("此处没有可翻译的段落。");
    renderTranslationPlaceholders(segments);
    const data = await sendRuntimeRequest<TranslateBatchResponse>({
      type: "TRANSLATE_BATCH", texts: segments.map(segment => segment.text), preservePlaceholders: true,
      context: buildTranslationContext([target]), sourceLang: settings.sourceLang,
      targetLang: settings.targetLang, providerId: settings.activeProviderId
    });
    if (pending.get(target) !== task || revision !== documentTranslationRevision() || !target.isConnected) return;
    const stale = new Set(invalidateStaleSegments());
    renderTranslations(segments.map((segment, index) => ({ id: segment.id, text: data.translations[index] }))
      .filter(segment => !stale.has(segment.id)), getPageTranslationDisplayMode(settings.translationDisplayMode));
  } catch (error) {
    if (pending.get(target) !== task) return;
    clearTranslationsIn(target);
    throw error;
  } finally {
    if (pending.get(target) === task) pending.delete(target);
  }
}
