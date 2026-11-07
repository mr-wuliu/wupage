import { t } from "../shared/i18n";
import { AUTO_TRANSLATION_PRESETS, normalizeAutoTranslation, normalizeSitePattern, setAutoTranslationEnabled } from "../shared/auto-translation";
import type { AutoTranslationSettings, AutoTranslationSite } from "../shared/types";
import { uiIconMarkup } from "../shared/ui-icons";

export function setupAutoTranslationControls(
  root: HTMLElement,
  revealInvalidField: (field: HTMLInputElement) => void = () => {}
): {
  render: (value: AutoTranslationSettings | undefined) => void;
  read: () => AutoTranslationSettings;
} {
  const query = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!;
  const enabled = query<HTMLInputElement>("#autoTranslateEnabled");
  const foreign = query<HTMLInputElement>("#autoTranslateNonTarget");
  const foreignOption = query<HTMLElement>("#autoTranslateNonTargetOption");
  const list = query<HTMLElement>("#autoTranslateSites");
  const message = query<HTMLElement>("#autoTranslateSiteStatus");
  setupAutoTranslationHelp(root);
  let sites: Array<AutoTranslationSite & { preset?: string }> = [];
  const controls = new Map<string, HTMLInputElement>();
  let defaultLanguageRule = false;
  let excludedSites: string[] = [];

  function renderExcludedSites(): void {
    const group = root.querySelector<HTMLElement>("#autoTranslateExcluded");
    const list = root.querySelector<HTMLElement>("#autoTranslateExcludedSites");
    if (!group || !list) return;
    group.hidden = excludedSites.length === 0;
    list.replaceChildren();
    for (const site of excludedSites) {
      const row = document.createElement("li");
      const label = document.createElement("span"); label.textContent = site; label.title = site;
      const remove = document.createElement("button"); remove.type = "button"; remove.innerHTML = uiIconMarkup("cross");
      remove.title = t("removeExclusionFor", site); remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => {
        excludedSites = excludedSites.filter(value => value !== site);
        renderExcludedSites();
      });
      row.append(label, remove); list.append(row);
    }
  }

  function updateLanguageOption(): void {
    foreignOption.hidden = !enabled.checked;
    foreign.disabled = !enabled.checked;
  }

  enabled.addEventListener("change", () => {
    if (enabled.checked && defaultLanguageRule) {
      foreign.checked = true;
      defaultLanguageRule = false;
    }
    updateLanguageOption();
  });
  foreign.addEventListener("change", () => { defaultLanguageRule = false; });

  function syncDrafts(): void {
    for (const site of sites) {
      const control = controls.get(site.id);
      if (!control) continue;
      site.pattern = control.value;
      site.enabled = control.closest("li")?.querySelector<HTMLInputElement>(".auto-site-enabled")?.checked ?? site.enabled;
    }
  }

  function renderSites(): void {
    list.replaceChildren(); controls.clear();
    if (!sites.length) { const empty = document.createElement("li"); empty.className = "auto-site-empty"; empty.textContent = t("noSitesYetUseTheAddButtonBelow"); list.append(empty); }
    sites.forEach((site, index) => {
      const row = document.createElement("li"); row.className = "auto-site-row";
      row.dataset.siteId = site.id;
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = site.enabled; checkbox.className = "auto-site-enabled";
      checkbox.setAttribute("aria-label", t("enableSiteRule", index + 1));
      if (site.preset) checkbox.dataset.preset = site.preset;
      checkbox.addEventListener("change", () => { site.enabled = checkbox.checked; });
      const editor = document.createElement("div"); editor.className = "auto-site-editor";
      const pattern = document.createElement("input"); pattern.type = "text"; pattern.className = "auto-site-pattern";
      pattern.value = site.pattern; pattern.title = site.pattern; pattern.maxLength = 2048;
      pattern.placeholder = t("exampleComOrHttpsExampleComDocs");
      pattern.setAttribute("aria-label", t("siteRule", index + 1)); pattern.setAttribute("aria-describedby", "autoTranslateSiteHelp autoTranslateSiteStatus");
      const caption = document.createElement("small");
      const updateCaption = (): void => { caption.textContent = AUTO_TRANSLATION_PRESETS.find(preset => preset.domain === site.pattern.trim().toLowerCase())?.label ?? t("customSite"); };
      updateCaption();
      pattern.addEventListener("input", () => {
        site.pattern = pattern.value; pattern.title = pattern.value; pattern.removeAttribute("aria-invalid"); message.textContent = ""; updateCaption();
        remove.setAttribute("aria-label", t("deleteSite", site.pattern || t("empty")));
      });
      controls.set(site.id, pattern);
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary auto-site-remove";
      remove.innerHTML = uiIconMarkup("trash"); remove.title = t("removeSiteButton"); remove.setAttribute("aria-label", t("deleteSite", site.pattern || t("empty")));
      remove.addEventListener("click", () => {
        syncDrafts();
        const index = sites.indexOf(site);
        sites = sites.filter(entry => entry.id !== site.id); message.textContent = ""; renderSites();
        const next = sites[Math.min(index, sites.length - 1)];
        (next ? controls.get(next.id) : query<HTMLButtonElement>("#addAutoTranslateSite"))?.focus({ preventScroll: true });
      });
      editor.append(caption, pattern); row.append(checkbox, editor, remove); list.append(row);
    });
    const addRow = document.createElement("li"); addRow.className = "auto-site-add-row";
    const add = document.createElement("button"); add.id = "addAutoTranslateSite"; add.type = "button"; add.innerHTML = uiIconMarkup("plus");
    add.title = t("addSite"); add.setAttribute("aria-label", t("addSite"));
    add.addEventListener("click", () => {
      syncDrafts();
      const site = { id: crypto.randomUUID(), pattern: "", enabled: true };
      sites.push(site); message.textContent = ""; renderSites(); controls.get(site.id)?.focus();
    });
    addRow.append(add); list.append(addRow);
  }

  return {
    render(value): void {
      const settings = normalizeAutoTranslation(value);
      excludedSites = [...(settings.excludedSites ?? [])];
      renderExcludedSites();
      enabled.checked = settings.enabled; foreign.checked = settings.nonTargetLanguage;
      defaultLanguageRule = !settings.enabled && setAutoTranslationEnabled(settings, true).nonTargetLanguage;
      updateLanguageOption();
      sites = AUTO_TRANSLATION_PRESETS.filter(site => !settings.removedPresetSites?.includes(site.domain)).map(site => ({
        id: `preset-${site.domain}`, preset: site.domain, pattern: site.domain, enabled: settings.presetSites.includes(site.domain)
      }));
      for (const site of settings.customSites) {
        const duplicate = sites.find(entry => entry.pattern === site.pattern);
        if (duplicate) duplicate.enabled ||= site.enabled;
        else {
          let id = site.id; while (sites.some(entry => entry.id === id)) id += "-1";
          sites.push({ ...site, id });
        }
      }
      message.textContent = ""; renderSites();
    },
    read(): AutoTranslationSettings {
      const patterns = new Set<string>();
      const normalized = sites.map((site, index) => {
        try {
          const pattern = normalizeSitePattern(controls.get(site.id)?.value ?? site.pattern);
          if (patterns.has(pattern)) throw new Error(t("thisSiteRuleAlreadyExists"));
          const checkbox = controls.get(site.id)?.closest("li")?.querySelector<HTMLInputElement>(".auto-site-enabled");
          patterns.add(pattern); return { ...site, pattern, enabled: checkbox?.checked ?? site.enabled };
        } catch (error) {
          const text = t("lineEditOrRemoveThisRow", index + 1, error instanceof Error ? error.message : String(error));
          message.textContent = text;
          const field = controls.get(site.id);
          if (field) { field.setAttribute("aria-invalid", "true"); revealInvalidField(field); field.focus(); }
          throw new Error(text);
        }
      });
      const remaining = new Set(normalized.filter(site => site.preset === site.pattern).map(site => site.preset));
      const removed = AUTO_TRANSLATION_PRESETS.filter(site => !remaining.has(site.domain)).map(site => site.domain);
      return { enabled: enabled.checked, nonTargetLanguage: foreign.checked,
        presetSites: normalized.filter(site => site.preset === site.pattern && site.enabled).map(site => site.pattern),
        customSites: normalized.filter(site => site.preset !== site.pattern).map(({ id, pattern, enabled }) => ({ id, pattern, enabled })),
        ...(removed.length ? { removedPresetSites: removed } : {}),
        ...(excludedSites.length ? { excludedSites: [...excludedSites] } : {}) };
    }
  };
}

function setupAutoTranslationHelp(root: HTMLElement): void {
  const help = root.querySelector<HTMLElement>("#autoTranslateHelp");
  const trigger = root.querySelector<HTMLButtonElement>("#autoTranslateHelpTrigger");
  const panel = root.querySelector<HTMLElement>("#autoTranslateHelpPanel");
  if (!help || !trigger || !panel) return;
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const position = () => {
    if (panel.hidden) return;
    const anchor = trigger.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12))}px`;
    const top = anchor.bottom + 8 + bounds.height <= window.innerHeight - 12
      ? anchor.bottom + 8 : anchor.top - bounds.height - 8;
    panel.style.top = `${Math.max(12, top)}px`;
  };
  const show = () => { panel.hidden = false; position(); };
  const hide = () => {
    if (!help.matches(":hover") && !help.contains(document.activeElement)) panel.hidden = true;
  };
  help.addEventListener("mouseenter", show, options);
  help.addEventListener("mouseleave", hide, options);
  help.addEventListener("focusin", show, options);
  help.addEventListener("focusout", () => queueMicrotask(hide), options);
  trigger.addEventListener("click", show, options);
  trigger.addEventListener("keydown", event => {
    if (event.key === "Escape") { panel.hidden = true; trigger.blur(); event.stopPropagation(); }
  }, options);
  window.addEventListener("resize", position, options);
  window.addEventListener("scroll", position, { ...options, capture: true });
  window.addEventListener("pagehide", event => { if (!event.persisted) controller.abort(); }, options);
}
