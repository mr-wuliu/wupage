// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PlayerSubtitleController } from '../src/content/video-player';
import { sendRuntimeRequest } from '../src/content/runtime';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import { pageSubtitleCatalogue, loadPageSubtitles } from '../src/video/bridge-client';
import { mediaKey, VIDEO_PLATFORMS } from '../src/video/platforms';
vi.mock('../src/content/runtime', () => ({ sendRuntimeRequest: vi.fn() }));
vi.mock('../src/video/bridge-client', () => ({ pageSubtitleCatalogue: vi.fn(), loadPageSubtitles: vi.fn() }));
let controller: PlayerSubtitleController;
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', { runtime: { id: 'wupage' }, storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  document.body.innerHTML = '<div class="bpx-player-container" style="position:relative"><video></video><div class="bili-subtitle-x-subtitle-panel-major-group">另一种语言</div></div>';
  const video = document.querySelector('video')!;
  Object.defineProperty(video, 'textTracks', { value: [], configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 360));
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 30)] as unknown as DOMRectList);
  vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === 'GET_SETTINGS' ? DEFAULT_SETTINGS
    : request.type === 'TRANSLATE_VIDEO_SUBTITLES' ? { translations: request.texts.map(() => '正确译文'), cached: 0 } : null);
  vi.mocked(pageSubtitleCatalogue).mockResolvedValue({ key: mediaKey(), tracks: [
    { id: 'chinese', label: '中文', language: 'zh-CN' }, { id: 'english', label: 'English(US)', language: 'en-US' }
  ] });
  controller = new PlayerSubtitleController(video, video.parentElement!, VIDEO_PLATFORMS[1]);
});
afterEach(() => { controller.dispose(); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('recognizes regional English metadata when automatically choosing an original track', async () => {
  vi.mocked(loadPageSubtitles).mockResolvedValue({ key: mediaKey(), cues: [{ start: 0, end: 4, text: 'Hello' }] });
  await controller.start(); await flush();
  expect(loadPageSubtitles).toHaveBeenCalledWith('english', expect.any(AbortSignal));
  const root = document.querySelector('[data-wupage-video]')!.shadowRoot!;
  expect(root.querySelector('.source span')?.textContent).toBe('Hello');
  expect(root.querySelector('.translation span')?.textContent).toBe('正确译文');
});

it('follows a changed site catalogue selection in automatic mode', async () => {
  vi.mocked(loadPageSubtitles).mockImplementation(async id => ({key:mediaKey(),cues:[{start:0,end:4,text:id==='english'?'Hello':'你好'}]}));
  await controller.start(); await flush();
  vi.mocked(pageSubtitleCatalogue).mockResolvedValue({key:mediaKey(),selected:'chinese',tracks:[
    {id:'chinese',label:'中文',language:'zh-CN'},{id:'english',label:'English',language:'en-US'}
  ]});
  // Jump to either side of the refresh deadline without rendering 170 idle ticks.
  const started = Date.now();
  vi.setSystemTime(started + 19000);
  await vi.advanceTimersByTimeAsync(120); await flush();
  expect(pageSubtitleCatalogue).toHaveBeenCalledTimes(1);
  vi.setSystemTime(started + 20500);
  await vi.advanceTimersByTimeAsync(120); await flush();
  expect(pageSubtitleCatalogue).toHaveBeenCalledTimes(2);
  expect(loadPageSubtitles).toHaveBeenLastCalledWith('chinese', expect.any(AbortSignal));
  expect(document.querySelector('[data-wupage-video]')!.shadowRoot!.querySelector('.translation span')?.textContent).toBe('你好');
});

it('does not silently translate a different rendered language when an explicit track fails', async () => {
  vi.mocked(loadPageSubtitles).mockRejectedValue(new Error('CDN failed'));
  await controller.start(); await flush();
  vi.mocked(sendRuntimeRequest).mockClear();
  const root = document.querySelector('[data-wupage-video]')!.shadowRoot!;
  const select = root.querySelector<HTMLSelectElement>('.track')!;
  select.value = 'page:english'; select.dispatchEvent(new Event('change')); await flush();
  await vi.advanceTimersByTimeAsync(4000);
  expect(root.querySelector('.status')?.textContent).toContain('未能读取所选原字幕');
  expect(root.host.hasAttribute('data-error')).toBe(true);
  expect(root.querySelector('.translation span')?.textContent).toBe('');
  expect(document.querySelector('[data-wupage-video-native]')).toBeNull();
  expect(vi.mocked(sendRuntimeRequest).mock.calls.some(([request]) => request.type === 'TRANSLATE_VIDEO_SUBTITLES')).toBe(false);
});
