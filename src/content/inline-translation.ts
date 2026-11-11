import { normalizeProtectedText } from "../shared/protected-text";
import { TextFlowSnapshot } from "./text-flow";

const owned = (node: Node) => node instanceof Element && node.classList.contains("wupage-translation");
const children = (element: Element) => [...element.childNodes].filter(node => !owned(node));
const attributes = (element: Element) => JSON.stringify([...element.attributes]
  .filter(attribute => !attribute.name.startsWith("data-wupage-")).map(attribute => [attribute.name, attribute.value]));

interface Snapshot {
  element: Element;
  children: Node[];
  expected: Node[];
  attributes: string;
}
interface Piece { text?: string; id?: number; atom?: number; children?: Piece[] }
interface ProtectedInlineNode { marker: string; sourceNode: Node }

/** A closed set of original nodes. Translator output never supplies DOM or attributes. */
export class InlineTranslationPlan {
  readonly source: string;
  private readonly elements: Element[] = [];
  private readonly atoms = new Map<number, Element>();
  private readonly atomMarkup = new Map<Element, string>();
  private readonly snapshots: Snapshot[] = [];
  private readonly originals = new Map<Text, string>();
  private readonly expectedText = new Map<Text, string>();
  private readonly added = new Set<Text>();
  private applied = false;

  static create(block: Element, accepted: Set<Text>, protectedNodes: ProtectedInlineNode[] = []): InlineTranslationPlan | undefined {
    try {
      const plan = new InlineTranslationPlan(block, accepted, protectedNodes);
      return plan.elements.length ? plan : undefined;
    } catch { return undefined; }
  }

  private constructor(readonly block: Element, accepted: Set<Text>, protectedNodes: ProtectedInlineNode[]) {
    const protectedByNode = new Map(protectedNodes.map(entry => [entry.sourceNode, entry.marker]));
    const flows = new TextFlowSnapshot();
    const read = (element: Element): string => {
      const nodes = children(element);
      this.snapshots.push({ element, children: nodes, expected: nodes, attributes: attributes(element) });
      return nodes.map(node => {
        if (node instanceof Element && protectedByNode.has(node)) {
          const marker = protectedByNode.get(node)!;
          this.atoms.set(Number(/\d+/u.exec(marker)![0]), node);
          this.atomMarkup.set(node, node.outerHTML);
          return node.matches("br") ? ` ${marker} ` : marker;
        }
        if (node instanceof Text) {
          if (node.data.trim() && !accepted.has(node)) throw new Error("Text belongs to another translation unit");
          this.originals.set(node, node.data);
          this.expectedText.set(node, node.data);
          return node.data;
        }
        // Framework comment anchors can carry hydration/region identity.
        if (node.nodeType === Node.COMMENT_NODE) throw new Error("Framework anchor");
        if (!(node instanceof Element) || node.namespaceURI !== "http://www.w3.org/1999/xhtml"
          || node.matches("img,svg,math,br,wbr,code,kbd,samp") || !flows.isInlineTree(node)
          || node.matches("[role],[tabindex],[onclick],[slot],[translate],[hidden],[aria-hidden],.notranslate")) {
          throw new Error("Independent or protected content");
        }
        const id = this.elements.push(node) - 1;
        return `⟪WUPAGEOPEN${id}⟫${read(node)}⟪WUPAGECLOSE${id}⟫`;
      }).join("");
    };
    this.source = read(block).replace(/\s+/gu, " ").trim();
  }

  private hasExpectedChildren(): boolean {
    return this.snapshots.every(snapshot => {
      const actual = children(snapshot.element);
      return actual.length === snapshot.expected.length && actual.every((node, index) => node === snapshot.expected[index]);
    });
  }

  isCurrent(): boolean {
    return this.block.isConnected && this.hasExpectedChildren()
      && this.snapshots.every(snapshot => attributes(snapshot.element) === snapshot.attributes)
      && [...this.expectedText].every(([node, value]) => node.data === value)
      && [...this.atomMarkup].every(([node, html]) => node.outerHTML === html);
  }

  private parse(translation: string): Piece[] | undefined {
    const text = normalizeProtectedText(this.source, translation);
    if (text === undefined) return undefined;
    const root: Piece[] = [], stack = [root];
    let cursor = 0;
    for (const match of text.matchAll(/⟪WUPAGE(OPEN|CLOSE|BREAK)?(\d+)⟫/gu)) {
      if (match.index! > cursor) stack.at(-1)!.push({ text: text.slice(cursor, match.index) });
      if (!match[1] || match[1] === "BREAK") {
        if (!this.atoms.has(Number(match[2]))) return undefined;
        stack.at(-1)!.push({ atom: Number(match[2]) });
      } else if (match[1] === "OPEN") {
        const id = Number(match[2]);
        if (!this.elements[id]) return undefined;
        const nested: Piece[] = [];
        stack.at(-1)!.push({ id, children: nested });
        stack.push(nested);
      } else {
        const nested = stack.pop()!;
        const source = this.elements[Number(match[2])];
        if (source.textContent?.trim() && !pieceText(nested, this.atoms).trim()) return undefined;
      }
      cursor = match.index! + match[0].length;
    }
    if (cursor < text.length) root.push({ text: text.slice(cursor) });
    // Neutral spans may be application fields with no explicit button role.
    // Preserve their order relative to siblings even when rich prose permits
    // moving semantic emphasis or links with the translated word order.
    const preservesFields = (parent: Element, pieces: Piece[]): boolean => {
      const snapshot = this.snapshots.find(entry => entry.element === parent)!;
      const before = snapshot.children.filter((node): node is Element => node instanceof Element);
      const after = pieces.flatMap(piece => piece.id !== undefined ? [this.elements[piece.id]]
        : piece.atom !== undefined ? [this.atoms.get(piece.atom)!] : []);
      return before.filter(node => node.localName === "span").every(field => before.every(sibling =>
        Math.sign(before.indexOf(field) - before.indexOf(sibling)) === Math.sign(after.indexOf(field) - after.indexOf(sibling))))
        && pieces.every(piece => piece.id === undefined || preservesFields(this.elements[piece.id], piece.children!));
    };
    if (!preservesFields(this.block, root)) return undefined;
    return root;
  }

  accepts(text: string): boolean { return this.parse(text) !== undefined; }

  write(text: string): Text | undefined {
    const pieces = this.parse(text);
    if (!pieces || !this.isCurrent()) return undefined;
    const previousAdded = [...this.added];
    const update = (element: Element, items: Piece[]) => {
      const snapshot = this.snapshots.find(entry => entry.element === element)!;
      const pool = snapshot.children.filter((node): node is Text => node instanceof Text);
      const output: Node[] = items.map(piece => {
        if (piece.atom !== undefined) return this.atoms.get(piece.atom)!;
        if (piece.id !== undefined) {
          const node = this.elements[piece.id];
          update(node, piece.children!);
          return node;
        }
        const node = pool.shift() ?? element.ownerDocument.createTextNode("");
        if (!this.originals.has(node)) this.added.add(node);
        node.data = piece.text!;
        this.expectedText.set(node, node.data);
        return node;
      });
      // Keep surplus original Text nodes (including empty nodes held by a UI
      // framework) and comments attached to their original parent.
      for (const node of pool) { node.data = ""; this.expectedText.set(node, ""); output.push(node); }
      output.push(...snapshot.children.filter(node => node.nodeType === Node.COMMENT_NODE));
      const extras = [...element.childNodes].filter(owned);
      const next = [...output, ...extras], current = [...element.childNodes];
      if (next.length !== current.length || next.some((node, index) => node !== current[index])) {
        element.replaceChildren(...next);
      }
      snapshot.expected = output;
    };
    update(this.block, pieces);
    for (const node of previousAdded) if (!this.block.contains(node)) {
      this.expectedText.delete(node); this.added.delete(node);
    }
    this.applied = true;
    return [...this.expectedText.keys()].find(node => this.block.contains(node));
  }

  appendCopy(container: Element, text: string): boolean {
    const pieces = this.parse(text);
    if (!pieces || !this.isCurrent()) return false;
    const append = (parent: Element, items: Piece[]) => items.forEach(piece => {
      if (piece.atom !== undefined) {
        const copy = this.atoms.get(piece.atom)!.cloneNode(true) as Element;
        for (const node of [copy, ...copy.querySelectorAll("*")]) {
          node.removeAttribute("id"); node.removeAttribute("name");
          for (const attribute of [...node.attributes]) if (attribute.name.startsWith("on")) node.removeAttribute(attribute.name);
        }
        parent.append(copy);
        return;
      }
      if (piece.id === undefined) { parent.append(parent.ownerDocument.createTextNode(piece.text!)); return; }
      const copy = this.elements[piece.id].cloneNode(false) as Element;
      // Copies are presentation only; never duplicate page identity.
      copy.removeAttribute("id");
      copy.removeAttribute("name");
      for (const attribute of [...copy.attributes]) if (attribute.name.startsWith("on")) copy.removeAttribute(attribute.name);
      append(copy, piece.children!);
      parent.append(copy);
    });
    append(container, pieces);
    return true;
  }

  restore(): void {
    if (!this.applied) return;
    const intact = this.hasExpectedChildren();
    for (const [node, value] of this.originals) {
      if (node.data === this.expectedText.get(node)) node.data = value;
    }
    // An application update wins over the old snapshot.
    if (intact) {
      for (const snapshot of this.snapshots) {
        const next = [...snapshot.children, ...[...snapshot.element.childNodes].filter(owned)];
        const current = [...snapshot.element.childNodes];
        if (next.length !== current.length || next.some((node, index) => node !== current[index])) {
          snapshot.element.replaceChildren(...next);
        }
        snapshot.expected = snapshot.children;
      }
      this.added.forEach(node => { this.expectedText.delete(node); node.remove(); });
      this.added.clear();
    }
    this.originals.forEach((value, node) => this.expectedText.set(node, value));
    this.applied = false;
  }
}

function pieceText(pieces: Piece[], atoms: Map<number, Element>): string {
  return pieces.map(piece => piece.atom !== undefined ? atoms.get(piece.atom)!.textContent
    : piece.text ?? pieceText(piece.children!, atoms)).join("");
}
