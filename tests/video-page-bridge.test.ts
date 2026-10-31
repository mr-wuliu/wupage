// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { VIDEO_BRIDGE_CHANNEL } from "../src/video/site-cues";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reports the original subtitle language selected in the Bilibili player', async () => {
  vi.resetModules(); vi.stubGlobal('location', new URL('https://www.bilibili.com/video/BVfixture/'));
  document.body.innerHTML = '<div class="bpx-player-ctrl-subtitle-major"><div class="bpx-state-active" data-lan="zh-CN"></div></div>';
  vi.stubGlobal('performance', { getEntriesByType: () => [{ startTime: 1, name: 'https://api.bilibili.com/x/player/v2?bvid=BVfixture' }] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({data:{subtitle:{subtitles:[
    {id_str:'chinese',lan:'zh-CN',subtitle_url:'https://aisubtitle.hdslb.com/bfs/subtitle/zh.json'},
    {id_str:'english',lan:'en-US',subtitle_url:'https://aisubtitle.hdslb.com/bfs/subtitle/en.json'}
  ]}}}))));
  let listener!: EventListener;
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => { if (type === 'message') listener = callback as EventListener; });
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  await import('../src/video/page-bridge');
  for (const [language, expected] of [['zh-CN','chinese'],['en-US','english']]) {
    document.querySelector('[data-lan]')!.setAttribute('data-lan', language);
    listener(new MessageEvent('message', {source:window,origin:location.origin,data:{channel:VIDEO_BRIDGE_CHANNEL,direction:'request',id:'wp-selection',action:'catalogue'}}));
    for (let index=0;index<30;index++) await Promise.resolve();
    expect(post.mock.calls.at(-1)?.[0].data.selected).toBe(expected);
  }
});

it("reuses the player's complete authorized caption request, including its client context", async () => {
  vi.resetModules();
  vi.stubGlobal("location", new URL("https://www.youtube.com/watch?v=fixture"));
  document.body.innerHTML = '<div id="movie_player"></div>';
  Object.assign(document.querySelector('#movie_player')!, { getPlayerResponse: () => ({
    videoDetails: { videoId: 'fixture' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
      baseUrl: 'https://www.youtube.com/api/timedtext?v=fixture&lang=en', languageCode: 'en', vssId: '.en'
    }] } }
  }) });
  vi.stubGlobal('performance', { getEntriesByType: () => [{ startTime: 1,
    name: 'https://www.youtube.com/api/timedtext?v=fixture&lang=en&pot=proof&c=WEB&cver=123&fmt=json3'
  }] });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello' }] }] })));
  vi.stubGlobal('fetch', fetchMock);
  let listener!: EventListener;
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => { if (type === 'message') listener = callback as EventListener; });
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  await import('../src/video/page-bridge');
  const request = async (action: string) => {
    listener(new MessageEvent('message', { source: window, origin: location.origin,
      data: { channel: VIDEO_BRIDGE_CHANNEL, direction: 'request', id: 'wp-test', action, track: '.en' } }));
    for (let index = 0; index < 30; index++) await Promise.resolve();
  };
  await request('catalogue'); await request('load');
  const url = new URL(String(fetchMock.mock.calls[0][0]));
  expect(url.searchParams.get('pot')).toBe('proof');
  expect(url.searchParams.get('c')).toBe('WEB');
  expect(url.searchParams.get('cver')).toBe('123');
  expect(post.mock.calls.some(([message]) => message.data?.cues?.[0]?.text === 'Hello')).toBe(true);
});

it("keeps Bilibili metadata authenticated but omits cookies on signed caption CDN files", async () => {
  vi.resetModules(); vi.stubGlobal('location', new URL('https://www.bilibili.com/video/BVfixture/'));
  vi.stubGlobal('performance', { getEntriesByType: () => [{ startTime: 1, name: 'https://api.bilibili.com/x/player/v2?bvid=BVfixture' }] });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(
    new URL(String(input)).hostname === 'api.bilibili.com'
      ? { data: { subtitle: { subtitles: [{ id_str: 'en', lan: 'en-US', lan_doc: 'English', subtitle_url: '//subtitle.bilibili.com/S%13%1BP.%1D%28%29X%2CR%5Ej%1F%25w%0E%02H%5EHO4%14%7B4%08K%40%3C%7B%00M%0B%0A%1AM%1A%19%0BI%2A2%14%3C%7D%08%12V%0D%09%073W%25W%1A%06?auth_key=fixture' }] } } }
      : { body: [{ from: 0, to: 2, content: 'Hello' }] }
  )));
  vi.stubGlobal('fetch', fetchMock);
  let listener!: EventListener;
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => { if (type === 'message') listener = callback as EventListener; });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  await import('../src/video/page-bridge');
  for (const action of ['catalogue', 'load']) {
    listener(new MessageEvent('message', { source: window, origin: location.origin,
      data: { channel: VIDEO_BRIDGE_CHANNEL, direction: 'request', id: 'wp-test', action, track: 'en' } }));
    for (let index = 0; index < 30; index++) await Promise.resolve();
  }
  expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include');
  expect(fetchMock.mock.calls[1][1]?.credentials).toBe('omit');
  expect(String(fetchMock.mock.calls[1][0])).toBe('https://aisubtitle.hdslb.com/bfs/subtitle/fixture.json?auth_key=fixture');
});

it.each(['mobile player', 'initial response', 'observed request'])("loads YouTube mobile captions from %s with relative URLs and the complete mobile client context", async source => {
  vi.resetModules();
  vi.stubGlobal('location', new URL('https://m.youtube.com/watch?v=mobile'));
  document.body.innerHTML = '<div id="player-container-id"><div id="player"><video></video></div></div>';
  const response = { videoDetails: { videoId: 'mobile' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { baseUrl: '/api/timedtext?v=mobile&lang=en&kind=asr', languageCode: 'en', vssId: 'a.en', kind: 'asr' }
  ] } } };
  if (source === 'mobile player') Object.assign(document.querySelector('#player')!, { getPlayerResponse: () => response });
  if (source === 'initial response') vi.stubGlobal('ytInitialPlayerResponse', response);
  const authorized = 'https://m.youtube.com/api/timedtext?v=mobile&lang=en&kind=asr&c=MWEB&signature=mobile-signature&fmt=json3';
  vi.stubGlobal('performance', { getEntriesByType: () => [{ startTime: 1, name: authorized },
    { startTime: 2, name: authorized.replace('kind=asr', 'name=manual') }] });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Mobile captions' }] }] })));
  vi.stubGlobal('fetch', fetchMock);
  let listener!: EventListener;
  vi.spyOn(window, 'addEventListener').mockImplementation((type, callback) => { if (type === 'message') listener = callback as EventListener; });
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  await import('../src/video/page-bridge');
  const request = async (action: string, track?: string) => {
    listener(new MessageEvent('message', { source: window, origin: location.origin,
      data: { channel: VIDEO_BRIDGE_CHANNEL, direction: 'request', id: 'wp-mobile', action, track } }));
    for (let i = 0; i < 40; i++) await Promise.resolve();
    return post.mock.calls.at(-1)?.[0];
  };
  const catalogue = await request('catalogue');
  if (source === 'observed request') expect(catalogue.data.selected).toContain('manual');
  const track = catalogue.data.tracks.find((entry: { language: string; automatic?: boolean }) => entry.language === 'en' && entry.automatic);
  expect(track).toBeDefined();
  expect((await request('load', track.id)).data.cues[0].text).toBe('Mobile captions');
  expect(String(fetchMock.mock.calls[0][0])).toBe(authorized);
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include', redirect: 'error' });

  vi.stubGlobal('location', new URL('https://m.youtube.com/watch?v=next'));
  expect((await request('catalogue')).data.tracks).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
