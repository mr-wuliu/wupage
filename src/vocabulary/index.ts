import { initializeInterfaceLanguage, localizeDocument, t } from "../shared/i18n";
import { sendRuntimeMessage } from "../shared/messaging";
import { setupAppearance } from "../shared/appearance-runtime";
import type { ExtensionSettings } from "../shared/types";
import { dictionaryProvider } from "../shared/vocabulary";
import type { VocabularyEntry } from "../shared/vocabulary";
import { isDictionaryAudioUrl, type DictionaryPronunciation } from "../shared/dictionary";
import { setHtmlContent } from "../shared/html";
import { uiIconMarkup } from "../shared/ui-icons";
import "./styles.css";

await initializeInterfaceLanguage();
localizeDocument(document);
const appearance = setupAppearance(undefined);
void sendRuntimeMessage<ExtensionSettings>({ type: "GET_SETTINGS" })
  .then(settings => appearance.update(settings.appearance)).catch(() => undefined);

type SortMode = "saved" | "asc" | "desc" | "shuffle";
type DateGroupMode = "month" | "day";
const searchInput = get<HTMLInputElement>("#search");
const sortSelect = get<HTMLSelectElement>("#sort");
searchInput.placeholder = t("searchVocabulary");
const entriesElement = get<HTMLElement>("#entries");
const statusElement = get<HTMLElement>("#status");
const emptyElement = get<HTMLElement>("#empty");
const recoveryElement = get<HTMLElement>("#recovery");
const errorElement = get<HTMLElement>("#errorText");
const exportRecoveryButton = get<HTMLButtonElement>("#exportRecovery");
const toggleAllButton = get<HTMLButtonElement>("#toggleAll");
const resultsLayout = get<HTMLElement>("#resultsLayout");
const dateBrowser = get<HTMLElement>("#dateBrowser");
const dateNav = get<HTMLElement>("#dateNav");
const dateSelect = get<HTMLSelectElement>("#dateSelect");
let entries: VocabularyEntry[] = [];
let sortMode: SortMode = "saved";
let dateGroupMode: DateGroupMode = "month";
let selectedDateKey: string | null = null;
let shuffledIds: string[] = [];
const expandedIds = new Set<string>();
let revealSelectedDate = false;

get<HTMLButtonElement>("#reload").addEventListener("click", () => { void load(); });
searchInput.addEventListener("input", render);
sortSelect.addEventListener("change", () => {
  sortMode = sortSelect.value as SortMode;
  if (sortMode === "shuffle") shuffleEntries();
  render();
});
get<HTMLButtonElement>("#groupByMonth").addEventListener("click", () => setDateGroupMode("month"));
get<HTMLButtonElement>("#groupByDay").addEventListener("click", () => setDateGroupMode("day"));
dateSelect.addEventListener("change", () => { selectedDateKey = dateSelect.value || null; render(); });
exportRecoveryButton.addEventListener("click", () => { void exportRecovery(); });
toggleAllButton.addEventListener("click", () => {
  const visibleIds = [...entriesElement.querySelectorAll<HTMLElement>(".vocabulary-entry")].map(row => row.dataset.entryId!).filter(Boolean);
  if (!visibleIds.length) return;
  const collapse = visibleIds.every(id => expandedIds.has(id));
  for (const id of visibleIds) collapse ? expandedIds.delete(id) : expandedIds.add(id);
  for (const row of entriesElement.querySelectorAll<HTMLElement>(".vocabulary-entry")) {
    const expanded = expandedIds.has(row.dataset.entryId ?? "");
    const toggle = row.querySelector<HTMLButtonElement>(".word-toggle");
    const details = row.querySelector<HTMLElement>(".entry-details");
    if (toggle && details) { details.hidden = !expanded; toggle.setAttribute("aria-expanded", String(expanded)); }
  }
  updateToggleAllLabel(visibleIds);
});

function get<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing page element: ${selector}`);
  return element;
}

function setDateGroupMode(mode: DateGroupMode): void {
  if (dateGroupMode === mode) return;
  dateGroupMode = mode;
  revealSelectedDate = true;
  get<HTMLButtonElement>("#groupByMonth").setAttribute("aria-pressed", String(mode === "month"));
  get<HTMLButtonElement>("#groupByDay").setAttribute("aria-pressed", String(mode === "day"));
  render();
}

function localDateKey(timestamp: number, mode: DateGroupMode): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return mode === "month" ? `${date.getFullYear()}-${month}` : `${date.getFullYear()}-${month}-${day}`;
}

function dateLabel(key: string, mode: DateGroupMode): string {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day ?? 1);
  return new Intl.DateTimeFormat(undefined, mode === "month"
    ? { year: "numeric", month: "long" }
    : { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function renderDateBrowser(filtered: VocabularyEntry[]): VocabularyEntry[] {
  const visible = filtered.length > 0;
  dateBrowser.hidden = !visible;
  resultsLayout.classList.toggle("with-date-browser", visible);
  if (!visible) {
    dateNav.replaceChildren();
    dateSelect.replaceChildren();
    revealSelectedDate = false;
    return filtered;
  }

  const groups = new Map<string, VocabularyEntry[]>();
  for (const entry of filtered) {
    const key = localDateKey(entry.savedAt, dateGroupMode);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const keys = [...groups.keys()].sort().reverse();
  if (selectedDateKey !== null && !keys.includes(selectedDateKey)) {
    const monthKey = dateGroupMode === "day" && /^\d{4}-\d{2}$/u.test(selectedDateKey)
      ? selectedDateKey
      : dateGroupMode === "month" && /^\d{4}-\d{2}-\d{2}$/u.test(selectedDateKey)
        ? selectedDateKey.slice(0, 7)
        : null;
    if (monthKey && dateGroupMode === "month" && keys.includes(monthKey)) selectedDateKey = monthKey;
    else if (monthKey && dateGroupMode === "day") selectedDateKey = keys.find(key => key.startsWith(`${monthKey}-`)) ?? null;
    else selectedDateKey = null;
  }
  const choose = (key: string) => { selectedDateKey = key || null; render(); };
  const previousScrollTop = dateNav.scrollTop;
  dateNav.replaceChildren();
  dateNav.append(makeDateChoice("", t("allDates"), filtered.length, choose));

  if (dateGroupMode === "month") {
    for (const key of keys) dateNav.append(makeDateChoice(key, dateLabel(key, "month"), groups.get(key)!.length, choose));
  } else {
    const months = new Map<string, string[]>();
    for (const key of keys) {
      const monthKey = key.slice(0, 7);
      const monthDays = months.get(monthKey) ?? [];
      monthDays.push(key);
      months.set(monthKey, monthDays);
    }
    for (const [monthKey, days] of months) {
      const section = document.createElement("section"); section.className = "date-nav-month";
      const heading = document.createElement("h3"); heading.textContent = dateLabel(monthKey, "month");
      const list = document.createElement("div"); list.className = "date-nav-days";
      for (const key of days) list.append(makeDateChoice(key, dateLabel(key, "day"), groups.get(key)!.length, choose));
      section.append(heading, list); dateNav.append(section);
    }
  }

  dateSelect.replaceChildren(new Option(`${t("allDates")} · ${filtered.length}`, ""),
    ...keys.map(key => new Option(`${dateLabel(key, dateGroupMode)} · ${groups.get(key)!.length}`, key)));
  dateSelect.value = selectedDateKey ?? "";
  dateNav.scrollTop = previousScrollTop;
  if (revealSelectedDate) {
    revealSelectedDate = false;
    const navBounds = dateNav.getBoundingClientRect();
    const selectedButton = dateNav.querySelector<HTMLButtonElement>('.date-nav-item[aria-pressed="true"]');
    if (selectedButton && navBounds.height > 0) {
      const itemBounds = selectedButton.getBoundingClientRect();
      if (itemBounds.top < navBounds.top) dateNav.scrollTop -= navBounds.top - itemBounds.top;
      else if (itemBounds.bottom > navBounds.bottom) dateNav.scrollTop += itemBounds.bottom - navBounds.bottom;
    }
  }
  return selectedDateKey === null ? filtered : filtered.filter(entry => localDateKey(entry.savedAt, dateGroupMode) === selectedDateKey);
}

function makeDateChoice(key: string, label: string, count: number, choose: (key: string) => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button"; button.className = "date-nav-item";
  button.setAttribute("aria-pressed", String((key || null) === selectedDateKey));
  const text = document.createElement("span"); text.textContent = label;
  const badge = document.createElement("span"); badge.className = "date-count"; badge.textContent = String(count); badge.setAttribute("aria-hidden", "true");
  button.append(text, badge);
  button.addEventListener("click", () => choose(key));
  return button;
}

function shuffleEntries(): void {
  shuffledIds = entries.map(entry => entry.id);
  for (let i = shuffledIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledIds[i], shuffledIds[j]] = [shuffledIds[j], shuffledIds[i]];
  }
}

async function load(): Promise<void> {
  statusElement.textContent = t("loadingVocabulary");
  recoveryElement.hidden = true;
  try {
    entries = await sendRuntimeMessage<VocabularyEntry[]>({ type: "VOCABULARY_LIST" });
    if (sortMode === "shuffle") shuffleEntries();
    statusElement.textContent = "";
    render();
  } catch (error) {
    entries = [];
    entriesElement.replaceChildren();
    emptyElement.hidden = true;
    statusElement.textContent = "";
    errorElement.textContent = error instanceof Error ? error.message : t("vocabularyLoadFailed");
    recoveryElement.hidden = false;
  }
}

function render(): void {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const filtered = entries.filter(entry => !query || [entry.term, entry.translation ?? "",
    ...entry.meanings.flatMap(item => [item.partOfSpeech, item.definition]),
    ...entry.examples.flatMap(item => [item.sentence, item.translation ?? ""]),
    ...entry.pronunciations.map(item => item.phonetic ?? "")].join(" ").toLocaleLowerCase().includes(query));
  const dated = renderDateBrowser(filtered);
  const ordered = [...dated];
  if (sortMode === "asc" || sortMode === "desc") {
    const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    ordered.sort((a, b) => collator.compare(a.term, b.term) * (sortMode === "asc" ? 1 : -1));
  } else if (sortMode === "shuffle") {
    const rank = new Map(shuffledIds.map((id, index) => [id, index]));
    ordered.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  } else ordered.sort((a, b) => b.savedAt - a.savedAt || b.updatedAt - a.updatedAt);
  entriesElement.replaceChildren(...ordered.map(renderEntry));
  updateToggleAllLabel(ordered.map(entry => entry.id));
  emptyElement.hidden = ordered.length > 0;
  if (!entries.length) emptyElement.textContent = t("vocabularyEmpty");
  else if (!ordered.length) emptyElement.textContent = t("vocabularyNoResults");
}

function renderEntry(entry: VocabularyEntry): HTMLElement {
  const article = document.createElement("article");
  article.className = "vocabulary-entry";
  article.dataset.entryId = entry.id;
  const topLine = document.createElement("div");
  topLine.className = "entry-topline";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "word-toggle";
  toggle.textContent = entry.term;
  toggle.setAttribute("aria-expanded", String(expandedIds.has(entry.id)));
  toggle.setAttribute("aria-label", t("viewWordDetails", entry.term));
  topLine.append(toggle);
  const saved = document.createElement("time");
  saved.className = "saved-time";
  saved.dateTime = new Date(entry.savedAt).toISOString();
  saved.textContent = t("savedOn", new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(entry.savedAt));
  topLine.append(saved);
  const remove = document.createElement("button");
  remove.type = "button"; remove.className = "danger"; remove.textContent = t("removeFromVocabulary");
  remove.addEventListener("click", () => { void deleteEntry(entry); });
  topLine.append(remove);
  const details = document.createElement("div");
  details.className = "entry-details";
  details.hidden = !expandedIds.has(entry.id);
  toggle.addEventListener("click", () => {
    details.hidden = !details.hidden;
    if (details.hidden) expandedIds.delete(entry.id); else expandedIds.add(entry.id);
    toggle.setAttribute("aria-expanded", String(!details.hidden));
    const visibleIds = [...entriesElement.querySelectorAll<HTMLElement>(".vocabulary-entry")].map(row => row.dataset.entryId!).filter(Boolean);
    updateToggleAllLabel(visibleIds);
  });
  article.append(topLine, details);

  if (entry.pronunciations.length) {
    const pronunciationList = document.createElement("div");
    pronunciationList.className = "pronunciations";
    for (const pronunciation of entry.pronunciations) pronunciationList.append(renderPronunciation(entry, pronunciation));
    details.append(pronunciationList);
  }
  if (entry.meanings.length) {
    const meaningList = document.createElement("dl"); meaningList.className = "meanings";
    for (const meaning of entry.meanings) {
      const part = document.createElement("dt"); part.textContent = meaning.partOfSpeech;
      const definition = document.createElement("dd"); definition.textContent = meaning.definition;
      if (meaning.pronunciation) {
        const reading = document.createElement("span"); reading.className = "reading";
        reading.lang = "zh-Latn-pinyin"; reading.textContent = `${meaning.pronunciation} `;
        definition.prepend(reading);
      }
      meaningList.append(part, definition);
    }
    details.append(meaningList);
  }
  if (entry.examples.length) {
    const examples = document.createElement("section");
    examples.className = "examples";
    const heading = document.createElement("h3"); heading.textContent = t("vocabularyExamples");
    const list = document.createElement("ul");
    for (const example of entry.examples) {
      const item = document.createElement("li");
      const sentence = document.createElement("p"); sentence.className = "example-sentence"; sentence.textContent = example.sentence;
      item.append(sentence);
      if (example.translation) { const translation = document.createElement("p"); translation.className = "example-translation"; translation.textContent = example.translation; item.append(translation); }
      list.append(item);
    }
    examples.append(heading, list); details.append(examples);
  }
  if (entry.translation) {
    const translation = document.createElement("p");
    translation.className = "translation";
    translation.textContent = entry.translation;
    details.append(translation);
  }
  return article;
}

function updateToggleAllLabel(visibleIds: string[]): void {
  toggleAllButton.textContent = visibleIds.length > 0 && visibleIds.every(id => expandedIds.has(id))
    ? t("collapseAllVocabulary") : t("expandAllVocabulary");
  toggleAllButton.disabled = visibleIds.length === 0;
}

function renderPronunciation(entry: VocabularyEntry, pronunciation: DictionaryPronunciation): HTMLElement {
  const row = document.createElement("div"); row.className = "pronunciation";
  const text = document.createElement("span");
  text.textContent = `${pronunciation.accent === "uk" ? t("ukAccent") : pronunciation.accent === "us" ? t("us") : pronunciation.accent === "pinyin" ? t("pinyin") : t("pronunciation")}${pronunciation.phonetic ? ` · ${pronunciation.phonetic}` : ""}`;
  if (pronunciation.accent === "pinyin") text.lang = "zh-Latn-pinyin";
  row.append(text);
  const provider = dictionaryProvider(entry.dictionaryProvider);
  if (provider && pronunciation.audioUrl && isDictionaryAudioUrl(provider, pronunciation.audioUrl)) {
    const play = document.createElement("button");
    play.type = "button"; play.className = "audio-button";
    setHtmlContent(play, uiIconMarkup("volume"));
    play.setAttribute("aria-label", t("playSavedPronunciation"));
    play.title = t("playSavedPronunciation");
    play.addEventListener("click", async () => {
      play.disabled = true;
      try { await sendRuntimeMessage({ type: "PLAY_DICTIONARY_AUDIO", provider, url: pronunciation.audioUrl! }); }
      catch (error) { statusElement.textContent = error instanceof Error ? error.message : t("audioPlaybackFailed"); }
      finally { play.disabled = false; }
    });
    row.append(play);
  }
  return row;
}

async function deleteEntry(entry: VocabularyEntry): Promise<void> {
  try {
    await sendRuntimeMessage({ type: "VOCABULARY_DELETE", id: entry.id });
    entries = entries.filter(item => item.id !== entry.id);
    expandedIds.delete(entry.id);
    if (sortMode === "shuffle") shuffledIds = shuffledIds.filter(id => id !== entry.id);
    render(); statusElement.textContent = t("wordRemoved");
  } catch (error) { statusElement.textContent = error instanceof Error ? error.message : t("vocabularyUpdateFailed"); }
}

async function exportRecovery(): Promise<void> {
  try {
    const value = await sendRuntimeMessage<unknown>({ type: "VOCABULARY_EXPORT_RECOVERY" });
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = "wupage-vocabulary-recovery.json"; link.click();
    URL.revokeObjectURL(url);
  } catch (error) { errorElement.textContent = error instanceof Error ? error.message : t("vocabularyRecoveryExportFailed"); }
}

void load();
