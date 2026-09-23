import {
  createRenderVisibilitySnapshot,
  isElementVisuallyRendered
} from "./visibility";
import type { RenderVisibilitySnapshot } from "./visibility";
import type { TranslationDisplayMode } from "../shared/types";

export interface TextSegment {
  id: string;
  text: string;
  element: Element;
}

interface TrackedNode {
  id: string;
  node: Text;
  mode: RenderMode;
  sourceValue: string;
  sourceParent: Element;
  replaced?: boolean;
  commentPrefix?: string;
}

interface TrackedGroup {
  id: string;
  nodes: TrackedNode[];
  block: Element;
  mode: RenderMode;
  insertionBefore?: ChildNode;
  preserveWhitespace?: boolean;
}

interface TrackedAttribute {
  id: string;
  element: HTMLElement;
  name: "placeholder";
  sourceValue: string;
  translatedValue?: string;
}

type RenderMode = "block" | "inline" | "code-comment";

interface ProtectedToken {
  marker: string;
  node: Element;
  sourceNode: Element;
  hiddenByReplacement?: boolean;
}

const TRANSLATION_CLASS = "wupage-translation";
const PENDING_CLASS = "wupage-translation-pending";
const TRANSLATED_ATTR = "data-wupage-translated";
const TARGET_ATTR = "data-wupage-target-id";
const TRANSLATION_TARGET_ATTR = "data-wupage-translation-target";
const REPLACED_SOURCE_CLASS = "wupage-replaced-source";
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "BUTTON",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "OPTION",
  "KBD",
  "SAMP",
  "SVG",
  "CANVAS"
]);
const SKIP_SELECTORS = [
  "#wupage-floating-hitbox",
  "#wupage-floating-menu",
  "#wupage-debug-panel",
  "#wupage-paragraph-highlight",
  "header",
  "nav",
  "footer",
  "aside",
  "summary",
  "button",
  "a[role='button']",
  "[role='button']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[contenteditable='true']",
  "[aria-hidden='true']",
  "details-menu",
  "details-dialog",
  "modal-dialog",
  ".sr-only",
  ".rustdoc-breadcrumbs",
  ".breadcrumbs",
  ".breadcrumb",
  "[class*='breadcrumbs']",
  "[class*='Breadcrumb']",
  "[aria-label*='breadcrumb']",
  "[aria-label*='Breadcrumb']",
  ".IssueLabel",
  ".Label",
  ".js-issue-labels",
  ".sidebar-labels",
  ".discussion-sidebar-item",
  "[class*='LabelsList-module__']",
  "[class*='LabelToken-module__']",
  "[class*='prc-Token-']",
  "[data-component='Tooltip']",
  ".gh-header-actions",
  ".tabnav",
  ".UnderlineNav",
  ".js-repo-nav",
  ".Counter",
  ".State"
];
const SKIP_SELECTOR = SKIP_SELECTORS.join(",");
const VISIBLE_ARIA_HIDDEN_SKIP_SELECTOR = SKIP_SELECTORS.filter(
  (selector) => selector !== "[aria-hidden='true']"
).join(",");
const READABLE_SUMMARY_SKIP_SELECTOR = SKIP_SELECTORS.filter((selector) => selector !== "summary").join(",");
const COMPACT_NAV_SKIP_SELECTOR = SKIP_SELECTORS.filter(
  (selector) => ![
    "nav",
    "aside",
    "header",
    "footer",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']"
  ].includes(selector)
).join(",");
const COMPACT_CONTROL_SKIP_SELECTOR = SKIP_SELECTORS.filter(
  (selector) => ![
    "header",
    "nav",
    "footer",
    "aside",
    "button",
    "a[role='button']",
    "[role='button']",
    "[role='tab']",
    "[role='menuitem']",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']"
  ].includes(selector)
).join(",");
const KNOWN_COMPACT_NAV_SELECTOR = "nav.sidebar, #rustdoc-toc, .sidebar-elems";
const NAVIGATION_CONTAINER_SELECTOR = [
  "nav",
  "aside",
  "[role='navigation']",
  KNOWN_COMPACT_NAV_SELECTOR
].join(",");
const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";
const DOCUMENT_SEMANTIC_REGION_SELECTOR = [
  "header",
  "aside",
  "footer",
  "[role='banner']",
  "[role='contentinfo']"
].join(",");
const SEMANTIC_TEXT_BLOCK_SELECTOR = [
  "p",
  "blockquote",
  HEADING_SELECTOR,
  "figcaption",
  "caption",
  "dt",
  "dd",
  "th",
  "td"
].join(",");
const X_POST_TEXT_SELECTOR = "[data-testid='tweetText']";
const READABLE_ROOT_SELECTOR = "main,article,[role='main'],.markdown-body,.docblock,#main-content";
const CODE_SELECTOR = "pre, code, .highlight, .example-wrap, .blob-code, .react-code-text";
const CODE_COMMENT_TARGET_SELECTOR = ".react-code-text, .blob-code, pre, code, .highlight";

let trackedNodes: TrackedNode[] = [];
let trackedGroups: TrackedGroup[] = [];
let trackedAttributes: TrackedAttribute[] = [];
let protectedTokensById = new Map<string, ProtectedToken[]>();
let sourceTextById = new Map<string, string>();
const renderedById = new Map<string, Element>();
let targetIdCounter = 0;
let segmentIdCounter = 0;

const PARAGRAPH_SELECTOR = [
  "p",
  "li",
  "blockquote",
  "figcaption",
  "caption",
  "dt",
  "dd",
  "th",
  "td",
  "label",
  HEADING_SELECTOR,
  "[class*='IssueMetadata-module__metadataValue__']",
  ".docblock p",
  ".docblock li",
  ".docblock blockquote",
  ".methods p",
  ".impl-items p",
  ".markdown-body > div",
  ".markdown-body > p",
  ".comment-body p",
  X_POST_TEXT_SELECTOR
].join(",");

export function collectTextSegments(translateCodeComments = true): TextSegment[] {
  clearNodeTracking();
  return collectTextSegmentsFromRoot(document.body, true, translateCodeComments);
}

export function collectParagraphTextSegments(
  element: Element,
  translateCodeComments = true
): TextSegment[] {
  trackedNodes = trackedNodes.filter((tracked) => !element.contains(tracked.node));
  trackedGroups = trackedGroups.filter((group) => !group.nodes.some((tracked) => element.contains(tracked.node)));
  trackedAttributes = trackedAttributes.filter((tracked) =>
    tracked.element !== element && !element.contains(tracked.element)
  );
  return collectTextSegmentsFromRoot(element, false, translateCodeComments);
}

export function collectAdditionalTextSegments(
  element: Element,
  translateCodeComments = true
): TextSegment[] {
  return collectTextSegmentsFromRoot(element, false, translateCodeComments);
}

// Applications may reuse a text node or discard our rendered output. Release
// its tracking so the next scan can translate the current source again.
export function invalidateStaleSegments(changedRoots: Element[] = []): string[] {
  const stale = new Set<string>();
  const changed = (tracked: TrackedNode): boolean => !tracked.node.isConnected
    || tracked.node.parentElement !== tracked.sourceParent
    || tracked.node.data !== (tracked.replaced ? "" : tracked.sourceValue);
  for (const tracked of trackedNodes) {
    if (changed(tracked) || changedRoots.includes(tracked.node.parentElement!)) stale.add(tracked.id);
  }
  for (const [id, output] of renderedById) {
    if (!output.isConnected) stale.add(id);
  }
  for (const group of trackedGroups) {
    if (stale.has(group.id) || group.nodes.some((node) => stale.has(node.id))
      || changedRoots.some((root) => group.block === root || group.block.contains(root))) {
      stale.add(group.id);
      group.nodes.forEach((node) => stale.add(node.id));
    }
  }
  for (const tracked of trackedAttributes) {
    if (!tracked.element.isConnected
      || tracked.element.getAttribute(tracked.name) !== (tracked.translatedValue ?? tracked.sourceValue)) {
      stale.add(tracked.id);
    }
  }
  for (const tracked of trackedNodes) {
    if (!stale.has(tracked.id)) continue;
    // Never overwrite a new value supplied by the host application.
    if (tracked.replaced && tracked.node.data === "") tracked.node.data = tracked.sourceValue;
  }
  for (const id of stale) {
    renderedById.get(id)?.remove();
    renderedById.delete(id);
    removePendingForId(id);
    for (const token of protectedTokensById.get(id) ?? []) {
      if (token.hiddenByReplacement) token.sourceNode.classList.remove(REPLACED_SOURCE_CLASS);
    }
    protectedTokensById.delete(id);
    sourceTextById.delete(id);
  }
  trackedNodes = trackedNodes.filter((node) => !stale.has(node.id));
  trackedGroups = trackedGroups.filter((group) => !stale.has(group.id));
  trackedAttributes = trackedAttributes.filter((attribute) => !stale.has(attribute.id));
  return [...stale];
}

export function findTranslatableParagraph(start: Element | null): Element | null {
  if (start?.closest(CODE_SELECTOR) && !isInlineCodeInReadableText(start)) {
    return findCodeCommentBlock(start);
  }

  let current: Element | null = start;
  while (current && current !== document.body) {
    if (!shouldSkipElement(current) && current.matches(PARAGRAPH_SELECTOR)) {
      const text = normalizeText(current.textContent ?? "");
      if (
        text.length >= 2 &&
        (isIssueMetadataValue(current) || !isLikelyUiToken(text, current))
      ) {
        return current;
      }
    }
    current = current.parentElement;
  }
  return findNearestTextBlock(start);
}

export function clearTranslationsIn(element: Element): void {
  restoreTrackedAttributesIn(element);
  restoreReplacedSourcesIn(element);
  const targetId = element.getAttribute(TARGET_ATTR);
  if (targetId) {
    findTargetTranslations(targetId).forEach((node) => node.remove());
  }
  element.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((node) => node.remove());
  element.querySelectorAll(`[${TRANSLATED_ATTR}]`).forEach((node) => {
    node.removeAttribute(TRANSLATED_ATTR);
  });
  element.removeAttribute(TRANSLATED_ATTR);
  element.removeAttribute(TARGET_ATTR);
  trackedNodes = trackedNodes.filter((tracked) => !element.contains(tracked.node));
  trackedGroups = trackedGroups.filter((group) => !group.nodes.some((tracked) => element.contains(tracked.node)));
  trackedAttributes = trackedAttributes.filter((tracked) =>
    tracked.element !== element && !element.contains(tracked.element)
  );
}

export function hasTranslationsIn(element: Element): boolean {
  const targetId = element.getAttribute(TARGET_ATTR);
  if (targetId && findTargetTranslations(targetId).length > 0) {
    return true;
  }
  if (element.querySelector(`.${TRANSLATION_CLASS}`)) return true;
  return element.hasAttribute(TRANSLATED_ATTR) || Boolean(element.querySelector(`[${TRANSLATED_ATTR}]`));
}

export function hasPageTranslations(): boolean {
  return Boolean(
    document.querySelector(`.${TRANSLATION_CLASS}`) ||
      document.querySelector(`[${TRANSLATED_ATTR}]`) ||
      document.querySelector(`[${TRANSLATION_TARGET_ATTR}]`)
  );
}

export function ensureTranslationTarget(element: Element): string {
  const existing = element.getAttribute(TARGET_ATTR);
  if (existing) return existing;
  const id = `wupage-target-${Date.now()}-${targetIdCounter++}`;
  element.setAttribute(TARGET_ATTR, id);
  return id;
}

function collectTextSegmentsFromRoot(
  root: Element,
  resetTracking: boolean,
  translateCodeComments: boolean
): TextSegment[] {
  if (resetTracking) clearNodeTracking();
  splitXPostLineBreakTextNodes(root);
  const alreadyTracked = new Set(trackedNodes.map((tracked) => tracked.node));
  const visibility = createRenderVisibilitySnapshot();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      if (alreadyTracked.has(node as Text)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || shouldSkipElement(parent, true, visibility)) return NodeFilter.FILTER_REJECT;
      if (isStructuredListMetadata(parent)) return NodeFilter.FILTER_REJECT;
      if (!visibility.isTextNodeVisuallyRendered(node as Text)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const segments: TextSegment[] = [];
  const textNodes: TrackedNode[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const codeComment = translateCodeComments ? getCodeComment(node) : null;
    if (isInsideCodeBlock(node.parentElement) && !codeComment) continue;
    const text = normalizeText(node.textContent ?? "");
    const sourceText = codeComment?.text ?? text;
    if (!sourceText || sourceText.length < 2) continue;
    if (!codeComment && isNonTranslatableFragment(sourceText)) continue;
    if (!codeComment && isLikelyUiToken(sourceText, node.parentElement)) continue;
    const id = `seg-${Date.now()}-${segmentIdCounter++}`;
    const tracked: TrackedNode = {
      id,
      node,
      mode: codeComment ? "code-comment" : getRenderMode(node.parentElement),
      sourceValue: node.data,
      sourceParent: node.parentElement!,
      commentPrefix: codeComment?.prefix
    };
    trackedNodes.push(tracked);
    textNodes.push(tracked);
    segments.push({ id, text: sourceText, element: node.parentElement! });
  }

  const groupedSegments = groupTextSegments(textNodes, segments, visibility);
  const attributeSegments = collectAttributeSegments(root, visibility);
  const collectedSegments = [...groupedSegments, ...attributeSegments];
  collectedSegments.forEach((segment) => sourceTextById.set(segment.id, segment.text));
  return collectedSegments;
}

export function renderTranslations(
  translations: Array<{ id: string; text: string }>,
  displayMode: TranslationDisplayMode = "bilingual"
): void {
  const translationById = new Map(translations.map((entry) => [entry.id, entry.text]));

  for (const group of trackedGroups) {
    const translation = translationById.get(group.id);
    const block = group.block;
    if (!translation || block.closest(`.${TRANSLATION_CLASS}`)) continue;

    removePendingForId(group.id);
    if (isSameTranslation(group.id, translation)) continue;
    const targetId = ensureTranslationTarget(block);
    const element = document.createElement("span");
    element.className = TRANSLATION_CLASS;
    element.dataset.wupageMode = group.mode;
    element.dataset.wupageDisplayMode = displayMode;
    if (group.preserveWhitespace) element.dataset.wupagePreserveWhitespace = "true";
    applyTranslationTextColor(element, block, displayMode);
    renderProtectedText(element, group.id, translation);
    element.setAttribute("lang", "translated");
    if (displayMode !== "replace") element.setAttribute("aria-hidden", "true");
    element.setAttribute(TRANSLATION_TARGET_ATTR, targetId);
    block.setAttribute(TRANSLATED_ATTR, "true");
    insertGroupedTranslation(group, element, displayMode);
    renderedById.set(group.id, element);
    if (displayMode === "replace") replaceTrackedSource(group.nodes, group.id);
  }

  for (const tracked of trackedNodes) {
    if (trackedGroups.some((group) => group.nodes.includes(tracked))) continue;
    const translation = translationById.get(tracked.id);
    const parent = tracked.node.parentElement;
    if (!translation || !parent || parent.closest(`.${TRANSLATION_CLASS}`)) continue;

    removePendingForId(tracked.id);
    if (isSameTranslation(tracked.id, translation)) continue;
    const element = document.createElement("span");
    element.className = TRANSLATION_CLASS;
    element.dataset.wupageMode = tracked.mode;
    element.dataset.wupageDisplayMode = displayMode;
    applyTranslationTextColor(element, parent, displayMode);
    element.textContent = tracked.mode === "code-comment" ? `${tracked.commentPrefix ?? "//"} ${translation}` : translation;
    element.setAttribute("lang", "translated");
    if (displayMode !== "replace") element.setAttribute("aria-hidden", "true");
    parent.setAttribute(TRANSLATED_ATTR, "true");
    tracked.node.after(element);
    renderedById.set(tracked.id, element);
    if (displayMode === "replace") replaceTrackedSource([tracked]);
  }

  for (const tracked of trackedAttributes) {
    const translation = translationById.get(tracked.id);
    if (!translation || isSameTranslation(tracked.id, translation)) continue;
    tracked.element.setAttribute(tracked.name, translation);
    tracked.element.setAttribute(TRANSLATED_ATTR, "true");
    tracked.translatedValue = translation;
  }
}

export function renderTargetTranslation(
  element: Element,
  text: string,
  sourceText?: string,
  displayMode: TranslationDisplayMode = "bilingual"
): void {
  const targetId = ensureTranslationTarget(element);
  findTargetTranslations(targetId).forEach((node) => node.remove());
  if (sourceText !== undefined && normalizeText(sourceText) === normalizeText(text)) {
    element.removeAttribute(TRANSLATED_ATTR);
    element.removeAttribute(TARGET_ATTR);
    return;
  }

  const translation = document.createElement("span");
  translation.className = TRANSLATION_CLASS;
  translation.dataset.wupageMode = getRenderMode(element);
  translation.dataset.wupageDisplayMode = displayMode;
  applyTranslationTextColor(translation, element, displayMode);
  translation.textContent = text;
  translation.setAttribute("lang", "translated");
  if (displayMode !== "replace") translation.setAttribute("aria-hidden", "true");
  translation.setAttribute(TRANSLATION_TARGET_ATTR, targetId);
  element.setAttribute(TRANSLATED_ATTR, "true");
  element.append(translation);
}

export function renderTranslationPlaceholders(segments: TextSegment[]): void {
  const pendingIds = new Set(segments.map((segment) => segment.id));

  for (const group of trackedGroups) {
    if (!pendingIds.has(group.id)) continue;
    const block = group.block;
    if (block.closest(`.${TRANSLATION_CLASS}`)) continue;
    const targetId = ensureTranslationTarget(block);
    const pending = createPendingElement(group.id, group.mode);
    if (group.preserveWhitespace) pending.dataset.wupagePreserveWhitespace = "true";
    applyTranslationTextColor(pending, block, "bilingual");
    pending.setAttribute(TRANSLATION_TARGET_ATTR, targetId);
    removePendingForId(group.id);
    insertGroupedTranslation(group, pending);
    block.setAttribute(TRANSLATED_ATTR, "true");
  }

  for (const tracked of trackedNodes) {
    if (!pendingIds.has(tracked.id)) continue;
    if (trackedGroups.some((group) => group.nodes.includes(tracked))) continue;
    const parent = tracked.node.parentElement;
    if (!parent || parent.closest(`.${TRANSLATION_CLASS}`)) continue;
    insertPending(tracked.node, tracked.id, tracked.mode);
    parent.setAttribute(TRANSLATED_ATTR, "true");
  }
}

export function clearTranslationPlaceholders(segments: TextSegment[]): void {
  for (const segment of segments) {
    removePendingForId(segment.id);
  }
}

export function renderTargetPlaceholder(element: Element): void {
  const targetId = ensureTranslationTarget(element);
  findTargetTranslations(targetId).forEach((node) => node.remove());
  const pending = createPendingElement(targetId, getRenderMode(element));
  applyTranslationTextColor(pending, element, "bilingual");
  pending.setAttribute(TRANSLATION_TARGET_ATTR, targetId);
  element.setAttribute(TRANSLATED_ATTR, "true");
  element.append(pending);
}

export function clearTranslations(): void {
  restoreTrackedAttributesIn(document.documentElement);
  restoreReplacedSourcesIn(document.documentElement);
  document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((node) => node.remove());
  document.querySelectorAll(`[${TRANSLATED_ATTR}]`).forEach((node) => {
    node.removeAttribute(TRANSLATED_ATTR);
  });
  document.querySelectorAll(`[${TARGET_ATTR}]`).forEach((node) => {
    node.removeAttribute(TARGET_ATTR);
  });
  clearNodeTracking();
}

function clearNodeTracking(): void {
  trackedNodes = [];
  trackedGroups = [];
  trackedAttributes = [];
  protectedTokensById = new Map();
  sourceTextById = new Map();
  renderedById.clear();
}

function collectAttributeSegments(
  root: Element,
  visibility: RenderVisibilitySnapshot
): TextSegment[] {
  const trackedElements = new Set(trackedAttributes.map((tracked) => tracked.element));
  const candidates = [
    ...(root.matches("input[placeholder],textarea[placeholder]") ? [root] : []),
    ...root.querySelectorAll("input[placeholder],textarea[placeholder]")
  ];
  const segments: TextSegment[] = [];

  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement) || trackedElements.has(candidate)) continue;
    if (candidate.closest(`.${TRANSLATION_CLASS}, #wupage-floating-menu, #wupage-debug-panel`)) continue;
    if (!visibility.isElementVisuallyRendered(candidate)) continue;
    const sourceValue = candidate.getAttribute("placeholder") ?? "";
    const sourceText = normalizeText(sourceValue);
    if (sourceText.length < 2 || isNonTranslatableFragment(sourceText)) continue;
    const id = `seg-${Date.now()}-${segmentIdCounter++}`;
    trackedAttributes.push({ id, element: candidate, name: "placeholder", sourceValue });
    segments.push({ id, text: sourceText, element: candidate });
  }

  return segments;
}

function restoreTrackedAttributesIn(root: Element): void {
  for (const tracked of trackedAttributes) {
    if (tracked.element !== root && !root.contains(tracked.element)) continue;
    if (
      tracked.translatedValue !== undefined &&
      tracked.element.getAttribute(tracked.name) === tracked.translatedValue
    ) {
      tracked.element.setAttribute(tracked.name, tracked.sourceValue);
    }
  }
}

function replaceTrackedSource(nodes: TrackedNode[], protectedTokenId?: string): void {
  for (const tracked of nodes) {
    if (tracked.replaced) continue;
    tracked.node.data = "";
    tracked.replaced = true;
  }
  if (!protectedTokenId) return;
  for (const token of protectedTokensById.get(protectedTokenId) ?? []) {
    if (token.sourceNode.classList.contains(REPLACED_SOURCE_CLASS)) continue;
    token.sourceNode.classList.add(REPLACED_SOURCE_CLASS);
    token.hiddenByReplacement = true;
  }
}

function restoreReplacedSourcesIn(root: Element): void {
  for (const tracked of trackedNodes) {
    if (!tracked.replaced || !tracked.node.parentElement) continue;
    if (tracked.node.parentElement !== root && !root.contains(tracked.node.parentElement)) continue;
    if (tracked.node.data === "") tracked.node.data = tracked.sourceValue;
    tracked.replaced = false;
  }
  for (const tokens of protectedTokensById.values()) {
    for (const token of tokens) {
      if (!token.hiddenByReplacement) continue;
      if (token.sourceNode !== root && !root.contains(token.sourceNode)) continue;
      token.sourceNode.classList.remove(REPLACED_SOURCE_CLASS);
      token.hiddenByReplacement = false;
    }
  }
}

function isSameTranslation(id: string, translation: string): boolean {
  const sourceText = sourceTextById.get(id);
  return sourceText !== undefined && normalizeText(sourceText) === normalizeText(translation);
}

function findTargetTranslations(targetId: string): Element[] {
  return Array.from(document.querySelectorAll(`[${TRANSLATION_TARGET_ATTR}]`)).filter(
    (node) => node.getAttribute(TRANSLATION_TARGET_ATTR) === targetId
  );
}

function insertPending(anchor: Text, id: string, mode: RenderMode): void {
  removePendingForId(id);
  const pending = createPendingElement(id, mode);
  if (anchor.parentElement) applyTranslationTextColor(pending, anchor.parentElement, "bilingual");
  anchor.after(pending);
}

function applyTranslationTextColor(
  translation: HTMLElement,
  source: Element,
  displayMode: TranslationDisplayMode
): void {
  const color = window.getComputedStyle(source).color;
  if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") return;
  if (displayMode !== "bilingual-accent") {
    translation.style.color = color;
    return;
  }
  const mapped = mapTranslationTextColor(color, getEffectiveBackgroundColor(source));
  translation.style.color = mapped ?? color;
}

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function mapTranslationTextColor(
  sourceCssColor: string,
  backgroundCssColor: string
): string | null {
  const source = parseCssColor(sourceCssColor);
  const background = parseCssColor(backgroundCssColor);
  if (!source || !background) return null;

  const opaqueBackground = compositeColor(background, { r: 255, g: 255, b: 255, a: 1 });
  const opaqueSource = compositeColor(source, opaqueBackground);
  const darkBackground = relativeLuminance(opaqueBackground) < 0.42;
  const accent = darkBackground
    ? { r: 94, g: 234, b: 212, a: 1 }
    : { r: 15, g: 118, b: 110, a: 1 };
  let mapped = mixColors(opaqueSource, accent, 0.22);

  if (contrastRatio(mapped, opaqueBackground) < 4.5) {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const contrastColor = contrastRatio(black, opaqueBackground) >= contrastRatio(white, opaqueBackground)
      ? black
      : white;
    mapped = mixUntilContrast(mapped, contrastColor, opaqueBackground, 4.5);
  }

  if (colorDistance(mapped, opaqueSource) < 6) {
    const nudge = darkBackground
      ? { r: 129, g: 230, b: 217, a: 1 }
      : { r: 8, g: 95, b: 88, a: 1 };
    mapped = mixColors(mapped, nudge, 0.16);
    if (contrastRatio(mapped, opaqueBackground) < 4.5) {
      const contrastColor = darkBackground
        ? { r: 255, g: 255, b: 255, a: 1 }
        : { r: 0, g: 0, b: 0, a: 1 };
      mapped = mixUntilContrast(mapped, contrastColor, opaqueBackground, 4.5);
    }
  }
  return `rgb(${Math.round(mapped.r)}, ${Math.round(mapped.g)}, ${Math.round(mapped.b)})`;
}

function getEffectiveBackgroundColor(source: Element): string {
  const layers: RgbaColor[] = [];
  let current: Element | null = source;
  while (current) {
    const color = parseCssColor(window.getComputedStyle(current).backgroundColor);
    if (color && color.a > 0) layers.push(color);
    current = current.parentElement;
  }
  let result: RgbaColor = { r: 255, g: 255, b: 255, a: 1 };
  for (const layer of layers.reverse()) result = compositeColor(layer, result);
  return `rgb(${Math.round(result.r)}, ${Math.round(result.g)}, ${Math.round(result.b)})`;
}

function parseCssColor(value: string): RgbaColor | null {
  if (!value) return null;
  const match = value.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (!match) return null;
  const alphaValue = match[4] === undefined ? 1 : Number.parseFloat(match[4]);
  const alpha = match[4]?.includes("%") ? alphaValue / 100 : alphaValue;
  return {
    r: clampColorChannel(Number(match[1])),
    g: clampColorChannel(Number(match[2])),
    b: clampColorChannel(Number(match[3])),
    a: Math.max(0, Math.min(1, alpha))
  };
}

function compositeColor(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha
  };
}

function mixColors(from: RgbaColor, to: RgbaColor, amount: number): RgbaColor {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
    a: 1
  };
}

function mixUntilContrast(
  color: RgbaColor,
  contrastColor: RgbaColor,
  background: RgbaColor,
  targetRatio: number
): RgbaColor {
  let low = 0;
  let high = 1;
  for (let index = 0; index < 12; index += 1) {
    const amount = (low + high) / 2;
    const candidate = mixColors(color, contrastColor, amount);
    if (contrastRatio(candidate, background) >= targetRatio) high = amount;
    else low = amount;
  }
  return mixColors(color, contrastColor, high);
}

function contrastRatio(left: RgbaColor, right: RgbaColor): number {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: RgbaColor): number {
  const linearize = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

function colorDistance(left: RgbaColor, right: RgbaColor): number {
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
}

function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Number.isFinite(value) ? value : 0));
}

function createPendingElement(id: string, mode: RenderMode): HTMLElement {
  const element = document.createElement("span");
  element.className = `${TRANSLATION_CLASS} ${PENDING_CLASS}`;
  element.dataset.wupageMode = mode;
  element.dataset.wupagePendingId = id;
  element.setAttribute("lang", "translated");
  element.setAttribute("aria-hidden", "true");
  element.append(document.createElement("span"));
  return element;
}

function removePendingForId(id: string): void {
  document.querySelectorAll<HTMLElement>(`.${PENDING_CLASS}[data-wupage-pending-id="${id}"]`).forEach((node) => {
    const parent = node.parentElement;
    const targetId = node.getAttribute(TRANSLATION_TARGET_ATTR);
    node.remove();
    if (parent && !parent.querySelector(`.${TRANSLATION_CLASS}`)) {
      parent.removeAttribute(TRANSLATED_ATTR);
    }
    if (targetId && !findTargetTranslations(targetId).length) {
      const target = document.querySelector(`[${TARGET_ATTR}="${targetId}"]`);
      target?.removeAttribute(TRANSLATED_ATTR);
      target?.removeAttribute(TARGET_ATTR);
    }
  });
}

function groupTextSegments(
  nodes: TrackedNode[],
  fallback: TextSegment[],
  visibility: RenderVisibilitySnapshot
): TextSegment[] {
  const groups = new Map<Element, TrackedNode[]>();
  const standalone = new Set(fallback.map((segment) => segment.id));

  for (const tracked of nodes) {
    if (tracked.mode === "code-comment") continue;
    const block = findGroupingBlock(tracked.node.parentElement);
    if (!block) continue;
    if (block.querySelector(`.${TRANSLATION_CLASS}`)) continue;
    const group = groups.get(block) ?? [];
    group.push(tracked);
    groups.set(block, group);
  }

  const groupedSegments: TextSegment[] = [];
  for (const [block, groupNodes] of groups) {
    if (block.matches(X_POST_TEXT_SELECTOR)) {
      for (const paragraph of getXPostParagraphGroups(block, groupNodes)) {
        const id = paragraph.nodes[0].id;
        trackedGroups.push({
          id,
          nodes: paragraph.nodes,
          block,
          mode: "block",
          insertionBefore: paragraph.insertionBefore,
          preserveWhitespace: true
        });
        groupedSegments.push({ id, text: paragraph.text, element: block });
        paragraph.nodes.forEach((tracked) => standalone.delete(tracked.id));
      }
      continue;
    }

    const nodeText = normalizeText(groupNodes.map((tracked) => tracked.node.textContent ?? "").join(" "));
    const id = groupNodes[0].id;
    const { text, tokens } = getReadableBlockText(block, visibility);
    if (
      groupNodes.length < 2 &&
      text === nodeText &&
      !block.matches(`summary, label, ${X_POST_TEXT_SELECTOR}`)
    ) continue;
    if (!text) continue;
    trackedGroups.push({ id, nodes: groupNodes, block, mode: getRenderMode(block) });
    if (tokens.length) protectedTokensById.set(id, tokens);
    groupedSegments.push({ id, text, element: block });
    groupNodes.forEach((tracked) => standalone.delete(tracked.id));
  }

  return [
    ...groupedSegments,
    ...fallback.filter((segment) => standalone.has(segment.id))
  ];
}

interface XPostParagraphGroup {
  nodes: TrackedNode[];
  text: string;
  insertionBefore?: ChildNode;
}

/**
 * X preserves authored newlines inside text nodes. Split only at line-break
 * runs so paragraph boundaries can be tracked without changing the post's
 * rendered text or aggregate textContent.
 */
function splitXPostLineBreakTextNodes(root: Element): void {
  const posts = [
    ...(root.matches(X_POST_TEXT_SELECTOR) ? [root] : []),
    ...root.querySelectorAll(X_POST_TEXT_SELECTOR)
  ];

  for (const post of posts) {
    const walker = document.createTreeWalker(post, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);

    for (const node of nodes) {
      const parts = node.data.split(/(\r?\n+)/).filter((part) => part.length > 0);
      if (parts.length < 2) continue;
      node.data = parts[0];
      let anchor: ChildNode = node;
      for (const part of parts.slice(1)) {
        const sibling = document.createTextNode(part);
        anchor.after(sibling);
        anchor = sibling;
      }
    }
  }
}

function getXPostParagraphGroups(
  block: Element,
  groupNodes: TrackedNode[]
): XPostParagraphGroup[] {
  const trackedByNode = new Map(groupNodes.map((tracked) => [tracked.node, tracked]));
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return (node as Element).matches("br") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  const paragraphs: XPostParagraphGroup[] = [];
  let nodes: TrackedNode[] = [];
  let parts: string[] = [];
  let pendingBreaks = 0;
  let firstBreakNode: ChildNode | undefined;

  const finishParagraph = (insertionBefore?: ChildNode): void => {
    const text = parts.join("").trim();
    if (nodes.length && text) paragraphs.push({ nodes, text, insertionBefore });
    nodes = [];
    parts = [];
  };

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const isBreakElement = node.nodeType === Node.ELEMENT_NODE;
    const value = isBreakElement ? "\n" : (node as Text).data;
    const lineBreakCount = isBreakElement
      ? 1
      : (value.match(/\r?\n/g) ?? []).length;

    if (lineBreakCount > 0 && !value.trim()) {
      firstBreakNode ??= node as ChildNode;
      pendingBreaks += lineBreakCount;
      continue;
    }

    const text = normalizeText(value);
    if (!text) continue;
    if (pendingBreaks >= 2 && parts.length) finishParagraph(firstBreakNode);
    else if (pendingBreaks === 1 && parts.length) parts.push("\n");
    else if (parts.length) parts.push(" ");
    pendingBreaks = 0;
    firstBreakNode = undefined;

    parts.push(text);
    const tracked = node.nodeType === Node.TEXT_NODE
      ? trackedByNode.get(node as Text)
      : undefined;
    if (tracked) nodes.push(tracked);
  }

  finishParagraph(pendingBreaks >= 2 ? firstBreakNode : undefined);
  return paragraphs;
}

function findGroupingBlock(element: Element | null): Element | null {
  if (!element) return null;
  const compactNavigationTarget = getCompactNavigationTarget(element);
  if (compactNavigationTarget) return compactNavigationTarget;
  const compactControlTarget = getCompactControlTarget(element);
  if (compactControlTarget) return compactControlTarget;

  // Mail bodies and other web apps commonly use divs with inline formatting
  // instead of semantic paragraphs. Keep each such paragraph together.
  const div = element.closest("div");
  if (div?.closest("[role='main']")
    && !div.querySelector("div,p,table,ul,ol,blockquote,button,input,textarea,[contenteditable]")) {
    return div;
  }

  const readableBlock = element.closest(
    `${SEMANTIC_TEXT_BLOCK_SELECTOR}, label, summary, ${X_POST_TEXT_SELECTOR}`
  );
  if (readableBlock?.matches("summary") && !isInsideReadableSummary(readableBlock)) {
    return null;
  }
  if (readableBlock) return readableBlock;

  const listItem = element.closest("li");
  return listItem && !isStructuredListItem(listItem) ? listItem : null;
}

/**
 * Application timelines and result lists often use a list item as a complete
 * grid/card. Appending a translation to that item makes it another grid child
 * (and can squeeze it into a narrow icon or timeline column). The heading and
 * real paragraphs inside the card remain independently translatable.
 */
function isStructuredListItem(element: Element): boolean {
  return element.matches("li") && Boolean(element.querySelector(HEADING_SELECTOR));
}

function isStructuredListMetadata(element: Element): boolean {
  const listItem = element.closest("li");
  if (!listItem || !isStructuredListItem(listItem)) return false;

  return !element.closest(`p, blockquote, ${HEADING_SELECTOR}`);
}

function shouldSkipElement(
  element: Element,
  includeNavigation = false,
  visibility?: RenderVisibilitySnapshot
): boolean {
  if (element.closest(`.${TRANSLATION_CLASS}`)) return true;
  if (isInsideCodeBlock(element)) return false;
  if (isCompactControlText(element)) {
    return Boolean(element.closest(COMPACT_CONTROL_SKIP_SELECTOR));
  }
  if (SKIP_TAGS.has(element.tagName)) return true;
  if (isCompactNavigationText(element)) {
    if (!includeNavigation && !element.closest(KNOWN_COMPACT_NAV_SELECTOR)) return true;
    return Boolean(element.closest(COMPACT_NAV_SKIP_SELECTOR));
  }
  if (isInsideDocumentSemanticText(element)) {
    return Boolean(element.closest(COMPACT_NAV_SKIP_SELECTOR));
  }
  if (isInsideReadableHeadingContent(element)) {
    return Boolean(element.closest(READABLE_SUMMARY_SKIP_SELECTOR));
  }
  if (isInsideReadableSummary(element)) {
    return Boolean(element.closest(READABLE_SUMMARY_SKIP_SELECTOR));
  }
  const skipSelector = isVisuallyRenderedAriaHiddenText(element, visibility)
    ? VISIBLE_ARIA_HIDDEN_SKIP_SELECTOR
    : SKIP_SELECTOR;
  if (element.closest(skipSelector)) return true;
  return false;
}

function isVisuallyRenderedAriaHiddenText(
  element: Element,
  visibility?: RenderVisibilitySnapshot
): boolean {
  const hiddenContainer = element.closest("[aria-hidden='true']");
  if (!hiddenContainer || hiddenContainer.matches("svg,canvas")) return false;
  const isRendered = visibility?.isElementVisuallyRendered ?? isElementVisuallyRendered;
  if (!isRendered(element) || !isRendered(hiddenContainer)) return false;

  const sourceText = normalizeText(hiddenContainer.textContent ?? "");
  const semanticBlock = hiddenContainer.closest(`p,blockquote,li,${HEADING_SELECTOR}`)
    ?? hiddenContainer.parentElement;
  if (!sourceText || !semanticBlock) return false;

  return Array.from(semanticBlock.querySelectorAll("*")).some((candidate) =>
    candidate !== hiddenContainer &&
    !hiddenContainer.contains(candidate) &&
    !candidate.contains(hiddenContainer) &&
    normalizeText(candidate.textContent ?? "") === sourceText &&
    isVisuallyHiddenElement(candidate)
  );
}

function isVisuallyHiddenElement(element: Element): boolean {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return true;
  }
  if (style.clipPath && style.clipPath !== "none") return true;
  const rect = element.getBoundingClientRect();
  return rect.width <= 2 && rect.height <= 2;
}

function isInsideCodeBlock(element: Element | null): boolean {
  if (!element) return false;
  return Boolean(element.closest(CODE_SELECTOR));
}

function isInlineCodeInReadableText(element: Element): boolean {
  const code = element.closest("code");
  if (!code) return false;
  if (code.closest("pre, .highlight, .example-wrap, .blob-code, .react-code-text")) return false;
  return Boolean(code.closest("p, li, blockquote"));
}

function getReadableBlockText(
  block: Element,
  visibility: RenderVisibilitySnapshot
): { text: string; tokens: ProtectedToken[] } {
  const clone = block.cloneNode(true) as Element;
  const protectedCandidates = Array.from(clone.querySelectorAll("code,kbd,samp")).map((node) => {
    const element = node as Element;
    const sourcePath = getElementPath(clone, element);
    return {
      element,
      sourceElement: sourcePath ? getElementByPath(block, sourcePath) : null
    };
  });
  removeUnrenderedCloneText(block, clone, visibility);
  clone.querySelectorAll("br").forEach((node) => {
    node.replaceWith(document.createTextNode(" "));
  });
  clone
    .querySelectorAll(
      [
        `.${TRANSLATION_CLASS}`,
        "script",
        "style",
        "noscript",
        "button",
        "input",
        "textarea",
        "select",
        "option",
        "rustdoc-toolbar",
        ".anchor",
        ".sr-only",
        "[role='button']",
        "[aria-hidden='true']",
        "[title*='Copy item path']",
        "[aria-label*='Copy item path']"
      ].join(",")
    )
    .forEach((node) => node.remove());

  const tokens: ProtectedToken[] = [];
  protectedCandidates.forEach(({ element, sourceElement }) => {
    if (!clone.contains(element)) return;
    if (!isProtectedInlineElement(element)) return;
    if (!sourceElement) return;
    const protectedElement = getProtectedRenderElement(sourceElement);
    const marker = `⟪WUPAGE${tokens.length}⟫`;
    tokens.push({
      marker,
      node: protectedElement.cloneNode(true) as Element,
      sourceNode: protectedElement
    });
    element.replaceWith(document.createTextNode(` ${marker} `));
  });

  return {
    text: normalizeText(clone.textContent ?? ""),
    tokens
  };
}

function removeUnrenderedCloneText(
  source: Element,
  clone: Element,
  visibility: RenderVisibilitySnapshot
): void {
  const sourceWalker = source.ownerDocument.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const cloneWalker = clone.ownerDocument.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const pairs: Array<{ source: Text; clone: Text }> = [];
  while (sourceWalker.nextNode() && cloneWalker.nextNode()) {
    pairs.push({
      source: sourceWalker.currentNode as Text,
      clone: cloneWalker.currentNode as Text
    });
  }
  for (const pair of pairs) {
    if (!visibility.isTextNodeVisuallyRendered(pair.source)) pair.clone.remove();
  }
}

function renderProtectedText(container: Element, id: string, text: string): void {
  const tokens = protectedTokensById.get(id);
  if (!tokens?.length) {
    container.textContent = text;
    return;
  }

  const tokenByMarker = new Map(tokens.map((token) => [token.marker, token]));
  const pattern = new RegExp(tokens.map((token) => escapeRegExp(token.marker)).join("|"), "g");
  const normalizedText = normalizeProtectedMarkers(text, tokens);
  let cursor = 0;
  for (const match of normalizedText.matchAll(pattern)) {
    const marker = match[0];
    const index = match.index ?? 0;
    if (index > cursor) container.append(document.createTextNode(normalizedText.slice(cursor, index)));
    const token = tokenByMarker.get(marker);
    if (token) container.append(token.node.cloneNode(true));
    cursor = index + marker.length;
  }
  if (cursor < normalizedText.length) container.append(document.createTextNode(normalizedText.slice(cursor)));
}

function normalizeProtectedMarkers(text: string, tokens: ProtectedToken[]): string {
  const markerByIndex = new Map(
    tokens.map((token) => [Number(token.marker.match(/\d+/)?.[0]), token.marker])
  );
  const pattern = /[⟪《〈<【\[\{«「『]\s*WUPAGE\s*(\d+)\s*[⟫》〉>】\]\}»」』]/gi;
  const occurrences = [...text.matchAll(pattern)];
  const indexes = occurrences.map((match) => Number(match[1]));
  const isCompletePermutation =
    occurrences.length === tokens.length &&
    new Set(indexes).size === tokens.length &&
    indexes.every((index) => markerByIndex.has(index));
  const repairByPosition = occurrences.length === tokens.length && !isCompletePermutation;
  let occurrenceIndex = 0;

  pattern.lastIndex = 0;
  return text.replace(pattern, (match, index: string) => {
    if (repairByPosition) {
      return tokens[occurrenceIndex++]?.marker ?? match;
    }
    return markerByIndex.get(Number(index)) ?? match;
  });
}

function isProtectedInlineElement(element: Element): boolean {
  if (element.closest("pre, .highlight, .example-wrap, .blob-code, .react-code-text")) return false;
  return Boolean(element.closest(`li,${SEMANTIC_TEXT_BLOCK_SELECTOR}`));
}

function getProtectedRenderElement(element: Element): Element {
  const link = element.closest("a");
  if (link && link.textContent?.trim() === element.textContent?.trim()) return link;
  return element;
}

function getElementPath(root: Element, element: Element): number[] | null {
  const path: number[] = [];
  let current: Element | null = element;
  while (current && current !== root) {
    const parent: Element | null = current.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
    current = parent;
  }
  return current === root ? path : null;
}

function getElementByPath(root: Element, path: number[]): Element | null {
  let current: Element = root;
  for (const index of path) {
    const next = current.children.item(index);
    if (!next) return null;
    current = next;
  }
  return current;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function insertBlockTranslation(block: Element, translation: Element): void {
  if (block.matches(HEADING_SELECTOR)) {
    translation.setAttribute("data-wupage-container", "heading");
    const anchor = findHeadingAnchor(block);
    if (anchor) {
      anchor.before(translation);
      return;
    }
    block.append(translation);
    return;
  }
  if (block.matches("li")) {
    block.append(translation);
    return;
  }
  block.after(translation);
}

function insertGroupedTranslation(
  group: TrackedGroup,
  translation: Element,
  displayMode: TranslationDisplayMode = "bilingual"
): void {
  const { block, insertionBefore, mode } = group;
  if (insertionBefore?.parentNode) {
    insertionBefore.before(translation);
    return;
  }
  if (displayMode === "replace") {
    block.append(translation);
    return;
  }
  if (mode === "inline") {
    block.append(translation);
    return;
  }
  insertBlockTranslation(block, translation);
}

function findHeadingAnchor(block: Element): Element | null {
  return Array.from(block.children).find((child) =>
    child.matches(".anchor, [href^='#']")
  ) ?? null;
}

function getRenderMode(element: Element | null): RenderMode {
  if (!element) return "inline";
  if (element.matches(X_POST_TEXT_SELECTOR)) return "block";
  if (element.matches("label")) return isChoiceLabel(element) ? "inline" : "block";
  if (element.matches("summary")) return "inline";
  if (isCompactNavigationText(element)) return "inline";
  if (isCompactControlText(element)) return "inline";
  if (isReadableHeading(element)) return "block";
  if (isCompactUiElement(element)) return "inline";
  return "block";
}

function isChoiceLabel(element: Element): boolean {
  if (!element.matches("label")) return false;
  const nestedControl = element.querySelector("input[type='radio'],input[type='checkbox']");
  if (nestedControl) return true;
  const controlId = element.getAttribute("for");
  const control = controlId ? element.ownerDocument.getElementById(controlId) : null;
  return Boolean(control?.matches("input[type='radio'],input[type='checkbox']"));
}

function isCompactUiElement(element: Element): boolean {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const display = style.display;

  if (element.closest("p")) return false;
  if (display === "inline" || display === "inline-block" || display === "inline-flex") {
    return true;
  }
  if (rect.width > 0 && rect.height > 0 && rect.height <= 42) return true;
  if (element.closest("h1,h2,h3,h4,h5,h6")) return true;
  if (element.closest("li,td,th")) return true;
  return false;
}

function isLikelyUiToken(text: string, element: Element | null): boolean {
  if (!element) return false;
  if (isCompactNavigationText(element)) return false;
  if (isCompactControlText(element)) return false;
  if (text.length > 28) return false;
  if (element.closest("p")) return false;
  if (element.closest("figcaption,caption,dt,dd,th,td")) return false;
  if (isReadableHeading(element)) return false;
  const heading = element.closest(HEADING_SELECTOR);
  if (heading && isReadableHeading(heading)) return false;
  if (element.closest("article, main .markdown-body, .markdown-body")) return false;
  if (element.closest("[role='main']")) return false;
  if (/^[A-Z][A-Za-z]+(?:[-_/][A-Za-z0-9]+)+$/.test(text)) return true;
  if (/^[A-Z][A-Za-z\s]{1,24}$/.test(text) && isCompactUiElement(element)) return true;
  return false;
}

function isNonTranslatableFragment(text: string): boolean {
  if (!text.trim()) return true;
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  if (/^<?'?[a-zA-Z]>?$/.test(text)) return true;
  if (/^(::|->|=>|for|of)$/i.test(text)) return true;
  if (/^impl(?:<[^>]+>)?$/i.test(text)) return true;
  return false;
}

function isReadableHeading(element: Element): boolean {
  if (!element.matches(HEADING_SELECTOR)) return false;
  if (isInsideReadableRoot(element)) return true;
  return !element.closest(
    "nav,[role='navigation'],button,[role='button'],[role='tab'],[role='menuitem']"
  );
}

function isInsideDocumentSemanticText(element: Element): boolean {
  const block = element.closest(SEMANTIC_TEXT_BLOCK_SELECTOR);
  return Boolean(block?.closest(DOCUMENT_SEMANTIC_REGION_SELECTOR));
}

function isInsideReadableHeadingContent(element: Element): boolean {
  const heading = element.closest(HEADING_SELECTOR);
  return Boolean(heading && isReadableHeading(heading));
}

function isInsideReadableSummary(element: Element): boolean {
  const summary = element.closest("summary");
  return Boolean(summary && isInsideReadableRoot(summary));
}

function isCompactNavigationText(element: Element): boolean {
  return Boolean(getCompactNavigationTarget(element));
}

function getCompactNavigationTarget(element: Element): Element | null {
  const container = element.closest(NAVIGATION_CONTAINER_SELECTOR);
  if (!container) return null;
  const target = element.closest("a, h2, h3, h4, li, p, [role='listitem']");
  if (!target || !container.contains(target)) return null;
  if (target.matches("button,[role='button']")) return null;
  if (target.querySelector("button,input,select,textarea,[role='button']")) return null;
  const text = normalizeText(target.textContent ?? "");
  if (text.length < 2 || text.length > 80) return null;
  if (target.matches("a") && target.querySelector("img,svg,canvas")) {
    return getNestedTextHost(element, target);
  }
  return target;
}

function isCompactControlText(element: Element): boolean {
  return Boolean(getCompactControlTarget(element));
}

function getCompactControlTarget(element: Element): Element | null {
  const control = element.closest("button,a,[role='button'],[role='tab'],[role='menuitem']");
  if (!control || control.closest(HEADING_SELECTOR)) return null;
  if (control.matches("a:not([role='button'])") && !control.querySelector("img,svg,canvas")) return null;
  if (control.querySelector("input,select,textarea,[contenteditable='true']")) return null;
  const text = normalizeText(control.textContent ?? "");
  if (text.length < 2 || text.length > 120) return null;
  return getNestedTextHost(element, control);
}

function getNestedTextHost(element: Element, container: Element): Element {
  if (element === container) return container;
  let host = element;
  while (host.parentElement && host.parentElement !== container) {
    const parent = host.parentElement;
    if (parent.querySelector("img,svg,canvas,button,input,select,textarea,[role='button']")) break;
    if (normalizeText(parent.textContent ?? "") !== normalizeText(host.textContent ?? "")) break;
    host = parent;
  }
  return host;
}

function isInsideReadableRoot(element: Element): boolean {
  return Boolean(element.closest(READABLE_ROOT_SELECTOR));
}

function findNearestTextBlock(start: Element | null): Element | null {
  let current: Element | null = start;
  while (current && current !== document.body) {
    if (!shouldSkipElement(current) && isTextBlockCandidate(current)) return current;
    current = current.parentElement;
  }
  return null;
}

function findCodeCommentBlock(start: Element): Element | null {
  const codeRoot = start.closest(CODE_COMMENT_TARGET_SELECTOR);
  if (!codeRoot) return null;
  const text = codeRoot.textContent ?? "";
  if (!normalizeText(text)) return null;
  return text.split(/\r?\n/).some((line) => readCommentText(line)) ? codeRoot : null;
}

function isTextBlockCandidate(element: Element): boolean {
  if (element === document.body || element.matches("main, article, section")) return false;
  if (element.matches("div") && !element.closest(".docblock, .methods, .impl-items")) return false;
  const text = normalizeText(element.textContent ?? "");
  if (text.length < 2 || text.length > 320) return false;
  if (!isIssueMetadataValue(element) && isLikelyUiToken(text, element)) return false;
  if (element.querySelector("button,input,select,textarea,[role='button']")) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || rect.height > 140) return false;
  const childTextElements = Array.from(element.children).filter((child) =>
    normalizeText(child.textContent ?? "")
  );
  return childTextElements.length <= 2;
}

function isIssueMetadataValue(element: Element): boolean {
  return element.matches("[class*='IssueMetadata-module__metadataValue__']");
}

function getCodeComment(node: Text): { text: string; prefix: string } | null {
  const parent = node.parentElement;
  if (!parent || !isInsideCodeBlock(parent)) return null;
  const raw = node.textContent ?? "";
  const lines = raw.split(/\r?\n/);
  const comments = lines.map(readCommentText).filter((comment): comment is { text: string; prefix: string } =>
    Boolean(comment)
  );
  if (comments.length !== 1) return null;
  return comments[0];
}

function readCommentText(line: string): { text: string; prefix: string } | null {
  const trimmed = line.trim();
  const match =
    trimmed.match(/^\/\/\s*(.+)$/) ??
    trimmed.match(/^#\s*(.+)$/) ??
    trimmed.match(/^--\s*(.+)$/) ??
    trimmed.match(/^;\s*(.+)$/) ??
    trimmed.match(/^\/\*\s*(.+?)\s*\*\/$/) ??
    trimmed.match(/^\*\s+(.+)$/);
  if (!match) return null;
  const prefix = trimmed.startsWith("/*") ? "/*" : trimmed.match(/^(\/\/|#|--|;|\*)/)?.[1] ?? "//";
  const text = normalizeText(match[1]);
  if (!text || !/\p{L}/u.test(text)) return null;
  return { text, prefix };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
