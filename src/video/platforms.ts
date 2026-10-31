export interface VideoPlatform {
  id: string;
  label: string;
  hosts: string[];
  player: string;
  captions: string;
  lines?: string;
  toggle?: string;
  bridge?: boolean;
}

/** Site selectors are deliberately separate from scheduling and subtitle rendering. */
export const YOUTUBE_PLAYER_SELECTOR = "#movie_player,.html5-video-player,#player-container-id,#player";
export const VIDEO_PLATFORMS: VideoPlatform[] = [
  { id: "youtube", label: "YouTube", hosts: ["youtube.com", "youtube-nocookie.com"], player: YOUTUBE_PLAYER_SELECTOR,
    captions: ".ytp-caption-window-container", lines: ".caption-visual-line", toggle: ".ytp-subtitles-button", bridge: true },
  { id: "bilibili", label: "哔哩哔哩", hosts: ["bilibili.com"], player: ".bpx-player-container,.bilibili-player-video-wrap",
    captions: ".bili-subtitle-x-subtitle-panel-major-group,.bpx-player-subtitle-panel,.bilibili-player-video-subtitle",
    toggle: ".bpx-player-ctrl-subtitle", bridge: true },
  { id: "netflix", label: "Netflix", hosts: ["netflix.com"], player: ".watch-video,.watch-video--player-view,.VideoContainer",
    captions: ".player-timedtext", lines: ".player-timedtext-text-container" },
  { id: "vimeo", label: "Vimeo", hosts: ["vimeo.com", "vhx.tv"], player: ".player,.vp-video-wrapper",
    captions: ".vp-captions,[class*='CaptionsRenderer_module_captionsWindow']",
    lines: "[class*='CaptionsRenderer_module_captionsLine']" },
  { id: "disney", label: "Disney+", hosts: ["disneyplus.com"], player: "disney-web-player,.btm-media-overlays-container",
    captions: ".dss-subtitle-renderer-cue,.hive-subtitle-renderer-cue" },
  { id: "prime", label: "Prime Video", hosts: ["primevideo.com", "amazon.com", "amazon.co.jp", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.it", "amazon.es", "amazon.in", "amazon.ca", "amazon.com.au", "amazon.com.br"],
    player: ".atvwebplayersdk-player-container,.webPlayerUIContainer", captions: ".atvwebplayersdk-captions-text", lines: ".atvwebplayersdk-captions-text span" },
  { id: "ted", label: "TED", hosts: ["ted.com"], player: ".video-js,[data-testid='video-player']", captions: "#subtitles-container,.vjs-text-track-display", lines: ".whitespace-pre-line,.vjs-text-track-cue" },
  { id: "coursera", label: "Coursera", hosts: ["coursera.org"], player: ".rc-VideoPlayer,.video-js", captions: ".rc-CaptionsRenderer,.vjs-text-track-display", lines: ".vjs-text-track-cue" },
  { id: "udemy", label: "Udemy", hosts: ["udemy.com"], player: ".video-player--container,.video-js,[data-purpose='video-player'],[data-purpose='media-player-container']",
    captions: "[class*='captions-display--captions-container'],[class*='_caption-container_'],.vjs-text-track-display",
    lines: "[class*='captions-display--captions-cue-text'],[class*='_cue-text_'],.vjs-text-track-cue" }
];

export function videoPlatform(hostname = location.hostname): VideoPlatform | undefined {
  return VIDEO_PLATFORMS.find(platform => platform.hosts.some(host => hostname === host || hostname.endsWith(`.${host}`)));
}

export function mediaKey(url = location.href): string {
  const parsed = new URL(url);
  if (/(^|\.)youtube(?:-nocookie)?\.com$/u.test(parsed.hostname)) {
    return `youtube:${parsed.searchParams.get("v") || parsed.pathname.replace(/^\/(?:embed|shorts)\//u, "")}`;
  }
  if (/(^|\.)bilibili\.com$/u.test(parsed.hostname)) return `bilibili:${parsed.pathname}:${parsed.searchParams.get("p") || "1"}`;
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

export function queryVideoRoots(root: Document | ShadowRoot = document, observe?: (root: Document | ShadowRoot) => void): HTMLVideoElement[] {
  observe?.(root);
  const videos = [...root.querySelectorAll("video")];
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot && !element.id.startsWith("wupage-")) videos.push(...queryVideoRoots(element.shadowRoot, observe));
  }
  return videos;
}

export function playerContainer(video: HTMLVideoElement, platform = videoPlatform()): HTMLElement {
  const selected = (platform?.id === "youtube" && video.closest<HTMLElement>("#player-container-id"))
    || (platform && video.closest<HTMLElement>(platform.player));
  if (selected && selected !== video) {
    let accessible: HTMLElement | undefined = selected;
    while (accessible?.closest('[aria-hidden="true"]')) {
      accessible = accessible.parentElement?.closest<HTMLElement>(platform!.player) ?? undefined;
    }
    return accessible ?? selected;
  }
  let parent = video.parentElement;
  const rect = video.getBoundingClientRect();
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const bounds = parent.getBoundingClientRect();
    if (bounds.width >= rect.width * .9 && bounds.height >= rect.height * .8 && getComputedStyle(parent).position !== "static") return parent;
    parent = parent.parentElement;
  }
  return video.parentElement ?? document.body;
}

export function captionElements(container: HTMLElement, platform?: VideoPlatform): HTMLElement[] {
  const scope = container.getRootNode() as Document | ShadowRoot;
  const selector = platform?.captions ?? ".vjs-text-track-display,.plyr__captions,.jw-captions";
  let elements = [...container.querySelectorAll<HTMLElement>(selector)];
  if (!elements.length && scope !== document) elements = [...scope.querySelectorAll<HTMLElement>(selector)];
  return elements.filter(element => !element.closest("[data-wupage-video]"));
}

/** TED renders the selected translation itself without changing TextTrack.mode. */
export function selectedNativeTrack(container: HTMLElement, platform: VideoPlatform | undefined, tracks: TextTrack[]): TextTrack | undefined {
  if (platform?.id !== "ted") return undefined;
  const scope = container.getRootNode() as Document | ShadowRoot;
  const selected = scope.querySelector('[role="tooltip"] [role="radio"][aria-checked="true"]');
  const label = Array.from(selected?.querySelectorAll("span") ?? []).at(-1)?.textContent?.trim();
  const fromMenu = tracks.find(track => track.label === label);
  if (fromMenu) return fromMenu;
  const credits = container.querySelector("#subtitles-container > div:first-child")?.textContent
    ?.replace(/\s+/gu, " ").trim().toLowerCase();
  return credits ? tracks.find(track => track.label && ["translation", "transcript"].some(kind =>
    credits.startsWith(`${track.label.toLowerCase()} ${kind} by `))) : undefined;
}

/** Read rendered source text even while WuPage makes its native layer transparent. */
export function renderedCaption(container: HTMLElement, platform?: VideoPlatform): string {
  const texts: string[] = [];
  for (const element of captionElements(container, platform)) {
    if (getComputedStyle(element).display === "none" || element.hidden || !element.getClientRects().length) continue;
    const lines = platform?.lines ? [...element.querySelectorAll<HTMLElement>(platform.lines)] : [];
    const value = (lines.length ? lines.map(line => line.textContent ?? "").join("\n") : element.textContent ?? "")
      .replace(/[\t ]+/gu, " ").replace(/\n\s*\n/gu, "\n").trim();
    if (value && value.length <= 4000 && !texts.includes(value)) texts.push(value);
  }
  return texts.join("\n").slice(0, 4000);
}
