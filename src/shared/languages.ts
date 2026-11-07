import { t } from "./i18n";
export const TARGET_LANGUAGES = [
  { code: "zh-CN", get label() { return t("chinese"); } },
  { code: "zh-TW", get label() { return t("traditionalChinese"); } },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "ru", label: "Русский" }
];

export const SOURCE_LANGUAGES = [
  { code: "auto", get label() { return t("detectLanguage"); } },
  ...TARGET_LANGUAGES
];
