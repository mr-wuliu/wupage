// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { playerControlDock, playerControlsVisible } from "../src/video/player-controls";
import { videoPlatform } from "../src/video/platforms";

afterEach(() => document.body.replaceChildren());

describe("shared player controls", () => {
  it.each([
    ['video-js', '<div class="vjs-control-bar"><button>Play</button><div class="vjs-subs-caps-button"><button>CC</button></div></div>'],
    ['plyr', '<div class="plyr__controls"><button>Play</button><button data-plyr="captions">CC</button></div>'],
    ['jwplayer', '<div class="jw-controlbar"><div class="jw-button-container"><button>Play</button><button class="jw-icon-cc">CC</button></div></div>'],
    ['dplayer', '<div class="dplayer-icons-right"><button class="dplayer-subtitle-btn">CC</button></div>'],
    ['art-video-player', '<div class="art-controls-right"><button class="art-control-subtitle">CC</button></div>'],
    ['xgplayer', '<div class="xgplayer-controls"><div class="xg-right-grid"><xg-icon class="xgplayer-subtitle">CC</xg-icon></div></div>'],
    ['shaka-video-container', '<div class="shaka-controls-button-panel"><button class="shaka-caption-button">CC</button></div>'],
    ['media-controller', '<media-control-bar><media-captions-button>CC</media-captions-button></media-control-bar>']
  ])("finds the caption control in %s without replacing native controls", (kind, markup) => {
    document.body.innerHTML = `<div class="${kind}"><video></video>${markup}</div>`;
    const video = document.querySelector("video")!;
    const original = video.parentElement!.innerHTML;
    const dock = playerControlDock(video, video.parentElement!);
    expect(dock?.before?.textContent).toBe("CC");
    expect(dock?.before?.parentElement).toBe(dock?.container);
    expect(video.parentElement!.innerHTML).toBe(original);
  });
  it("does not dock into another nested player's controls or a popup menu", () => {
    document.body.innerHTML = '<main><video></video><div class="video-js"><video></video><div class="vjs-control-bar"></div></div><div role="menu"><div class="plyr__controls"></div></div></main>';
    expect(playerControlDock(document.querySelector("video")!, document.querySelector("main")!)).toBeUndefined();
  });
  it("aligns with settings when the site's native subtitle control is hidden", () => {
    document.body.innerHTML = '<div class="bpx-player-container"><video></video><div class="bpx-player-control-bottom-right"><div class="bpx-player-ctrl-subtitle" hidden></div><div class="bpx-player-ctrl-setting" role="button">Settings</div></div></div>';
    const settings = document.querySelector<HTMLElement>(".bpx-player-ctrl-setting")!;
    Object.defineProperty(settings, "offsetHeight", { value: 22 });
    const dock = playerControlDock(document.querySelector("video")!, document.querySelector<HTMLElement>(".bpx-player-container")!, videoPlatform("www.bilibili.com"));
    expect(dock?.before).toBe(settings);
    expect(dock?.reference).toBe(settings);
  });
  it("discovers and observes controls in a nested open component", () => {
    document.body.innerHTML = '<main><player-shell></player-shell></main>';
    const shadow = document.querySelector("player-shell")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<div class="video-js"><video></video><div class="vjs-control-bar"><button class="vjs-fullscreen-control">Full</button></div></div>';
    const observed: ShadowRoot[] = [];
    const dock = playerControlDock(shadow.querySelector("video")!, document.querySelector("main")!, undefined, root => observed.push(root));
    expect(dock?.before?.textContent).toBe("Full");
    expect(observed).toEqual([shadow]);
    expect(playerControlDock(shadow.querySelector("video")!, document.querySelector<HTMLElement>("player-shell")!)?.container).toBe(dock?.container);
    expect(playerControlsVisible(dock!.container)).toBe(true);
    document.querySelector("player-shell")!.setAttribute("style", "opacity:0");
    expect(playerControlsVisible(dock!.container)).toBe(false);
  });
});
