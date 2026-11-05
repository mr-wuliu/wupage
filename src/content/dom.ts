import { scanTextRootsProgressive } from "./progressive-scan";
import type { ProgressiveScanOptions, TextSegment } from "./text-segments";
export type { TextSegment } from "./text-segments";
import { getEffectiveBackgroundColor, mapTranslationTextColor, type TranslationColors } from "../shared/translation-colors";
export { mapTranslationTextColor } from "../shared/translation-colors";
import {
  createRenderVisibilitySnapshot,
  isElementVisuallyRendered
} from "./visibility";
import type { RenderVisibilitySnapshot } from "./visibility";
import type { TranslationDisplayMode } from "../shared/types";
import { readImageTextLayout } from "./image-text-layout";
import { normalizeProtectedText } from "../shared/protected-text";
import { isDivProseBlock, READABLE_ROOT_SELECTOR } from "./readable-content";
import {
  clearLineBreakParagraphs, isLineBreakParagraphMutation, LINE_BREAK_SOURCE_SELECTOR, prepareLineBreakParagraphs
} from "./line-break-paragraphs";
import {
  clearLegacyScientificParagraphs, isLegacyScientificEquation, isLegacyScientificProseBlock,
  isScientificCitation, isScientificMathImage, legacyScientificProseBlock, prepareLegacyScientificParagraphs
} from "./legacy-scientific";
import { videoPlatform } from "../video/platforms";
import { clearTranslationTypography, linkTranslationTypography } from "./translation-typography";
import { isNonProseElement, isTranslationOptedOut, NON_PROSE_SELECTOR } from "./content-policy";
import { componentShadowRoot, composedContains, projectedSlot, queryTranslationElements,
  sameTranslationNodePath, translationNodePath } from "./dom-roots";
import { constrainTranslationOwner, translationOwner } from "./translation-boundaries";
import { InlineTranslationPlan } from "./inline-translation";
import { injectContentStyles } from "./styles";
import { isSteamCommunity, isSteamContentCard, steamItemTitle, steamTextBlock } from "./steam-content";
import { containsExcludedElement, isElementExcluded } from "./element-exclusions";

interface TrackedNode {
  id: string;
  node: Text;
  mode: RenderMode;
  sourceValue: string;
  sourceParent: Element;
  sourcePath: Node[];
  sourceOwner?: Element | null;
  replaced?: boolean;
  replacementValue?: string;
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
  sourcePath: Node[];
  translatedValue?: string;
}

interface TrackedImageText {
  id: string;
  image: HTMLImageElement;
  sourceValue: string;
  sourcePath: Node[];
  replaced?: boolean;
  renderedSource?: string;
  waitingForImage?: boolean;
}

interface StableReplacement {
  source: HTMLElement;
  container: HTMLElement;
  sourceHadClass: boolean;
  containerHadClass: boolean;
}

type RenderMode = "block" | "inline" | "code-comment";

interface ProtectedToken {
  marker: string;
  node: Element;
  sourceNode: Element;
  sourceHidden?: { hadClassAttribute: boolean };
  sourceSignature: string;
}

const TRANSLATION_CLASS = "wupage-translation";
const PENDING_CLASS = "wupage-translation-pending";
const TRANSLATED_ATTR = "data-wupage-translated";
const TARGET_ATTR = "data-wupage-target-id";
const TRANSLATION_TARGET_ATTR = "data-wupage-translation-target";
const REPLACED_SOURCE_CLASS = "wupage-replaced-source";
const STABLE_REPLACEMENT_CLASS = "wupage-stable-replacement";
const STABLE_SOURCE_CLASS = "wupage-stable-source";
// Playback labels share compact-control markup with ordinary navigation, but
// adding bilingual text to these fixed-size rows can cover neighboring buttons.
const VIDEO_CONTROL_SELECTOR = [
  "video", "audio", "[data-testid='videoPlayer']", "[data-testid='videoComponent']",
  ".ytp-chrome-bottom", ".ytp-chrome-top", ".vjs-control-bar", ".plyr__controls", ".jw-controlbar"
].join(",");
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
  "[data-wupage-video]",
  "[data-wupage-video-native]",
  "#wupage-video-panel",
  "#wupage-video-overlay",
  "#wupage-selection-tools",
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
  "[class*='hiddenVisually']",
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
  "[task-menu]",
  KNOWN_COMPACT_NAV_SELECTOR
].join(",");
const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";
const COMPACT_CONTROL_SELECTOR = "button,a,[role='button'],[role='tab'],[role='menuitem'],"
  + "[role='menuitemradio'],[role='menuitemcheckbox'],[role='option']";
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
const DISCORD_MESSAGE_SELECTOR = "[id^='message-content-']";
// Posts whose inline spans contain authored paragraph and line breaks.
const POST_TEXT_SELECTOR = `[data-testid='tweetText'], ${DISCORD_MESSAGE_SELECTOR}`;
const YOUTUBE_DESCRIPTION_SELECTOR = [
  "#description-inline-expander .ytAttributedStringHost",
  "ytd-expandable-video-description-body-renderer .ytAttributedStringHost",
  "#description yt-formatted-string.content"
].join(",");
// Comment bodies use inline attributed strings in both YouTube renderers.
// Their height/display describes the source text, not a compact UI label.
const YOUTUBE_COMMENT_SELECTOR = "ytd-comment-view-model #content-text, ytd-comment-renderer #content-text";
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
const IMMUTABLE_INLINE_SELECTOR = "[translate='no' i],.notranslate,math";

let trackedNodes: TrackedNode[] = [];
let trackedByText = new WeakMap<Text, TrackedNode>();
function trackTextNodes(...nodes: TrackedNode[]): void {
  for (const node of nodes) {
    node.sourceOwner = translationOwner(node.sourceParent);
    trackedByText.set(node.node, node);
    trackedNodes.push(node);
  }
}
let trackedGroups: TrackedGroup[] = [];
let trackedAttributes: TrackedAttribute[] = [];
let trackedImageTexts: TrackedImageText[] = [];
let protectedTokensById = new Map<string, ProtectedToken[]>();
let sourceTextById = new Map<string, string>();
const renderedById = new Map<string, HTMLElement | Text>();
const translatedTextById = new Map<string, string>();
const stableReplacementsById = new Map<string, StableReplacement>();
const inlinePlans = new Map<string, InlineTranslationPlan>();
let inlinePlansByBlock = new WeakMap<Element, { id: string; plan: InlineTranslationPlan }>();
const preparedIds = new Set<string>();
const stableReplacementSources = new WeakSet<Element>();
let targetIdCounter = 0;
let segmentIdCounter = 0;
let nodeTrackingEpoch = 0;
/**
 * The elements that held text a full scan rejected only because it was not
 * rendered at that moment. Scrolling can reveal such text without any DOM
 * mutation, so these are the subtrees a viewport change has to revisit instead
 * of walking the whole document again. Candidates stay queued until they scan
 * successfully: a single rescan cannot prove that text which is still covered
 * now will stay covered, and the next scroll may uncover it.
 */
const hiddenScanRoots = new Set<Element>();
/**
 * One scroll can uncover hundreds of subtrees, and rescanning every one of them
 * on the same event made a scroll cost as much as a full scan. A viewport event
 * takes a bounded batch instead; the queue keeps the rest for later events, in
 * insertion order, so no candidate waits forever.
 */
const HIDDEN_SCAN_ROOT_BATCH = 400;
/**
 * Pages that keep thousands of subtrees unrendered would otherwise grow the
 * queue without bound. Past this budget the overflow collapses into the smallest
 * ancestor that covers it, so that text stays reachable from a later scroll
 * instead of being dropped until the next whole-document scan notices it.
 */
const HIDDEN_SCAN_ROOT_BUDGET = 4096;
let hiddenScanOverflowRoot: Element | null = null;
// Re-queued hidden roots must not postpone overflow beyond the current round.
let hiddenScanRootsBeforeOverflow = 0;

function noteHiddenScanCandidate(element: Element | null): void {
  if (!element || hiddenScanRoots.has(element) || hiddenScanOverflowRoot?.contains(element)) return;
  // Disconnected candidates are removed when taking a snapshot. Walking the
  // entire queue for every overflowing text node makes collection quadratic.
  if (hiddenScanRoots.size < HIDDEN_SCAN_ROOT_BUDGET) {
    hiddenScanRoots.add(element);
    return;
  }
  if (!hiddenScanOverflowRoot) hiddenScanRootsBeforeOverflow = hiddenScanRoots.size;
  hiddenScanOverflowRoot = commonHiddenScanAncestor(hiddenScanOverflowRoot, element);
}

function commonHiddenScanAncestor(current: Element | null, element: Element): Element {
  if (!current || !current.isConnected) return element;
  if (current.contains(element)) return current;
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.contains(current)) return ancestor;
  }
  return element;
}

function clearHiddenScanCandidates(): void {
  hiddenScanRoots.clear();
  hiddenScanOverflowRoot = null;
  hiddenScanRootsBeforeOverflow = 0;
}

interface DeferredBlockText {
  block: Element;
  /**
   * Text nodes this block kept when it was scanned. Reading the block later must
   * not depend on where the viewport sits at that moment, so the accepted set is
   * frozen at scan time instead of re-testing visibility.
   */
  accepted: Set<Text>;
  text?: string;
  tokens?: ProtectedToken[];
}

/**
 * Reading a block clones it and strips hidden text, which is the most expensive
 * step of a scan. A long page accepts thousands of blocks but only translates
 * the ones near the viewport, so multi-node blocks defer that work until the
 * segment actually reaches a batch.
 */
const deferredBlockTexts = new Map<string, DeferredBlockText>();

function resolveDeferredBlockText(id: string): string {
  const pending = deferredBlockTexts.get(id);
  if (!pending) return sourceTextById.get(id) ?? "";
  if (pending.text === undefined) {
    const { text, tokens } = getReadableBlockText(
      pending.block,
      createRenderVisibilitySnapshot(),
      pending.accepted.size,
      pending.accepted
    );
    pending.text = text;
    pending.tokens = tokens;
    if (tokens.length) protectedTokensById.set(id, tokens);
    sourceTextById.set(id, text);
  }
  return pending.text ?? "";
}

/** Source text of a segment, reading a deferred block on first use. */
function readSourceText(id: string): string {
  const inline = inlinePlans.get(id);
  if (inline) return inline.source;
  if (deferredBlockTexts.has(id)) return resolveDeferredBlockText(id);
  return sourceTextById.get(id) ?? "";
}

const PARAGRAPH_SELECTOR = [
  LINE_BREAK_SOURCE_SELECTOR,
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
  POST_TEXT_SELECTOR,
  YOUTUBE_DESCRIPTION_SELECTOR,
  YOUTUBE_COMMENT_SELECTOR
].join(",");

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
  return collectTextSegmentsFromRoot(element, translateCodeComments);
}

export async function collectTextSegmentsProgressive(
  translateCodeComments = true,
  options: ProgressiveScanOptions = {}
): Promise<TextSegment[]> {
  if (options.signal?.aborted) return [];
  clearNodeTracking();
  if (!document.body) return [];
  prepareLegacyScientificParagraphs(document.body);
  return scanTrackedTextRoots([document.body], translateCodeComments, options, true);
}

/** Incremental scans retain existing translations and use the same time budget. */
export function collectAdditionalTextSegmentsProgressive(
  roots: Element[], translateCodeComments = true, options: ProgressiveScanOptions = {}
): Promise<TextSegment[]> {
  return scanTrackedTextRoots(roots, translateCodeComments, options, options.observeChanges ?? true);
}

function scanTrackedTextRoots(
  roots: Element[], translateCodeComments: boolean, options: ProgressiveScanOptions, observeChanges: boolean
): Promise<TextSegment[]> {
  const epoch = nodeTrackingEpoch;
  return scanTextRootsProgressive(roots, { ...options, observeChanges }, {
    isCurrent: () => epoch === nodeTrackingEpoch,
    isParagraph: element => element.matches(PARAGRAPH_SELECTOR + ",[data-wupage-scientific-source]"),
    collect: (root, directTextOnly) => collectTextSegmentsFromRoot(root, translateCodeComments, directTextOnly),
    clearHiddenCandidates: clearHiddenScanCandidates,
    invalidate: invalidateStaleSegments
  });
}

/**
 * Hands the next batch of pending candidates to a viewport-driven rescan. Taken
 * candidates leave the queue and the rescan re-adds the ones that are still
 * hidden, so repeated scrolls keep retrying exactly those subtrees instead of
 * the whole document while the queue still advances towards the rest.
 */
export function takeHiddenScanRoots(limit = HIDDEN_SCAN_ROOT_BATCH): Element[] {
  if (limit <= 0) return [];
  const roots: Element[] = [];
  for (const element of hiddenScanRoots) {
    if (roots.length >= limit || (hiddenScanOverflowRoot && hiddenScanRootsBeforeOverflow === 0)) break;
    hiddenScanRoots.delete(element);
    hiddenScanRootsBeforeOverflow = Math.max(0, hiddenScanRootsBeforeOverflow - 1);
    if (element.isConnected) roots.push(element);
  }
  // A hidden root gets re-queued after its retry, so the queue may never empty.
  // Give overflow a turn after the roots that were ahead of it have had theirs,
  // keeping it within the batch limit even when the round ends on a full batch.
  if (hiddenScanOverflowRoot && (!hiddenScanRootsBeforeOverflow || !hiddenScanRoots.size) && roots.length < limit) {
    const overflow = hiddenScanOverflowRoot;
    hiddenScanOverflowRoot = null;
    hiddenScanRootsBeforeOverflow = 0;
    if (overflow.isConnected) roots.push(overflow);
  }
  return roots;
}

// Applications may reuse a text node or discard our rendered output. Release
// its tracking so the next scan can translate the current source again.
export function invalidateStaleSegments(changedRoots: Element[] = []): string[] {
  const stale = new Set<string>();
  for (const [id, plan] of inlinePlans) if (!plan.isCurrent()) stale.add(id);
  for (const [id, tokens] of protectedTokensById) {
    if (tokens.some(token => !token.sourceNode.isConnected
      || protectedSourceSignature(token.sourceNode, Boolean(token.sourceHidden)) !== token.sourceSignature)) stale.add(id);
  }
  const recovered = recoverRewrittenReplacementSegments();
  // The host may move an intact source or add another control beside it. Its
  // text nodes can remain unchanged even though our isolated layout is unsafe.
  for (const id of stableReplacementsById.keys()) {
    if (!recovered.has(id)) stale.add(id);
  }
  const changed = (tracked: TrackedNode): boolean => !tracked.node.isConnected
    || tracked.node.parentElement !== tracked.sourceParent
    || !sameTranslationNodePath(tracked.node, tracked.sourcePath)
    || translationOwner(tracked.sourceParent) !== (tracked.sourceOwner ?? null)
    || isNonProseElement(tracked.sourceParent) || isTranslationOptedOut(tracked.sourceParent)
    || tracked.node.data !== (tracked.replaced ? tracked.replacementValue ?? "" : tracked.sourceValue);
  for (const tracked of trackedNodes) {
    if (recovered.has(tracked.id)) continue;
    if (changed(tracked) || changedRoots.includes(tracked.node.parentElement!)) stale.add(tracked.id);
  }
  for (const [id, output] of renderedById) {
    if (!output.isConnected) stale.add(id);
  }
  for (const group of trackedGroups) {
    if (recovered.has(group.id)) continue;
    if (!group.block.isConnected || group.nodes.some((node) => !group.block.contains(node.node))
      || stale.has(group.id) || group.nodes.some((node) => stale.has(node.id))
      || changedRoots.some((root) => group.block === root || group.block.contains(root))) {
      stale.add(group.id);
      group.nodes.forEach((node) => stale.add(node.id));
    }
  }
  for (const tracked of trackedAttributes) {
    if (!tracked.element.isConnected
      || !sameTranslationNodePath(tracked.element, tracked.sourcePath)
      || isTranslationOptedOut(tracked.element)
      || tracked.element.getAttribute(tracked.name) !== (tracked.translatedValue ?? tracked.sourceValue)) {
      stale.add(tracked.id);
      if (tracked.translatedValue !== undefined && tracked.element.getAttribute(tracked.name) === tracked.translatedValue) {
        tracked.element.setAttribute(tracked.name, tracked.sourceValue);
      }
      tracked.element.removeAttribute(TRANSLATED_ATTR);
    }
  }
  for (const tracked of trackedImageTexts) {
    const anchor = tracked.image.closest("picture") ?? tracked.image;
    const output = renderedById.get(tracked.id);
    if (!tracked.image.isConnected || tracked.image.getAttribute("alt") !== tracked.sourceValue
      || !sameTranslationNodePath(tracked.image, tracked.sourcePath)
      || isTranslationOptedOut(tracked.image) || isNonProseElement(tracked.image)
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
  for (const id of stale) inlinePlans.get(id)?.restore();
  for (const tracked of trackedNodes) {
    if (!stale.has(tracked.id)) continue;
    // Never overwrite a new value supplied by the host application.
    if (tracked.replaced && tracked.node.data === (tracked.replacementValue ?? "")) tracked.node.data = tracked.sourceValue;
    tracked.replaced = false;
    tracked.replacementValue = undefined;
    if (trackedByText.get(tracked.node) === tracked) trackedByText.delete(tracked.node);
  }
  for (const group of trackedGroups) {
    if (stale.has(group.id)) restoreGroupedSource(group);
  }
  for (const id of stale) {
    inlinePlans.delete(id);
    preparedIds.delete(id);
    restoreStableReplacement(id);
    removeRenderedTranslation(id);
    removePendingForId(id);
    for (const token of protectedTokensById.get(id) ?? []) {
      restoreProtectedSource(token);
    }
    protectedTokensById.delete(id);
    sourceTextById.delete(id);
    deferredBlockTexts.delete(id);
    translatedTextById.delete(id);
  }
  trackedNodes = trackedNodes.filter((node) => !stale.has(node.id));
  trackedGroups = trackedGroups.filter((group) => !stale.has(group.id));
  trackedAttributes = trackedAttributes.filter((attribute) => !stale.has(attribute.id));
  trackedImageTexts = trackedImageTexts.filter((tracked) => !stale.has(tracked.id));
  return [...stale];
}

/** Only isolate one complete, noninteractive text element in a simple wrapper. */
function stableReplacementSource(nodes: TrackedNode[]): HTMLElement | undefined {
  const parents = new Set(nodes.filter((node) => node.sourceValue.trim()).map((node) => node.sourceParent));
  if (parents.size !== 1) return undefined;
  const source = parents.values().next().value;
  if (!(source instanceof HTMLElement) || !source.isConnected || !source.matches("span,p,div")) return undefined;
  if (source.matches("[role],[tabindex],[contenteditable],[slot]")
    || [...source.attributes].some((attribute) => attribute.name.startsWith("on"))) return undefined;
  if ([...source.childNodes].some((node) => node instanceof Element && !node.matches(`.${TRANSLATION_CLASS}`))) {
    return undefined;
  }
  const container = source.parentElement;
  if (!(container instanceof HTMLElement) || !container.matches("p,div")
    || container.matches("[contenteditable],[slot]")) return undefined;
  if (container.style.display && container.style.display !== "block") return undefined;
  const alreadyIsolated = [...stableReplacementsById.values()].some((entry) => entry.source === source && entry.container === container);
  if (!alreadyIsolated && window.getComputedStyle(container).display !== "block") return undefined;
  if ([...container.childNodes].some((node) => node !== source
    && node.nodeType !== Node.COMMENT_NODE
    && !(node instanceof Text && !node.data.trim())
    && !(node instanceof Element && node.matches(`.${TRANSLATION_CLASS}`)))) return undefined;
  // Moving output outside a hidden or positioned source would bypass its
  // layout boundary. Only our own reversible visibility change is expected.
  const style = window.getComputedStyle(source);
  if (style.display === "none" || Number.parseFloat(style.opacity) === 0
    || (style.visibility === "hidden" && !source.classList.contains(STABLE_SOURCE_CLASS))
    || style.position === "absolute" || style.position === "fixed"
    || (style.clip && style.clip !== "auto")
    || (style.clipPath && style.clipPath !== "none")) return undefined;
  return source;
}

function directSourceTextNodes(source: Element): Text[] {
  return [...source.childNodes].filter((node): node is Text => node instanceof Text);
}

// A resize-driven host can restore or rebuild its text after replacement clears
// it. Preserve the logical result and stop editing the host's measured contents.
function recoverRewrittenReplacementSegments(): Set<string> {
  const recovered = new Set<string>();
  const groups = new Map(trackedGroups.map((group) => [group.id, group]));
  const groupedNodes = new Set(trackedGroups.flatMap((group) => group.nodes));
  const candidates = new Map<string, TrackedNode[]>();
  for (const group of trackedGroups) candidates.set(group.id, group.nodes);
  for (const node of trackedNodes) {
    if (!groupedNodes.has(node)) candidates.set(node.id, [node]);
  }
  for (const [id, oldNodes] of candidates) {
    if (oldNodes.some(node => isElementExcluded(node.sourceParent))) continue;
    const output = renderedById.get(id);
    if (output instanceof Text) continue;
    const translation = translatedTextById.get(id);
    if (!translation || output?.getAttribute("data-wupage-display-mode") !== "replace"
      || (!stableReplacementsById.has(id) && !oldNodes.some((node) => node.replaced))) continue;
    const group = groups.get(id);
    const stable = stableReplacementsById.get(id);
    if (stable && (!stable.container.isConnected || stable.source.parentElement !== stable.container
      || (output.isConnected && output.parentElement !== stable.container))) continue;
    if (protectedTokensById.has(id) || group?.authoredLines || group?.insertionBefore || group?.insertionAfter
      || oldNodes.some((node) => node.mode === "code-comment")) continue;
    const source = stableReplacementSource(oldNodes);
    if (!source) continue;
    // The page scheduler retains the original group element as its viewport
    // anchor. A move out of that block is new content, not a same-place rewrite.
    if (group && (!group.block.isConnected || !group.block.contains(source))) continue;
    const nodes = directSourceTextNodes(source);
    const text = normalizeText(nodes.map((node) => node.data).join(""));
    if (!text || text !== normalizeText(sourceTextById.get(id) ?? "")) continue;
    stableReplacementSources.add(source);
    let rebound = oldNodes;
    if (nodes.length !== oldNodes.length || nodes.some((node, index) => oldNodes[index].node !== node
      || oldNodes[index].sourceValue !== node.data || oldNodes[index].replaced)) {
      rebound = nodes.map((node): TrackedNode => ({
        id, node, mode: oldNodes[0].mode, sourceValue: node.data, sourceParent: source,
        sourcePath: translationNodePath(node)
      }));
      const old = new Set(oldNodes);
      trackedNodes = trackedNodes.filter((node) => !old.has(node));
      trackTextNodes(...rebound);
      if (group) group.nodes = rebound;
      else if (rebound.length > 1) {
        trackedGroups.push({ id, nodes: rebound, block: source, mode: rebound[0].mode });
      }
    }
    recovered.add(id);
    if (output?.isConnected) {
      renderStableReplacement(id, rebound, output);
    } else {
      renderTranslations([{ id, text: translation }], "replace");
    }
  }
  return recovered;
}

function renderStableReplacement(id: string, nodes: TrackedNode[], output: HTMLElement): boolean {
  const source = stableReplacementSource(nodes);
  if (!source || !stableReplacementSources.has(source)) return false;
  const container = source.parentElement!;
  const existing = stableReplacementsById.get(id);
  if (existing && (existing.source !== source || existing.container !== container)) restoreStableReplacement(id);
  if (!stableReplacementsById.has(id)) {
    stableReplacementsById.set(id, {
      source, container, sourceHadClass: source.hasAttribute("class"), containerHadClass: container.hasAttribute("class")
    });
  }
  if (!source.classList.contains(STABLE_SOURCE_CLASS)) source.classList.add(STABLE_SOURCE_CLASS);
  if (!container.classList.contains(STABLE_REPLACEMENT_CLASS)) container.classList.add(STABLE_REPLACEMENT_CLASS);
  if (output.getAttribute("data-wupage-container") !== "stable-replacement") {
    output.setAttribute("data-wupage-container", "stable-replacement");
  }
  const targetId = ensureTranslationTarget(source);
  if (output.getAttribute(TRANSLATION_TARGET_ATTR) !== targetId) output.setAttribute(TRANSLATION_TARGET_ATTR, targetId);
  if (source.getAttribute(TRANSLATED_ATTR) !== "true") source.setAttribute(TRANSLATED_ATTR, "true");
  // A sibling cannot inherit the source's typography. Refresh it on recovery
  // (including resize), without generating mutations when nothing changed.
  const style = window.getComputedStyle(source);
  for (const name of ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant",
    "line-height", "letter-spacing", "word-spacing", "text-transform", "color"]) {
    const value = style.getPropertyValue(name);
    if (value && (output.style.getPropertyValue(name) !== value || output.style.getPropertyPriority(name) !== "important")) {
      output.style.setProperty(name, value, "important");
    }
  }
  if (output.parentElement !== container) source.after(output);
  return true;
}

function restoreStableReplacement(id: string): void {
  const replacement = stableReplacementsById.get(id);
  if (!replacement) return;
  for (const [element, name, hadClass] of [
    [replacement.source, STABLE_SOURCE_CLASS, replacement.sourceHadClass],
    [replacement.container, STABLE_REPLACEMENT_CLASS, replacement.containerHadClass]
  ] as const) {
    element.classList.remove(name);
    if (!hadClass && element.getAttribute("class") === "") element.removeAttribute("class");
  }
  stableReplacementsById.delete(id);
}

export function findTranslatableParagraph(start: Element | null): Element | null {
  if (start?.closest(CODE_SELECTOR) && !isInlineCodeInReadableText(start)) {
    return findCodeCommentBlock(start);
  }

  if (start && !shouldSkipElement(start)) {
    const steamBlock = steamTextBlock(start);
    if (steamBlock && !shouldSkipElement(steamBlock)) return steamBlock;
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
  const fallback = findNearestTextBlock(start);
  // Inline fallback targets must share the renderer's enclosing prose boundary;
  // its translation may be a sibling outside the clicked span or emphasis.
  const block = fallback && computeGroupingBlock(fallback);
  return block && !shouldSkipElement(block) ? block : fallback;
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
    queryTranslationElements(`.${TRANSLATION_CLASS}`)[0] ||
      queryTranslationElements(`[${TRANSLATED_ATTR}]`)[0] ||
      queryTranslationElements(`[${TRANSLATION_TARGET_ATTR}]`)[0]
  );
}

export function ensureTranslationTarget(element: Element): string {
  const existing = element.getAttribute(TARGET_ATTR);
  if (existing) return existing;
  const id = `wupage-target-${Date.now()}-${targetIdCounter++}`;
  element.setAttribute(TARGET_ATTR, id);
  return id;
}

const NON_BLANK_TEXT = /\S/;

function collectTextSegmentsFromRoot(
  root: Element,
  translateCodeComments: boolean,
  directTextOnly = false
): TextSegment[] {
  // A whole-document scan starts from a clean slate; the progressive scanner
  // already cleared the candidates and its per-chunk results must survive the
  // body sweep.
  if (!directTextOnly && (root === document.body || root === document.documentElement)) {
    clearHiddenScanCandidates();
  }
  // Grouping is pure for the duration of one scan (collection never mutates the
  // page), and the same ancestor answers for every inline child, so one lookup
  // per element removes the repeated closest()/getComputedStyle chains.
  groupingBlockCache = new WeakMap();
  // Also prepare a large container's direct text before the progressive walker
  // descends into its children, so rich paragraphs cannot straddle scan chunks.
  prepareLineBreakParagraphs(root, directTextOnly);
  if (!directTextOnly) {
    prepareLegacyScientificParagraphs(root);
    splitAuthoredLineBreakTextNodes(root, POST_TEXT_SELECTOR);
    splitAuthoredLineBreakTextNodes(root, YOUTUBE_DESCRIPTION_SELECTOR, true);
  }
  const alreadyTracked = new Set(trackedNodes.map((tracked) => tracked.node));
  const visibility = createRenderVisibilitySnapshot();
  const acceptsText = (text: Text): boolean => {
    if (!NON_BLANK_TEXT.test(text.data) || alreadyTracked.has(text)) return false;
    const parent = text.parentElement;
    if (!parent || shouldSkipElement(parent, true, visibility) || isStructuredListMetadata(parent)) return false;
    if (!visibility.isTextNodeVisuallyRendered(text)) {
      noteHiddenScanCandidate(parent);
      return false;
    }
    return true;
  };
  const candidates: Text[] = [];
  if (directTextOnly) {
    for (let node = root.firstChild; node; node = node.nextSibling) {
      if (node instanceof Text && acceptsText(node)) candidates.push(node);
    }
  } else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node => acceptsText(node as Text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    while (walker.nextNode()) candidates.push(walker.currentNode as Text);
  }

  const segments: TextSegment[] = [];
  const textNodes: TrackedNode[] = [];
  for (const node of candidates) {
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
      sourcePath: translationNodePath(node),
      commentPrefix: codeComment?.prefix
    };
    trackTextNodes(tracked);
    textNodes.push(tracked);
    segments.push({ id, text: sourceText, element: node.parentElement! });
  }

  const groupedSegments = groupTextSegments(textNodes, segments, visibility);
  const attributeSegments = directTextOnly ? [] : collectAttributeSegments(root, visibility);
  const imageTextSegments = directTextOnly ? [] : collectImageTextSegments(root, visibility);
  const collectedSegments = [...groupedSegments, ...attributeSegments, ...imageTextSegments];
  collectedSegments.forEach((segment) => {
    Object.defineProperty(segment, "requestText", { get: () => {
      if (!preparedIds.has(segment.id)) {
        // Resolve protected tokens before deciding whether the entire inline
        // tree can be represented without touching independent content.
        readSourceText(segment.id);
        preparedIds.add(segment.id);
        const group = trackedGroups.find(entry => entry.id === segment.id);
        if (group && !group.authoredLines
          && !group.insertionBefore && !group.insertionAfter) {
          const plan = InlineTranslationPlan.create(group.block, new Set(group.nodes.map(entry => entry.node)), protectedTokensById.get(segment.id));
          if (plan) { inlinePlans.set(segment.id, plan); inlinePlansByBlock.set(group.block, { id: segment.id, plan }); }
        }
      }
      return readSourceText(segment.id);
    } });
    // Deferred block text is recorded when the segment is finally requested.
    if (deferredBlockTexts.has(segment.id)) return;
    sourceTextById.set(segment.id, segment.text);
  });
  return collectedSegments;
}

export function renderTranslations(
  translations: Array<{ id: string; text: string }>,
  displayMode: TranslationDisplayMode = "bilingual"
): string[] {
  injectContentStyles();
  const counts = new Map<string, number>();
  translations.forEach(({ id }) => counts.set(id, (counts.get(id) ?? 0) + 1));
  const groupsById = new Map(trackedGroups.map(group => [group.id, group]));
  const nodesById = new Map<string, TrackedNode[]>();
  for (const node of trackedNodes) {
    if (!counts.has(node.id) || groupsById.has(node.id)) continue;
    const nodes = nodesById.get(node.id) ?? [];
    nodes.push(node); nodesById.set(node.id, nodes);
  }
  translations = translations.flatMap(({ id, text }) => {
    if (counts.get(id) !== 1 || typeof text !== "string" || !text.trim()
      || (!sourceTextById.has(id) && !deferredBlockTexts.has(id)) || !isTranslationBindingCurrent(id, groupsById, nodesById)) {
      removePendingForId(id);
      return [];
    }
    // A caller can render a segment that never reached a batch, so the deferred
    // block text is resolved first; it is also what registers the tokens.
    const sourceText = readSourceText(id);
    const normalized = normalizeProtectedText(sourceText, text);
    if (normalized !== undefined && (!inlinePlans.has(id) || inlinePlans.get(id)!.accepts(normalized))) {
      return [{ id, text: normalized }];
    }
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
    removeRenderedTranslation(group.id);
    const targetId = ensureTranslationTarget(block);
    const plan = inlinePlans.get(group.id);
    if (displayMode === "replace" && plan) {
      const anchor = plan.write(translation);
      if (anchor) {
        group.nodes.forEach(entry => { entry.replaced = true; entry.replacementValue = entry.node.data; });
        renderedById.set(group.id, anchor);
        block.setAttribute(TRANSLATED_ATTR, "true");
      }
      continue;
    }
    if (displayMode === "replace" && renderBoundTextReplacement(group.id, group.nodes, block, translation)) {
      block.setAttribute(TRANSLATED_ATTR, "true");
      continue;
    }
    const element = document.createElement("span");
    element.className = TRANSLATION_CLASS;
    element.dataset.wupageMode = group.mode;
    element.dataset.wupageDisplayMode = displayMode;
    if (group.preserveWhitespace) element.dataset.wupagePreserveWhitespace = "true";
    applyTranslationTextAppearance(element, block, displayMode);
    if (plan) plan.appendCopy(element, translation);
    else renderProtectedText(element, group.id, translation);
    element.setAttribute("lang", "translated");
    if (displayMode !== "replace") element.setAttribute("aria-hidden", "true");
    element.setAttribute(TRANSLATION_TARGET_ATTR, targetId);
    block.setAttribute(TRANSLATED_ATTR, "true");
    if (displayMode === "replace" && renderStableReplacement(group.id, group.nodes, element)) {
      renderedById.set(group.id, element);
      if (!isOutputVisible(element)) rollbackInvisibleTranslation(group.id, group.nodes, element);
      continue;
    }
    insertGroupedTranslation(group, element, displayMode);
    linkTranslationTypography(element, block);
    renderedById.set(group.id, element);
    if (!isOutputVisible(element)) { rollbackInvisibleTranslation(group.id, group.nodes, element); continue; }
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
    removeRenderedTranslation(tracked.id);
    if (displayMode === "replace" && renderBoundTextReplacement(tracked.id, [tracked], parent, translation)) {
      parent.setAttribute(TRANSLATED_ATTR, "true");
      continue;
    }
    const element = document.createElement("span");
    element.className = TRANSLATION_CLASS;
    element.dataset.wupageMode = tracked.mode;
    element.dataset.wupageDisplayMode = displayMode;
    applyTranslationTextAppearance(element, parent, displayMode);
    element.textContent = tracked.mode === "code-comment" ? `${tracked.commentPrefix ?? "//"} ${translation}` : translation;
    element.setAttribute("lang", "translated");
    if (displayMode !== "replace") element.setAttribute("aria-hidden", "true");
    parent.setAttribute(TRANSLATED_ATTR, "true");
    if (displayMode === "replace" && renderStableReplacement(tracked.id, [tracked], element)) {
      renderedById.set(tracked.id, element);
      if (!isOutputVisible(element)) rollbackInvisibleTranslation(tracked.id, [tracked], element);
      continue;
    }
    if (tracked.mode === "block" && parent.matches(HEADING_SELECTOR)) insertBlockTranslation(parent, element);
    else tracked.node.after(element);
    renderedById.set(tracked.id, element);
    if (!isOutputVisible(element)) { rollbackInvisibleTranslation(tracked.id, [tracked], element); continue; }
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
    applyTranslationTextAppearance(element, tracked.image.parentElement ?? tracked.image, displayMode);
    if (!renderInterleavedImageText(tracked, element, translation, displayMode)) {
      element.textContent = translation;
    }
    insertImageTextTranslation(tracked, element);
    renderedById.set(tracked.id, element);
  }
  return translations.filter(({ id, text }) => renderedById.has(id) || isSameTranslation(id, text)
    || trackedAttributes.some(attribute => attribute.id === id && attribute.translatedValue !== undefined)).map(({ id }) => id);
}

// A site's !important span rule must never leave the replacement blank. Keep
// the source when the generated element cannot be shown; other segments proceed.
function isOutputVisible(element: HTMLElement): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !style || (style.display !== "none" && style.visibility !== "hidden"
    && style.visibility !== "collapse" && style.opacity !== "0");
}

function rollbackInvisibleTranslation(id: string, nodes: TrackedNode[], output: HTMLElement): void {
  restoreStableReplacement(id);
  removeRenderedTranslation(id);
  output.remove();
  for (const tracked of nodes) {
    if (tracked.replaced && tracked.node.data === (tracked.replacementValue ?? "")) tracked.node.data = tracked.sourceValue;
    tracked.replaced = false; tracked.replacementValue = undefined;
    tracked.sourceParent.removeAttribute(TRANSLATED_ATTR);
    tracked.sourceParent.removeAttribute(TARGET_ATTR);
  }
}

// Reuse the raw results, including protected markers and image paragraphs.
// Restoring source nodes first makes replacement mode reversible and lets the
// new display inherit the source's color rather than the previous accent.
export function setTranslationDisplayMode(displayMode: TranslationDisplayMode): void {
  invalidateStaleSegments();
  for (const id of renderedById.keys()) {
    if (!translatedTextById.has(id)) continue;
    removeRenderedTranslation(id);
  }
  restoreReplacedSourcesIn(document.documentElement);
  renderTranslations([...translatedTextById].map(([id, text]) => ({ id, text })), displayMode);
}

export function renderTranslationPlaceholders(segments: TextSegment[]): void {
  injectContentStyles();
  const pendingIds = new Set(segments.map((segment) => segment.id));

  for (const group of trackedGroups) {
    if (!pendingIds.has(group.id)) continue;
    const block = group.block;
    if (block.closest(`.${TRANSLATION_CLASS}`)) continue;
    const targetId = ensureTranslationTarget(block);
    const pending = createPendingElement(group.id, group.mode);
    if (group.preserveWhitespace) pending.dataset.wupagePreserveWhitespace = "true";
    applyTranslationTextAppearance(pending, block, "bilingual");
    pending.setAttribute(TRANSLATION_TARGET_ATTR, targetId);
    removePendingForId(group.id);
    insertGroupedTranslation(group, pending);
    linkTranslationTypography(pending, block);
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

export function clearTranslations(): void {
  hideTranslations();
  clearNodeTracking();
}

export function hideTranslations(): void {
  clearTranslationTypography();
  restoreTrackedAttributesIn(document.documentElement);
  restoreReplacedSourcesIn(document.documentElement);
  queryTranslationElements(`.${TRANSLATION_CLASS}`).forEach((node) => node.remove());
  queryTranslationElements(`[${TRANSLATED_ATTR}]`).forEach((node) => {
    node.removeAttribute(TRANSLATED_ATTR);
  });
  queryTranslationElements(`[${TARGET_ATTR}]`).forEach((node) => {
    node.removeAttribute(TARGET_ATTR);
  });
  // Virtual lists temporarily detach rows and later reuse the same nodes. A
  // global stop must restore those rows too, before tracking can be discarded.
  for (const output of renderedById.values()) if (output instanceof Element) output.remove();
  const detached = new Set<Node>([
    ...trackedNodes.map(tracked => tracked.sourceParent.getRootNode()),
    ...trackedGroups.map(group => group.block.getRootNode()),
    ...trackedAttributes.map(tracked => tracked.element.getRootNode()),
    ...trackedImageTexts.map(tracked => tracked.image.getRootNode())
  ]);
  for (const root of detached) {
    if (root === document || root.isConnected || !(root instanceof Element || root instanceof DocumentFragment)) continue;
    root.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach(node => node.remove());
    const elements = [...root.querySelectorAll(`[${TRANSLATED_ATTR}],[${TARGET_ATTR}]`)];
    if (root instanceof Element) elements.push(root);
    for (const element of elements) { element.removeAttribute(TRANSLATED_ATTR); element.removeAttribute(TARGET_ATTR); }
  }
  renderedById.clear();
  for (const tracked of trackedAttributes) tracked.translatedValue = undefined;
}

export function restoreTranslations(displayMode: TranslationDisplayMode): void {
  renderTranslations([...translatedTextById].map(([id, text]) => ({ id, text })), displayMode);
}

function clearNodeTracking(): void {
  for (const plan of inlinePlans.values()) plan.restore();
  inlinePlans.clear();
  inlinePlansByBlock = new WeakMap();
  preparedIds.clear();
  nodeTrackingEpoch += 1;
  for (const id of stableReplacementsById.keys()) restoreStableReplacement(id);
  clearLegacyScientificParagraphs();
  clearLineBreakParagraphs();
  trackedNodes = [];
  trackedByText = new WeakMap();
  trackedGroups = [];
  trackedAttributes = [];
  trackedImageTexts = [];
  deferredBlockTexts.clear();
  clearHiddenScanCandidates();
  protectedTokensById = new Map();
  sourceTextById = new Map();
  renderedById.clear();
  translatedTextById.clear();
}

function pruneTranslationResults(): void {
  const ids = new Set([...trackedNodes, ...trackedGroups, ...trackedAttributes, ...trackedImageTexts].map((entry) => entry.id));
  for (const map of [translatedTextById, sourceTextById, protectedTokensById, deferredBlockTexts, inlinePlans]) {
    for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
  }
  for (const id of preparedIds) if (!ids.has(id)) preparedIds.delete(id);
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
    if (isLegacyScientificEquation(candidate)
      || (candidate.closest(".MATH") && isScientificMathImage(candidate.closest(".MATH")!))) continue;
    if (shouldSkipElement(candidate, true, visibility)) continue;
    if (!visibility.isElementVisuallyRendered(candidate)) {
      // A lazy image only gains its first rendered area after it loads or
      // scrolls into view, so the viewport change is the event worth rescanning.
      noteHiddenScanCandidate(candidate);
      continue;
    }
    const sourceValue = candidate.getAttribute("alt") ?? "";
    // Promotional sites often render entire paragraphs as images and supply
    // their text in alt. Ignore short labels such as logos and image buttons.
    if (normalizeText(sourceValue).length < 80 || !/\p{L}/u.test(sourceValue)) continue;
    const text = sourceValue.split(/\r?\n/).map(normalizeText).filter(Boolean).join("\n\n");
    const id = `seg-${Date.now()}-${segmentIdCounter++}`;
    trackedImageTexts.push({ id, image: candidate, sourceValue, sourcePath: translationNodePath(candidate) });
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
      translationColorSources.set(result, { color: layout.foreground, background });
      setTranslationTextColor(result, mapTranslationTextColor(layout.foreground, background, translationColors) ?? layout.foreground);
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
    if (isTranslationOptedOut(candidate)) continue;
    if (candidate.closest(`.${TRANSLATION_CLASS}, #wupage-floating-menu, #wupage-debug-panel`)) continue;
    if (!visibility.isElementVisuallyRendered(candidate)) {
      noteHiddenScanCandidate(candidate);
      continue;
    }
    const sourceValue = candidate.getAttribute("placeholder") ?? "";
    const sourceText = normalizeText(sourceValue);
    if (sourceText.length < 2 || isNonTranslatableFragment(sourceText)) continue;
    const id = `seg-${Date.now()}-${segmentIdCounter++}`;
    trackedAttributes.push({ id, element: candidate, name: "placeholder", sourceValue, sourcePath: translationNodePath(candidate) });
    segments.push({ id, text: sourceText, element: candidate });
  }

  return segments;
}

function restoreTrackedAttributesIn(root: Element): void {
  for (const tracked of trackedAttributes) {
    if (root !== document.documentElement && tracked.element !== root && !composedContains(root, tracked.element)) continue;
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

// Prepared controls and custom navigation labels reuse their original Text
// nodes, preserving projection and framework references without a new UI child.
function renderBoundTextReplacement(id: string, nodes: TrackedNode[], source: Element, text: string): boolean {
  const item = source.closest("[role='listitem']");
  const prepared = preparedIds.has(id) && (translationOwner(source) || isCompactControlText(source))
    && nodes.every(node => node.sourceParent === source);
  if (protectedTokensById.has(id) || nodes.some(node => node.mode !== "inline")
    || (!prepared && (!item?.localName.includes("-") || !isCompactNavigationText(source)))) return false;
  const first = nodes.find(node => node.sourceValue.trim());
  if (!first) return false;
  removeRenderedTranslation(id);
  for (const tracked of nodes) {
    const value = tracked === first ? text : "";
    tracked.replacementValue = value;
    tracked.replaced = true;
    if (tracked.node.data !== value) tracked.node.data = value;
  }
  renderedById.set(id, first.node);
  return true;
}

function isTranslationBindingCurrent(id: string, groups: Map<string, TrackedGroup>, standalone: Map<string, TrackedNode[]>): boolean {
  if (inlinePlans.has(id) && !inlinePlans.get(id)!.isCurrent()) return false;
  const group = groups.get(id);
  const nodes = group?.nodes ?? standalone.get(id) ?? [];
  if (nodes.some(entry => !entry.node.isConnected || entry.node.parentElement !== entry.sourceParent
    || !sameTranslationNodePath(entry.node, entry.sourcePath)
    || translationOwner(entry.sourceParent) !== (entry.sourceOwner ?? null)
    || entry.node.data !== (entry.replaced ? entry.replacementValue ?? "" : entry.sourceValue)
    || isNonProseElement(entry.sourceParent) || isTranslationOptedOut(entry.sourceParent))) return false;
  if (group && (!group.block.isConnected || nodes.some(entry => !group.block.contains(entry.node)))) return false;
  if (group?.insertionBefore && !group.block.contains(group.insertionBefore)) return false;
  if (group?.insertionAfter && !group.block.contains(group.insertionAfter)) return false;
  if ((protectedTokensById.get(id) ?? []).some(token => !token.sourceNode.isConnected
    || protectedSourceSignature(token.sourceNode, Boolean(token.sourceHidden)) !== token.sourceSignature)) return false;
  const attribute = trackedAttributes.find(entry => entry.id === id);
  if (attribute && (!attribute.element.isConnected || isTranslationOptedOut(attribute.element)
    || !sameTranslationNodePath(attribute.element, attribute.sourcePath)
    || attribute.element.getAttribute(attribute.name) !== (attribute.translatedValue ?? attribute.sourceValue))) return false;
  const image = trackedImageTexts.find(entry => entry.id === id);
  if (!nodes.length && !attribute && !image) return false;
  return !image || (image.image.isConnected && !isTranslationOptedOut(image.image)
    && !isNonProseElement(image.image) && sameTranslationNodePath(image.image, image.sourcePath)
    && image.image.getAttribute("alt") === image.sourceValue);
}

/** Recognize our completed writes by their current bindings, not by a timer. */
export function isTranslationMutation(record: MutationRecord): boolean {
  if (isLineBreakParagraphMutation(record)) return true;
  const tracked = record.target instanceof Text ? trackedByText.get(record.target) : undefined;
  if (tracked?.replaced && tracked.node.data === (tracked.replacementValue ?? "")) return true;
  let element = record.target instanceof Element ? record.target : record.target.parentElement;
  while (element) {
    const entry = inlinePlansByBlock.get(element);
    if (entry && inlinePlans.get(entry.id) === entry.plan && entry.plan.isCurrent()) return true;
    element = element.parentElement;
  }
  return false;
}

function removeRenderedTranslation(id: string): void {
  const rendered = renderedById.get(id);
  // Original Text nodes belong to the page and must keep their identity.
  if (rendered instanceof Element) rendered.remove();
  renderedById.delete(id);
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
  const all = root === document.documentElement;
  for (const plan of inlinePlans.values()) {
    if (all || plan.block === root || composedContains(root, plan.block)) plan.restore();
  }
  for (const [id, replacement] of stableReplacementsById) {
    if (all || replacement.source === root || composedContains(root, replacement.source)) restoreStableReplacement(id);
  }
  for (const group of trackedGroups) {
    if (group.sourceHidden && (all || group.block === root || composedContains(root, group.block))) {
      restoreGroupedSource(group);
    }
  }
  for (const tracked of trackedImageTexts) {
    if (all || tracked.image === root || composedContains(root, tracked.image)) restoreImageTextSource(tracked);
  }
  for (const tracked of trackedNodes) {
    if (!tracked.replaced) continue;
    if (!all && (!tracked.node.parentElement || (tracked.node.parentElement !== root && !composedContains(root, tracked.node.parentElement)))) continue;
    if (tracked.node.data === (tracked.replacementValue ?? "")) tracked.node.data = tracked.sourceValue;
    tracked.replaced = false;
    tracked.replacementValue = undefined;
  }
  for (const tokens of protectedTokensById.values()) {
    for (const token of tokens) {
      if (!all && token.sourceNode !== root && !composedContains(root, token.sourceNode)) continue;
      restoreProtectedSource(token);
    }
  }
}

function isSameTranslation(id: string, translation: string): boolean {
  if (!deferredBlockTexts.has(id) && !sourceTextById.has(id)) return false;
  return normalizeText(readSourceText(id)) === normalizeText(translation);
}

function findTargetTranslations(targetId: string): Element[] {
  return queryTranslationElements(`[${TRANSLATION_TARGET_ATTR}]`).filter(
    (node) => node.getAttribute(TRANSLATION_TARGET_ATTR) === targetId
  );
}

function insertPending(anchor: Text, id: string, mode: RenderMode): void {
  removePendingForId(id);
  const pending = createPendingElement(id, mode);
  if (anchor.parentElement) applyTranslationTextAppearance(pending, anchor.parentElement, "bilingual");
  if (mode === "block" && anchor.parentElement?.matches(HEADING_SELECTOR)) insertBlockTranslation(anchor.parentElement, pending);
  else anchor.after(pending);
}

let translationColors: TranslationColors | undefined;
const translationColorSources = new WeakMap<HTMLElement, { source: Element } | { color: string; background: string }>();

/** Recolor existing results in place, including paragraph and image-text translations. */
export function refreshTranslationColors(colors?: TranslationColors): void {
  translationColors = colors;
  for (const result of queryTranslationElements<HTMLElement>(
    '.wupage-translation[data-wupage-display-mode="bilingual-accent"], .wupage-image-text-result'
  )) {
    if (result.dataset.wupageImageLayout === "interleaved") continue;
    const entry = translationColorSources.get(result);
    if (!entry) continue;
    if ("source" in entry) {
      if (entry.source.isConnected) applyTranslationTextColor(result, entry.source, "bilingual-accent");
    } else {
      const color = mapTranslationTextColor(entry.color, entry.background, translationColors);
      if (color) setTranslationTextColor(result, color);
    }
  }
}

function applyTranslationTextAppearance(
  translation: HTMLElement,
  source: Element,
  displayMode: TranslationDisplayMode
): void {
  applyTranslationWrapping(translation, source);
  applyTranslationTextColor(translation, source, displayMode);
}

function applyTranslationWrapping(translation: HTMLElement, source: Element): void {
  if (translation.dataset.wupageMode === "code-comment"
    || translation.dataset.wupagePreserveWhitespace === "true"
    || window.getComputedStyle(source).whiteSpace !== "nowrap") return;

  // Render mode describes placement, not meaning: a short prose span and an
  // inbox timestamp can both be inline. Respect explicit UI constraints first.
  const cell = source.closest("td,th,[role='cell'],[role='gridcell'],[role='columnheader'],[role='rowheader']");
  const paragraph = source.closest("p,blockquote,figcaption");
  const compact = isCompactNavigationText(source) || isCompactControlText(source)
    || getSingleLineTextTarget(source)
    || (cell && (!paragraph || !cell.contains(paragraph)));
  if (compact) {
    translation.style.setProperty("white-space", "inherit");
    return;
  }

  // Only positively identified flowing prose may override inherited nowrap.
  // Leaf div prose can still use inline placement when its original is short.
  const div = source.closest("div");
  const flowingDiv = div && isDivProseBlock(div)
    && (!div.parentElement || !isLayoutContainer(div.parentElement));
  const prose = paragraph || flowingDiv || source.closest(HEADING_SELECTOR)
    || source.matches(`li,dt,dd,article,[role='article'],${LINE_BREAK_SOURCE_SELECTOR},${POST_TEXT_SELECTOR},${YOUTUBE_COMMENT_SELECTOR}`)
    || isLegacyScientificProseBlock(source);
  translation.style.setProperty("white-space", prose ? "normal" : "inherit");
}

function applyTranslationTextColor(
  translation: HTMLElement,
  source: Element,
  displayMode: TranslationDisplayMode
): void {
  translationColorSources.set(translation, { source });
  if (isCompactNavigationText(source) || isCompactControlText(source)) {
    // Host menus commonly style every span as an icon or collapsed label.
    // Shield inserted text without changing the link, layout cell or icon.
    for (const [name, value] of [
      ["display", "inline"], ["position", "static"], ["float", "none"],
      ["visibility", "visible"], ["opacity", "1"], ["font", "inherit"],
      ["font-size", displayMode === "replace" ? "inherit" : "0.92em"], ["line-height", "inherit"]
    ]) translation.style.setProperty(name, value, "important");
  }
  const sourceStyle = window.getComputedStyle(source);
  const color = sourceStyle.color;
  if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") return;
  if (displayMode !== "bilingual-accent") {
    setTranslationTextColor(translation, color);
    return;
  }
  const mapped = mapTranslationTextColor(color, getEffectiveBackgroundColor(source), translationColors);
  setTranslationTextColor(translation, mapped ?? color);
}

function setTranslationTextColor(translation: HTMLElement, color: string): void {
  // Host pages can force span colors or inherit a fixed WebKit text fill.
  // Keep the selected mode's color visible in both cases.
  translation.style.setProperty("color", color, "important");
  translation.style.setProperty("-webkit-text-fill-color", "currentColor", "important");
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
  queryTranslationElements<HTMLElement>(`.${PENDING_CLASS}[data-wupage-pending-id="${id}"]`).forEach((node) => {
    const parent = node.parentElement;
    const targetId = node.getAttribute(TRANSLATION_TARGET_ATTR);
    node.remove();
    if (parent && !parent.querySelector(`.${TRANSLATION_CLASS}`)) {
      parent.removeAttribute(TRANSLATED_ATTR);
    }
    if (targetId && !findTargetTranslations(targetId).length) {
      const target = queryTranslationElements(`[${TARGET_ATTR}="${targetId}"]`)[0];
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
  const exclusionBoundaries = new Map<Element, boolean>();

  for (const tracked of nodes) {
    if (tracked.mode === "code-comment") continue;
    const block = findGroupingBlock(tracked.node.parentElement);
    if (!block) continue;
    // Keep excluded inline regions in place instead of merging their content
    // into a larger paragraph or hiding them during replacement.
    if (!exclusionBoundaries.has(block)) exclusionBoundaries.set(block, containsExcludedElement(block));
    if (exclusionBoundaries.get(block)) continue;
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
    if (block.matches(POST_TEXT_SELECTOR)) {
      for (const paragraph of getPostParagraphGroups(block, groupNodes)) {
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
    // A block whose text lives in one node is cheap and decides its own grouping
    // from that text, so it is read now. Multi-node blocks are the expensive ones
    // and their text is only needed once the segment reaches a batch.
    const singleNodeBlock = groupNodes.length < 2;
    const readable = singleNodeBlock
      ? getReadableBlockText(block, visibility, groupNodes.length)
      : undefined;
    if (
      singleNodeBlock &&
      readable!.text === nodeText &&
      !block.matches(LINE_BREAK_SOURCE_SELECTOR) &&
      !isLegacyScientificProseBlock(block) &&
      !block.matches(`summary, label, li, ${POST_TEXT_SELECTOR}, ${YOUTUBE_COMMENT_SELECTOR}`)
    ) continue;
    if (singleNodeBlock && !readable!.text) continue;
    const authoredLines = isAuthoredLineTextBlock(block);
    const sourceNodes = completeGroupedSourceNodes(block, groupNodes, visibility, trackedSourceNodes);
    trackedGroups.push({
      id, nodes: sourceNodes, block, mode: authoredLines ? "block" : getRenderMode(block), authoredLines,
      preserveWhitespace: block.matches(YOUTUBE_COMMENT_SELECTOR)
    });
    if (singleNodeBlock) {
      if (readable!.tokens.length) protectedTokensById.set(id, readable!.tokens);
      groupedSegments.push({ id, text: readable!.text, element: block });
    } else {
      // Every accepted node is non-blank, so a multi-node block always resolves
      // to a non-empty text and needs no empty-text fallback here.
      deferredBlockTexts.set(id, { block, accepted: new Set(sourceNodes.map((tracked) => tracked.node)) });
      groupedSegments.push({
        id,
        element: block,
        get text(): string {
          return resolveDeferredBlockText(id);
        }
      });
    }
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
    const citation = parent?.closest("a[href]");
    // The entire citation is already a protected token. Clearing its text as
    // ordinary prose would mutate the protection source during replacement.
    if (citation && isScientificCitation(citation)) continue;
    if (tracked.has(node) || !parent || findGroupingBlock(parent) !== block
      || hasSkippedAncestor(parent, "code,kbd,samp,button,input,textarea,select,option,[role='button']")
      || shouldSkipElement(parent, true, visibility) || !visibility.isTextNodeVisuallyRendered(node)) continue;
    // Short words, punctuation and whitespace can be in the complete paragraph
    // even when they were unsuitable as standalone translation requests.
    const entry: TrackedNode = {
      id: nodes[0].id, node, mode: nodes[0].mode, sourceValue: node.data, sourceParent: parent,
      sourcePath: translationNodePath(node)
    };
    trackTextNodes(entry);
    tracked.add(node);
    complete.push(entry);
  }
  return complete;
}

interface PostParagraphGroup {
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
          id, node, mode: "block", sourceValue: node.data, sourceParent: node.parentElement!,
          sourcePath: translationNodePath(node)
        };
        trackTextNodes(tracked);
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

function getPostParagraphGroups(
  block: Element,
  groupNodes: TrackedNode[]
): PostParagraphGroup[] {
  const trackedByNode = new Map(groupNodes.map((tracked) => [tracked.node, tracked]));
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const owner = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
      // Screen-reader-only text (Discord's full timestamp next to "(edited)") is not part of the post.
      if (owner?.closest(`.${TRANSLATION_CLASS}, .sr-only, [class*='hiddenVisually']`)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return (node as Element).matches("br") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  const paragraphs: PostParagraphGroup[] = [];
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

let groupingBlockCache = new WeakMap<Element, Element | null>();

function findGroupingBlock(element: Element | null): Element | null {
  if (!element) return null;
  if (groupingBlockCache.has(element)) return groupingBlockCache.get(element) ?? null;
  const candidate = constrainTranslationOwner(element, computeGroupingBlock(element));
  // An explicitly re-enabled child of translate=no owns its own text. Never
  // aggregate it into an opted-out paragraph and replace that paragraph.
  const block = candidate && !isTranslationOptedOut(candidate) ? candidate : null;
  groupingBlockCache.set(element, block);
  return block;
}

function computeGroupingBlock(element: Element): Element | null {
  const lineBreakParagraph = element.closest(LINE_BREAK_SOURCE_SELECTOR);
  if (lineBreakParagraph) return lineBreakParagraph;
  const description = element.closest(YOUTUBE_DESCRIPTION_SELECTOR);
  if (description) return element.closest("a") ? null : description;
  const comment = element.closest(YOUTUBE_COMMENT_SELECTOR);
  if (comment) return comment;
  const workshopTitle = steamItemTitle(element);
  if (workshopTitle) return workshopTitle;
  const compactControlTarget = getCompactControlTarget(element);
  if (compactControlTarget) return compactControlTarget;
  const compactNavigationTarget = getCompactNavigationTarget(element);
  if (compactNavigationTarget) return compactNavigationTarget;
  const singleLineTarget = getSingleLineTextTarget(element);
  if (singleLineTarget) return constrainGroupingToLayoutSlot(element, singleLineTarget);

  const listItem = element.closest("li");
  const readableBlock = element.closest(
    `${SEMANTIC_TEXT_BLOCK_SELECTOR}, label, summary, ${POST_TEXT_SELECTOR}`
  );
  // Layout tables and blockquotes can wrap entire documents. Their semantic
  // boundary must not absorb nearer list items; replacement would empty those
  // items and move their combined translation to the outer container's end.
  // Paragraphs and cells *inside* a list item still own their own content.
  if (readableBlock && (!listItem || listItem.contains(readableBlock))) {
    if (readableBlock.matches("summary") && !isInsideReadableSummary(readableBlock)) return null;
    return constrainGroupingToLayoutSlot(element, readableBlock);
  }
  const scientificBlock = legacyScientificProseBlock(element);
  if (scientificBlock) return scientificBlock;

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
  if (div && isDivProseBlock(div)) return constrainGroupingToLayoutSlot(element, div);

  if (!listItem) return null;
  const slot = constrainGroupingToLayoutSlot(element, listItem);
  if (slot !== listItem) return slot;
  if (isStructuredListItem(listItem)) return null;
  const link = element.closest("a");
  // Tags and icon/link rows give the link its own layout box. Moving its
  // translation to the list item leaves an empty badge or fixed-width link
  // behind, so keep the label (including rich text) inside that same link.
  // Plain inline links within list prose still belong to the full sentence.
  if (link && listItem.contains(link)
    && normalizeText(listItem.textContent ?? "") === normalizeText(link.textContent ?? "")
    && /^(?:block|inline-block|(?:inline-)?(?:flex|grid))$/u.test(window.getComputedStyle(link).display)) {
    return link;
  }
  return listItem;
}

function isLayoutContainer(element: Element): boolean {
  return /^(?:inline-)?(?:flex|grid)$/u.test(window.getComputedStyle(element).display);
}

// Inbox/result rows put rich text inside a clipped, single-line wrapper.
// Grouping at the surrounding table cell moves the result outside that box.
// Keep the first independent text field (subject, preview, sender) in place.
function getSingleLineTextTarget(element: Element): Element | null {
  let container: Element | null = element;
  while (container && container !== document.body) {
    const style = window.getComputedStyle(container);
    if (style.whiteSpace === "nowrap"
      && (/(?:hidden|clip)/u.test(`${style.overflow} ${style.overflowX}`) || style.textOverflow === "ellipsis")) {
      let field = container;
      // A single wrapper often sits between the clipping box and its fields.
      // Only descend through wrappers with no authored text of their own.
      while (field.children.length && !Array.from(field.childNodes).some(node =>
        node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()))) {
        const child = Array.from(field.children).find(child => child === element || child.contains(element));
        if (!child) break;
        field = child;
        if (field.parentElement!.children.length > 1) break;
      }
      return field;
    }
    if (container.matches(`${SEMANTIC_TEXT_BLOCK_SELECTOR},li,article,main,[role='main']`)) break;
    container = container.parentElement;
  }
  return null;
}

// A semantic paragraph/list item may itself arrange several independent cells.
// Read and render inside the nearest cell instead of aggregating its siblings
// or introducing another flex/grid item for their combined translation.
function constrainGroupingToLayoutSlot(element: Element, block: Element, respectLinkLayout = false): Element | null {
  let current = element;
  while (current !== block && current.parentElement) {
    // Inline-block badges, statistics links and labels are independent boxes
    // even when their parent is a normal paragraph rather than a flex row.
    if (window.getComputedStyle(current).display === "inline-block"
      && !current.matches("code,kbd,samp,.MATH")
      && !current.querySelector(`${SEMANTIC_TEXT_BLOCK_SELECTOR},div,ul,ol,dl`)) return current;
    const parent = current.parentElement;
    if (isLayoutContainer(parent)
      && (respectLinkLayout || !(parent.matches("a") && !parent.querySelector(SEMANTIC_TEXT_BLOCK_SELECTOR)))) {
      return current.querySelector(`${SEMANTIC_TEXT_BLOCK_SELECTOR},div,ul,ol,dl,button,input,select,textarea`)
        ? null : current;
    }
    current = parent;
  }
  return block;
}

function isAuthoredLineTextBlock(element: Element): boolean {
  if (!element.matches("span") || !element.querySelector("br")) return false;
  if (hasSkippedAncestor(element, "a,button,nav,[role='navigation'],[role='button'],[role='tab']")) return false;
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
  return element.matches("li")
    && Boolean(element.querySelector(`${HEADING_SELECTOR},p,blockquote,table,ul,ol,dl`));
}

function isStructuredListMetadata(element: Element): boolean {
  const listItem = element.closest("li");
  // Existing heading-based activity cards use the surrounding fields as
  // metadata. A paragraph-only card can have readable labels of its own.
  if (!listItem?.querySelector(HEADING_SELECTOR)) return false;
  // A chat message (Discord: li > h3 name + div body) wraps an ARIA article: its text is the post, not card metadata.
  const article = element.closest("[role='article']");
  if (article && listItem.contains(article)) return false;

  return !element.closest(`p, blockquote, ${HEADING_SELECTOR}`);
}

function shouldSkipElement(
  element: Element,
  includeNavigation = false,
  visibility?: RenderVisibilitySnapshot
): boolean {
  // A scan asks this question once per text node, so sibling nodes under the
  // same parent repeat the whole ancestor-closest chain. The answer only
  // depends on the element and on the snapshot used to judge aria-hidden text.
  if (!visibility || !includeNavigation) return decideSkipElement(element, includeNavigation, visibility);
  const memoized = visibility.decisions.get(element);
  if (memoized !== undefined) return memoized;
  const skip = decideSkipElement(element, includeNavigation, visibility);
  visibility.decisions.set(element, skip);
  return skip;
}

function decideSkipElement(
  element: Element,
  includeNavigation: boolean,
  visibility?: RenderVisibilitySnapshot
): boolean {
  if (isNonProseElement(element) || isTranslationOptedOut(element)) return true;
  if (isLegacyScientificEquation(element)) return true;
  if (element.closest(`.${TRANSLATION_CLASS},kbd,samp`)) return true;
  if (element.closest(VIDEO_CONTROL_SELECTOR)) return true;
  if (element.closest(videoPlatform()?.captions ?? ".vjs-text-track-display,.plyr__captions,.jw-captions")) return true;
  if (element.closest(REDDIT_METADATA_SELECTOR)) return true;
  if (isInsideCodeBlock(element)) return false;
  if (isCompactControlText(element)) {
    return hasSkippedAncestor(element, COMPACT_CONTROL_SKIP_SELECTOR);
  }
  if (SKIP_TAGS.has(element.tagName.toUpperCase())) return true;
  if (isCompactNavigationText(element)) {
    if (!includeNavigation && !element.closest(KNOWN_COMPACT_NAV_SELECTOR)) return true;
    return hasSkippedAncestor(element, COMPACT_NAV_SKIP_SELECTOR);
  }
  if (isInsideDocumentSemanticText(element)) {
    return hasSkippedAncestor(element, COMPACT_NAV_SKIP_SELECTOR);
  }
  if (isInsideReadableHeadingContent(element)) {
    return hasSkippedAncestor(element, READABLE_SUMMARY_SKIP_SELECTOR);
  }
  if (isInsideReadableSummary(element)) {
    return hasSkippedAncestor(element, READABLE_SUMMARY_SKIP_SELECTOR);
  }
  const skipSelector = isVisuallyRenderedAriaHiddenText(element, visibility)
    ? VISIBLE_ARIA_HIDDEN_SKIP_SELECTOR
    : SKIP_SELECTOR;
  return hasSkippedAncestor(element, skipSelector);
}

function hasSkippedAncestor(element: Element, selector: string): boolean {
  let skipped = element.closest(selector);
  while (skipped && isSteamContentCard(skipped)) {
    // Only the navigable-card role is exempt; hidden/editor/navigation rules
    // on the very same element must still apply.
    const otherSelectors = selector.split(",").filter(part => part.trim() !== "[role='button']").join(",");
    if (otherSelectors && skipped.matches(otherSelectors)) return true;
    skipped = skipped.parentElement?.closest(selector) ?? null;
  }
  return Boolean(skipped);
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

// Anything here changes what the plain text of a block means: code and math
// become protected tokens, <br> becomes a space, and the rest are stripped from
// the clone. A block carrying none of them can be read without cloning it.
const PLAIN_TEXT_BLOCKER_SELECTOR = [
  IMMUTABLE_INLINE_SELECTOR,
  "code",
  "kbd",
  "samp",
  "br",
  ".MATH",
  ".anchor",
  "rustdoc-toolbar",
  "[title*='Copy item path']",
  "[aria-label*='Copy item path']",
].join(",");

/**
 * True when the visible text of a block equals its raw textContent.
 *
 * Cloning a block is the most expensive step of a scan, and most prose blocks
 * need none of it: no protected inline elements, no <br>, and every non-blank
 * text node already accepted for this very block (so nothing would be stripped
 * from the clone).
 */
function canReadPlainBlockText(block: Element, acceptedNodes: number): boolean {
  if (block.querySelector(PLAIN_TEXT_BLOCKER_SELECTOR)) return false;
  for (const link of block.querySelectorAll("a[href]")) {
    if (isScientificCitation(link)) return false;
  }
  let total = 0;
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (NON_BLANK_TEXT.test((walker.currentNode as Text).data)) total += 1;
  }
  return total === acceptedNodes;
}

function getReadableBlockText(
  block: Element,
  visibility: RenderVisibilitySnapshot,
  acceptedNodes?: number,
  acceptedText?: Set<Text>
): { text: string; tokens: ProtectedToken[] } {
  if (acceptedNodes !== undefined && canReadPlainBlockText(block, acceptedNodes)) {
    return { text: normalizeText(block.textContent ?? ""), tokens: [] };
  }
  const clone = block.cloneNode(true) as Element;
  // A clone has the same element order as its source, so candidates pair up by
  // index. Walking an ancestor path for every candidate was pure overhead.
  const protectedSelector = `code,kbd,samp,.MATH,a[href],${IMMUTABLE_INLINE_SELECTOR}`;
  const sourceCandidates = Array.from(block.querySelectorAll(protectedSelector));
  const protectedCandidates = Array.from(clone.querySelectorAll(protectedSelector)).map((
    node,
    index
  ) => ({
    element: node as Element,
    sourceElement: sourceCandidates[index] ?? null
  }));
  removeUnrenderedCloneText(block, clone, visibility, acceptedText);
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
        "[class*='hiddenVisually']",
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
    const immutable = sourceElement.matches("math") || isTranslationOptedOut(sourceElement);
    if (!sourceElement.matches("code,kbd,samp") && !immutable
      && !isScientificMathImage(sourceElement) && !isScientificCitation(sourceElement)) return;
    if (sourceElement.closest(NON_PROSE_SELECTOR)) return;
    if (!visibility.isElementVisuallyRendered(sourceElement)) return;
    if (!isProtectedInlineElement(sourceElement)) return;
    // An opt-out wrapper can contain independently enabled text. That text is
    // translated separately, so cloning the wrapper would duplicate it.
    if (immutable && sourceElement.querySelector("[translate='yes' i],[translate='']")) return;
    const protectedElement = getProtectedRenderElement(sourceElement);
    const marker = `⟪WUPAGE${tokens.length}⟫`;
    tokens.push({
      marker,
      node: protectedElement.cloneNode(true) as Element,
      sourceNode: protectedElement,
      sourceSignature: protectedSourceSignature(protectedElement)
    });
    element.replaceWith(document.createTextNode(` ${marker} `));
  });

  return {
    text: normalizeText(clone.textContent ?? ""),
    tokens
  };
}

function protectedSourceSignature(element: Element, hiddenByExtension = false): string {
  // Protected nodes are not in trackedNodes. A virtualized page can change a
  // formula, code identifier, brand or citation without touching adjacent prose.
  // Ignore only our own reversible root class and whitespace cleared by replace.
  const markup = [element, ...element.querySelectorAll("*")].map(node => [node.namespaceURI, node.localName,
    [...node.attributes].flatMap(attribute => {
      if (attribute.name !== "class") return [[attribute.name, attribute.value]];
      const classes = [...node.classList].filter(name => node !== element || !hiddenByExtension || name !== REPLACED_SOURCE_CLASS).sort();
      return classes.length ? [["class", classes.join(" ")]] : [];
    }).sort(([left], [right]) => left.localeCompare(right))]);
  return JSON.stringify([normalizeText(element.textContent ?? ""), markup]);
}

function removeUnrenderedCloneText(
  source: Element,
  clone: Element,
  visibility: RenderVisibilitySnapshot,
  acceptedText?: Set<Text>
): void {
  const sourceWalker = source.ownerDocument.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const cloneWalker = clone.ownerDocument.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  // Walk both trees in lockstep. Removed nodes are collected instead of deleted
  // in place: detaching the walker's current node strands it, and the rest of the
  // block would then keep text that was supposed to be dropped.
  const hidden: Text[] = [];
  while (sourceWalker.nextNode() && cloneWalker.nextNode()) {
    const sourceText = sourceWalker.currentNode as Text;
    // A deferred read replays the decision made during the scan, so a block read
    // after the user scrolled still yields the same text.
    const keep = acceptedText
      ? acceptedText.has(sourceText)
      : visibility.isTextNodeVisuallyRendered(sourceText);
    // A descendant may belong to its own label, control or paragraph. Its
    // text must never also appear in an ancestor's translation request.
    if (!keep || (sourceText.parentElement && isElementExcluded(sourceText.parentElement))
      || findGroupingBlock(sourceText.parentElement) !== source) {
      hidden.push(cloneWalker.currentNode as Text);
    }
  }
  for (const node of hidden) node.remove();
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
  if (isCompactControlText(element)) return true;
  if (legacyScientificProseBlock(element)) return true;
  const div = element.closest("div");
  return Boolean(element.closest(`li,${SEMANTIC_TEXT_BLOCK_SELECTOR}`) || (div && isDivProseBlock(div)));
}

function getProtectedRenderElement(element: Element): Element {
  const link = element.closest("a");
  if (link && link.textContent?.trim() === element.textContent?.trim()) return link;
  return element;
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
    // Keep heading anchors and action controls on the original title's row;
    // the bilingual result starts its own row with the same typography.
    block.append(translation);
    return;
  }
  if (block.matches(`li, ${YOUTUBE_COMMENT_SELECTOR}, ${DISCORD_MESSAGE_SELECTOR}`)) {
    block.append(translation);
    return;
  }
  if (block.parentElement && isLayoutContainer(block.parentElement)) {
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
  // Legacy title/abstract divs carry their own alignment and typography.
  if (block.matches("div") && isLegacyScientificProseBlock(block)) {
    block.append(translation);
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

function getRenderMode(element: Element | null): RenderMode {
  if (!element) return "inline";
  if (element.matches(LINE_BREAK_SOURCE_SELECTOR)) return "block";
  if (isLegacyScientificProseBlock(element)) return "block";
  if (element.matches(POST_TEXT_SELECTOR)) return "block";
  if (element.matches(YOUTUBE_COMMENT_SELECTOR)) return "block";
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
  if (element.closest(LINE_BREAK_SOURCE_SELECTOR)) return false;
  if (translationOwner(element)) return false;
  // Steam's generated div/link UI also carries short headings, filters and
  // mod names. Keep these readable labels; normal content exclusions still apply.
  if (isSteamCommunity(element)) return false;
  if (legacyScientificProseBlock(element)) return false;
  if (element.closest(YOUTUBE_DESCRIPTION_SELECTOR)) return false;
  if (element.closest(YOUTUBE_COMMENT_SELECTOR)) return false;
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
  // Standalone counts/dates carry no language. Numbers inside prose are
  // recovered by completeGroupedSourceNodes and remain in that sentence.
  if (!/\p{L}/u.test(text)) return true;
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
  // Navigation links can be fixed-height icon/text rows even when their icons
  // are font glyphs rather than img/svg. Keep rich labels inside the existing
  // text cell so replacement does not land in a clipped extra row/column.
  const slot = constrainGroupingToLayoutSlot(element, target, true);
  if (slot !== target) return slot;
  if (target.matches("a") && target.querySelector("img,svg,canvas")) {
    return getNestedTextHost(element, target);
  }
  return target;
}

function isCompactControlText(element: Element): boolean {
  return Boolean(getCompactControlTarget(element));
}

function getCompactControlTarget(element: Element): Element | null {
  const control = element.closest(COMPACT_CONTROL_SELECTOR) ?? getSlottedControlHost(element);
  if (!control || control.closest(HEADING_SELECTOR)) return null;
  if (isSteamContentCard(control)) return null;
  if (control.matches("a:not([role='button'])") && !control.querySelector("img,svg,canvas")) return null;
  if (control.querySelector("input,select,textarea,[contenteditable='true']")) return null;
  const text = normalizeText(control.textContent ?? "");
  if (text.length < 2 || text.length > 120) return null;
  return getNestedTextHost(element, control);
}

// A custom element may expose its button only inside an open shadow root.
// Its light-DOM label still belongs to that button's slot, not the surrounding
// action row. Check the actual projection so prose beside a button is unaffected.
function getSlottedControlHost(element: Element): Element | null {
  let child: Element | null = null;
  for (let host: Element | null = element; host; child = host, host = host.parentElement) {
    if (!componentShadowRoot(host)) continue;
    const slots = child ? [projectedSlot(child)] : Array.from(host.childNodes).flatMap(node =>
      node instanceof Text ? [projectedSlot(node)] : []);
    if (slots.some(slot => slot?.closest(COMPACT_CONTROL_SELECTOR))) return host;
  }
  return null;
}

function getNestedTextHost(element: Element, container: Element): Element {
  if (element === container) return container;
  let host = element;
  while (host.parentElement && host.parentElement !== container) {
    const parent = host.parentElement;
    // Keep grouped labels in their layout cell instead of adding a new item
    // to the parent's icon/text grid or flex row.
    if (/^(?:inline-)?(?:flex|grid)$/u.test(window.getComputedStyle(parent).display)) break;
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
