import { t } from "./i18n";
import type { TranslationDisplayMode } from "./types";

export const TRANSLATION_DISPLAY_MODES: ReadonlyArray<{
  value: TranslationDisplayMode;
  label: string;
  description: string;
}> = [
  {
    value: "replace",
    get label() { return t("replaceDisplayMode"); },
    get description() { return t("hideTheOriginalAndShowOnlyTheTranslation"); }
  },
  {
    value: "bilingual",
    get label() { return t("originalColors"); },
    get description() { return t("showTheTranslationBelowTheOriginalInThe"); }
  },
  {
    value: "bilingual-accent",
    get label() { return t("twoColorBilingual"); },
    get description() { return t("showTheTranslationBelowTheOriginalInA"); }
  }
];
