// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations,
  collectAdditionalTextSegmentsProgressive,
  collectTextSegmentsProgressive,
  hasPageTranslations,
  hideTranslations,
  invalidateStaleSegments,
  renderTranslations,
  restoreTranslations,
  setTranslationDisplayMode
} from "../src/content/dom";

const labels = ["Extension overview", "Packages", "Availability", "Properties", "Privacy", "Store listings", "Analytics", "Reviews"];
const translated = ["扩展概述", "程序包", "可用性", "属性", "隐私", "商店条目", "分析", "评论"];
const fixture = () => `<main><app-focus-nav><v6_he-task-menu task-menu item-type="page" class="he-task-menu"><div id="items">${labels.map((label, i) =>
  `<v6_he-task-item task-item role="listitem" tabindex="0" aria-label="${label}"${i === 0 ? ' selected' : ''}>${label}${i > 0 && i < 6
    ? '<v6_he-icon slot="end" name="completedsolid" aria-label="Step Completed"></v6_he-icon>' : ''}</v6_he-task-item>`).join("")}</div></v6_he-task-menu></app-focus-nav></main>`;

describe("custom task menu translation", () => {
  beforeEach(() => {
    document.body.innerHTML = fixture();
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({display:"block",visibility:"visible",opacity:"1",color:"rgb(0, 0, 0)"}) as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({width:280,height:36,top:0,left:0,right:280,bottom:36,x:0,y:0,toJSON:()=>({})});
  });
  afterEach(() => {clearTranslations(); vi.restoreAllMocks(); document.body.innerHTML="";});

  it("translates eight task items independently without flattening the menu", async () => {
    const original=document.querySelector("main")!.innerHTML;
    const items=[...document.querySelectorAll("[task-item]")], icons=[...document.querySelectorAll("[slot='end']")];
    const textNodes=items.map(item=>item.firstChild);
    const segments=(await collectTextSegmentsProgressive());
    expect(segments.map(s=>s.text)).toEqual(labels);
    renderTranslations(segments.map(({id},i)=>({id,text:translated[i]})),"replace");
    for(const mode of ["replace","bilingual","bilingual-accent","replace"] as const) {
      setTranslationDisplayMode(mode);
      expect(document.querySelector('#items > .wupage-translation')).toBeNull();
      expect(items.map(item=>(mode==="replace"?item:item.querySelector('.wupage-translation'))?.textContent)).toEqual(translated);
      expect(items.map(item=>item.getAttribute('aria-label'))).toEqual(labels);
      expect(items.every((item,i)=>item.firstChild===textNodes[i])).toBe(true);
      expect(icons.every(icon=>icon.isConnected&&icon.getAttribute('slot')==='end')).toBe(true);
      expect(invalidateStaleSegments()).toEqual([]);
      expect((await collectAdditionalTextSegmentsProgressive([document.body]))).toEqual([]);
      expect(hasPageTranslations()).toBe(true);
    }
    hideTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
    restoreTranslations("replace");
    expect(items.map(item=>item.textContent)).toEqual(translated);
    clearTranslations();
    expect(document.querySelector("main")!.innerHTML).toBe(original);
  });

  it("keeps a new host label when invalidating an in-place text replacement", async () => {
    const segments=(await collectTextSegmentsProgressive());
    renderTranslations(segments.map(({id},i)=>({id,text:translated[i]})),"replace");
    const first=document.querySelector('[task-item]')!;
    first.firstChild!.textContent="Updated overview";
    expect(invalidateStaleSegments()).toContain(segments[0].id);
    expect(first.textContent).toBe("Updated overview");
    expect((await collectAdditionalTextSegmentsProgressive([document.body])).map(s=>s.text)).toEqual(["Updated overview"]);
  });
});
