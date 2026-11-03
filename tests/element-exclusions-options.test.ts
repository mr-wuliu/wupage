// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupElementExclusionControls } from "../src/options/element-exclusions";
import { normalizeSettings } from "../src/shared/settings";

beforeEach(() => {
  document.body.innerHTML = readFileSync(resolve(process.cwd(), "options.html"), "utf8");
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const field = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

it("shows only the X preset and keeps deletion and disablement when saved", () => {
  const controls = setupElementExclusionControls(field("#elementExclusionSettings"), () => {});
  controls.render(undefined);
  expect(document.querySelectorAll(".exclusion-rule")).toHaveLength(1);
  expect(field<HTMLElement>(".exclusion-rule-details").hidden).toBe(true);
  expect(field<HTMLButtonElement>(".exclusion-rule-toggle").getAttribute("aria-expanded")).toBe("false");
  expect(field<HTMLElement>(".exclusion-rule-name").textContent).toBe("X 侧边导航栏");
  expect(field<HTMLElement>(".exclusion-rule-site").textContent).toBe("x.com");
  expect(field<HTMLInputElement>('[data-field="pattern"]').value).toBe("x.com");
  expect(field<HTMLTextAreaElement>('[data-field="selectors"]').value).toBe('header[role="banner"]');
  field<HTMLInputElement>('.exclusion-rule input[type="checkbox"]').click();
  expect(field<HTMLElement>(".exclusion-rule-details").hidden).toBe(true);
  const saved = normalizeSettings({ elementExclusions: controls.read() });
  controls.render(saved.elementExclusions);
  expect(field<HTMLInputElement>('.exclusion-rule input[type="checkbox"]').checked).toBe(false);
  field<HTMLButtonElement>(".exclusion-rule-remove").click();
  expect(normalizeSettings({ elementExclusions: controls.read() }).elementExclusions).toEqual([]);
  controls.render([]); expect(document.querySelectorAll(".exclusion-rule")).toHaveLength(0);
});

it("edits arbitrary sites and multiple selectors without losing other rule drafts", () => {
  const controls = setupElementExclusionControls(field("#elementExclusionSettings"), () => {});
  controls.render(undefined);
  field<HTMLInputElement>('[data-field="name"]').value = "X navigation";
  field<HTMLButtonElement>("#addElementExclusion").click();
  const added = document.querySelectorAll(".exclusion-rule")[1];
  expect(added.querySelector<HTMLElement>(".exclusion-rule-details")!.hidden).toBe(false);
  expect(field<HTMLElement>(".exclusion-rule-details").hidden).toBe(true);
  added.querySelector<HTMLInputElement>('[data-field="name"]')!.value = "推荐区域";
  added.querySelector<HTMLInputElement>('[data-field="pattern"]')!.value = "EXAMPLE.com/articles/*";
  added.querySelector<HTMLTextAreaElement>('[data-field="selectors"]')!.value = ".recommendations\n[data-region='ads']\n.recommendations";
  const rules = controls.read();
  expect(rules[0].name).toBe("X navigation");
  expect(rules[1]).toMatchObject({ name: "推荐区域", pattern: "example.com/articles/*", selectors: [".recommendations", "[data-region='ads']"], enabled: true });
});

it("reveals invalid website or selector fields instead of saving a broken rule", () => {
  const reveal = vi.fn();
  const controls = setupElementExclusionControls(field("#elementExclusionSettings"), reveal);
  controls.render(undefined);
  const pattern = field<HTMLInputElement>('[data-field="pattern"]'); pattern.value = "https://";
  expect(() => controls.read()).toThrow("第 1 条规则"); expect(reveal).toHaveBeenLastCalledWith(pattern);
  expect(pattern.getAttribute("aria-invalid")).toBe("true");
  expect(field<HTMLElement>(".exclusion-rule-details").hidden).toBe(false);
  pattern.value = "example.com";
  const selectors = field<HTMLTextAreaElement>('[data-field="selectors"]'); selectors.value = "div..invalid";
  expect(() => controls.read()).toThrow("CSS 选择器无效"); expect(reveal).toHaveBeenLastCalledWith(selectors);
  selectors.value = ".valid\n[data-ad]";
  expect(controls.read()[0].selectors).toEqual([".valid", "[data-ad]"]);
});

it("expands details on demand and retains unsaved edits when collapsed or other rules are added", () => {
  const controls = setupElementExclusionControls(field("#elementExclusionSettings"), () => {});
  controls.render(undefined);
  const toggle = field<HTMLButtonElement>(".exclusion-rule-toggle");
  toggle.click(); expect(field<HTMLElement>(".exclusion-rule-details").hidden).toBe(false);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const name = field<HTMLInputElement>('[data-field="name"]'); name.value = "我的导航规则"; name.dispatchEvent(new Event("input"));
  const pattern = field<HTMLInputElement>('[data-field="pattern"]'); pattern.value = "example.com"; pattern.dispatchEvent(new Event("input"));
  expect(field<HTMLElement>(".exclusion-rule-name").textContent).toBe("我的导航规则");
  expect(field<HTMLElement>(".exclusion-rule-site").textContent).toBe("example.com");
  toggle.click(); expect(field<HTMLElement>(".exclusion-rule-details").hidden).toBe(true);
  field<HTMLButtonElement>("#addElementExclusion").click();
  expect(field<HTMLElement>(".exclusion-rule-details").hidden).toBe(true);
  expect(field<HTMLInputElement>('[data-field="name"]').value).toBe("我的导航规则");
  document.querySelectorAll<HTMLButtonElement>(".exclusion-rule-remove")[1].click();
  expect(document.activeElement).toBe(field<HTMLButtonElement>(".exclusion-rule-toggle"));
  expect(controls.read()[0]).toMatchObject({ name: "我的导航规则", pattern: "example.com" });
});
