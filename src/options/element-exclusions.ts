import { t } from "../shared/i18n";
import { normalizeElementExclusions, normalizeElementInclusions, type ElementRule, type ElementRuleSettings } from "../shared/element-exclusions";
import { normalizeSitePattern } from "../shared/auto-translation";
import { randomId } from "../shared/random-id";
import { uiIconMarkup } from "../shared/ui-icons";

type Action = "exclude" | "include";
type RuleDraft = ElementRule & { action: Action; key: string };
const ACTION_LABEL = { exclude: "keepRegionOriginal", include: "forceRegionTranslation" } as const;

export function setupElementRuleControls(root: HTMLElement, reveal: (field: HTMLElement) => void) {
  const list = root.querySelector<HTMLElement>("#elementExclusionRules")!;
  const message = root.querySelector<HTMLElement>("#elementExclusionStatus")!;
  const add = { exclude: root.querySelector<HTMLButtonElement>("#addElementExclusion")!,
    include: root.querySelector<HTMLButtonElement>("#addElementInclusion")! };
  let rules: RuleDraft[] = [];
  const expanded = new Set<string>();
  const fields = new Map<string, { name: HTMLInputElement; pattern: HTMLInputElement; selectors: HTMLTextAreaElement;
    action: HTMLSelectElement; enabled: HTMLInputElement; toggle: HTMLButtonElement; expand: () => void }>();
  function sync(): void {
    for (const rule of rules) {
      const controls = fields.get(rule.key)!;
      Object.assign(rule, { name: controls.name.value, pattern: controls.pattern.value,
        selectors: controls.selectors.value.split(/\r?\n/u), enabled: controls.enabled.checked, action: controls.action.value });
    }
  }
  function updateAddButtons(): void {
    for (const action of ["exclude", "include"] as const) {
      add[action].disabled = [...fields.values()].filter(controls => controls.action.value === action).length >= 100;
    }
  }
  function render(): void {
    list.replaceChildren(); fields.clear();
    if (!rules.length) {
      const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = t("noRegionRulesYet"); list.append(empty);
    }
    for (const [index, rule] of rules.entries()) {
      const card = document.createElement("article"); card.className = "exclusion-rule"; card.dataset.ruleId = rule.key;
      const heading = document.createElement("div"); heading.className = "exclusion-rule-heading";
      const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "exclusion-rule-toggle";
      const summary = document.createElement("span"); summary.className = "exclusion-rule-summary";
      const title = document.createElement("span"); title.className = "exclusion-rule-name";
      const website = document.createElement("span"); website.className = "exclusion-rule-site";
      summary.append(title, website);
      const arrow = document.createElement("span"); arrow.className = "exclusion-rule-arrow"; arrow.innerHTML = uiIconMarkup("arrow-down-03");
      toggle.append(summary, arrow);
      const details = document.createElement("div"); details.className = "exclusion-rule-details"; details.id = `element-exclusion-detail-${index}`;
      toggle.setAttribute("aria-controls", details.id);
      const setExpanded = (open: boolean): void => {
        if (open) expanded.add(rule.key); else expanded.delete(rule.key);
        details.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); toggle.title = open ? t("collapseRule") : t("expandRule");
      };
      setExpanded(expanded.has(rule.key));
      toggle.addEventListener("click", () => setExpanded(details.hidden));
      const enabledLabel = document.createElement("label"); enabledLabel.className = "setting-toggle";
      const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = rule.enabled; enabled.setAttribute("role", "switch");
      enabled.setAttribute("aria-label", t("enableRegionRule", index + 1));
      const track = document.createElement("span"); track.className = "setting-toggle-control"; track.setAttribute("aria-hidden", "true");
      enabledLabel.title = t("enableRule"); enabledLabel.append(enabled, track);
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary exclusion-rule-remove";
      remove.innerHTML = uiIconMarkup("trash"); remove.title = t("deleteRule"); remove.setAttribute("aria-label", t("deleteRegionRule", index + 1));
      heading.append(toggle, enabledLabel, remove);
      const grid = document.createElement("div"); grid.className = "grid";
      const input = (caption: string, value: string, placeholder: string, maxLength: number) => {
        const label = document.createElement("label"); label.textContent = caption;
        const control = document.createElement("input"); control.type = "text"; control.value = value; control.placeholder = placeholder; control.maxLength = maxLength;
        control.setAttribute("aria-label", t("rule", index + 1, caption)); label.append(control); grid.append(label); return control;
      };
      const name = input(t("name"), rule.name, "", 80); name.dataset.field = "name";
      const pattern = input(t("site"), rule.pattern, t("exampleComOrHttpsExampleComDocs"), 2048); pattern.dataset.field = "pattern";
      const actionLabel = document.createElement("label"); actionLabel.textContent = t("regionRuleAction");
      const action = document.createElement("select"); action.dataset.field = "action";
      action.setAttribute("aria-label", t("rule", index + 1, t("regionRuleAction")));
      for (const type of ["exclude", "include"] as const) action.add(new Option(t(ACTION_LABEL[type]), type));
      action.value = rule.action; actionLabel.append(action);
      const selectorLabel = document.createElement("label"); selectorLabel.textContent = t("regionRuleSelectors");
      const selectors = document.createElement("textarea"); selectors.rows = 3; selectors.spellcheck = false; selectors.value = rule.selectors.join("\n");
      selectors.dataset.field = "selectors";
      selectors.setAttribute("aria-label", t("rule", index + 1, t("regionRuleSelectors"))); selectors.setAttribute("aria-describedby", "elementExclusionSelectorHelp elementExclusionStatus");
      selectorLabel.append(selectors); details.append(grid, actionLabel, selectorLabel); card.append(heading, details); list.append(card);
      fields.set(rule.key, { name, pattern, selectors, action, enabled, toggle, expand: () => setExpanded(true) });
      const updateSummary = (): void => {
        const include = action.value === "include";
        title.textContent = name.value.trim() || t("newRule");
        website.textContent = `${t(ACTION_LABEL[include ? "include" : "exclude"])} · ${pattern.value.trim() || t("siteNotEntered")}`;
        selectors.placeholder = include ? '.settings-dialog\n[role="dialog"] .field-label' : '.sidebar\n[data-region="recommendations"]';
        title.title = title.textContent; website.title = website.textContent;
      };
      updateSummary();
      for (const control of [name, pattern, selectors]) control.addEventListener("input", () => {
        control.removeAttribute("aria-invalid"); message.textContent = ""; updateSummary();
      });
      action.addEventListener("change", () => {
        action.removeAttribute("aria-invalid"); message.textContent = ""; updateSummary(); updateAddButtons();
      });
      remove.addEventListener("click", () => {
        sync(); rules = rules.filter(entry => entry !== rule); expanded.delete(rule.key); render(); message.textContent = "";
        (fields.get(rules[Math.min(index, rules.length - 1)]?.key)?.toggle ?? add[rule.action]).focus();
      });
    }
    updateAddButtons();
  }
  for (const action of ["exclude", "include"] as const) add[action].addEventListener("click", () => {
    sync();
    if (rules.filter(rule => rule.action === action).length >= 100) return;
    const id = randomId();
    const rule = { id, key: `${action}:${id}`, action, name: "", pattern: "", selectors: [], enabled: true };
    rules.push(rule); expanded.add(rule.key); render(); message.textContent = ""; fields.get(rule.key)!.name.focus();
  });
  return {
    render(settings: ElementRuleSettings): void {
      rules = [
        ...normalizeElementExclusions(settings.elementExclusions).map(rule => ({ ...rule, action: "exclude" as const, key: `exclude:${rule.id}` })),
        ...normalizeElementInclusions(settings.elementInclusions).map(rule => ({ ...rule, action: "include" as const, key: `include:${rule.id}` }))
      ];
      for (const key of expanded) if (!rules.some(rule => rule.key === key)) expanded.delete(key);
      message.textContent = ""; render();
    },
    read(): Required<ElementRuleSettings> {
      sync();
      const fail = (field: HTMLElement, text: string): never => {
        const id = field.closest<HTMLElement>(".exclusion-rule")?.dataset.ruleId;
        if (id) fields.get(id)?.expand();
        message.textContent = text; field.setAttribute("aria-invalid", "true"); reveal(field); field.focus(); throw new Error(text);
      };
      const result: Record<Action, ElementRule[]> = { exclude: [], include: [] };
      for (const [index, rule] of rules.entries()) {
        const controls = fields.get(rule.key)!;
        const entries = result[rule.action];
        if (entries.length >= 100) fail(controls.action, t("tooManyRegionRulesForAction"));
        let pattern: string;
        try { pattern = normalizeSitePattern(rule.pattern); }
        catch (error) { return fail(controls.pattern, t("ruleError", index + 1, error instanceof Error ? error.message : String(error))); }
        const selectors = [...new Set(rule.selectors.map(selector => selector.trim()).filter(Boolean))];
        if (!selectors.length) fail(controls.selectors, t("ruleEnterAtLeastOneCssSelector", index + 1));
        if (selectors.length > 100) fail(controls.selectors, t("ruleEnterUpTo100Selectors", index + 1));
        const probe = document.createElement("div");
        for (const [line, selector] of selectors.entries()) {
          try { if (selector.length > 4096) throw new Error(); probe.matches(selector); }
          catch { fail(controls.selectors, t("ruleCssSelectorIsInvalidCheckItAnd", index + 1, line + 1)); }
        }
        entries.push({ id: rule.id, enabled: rule.enabled, pattern, selectors, name: rule.name.trim() || pattern });
      }
      message.textContent = "";
      return { elementExclusions: normalizeElementExclusions(result.exclude), elementInclusions: normalizeElementInclusions(result.include) };
    }
  };
}
