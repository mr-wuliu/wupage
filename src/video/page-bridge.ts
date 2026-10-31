// Runs in the page's MAIN world. No extension APIs, settings or provider credentials.
import { bilibiliCues, VIDEO_BRIDGE_CHANNEL, youtubeCues, type PageSubtitleTrack } from "./site-cues";
import { mediaKey, YOUTUBE_PLAYER_SELECTOR } from "./platforms";
import { bilibiliProtoTracks } from "./bilibili-proto";
import { bilibiliSubtitleUrl } from "./bilibili-url";

interface RemoteTrack extends PageSubtitleTrack { url: string }
interface YouTubePlayerResponse {
  videoDetails?: { videoId?: string }; captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Array<{
    baseUrl?: string; languageCode?: string; vssId?: string; kind?: string; name?: { simpleText?: string; runs?: Array<{ text?: string }> }
  }> } };
}
interface YouTubePlayer extends Element {
  getPlayerResponse?(): YouTubePlayerResponse | undefined;
  getOption?(module: string, name: string): { vss_id?: string; languageCode?: string } | undefined;
}

const host = location.hostname;
const youtube = /(^|\.)youtube(?:-nocookie)?\.com$/u.test(host);
const bilibili = /(^|\.)bilibili\.com$/u.test(host);
const resources: Array<{ url: string; key: string }> = [];
const seenResources = new Set<string>();
let catalogue: RemoteTrack[] = [];
let catalogueKey = "";

function permitted(value: string, kind: "captions" | "metadata"): URL | undefined {
  try {
    const url = new URL(value, location.href);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return;
    if (youtube && /(^|\.)youtube\.com$/u.test(url.hostname) && url.pathname === "/api/timedtext" && kind === "captions") return url;
    if (bilibili && kind === "metadata" && url.hostname === "api.bilibili.com"
      && (/^\/x\/player\/(?:wbi\/)?v2$/u.test(url.pathname) || url.pathname === "/x/v2/subtitle/web/view")) return url;
    if (bilibili && kind === "captions" && /(^|\.)(?:hdslb\.com|bilibili\.com)$/u.test(url.hostname)
      && (/^\/bfs\/(?:ai_)?subtitle\//u.test(url.pathname) || url.hostname === "subtitle.bilibili.com")) return url;
  } catch { /* Never fetch a page-supplied arbitrary URL. */ }
}

function observe(entries: PerformanceEntry[]): void {
  for (const entry of entries) {
    if (!permitted(entry.name, "captions") && !permitted(entry.name, "metadata")) continue;
    const identity = `${entry.startTime}:${entry.name}`;
    if (seenResources.has(identity)) continue;
    seenResources.add(identity);
    if (seenResources.size > 1000) seenResources.delete(seenResources.values().next().value!);
    resources.push({ url: entry.name, key: mediaKey() });
    if (resources.length > 40) resources.shift();
  }
}

async function readJson(value: string, kind: "captions" | "metadata"): Promise<unknown> {
  const url = permitted(value, kind);
  if (!url) throw new Error("字幕地址不属于当前播放器。");
  // Signed Bilibili caption files allow wildcard CORS, which rejects credentialed fetches.
  const credentials = bilibili && kind === "captions" ? "omit" : "include";
  const response = await fetch(url, { credentials, redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("播放器未能返回字幕，请打开原生字幕后重试。");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("播放器没有返回字幕内容。");
  const decoder = new TextDecoder(); let text = ""; let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error("字幕数据过大。");
      chunks.push(part.value);
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); }
  if (!text.trim()) throw new Error("字幕需要播放器授权，请先开启原生字幕。");
  if (bilibili && kind === "metadata" && url.pathname === "/x/v2/subtitle/web/view" && !/^\s*[{[]/u.test(text)) {
    const buffer = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return { data: { subtitle: { subtitles: bilibiliProtoTracks(buffer) } } };
  }
  return JSON.parse(text);
}

async function readCatalogue(): Promise<{ key: string; tracks: PageSubtitleTrack[]; selected?: string }> {
  const key = mediaKey();
  let selected: string | undefined;
  const next: RemoteTrack[] = [];
  if (youtube) {
    const currentId = new URL(location.href).searchParams.get("v") || location.pathname.split("/").at(-1);
    const players = [...document.querySelectorAll<YouTubePlayer>(YOUTUBE_PLAYER_SELECTOR)];
    let player: YouTubePlayer | undefined;
    let response: YouTubePlayerResponse | undefined;
    for (const candidate of players) {
      try {
        const value = candidate.getPlayerResponse?.();
        if (value?.captions && (!value.videoDetails?.videoId || value.videoDetails.videoId === currentId)) {
          player = candidate; response = value; break;
        }
      } catch { /* A replaced player may still be present during mobile navigation. */ }
    }
    // Mobile YouTube may expose metadata only through the page's initial response.
    // Check the video ID on every read: that response can outlive SPA navigation.
    const initial = (window as Window & { ytInitialPlayerResponse?: YouTubePlayerResponse }).ytInitialPlayerResponse;
    if (!response && initial?.videoDetails?.videoId === currentId) response = initial;
    player ??= players.find(candidate => typeof candidate.getOption === "function");
    const current = player?.getOption?.("captions", "track");
    for (const [index, track] of (response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).slice(0, 200).entries()) {
      const url = track.baseUrl && permitted(track.baseUrl, "captions");
      if (!url) continue;
      const id = track.vssId || `${track.languageCode}-${index}`;
      next.push({ id, language: (track.languageCode ?? "auto").slice(0, 32), automatic: track.kind === "asr", url: url.href,
        label: (track.name?.simpleText || track.name?.runs?.map(run => run.text ?? "").join("") || track.languageCode || "字幕").slice(0, 200) });
      if (current?.vss_id === track.vssId || (!selected && current?.languageCode === track.languageCode)) selected = id;
    }
    observe(performance.getEntriesByType("resource"));
    if (!next.length) {
      // A mobile player can withhold its JS API. Reuse only subtitle requests it
      // already made for this video, without calling an additional player API.
      for (const entry of [...resources].reverse()) {
        const url = permitted(entry.url, "captions");
        const language = url?.searchParams.get("lang");
        if (entry.key !== key || !url || url.searchParams.get("v") !== currentId || !language || url.searchParams.has("tlang")) continue;
        const id = `observed:${language}:${url.searchParams.get("kind") || ""}:${url.searchParams.get("name") || ""}`.slice(0, 128);
        if (next.some(track => track.id === id)) continue;
        next.push({ id, language: language.slice(0, 32), label: language.slice(0, 200), automatic: url.searchParams.get("kind") === "asr", url: url.href });
      }
      selected = next.find(track => track.language === current?.languageCode)?.id || next[0]?.id;
    }
  } else if (bilibili) {
    observe(performance.getEntriesByType("resource"));
    const urls = resources.filter(entry => entry.key === key && permitted(entry.url, "metadata")).reverse().slice(0, 2);
    for (const entry of urls) {
      try {
        const payload = await readJson(entry.url, "metadata") as { data?: { subtitle?: { subtitles?: Array<{ id_str?: string; id?: number; lan?: string; lan_doc?: string; subtitle_url?: string }> } } };
        for (const [index, track] of (payload.data?.subtitle?.subtitles ?? []).slice(0, 200).entries()) {
          const url = track.subtitle_url && bilibiliSubtitleUrl(track.subtitle_url);
          if (!url || !permitted(url, "captions")) continue;
          next.push({ id: String(track.id_str || track.id || index), label: String(track.lan_doc || track.lan || "字幕").slice(0, 200),
            language: String(track.lan || "auto").replace(/^ai-/u, "").slice(0, 32), url: new URL(url, location.href).href });
        }
        if (next.length) break;
      } catch { /* The rendered-caption adapter remains available without metadata access. */ }
    }
    const language = document.querySelector('.bpx-player-ctrl-subtitle-major .bpx-state-active[data-lan]')?.getAttribute('data-lan');
    if (language) selected = next.find(track => track.language === language.replace(/^ai-/u, ''))?.id;
  }
  if (mediaKey() !== key) throw new Error("视频已切换。");
  catalogue = next; catalogueKey = key;
  return { key, tracks: next.map(({ url: _url, ...track }) => track), selected };
}

async function load(id: string): Promise<unknown> {
  const key = mediaKey();
  if (catalogueKey !== key) await readCatalogue();
  const track = catalogue.find(item => item.id === id);
  if (!track) throw new Error("字幕轨已变化，请重新选择。");
  let url = new URL(track.url);
  if (youtube) {
    observe(performance.getEntriesByType("resource"));
    const observed = [...resources].reverse().find(entry => {
      const candidate = permitted(entry.url, "captions");
      return entry.key === key && candidate && ["v", "lang", "kind", "name", "tlang"].every(name =>
        (candidate.searchParams.get(name) || "") === (url.searchParams.get(name) || ""));
    });
    if (observed) {
      // Reuse the complete player request instead of mixing tokens and client contexts.
      url = new URL(observed.url);
    }
    url.searchParams.set("fmt", "json3");
  }
  const payload = await readJson(url.href, "captions");
  if (key !== mediaKey()) throw new Error("视频已切换。");
  return { key, cues: youtube ? youtubeCues(payload) : bilibiliCues(payload) };
}

if (youtube || bilibili) {
  observe(performance.getEntriesByType("resource"));
  try { new PerformanceObserver(list => observe(list.getEntries())).observe({ type: "resource", buffered: true }); } catch { /* Resource timing is optional. */ }
  window.addEventListener("message", event => {
    const request = event.data;
    if (event.source !== window || event.origin !== location.origin || request?.channel !== VIDEO_BRIDGE_CHANNEL
      || request.direction !== "request" || typeof request.id !== "string" || !/^wp-[\w-]{1,60}$/u.test(request.id)
      || !["catalogue", "load"].includes(request.action) || (request.action === "load" && (typeof request.track !== "string" || request.track.length > 128))) return;
    void (request.action === "catalogue" ? readCatalogue() : load(request.track)).then(data => {
      window.postMessage({ channel: VIDEO_BRIDGE_CHANNEL, direction: "response", id: request.id, data }, location.origin);
    }).catch(error => {
      window.postMessage({ channel: VIDEO_BRIDGE_CHANNEL, direction: "response", id: request.id,
        error: error instanceof SyntaxError ? "播放器字幕格式暂不可用，请打开原生字幕后重试。" : String(error instanceof Error ? error.message : error).slice(0, 300) }, location.origin);
    });
  });
}
