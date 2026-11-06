export const SELECTION_TRANSLATION_STYLES = `
:host { color-scheme: var(--wp-color-scheme, light dark); --bg: var(--wp-selection-background, var(--wp-surface, #fff)); --fg: var(--wp-selection-foreground, var(--wp-foreground, #172b29)); --muted: color-mix(in srgb, var(--fg) 65%, var(--bg)); --line: color-mix(in srgb, var(--fg) 18%, var(--bg)); --soft: color-mix(in srgb, var(--accent) 8%, var(--bg)); --accent: var(--wp-selection-accent, var(--wp-accent, #116466)); }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, select, textarea, a { -webkit-tap-highlight-color: transparent; }
button, select, textarea { font: inherit; color: inherit; }
button, select { cursor: pointer; }
button:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.trigger-dot, .trigger-line { position: fixed; display: block; padding: 0; border: 0; background: transparent; pointer-events: auto; }
.trigger-dot { width: 28px; height: 28px; border-radius: 50%; }
.trigger-dot::after { content: ''; position: absolute; inset: 8px; border: 2px solid var(--bg); border-radius: 50%; background: var(--wp-selection-trigger, var(--accent)); box-shadow: 0 1px 5px #173d3766; }
.trigger-dot:hover::after, .trigger-dot:focus-visible::after { inset: 6px; }
.trigger-line { height: 12px; min-width: 4px; border-radius: 2px; }
.trigger-line::after { content: ''; position: absolute; left: 0; right: 0; top: 5px; height: 2px; background: var(--wp-selection-trigger, var(--accent)); border-radius: 2px; }
.trigger-line:hover::after, .trigger-line:focus-visible::after { height: 3px; }
.touch-triggers { position: fixed; display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg); color: var(--fg); box-shadow: 0 4px 20px #0003; font: 14px/1.4 system-ui,sans-serif; pointer-events: auto; }
.touch-triggers:empty { display: none; }
.selection-preview { flex: 1; min-width: 0; padding-left: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trigger-touch, .dismiss-trigger { flex: none; min-height: 44px; padding: 0 14px; border: 0; border-radius: 8px; color: var(--bg); background: var(--accent); touch-action: manipulation; user-select: none; -webkit-user-select: none; }
.dismiss-trigger { display: grid; place-items: center; width: 44px; padding: 0; color: var(--fg); background: var(--soft); }
.dismiss-trigger svg { width: 16px; height: 16px; }
.touch-card .close, .touch-card .speak { flex-basis: 44px; min-width: 44px; height: 44px; }
.touch-card select, .touch-card .submit-source, .touch-card .retry, .touch-card .replace-selection { min-height: 44px; }
.touch-card header { flex-wrap: wrap; gap: 6px; padding: 10px; }
.card.touch-card .word { font-size: 16px; flex-basis: 45%; }
.card { position: fixed; display: flex; flex-direction: column; width: min(360px, calc(100vw - 24px)); max-height: calc(100vh - 24px); margin: 0; padding: 0; overflow: hidden; pointer-events: auto; border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 8px 36px #162d2a26; background: var(--bg); color: var(--fg); text-align: left; direction: ltr; font: 14px/1.6 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; user-select: text; }
.card:focus { outline: none; }
header { display: flex; align-items: center; flex: 0 0 auto; gap: 10px; padding: 14px 14px 10px; }
.word { display: block; flex: 1; width: 0; min-width: 0; margin: -3px -5px; padding: 3px 5px; border: 1px solid transparent; border-radius: 6px; background: transparent; font-size: 21px; font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; overflow-y: auto; resize: none; outline: none; }
.word:hover { border-color: var(--line); background: var(--soft); }
.word:focus { border-color: var(--accent); background: var(--soft); }
.word[aria-invalid="true"] { border-color: #ad3737; }
.translation-mode .word { font-size: 13px; font-weight: 400; line-height: 1.5; color: var(--muted); }
.source-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 0 16px 12px; font-size: 12px; }
.source-actions [role="alert"] { flex: 1; min-width: 0; color: #ad3737; overflow-wrap: anywhere; }
.submit-source { flex: 0 0 auto; padding: 5px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); color: var(--accent); }
.submit-source:hover { background: var(--line); }
.result-actions { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: 10px; padding: 0 16px 12px; font-size: 12px; }
.result-actions [role="status"] { flex: 1; min-width: 0; color: var(--muted); overflow-wrap: anywhere; }
.replace-selection { flex: 0 0 auto; padding: 5px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); color: var(--accent); }
.replace-selection:hover { background: var(--line); }
.replace-selection:disabled { opacity: .55; cursor: default; }
.translation-service { flex: 0 1 auto; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 7px; border-radius: 6px; background: var(--soft); color: var(--muted); font-size: 12px; }
select { max-width: 110px; min-width: 0; padding: 5px 24px 5px 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); font-size: 12px; appearance: none; background-image: var(--wp-selection-select-arrow); background-position: right 7px center; background-size: 9px 9px; background-repeat: no-repeat; }
.close { flex: 0 0 26px; height: 26px; padding: 0; border: 0; border-radius: 5px; color: var(--muted); background: transparent; font-size: 22px; line-height: 1; }
.close svg, .speak svg { width: 14px; height: 14px; }
.close:hover { background: var(--soft); }
.body { min-width: 0; min-height: 44px; padding: 0 16px 14px; overflow: auto; overflow-wrap: anywhere; overscroll-behavior: contain; }
.selection-translation { margin: 0; font-size: 14px; line-height: 1.7; white-space: pre-wrap; }
.body[aria-busy] { color: var(--muted); }
.phonetics { display: flex; flex-wrap: wrap; gap: 3px 16px; margin-bottom: 12px; color: var(--muted); font-size: 13px; }
.phonetics > div { display: flex; align-items: center; gap: 5px; }
.speak { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 5px; color: var(--accent); background: var(--soft); font-size: 11px; }
.speak:hover { background: var(--line); }
.speak:disabled { opacity: .5; cursor: wait; }
.meanings { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
.meanings li { display: flex; align-items: baseline; gap: 10px; overflow-wrap: anywhere; }
.part-of-speech { flex: 0 0 auto; min-width: 24px; color: var(--muted); font-style: italic; }
.part-of-speech:empty { display: none; }
.meaning-pronunciation { margin-right: 7px; color: var(--muted); font-size: 12px; }
.notice { margin: 6px 0; color: var(--muted); }
.retry { margin-top: 6px; padding: 5px 12px; border: 1px solid var(--line); border-radius: 5px; background: var(--soft); }
footer { display: flex; flex: 0 0 auto; justify-content: space-between; align-items: center; gap: 10px; min-height: 36px; padding: 7px 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
footer span { min-width: 0; }
footer a { flex-shrink: 0; margin-left: auto; color: var(--accent); text-decoration: none; }
footer a:hover { text-decoration: underline; }
@media (prefers-color-scheme: dark) {
  :host { --bg: var(--wp-selection-background, var(--wp-surface, #202a28)); --fg: var(--wp-selection-foreground, var(--wp-foreground, #e6eeea)); --accent: var(--wp-selection-accent, var(--wp-accent, #83d2c5)); }
}
`;
