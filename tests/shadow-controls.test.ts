// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations,
  collectTextSegmentsProgressive,
  renderTranslationPlaceholders,
  renderTranslations,
  setTranslationDisplayMode
} from "../src/content/dom";

beforeEach(() => {
  vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({
    display: "block", visibility: "visible", opacity: "1", color: "rgb(0, 0, 0)"
  }) as CSSStyleDeclaration);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 200, height: 40, top: 0, right: 200, bottom: 40, left: 0
  } as DOMRect);
});
afterEach(() => { clearTranslations(); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("slotted custom controls", () => {
  it.each(["div", "p", "nav"])("keeps adjacent Partner Center buttons inside their own slots within %s", async tag => {
    document.body.innerHTML = `<main><${tag} id="actions">
      <v6_he-button appearance="primary" type="button">Update</v6_he-button>
      <v6_he-button appearance="secondary" type="button">Cancel submission</v6_he-button>
      </${tag}></main>`;
    const hosts = [...document.querySelectorAll("v6_he-button")];
    const labels = hosts.map(host => host.firstChild!);
    const buttons = hosts.map(host => {
      host.attachShadow({ mode: "open" }).innerHTML = `<button type="button"><span><slot></slot></span></button>`;
      return host.shadowRoot!.querySelector("button")!;
    });
    const clicks = vi.fn();
    buttons.forEach(button => button.addEventListener("click", clicks));
    const original = document.querySelector("main")!.innerHTML;
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual(["Update", "Cancel submission"]);
    renderTranslationPlaceholders(segments);
    expect(document.querySelector("#actions > .wupage-translation")).toBeNull();
    hosts.forEach(host => expect(host.querySelector(".wupage-translation-pending")).not.toBeNull());
    renderTranslations(segments.map(({ id }, index) => ({ id, text: ["更新", "取消提交"][index] })), "replace");
    for (const mode of ["replace", "bilingual", "bilingual-accent", "replace"] as const) {
      setTranslationDisplayMode(mode);
      expect(document.querySelector("#actions > .wupage-translation")).toBeNull();
      hosts.forEach((host, index) => {
        const translation = host.querySelector(".wupage-translation")!;
        expect(translation.textContent).toBe(["更新", "取消提交"][index]);
        expect(host.shadowRoot!.querySelector("slot")!.assignedNodes()).toContain(translation);
        expect(host.firstChild).toBe(labels[index]);
        expect(host.shadowRoot!.querySelector("button")).toBe(buttons[index]);
        buttons[index].click();
      });
    }
    expect(clicks).toHaveBeenCalledTimes(8);
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
    expect(hosts.map(host => host.firstChild)).toEqual(labels);
  });

  it.each(["button", 'div role="button"'])("keeps named label slots separate from icons with a shadow %s", async control => {
    document.body.innerHTML = `<main><div id="actions"><custom-action>
      <span slot="label"><span>Cancel submission</span></span><span slot="icon" aria-hidden="true">close</span>
      </custom-action><span>Separate status text.</span></div></main>`;
    const host = document.querySelector("custom-action")!;
    host.attachShadow({ mode: "open" }).innerHTML = `<${control}><slot name="icon"></slot><slot name="label"></slot></${control.split(" ")[0]}>`;
    const original = document.querySelector("main")!.innerHTML;
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual(["Cancel submission", "Separate status text."]);
    renderTranslations(segments.map(({ id, text }) => ({ id, text: `译文：${text}` })), "replace");
    const label = host.querySelector('[slot="label"]')!;
    expect(label.querySelector(".wupage-translation")?.textContent).toBe("译文：Cancel submission");
    expect(host.querySelector('[slot="icon"]')?.textContent).toBe("close");
    expect(host.shadowRoot!.querySelector<HTMLSlotElement>('slot[name="label"]')!.assignedElements()).toEqual([label]);
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it("does not treat prose slots beside an unrelated shadow button as control labels", async () => {
    document.body.innerHTML = `<main><custom-card><p>Read <em>this complete paragraph</em> before continuing.</p></custom-card></main>`;
    document.querySelector("custom-card")!.attachShadow({ mode: "open" }).innerHTML = '<button>Dismiss</button><slot></slot>';
    const segments = await collectTextSegmentsProgressive();
    expect(segments.map(segment => segment.text)).toEqual(["Read this complete paragraph before continuing.", "Dismiss"]);
  });
});
