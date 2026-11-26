import { t } from "../shared/i18n";
import { MAX_GLOSSARY_ENTRIES, MAX_GLOSSARY_GROUPS, MAX_GLOSSARY_NAME, MAX_GLOSSARY_TEXT,
  normalizeGlossaryGroups, validGlossaryText, type GlossaryEntry, type GlossaryGroup } from "../shared/glossary";
import { normalizeRegionSitePattern } from "../shared/region-site-pattern";
import { randomId } from "../shared/random-id";
import { uiIconMarkup, type UiIconName } from "../shared/ui-icons";

export function setupGlossaryControls(root: HTMLElement, reveal: (field: HTMLElement) => void) {
  const list = root.querySelector<HTMLElement>("#glossaryGroups")!;
  const add = root.querySelector<HTMLButtonElement>("#addGlossaryGroup")!;
  const status = root.querySelector<HTMLElement>("#glossaryStatus")!;
  const groups = new Map<string, ReturnType<typeof addGroup>>();
  const captions = { site: t("site"), source: t("glossarySource"), target: t("glossaryTarget") };

  function field(caption: string, value: string, maxLength: number) {
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = caption;
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.maxLength = maxLength;
    input.addEventListener("input", () => {
      input.removeAttribute("aria-invalid");
      status.textContent = "";
    });
    label.append(text, input);
    return { label, input };
  }

  function button(icon: UiIconName, caption: string, iconOnly = false): HTMLButtonElement {
    const control = document.createElement("button");
    control.type = "button";
    control.innerHTML = uiIconMarkup(icon);
    control.className = iconOnly ? "secondary exclusion-rule-remove" : "secondary exclusion-rule-add";
    if (iconOnly) {
      control.title = caption;
      control.setAttribute("aria-label", caption);
    } else control.append(caption);
    return control;
  }

  function addGroup(group: GlossaryGroup, open = false) {
    const card = document.createElement("article");
    card.className = "glossary-group";
    const heading = document.createElement("div");
    heading.className = "glossary-group-heading";
    const name = field(t("glossaryGroupName"), group.name, MAX_GLOSSARY_NAME);
    const toggle = document.createElement("label");
    toggle.className = "setting-toggle";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = group.enabled;
    enabled.setAttribute("role", "switch");
    enabled.setAttribute("aria-label", t("enableGlossaryGroup"));
    const track = document.createElement("span");
    track.className = "setting-toggle-control";
    track.setAttribute("aria-hidden", "true");
    const switchLabel = document.createElement("span");
    switchLabel.textContent = t("enable");
    toggle.append(switchLabel, enabled, track);
    const remove = button("trash", t("deleteGlossaryGroup"), true);
    remove.addEventListener("click", () => {
      groups.delete(group.id);
      card.remove();
      updateGroupLimit();
      status.textContent = "";
      add.focus();
    });
    heading.append(name.label, toggle, remove);

    const details = document.createElement("details");
    details.open = open;
    const summary = document.createElement("summary");
    const rows = document.createElement("div");
    rows.className = "glossary-entries";
    const columns = document.createElement("div");
    columns.className = "glossary-entry-columns";
    columns.setAttribute("aria-hidden", "true");
    for (const caption of Object.values(captions)) {
      const column = document.createElement("span");
      column.textContent = caption;
      columns.append(column);
    }
    rows.append(columns);
    const addEntryButton = button("plus", t("addGlossaryEntry"));
    const entries = new Map<string, ReturnType<typeof addEntry>>();
    const updateEntries = () => {
      summary.textContent = t("glossaryEntryCount", entries.size);
      rows.hidden = entries.size === 0;
      addEntryButton.disabled = entries.size >= MAX_GLOSSARY_ENTRIES;
    };

    function addEntry(entry: GlossaryEntry) {
      const row = document.createElement("div");
      row.className = "glossary-entry";
      const site = field(captions.site, entry.site === "*" ? "" : entry.site, 2048);
      site.input.placeholder = "*";
      site.input.setAttribute("aria-describedby", "glossarySiteHelp");
      site.input.spellcheck = false;
      const source = field(captions.source, entry.source, MAX_GLOSSARY_TEXT);
      const target = field(captions.target, entry.target, MAX_GLOSSARY_TEXT);
      const deleteEntry = button("trash", t("deleteGlossaryEntry"), true);
      deleteEntry.addEventListener("click", () => {
        entries.delete(entry.id);
        row.remove();
        updateEntries();
        status.textContent = "";
        addEntryButton.focus();
      });
      row.append(site.label, source.label, target.label, deleteEntry);
      rows.append(row);
      return { site: site.input, source: source.input, target: target.input };
    }

    for (const entry of group.entries) entries.set(entry.id, addEntry(entry));
    addEntryButton.addEventListener("click", () => {
      if (entries.size >= MAX_GLOSSARY_ENTRIES) return;
      const id = randomId();
      const entry = addEntry({ id, site: "*", source: "", target: "" });
      entries.set(id, entry);
      updateEntries();
      entry.source.focus();
    });
    updateEntries();
    details.append(summary, rows, addEntryButton);
    card.append(heading, details);
    list.append(card);
    return { name: name.input, enabled, details, entries };
  }

  function updateGroupLimit(): void {
    add.disabled = groups.size >= MAX_GLOSSARY_GROUPS;
  }

  function fail(field: HTMLInputElement, message: string): never {
    const details = field.closest("details");
    if (details) details.open = true;
    status.textContent = message;
    field.setAttribute("aria-invalid", "true");
    reveal(field);
    field.focus();
    throw new Error(message);
  }

  add.addEventListener("click", () => {
    if (groups.size >= MAX_GLOSSARY_GROUPS) return;
    const id = randomId();
    const controls = addGroup({ id, name: "", enabled: true, entries: [] }, true);
    groups.set(id, controls);
    updateGroupLimit();
    controls.name.focus();
  });

  return {
    render(value: GlossaryGroup[] | undefined): void {
      const open = new Set([...groups].filter(([, controls]) => controls.details.open).map(([id]) => id));
      groups.clear();
      list.replaceChildren();
      for (const group of normalizeGlossaryGroups(value)) groups.set(group.id, addGroup(group, open.has(group.id)));
      updateGroupLimit();
      status.textContent = "";
    },
    read(): GlossaryGroup[] {
      status.textContent = "";
      return [...groups].map(([id, group]) => {
        const name = group.name.value.trim();
        if (!name) fail(group.name, t("enterGlossaryGroupName"));
        const entries = [...group.entries].map(([id, entry]) => {
          let site: string;
          try { site = normalizeRegionSitePattern(entry.site.value); }
          catch (error) { return fail(entry.site, error instanceof Error ? error.message : String(error)); }
          const source = entry.source.value.trim(), target = entry.target.value.trim();
          if (!validGlossaryText(source)) fail(entry.source, t("enterGlossarySource"));
          if (!validGlossaryText(target)) fail(entry.target, t("enterGlossaryTarget"));
          return { id, site, source, target };
        });
        return { id, name, enabled: group.enabled.checked, entries };
      });
    }
  };
}
