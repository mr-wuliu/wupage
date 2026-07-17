const STYLE_ID = "wupage-translation-style";

export function injectContentStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .wupage-translation {
      box-sizing: border-box;
      max-width: 100%;
      overflow-wrap: break-word;
      word-break: break-word;
      pointer-events: none;
    }

    .wupage-translation[data-wupage-mode="block"] {
      display: block;
      margin: 0.18em 0 0.38em;
      color: #0f766e;
      font-size: 0.95em;
      line-height: 1.55;
    }

    .wupage-translation[data-wupage-mode="block"][data-wupage-container="heading"] {
      margin: 0.2em 0 0;
      font-size: 1rem;
      font-weight: 400;
      line-height: 1.45;
    }

    .wupage-translation[data-wupage-mode="inline"] {
      display: inline;
      margin-left: 0.35em;
      color: #0f766e;
      font-size: 0.92em;
      line-height: inherit;
    }

    .wupage-translation[data-wupage-mode="code-comment"] {
      display: block;
      margin: 0;
      color: #0f766e;
      font: inherit;
      line-height: inherit;
      white-space: pre-wrap;
    }

    .wupage-translation-pending {
      min-width: 1.25em;
      min-height: 1.25em;
    }

    .wupage-translation-pending > span {
      display: inline-block;
      width: 0.9em;
      height: 0.9em;
      box-sizing: border-box;
      border: 2px solid rgba(15, 118, 110, 0.22);
      border-top-color: #0f766e;
      border-radius: 999px;
      vertical-align: -0.12em;
      animation: wupage-spin 780ms linear infinite;
    }

    .wupage-translation-pending[data-wupage-mode="block"] > span,
    .wupage-translation-pending[data-wupage-mode="code-comment"] > span {
      margin: 0.2em 0;
    }

    @keyframes wupage-spin {
      to {
        transform: rotate(360deg);
      }
    }

    #wupage-floating-hitbox {
      position: fixed;
      right: 22px;
      bottom: 88px;
      z-index: 2147483647;
      width: 74px;
      height: 74px;
      display: grid;
      place-items: center;
      pointer-events: auto;
    }

    #wupage-floating-ball {
      position: relative;
      width: 42px;
      height: 42px;
      border: 0;
      border-radius: 999px;
      display: grid;
      place-items: center;
      color: #ffffff;
      background: #116466;
      box-shadow: 0 8px 24px rgba(15, 35, 38, 0.22);
      font: 700 16px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
      user-select: none;
      touch-action: none;
      transition: transform 160ms ease, background 160ms ease, opacity 160ms ease;
    }

    #wupage-floating-ball:hover {
      background: #0f5557;
    }

    #wupage-floating-ball.is-loading {
      opacity: 0.68;
      cursor: wait;
    }

    #wupage-floating-ball.is-dragging {
      transition: none;
      cursor: grabbing;
      opacity: 0.92;
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
      position: fixed;
      z-index: 2147483647;
      width: 220px;
      padding: 6px;
      border: 1px solid rgba(31, 42, 46, 0.12);
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 12px 30px rgba(15, 35, 38, 0.2);
      font: 13px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #wupage-floating-menu[hidden] {
      display: none;
    }

    #wupage-floating-menu button {
      display: block;
      width: 100%;
      min-height: 32px;
      border: 0;
      border-radius: 6px;
      padding: 0 10px;
      color: #172026;
      background: transparent;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }

    #wupage-floating-menu button:hover {
      background: #e8f1ef;
    }

    #wupage-floating-menu button[aria-pressed="true"] {
      color: #0f5557;
      background: #d9efea;
      font-weight: 700;
    }

    #wupage-floating-menu .wupage-menu-section {
      padding: 4px;
    }

    #wupage-floating-menu .wupage-menu-field {
      display: grid;
      gap: 6px;
      color: #5f6f75;
      font-size: 12px;
      line-height: 1.2;
    }

    #wupage-floating-menu select {
      width: 100%;
      height: 32px;
      box-sizing: border-box;
      border: 1px solid rgba(31, 42, 46, 0.18);
      border-radius: 6px;
      padding: 0 28px 0 9px;
      color: #172026;
      background: #ffffff;
      font: 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
    }

    #wupage-floating-menu .wupage-menu-divider {
      height: 1px;
      margin: 6px 4px;
      background: rgba(31, 42, 46, 0.1);
    }

    #wupage-floating-menu .wupage-switch-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    #wupage-floating-menu .wupage-switch {
      position: relative;
      flex: 0 0 auto;
      width: 32px;
      height: 24px;
      border-radius: 8px;
      background: #d5dde0;
      transition: background 160ms ease;
    }

    #wupage-floating-menu .wupage-switch span {
      position: absolute;
      left: 3px;
      top: 3px;
      width: 18px;
      height: 18px;
      border-radius: 6px;
      background: #ffffff;
      box-shadow: 0 1px 3px rgba(15, 35, 38, 0.24);
      transition: transform 160ms ease;
    }

    #wupage-floating-menu .wupage-switch-row[aria-pressed="true"] .wupage-switch {
      background: #116466;
    }

    #wupage-floating-menu .wupage-switch-row[aria-pressed="true"] .wupage-switch span {
      transform: translateX(8px);
    }

    .wupage-paragraph-active {
      outline: 1px dashed rgba(17, 100, 102, 0.45);
      outline-offset: 3px;
    }

    #wupage-paragraph-highlight {
      position: fixed;
      z-index: 2147483646;
      box-sizing: border-box;
      border: 1px dashed rgba(17, 100, 102, 0.68);
      border-radius: 4px;
      pointer-events: none;
      background: rgba(17, 100, 102, 0.035);
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
      max-height: min(520px, calc(100vh - 36px));
      box-sizing: border-box;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      border: 1px solid rgba(31, 42, 46, 0.14);
      border-radius: 8px;
      overflow: hidden;
      background: #ffffff;
      box-shadow: 0 18px 44px rgba(15, 35, 38, 0.24);
      color: #172026;
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
      border-bottom: 1px solid rgba(31, 42, 46, 0.1);
      background: #f7faf9;
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
      color: #405057;
      background: transparent;
      font: 18px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
    }

    #wupage-debug-panel header button:hover {
      background: #e8f1ef;
    }

    #wupage-debug-panel .wupage-debug-summary {
      padding: 8px 10px;
      border-bottom: 1px solid rgba(31, 42, 46, 0.08);
      color: #52636a;
    }

    #wupage-debug-panel .wupage-debug-list {
      min-height: 80px;
      overflow: auto;
      padding: 8px;
    }

    #wupage-debug-panel .wupage-debug-empty {
      padding: 18px 8px;
      color: #7a8a91;
      text-align: center;
    }

    #wupage-debug-panel .wupage-debug-task {
      display: grid;
      gap: 4px;
      padding: 8px;
      border: 1px solid rgba(31, 42, 46, 0.1);
      border-left: 3px solid #9aa8ad;
      border-radius: 7px;
      background: #ffffff;
    }

    #wupage-debug-panel .wupage-debug-task + .wupage-debug-task {
      margin-top: 7px;
    }

    #wupage-debug-panel .wupage-debug-task[data-status="running"],
    #wupage-debug-panel .wupage-debug-task[data-status="waiting"] {
      border-left-color: #116466;
      background: #f4fbf9;
    }

    #wupage-debug-panel .wupage-debug-task[data-status="failed"] {
      border-left-color: #b42318;
      background: #fff8f7;
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

    #wupage-debug-panel .wupage-debug-task-title strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }

    #wupage-debug-panel .wupage-debug-task-title span {
      flex: 0 0 auto;
      color: #0f5557;
      font-weight: 700;
    }

    #wupage-debug-panel .wupage-debug-task-meta {
      color: #5f6f75;
    }

    #wupage-debug-panel .wupage-debug-task-error {
      max-height: 58px;
      overflow: auto;
      color: #b42318;
      word-break: break-word;
    }

    #wupage-debug-panel .wupage-debug-task-detail {
      display: none;
      gap: 8px;
      margin-top: 6px;
      padding-top: 7px;
      border-top: 1px solid rgba(31, 42, 46, 0.08);
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
      color: #405057;
      font-size: 12px;
      line-height: 1.3;
    }

    #wupage-debug-panel .wupage-debug-text-block p,
    #wupage-debug-panel .wupage-debug-text-block pre {
      margin: 0;
      padding: 6px;
      border-radius: 6px;
      background: rgba(31, 42, 46, 0.05);
      color: #172026;
      font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }

  `;
  document.documentElement.append(style);
}
