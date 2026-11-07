// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VideoSubtitleManager } from '../src/content/video-subtitles';
import { sendRuntimeRequest } from '../src/content/runtime';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';

vi.mock('../src/content/runtime', () => ({ sendRuntimeRequest: vi.fn() }));
let manager: VideoSubtitleManager;
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', {runtime:{id:'wupage'},storage:{onChanged:{addListener:vi.fn(),removeListener:vi.fn()}}});
  document.body.innerHTML = '<div style="position:relative"><video></video><div class="vjs-text-track-display">First lecture.</div></div>';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 360));
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 640, 360)] as unknown as DOMRectList);
  vi.mocked(sendRuntimeRequest).mockImplementation(async request => request.type === 'GET_SETTINGS' ? structuredClone(DEFAULT_SETTINGS)
    : request.type === 'TRANSLATE_VIDEO_SUBTITLES' ? {translations:request.texts.map(text=>'译：'+text),cached:0} : null);
  manager = new VideoSubtitleManager();
});
afterEach(() => { manager.dispose(); document.body.replaceChildren();vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllGlobals(); });

it.each(['replacement', 'reattachment'])('preserves manual translation after an old controller retires before discovery: %s', async kind => {
  manager.open();await flush();await vi.advanceTimersByTimeAsync(500);
  expect(document.querySelector('[data-wupage-video]')?.hasAttribute('data-enabled')).toBe(true);
  const video=document.querySelector('video')!,container=video.parentElement!;
  video.remove();await vi.advanceTimersByTimeAsync(120);
  expect(container.querySelector('[data-wupage-video]')).toBeNull();
  container.prepend(kind==='replacement'?document.createElement('video'):video);
  container.querySelector('.vjs-text-track-display')!.textContent='Second lecture.';
  await vi.advanceTimersByTimeAsync(600);await flush();
  const host=document.querySelector('[data-wupage-video]')!;
  expect(host.hasAttribute('data-enabled')).toBe(true);
  expect(host.shadowRoot!.querySelector('.translation span')?.textContent).toBe('译：Second lecture.');
});

it('keeps a manual stop when the following lecture replaces the video', async () => {
  manager.open();await flush();await vi.advanceTimersByTimeAsync(500);
  document.querySelector('[data-wupage-video]')!.shadowRoot!.querySelector<HTMLButtonElement>('.toggle')!.click();
  const count=vi.mocked(sendRuntimeRequest).mock.calls.filter(([r])=>r.type==='TRANSLATE_VIDEO_SUBTITLES').length;
  document.querySelector('video')!.replaceWith(document.createElement('video'));
  await vi.advanceTimersByTimeAsync(800);await flush();
  expect(document.querySelector('[data-wupage-video]')?.hasAttribute('data-enabled')).toBe(false);
  expect(vi.mocked(sendRuntimeRequest).mock.calls.filter(([r])=>r.type==='TRANSLATE_VIDEO_SUBTITLES')).toHaveLength(count);
});
