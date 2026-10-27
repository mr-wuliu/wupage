import {
  createRenderVisibilitySnapshot,
  isElementVisuallyRendered
} from "./visibility";
import type { RenderVisibilitySnapshot } from "./visibility";
import type { TranslationDisplayMode } from "../shared/types";
import { readImageTextLayout } from "./image-text-layout";
import { normalizeProtectedText } from "../shared/protected-text";
import { isDivProseBlock, READABLE_ROOT_SELECTOR } from "./readable-content";

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
  insertionAfter?: ChildNode;
  preserveWhitespace?: boolean;
  authoredLines?: boolean;
  sourceHidden?: { hadClassAttribute: boolean };
}

interface TrackedAttribute {
  id: string;
  element: HTMLElement;
  name: "placeholder";
  sourceValue: string;
  translatedValue?: string;
}

interface TrackedImageText {
  id: string;
  image: HTMLImageElement;
  sourceValue: string;
  replaced?: boolean;
  renderedSource?: string;
  waitingForImage?: boolean;
}

type RenderMode = "block" | "inline" | "code-comment";

interface ProtectedToken {
  marker: string;
  node: Element;
  sourceNode: Element;
  sourceHidden?: { hadClassAttribute: boolean };
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
  "#wupage-selection-translator",
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
  "[contenteditable]:not([contenteditable='false'])",
  "[hidden]",
  "[aria-hidden='true']",
  "details-menu",
  "details-dialog",
  "modal-dialog",
  ".sr-only",
  ".rustdoc-breadcrumbs",
  ".breadcrumbs",
  ".breadcrumb",
  "[aria-label*='breadcrumb']",
  "[aria-label*='Breadcrumb']",
  ".IssueLabel",
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
  ".js-repo-nav"
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
const YOUTUBE_DESCRIPTION_SELECTOR = [
  "#description-inline-expander .ytAttributedStringHost",
  "ytd-expandable-video-description-body-renderer .ytAttributedStringHost",
  "#description yt-formatted-string.content"
].join(",");
// Reddit distributes comment metadata through named shadow-DOM slots. A
// translation added to that wrapper can become an unslotted avatar-column item.
const REDDIT_METADATA_SELECTOR = [
  "shreddit-comment [slot='commentMeta']",
  "shreddit-comment [slot='authorName']",
  "shreddit-comment [slot='authorFlair']",
  "shreddit-comment [slot='timestamp']",
  "shreddit-post [slot='credit-bar']"
].join(",");
const CODE_SELECTOR = "pre, code, .highlight, .example-wrap, .blob-code, .react-code-text";
const CODE_COMMENT_TARGET_SELECTOR = ".react-code-text, .blob-code, pre, code, .highlight";

let trackedNodes: TrackedNode[] = [];
let trackedGroups: TrackedGroup[] = [];
let trackedAttributes: TrackedAttribute[] = [];
let trackedImageTexts: TrackedImageText[] = [];
let protectedTokensById = new Map<string, ProtectedToken[]>();
let sourceTextById = new Map<string, string>();
const renderedById = new Map<string, Element>();
const translatedTextById = new Map<string, string>();
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
  X_POST_TEXT_SELECTOR,
  YOUTUBE_DESCRIPTION_SELECTOR
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
  trackedImageTexts = trackedImageTexts.filter((tracked) =>
    tracked.image !== element && !element.contains(tracked.image)
  );
  pruneTranslationResults();
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
  for (const tracked of trackedImageTexts) {
    const anchor = tracked.image.closest("picture") ?? tracked.image;
    const output = renderedById.get(tracked.id);
    if (!tracked.image.isConnected || tracked.image.getAttribute("alt") !== tracked.sourceValue
      || (tracked.renderedSource && tracked.renderedSource !== (tracked.image.currentSrc || tracked.image.src))
      || (tracked.waitingForImage && tracked.image.complete && tracked.image.naturalWidth > 0)
      || (output && output.parentElement !== anchor.parentElement)) {
      stale.add(tracked.id);
    }
    if (stale.has(tracked.id)) {
      restoreImageTextSource(tracked);
      tracked.image.removeAttribute(TRANSLATED_ATTR);
      tracked.image.removeAttribute(TARGET_ATTR);
    }
  }
  for (const tracked of trackedNodes) {
    if (!stale.has(tracked.id)) continue;
    // Never overwrite a new value supplied by the host application.
    if (tracked.replaced && tracked.node.data === "") tracked.node.data = tracked.sourceValue;
  }
  for (const group of trackedGroups) {
    if (stale.has(group.id)) restoreGroupedSource(group);
  }
  for (const id of stale) {
    renderedById.get(id)?.remove();
    renderedById.delete(id);
    removePendingForId(id);
    for (const token of protectedTokensById.get(id) ?? []) {
      restoreProtectedSource(token);
    }
    protectedTokensById.delete(id);
    sourceTextById.delete(id);
    translatedTextById.delete(id);
  }
  trackedNodes = trackedNodes.filter((node) => !stale.has(node.id));
  trackedGroups = trackedGroups.filter((group) => !stale.has(group.id));
  trackedAttributes = trackedAttributes.filter((attribute) => !stale.has(attribute.id));
  trackedImageTexts = trackedImageTexts.filter((tracked) => !stale.has(tracked.id));
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
  // Image translations follow their picture, so they can sit outside the root
  // being cleared (including when the root is the img itself).
  for (const tracked of trackedImageTexts) {
    if (tracked.image !== element && !element.contains(tracked.image)) continue;
    renderedById.get(tracked.id)?.remove();
    renderedById.delete(tracked.id);
    removePendingForId(tracked.id);
    tracked.image.removeAttribute(TRANSLATED_ATTR);
    tracked.image.removeAttribute(TARGET_ATTR);
  }
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
  trackedImageTexts = trackedImageTexts.filter((tracked) =>
    tracked.image !== element && !element.contains(tracked.image)
  );
  pruneTranslationResults();
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
  splitAuthoredLineBreakTextNodes(root, X_POST_TEXT_SELECTOR);
  splitAuthoredLineBreakTextNodes(root, YOUTUBE_DESCRIPTION_SELECTOR, true);
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
    if (node.parentElement?.closest(YOUTUBE_DESCRIPTION_SELECTOR)
      && /^https?:\/\/\S+$/i.test(sourceText)) continue;
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
  const imageTextSegments = collectImageTextSegments(root, visibility);
  const collectedSegments = [...groupedSegments, ...attributeSegments, ...imageTextSegments];
  collectedSegments.forEach((segment) => sourceTextById.set(segment.id, segment.text));
  return collectedSegments;
}

export function renderTranslations(
  translations: Array<{ id: string; text: string }>,
  displayMode: TranslationDisplayMode = "bilingual"
): void {
  translations = translations.flatMap(({ id, text }) => {
    if (!protectedTokensById.has(id)) return [{ id, text }];
    const normalized = normalizeProtectedText(sourceTextById.get(id) ?? "", text);
    if (normalized !== undefined) return [{ id, text: normalized }];
    // Keep the original visible if an unvalidated result reaches the renderer.
    // Formula/code identity cannot safely be reconstructed from occurrence order.
    removePendingForId(id);
    return [];
  });
  const translationById = new Map(translations.map((entry) => [entry.id, entry.text]));
  for (const { id, text } of translations) {
    if (sourceTextById.has(id)) translatedTextById.set(id, text);
  }

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
    if (displayMode === "replace") {
      replaceTrackedSource(group.nodes, group.id);
      if (group.authoredLines) {
        group.sourceHidden ??= { hadClassAttribute: group.block.hasAttribute("class") };
        group.block.classList.add(REPLACED_SOURCE_CLASS);
      }
    }
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

  for (const tracked of trackedImageTexts) {
    const translation = translationById.get(tracked.id);
    if (!translation || !tracked.image.isConnected) continue;
    removePendingForId(tracked.id);
    renderedById.get(tracked.id)?.remove();
    renderedById.delete(tracked.id);
    restoreImageTextSource(tracked);
    if (isSameTranslation(tracked.id, translation)) {
      tracked.image.removeAttribute(TRANSLATED_ATTR);
      tracked.image.removeAttribute(TARGET_ATTR);
      continue;
    }
    const element = document.createElement("span");
    element.className = TRANSLATION_CLASS;
    element.dataset.wupageDisplayMode = displayMode;
    element.setAttribute("lang", "translated");
    if (displayMode !== "replace") element.setAttribute("aria-hidden", "true");
    applyTranslationTextColor(element, tracked.image.parentElement ?? tracked.image, displayMode);
    if (!renderInterleavedImageText(tracked, element, translation, displayMode)) {
      element.textContent = translation;
    }
    insertImageTextTranslation(tracked, element);
    renderedById.set(tracked.id, element);
  }
}

// Reuse the raw results, including protected markers and image paragraphs.
// Restoring source nodes first makes replacement mode reversible and lets the
// new display inherit the source's color rather than the previous accent.
export function setTranslationDisplayMode(displayMode: TranslationDisplayMode): void {
  invalidateStaleSegments();
  for (const [id, output] of renderedById) {
    if (!translatedTextById.has(id)) continue;
    output.remove();
    renderedById.delete(id);
  }
  restoreReplacedSourcesIn(document.documentElement);
  renderTranslations([...translatedTextById].map(([id, text]) => ({ id, text })), displayMode);
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

  for (const tracked of trackedImageTexts) {
    if (!pendingIds.has(tracked.id) || !tracked.image.isConnected) continue;
    removePendingForId(tracked.id);
    const pending = createPendingElement(tracked.id, "block");
    insertImageTextTranslation(tracked, pending);
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
  hideTranslations();
  clearNodeTracking();
}

export function hideTranslations(): void {
  restoreTrackedAttributesIn(document.documentElement);
  restoreReplacedSourcesIn(document.documentElement);
  document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((node) => node.remove());
  document.querySelectorAll(`[${TRANSLATED_ATTR}]`).forEach((node) => {
    node.removeAttribute(TRANSLATED_ATTR);
  });
  document.querySelectorAll(`[${TARGET_ATTR}]`).forEach((node) => {
    node.removeAttribute(TARGET_ATTR);
  });
  renderedById.clear();
  for (const tracked of trackedAttributes) tracked.translatedValue = undefined;
}

export function restoreTranslations(displayMode: TranslationDisplayMode): void {
  renderTranslations([...translatedTextById].map(([id, text]) => ({ id, text })), displayMode);
}

function clearNodeTracking(): void {
  trackedNodes = [];
  trackedGroups = [];
  trackedAttributes = [];
  trackedImageTexts = [];
  protectedTokensById = new Map();
  sourceTextById = new Map();
  renderedById.clear();
  translatedTextById.clear();
}

function pruneTranslationResults(): void {
  const ids = new Set([...trackedNodes, ...trackedGroups, ...trackedAttributes, ...trackedImageTexts].map((entry) => entry.id));
  for (const id of translatedTextById.keys()) {
    if (!ids.has(id)) translatedTextById.delete(id);
  }
}

function collectImageTextSegments(
  root: Element,
  visibility: RenderVisibilitySnapshot
): TextSegment[] {
  const trackedImages = new Set(trackedImageTexts.map((tracked) => tracked.image));
  const candidates = [
    ...(root.matches("img[alt]") ? [root] : []),
    ...root.querySelectorAll("img[alt]")
  ];
  const segments: TextSegment[] = [];
  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLImageElement) || trackedImages.has(candidate)) continue;
    if (shouldSkipElement(candidate, true, visibility)
      || !visibility.isElementVisuallyRendered(candidate)) continue;
    const sourceValue = candidate.getAttribute("alt") ?? "";
    // Promotional sites often render entire paragraphs as images and supply
    // their text in alt. Ignore short labels such as logos and image buttons.
    if (normalizeText(sourceValue).length < 80 || !/\p{L}/u.test(sourceValue)) continue;
    const text = sourceValue.split(/\r?\n/).map(normalizeText).filter(Boolean).join("\n\n");
    const id = `seg-${Date.now()}-${segmentIdCounter++}`;
    trackedImageTexts.push({ id, image: candidate, sourceValue });
    segments.push({ id, text, element: candidate });
  }
  return segments;
}

function insertImageTextTranslation(tracked: TrackedImageText, element: HTMLElement): void {
  const image = tracked.image;
  const anchor = image.closest("picture") ?? image;
  const targetId = ensureTranslationTarget(image);
  element.dataset.wupageMode = "block";
  element.dataset.wupageContainer = "image-text";
  element.setAttribute(TRANSLATION_TARGET_ATTR, targetId);
  if (anchor.hasAttribute("slot")) element.setAttribute("slot", anchor.getAttribute("slot")!);
  anchor.after(element);
  image.setAttribute(TRANSLATED_ATTR, "true");
}

function renderInterleavedImageText(
  tracked: TrackedImageText,
  element: HTMLElement,
  translation: string,
  displayMode: TranslationDisplayMode
): boolean {
  const paragraphs = tracked.sourceValue.split(/\r?\n/).map(normalizeText).filter(Boolean);
  const blocks = translation.split(/\r?\n\s*\r?\n/).map((text) => text.trim()).filter(Boolean);
  const translated = blocks.length === paragraphs.length
    ? blocks
    : translation.split(/\r?\n/).map((text) => text.trim()).filter(Boolean);
  if (translated.length !== paragraphs.length) return false;
  tracked.waitingForImage = !tracked.image.complete;
  const layout = readImageTextLayout(tracked.image, paragraphs.length);
  if (!layout) return false;
  const source = tracked.image.currentSrc || tracked.image.src;
  element.dataset.wupageImageLayout = "interleaved";
  setTranslationTextColor(element, layout.foreground);
  element.style.setProperty("--wupage-image-font-size", `clamp(14px, ${layout.fontRatio * 100}cqw, 32px)`);
  // The original is now represented by the individual image slices. Keep
  // those alternatives accessible, hiding only the bilingual translation.
  element.removeAttribute("aria-hidden");
  paragraphs.forEach((text, index) => {
    const row = document.createElement("span");
    row.className = "wupage-image-text-row";
    if (displayMode !== "replace") {
      const slice = layout.slices[index];
      const original = document.createElement("span");
      original.className = "wupage-image-text-original";
      original.style.aspectRatio = `${layout.width} / ${slice.bottom - slice.top}`;
      const image = document.createElement("img");
      image.src = source;
      image.alt = text;
      image.draggable = false;
      image.style.transform = `translateY(${-slice.top / layout.height * 100}%)`;
      original.append(image);
      row.append(original);
    }
    const result = document.createElement("span");
    result.className = "wupage-image-text-result";
    result.textContent = translated[index];
    if (displayMode !== "replace") result.setAttribute("aria-hidden", "true");
    if (displayMode === "bilingual-accent") {
      const channels = layout.foreground.match(/\d+/g)!.map(Number);
      const background = channels.reduce((sum, value) => sum + value, 0) > 384
        ? "rgb(23, 32, 38)" : "rgb(255, 255, 255)";
      setTranslationTextColor(result, mapTranslationTextColor(layout.foreground, background) ?? layout.foreground);
    }
    row.append(result);
    element.append(row);
  });
  if (!tracked.image.classList.contains(REPLACED_SOURCE_CLASS)) {
    tracked.image.classList.add(REPLACED_SOURCE_CLASS);
    tracked.replaced = true;
  }
  tracked.renderedSource = source;
  return true;
}

function restoreImageTextSource(tracked: TrackedImageText): void {
  if (tracked.replaced) tracked.image.classList.remove(REPLACED_SOURCE_CLASS);
  tracked.replaced = false;
  tracked.renderedSource = undefined;
  tracked.waitingForImage = false;
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
    token.sourceHidden = { hadClassAttribute: token.sourceNode.hasAttribute("class") };
    token.sourceNode.classList.add(REPLACED_SOURCE_CLASS);
  }
}

function restoreGroupedSource(group: TrackedGroup): void {
  if (!group.sourceHidden) return;
  group.block.classList.remove(REPLACED_SOURCE_CLASS);
  if (!group.sourceHidden.hadClassAttribute && group.block.getAttribute("class") === "") {
    group.block.removeAttribute("class");
  }
  group.sourceHidden = undefined;
}

function restoreProtectedSource(token: ProtectedToken): void {
  if (!token.sourceHidden) return;
  token.sourceNode.classList.remove(REPLACED_SOURCE_CLASS);
  if (!token.sourceHidden.hadClassAttribute && token.sourceNode.getAttribute("class") === "") {
    token.sourceNode.removeAttribute("class");
  }
  token.sourceHidden = undefined;
}

function restoreReplacedSourcesIn(root: Element): void {
  for (const group of trackedGroups) {
    if (group.sourceHidden && (group.block === root || root.contains(group.block))) {
      restoreGroupedSource(group);
    }
  }
  for (const tracked of trackedImageTexts) {
    if (tracked.image === root || root.contains(tracked.image)) restoreImageTextSource(tracked);
  }
  for (const tracked of trackedNodes) {
    if (!tracked.replaced || !tracked.node.parentElement) continue;
    if (tracked.node.parentElement !== root && !root.contains(tracked.node.parentElement)) continue;
    if (tracked.node.data === "") tracked.node.data = tracked.sourceValue;
    tracked.replaced = false;
  }
  for (const tokens of protectedTokensById.values()) {
    for (const token of tokens) {
      if (token.sourceNode !== root && !root.contains(token.sourceNode)) continue;
      restoreProtectedSource(token);
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
    setTranslationTextColor(translation, color);
    return;
  }
  const mapped = mapTranslationTextColor(color, getEffectiveBackgroundColor(source));
  setTranslationTextColor(translation, mapped ?? color);
}

function setTranslationTextColor(translation: HTMLElement, color: string): void {
  // Host pages can force span colors or inherit a fixed WebKit text fill.
  // Keep the selected mode's color visible in both cases.
  translation.style.setProperty("color", color, "important");
  translation.style.setProperty("-webkit-text-fill-color", "currentColor", "important");
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
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const darkBackground = contrastRatio(white, opaqueBackground) > contrastRatio(black, opaqueBackground);
  const contrastColor = darkBackground ? white : black;
  const ensureContrast = (color: RgbaColor): RgbaColor => contrastRatio(color, opaqueBackground) >= 4.6
    ? color : mixUntilContrast(color, contrastColor, opaqueBackground, 4.6);
  const accent = darkBackground
    ? { r: 94, g: 234, b: 212, a: 1 }
    : { r: 15, g: 118, b: 110, a: 1 };
  let mapped = ensureContrast(mixColors(opaqueSource, accent, 0.65));

  if (colorDistance(mapped, opaqueSource) < 48) {
    // Teal source text needs a different accent, not another near-identical teal.
    const alternate = darkBackground
      ? { r: 147, g: 197, b: 253, a: 1 }
      : { r: 37, g: 99, b: 235, a: 1 };
    mapped = ensureContrast(mixColors(opaqueSource, alternate, 0.8));
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

let cssColorContext: CanvasRenderingContext2D | null | undefined;
const resolvedCssColors = new Map<string, RgbaColor>();

function parseCssColor(value: string): RgbaColor | null {
  if (!value) return null;
  const match = value.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (!match) return resolveCssColor(value);
  const alphaValue = match[4] === undefined ? 1 : Number.parseFloat(match[4]);
  const alpha = match[4]?.includes("%") ? alphaValue / 100 : alphaValue;
  return {
    r: clampColorChannel(Number(match[1])),
    g: clampColorChannel(Number(match[2])),
    b: clampColorChannel(Number(match[3])),
    a: Math.max(0, Math.min(1, alpha))
  };
}

function resolveCssColor(value: string): RgbaColor | null {
  const cached = resolvedCssColors.get(value);
  if (cached) return cached;
  if (typeof CSS === "undefined" || !CSS.supports("color", value)
    || typeof CanvasRenderingContext2D === "undefined") return null;
  try {
    if (cssColorContext === undefined) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      cssColorContext = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!cssColorContext) return null;
    // Computed styles preserve oklch(), lab() and color(display-p3 ...).
    // Let the browser convert them into sRGB instead of falling back to the source.
    cssColorContext.clearRect(0, 0, 1, 1);
    cssColorContext.fillStyle = value;
    cssColorContext.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = cssColorContext.getImageData(0, 0, 1, 1).data;
    const color = { r, g, b, a: alpha / 255 };
    if (resolvedCssColors.size >= 256) resolvedCssColors.clear();
    resolvedCssColors.set(value, color);
    return color;
  } catch {
    return null;
  }
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
    if (block.querySelector(`.${TRANSLATION_CLASS}`) && !block.matches(YOUTUBE_DESCRIPTION_SELECTOR)) continue;
    const group = groups.get(block) ?? [];
    group.push(tracked);
    groups.set(block, group);
  }

  const groupedSegments: TextSegment[] = [];
  const trackedSourceNodes = new Set(trackedNodes.map((entry) => entry.node));
  for (const [block, groupNodes] of groups) {
    if (block.matches(YOUTUBE_DESCRIPTION_SELECTOR)) {
      for (const line of getYouTubeDescriptionLines(block, groupNodes, visibility)) {
        const id = line.nodes[0].id;
        trackedGroups.push({
          id,
          nodes: line.nodes,
          block,
          mode: "block",
          insertionAfter: line.nodes.at(-1)!.node
        });
        groupedSegments.push({ id, text: line.text, element: block });
        line.nodes.forEach((tracked) => standalone.delete(tracked.id));
      }
      continue;
    }
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
      !block.matches(`summary, label, li, ${X_POST_TEXT_SELECTOR}`)
    ) continue;
    if (!text) continue;
    const authoredLines = isAuthoredLineTextBlock(block);
    const sourceNodes = completeGroupedSourceNodes(block, groupNodes, visibility, trackedSourceNodes);
    trackedGroups.push({ id, nodes: sourceNodes, block, mode: authoredLines ? "block" : getRenderMode(block), authoredLines });
    if (tokens.length) protectedTokensById.set(id, tokens);
    groupedSegments.push({ id, text, element: block });
    groupNodes.forEach((tracked) => standalone.delete(tracked.id));
  }

  return [
    ...groupedSegments,
    ...fallback.filter((segment) => standalone.has(segment.id))
  ];
}

function completeGroupedSourceNodes(
  block: Element,
  nodes: TrackedNode[],
  visibility: RenderVisibilitySnapshot,
  tracked: Set<Text>
): TrackedNode[] {
  const complete = [...nodes];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (tracked.has(node) || !parent || findGroupingBlock(parent) !== block
      || parent.closest("code,kbd,samp,button,input,textarea,select,option,[role='button']")
      || shouldSkipElement(parent, true, visibility) || !visibility.isTextNodeVisuallyRendered(node)) continue;
    // Short words, punctuation and whitespace can be in the complete paragraph
    // even when they were unsuitable as standalone translation requests.
    const entry: TrackedNode = {
      id: nodes[0].id, node, mode: nodes[0].mode, sourceValue: node.data, sourceParent: parent
    };
    trackedNodes.push(entry);
    tracked.add(node);
    complete.push(entry);
  }
  return complete;
}

interface XPostParagraphGroup {
  nodes: TrackedNode[];
  text: string;
  insertionBefore?: ChildNode;
}

// Description runs contain literal newlines, with links in separate siblings.
// Track each authored line so providers cannot flatten the description and so
// translations stay beside their source rather than at the end of the host.
function splitAuthoredLineBreakTextNodes(root: Element, selector: string, skipLinks = false): void {
  const descriptions = [
    ...(root.matches(selector) ? [root] : []),
    ...root.querySelectorAll(selector)
  ];
  for (const description of descriptions) {
    const walker = document.createTreeWalker(description, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      if (node.parentElement?.closest(`.${TRANSLATION_CLASS}`)
        || (skipLinks && node.parentElement?.closest("a"))) continue;
      const breaks = [...node.data.matchAll(/\r?\n+/g)];
      for (const match of breaks.reverse()) {
        const end = match.index! + match[0].length;
        if (end < node.length) node.splitText(end);
        if (match.index! > 0) node.splitText(match.index!);
      }
    }
  }
}

function getYouTubeDescriptionLines(
  block: Element,
  groupNodes: TrackedNode[],
  visibility: RenderVisibilitySnapshot
): Array<{ nodes: TrackedNode[]; text: string }> {
  const trackedByNode = new Map(groupNodes.map((tracked) => [tracked.node, tracked]));
  const lines: Array<{ nodes: TrackedNode[]; text: string }> = [];
  let nodes: TrackedNode[] = [];
  let sourceNodes: Text[] = [];
  let parts: string[] = [];
  const finish = (): void => {
    const text = normalizeText(parts.join(""));
    if (nodes.length && text) {
      // Include punctuation and short inline fragments in replacement/restore
      // tracking even when they could not be translated on their own.
      const id = nodes[0].id;
      nodes = sourceNodes.map((node) => {
        const existing = trackedByNode.get(node);
        if (existing) return existing;
        const tracked: TrackedNode = {
          id, node, mode: "block", sourceValue: node.data, sourceParent: node.parentElement!
        };
        trackedNodes.push(tracked);
        return tracked;
      });
      lines.push({ nodes, text });
    }
    nodes = [];
    sourceNodes = [];
    parts = [];
  };
  const visit = (parent: Element): void => {
    for (const child of parent.childNodes) {
      if (child instanceof Element) {
        if (child.matches(`.${TRANSLATION_CLASS}`)) continue;
        // Keep original URLs and video chips intact and independently clickable.
        if (child.matches("a, br")) {
          finish();
        } else if (!shouldSkipElement(child, true, visibility)) {
          visit(child);
        }
      } else if (child instanceof Text) {
        if (/\r?\n/.test(child.data)) {
          finish();
        } else if (visibility.isTextNodeVisuallyRendered(child)) {
          parts.push(child.data);
          sourceNodes.push(child);
          const tracked = trackedByNode.get(child);
          if (tracked) nodes.push(tracked);
        }
      }
    }
  };
  visit(block);
  finish();
  return lines;
}

function getXPostParagraphGroups(
  block: Element,
  groupNodes: TrackedNode[]
): XPostParagraphGroup[] {
  const trackedByNode = new Map(groupNodes.map((tracked) => [tracked.node, tracked]));
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if ((node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest(`.${TRANSLATION_CLASS}`)) {
        return NodeFilter.FILTER_REJECT;
      }
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
  const description = element.closest(YOUTUBE_DESCRIPTION_SELECTOR);
  if (description) return element.closest("a") ? null : description;
  const compactNavigationTarget = getCompactNavigationTarget(element);
  if (compactNavigationTarget) return compactNavigationTarget;
  const compactControlTarget = getCompactControlTarget(element);
  if (compactControlTarget) return compactControlTarget;

  const readableBlock = element.closest(
    `${SEMANTIC_TEXT_BLOCK_SELECTOR}, label, summary, ${X_POST_TEXT_SELECTOR}`
  );
  if (readableBlock?.matches("summary") && !isInsideReadableSummary(readableBlock)) {
    return null;
  }
  if (readableBlock) return readableBlock;

  // Promotional pages often use a span with authored <br> lines as a whole
  // paragraph. Treating its text runs as inline labels appends each translation
  // to the same nowrap line and sends it into adjacent images or clipped cards.
  let candidate: Element | null = element;
  while (candidate && candidate !== document.body) {
    if (isAuthoredLineTextBlock(candidate)) return candidate;
    if (!candidate.matches("span,em,strong,b,i,u,small,mark,code,a,ruby,rt")) break;
    candidate = candidate.parentElement;
  }

  const div = element.closest("div");
  if (div && isDivProseBlock(div)) return div;

  const listItem = element.closest("li");
  return listItem && !isStructuredListItem(listItem) ? listItem : null;
}

function isAuthoredLineTextBlock(element: Element): boolean {
  if (!element.matches("span") || !element.querySelector("br")) return false;
  if (element.closest("a,button,nav,[role='navigation'],[role='button'],[role='tab']")) return false;
  if (element.querySelector("div,p,ul,ol,table,img,picture,video,iframe,input,textarea,select,button,[contenteditable]")) return false;
  if (normalizeText(element.textContent ?? "").length < 24) return false;
  if (/^(?:inline-)?(?:flex|grid)$/u.test(window.getComputedStyle(element).display)) return false;
  // Keep a translation inside its existing layout cell rather than creating
  // an extra flex/grid item next to the source.
  if (element.parentElement && /^(?:inline-)?(?:flex|grid)$/u.test(window.getComputedStyle(element.parentElement).display)) return false;
  const lines = element.innerHTML.split(/<br\b[^>]*>/iu).filter((line) => line.replace(/<[^>]*>/gu, "").trim());
  return lines.length >= 2;
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
  if (element.closest(REDDIT_METADATA_SELECTOR)) return true;
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
  const div = code.closest("div");
  return Boolean(code.closest("p, li, blockquote") || (div && isDivProseBlock(div)));
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
        "[hidden]",
        "[contenteditable]:not([contenteditable='false'])",
        "[title*='Copy item path']",
        "[aria-label*='Copy item path']"
      ].join(",")
    )
    .forEach((node) => node.remove());

  const tokens: ProtectedToken[] = [];
  protectedCandidates.forEach(({ element, sourceElement }) => {
    if (!clone.contains(element)) return;
    if (!sourceElement) return;
    if (!isProtectedInlineElement(sourceElement)) return;
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
  const normalizedText = text;
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

function isProtectedInlineElement(element: Element): boolean {
  if (element.closest("pre, .highlight, .example-wrap, .blob-code, .react-code-text")) return false;
  const div = element.closest("div");
  return Boolean(element.closest(`li,${SEMANTIC_TEXT_BLOCK_SELECTOR}`) || (div && isDivProseBlock(div)));
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
  // Keep translated text in the same named slot as its source. A sibling
  // without a slot is rendered in the custom element's default slot instead.
  if (block.hasAttribute("slot")) {
    block.append(translation);
    return;
  }
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
  const { block, insertionBefore, insertionAfter, mode } = group;
  if (group.authoredLines) {
    translation.setAttribute("data-wupage-container", "authored-lines");
    block.after(translation);
    return;
  }
  if (insertionAfter?.parentNode) {
    if (block.matches(YOUTUBE_DESCRIPTION_SELECTOR)) {
      translation.setAttribute("data-wupage-container", "youtube-description");
    }
    insertionAfter.after(translation);
    return;
  }
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
  // Normal list items carry prose even when short or composed of one link.
  // Navigation and control labels are classified before reaching this check.
  if (element.matches("li") && display === "list-item") return false;
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
  if (element.closest(YOUTUBE_DESCRIPTION_SELECTOR)) return false;
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
