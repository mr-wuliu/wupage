export const TRANSLATION_ENDPOINTS = {
  googleWebHtml: "https://translate-pa.googleapis.com/v1/translateHtml",
  googleWebDictionary: "https://clients5.google.com/translate_a/t",
  googleCloud: "https://translation.googleapis.com/language/translate/v2",
  microsoftWeb: "https://edge.microsoft.com/translate/translatetext",
  tencentWeb: "https://transmart.qq.com/api/imt",
  yandexWeb: "https://translate.yandex.net/api/v1/tr.json/translate",
  yandexCloud: "https://translate.api.cloud.yandex.net/translate/v2/translate",
  volcengineWeb: "https://translate.volcengine.com/crx/translate/v1",
  volcengineCloud: "https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01",
  myMemoryWeb: "https://api.mymemory.translated.net/get",
  myMemoryApi: "https://translated-mymemory---translation-memory.p.rapidapi.com/api/get"
} as const;
