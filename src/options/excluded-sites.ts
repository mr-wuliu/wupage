import { t } from "../shared/i18n";
import { uiIconMarkup } from "../shared/ui-icons";

/** Keep removals in the form until the user saves the settings. */
export function setupExcludedSites(group: HTMLElement) {
  const list = group.querySelector("ul")!;
  let sites: string[] = [];
  function render(value: readonly string[] = []): void {
    sites = [...value];
    group.hidden = sites.length === 0;
    list.replaceChildren();
    for (const site of sites) {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = label.title = site;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.innerHTML = uiIconMarkup("cross");
      remove.title = t("removeExclusionFor", site);
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => render(sites.filter(value => value !== site)));
      row.append(label, remove);
      list.append(row);
    }
  }
  return { render, read: () => [...sites] };
}
