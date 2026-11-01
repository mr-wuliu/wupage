import type { VideoPlatform } from "./platforms";

export interface PlayerControlDock { container: HTMLElement; before?: Element; reference?: Element; }
interface ControlRule { selector: string; before?: string; }

// Site rules use the native button row, never a progress slider or popup menu.
// CSS-module hashes are intentionally excluded from the Vimeo / Udemy hooks.
const SITE_CONTROLS: Record<string, ControlRule[]> = {
  youtube: [{ selector: ".ytp-right-controls", before: ".ytp-subtitles-button" }],
  bilibili: [
    { selector: ".bpx-player-control-bottom-right", before: ".bpx-player-ctrl-subtitle,.bpx-player-ctrl-setting" },
    { selector: ".bilibili-player-video-control-bottom-right", before: ".bilibili-player-video-btn-subtitle" }
  ],
  vimeo: [
    { selector: '[class*="ControlBarButtonsAndMenus_module_collapsibleContent"]', before: ".cc,.vp-prefs" },
    { selector: ".vp-controls .vp-controls-buttons", before: ".cc,.vp-prefs" }
  ],
  udemy: [
    { selector: '[class*="_control-bar_"]', before: '[class*="_control-captions_"],[class*="_control-settings_"]' },
    { selector: '[class*="video-control-bar--control-bar"]', before: '[data-purpose="captions-dropdown"],[data-purpose="settings-button"]' }
  ]
};

const COMMON_CONTROLS: ControlRule[] = [
  { selector: ".vjs-control-bar", before: ".vjs-subs-caps-button,.vjs-fullscreen-control" },
  { selector: ".plyr__controls", before: '[data-plyr="captions"],[data-plyr="settings"],[data-plyr="fullscreen"]' },
  { selector: ".jw-controlbar .jw-button-container", before: ".jw-icon-cc,.jw-icon-settings,.jw-icon-fullscreen" },
  { selector: ".dplayer-icons-right", before: ".dplayer-subtitle-btn,.dplayer-setting,.dplayer-full" },
  { selector: ".art-controls-right", before: ".art-control-subtitle,.art-control-setting,.art-control-fullscreen" },
  { selector: ".xgplayer-controls .xg-right-grid", before: "xg-icon.xgplayer-subtitle,xg-icon.xgplayer-fullscreen" },
  { selector: ".shaka-controls-button-panel", before: ".shaka-caption-button,.shaka-overflow-menu-button,.shaka-fullscreen-button" },
  { selector: 'media-control-bar', before: "media-captions-button,media-settings-menu-button,media-fullscreen-button" }
];
const PLAYER_SCOPE = ".html5-video-player,.bpx-player-container,.bilibili-player-video-wrap,.video-js,.plyr,.jwplayer,.dplayer,.art-video-player,.xgplayer,.shaka-video-container,media-controller";

export function playerContains(element: Element, descendant: Node): boolean {
  let node: Node = descendant;
  while (!element.contains(node)) {
    const root = node.getRootNode();
    if (!(root instanceof ShadowRoot)) return false;
    node = root.host;
  }
  return true;
}

export function playerControlDock(video: HTMLVideoElement, container: HTMLElement, platform?: VideoPlatform, observe?: (root: ShadowRoot) => void): PlayerControlDock | undefined {
  // Some players keep their controls beside the video's open shadow root.
  const roots: Array<HTMLElement | ShadowRoot> = [container];
  if (container.shadowRoot) { roots.push(container.shadowRoot); observe?.(container.shadowRoot); }
  const rules = [...(SITE_CONTROLS[platform?.id ?? ""] ?? []), ...COMMON_CONTROLS];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    for (const rule of rules) for (const candidate of root.querySelectorAll<HTMLElement>(rule.selector)) {
      if (candidate.closest('[id^="wupage-"],[role="menu"]')) continue;
      const scope = candidate.closest(PLAYER_SCOPE);
      if (scope && !playerContains(scope, video)) continue;
      const anchors = rule.before ? [...candidate.querySelectorAll<HTMLElement>(rule.before)] : [];
      const anchor = anchors.find(element => element.offsetHeight > 0) ?? anchors[0];
      let before = anchor ?? undefined;
      while (before?.parentElement && before.parentElement !== candidate) before = before.parentElement;
      let reference = anchor?.matches('button,[role="button"]') ? anchor
        : anchor?.querySelector('button,[role="button"]') ?? anchor ?? candidate.querySelector('button,[role="button"]') ?? undefined;
      if (reference instanceof HTMLElement && !reference.offsetHeight) {
        reference = [...candidate.querySelectorAll<HTMLElement>('button,[role="button"]')].find(element => element.offsetHeight > 0) ?? reference;
      }
      return { container: candidate, before, reference };
    }
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot && !element.id.startsWith("wupage-")) { roots.push(element.shadowRoot); observe?.(element.shadowRoot); }
    }
  }
  return undefined;
}

/** Opacity alone does not remove invisible controls from hit testing. */
export function playerControlsVisible(container: HTMLElement): boolean {
  let element: Element | null = container;
  while (element) {
    const style = getComputedStyle(element);
    if (element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true"
      || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
    const root: Node = element.getRootNode();
    element = element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return true;
}
