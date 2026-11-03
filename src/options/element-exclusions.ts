import { normalizeElementExclusions, type ElementExclusionRule } from "../shared/element-exclusions";
import { normalizeSitePattern } from "../shared/auto-translation";
import { randomId } from "../shared/random-id";
import { uiIconMarkup } from "../shared/ui-icons";

export function setupElementExclusionControls(root: HTMLElement, reveal: (field: HTMLElement) => void) {
  const list = root.querySelector<HTMLElement>("#elementExclusionRules")!;
  const message = root.querySelector<HTMLElement>("#elementExclusionStatus")!;
  const add = root.querySelector<HTMLButtonElement>("#addElementExclusion")!;
  let rules: ElementExclusionRule[] = [];
  const expanded = new Set<string>();
  const fields = new Map<string, { name: HTMLInputElement; pattern: HTMLInputElement; selectors: HTMLTextAreaElement;
    enabled: HTMLInputElement; toggle: HTMLButtonElement; expand: () => void }>();
  function sync(): void {
    for (const rule of rules) {
      const controls = fields.get(rule.id)!;
      Object.assign(rule, { name: controls.name.value, pattern: controls.pattern.value,
        selectors: controls.selectors.value.split(/\r?\n/u), enabled: controls.enabled.checked });
    }
  }
  function render(): void {
    list.replaceChildren(); fields.clear(); add.disabled = rules.length >= 100;
    if (!rules.length) {
      const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "暂无排除规则。"; list.append(empty);
    }
    for (const [index, rule] of rules.entries()) {
      const card = document.createElement("article"); card.className = "exclusion-rule"; card.dataset.ruleId = rule.id;
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
        if (open) expanded.add(rule.id); else expanded.delete(rule.id);
        details.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); toggle.title = open ? "收起规则" : "展开规则";
      };
      setExpanded(expanded.has(rule.id));
      toggle.addEventListener("click", () => setExpanded(details.hidden));
      const enabledLabel = document.createElement("label"); enabledLabel.className = "setting-toggle";
      const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = rule.enabled; enabled.setAttribute("role", "switch");
      enabled.setAttribute("aria-label", `启用第 ${index + 1} 条排除规则`);
      const track = document.createElement("span"); track.className = "setting-toggle-control"; track.setAttribute("aria-hidden", "true");
      enabledLabel.title = "启用规则"; enabledLabel.append(enabled, track);
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary exclusion-rule-remove";
      remove.innerHTML = uiIconMarkup("trash"); remove.title = "删除规则"; remove.setAttribute("aria-label", `删除第 ${index + 1} 条排除规则`);
      heading.append(toggle, enabledLabel, remove);
      const grid = document.createElement("div"); grid.className = "grid";
      const input = (caption: string, value: string, placeholder: string, maxLength: number) => {
        const label = document.createElement("label"); label.textContent = caption;
        const control = document.createElement("input"); control.type = "text"; control.value = value; control.placeholder = placeholder; control.maxLength = maxLength;
        control.setAttribute("aria-label", `第 ${index + 1} 条规则${caption}`); label.append(control); grid.append(label); return control;
      };
      const name = input("名称", rule.name, "例如：侧边导航栏", 80); name.dataset.field = "name";
      const pattern = input("网站", rule.pattern, "example.com 或 https://example.com/docs/*", 2048); pattern.dataset.field = "pattern";
      const selectorLabel = document.createElement("label"); selectorLabel.textContent = "排除元素";
      const selectors = document.createElement("textarea"); selectors.rows = 3; selectors.spellcheck = false; selectors.value = rule.selectors.join("\n");
      selectors.placeholder = '.sidebar\n[data-region="recommendations"]'; selectors.dataset.field = "selectors";
      selectors.setAttribute("aria-label", `第 ${index + 1} 条规则排除元素`); selectors.setAttribute("aria-describedby", "elementExclusionSelectorHelp elementExclusionStatus");
      selectorLabel.append(selectors); details.append(grid, selectorLabel); card.append(heading, details); list.append(card);
      fields.set(rule.id, { name, pattern, selectors, enabled, toggle, expand: () => setExpanded(true) });
      const updateSummary = (): void => {
        title.textContent = name.value.trim() || "新规则"; website.textContent = pattern.value.trim() || "尚未填写网站";
        title.title = title.textContent; website.title = website.textContent;
      };
      updateSummary();
      for (const control of [name, pattern, selectors]) control.addEventListener("input", () => {
        control.removeAttribute("aria-invalid"); message.textContent = ""; updateSummary();
      });
      remove.addEventListener("click", () => {
        sync(); rules = rules.filter(entry => entry !== rule); expanded.delete(rule.id); render(); message.textContent = "";
        (fields.get(rules[Math.min(index, rules.length - 1)]?.id)?.toggle ?? add).focus();
      });
    }
  }
  add.addEventListener("click", () => {
    if (rules.length >= 100) return;
    sync();
    const rule = { id: `exclusion-${randomId()}`, name: "", pattern: "", selectors: [], enabled: true };
    rules.push(rule); expanded.add(rule.id); render(); message.textContent = ""; fields.get(rule.id)!.name.focus();
  });
  return {
    render(value: ElementExclusionRule[] | undefined): void {
      rules = normalizeElementExclusions(value);
      for (const id of expanded) if (!rules.some(rule => rule.id === id)) expanded.delete(id);
      message.textContent = ""; render();
    },
    read(): ElementExclusionRule[] {
      sync();
      const fail = (field: HTMLElement, text: string): never => {
        const id = field.closest<HTMLElement>(".exclusion-rule")?.dataset.ruleId;
        if (id) fields.get(id)?.expand();
        message.textContent = text; field.setAttribute("aria-invalid", "true"); reveal(field); field.focus(); throw new Error(text);
      };
      const result = rules.map((rule, index) => {
        const controls = fields.get(rule.id)!;
        let pattern: string;
        try { pattern = normalizeSitePattern(rule.pattern); }
        catch (error) { return fail(controls.pattern, `第 ${index + 1} 条规则：${error instanceof Error ? error.message : String(error)}`); }
        const selectors = [...new Set(rule.selectors.map(selector => selector.trim()).filter(Boolean))];
        if (!selectors.length) fail(controls.selectors, `第 ${index + 1} 条规则：请填写至少一个排除元素的 CSS 选择器。`);
        if (selectors.length > 100) fail(controls.selectors, `第 ${index + 1} 条规则：最多填写 100 个选择器。`);
        const probe = document.createElement("div");
        for (const [line, selector] of selectors.entries()) {
          try { if (selector.length > 4096) throw new Error(); probe.matches(selector); }
          catch { fail(controls.selectors, `第 ${index + 1} 条规则：第 ${line + 1} 个 CSS 选择器无效，请检查后重试。`); }
        }
        return { ...rule, pattern, selectors, name: rule.name.trim() || pattern };
      });
      message.textContent = ""; return normalizeElementExclusions(result);
    }
  };
}
