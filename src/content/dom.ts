export interface TextSegment {
  id: string;
  text: string;
}

interface TrackedNode {
  id: string;
  node: Text;
  mode: RenderMode;
  commentPrefix?: string;
}

interface TrackedGroup {
  id: string;
  nodes: TrackedNode[];
}

type RenderMode = "block" | "inline" | "code-comment";

const TRANSLATION_CLASS = "wupage-translation";
const PENDING_CLASS = "wupage-translation-pending";
const TRANSLATED_ATTR = "data-wupage-translated";
const TARGET_ATTR = "data-wupage-target-id";
const TRANSLATION_TARGET_ATTR = "data-wupage-translation-target";
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "BUTTON",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "OPTION",
  "LABEL",
  "KBD",
  "SAMP",
  "SVG",
  "CANVAS"
]);
const SKIP_SELECTOR = [
  "header",
  "nav",
  "footer",
  "aside",
  "summary",
  "button",
  "label",
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
].join(",");
const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";
const READABLE_ROOT_SELECTOR = "main,article,[role='main'],.markdown-body,.docblock,#main-content";
const CODE_SELECTOR = "pre, code, .highlight, .example-wrap, .blob-code, .react-code-text";
const CODE_COMMENT_TARGET_SELECTOR = ".react-code-text, .blob-code, pre, code, .highlight";

let trackedNodes: TrackedNode[] = [];
let trackedGroups: TrackedGroup[] = [];
let targetIdCounter = 0;

const PARAGRAPH_SELECTOR = [
  "p",
  "li",
  "blockquote",
  HEADING_SELECTOR,
  "[class*='IssueMetadata-module__metadataValue__']",
  ".docblock p",
  ".docblock li",
  ".docblock blockquote",
  ".methods p",
  ".impl-items p",
  ".markdown-body > div",
  ".markdown-body > p",
  ".comment-body p"
].join(",");

export function collectTextSegments(): TextSegment[] {
  clearNodeTracking();
  return collectTextSegmentsFromRoot(document.body, true);
}

export function collectParagraphTextSegments(element: Element): TextSegment[] {
  trackedNodes = trackedNodes.filter((tracked) => !element.contains(tracked.node));
  trackedGroups = trackedGroups.filter((group) => !group.nodes.some((tracked) => element.contains(tracked.node)));
  return collectTextSegmentsFromRoot(element, false);
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

function collectTextSegmentsFromRoot(root: Element, resetTracking: boolean): TextSegment[] {
  if (resetTracking) clearNodeTracking();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
      if (!isElementVisible(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const segments: TextSegment[] = [];
  const textNodes: TrackedNode[] = [];
  let index = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const codeComment = getCodeComment(node);
    if (isInsideCodeBlock(node.parentElement) && !codeComment) continue;
    const text = normalizeText(node.textContent ?? "");
    const sourceText = codeComment?.text ?? text;
    if (!sourceText || sourceText.length < 2) continue;
    if (!codeComment && isNonTranslatableFragment(sourceText)) continue;
    if (!codeComment && isLikelyUiToken(sourceText, node.parentElement)) continue;
    const id = `seg-${Date.now()}-${index}`;
    const tracked: TrackedNode = {
      id,
      node,
      mode: codeComment ? "code-comment" : getRenderMode(node.parentElement),
      commentPrefix: codeComment?.prefix
    };
    trackedNodes.push(tracked);
    textNodes.push(tracked);
    segments.push({ id, text: sourceText });
    index += 1;
  }

  return groupTextSegments(textNodes, segments);
}

export function renderTranslations(translations: Array<{ id: string; text: string }>): void {
  const translationById = new Map(translations.map((entry) => [entry.id, entry.text]));

  for (const group of trackedGroups) {
    const translation = translationById.get(group.id);
    const anchor = group.nodes.at(-1);
    const parent = anchor?.node.parentElement;
    if (!translation || !anchor || !parent || parent.closest(`.${TRANSLATION_CLASS}`)) continue;

    removePendingForId(group.id);
    const element = document.createElement("span");
    element.className = TRANSLATION_CLASS;
    element.dataset.wupageMode = "block";
    element.textContent = translation;
    element.setAttribute("lang", "translated");
    element.setAttribute("aria-hidden", "true");
    parent.setAttribute(TRANSLATED_ATTR, "true");
    anchor.node.after(element);
  }

  for (const tracked of trackedNodes) {
    if (trackedGroups.some((group) => group.nodes.includes(tracked))) continue;
    const translation = translationById.get(tracked.id);
    const parent = tracked.node.parentElement;
    if (!translation || !parent || parent.closest(`.${TRANSLATION_CLASS}`)) continue;

    removePendingForId(tracked.id);
    const element = document.createElement("span");
    element.className = TRANSLATION_CLASS;
    element.dataset.wupageMode = tracked.mode;
    element.textContent =
      tracked.mode === "code-comment" ? `${tracked.commentPrefix ?? "//"} ${translation}` : translation;
    element.setAttribute("lang", "translated");
    element.setAttribute("aria-hidden", "true");
    parent.setAttribute(TRANSLATED_ATTR, "true");
    tracked.node.after(element);
  }
}

export function renderTargetTranslation(element: Element, text: string): void {
  const targetId = ensureTranslationTarget(element);
  findTargetTranslations(targetId).forEach((node) => node.remove());

  const translation = document.createElement("span");
  translation.className = TRANSLATION_CLASS;
  translation.dataset.wupageMode = getRenderMode(element);
  translation.textContent = text;
  translation.setAttribute("lang", "translated");
  translation.setAttribute("aria-hidden", "true");
  translation.setAttribute(TRANSLATION_TARGET_ATTR, targetId);
  element.setAttribute(TRANSLATED_ATTR, "true");
  element.append(translation);
}

export function renderTranslationPlaceholders(segments: TextSegment[]): void {
  const pendingIds = new Set(segments.map((segment) => segment.id));

  for (const group of trackedGroups) {
    if (!pendingIds.has(group.id)) continue;
    const anchor = group.nodes.at(-1);
    const parent = anchor?.node.parentElement;
    if (!anchor || !parent || parent.closest(`.${TRANSLATION_CLASS}`)) continue;
    insertPending(anchor.node, group.id, "block");
    parent.setAttribute(TRANSLATED_ATTR, "true");
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
  pending.setAttribute(TRANSLATION_TARGET_ATTR, targetId);
  element.setAttribute(TRANSLATED_ATTR, "true");
  element.append(pending);
}

export function clearTranslations(): void {
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
}

function findTargetTranslations(targetId: string): Element[] {
  return Array.from(document.querySelectorAll(`[${TRANSLATION_TARGET_ATTR}]`)).filter(
    (node) => node.getAttribute(TRANSLATION_TARGET_ATTR) === targetId
  );
}

function insertPending(anchor: Text, id: string, mode: RenderMode): void {
  removePendingForId(id);
  anchor.after(createPendingElement(id, mode));
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
    node.remove();
  });
}

function groupTextSegments(nodes: TrackedNode[], fallback: TextSegment[]): TextSegment[] {
  const groups = new Map<Element, TrackedNode[]>();
  const standalone = new Set(fallback.map((segment) => segment.id));

  for (const tracked of nodes) {
    if (tracked.mode === "code-comment") continue;
    const block = tracked.node.parentElement?.closest(`p, li, blockquote, ${HEADING_SELECTOR}`);
    if (!block) continue;
    if (block.querySelector(`.${TRANSLATION_CLASS}`)) continue;
    const group = groups.get(block) ?? [];
    group.push(tracked);
    groups.set(block, group);
  }

  const groupedSegments: TextSegment[] = [];
  for (const groupNodes of groups.values()) {
    const block = groupNodes[0].node.parentElement?.closest(`p, li, blockquote, ${HEADING_SELECTOR}`);
    if (!block) continue;
    const nodeText = normalizeText(groupNodes.map((tracked) => tracked.node.textContent ?? "").join(" "));
    const text = getReadableBlockText(block);
    if (groupNodes.length < 2 && text === nodeText) continue;
    if (!text) continue;
    const id = groupNodes[0].id;
    trackedGroups.push({ id, nodes: groupNodes });
    groupedSegments.push({ id, text });
    groupNodes.forEach((tracked) => standalone.delete(tracked.id));
  }

  return [
    ...groupedSegments,
    ...fallback.filter((segment) => standalone.has(segment.id))
  ];
}

function shouldSkipElement(element: Element): boolean {
  if (isInsideCodeBlock(element)) return false;
  if (SKIP_TAGS.has(element.tagName)) return true;
  if (element.closest(`.${TRANSLATION_CLASS}`)) return true;
  if (element.closest(SKIP_SELECTOR)) return true;
  return false;
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

function getReadableBlockText(block: Element): string {
  const clone = block.cloneNode(true) as Element;
  clone
    .querySelectorAll(`.${TRANSLATION_CLASS}, script, style, noscript, .anchor, [aria-hidden="true"]`)
    .forEach((node) => node.remove());
  return normalizeText(clone.textContent ?? "");
}

function getRenderMode(element: Element | null): RenderMode {
  if (!element) return "inline";
  if (isReadableHeading(element)) return "block";
  if (isCompactUiElement(element)) return "inline";
  return "block";
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
  if (text.length > 28) return false;
  if (element.closest("p")) return false;
  if (isReadableHeading(element)) return false;
  const heading = element.closest(HEADING_SELECTOR);
  if (heading && isReadableHeading(heading)) return false;
  if (element.closest("article, main .markdown-body, .markdown-body")) return false;
  if (/^[A-Z][A-Za-z]+(?:[-_/][A-Za-z0-9]+)+$/.test(text)) return true;
  if (/^[A-Z][A-Za-z\s]{1,24}$/.test(text) && isCompactUiElement(element)) return true;
  return false;
}

function isNonTranslatableFragment(text: string): boolean {
  if (!text.trim()) return true;
  if (/^[\W_]+$/.test(text)) return true;
  if (/^<?'?[a-zA-Z]>?$/.test(text)) return true;
  if (/^(::|->|=>|for|of)$/i.test(text)) return true;
  if (/^impl(?:<[^>]+>)?$/i.test(text)) return true;
  return false;
}

function isReadableHeading(element: Element): boolean {
  return element.matches(HEADING_SELECTOR) && isInsideReadableRoot(element);
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
  if (!text || /^[\W\d_]+$/.test(text)) return null;
  return { text, prefix };
}

function isElementVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
