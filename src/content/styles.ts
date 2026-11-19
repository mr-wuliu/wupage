import { onTranslationRoot, translationRoots } from "./dom-roots";

const STYLE_ID = "wupage-translation-style";
const styles = new WeakMap<Document | ShadowRoot, HTMLStyleElement>();
const observers = new WeakMap<Document | ShadowRoot, MutationObserver>();
let subscribed = false;

const PAGE_ACTIONS = "a[href],area[href],button,input,select,textarea,label,summary,"
  + "[role='button'],[role='link'],[role='tab'],[role^='menuitem'],[role='option'],[role='combobox'],"
  + "[role='checkbox'],[role='radio'],[role='switch'],[role='slider'],[role='treeitem']";

export function injectContentStyles(): void {
  if (!subscribed) { subscribed = true; onTranslationRoot(ensureRootStyles); }
  for (const root of translationRoots()) ensureRootStyles(root);
}

function ensureRootStyles(root: Document | ShadowRoot): void {
  const isDocument = root.nodeType === 9;
  const owner = (isDocument ? root : root.ownerDocument) as Document;
  const view = owner.defaultView;
  if (!owner.documentElement || !view || view.document !== owner) return;
  let style = styles.get(root);
  if (!style) {
    style = owner.createElement("style"); style.id = STYLE_ID;
    styles.set(root, style);
  }
  if (style.textContent !== CONTENT_CSS) style.textContent = CONTENT_CSS;
  style.disabled = false;
  style.removeAttribute("media");
  const parent = isDocument ? owner.documentElement : root;
  if (style.parentNode !== parent) parent.append(style);
  if (!observers.has(root)) {
    // Defer repairs to one task. Host code repeatedly deleting styles cannot
    // create an unbounded synchronous MutationObserver feedback loop.
    let repair: number | undefined;
    const observer = new view.MutationObserver(records => {
      if (repair !== undefined) return;
      if (style!.isConnected && !records.some(record => record.target === style || style!.contains(record.target))) return;
      if (style!.isConnected && style!.textContent === CONTENT_CSS && !style!.disabled && !style!.hasAttribute("media")) return;
      repair = view.setTimeout(() => {
        repair = undefined;
        // The task can outlive a removed frame, shadow host or test realm.
        // Use the owning document rather than ambient DOM constructors.
        if (view.document !== owner || (!isDocument && !(root as ShadowRoot).host.isConnected)) {
          observer.disconnect(); observers.delete(root); return;
        }
        ensureRootStyles(root);
      }, 100);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["media", "disabled"] });
    observers.set(root, observer);
  }
}

const CONTENT_CSS = `
    .wupage-translation {
      position: static !important;
      float: none !important;
      transform: none !important;
      text-indent: 0 !important;
      box-sizing: border-box;
      min-width: 0;
      width: auto;
      height: auto;
      max-width: 100%;
      white-space: normal;
      overflow-wrap: break-word;
      word-break: break-word;
    }

    .wupage-translation:not(.wupage-translation-pending) {
      pointer-events: auto;
      -webkit-user-select: text !important;
      user-select: text !important;
    }

    /* Let the browser start selections on rendered text. Keep original action
       targets and presentation-only copies of actions out of the hit path. */
    :where(${PAGE_ACTIONS}) .wupage-translation,
    .wupage-translation :where(${PAGE_ACTIONS},[onclick]),
    .wupage-translation :where(${PAGE_ACTIONS},[onclick]) *,
    .wupage-translation-pending {
      pointer-events: none !important;
    }

    .wupage-translation[data-wupage-mode="block"] {
      display: block;
      margin: 0.18em 0 0.38em;
      color: inherit;
      font: inherit;
      line-height: inherit;
    }

    .wupage-translation[data-wupage-mode="block"][data-wupage-container="heading"] {
      display: block;
      margin: 0.18em 0 0.38em;
      color: inherit;
      font: inherit;
      line-height: inherit;
    }

    .wupage-translation[data-wupage-mode="inline"] {
      display: inline;
      margin-left: 0.35em;
      color: inherit;
      font-size: 0.92em;
      line-height: inherit;
      white-space: inherit;
      overflow-wrap: inherit;
      word-break: inherit;
    }

    .wupage-translation[data-wupage-mode="code-comment"] {
      display: block;
      margin: 0;
      color: inherit;
      font: inherit;
      line-height: inherit;
      white-space: pre-wrap;
    }

    .wupage-translation[data-wupage-preserve-whitespace="true"] {
      white-space: pre-wrap;
    }

    .wupage-translation[data-wupage-container="youtube-description"] {
      display: inline;
      margin: 0;
      white-space: pre-wrap;
    }

    .wupage-translation[data-wupage-container="youtube-description"]:not([data-wupage-display-mode="replace"])::before {
      content: "\\A";
      white-space: pre;
    }

    .wupage-translation[data-wupage-display-mode="replace"] {
      display: inline;
      margin: 0;
      color: inherit;
      font: inherit;
      line-height: inherit;
    }

    /* GitHub lays out code and line numbers in separate fixed-height rows.
       Keep comment translations on the source row, including pending states,
       so neither virtualized code nor the gutter needs to be resized. */
    :is(.react-code-text, .blob-code) .wupage-translation[data-wupage-mode="code-comment"] {
      display: inline;
      margin: 0 0 0 0.75em;
      white-space: nowrap;
    }

    :is(.react-code-text, .blob-code) .wupage-translation[data-wupage-mode="code-comment"][data-wupage-display-mode="replace"] {
      margin: 0;
    }

    .wupage-replaced-source {
      display: none !important;
    }

    /* Keep host-managed text measurable while its replacement determines the
       wrapper's height. The source must not stretch to the translation row. */
    .wupage-stable-replacement {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) !important;
      align-items: start !important;
    }

    .wupage-stable-replacement > .wupage-stable-source {
      grid-area: 1 / 1 !important;
      align-self: start !important;
      min-width: 0 !important;
      visibility: hidden !important;
    }

    .wupage-stable-replacement > .wupage-translation[data-wupage-container="stable-replacement"] {
      grid-area: 1 / 1;
      align-self: start;
      min-width: 0;
      display: block;
      margin: 0;
      visibility: visible;
    }

    .wupage-translation[data-wupage-container="authored-lines"] {
      position: static;
      display: block;
      float: none;
      width: auto;
      min-width: 0;
      height: auto;
      transform: none;
      letter-spacing: inherit;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .wupage-translation[data-wupage-container="image-text"] {
      display: block;
      margin: 0.6em 0;
      padding: 0;
      border-radius: 0;
      color: inherit;
      background: transparent;
      font-size: 0.95em;
      line-height: 1.55;
      text-align: start;
      white-space: pre-wrap;
    }

    .wupage-translation[data-wupage-image-layout="interleaved"] {
      container-type: inline-size;
      margin: 0;
      padding: 0;
      border-radius: 0;
      background: transparent;
      text-align: center;
      white-space: normal;
    }

    .wupage-image-text-row {
      display: block;
      margin: 0 0 1.4em;
      font-size: var(--wupage-image-font-size);
    }

    .wupage-image-text-original {
      position: relative;
      display: block;
      width: 100%;
      overflow: hidden;
    }

    .wupage-image-text-original > img {
      position: absolute;
      top: 0;
      left: 0;
      display: block;
      width: 100%;
      max-width: none;
      height: auto;
      margin: 0;
      padding: 0;
      border: 0;
      transform-origin: top left;
    }

    .wupage-image-text-result {
      display: block;
      margin: 0.3em 0 0;
      font-size: 0.95em;
      font-weight: 600;
      line-height: 1.75;
      white-space: pre-wrap;
    }

    .wupage-translation-pending {
      min-width: 1.25em;
      min-height: 1.25em;
      -webkit-user-select: none;
      user-select: none;
    }

    .wupage-translation-pending > span {
      display: inline-block;
      width: 0.9em;
      height: 0.9em;
      box-sizing: border-box;
      border: 2px solid rgba(15, 118, 110, 0.22);
      border-top-color: var(--wp-accent, #0f766e);
      border-radius: 999px;
      vertical-align: -0.12em;
      animation: wupage-spin 780ms linear infinite;
    }

    .wupage-translation-pending[data-wupage-mode="block"] > span,
    .wupage-translation-pending[data-wupage-mode="code-comment"] > span {
      margin: 0.2em 0;
    }

    :is(.react-code-text, .blob-code) .wupage-translation-pending[data-wupage-mode="code-comment"] > span {
      margin: 0;
    }

    @keyframes wupage-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;
