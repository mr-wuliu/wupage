import { t } from "../shared/i18n";
import { applyColorScheme, BUILT_IN_SCHEMES, COLOR_FIELDS, COLOR_GROUPS, DEFAULT_APPEARANCE, getColorScheme,
  isHexColor, normalizeAppearance, schemeColor, type AppearanceMode, type AppearanceSettings, type AppearanceTone } from "../shared/appearance";
import { setupAppearance } from "../shared/appearance-runtime";
import { mapTranslationTextColor } from "../shared/translation-colors";
import "./appearance.css";
import { setupPopupMenuControls } from "./popup-menu";
import { showActionStatus } from "./action-feedback";

export function setupAppearanceControls(root: HTMLElement): {
  render: (value: unknown) => void;
  read: () => AppearanceSettings;
} {
  const query = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const select = query<HTMLSelectElement>("#appearanceScheme");
  const colors = query<HTMLElement>("#appearanceColors");
  const name = query<HTMLInputElement>("#appearanceSchemeName");
  const status = query<HTMLElement>("#appearanceStatus");
  const duplicate = query<HTMLButtonElement>("#duplicateScheme");
  const copyNotice = query<HTMLElement>("#appearanceCopyNotice");
  const copyToEdit = query<HTMLButtonElement>("#copySchemeToEdit");
  const menu = setupPopupMenuControls(query<HTMLElement>("#popupMenuEditor"));
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-appearance-tab]")];
  function selectTab(name: string): void {
    for (const tab of tabs) {
      const selected = tab.dataset.appearanceTab === name;
      tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of root.querySelectorAll<HTMLElement>("[data-appearance-panel]")) panel.hidden = panel.dataset.appearancePanel !== name;
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => selectTab(tab.dataset.appearanceTab!));
    tab.addEventListener("keydown", event => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); selectTab(tabs[next].dataset.appearanceTab!); tabs[next].focus();
    });
  }
  let draft = normalizeAppearance(undefined);
  let tone: AppearanceTone = "light";
  let initialized = false;
  const theme = setupAppearance(draft, { live: false });
  const selected = () => getColorScheme(draft, tone);
  const custom = () => draft.customSchemes.find(scheme => scheme.id === selected().id);

  function paint(): void {
    theme.update(draft);
    const scheme = selected();
    const preview = query<HTMLElement>("#appearancePreview");
    applyColorScheme(preview, scheme);
    preview.style.colorScheme = tone;
    query<HTMLElement>("#appearancePreviewTone").textContent = tone === "light" ? t("light") : t("dark");
    const palette = { light: schemeColor(scheme, "translation-light"), dark: schemeColor(scheme, "translation-dark") };
    query<HTMLElement>(".appearance-preview-translation-light").style.color = mapTranslationTextColor("rgb(39, 49, 58)", "rgb(255, 255, 255)", palette)!;
    query<HTMLElement>(".appearance-preview-translation-dark").style.color = mapTranslationTextColor("rgb(231, 239, 236)", "rgb(23, 32, 38)", palette)!;
  }

  function renderEditor(): void {
    select.replaceChildren();
    for (const [label, schemes] of [[t("builtInSchemes"), BUILT_IN_SCHEMES], [t("customSchemes"), draft.customSchemes]] as const) {
      const group = document.createElement("optgroup");
      group.label = label;
      for (const scheme of schemes.filter(scheme => scheme.tone === tone)) {
        const option = document.createElement("option");
        option.value = scheme.id; option.textContent = scheme.name;
        group.append(option);
      }
      if (group.childElementCount) select.append(group);
    }
    const scheme = selected();
    select.value = scheme.id;
    const editable = Boolean(custom());
    query<HTMLElement>("#customSchemeName").hidden = !editable;
    query<HTMLElement>("#customSchemeActions").hidden = !editable;
    copyNotice.hidden = true;
    name.value = editable ? scheme.name : "";
    name.removeAttribute("aria-invalid");
    duplicate.disabled = draft.customSchemes.length >= 32;
    duplicate.title = duplicate.disabled ? t("youCanSaveUpTo32CustomSchemes") : t("duplicateAndEditTheCurrentScheme");
    copyToEdit.disabled = duplicate.disabled;
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-appearance-tone]")) {
      button.setAttribute("aria-pressed", String(button.dataset.appearanceTone === tone));
    }
    const firstRender = !colors.childElementCount;
    const expandedGroups = new Set(Array.from(colors.querySelectorAll<HTMLDetailsElement>("details[open]"), group => group.dataset.colorGroup));
    colors.replaceChildren();
    const groups = new Map<string, HTMLElement>();
    for (const group of COLOR_GROUPS) {
      const details = document.createElement("details");
      details.className = "appearance-color-group";
      details.dataset.colorGroup = group.id;
      details.open = firstRender ? group.id === "floating" || group.id === "translation" : expandedGroups.has(group.id);
      const summary = document.createElement("summary");
      summary.textContent = group.label;
      const swatches = document.createElement("span");
      swatches.className = "appearance-group-swatches";
      swatches.setAttribute("aria-hidden", "true");
      for (const { key } of COLOR_FIELDS.filter(field => field.group === group.id).slice(0, 4)) {
        const swatch = document.createElement("span");
        swatch.dataset.colorSwatch = key;
        swatch.style.background = schemeColor(scheme, key); swatches.append(swatch);
      }
      summary.append(swatches);
      const grid = document.createElement("div"); grid.className = "appearance-color-grid";
      details.append(summary);
      if (group.id !== "floating" && group.id !== "translation") {
        const description = document.createElement("p");
        description.className = "field-description"; description.textContent = group.description;
        details.append(description);
      }
      details.append(grid); colors.append(details); groups.set(group.id, grid);
    }
    for (const { key, label, group } of COLOR_FIELDS) {
      const row = document.createElement("div");
      row.className = "appearance-color-row";
      const text = document.createElement("label");
      text.htmlFor = `appearance-color-${key}`; text.textContent = label;
      const picker = document.createElement("input");
      picker.type = "color"; picker.id = text.htmlFor; picker.value = scheme.colors[key];
      picker.disabled = !editable;
      const hex = document.createElement("input");
      hex.type = "text"; hex.value = scheme.colors[key]; hex.maxLength = 7;
      hex.spellcheck = false; hex.disabled = !editable;
      hex.setAttribute("aria-label", t("hexColor", label));
      hex.dataset.colorHex = key;
      const opacity = document.createElement("button");
      opacity.type = "button"; opacity.className = "appearance-opacity-toggle";
      opacity.dataset.colorOpacity = key;
      opacity.setAttribute("aria-expanded", "false");
      const swatch = document.createElement("span"); swatch.className = "appearance-opacity-swatch";
      swatch.setAttribute("aria-hidden", "true");
      const caption = document.createElement("span"); caption.setAttribute("aria-hidden", "true");
      opacity.append(swatch, caption);
      const panel = document.createElement("div");
      panel.className = "appearance-opacity-row appearance-color-opacity"; panel.id = `appearance-opacity-${key}`; panel.hidden = true;
      opacity.setAttribute("aria-controls", panel.id);
      const opacityLabel = document.createElement("label");
      opacityLabel.htmlFor = `${panel.id}-range`; opacityLabel.textContent = t("opacity");
      const range = document.createElement("input");
      range.type = "range"; range.id = opacityLabel.htmlFor;
      const number = document.createElement("input"); number.type = "number"; number.dataset.colorOpacityNumber = key;
      for (const input of [range, number]) {
        input.min = "0"; input.max = "100"; input.step = "1";
        input.value = String(scheme.opacities?.[key] ?? 100);
        input.setAttribute("aria-label", t("colorOpacity", label));
        input.title = t("lowerValuesAreMoreTransparent100IsFully");
      }
      const value = document.createElement("span"); value.className = "appearance-opacity-value";
      const percent = document.createElement("span"); percent.textContent = "%"; percent.setAttribute("aria-hidden", "true");
      value.append(number, percent); panel.append(opacityLabel, range, value);
      function updateSwatch(): void {
        const current = selected();
        const percent = current.opacities?.[key] ?? 100;
        caption.textContent = `${percent}%`;
        opacity.title = `${t("colorOpacity", label)} · ${percent}%`;
        opacity.setAttribute("aria-label", opacity.title);
        swatch.style.setProperty("--swatch-color", schemeColor(current, key));
        range.setAttribute("aria-valuetext", `${percent}%`);
        colors.querySelector<HTMLElement>(`[data-color-swatch="${key}"]`)?.style.setProperty("background", schemeColor(current, key));
      }
      function setOpacity(value: number): void {
        const scheme = custom();
        if (!scheme) return;
        scheme.opacities ??= {};
        scheme.opacities[key] = value;
        status.textContent = ""; updateSwatch(); paint();
      }
      range.addEventListener("input", () => {
        number.value = range.value; number.removeAttribute("aria-invalid"); setOpacity(Number(range.value));
      });
      number.addEventListener("input", () => {
        const value = number.valueAsNumber;
        const valid = Number.isInteger(value) && value >= 0 && value <= 100;
        number.setAttribute("aria-invalid", String(!valid));
        if (valid) { range.value = String(value); setOpacity(value); }
      });
      opacity.addEventListener("click", () => {
        const open = panel.hidden;
        for (const other of colors.querySelectorAll<HTMLElement>(".appearance-color-opacity")) other.hidden = true;
        for (const toggle of colors.querySelectorAll("[data-color-opacity]")) toggle.setAttribute("aria-expanded", "false");
        panel.hidden = !open; opacity.setAttribute("aria-expanded", String(open));
        if (open) range.focus();
      });
      panel.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation(); panel.hidden = true; opacity.setAttribute("aria-expanded", "false"); opacity.focus();
      });
      updateSwatch();
      picker.addEventListener("input", () => {
        const scheme = custom();
        if (!scheme) return;
        scheme.colors[key] = picker.value; hex.value = picker.value;
        hex.removeAttribute("aria-invalid"); status.textContent = ""; updateSwatch(); paint();
      });
      hex.addEventListener("input", () => {
        const value = hex.value.trim();
        hex.setAttribute("aria-invalid", String(!isHexColor(value)));
        const scheme = custom();
        if (!scheme || !isHexColor(value)) return;
        scheme.colors[key] = value.toLowerCase(); picker.value = value;
        status.textContent = ""; updateSwatch(); paint();
      });
      row.append(text, picker, hex, opacity, panel);
      if (!editable) {
        opacity.disabled = true;
        const locked = document.createElement("button");
        locked.type = "button"; locked.className = "appearance-locked-color";
        locked.setAttribute("aria-label", t("copyToConfigureColor", label));
        locked.title = t("copySchemeBeforeEditing");
        locked.addEventListener("click", () => {
          copyNotice.hidden = false;
          copyNotice.querySelector("p")!.textContent = duplicate.disabled
            ? t("youCanSaveUpTo32CustomSchemes") : t("copySchemeBeforeEditing");
          if (copyToEdit.disabled) { copyNotice.tabIndex = -1; copyNotice.focus(); }
          else copyToEdit.focus();
        });
        row.append(locked);
      }
      groups.get(group)!.append(row);
    }
    const opacityRow = document.createElement("div"); opacityRow.className = "appearance-opacity-row";
    const opacityLabel = document.createElement("label"); opacityLabel.htmlFor = "floatingOpacityRange"; opacityLabel.textContent = t("overallOpacity");
    const opacityRange = document.createElement("input");
    opacityRange.type = "range"; opacityRange.id = opacityLabel.htmlFor;
    opacityRange.min = "0"; opacityRange.max = "100"; opacityRange.step = "1"; opacityRange.value = String(draft.floatingOpacity);
    opacityRange.title = t("lowerValuesAreMoreTransparent100IsFully");
    const opacityValue = document.createElement("span"); opacityValue.className = "appearance-opacity-value";
    const opacityNumber = document.createElement("input");
    opacityNumber.type = "number"; opacityNumber.id = "floatingOpacityNumber";
    opacityNumber.min = "0"; opacityNumber.max = "100"; opacityNumber.step = "1"; opacityNumber.value = opacityRange.value;
    opacityNumber.setAttribute("aria-label", t("floatingButtonOpacityPercentage"));
    const percent = document.createElement("span"); percent.textContent = "%"; percent.setAttribute("aria-hidden", "true");
    opacityRange.setAttribute("aria-valuetext", `${draft.floatingOpacity}%`);
    opacityRange.addEventListener("input", () => {
      draft.floatingOpacity = Number(opacityRange.value);
      opacityNumber.value = opacityRange.value; opacityNumber.removeAttribute("aria-invalid");
      opacityRange.setAttribute("aria-valuetext", `${draft.floatingOpacity}%`);
      status.textContent = ""; paint();
    });
    opacityNumber.addEventListener("input", () => {
      const value = opacityNumber.valueAsNumber;
      const valid = Number.isInteger(value) && value >= 0 && value <= 100;
      opacityNumber.setAttribute("aria-invalid", String(!valid));
      if (!valid) return;
      draft.floatingOpacity = value; opacityRange.value = String(value);
      opacityRange.setAttribute("aria-valuetext", `${value}%`);
      status.textContent = ""; paint();
    });
    opacityValue.append(opacityNumber, percent); opacityRow.append(opacityLabel, opacityRange, opacityValue);
    groups.get("floating")!.append(opacityRow);
    paint();
  }

  root.addEventListener("change", event => {
    if (!(event.target instanceof HTMLInputElement) || event.target.name !== "appearanceMode") return;
    draft.mode = event.target.value as AppearanceMode;
    if (draft.mode !== "system") tone = draft.mode;
    status.textContent = ""; renderEditor();
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-appearance-tone]")) {
    button.addEventListener("click", () => { tone = button.dataset.appearanceTone as AppearanceTone; status.textContent = ""; renderEditor(); });
  }
  select.addEventListener("change", () => {
    if (tone === "light") draft.lightSchemeId = select.value;
    else draft.darkSchemeId = select.value;
    status.textContent = ""; renderEditor();
  });
  duplicate.addEventListener("click", () => {
    if (draft.customSchemes.length >= 32) return;
    const source = selected();
    const id = `custom-${crypto.randomUUID()}`;
    const names = new Set([...BUILT_IN_SCHEMES, ...draft.customSchemes].map(scheme => scheme.name));
    let newName = t("copy", source.name.slice(0, 50));
    for (let n = 2; names.has(newName); n++) newName = t("numberedSchemeCopy", source.name.slice(0, 50), n);
    draft.customSchemes.push({ ...source, id, name: newName, colors: { ...source.colors },
      ...(source.opacities ? { opacities: { ...source.opacities } } : {}) });
    if (tone === "light") draft.lightSchemeId = id;
    else draft.darkSchemeId = id;
    status.textContent = t("schemeCopiedYouCanEditItsColorsAnd"); renderEditor(); name.focus(); name.select();
  });
  copyToEdit.addEventListener("click", () => duplicate.click());
  name.addEventListener("input", () => {
    const scheme = custom();
    if (!scheme) return;
    const value = name.value.trim();
    name.setAttribute("aria-invalid", String(!value));
    if (value) {
      scheme.name = value;
      select.selectedOptions[0].textContent = value;
    }
  });
  query<HTMLButtonElement>("#resetSchemeColors").addEventListener("click", () => {
    const scheme = custom();
    if (!scheme) return;
    scheme.colors = { ...getColorScheme(DEFAULT_APPEARANCE, tone).colors };
    delete scheme.opacities;
    renderEditor(); showActionStatus(status, t("defaultColorsRestoredSaveToApply"));
  });
  query<HTMLButtonElement>("#deleteScheme").addEventListener("click", () => {
    const scheme = custom();
    if (!scheme) return;
    draft.customSchemes = draft.customSchemes.filter(entry => entry.id !== scheme.id);
    if (tone === "light") draft.lightSchemeId = DEFAULT_APPEARANCE.lightSchemeId;
    else draft.darkSchemeId = DEFAULT_APPEARANCE.darkSchemeId;
    status.textContent = t("schemeDeletedAndDefaultColorsSelectedSaveTo"); renderEditor(); select.focus();
  });

  return {
    render(value) {
      draft = normalizeAppearance(value);
      menu.render(draft.popupMenu);
      status.textContent = "";
      if (!initialized) {
        tone = draft.mode === "system"
          ? typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
          : draft.mode;
        initialized = true;
      }
      for (const radio of root.querySelectorAll<HTMLInputElement>("[name='appearanceMode']")) radio.checked = radio.value === draft.mode;
      name.removeAttribute("aria-invalid");
      renderEditor();
    },
    read() {
      const invalid = root.querySelector<HTMLInputElement>("[aria-invalid='true']");
      if (invalid) {
        selectTab("colors");
        const group = invalid.closest("details");
        if (group) group.open = true;
        const panel = invalid.closest<HTMLElement>(".appearance-color-opacity");
        if (panel) {
          panel.hidden = false;
          colors.querySelector(`[aria-controls="${panel.id}"]`)?.setAttribute("aria-expanded", "true");
        }
        invalid.focus();
        throw new Error(invalid === name ? t("enterAColorSchemeName") : invalid.id === "floatingOpacityNumber" || invalid.hasAttribute("data-color-opacity-number")
          ? t("enterAnIntegerOpacityFrom0To100") : t("enterAFullHexColorSuchAs116466"));
      }
      return normalizeAppearance({ ...draft, popupMenu: menu.read() });
    }
  };
}
