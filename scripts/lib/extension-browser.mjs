import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFirefox } from './firefox.mjs';
import { browserTarget } from './browser-target.mjs';

// Both adapters use new profiles and never attach to the user's open browsers.
export async function openExtensionBrowser(root, output, firefox = false) {
  await fs.mkdir(output, { recursive: true });
  if (firefox) {
    const browser = await startFirefox(output, path.join(root, 'dist-firefox'), {
      'browser.download.folderList': 2, 'browser.download.dir': path.resolve(output),
      'browser.download.useDownloadDir': true, 'browser.helperApps.neverAsk.saveToDisk': 'application/pdf,application/toml',
      'pdfjs.disabled': true
    });
    try {
      const result = await browser.command('WebDriver:GetWindowHandle');
      const control = result.value ?? result;
      const select = handle => browser.command('WebDriver:SwitchToWindow', { handle });
      await browser.command('WebDriver:Navigate', { url: `${browser.base}options.html` });
      const created = await browser.command('WebDriver:NewWindow', { type: 'tab' });
      const page = (created.value ?? created).handle;
      return {
        api: async (source, input = []) => {
          await select(control);
          const result = await browser.executeAsync(`const done=arguments[arguments.length-1],input=JSON.parse(arguments[0]),chrome=window.wrappedJSObject.chrome;
            (async()=>{${source}})().then(value=>done(JSON.stringify({value})),error=>done(JSON.stringify({error:String(error)})));`, [JSON.stringify(input)]);
          const parsed = JSON.parse(result); if (parsed.error) throw new Error(parsed.error); return parsed.value;
        },
        evaluate: async source => { await select(page); return browser.execute(source); },
        navigate: async url => { await select(page); await browser.command('WebDriver:Navigate', { url }); },
        capture: async name => {
          await select(page); const value = await browser.command('WebDriver:TakeScreenshot', { id: null, highlights: [], full: false });
          await fs.writeFile(path.join(output, name), Buffer.from(value.value, 'base64'));
        },
        resize: async (width, height) => {
          await select(page); await browser.command('WebDriver:SetWindowRect', { width, height });
        },
        pointer: async (actions, modifiers = []) => {
          await select(page);
          const keys = modifiers.map(key => ({ Control: '\uE009', Alt: '\uE00A', Shift: '\uE008', Meta: '\uE03D' })[key]);
          if (keys.length) await browser.command('WebDriver:PerformActions', { actions: [{ type: 'key', id: 'keyboard', actions: keys.map(value => ({ type: 'keyDown', value })) }] });
          try { await browser.command('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
            actions: actions.map(action => action.type === 'move' ? { type: 'pointerMove', origin: 'viewport', x: Math.round(action.x), y: Math.round(action.y), duration: 80 }
              : { type: action.type === 'down' ? 'pointerDown' : 'pointerUp', button: 0 }) }] }); }
          finally { if (keys.length) await browser.command('WebDriver:PerformActions', { actions: [{ type: 'key', id: 'keyboard', actions: keys.reverse().map(value => ({ type: 'keyUp', value })) }] }); }
        },
        press: async combination => {
          await select(page);
          const modifiers = { Alt: '\uE00A', Shift: '\uE008', Control: '\uE009', Meta: '\uE03D', Escape: '\uE00C',
            Enter: '\uE007', Space: '\uE00D', ArrowDown: '\uE015', Delete: '\uE017', Tab: '\uE004', Backspace: '\uE003' };
          const keys = combination.split('+').map(key => modifiers[key] || key.toLowerCase());
          await browser.command('WebDriver:PerformActions', { actions: [{ type: 'key', id: 'keyboard', actions: [
            ...keys.map(value => ({ type: 'keyDown', value })), ...[...keys].reverse().map(value => ({ type: 'keyUp', value }))
          ] }] });
        },
        download: async (source, destination) => {
          const before = new Set(await fs.readdir(output));
          await select(page); await browser.execute(source);
          for (let attempt = 0; attempt < 600; attempt++) {
            const files = await fs.readdir(output);
            const added = files.filter(name => !before.has(name));
            const file = added.find(name => name.endsWith(path.extname(destination)));
            // Firefox creates an empty destination before its randomly named
            // .part file finishes; checking only "<name>.pdf.part" races it.
            if (file && !added.some(name => name.endsWith('.part')) && (await fs.stat(path.join(output, file))).size > 0) {
              await fs.copyFile(path.join(output, file), destination); return destination;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          throw new Error('Firefox download timed out');
        },
        close: () => browser.close()
      };
    } catch (error) { await browser.close(); throw error; }
  }
  const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = await import(path.isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName);
  const browser = await chromium.launchPersistentContext(path.join(output, `profile-${Date.now()}`), {
    ...browserTarget().chromiumOptions,
    headless: true, viewport: { width: 1400, height: 1000 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--lang=zh-CN', '--enable-unsafe-extension-debugging']
  });
  try {
    const session = await browser.browser().newBrowserCDPSession();
    await session.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }); await session.detach();
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
    const control = await browser.newPage(); await control.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    const page = await browser.newPage();
    return {
      api: (source, input = []) => control.evaluate(`(async()=>{const input=${JSON.stringify(input)};${source}})()`),
      evaluate: source => page.evaluate(`(()=>{${source}})()`),
      navigate: url => page.goto(url),
      capture: name => page.screenshot({ path: path.join(output, name) }),
      resize: (width, height) => page.setViewportSize({ width, height }),
      pointer: async (actions, modifiers = []) => {
        for (const key of modifiers) await page.keyboard.down(key);
        try { for (const action of actions) {
          if (action.type === 'move') await page.mouse.move(action.x, action.y, { steps: 6 });
          else if (action.type === 'down') await page.mouse.down();
          else await page.mouse.up();
        } } finally { for (const key of [...modifiers].reverse()) await page.keyboard.up(key); }
      },
      press: async combination => { await page.bringToFront(); await page.keyboard.press(combination); },
      download: async (source, destination) => {
        const pending = page.waitForEvent('download', { timeout: 120000 });
        await page.evaluate(`(()=>{${source}})()`);
        const download = await pending; await download.saveAs(destination); return destination;
      },
      close: () => browser.close()
    };
  } catch (error) { await browser.close(); throw error; }
}
