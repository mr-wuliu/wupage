import { SETTINGS_KEY } from "../shared/defaults";
import { DICTIONARY_LABELS, MAX_SELECTION_TEXT_LENGTH, dictionaryProviderForQuery, dictionarySourceUrl, isChineseDictionaryQuery, isSingleDictionaryWord, normalizeSelectionText, normalizeSelectionTranslation,
  type DictionaryEntry, type DictionaryProvider, type SelectionTranslationSettings } from "../shared/dictionary";
import type { ExtensionSettings, TranslateBatchResponse } from "../shared/types";
import { sendRuntimeRequest } from "./runtime";
import { SELECTION_TRANSLATION_STYLES } from "./selection-translation-styles";
import { normalizeShortcutEnabled } from "../shared/shortcuts";
import { formatLocalShortcut, matchesLocalShortcut, normalizeLocalShortcuts } from "../shared/local-shortcuts";
import { uiIconMarkup } from "../shared/ui-icons";
import { setHtmlContent } from "../shared/html";
import { hasTouchInput, visibleViewport } from "../shared/touch";

const HOST_ID = "wupage-selection-tools";
const EXCLUDED = "input,textarea,select,button,[contenteditable]:not([contenteditable='false']),[role='textbox'],#wupage-selection-tools,#wupage-floating-hitbox,#wupage-floating-menu,#wupage-debug-panel,#wupage-image-tools,#wupage-touch-paragraph,#wupage-touch-hint";

export class SelectionTranslationController {
  private settings: SelectionTranslationSettings;
  private shortcutEnabled = normalizeShortcutEnabled(undefined);
  private localShortcuts = normalizeLocalShortcuts(undefined);
  private host: HTMLElement;
  private root: ShadowRoot;
  private triggers: HTMLElement;
  private card: HTMLElement;
  private word: HTMLTextAreaElement;
  private sourceActions: HTMLElement;
  private sourceError: HTMLElement;
  private submitSource: HTMLButtonElement;
  private body: HTMLElement;
  private providerSelect: HTMLSelectElement;
  private translationService: HTMLElement;
  private footer: HTMLElement;
  private source: HTMLAnchorElement;
  private audioStatus: HTMLElement;
  private range?: Range;
  private query = "";
  private version = 0;
  private audioVersion = 0;
  private audioRequested = false;
  private selecting = false;
  private touchSelection = hasTouchInput();
  private disposed = false;
  private selectionTimer?: number;

  constructor(settings: SelectionTranslationSettings) {
    this.settings = settings;
    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    this.host.style.cssText = "all:initial!important;display:block!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483646!important;";
    this.root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = SELECTION_TRANSLATION_STYLES;
    this.triggers = document.createElement("div");
    this.triggers.className = "triggers";
    this.card = document.createElement("section");
    this.card.className = "card";
    this.card.hidden = true;
    this.card.tabIndex = -1;
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-label", "划词翻译");
    this.card.lang = "zh-CN";
    const header = document.createElement("header");
    this.word = document.createElement("textarea");
    this.word.className = "word";
    this.word.lang = "en";
    this.word.rows = 1;
    this.word.spellcheck = false;
    this.word.title = "编辑原文";
    this.word.setAttribute("aria-label", "原文");
    this.word.setAttribute("aria-describedby", "wupage-selection-source-error");
    this.word.addEventListener("input", () => {
      this.version++;
      this.stopAudio();
      this.body.replaceChildren();
      this.body.hidden = true;
      this.body.removeAttribute("aria-busy");
      this.footer.hidden = true;
      this.sourceActions.hidden = false;
      this.sourceError.textContent = "";
      this.word.removeAttribute("aria-invalid");
      this.updateSourceAction();
      this.resizeSourceEditor();
    });
    this.word.addEventListener("focus", () => this.resizeSourceEditor());
    this.word.addEventListener("keydown", event => {
      event.stopPropagation();
      if (this.shortcutEnabled["dismiss-overlays"] && matchesLocalShortcut(event, this.localShortcuts["dismiss-overlays"])) { event.preventDefault(); this.close(); return; }
      if (this.shortcutEnabled["selection-submit"] && matchesLocalShortcut(event, this.localShortcuts["selection-submit"]) && !event.repeat) {
        event.preventDefault(); this.submitEditedText();
      }
    });
    this.word.addEventListener("keyup", event => event.stopPropagation());
    this.word.addEventListener("keypress", event => event.stopPropagation());
    this.providerSelect = document.createElement("select");
    this.providerSelect.setAttribute("aria-label", "查词词典");
    for (const provider of ["youdao", "bing"] as const) {
      const option = document.createElement("option");
      option.value = provider; option.textContent = DICTIONARY_LABELS[provider];
      this.providerSelect.append(option);
    }
    this.providerSelect.addEventListener("change", () => this.submitEditedText());
    this.translationService = document.createElement("span");
    this.translationService.className = "translation-service";
    this.translationService.hidden = true;
    const close = document.createElement("button");
    close.type = "button"; close.className = "close"; setHtmlContent(close, uiIconMarkup("cross"));
    close.setAttribute("aria-label", "关闭划词翻译");
    close.addEventListener("click", () => this.close());
    header.append(this.word, this.providerSelect, this.translationService, close);
    this.sourceActions = document.createElement("div");
    this.sourceActions.className = "source-actions";
    this.sourceActions.hidden = true;
    this.sourceError = document.createElement("span");
    this.sourceError.id = "wupage-selection-source-error";
    this.sourceError.setAttribute("role", "alert");
    this.submitSource = document.createElement("button");
    this.submitSource.type = "button";
    this.submitSource.className = "submit-source";
    this.submitSource.addEventListener("click", () => this.submitEditedText());
    this.sourceActions.append(this.sourceError, this.submitSource);
    this.body = document.createElement("div");
    this.body.className = "body";
    this.body.setAttribute("aria-live", "polite");
    this.footer = document.createElement("footer");
    this.audioStatus = document.createElement("span");
    this.audioStatus.setAttribute("role", "status");
    this.source = document.createElement("a");
    this.source.target = "_blank";
    this.source.rel = "noopener noreferrer";
    this.footer.append(this.audioStatus, this.source);
    this.card.append(header, this.sourceActions, this.body, this.footer);
    this.root.append(style, this.triggers, this.card);
    // Clicking an entry point must retain the browser selection until its query is captured.
    this.triggers.addEventListener("pointerdown", event => event.preventDefault());
    document.documentElement.append(this.host);
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("pointerup", this.onPointerUp);
    document.addEventListener("pointercancel", this.onPointerCancel);
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("scroll", this.onScroll, true);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("pagehide", this.onResize);
    window.visualViewport?.addEventListener("resize", this.onViewportChange);
    window.visualViewport?.addEventListener("scroll", this.onViewportChange);
  }

  update(settings: SelectionTranslationSettings): void {
    if (this.settings.enabled !== settings.enabled || this.settings.style !== settings.style || this.settings.provider !== settings.provider) this.close();
    this.settings = settings;
  }

  updateShortcuts(value: unknown, bindings?: unknown): void {
    this.localShortcuts = normalizeLocalShortcuts(bindings);
    this.shortcutEnabled = normalizeShortcutEnabled(value, undefined, this.localShortcuts);
    this.updateSourceAction();
  }

  dispose(): void {
    this.close(); this.disposed = true;
    this.host.remove();
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("pointerup", this.onPointerUp);
    document.removeEventListener("pointercancel", this.onPointerCancel);
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pagehide", this.onResize);
    window.visualViewport?.removeEventListener("resize", this.onViewportChange);
    window.visualViewport?.removeEventListener("scroll", this.onViewportChange);
  }

  private owns(event: Event): boolean { return event.composedPath().includes(this.host); }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.owns(event)) return;
    if (event.pointerType) this.touchSelection = event.pointerType === "touch";
    this.selecting = true;
    this.close();
  };
  private onPointerUp = (event: PointerEvent): void => {
    this.selecting = false;
    if (event.pointerType && !this.owns(event)) this.touchSelection = event.pointerType === "touch";
    if (!this.owns(event) && event.button === 0) this.scheduleSelection();
  };
  private onPointerCancel = (event: PointerEvent): void => {
    this.selecting = false;
    if (event.pointerType === "touch") this.touchSelection = true;
    if (!this.owns(event)) this.scheduleSelection();
  };
  private onSelectionChange = (): void => {
    if (!this.selecting && this.card.hidden) this.scheduleSelection();
  };
  private onKeyUp = (event: KeyboardEvent): void => {
    if (this.owns(event) || event.key === "Escape" || !this.card.hidden) return;
    if (event.key.startsWith("Arrow") || event.key === "Shift" || event.key === "Home" || event.key === "End") this.scheduleSelection();
  };
  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.shortcutEnabled["dismiss-overlays"] && matchesLocalShortcut(event, this.localShortcuts["dismiss-overlays"])) { if (!this.card.hidden) event.preventDefault(); this.close(); }
  };
  private onScroll = (event: Event): void => {
    if (this.owns(event)) return;
    if (this.touchSelection && !this.card.hidden && this.root.activeElement === this.word) this.onViewportChange();
    else this.close();
  };
  private onResize = (event: Event): void => {
    if (event.type === "pagehide" || !this.touchSelection) this.close();
    else this.onViewportChange();
  };
  private onViewportChange = (): void => {
    if (!this.card.hidden) this.resizeSourceEditor();
    else if (this.triggers.childElementCount) this.captureSelection();
  };

  private scheduleSelection(): void {
    window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => this.captureSelection(), this.touchSelection ? 180 : 30);
  }

  private captureSelection(): void {
    if (this.disposed || !this.settings.enabled || !this.card.hidden) return;
    const selection = window.getSelection();
    const query = normalizeSelectionText(selection?.toString());
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !query
      || document.activeElement?.closest(EXCLUDED)) { this.close(); return; }
    const range = selection.getRangeAt(0);
    for (const node of [range.startContainer, range.endContainer, range.commonAncestorContainer]) {
      const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
      if (!node.isConnected || element?.closest(EXCLUDED)) { this.close(); return; }
    }
    // A selection can begin/end in prose and cross an editor in the middle.
    // Checking only its endpoints would send that editor's draft as source text.
    const common = range.commonAncestorContainer;
    if (common instanceof Element && [...common.querySelectorAll(EXCLUDED)].some(element => range.intersectsNode(element))) {
      this.close(); return;
    }
    this.range = range.cloneRange(); this.query = query;
    const rects = this.rects();
    this.triggers.replaceChildren();
    if (!rects.length) return;
    const last = rects[rects.length - 1];
    this.triggers.classList.toggle("touch-triggers", this.touchSelection);
    this.host.style.setProperty("z-index", String(this.touchSelection ? 2147483647 : 2147483646), "important");
    if (this.touchSelection) {
      const view = visibleViewport(), width = Math.max(0, Math.min(360, view.width - 24));
      this.triggers.style.cssText = `left:${view.left + (view.width - width) / 2}px;top:${Math.max(view.top + 12, view.bottom - 76)}px;width:${width}px`;
      const button = this.trigger("trigger-touch");
      button.textContent = isSingleDictionaryWord(query) ? "查词" : "翻译所选";
      const preview = document.createElement("span"); preview.className = "selection-preview"; preview.textContent = query;
      const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.className = "dismiss-trigger";
      dismiss.setAttribute("aria-label", "关闭划词入口"); setHtmlContent(dismiss, uiIconMarkup("cross"));
      dismiss.addEventListener("click", () => this.close());
      this.triggers.append(preview, button, dismiss);
    } else if (this.settings.style === "dot") {
      this.triggers.removeAttribute("style");
      const button = this.trigger("trigger-dot");
      button.style.left = `${Math.max(8, Math.min(window.innerWidth - 36, last.right + 3))}px`;
      button.style.top = `${Math.max(8, Math.min(window.innerHeight - 36, last.bottom - 8))}px`;
      this.triggers.append(button);
    } else { this.triggers.removeAttribute("style"); rects.forEach((rect, index) => {
      const button = this.trigger("trigger-line");
      button.style.left = `${rect.left}px`; button.style.top = `${rect.bottom - 5}px`; button.style.width = `${rect.width}px`;
      button.tabIndex = index === 0 ? 0 : -1;
      this.triggers.append(button);
    }); }
  }

  private rects(): DOMRect[] {
    if (!this.range?.startContainer.isConnected || !this.range.endContainer.isConnected) return [];
    const rects = Array.from(this.range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth);
    const lines: DOMRect[] = [];
    for (const rect of rects) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.top - rect.top) <= 2 && Math.abs(last.bottom - rect.bottom) <= 2 && rect.left <= last.right + 3 && rect.right >= last.left) {
        lines[lines.length - 1] = new DOMRect(Math.min(last.left, rect.left), Math.min(last.top, rect.top),
          Math.max(last.right, rect.right) - Math.min(last.left, rect.left), Math.max(last.bottom, rect.bottom) - Math.min(last.top, rect.top));
      } else lines.push(rect);
    }
    return lines;
  }

  private trigger(className: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button"; button.className = className;
    const action = isSingleDictionaryWord(this.query) ? "查词" : "翻译";
    button.title = action; button.setAttribute("aria-label", `${action}“${this.query.slice(0, 100)}”`);
    button.addEventListener("click", () => { void this.lookup(this.settings.provider); });
    return button;
  }

  private async lookup(provider: DictionaryProvider, { forceTranslation = false, focus = true }: { forceTranslation?: boolean; focus?: boolean } = {}): Promise<void> {
    if (!this.query || !this.settings.enabled || this.disposed) return;
    const version = ++this.version;
    this.stopAudio();
    this.triggers.replaceChildren();
    this.card.hidden = false;
    this.sourceActions.hidden = true;
    this.sourceError.textContent = "";
    this.word.removeAttribute("aria-invalid");
    this.body.hidden = false;
    let translating = forceTranslation || !isSingleDictionaryWord(this.query);
    this.setTranslationMode(translating);
    const chinese = isChineseDictionaryQuery(this.query);
    provider = dictionaryProviderForQuery(provider, this.query);
    this.providerSelect.querySelector<HTMLOptionElement>('option[value="bing"]')!.disabled = chinese;
    this.providerSelect.title = chinese ? "中文拼音和释义由有道词典提供" : "";
    this.providerSelect.value = provider;
    this.word.value = this.query;
    this.word.lang = chinese ? "zh-CN" : "";
    this.source.href = dictionarySourceUrl(provider, this.query);
    this.source.textContent = `在${DICTIONARY_LABELS[provider]}中查看`;
    this.body.textContent = translating ? "正在翻译…" : "正在查询…";
    this.body.setAttribute("aria-busy", "true");
    this.resizeSourceEditor();
    if (!this.positionCard()) { this.close(); return; }
    if (focus) this.card.focus({ preventScroll: true });
    try {
      if (translating) { await this.translateSelection(version); return; }
      const entry = await sendRuntimeRequest<DictionaryEntry>({ type: "LOOKUP_DICTIONARY", provider, query: this.query });
      if (!this.canRender(version)) return;
      if (entry.meanings.some(meaning => meaning.definition.trim())
        || (chinese && entry.pronunciations.some(item => item.phonetic?.trim()))) this.renderEntry(entry, version);
      else { translating = true; await this.translateSelection(version); }
    } catch (error) {
      if (version !== this.version || this.disposed) return;
      this.body.replaceChildren();
      const message = document.createElement("p");
      message.className = "notice";
      message.textContent = this.errorMessage(error);
      const retry = document.createElement("button");
      retry.type = "button"; retry.textContent = "重试"; retry.className = "retry";
      retry.addEventListener("click", () => { void this.lookup(provider, { forceTranslation: translating }); });
      this.body.append(message, retry);
    } finally {
      if (version === this.version) { this.body.removeAttribute("aria-busy"); this.positionCard(); }
    }
  }

  private updateSourceAction(): void {
    const action = isSingleDictionaryWord(this.word.value.trim()) ? "查词" : "翻译";
    this.submitSource.textContent = action;
    this.submitSource.title = this.shortcutEnabled["selection-submit"] ? `${action}（${formatLocalShortcut(this.localShortcuts["selection-submit"])}）` : action;
  }

  private submitEditedText(): void {
    if (this.disposed || this.card.hidden || !this.settings.enabled) return;
    const query = normalizeSelectionText(this.word.value);
    if (!query) {
      this.sourceActions.hidden = false;
      this.sourceError.textContent = Array.from(this.word.value.trim()).length > MAX_SELECTION_TEXT_LENGTH
        ? "原文不能超过 5,000 个字符。" : "请输入要查询或翻译的文字。";
      this.word.setAttribute("aria-invalid", "true");
      this.updateSourceAction();
      this.positionCard();
      return;
    }
    this.query = query;
    void this.lookup(this.providerSelect.value as DictionaryProvider, { focus: false });
  }

  private resizeSourceEditor(): void {
    if (this.card.hidden) return;
    const measured = Number.parseFloat(window.getComputedStyle(this.word).lineHeight);
    const lineHeight = measured >= 8 ? measured : this.card.classList.contains("translation-mode") ? 20 : 28;
    const expanded = this.root.activeElement === this.word;
    const limit = Math.max(36, Math.min(expanded ? 150 : lineHeight * 2 + 8, visibleViewport().height / 3));
    this.word.style.height = "0px";
    this.word.style.height = `${Math.min(limit, Math.max(lineHeight + 8, this.word.scrollHeight))}px`;
    this.positionCard();
  }

  private canRender(version: number): boolean {
    if (version !== this.version || this.disposed) return false;
    if (!this.range?.startContainer.isConnected || !this.range.endContainer.isConnected) { this.close(); return false; }
    return true;
  }

  private setTranslationMode(enabled: boolean): void {
    this.card.classList.toggle("translation-mode", enabled);
    this.card.dataset.mode = enabled ? "translation" : "dictionary";
    this.providerSelect.hidden = enabled;
    this.translationService.hidden = !enabled;
    this.translationService.textContent = "翻译";
    this.translationService.title = "";
    this.footer.hidden = enabled;
    this.resizeSourceEditor();
  }

  private async translateSelection(version: number): Promise<void> {
    if (!this.canRender(version)) return;
    this.setTranslationMode(true);
    this.body.textContent = "正在翻译…";
    const settings = await sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" });
    if (!this.canRender(version)) return;
    const provider = settings.providers.find(item => item.id === settings.activeProviderId && item.enabled !== false);
    if (!provider) throw new Error("请先在设置中选择可用的翻译服务。");
    this.translationService.textContent = provider.label;
    this.translationService.title = `${provider.label} → ${settings.targetLang}`;
    const result = await sendRuntimeRequest<TranslateBatchResponse>({
      type: "TRANSLATE_BATCH", texts: [this.query], providerId: provider.id,
      sourceLang: settings.sourceLang, targetLang: settings.targetLang
    });
    if (!this.canRender(version)) return;
    const translated = result.translations?.[0];
    if (typeof translated !== "string" || !translated.trim()) throw new Error("翻译服务未返回译文，请重试。");
    const text = document.createElement("p");
    text.className = "selection-translation";
    text.lang = settings.targetLang;
    text.textContent = translated.trim();
    this.body.replaceChildren(text);
  }

  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : "请求失败，请重试。";
    if (message.startsWith("Unhandled message:")) return "扩展后台尚未更新，请重新加载扩展并刷新当前页面。";
    if (message.includes("Extension context invalidated")) return "扩展已更新，请刷新当前页面后重试。";
    return message;
  }

  private renderEntry(entry: DictionaryEntry, version: number): void {
    this.word.value = entry.word;
    this.resizeSourceEditor();
    this.body.replaceChildren();
    const phonetics = document.createElement("div");
    phonetics.className = "phonetics";
    for (const pronunciation of entry.pronunciations) {
      const line = document.createElement("div");
      const accent = pronunciation.accent === "uk" ? "英" : pronunciation.accent === "us" ? "美" : pronunciation.accent === "pinyin" ? "拼音" : "读音";
      const label = document.createElement("span");
      label.textContent = `${accent} ${pronunciation.phonetic ? pronunciation.accent === "uk" || pronunciation.accent === "us" ? `/${pronunciation.phonetic}/` : pronunciation.phonetic : ""}`;
      if (pronunciation.accent === "pinyin") label.lang = "zh-Latn-pinyin";
      line.append(label);
      if (pronunciation.audioUrl) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "speak"; setHtmlContent(button, uiIconMarkup("volume"));
        button.setAttribute("aria-label", `播放${accent === "拼音" ? "中文" : accent === "读音" ? "单词" : `${accent}式`}发音`);
        button.addEventListener("click", () => { void this.play(entry.provider, pronunciation.audioUrl!, button, version); });
        line.append(button);
      }
      phonetics.append(line);
    }
    if (phonetics.childElementCount) this.body.append(phonetics);
    const meanings = document.createElement("ul");
    meanings.className = "meanings";
    for (const meaning of entry.meanings) {
      const item = document.createElement("li");
      const pos = document.createElement("span");
      pos.className = "part-of-speech"; pos.textContent = meaning.partOfSpeech;
      const definition = document.createElement("span");
      if (meaning.pronunciation) {
        const reading = document.createElement("span");
        reading.className = "meaning-pronunciation"; reading.lang = "zh-Latn-pinyin";
        reading.textContent = meaning.pronunciation;
        definition.append(reading);
      }
      definition.append(document.createTextNode(meaning.definition));
      item.append(pos, definition); meanings.append(item);
    }
    if (meanings.childElementCount) this.body.append(meanings);
    else {
      const empty = document.createElement("p"); empty.className = "notice";
      empty.textContent = isChineseDictionaryQuery(this.query) ? "未找到词典释义，可查看原站。" : "未找到词典释义，可切换词典或查看原站。";
      this.body.append(empty);
    }
  }

  private async play(provider: DictionaryProvider, url: string, button: HTMLButtonElement, version: number): Promise<void> {
    const audioVersion = ++this.audioVersion;
    this.audioRequested = true;
    button.disabled = true;
    this.audioStatus.textContent = "正在加载发音…";
    try {
      await sendRuntimeRequest({ type: "PLAY_DICTIONARY_AUDIO", provider, url });
      if (version === this.version && audioVersion === this.audioVersion) this.audioStatus.textContent = "";
    } catch (error) {
      if (version === this.version && audioVersion === this.audioVersion) this.audioStatus.textContent = this.errorMessage(error);
    } finally { button.disabled = false; }
  }

  private stopAudio(): void {
    this.audioVersion++;
    this.audioStatus.textContent = "";
    if (!this.audioRequested) return;
    this.audioRequested = false;
    void sendRuntimeRequest({ type: "STOP_DICTIONARY_AUDIO" }).catch(() => undefined);
  }

  private positionCard(): boolean {
    const rects = this.rects();
    const view = visibleViewport();
    if (!rects.length && (!this.touchSelection || !this.range?.startContainer.isConnected || !this.range.endContainer.isConnected)) return false;
    // Keyboard scrolling may move the source selection offscreen while its editor remains open.
    const first = rects[0] ?? new DOMRect(view.left, view.top, 0, 0), last = rects[rects.length - 1] ?? first;
    this.card.classList.toggle("touch-card", this.touchSelection);
    this.card.style.maxHeight = `${Math.max(0, view.height - 24)}px`;
    this.card.style.maxWidth = `${Math.max(0, view.width - 24)}px`;
    const width = this.card.offsetWidth || Math.min(360, view.width - 24);
    const height = this.card.offsetHeight || 160;
    const top = this.touchSelection ? view.bottom - height - 12
      : last.bottom + 10 + height <= view.bottom - 12 ? last.bottom + 10 : first.top - height - 10;
    this.card.style.left = `${Math.max(view.left + 12, Math.min(view.right - width - 12, this.touchSelection ? view.left + (view.width - width) / 2 : first.left))}px`;
    this.card.style.top = `${Math.max(view.top + 12, Math.min(view.bottom - height - 12, top))}px`;
    return true;
  }

  private close(): void {
    window.clearTimeout(this.selectionTimer);
    this.version++;
    if (this.root.activeElement instanceof HTMLElement) this.root.activeElement.blur();
    this.card.hidden = true;
    this.triggers.replaceChildren();
    this.range = undefined;
    this.query = "";
    this.stopAudio();
  }
}

let controller: SelectionTranslationController | undefined;

export function initSelectionTranslation(): void {
  if (typeof document === "undefined" || !chrome?.runtime?.id || controller) return;
  let revision = 0;
  const apply = (settings: Partial<ExtensionSettings> | undefined) => {
    const normalized = normalizeSelectionTranslation(settings?.selectionTranslation);
    if (controller) controller.update(normalized);
    else controller = new SelectionTranslationController(normalized);
    controller.updateShortcuts(settings?.shortcutEnabled, settings?.localShortcuts);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    revision++;
    apply(changes[SETTINGS_KEY].newValue as Partial<ExtensionSettings> | undefined);
  });
  void sendRuntimeRequest<ExtensionSettings>({ type: "GET_SETTINGS" }).then(settings => {
    if (!revision) apply(settings);
  }).catch(() => undefined);
}
