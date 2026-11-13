// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranslations, collectTextSegmentsProgressive, hideTranslations, invalidateStaleSegments,
  renderTranslations, restoreTranslations, setTranslationDisplayMode
} from "../src/content/dom";
import { InlineTranslationPlan } from "../src/content/inline-translation";
import { structuredTranslation } from "./helpers/structured-translation";

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 30));
});
afterEach(() => { clearTranslations(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("inline comment boundaries", () => {
  it.each(["replace", "bilingual", "bilingual-accent"] as const)(
    "preserves a random.org-style link list with a trailing comment, starting in %s", async mode => {
      // The homepage's Contact and Help paragraph ends with a commented-out BR.
      document.body.innerHTML = `<div class="mainindent"><p id="source">
        <a href="/faq/">FAQ</a> contains answers to frequently asked questions<br>
        <a href="/newsletter/">Newsletter</a> appears at random intervals<br>
        <a href="/mads/">Contact Details</a> in case you want to get in touch<br>
        <!-- <br> -->
      </p></div>`;
      const original = document.body.innerHTML, source = document.querySelector("#source")!;
      const children = [...source.childNodes], links = [...source.querySelectorAll("a")];
      const breaks = [...source.querySelectorAll("br")];
      const comment = children.find(node => node instanceof Comment)!;
      const tail = children.slice(children.indexOf(breaks.at(-1)!) + 1);
      const click = vi.fn((event: Event) => event.preventDefault());
      links[0].addEventListener("click", click);
      const segments = await collectTextSegmentsProgressive();
      expect(segments).toHaveLength(1);
      expect(segments[0].requestText).toContain("⟪WUPAGEOPEN0⟫FAQ⟪WUPAGECLOSE0⟫");
      expect(segments[0].requestText).not.toContain("<!--");
      renderTranslations(segments.map(segment => ({ id: segment.id,
        text: structuredTranslation(segment.requestText!, "对应部分的译文") })), mode);

      for (const next of [mode, "replace", "bilingual", "bilingual-accent", "replace"] as const) {
        setTranslationDisplayMode(next);
        expect(invalidateStaleSegments()).toEqual([]);
        expect([...source.querySelectorAll("a")]).toEqual(links);
        expect(links.map(link => link.getAttribute("href"))).toEqual(["/faq/", "/newsletter/", "/mads/"]);
        expect(links.every(link => link.isConnected && Boolean(link.textContent?.trim()))).toBe(true);
        expect([...source.querySelectorAll("br")]).toEqual(breaks);
        expect([...source.childNodes].slice(-tail.length)).toEqual(tail);
        expect(comment.textContent).toBe(" <br> ");
        if (next === "replace") expect(links.map(link => link.textContent)).toEqual(Array(3).fill("对应部分的译文"));
        else {
          const copy = document.querySelector(".wupage-translation")!;
          expect([...copy.querySelectorAll("a")].map(link => link.getAttribute("href")))
            .toEqual(["/faq/", "/newsletter/", "/mads/"]);
          expect(copy.querySelectorAll("br")).toHaveLength(3);
        }
        hideTranslations();
        expect(links.map(link => link.textContent)).toEqual(["FAQ", "Newsletter", "Contact Details"]);
        restoreTranslations(next);
      }
      links[0].dispatchEvent(new MouseEvent("click", { cancelable: true }));
      expect(click).toHaveBeenCalledOnce();
      clearTranslations();
      expect(document.body.innerHTML).toBe(original);
      expect([...source.childNodes]).toEqual(children);
    }
  );

  it("keeps leading, trailing and nested comment anchors around reordered formatting", () => {
    document.body.innerHTML = '<p><!--start--> Before <a href="/guide"><em><!--inner-->the guide<!--/inner--></em></a> after. <!--end--></p>';
    const block = document.querySelector("p")!, original = block.innerHTML;
    const nodes = [...block.childNodes], nested = [...block.querySelector("em")!.childNodes];
    const accepted = new Set<Text>();
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) accepted.add(walker.currentNode as Text);
    const plan = InlineTranslationPlan.create(block, accepted)!;
    expect(plan.source).toBe("Before ⟪WUPAGEOPEN0⟫⟪WUPAGEOPEN1⟫the guide⟪WUPAGECLOSE1⟫⟪WUPAGECLOSE0⟫ after.");
    expect(plan.write("⟪WUPAGEOPEN0⟫⟪WUPAGEOPEN1⟫指南⟪WUPAGECLOSE1⟫⟪WUPAGECLOSE0⟫前后的说明。")).toBeDefined();
    expect(block.firstChild).toBe(nodes[0]);
    expect(block.lastChild).toBe(nodes.at(-1));
    expect([...block.querySelector("em")!.childNodes]).toEqual(nested);
    expect(plan.isCurrent()).toBe(true);
    plan.restore();
    expect(block.innerHTML).toBe(original);
    expect([...block.childNodes]).toEqual(nodes);
  });

  it("rejects a changed comment before writing a pending translation", () => {
    document.body.innerHTML = '<p>Read <a href="/guide">the guide</a>.<!--anchor--></p>';
    const block = document.querySelector("p")!;
    const accepted = new Set([block.firstChild as Text, block.querySelector("a")!.firstChild as Text,
      block.querySelector("a")!.nextSibling as Text]);
    const plan = InlineTranslationPlan.create(block, accepted)!;
    block.lastChild!.textContent = "updated anchor";
    const updated = block.innerHTML;
    expect(plan.isCurrent()).toBe(false);
    expect(plan.write(plan.source)).toBeUndefined();
    expect(block.innerHTML).toBe(updated);
  });

  it("keeps comments inside a sentence as a boundary against reordering", () => {
    document.body.innerHTML = '<p>Read <!--region--><a href="/guide">the guide</a> carefully.</p>';
    const block = document.querySelector("p")!;
    const original = block.innerHTML;
    const accepted = new Set([block.firstChild as Text, block.querySelector("a")!.firstChild as Text,
      block.lastChild as Text]);
    expect(InlineTranslationPlan.create(block, accepted)).toBeUndefined();
    expect(block.innerHTML).toBe(original);
  });
});
