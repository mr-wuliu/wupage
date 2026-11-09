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
  const css = isDocument ? CONTENT_CSS : CONTENT_CSS.split("#wupage-floating-hitbox")[0];
  if (style.textContent !== css) style.textContent = css;
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
      if (style!.isConnected && style!.textContent === css && !style!.disabled && !style!.hasAttribute("media")) return;
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

    #wupage-floating-hitbox {
      all: initial;
      position: fixed !important;
      left: auto !important;
      top: auto !important;
      right: 22px !important;
      bottom: 88px !important;
      z-index: 2147483647 !important;
      box-sizing: border-box !important;
      width: 74px !important;
      height: 74px !important;
      margin: 0 !important;
      padding: 0 !important;
      display: grid !important;
      place-items: center !important;
      transform: none !important;
      pointer-events: auto !important;
    }

    #wupage-floating-hitbox[hidden] {
      display: none !important;
    }

    #wupage-floating-hitbox:has(.is-menu-open) {
      pointer-events: none !important;
    }

    #wupage-floating-ball {
      all: initial;
      position: relative;
      box-sizing: border-box;
      width: 42px;
      height: 42px;
      min-width: 0;
      min-height: 0;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 999px;
      display: grid;
      place-items: center;
      color: var(--wp-floating-foreground, #ffffff);
      background: var(--wp-floating-background, #116466);
      opacity: var(--wp-floating-opacity, 1);
      box-shadow: 0 8px 24px rgba(15, 35, 38, 0.22);
      appearance: none;
      cursor: pointer;
      pointer-events: auto;
      overflow: visible;
      text-align: center;
      text-decoration: none;
      text-indent: 0;
      text-transform: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      white-space: nowrap;
      touch-action: none;
      transition: transform 160ms ease, background 160ms ease, opacity 160ms ease;
    }

    #wupage-floating-ball > .wupage-floating-label {
      all: initial;
      user-select: none !important;
      -webkit-user-select: none !important;
      -webkit-touch-callout: none !important;
      pointer-events: none !important;
      display: block;
      color: var(--wp-floating-foreground, #ffffff);
      font-family: "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
      font-size: 16px;
      font-style: normal !important;
      font-synthesis: none;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0;
      text-align: center;
      text-decoration: none;
      text-indent: 0;
      text-transform: none;
      transform: none !important;
      writing-mode: horizontal-tb;
    }

    #wupage-floating-ball:hover {
      background: var(--wp-floating-hover, #0f5557);
    }

    #wupage-floating-ball:focus-visible {
      outline: 3px solid var(--wp-floating-background, #69b8ac);
      outline-offset: 3px;
    }

    #wupage-floating-ball.wupage-is-loading {
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--wp-floating-background, #116466) 25%, transparent), 0 8px 24px rgba(15, 35, 38, 0.22);
    }

    #wupage-floating-ball.is-dragging {
      transition: none;
      cursor: grabbing;
      opacity: calc(var(--wp-floating-opacity, 1) * 0.92);
      transform: none;
    }

    #wupage-floating-ball[data-edge="left"]:not(.is-dragging) {
      transform: translateX(0);
    }

    #wupage-floating-ball[data-edge="right"]:not(.is-dragging) {
      transform: translateX(0);
    }

    #wupage-floating-hitbox:has(#wupage-floating-ball[data-edge="left"]):hover #wupage-floating-ball,
    #wupage-floating-ball[data-edge="left"].is-menu-open {
      transform: translateX(20px);
    }

    #wupage-floating-hitbox:has(#wupage-floating-ball[data-edge="right"]):hover #wupage-floating-ball,
    #wupage-floating-ball[data-edge="right"].is-menu-open {
      transform: translateX(-20px);
    }

    #wupage-floating-menu {
      all: initial;
      color-scheme: var(--wp-color-scheme, light);
      position: fixed !important;
      z-index: 2147483647;
      box-sizing: border-box;
      width: 296px;
      display: grid;
      gap: 14px;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 10px;
      border: 1px solid var(--wp-border, rgba(31, 42, 46, 0.12));
      border-radius: 14px;
      background: var(--wp-surface, #ffffff);
      box-shadow: 0 12px 30px rgba(15, 35, 38, 0.2);
      font: 13px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--wp-foreground, #172026);
      direction: ltr;
      text-align: left;
      font-synthesis: none;
      isolation: isolate;
    }

    #wupage-floating-menu *,
    #wupage-floating-menu *::before,
    #wupage-floating-menu *::after {
      box-sizing: border-box;
    }

    #wupage-floating-menu[hidden],
    #wupage-floating-menu [hidden] {
      display: none !important;
    }

    #wupage-floating-menu button {
      all: initial;
      display: block;
      box-sizing: border-box;
      width: 100%;
      min-height: 32px;
      border: 0;
      border-radius: 6px;
      padding: 0 10px;
      color: var(--wp-foreground, #172026);
      background: transparent;
      text-align: left;
      font: inherit;
      text-shadow: none;
      appearance: none;
      white-space: nowrap;
      cursor: pointer;
    }

    #wupage-floating-menu button:hover {
      background: var(--wp-selected, #e8f1ef);
    }

    #wupage-floating-menu button:focus-visible {
      outline: 2px solid var(--wp-accent, #69b8ac);
      outline-offset: 2px;
    }

    #wupage-floating-menu button:disabled {
      cursor: wait;
      opacity: 0.65;
    }

    #wupage-floating-menu button[aria-pressed="true"] {
      color: var(--wp-accent, #0f5557);
      background: var(--wp-selected, #d9efea);
      font-weight: 700;
    }

    #wupage-floating-menu .wupage-translation-actions {
      display: flex;
      gap: 8px;
    }

    #wupage-floating-menu .wupage-translation-actions > button {
      flex: 1 1 0;
      min-width: 0;
    }

    #wupage-floating-menu button[data-action="page-toggle"] {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 40px;
      margin: 0;
      border: 1px solid var(--wp-accent, #116466);
      color: var(--wp-on-accent, #ffffff);
      background: var(--wp-accent, #116466);
      text-align: center;
      font-weight: 700;
    }

    #wupage-floating-menu button[data-action="page-toggle"]:hover {
      border-color: var(--wp-accent, #0f5557);
      background: var(--wp-accent-hover, #0f5557);
    }

    #wupage-floating-menu button[data-action="page-toggle"]:focus-visible {
      outline: 2px solid rgba(17, 100, 102, 0.34);
      outline-offset: 2px;
    }

    #wupage-floating-menu .wupage-menu-section {
      padding: 0;
    }

    #wupage-floating-menu .wupage-menu-top {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    #wupage-floating-menu .wupage-menu-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0;
      min-height: 28px;
    }

    #wupage-floating-menu .wupage-menu-header strong {
      font: 700 15px/1.2 system-ui, sans-serif;
      color: var(--wp-foreground, #172026);
    }

    #wupage-floating-menu button[data-action="retranslate"] {
      width: auto;
      flex: 0 0 auto;
      min-height: 28px;
      padding: 0 6px;
      color: var(--wp-accent, #116466);
      font-size: 12px;
    }

    #wupage-floating-menu .wupage-menu-header button {
      display: grid;
      place-items: center;
      width: 28px;
      min-height: 28px;
      padding: 0;
      color: var(--wp-muted, #526068);
    }

    #wupage-floating-menu .wupage-menu-header svg {
      width: 19px;
      height: 19px;
    }

    #wupage-floating-menu .wupage-field-label {
      display: block;
      margin: 0 0 6px;
      color: var(--wp-muted, #647379);
      font: 12px/1.4 system-ui, sans-serif;
      text-align: left;
    }

    #wupage-floating-menu .wupage-menu-field {
      all: initial;
      display: block;
      margin: 0;
      padding: 0;
      font: inherit;
    }

    #wupage-floating-menu .wupage-provider-select {
      all: initial;
      position: relative !important;
      inset: auto !important;
      display: block;
      width: 100%;
      height: 36px;
      margin: 0 !important;
      padding: 0 !important;
      font: inherit;
    }

    #wupage-floating-menu select[data-role="provider"][hidden] {
      display: none !important;
    }

    #wupage-floating-menu select[data-role="display-mode"] {
      all: initial;
      box-sizing: border-box;
      display: block;
      align-items: center;
      width: 100%;
      min-width: 0;
      min-height: 34px;
      padding: 0 32px 0 10px;
      border: 1px solid var(--wp-border, #c9d1cf);
      border-radius: 6px;
      color: var(--wp-foreground, #172026);
      background: var(--wp-surface, #ffffff);
      font: inherit;
      font-size: 12px;
      appearance: none;
      background-image: var(--wp-select-arrow);
      background-position: right 10px center;
      background-size: 10px 10px;
      background-repeat: no-repeat;
      cursor: pointer;
    }

    #wupage-floating-menu select[data-role="display-mode"]:focus-visible {
      outline: 2px solid var(--wp-accent, #116466);
      outline-offset: 2px;
    }

    #wupage-floating-menu .wupage-translation-feedback {
      padding: 0;
    }

    #wupage-floating-menu [data-role="translation-status"],
    #wupage-floating-menu .wupage-menu-hint {
      margin: 0;
      color: var(--wp-muted, #647379);
      font: 12px/1.6 system-ui, sans-serif;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    #wupage-floating-menu [data-role="translation-status"][data-tone="error"] {
      color: var(--wp-danger, #b13e36);
    }

    #wupage-floating-menu .wupage-menu-hint {
      padding: 2px 10px 4px;
    }

    @media (any-hover: none) and (any-pointer: coarse) {
      #wupage-floating-menu .wupage-menu-hint {
        display: none !important;
      }
    }

    #wupage-floating-menu .wupage-language-pair {
      all: initial;
      display: flex;
      align-items: center;
      width: 100%;
      min-width: 0;
      margin: 0;
      padding: 0;
      gap: 6px;
      box-sizing: border-box;
      direction: ltr;
      font: 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #wupage-floating-menu .wupage-language-select {
      all: initial;
      position: relative;
      display: grid;
      flex: 0 1 auto;
      box-sizing: border-box;
      float: none !important;
      width: auto !important;
      min-width: 0 !important;
      height: 40px !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0;
      color: inherit;
      font: inherit;
      text-align: left;
      transform: none !important;
    }

    #wupage-floating-menu .wupage-language-select select {
      all: initial;
      display: block;
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      min-width: 0 !important;
      max-width: none !important;
      height: 40px !important;
      box-sizing: border-box;
      margin: 0 !important;
      appearance: none !important;
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 0 24px 0 10px !important;
      color: transparent !important;
      background: var(--wp-soft, #eef2f1);
      font: 500 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      letter-spacing: normal !important;
      text-align: left !important;
      text-indent: 0 !important;
      text-transform: none !important;
      transform: none !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      box-shadow: none !important;
      text-shadow: none !important;
      vertical-align: middle !important;
      cursor: pointer;
    }

    #wupage-floating-menu .wupage-language-select select option {
      color: var(--wp-foreground, #26343a) !important;
      background: var(--wp-surface, #ffffff) !important;
      font: 500 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    }

    #wupage-floating-menu .wupage-language-value {
      all: initial;
      position: relative !important;
      z-index: 1;
      inset: auto !important;
      display: block !important;
      box-sizing: border-box;
      align-items: center !important;
      justify-content: flex-start !important;
      min-width: 0 !important;
      margin: 0 !important;
      padding: 0 21px 0 8px !important;
      overflow: hidden !important;
      color: var(--wp-foreground, #26343a);
      font: 500 13px/40px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      letter-spacing: normal !important;
      text-align: left !important;
      text-overflow: ellipsis !important;
      text-transform: none !important;
      text-shadow: none !important;
      white-space: nowrap !important;
      pointer-events: none;
      transform: none !important;
    }

    #wupage-floating-menu .wupage-language-select select:hover,
    #wupage-floating-menu .wupage-language-select select:focus-visible {
      border-color: var(--wp-border, #aebbb7);
      background: var(--wp-surface, #ffffff);
    }

    #wupage-floating-menu .wupage-language-chevron {
      all: initial;
      display: flex;
      position: absolute !important;
      z-index: 2;
      pointer-events: none;
      right: 7px !important;
      top: 50% !important;
      width: 10px !important;
      height: 10px !important;
      margin: 0 !important;
      padding: 0 !important;
      color: var(--wp-muted, #7d898e);
      transform: translateY(-50%) !important;
    }

    #wupage-floating-menu .wupage-language-chevron svg { width: 10px; height: 10px; }
    #wupage-floating-menu .wupage-language-direction svg { width: 14px; height: 14px; }
    #wupage-floating-menu .wupage-language-add-site svg { width: 12px; height: 12px; }

    #wupage-floating-menu .wupage-language-direction {
      all: initial;
      flex: 0 0 18px;
      position: static !important;
      width: 18px !important;
      height: 40px !important;
      display: grid !important;
      place-items: center !important;
      align-self: center !important;
      margin: 0 !important;
      padding: 0 !important;
      color: var(--wp-muted, #7a878b);
      font: 17px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      text-align: center !important;
      transform: none !important;
    }

    #wupage-floating-menu .wupage-language-direction svg {
      all: initial;
      display: block !important;
      width: 24px !important;
      height: 24px !important;
      margin: 0 !important;
      padding: 0 !important;
      color: inherit;
      overflow: visible;
    }

    #wupage-floating-menu .wupage-visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      clip-path: inset(50%);
    }

    #wupage-floating-menu .wupage-menu-divider {
      height: 1px;
      margin: 6px 4px;
      background: rgba(31, 42, 46, 0.1);
    }

    #wupage-floating-menu .wupage-feature-buttons {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin: 0;
    }

    #wupage-floating-menu .wupage-feature-button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      min-width: 0;
      min-height: 40px;
      padding: 0 8px;
      border: 2px dashed var(--wp-border, #c9d1cf);
      border-radius: 8px;
      background: var(--wp-surface, #ffffff);
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
    }

    #wupage-floating-menu .wupage-feature-button[aria-busy="true"] { opacity: 1; cursor: wait; }
    #wupage-floating-menu:lang(en) .wupage-feature-button { white-space: normal; }

    #wupage-floating-menu .wupage-feature-button[aria-pressed="true"] {
      color: var(--wp-accent, #116466);
      border: 1px solid var(--wp-accent, #116466);
      background: var(--wp-selected, #e4eeeb);
      box-shadow: inset 0 0 0 1px var(--wp-accent, #116466);
    }

    #wupage-floating-menu .wupage-feature-button:hover {
      border-color: var(--wp-accent, #116466);
      background: var(--wp-soft, #eef2f1);
    }

    #wupage-floating-menu .wupage-feature-button[aria-pressed="true"]:hover {
      background: var(--wp-selected, #e4eeeb);
    }

    #wupage-floating-menu .wupage-feature-button:focus-visible {
      outline: 2px solid var(--wp-accent, #116466);
      outline-offset: 2px;
    }

    #wupage-floating-menu .wupage-feature-indicator {
      position: relative;
      flex: 0 0 auto;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      visibility: hidden;
      pointer-events: none;
    }

    #wupage-floating-menu .wupage-feature-indicator::after {
      content: "";
      position: absolute;
      inset: -4px;
      box-sizing: border-box;
      border: 1px dashed currentColor;
      border-radius: 50%;
    }

    #wupage-floating-menu .wupage-feature-button[aria-pressed="true"] .wupage-feature-indicator {
      visibility: visible;
    }

    #wupage-floating-menu .wupage-language-auto { width: 38px; min-height: 36px; padding: 0 4px; font-size: 11px; }
    #wupage-floating-menu .wupage-language-automatic { display: flex; flex: 0 0 auto; align-items: center; margin-left: auto; gap: 6px; }
    #wupage-floating-menu .wupage-language-add-site { display: grid; place-items: center; width: 22px; min-height: 28px; padding: 0; border: 1px solid var(--wp-border, #c9d1cf); color: var(--wp-accent, #116466); background: var(--wp-soft, #eef2f1); font-size: 18px; line-height: 1; text-align: center; }
    #wupage-floating-menu .wupage-language-add-site:disabled:not([aria-busy="true"]) { cursor: default; }
    #wupage-floating-menu .image-feature-row { display: flex; align-items: center; gap: 2px; min-height: 40px; padding-right: 3px; border: 2px dashed var(--wp-border, #c9d1cf); border-radius: 8px; background: var(--wp-surface, #fff); }
    #wupage-floating-menu .image-feature-row:has([aria-pressed="true"]) { border: 1px solid var(--wp-accent, #116466); box-shadow: inset 0 0 0 1px var(--wp-accent, #116466); background: var(--wp-selected, #e4eeeb); }
    #wupage-floating-menu .image-feature-row .wupage-feature-button { flex: 1; align-self: stretch; min-height: 36px; padding: 0 3px; border: 0; background: transparent; box-shadow: none; }
    #wupage-floating-menu .image-feature-row .wupage-feature-indicator { display: none; }
    #wupage-floating-menu .image-feature[data-loading] .wupage-feature-button { visibility: hidden; }
    #wupage-floating-menu .ocr-help-slot, #wupage-floating-menu .ocr-help { display: flex; align-items: center; }
    #wupage-floating-menu .ocr-help-trigger { display: grid; place-items: center; width: 16px; min-height: 16px; height: 16px; padding: 0; border: 1px solid var(--wp-border, #c9d1cf); border-radius: 50%; font: 600 10px/1 system-ui; color: var(--wp-muted, #526068); cursor: help; }
    #wupage-floating-menu .ocr-model-action { display: grid; place-items: center; flex: 0 0 18px; width: 18px; min-height: 28px; padding: 1px; color: var(--wp-muted, #526068); }
    #wupage-floating-menu .ocr-model-action svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    #wupage-floating-menu .ocr-help-panel { position: fixed; z-index: 2147483647; width: 260px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow: auto; padding: 12px 14px; border: 1px solid var(--wp-border, #c9d1cf); border-radius: 10px; background: var(--wp-surface, #fff); box-shadow: 0 6px 24px #17203326; }
    #wupage-floating-menu .ocr-description, #wupage-floating-menu .ocr-model-status { margin: 5px 0 0; font: 12px/1.6 system-ui; color: var(--wp-muted, #526068); white-space: normal; overflow-wrap: anywhere; }
    #wupage-floating-menu .ocr-help-panel .ocr-description { margin-top: 0; }
    #wupage-floating-menu .ocr-model-status[data-state="error"] { color: var(--wp-danger, #b13e36); }
    #wupage-floating-ball[data-touch="true"] { width: 44px; height: 44px; }
    #wupage-floating-hitbox:has(#wupage-floating-ball[data-touch="true"]) { width: 76px !important; height: 76px !important; }
    #wupage-floating-ball[data-touch="true"][data-edge="left"]:not(.is-dragging) { transform: translateX(30px) !important; }
    #wupage-floating-ball[data-touch="true"][data-edge="right"]:not(.is-dragging) { transform: translateX(-30px) !important; }
    #wupage-floating-menu[data-touch="true"] { gap: 8px; padding: 12px; padding-bottom: max(12px, env(safe-area-inset-bottom)); border-radius: 16px; }
    #wupage-floating-menu[data-touch="true"] .wupage-menu-top { display: contents; }
    #wupage-floating-menu[data-touch="true"] .wupage-menu-header { order: 0; }
    #wupage-floating-menu[data-touch="true"] .wupage-translation-actions { order: 1; display: grid; grid-template-columns: 1fr; gap: 6px; }
    #wupage-floating-menu[data-touch="true"] button[data-action="page-toggle"] { min-height: 48px; font-size: 16px; }
    #wupage-floating-menu[data-touch="true"] .wupage-menu-section { order: 2; }
    #wupage-floating-menu[data-touch="true"] label.wupage-menu-field { order: 3; gap: 4px; }
    #wupage-floating-menu[data-touch="true"] .wupage-feature-buttons { order: 4; gap: 8px; }
    #wupage-floating-menu[data-touch="true"] label[data-touch-extra] { order: 5; }
    #wupage-floating-menu[data-touch="true"] .wupage-more-button { order: 6; display: flex; align-items: center; justify-content: center; gap: 8px; }
    #wupage-floating-menu .wupage-more-button svg { width: 14px; height: 14px; }
    #wupage-floating-menu[data-touch="true"] .wupage-translation-feedback { order: 7; }
    #wupage-floating-menu[data-touch="true"]:not([data-more-open]) [data-touch-extra] { display: none !important; }
    #wupage-floating-menu[data-touch="true"] button,
    #wupage-floating-menu[data-touch="true"] select { min-height: 44px; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    #wupage-floating-menu[data-touch="true"] .wupage-more-button { background: var(--wp-soft,#eef2f1); border: 1px solid var(--wp-border,#c9d1cf); border-radius: 8px; }
    #wupage-floating-menu[data-touch="true"] .wupage-provider-picker button { min-height: 44px !important; }
    #wupage-floating-menu[data-touch="true"] .wupage-menu-header button { width: 44px; }
    #wupage-floating-menu[data-touch="true"] .wupage-language-value { min-height: 44px; line-height: 44px; }
    #wupage-floating-menu[data-touch="true"] .wupage-language-auto { width: 44px; }
    #wupage-floating-menu[data-touch="true"] .wupage-language-add-site { width: 44px; }
    #wupage-floating-menu[data-touch="true"] .ocr-model-action { flex-basis: 44px; width: 44px; }
    #wupage-floating-menu[data-touch="true"] .ocr-help-trigger { width: 44px; height: 44px; border: 0; }
    #wupage-floating-menu[data-touch="true"] .image-feature-row { min-width: 0; }
    #wupage-floating-menu[data-touch="true"] .image-feature-row .wupage-feature-button { white-space: normal; }
    #wupage-floating-menu[data-touch="true"]:not([data-more-open]) .ocr-help-slot,
    #wupage-floating-menu[data-touch="true"]:not([data-more-open]) .ocr-model-action[data-state="installed"] { display: none; }
    #wupage-floating-menu[data-touch="true"][data-more-open] .image-feature { grid-column: 1 / -1; }
    #wupage-floating-menu .wupage-provider-notice { margin: 4px 0; padding: 8px; border: 1px solid var(--wp-border, #c7a557); border-radius: 8px; font: 12px/1.6 system-ui,sans-serif; }
    #wupage-floating-menu .wupage-local-notice { display: flex; align-items: center; gap: 8px; }
    #wupage-floating-menu .wupage-local-notice span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    #wupage-floating-menu .wupage-local-notice button { flex: none; width: auto; padding: 0 8px; color: var(--wp-accent,#116466); }
    #wupage-floating-menu .wupage-local-notice[data-state="missing"],
    #wupage-floating-menu .wupage-local-notice[data-state="error"] { border-color: var(--wp-danger,#b13e36); }
    #wupage-floating-menu[data-touch="true"] .wupage-provider-notice { order: 3; margin: 0; padding: 2px 8px; }
    #wupage-floating-menu .ocr-model-progress { display: block; width: 100%; height: 5px; margin: 6px 0; accent-color: var(--wp-accent, #116466); }

    [data-wupage-paragraph-active="true"] {
      outline: 1px dashed color-mix(in srgb, var(--wp-paragraph-highlight, #116466) 45%, transparent);
      outline-offset: 3px;
    }

    #wupage-paragraph-highlight {
      position: fixed;
      z-index: 2147483646;
      box-sizing: border-box;
      border: 1px dashed color-mix(in srgb, var(--wp-paragraph-highlight, #116466) 68%, transparent);
      border-radius: 4px;
      pointer-events: none;
      background: color-mix(in srgb, var(--wp-paragraph-highlight, #116466) 5%, transparent);
    }

    #wupage-paragraph-highlight[hidden] {
      display: none;
    }

    #wupage-debug-panel {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483647;
      width: min(360px, calc(100vw - 36px));
      height: min(420px, calc(100vh - 36px));
      min-width: min(280px, calc(100vw - 16px));
      min-height: min(200px, calc(100vh - 16px));
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
      box-sizing: border-box;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      border: 1px solid var(--wp-border, rgba(31, 42, 46, 0.14));
      border-radius: 8px;
      overflow: hidden;
      background: var(--wp-surface, #ffffff);
      box-shadow: 0 18px 44px rgba(15, 35, 38, 0.24);
      color: var(--wp-foreground, #172026);
      font: 12px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #wupage-debug-panel[hidden] {
      display: none;
    }

    #wupage-debug-panel header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 9px 10px;
      border-bottom: 1px solid var(--wp-border, rgba(31, 42, 46, 0.1));
      background: var(--wp-soft, #f7faf9);
      cursor: grab;
      user-select: none;
      touch-action: none;
    }

    #wupage-debug-panel.is-dragging header {
      cursor: grabbing;
    }

    #wupage-debug-panel header strong {
      font-size: 13px;
    }

    #wupage-debug-panel header button {
      width: 26px;
      height: 26px;
      border: 0;
      border-radius: 6px;
      color: var(--wp-muted, #405057);
      background: transparent;
      font: 18px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
    }

    #wupage-debug-panel header button:hover {
      background: var(--wp-selected, #e8f1ef);
    }

    #wupage-debug-panel .wupage-debug-summary {
      padding: 8px 10px;
      border-bottom: 1px solid var(--wp-border, rgba(31, 42, 46, 0.08));
      color: var(--wp-muted, #52636a);
    }

    #wupage-debug-panel .wupage-debug-list {
      min-height: 80px;
      overflow: auto;
      padding: 8px;
    }

    #wupage-debug-panel .wupage-debug-resize {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 22px;
      height: 22px;
      cursor: nwse-resize;
      touch-action: none;
    }

    #wupage-debug-panel .wupage-debug-resize::before,
    #wupage-debug-panel .wupage-debug-resize::after {
      content: "";
      position: absolute;
      right: 4px;
      bottom: 4px;
      border-right: 2px solid var(--wp-muted, #87959a);
      border-bottom: 2px solid var(--wp-muted, #87959a);
    }

    #wupage-debug-panel .wupage-debug-resize::before {
      width: 10px;
      height: 10px;
    }

    #wupage-debug-panel .wupage-debug-resize::after {
      width: 5px;
      height: 5px;
    }

    #wupage-debug-panel.is-resizing {
      user-select: none;
    }

    #wupage-debug-panel .wupage-debug-empty {
      padding: 18px 8px;
      color: var(--wp-muted, #7a8a91);
      text-align: center;
    }

    #wupage-debug-panel .wupage-debug-task {
      display: grid;
      gap: 4px;
      padding: 8px;
      border: 1px solid var(--wp-border, rgba(31, 42, 46, 0.1));
      border-left: 3px solid var(--wp-muted, #9aa8ad);
      border-radius: 7px;
      background: var(--wp-surface, #ffffff);
    }

    #wupage-debug-panel .wupage-debug-task + .wupage-debug-task {
      margin-top: 7px;
    }

    #wupage-debug-panel .wupage-debug-task[data-status="running"],
    #wupage-debug-panel .wupage-debug-task[data-status="waiting"] {
      border-left-color: var(--wp-accent, #116466);
      background: var(--wp-soft, #f4fbf9);
    }

    #wupage-debug-panel .wupage-debug-task[data-status="failed"] {
      border-left-color: var(--wp-danger, #b42318);
      background: var(--wp-danger-soft, #fff8f7);
    }

    #wupage-debug-panel .wupage-debug-task[data-status="succeeded"] {
      border-left-color: var(--wp-success, #25734c);
    }

    #wupage-debug-panel .wupage-debug-task[data-status="succeeded"] .wupage-debug-task-title span {
      color: var(--wp-success, #25734c);
    }

    #wupage-debug-panel .wupage-debug-task-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      cursor: pointer;
      list-style: none;
    }

    #wupage-debug-panel .wupage-debug-task-title::-webkit-details-marker {
      display: none;
    }

    #wupage-debug-panel .wupage-debug-task-title::marker { content: ""; }
    #wupage-debug-panel .wupage-debug-task-title::before {
      content: "";
      flex: 0 0 10px;
      width: 10px;
      height: 10px;
      background-color: currentColor;
      mask: var(--wp-disclosure-icon) center / contain no-repeat;
      transform: rotate(-90deg);
    }
    #wupage-debug-panel details[open] > .wupage-debug-task-title::before { transform: none; }

    #wupage-debug-panel .wupage-debug-task-title strong {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }

    #wupage-debug-panel .wupage-debug-task-title span {
      flex: 0 0 auto;
      color: var(--wp-accent, #0f5557);
      font-weight: 700;
    }

    #wupage-debug-panel .wupage-debug-task-meta {
      color: var(--wp-muted, #5f6f75);
    }

    #wupage-debug-panel .wupage-debug-task-error {
      max-height: 58px;
      overflow: auto;
      color: var(--wp-danger, #b42318);
      word-break: break-word;
    }

    #wupage-debug-panel .wupage-debug-task-detail {
      display: none;
      gap: 8px;
      margin-top: 6px;
      padding-top: 7px;
      border-top: 1px solid var(--wp-border, rgba(31, 42, 46, 0.08));
    }

    #wupage-debug-panel .wupage-debug-task[open] .wupage-debug-task-detail {
      display: grid;
    }

    #wupage-debug-panel .wupage-debug-text-block {
      display: grid;
      gap: 5px;
    }

    #wupage-debug-panel .wupage-debug-text-block h4 {
      margin: 0;
      color: var(--wp-muted, #405057);
      font-size: 12px;
      line-height: 1.3;
    }

    #wupage-debug-panel .wupage-debug-text-block p,
    #wupage-debug-panel .wupage-debug-text-block pre {
      margin: 0;
      padding: 6px;
      border-radius: 6px;
      background: rgba(31, 42, 46, 0.05);
      color: var(--wp-foreground, #172026);
      font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }

  `;
