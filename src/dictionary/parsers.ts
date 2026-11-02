import { dictionarySourceUrl, isChineseDictionaryQuery, isDictionaryAudioUrl, type DictionaryEntry, type DictionaryPronunciation } from "../shared/dictionary";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] { return Array.isArray(value) ? value : value ? [value] : []; }

// Some Youdao dictionaries return strings, others return annotated text fragments.
function text(value: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => text(item, depth + 1)).join("");
  const item = record(value);
  return text(item["#text"] ?? item.i ?? item.l, depth + 1);
}

export function parseYoudaoDictionary(payload: unknown, query: string): DictionaryEntry {
  const data = record(payload);
  if (!data.ec && !data.ce && !data.simple && !data.newhh && !data.input) throw new Error("有道词典返回了无法识别的数据，请稍后重试。");
  const ec = record(list(record(data.ec).word)[0]);
  const ce = record(list(record(data.ce).word)[0]);
  const simple = record(list(record(data.simple).word)[0]);
  const chinese = isChineseDictionaryQuery(query);
  if (chinese) {
    const dictionary = record(data.newhh);
    const groups = list(dictionary.dataList).slice(0, 30).map(record);
    const readings = [...new Set(groups.map(group => text(group.pinyin).trim()).filter(Boolean))];
    const meanings: DictionaryEntry["meanings"] = [];
    for (const group of groups) {
      for (const sense of list(group.sense).slice(0, 30).map(record)) {
        for (const value of list(sense.def)) {
          const definition = text(value).trim();
          if (!definition || meanings.length >= 30) continue;
          meanings.push({ partOfSpeech: text(sense.cat ?? group.cat), definition,
            ...(readings.length > 1 ? { pronunciation: text(group.pinyin).trim() } : {}) });
        }
      }
    }
    if (readings.length || meanings.length) {
      const phonetics = readings.length ? readings : [text(ce.phone ?? simple.phone).trim()].filter(Boolean);
      return {
        provider: "youdao", query, word: text(dictionary.word) || query, sourceUrl: dictionarySourceUrl("youdao", query),
        pronunciations: phonetics.map(phonetic => ({ accent: "pinyin", phonetic })), meanings
      };
    }
  }
  const wordData = Object.keys(ec).length ? ec : ce;
  const word = text(wordData["return-phrase"]) || text(simple["return-phrase"]) || query;
  const pronunciations: DictionaryPronunciation[] = [];
  for (const accent of ["uk", "us"] as const) {
    const phonetic = text(wordData[`${accent}phone`] ?? simple[`${accent}phone`]);
    const hasAudio = typeof (wordData[`${accent}speech`] ?? simple[`${accent}speech`]) === "string";
    const url = new URL("https://dict.youdao.com/dictvoice");
    url.searchParams.set("audio", word);
    url.searchParams.set("type", accent === "uk" ? "1" : "2");
    if (phonetic || hasAudio) pronunciations.push({ accent, phonetic, audioUrl: hasAudio ? url.href : undefined });
  }
  const phone = text(wordData.phone ?? simple.phone);
  if (!pronunciations.length && phone) pronunciations.push({ accent: chinese ? "pinyin" : "default", phonetic: phone });
  const meanings: DictionaryEntry["meanings"] = [];
  for (const group of list(wordData.trs).slice(0, 30)) {
    const item = record(group);
    if (typeof item.tran === "string") meanings.push({ partOfSpeech: text(item.pos), definition: item.tran });
    else for (const tr of list(item.tr)) {
      const definition = text(record(tr).l).trim();
      if (!definition) continue;
      const match = definition.match(/^([a-z]+(?:\s*&\s*[a-z]+)?\.)\s*/i);
      meanings.push({ partOfSpeech: match?.[1] ?? "", definition: match ? definition.slice(match[0].length) : definition });
    }
  }
  return { provider: "youdao", query, word, sourceUrl: dictionarySourceUrl("youdao", query), pronunciations, meanings };
}

/** Parse inside an inert template; remote scripts and resources are never attached to a live document. */
export function parseBingDictionary(html: string, query: string): DictionaryEntry {
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;
  const root = content.querySelector(".qdef");
  if (!root && !/词典|dictionary/i.test(content.querySelector("title")?.textContent ?? "")) {
    throw new Error("Bing 词典暂时不可用或页面结构已变化，请切换词典后重试。");
  }
  const pronunciations: DictionaryPronunciation[] = [];
  for (const accent of ["uk", "us"] as const) {
    const raw = root?.querySelector(accent === "uk" ? ".hd_pr" : ".hd_prUS")?.textContent ?? "";
    const phonetic = raw.match(/\[([^\]]+)\]/)?.[1];
    const path = root?.querySelector(`#bigaud_${accent}`)?.getAttribute("data-mp3link");
    let audioUrl: string | undefined;
    if (path) {
      try { const url = new URL(path, "https://cn.bing.com").href; if (isDictionaryAudioUrl("bing", url)) audioUrl = url; } catch { /* Missing audio is allowed. */ }
    }
    if (phonetic || audioUrl) pronunciations.push({ accent, phonetic, audioUrl });
  }
  const meanings = Array.from(root?.querySelectorAll("li") ?? []).flatMap(item => {
    const definition = item.querySelector(".def")?.textContent?.trim();
    return definition ? [{ partOfSpeech: item.querySelector(".pos")?.textContent?.trim() ?? "", definition }] : [];
  }).slice(0, 30);
  return { provider: "bing", query, word: root?.querySelector("h1")?.textContent?.trim() || query,
    sourceUrl: dictionarySourceUrl("bing", query), pronunciations, meanings };
}
