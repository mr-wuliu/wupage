// Drive the installed Firefox through its built-in Marionette test protocol.
// No driver download or changes to the user's Firefox profile are required.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function startFirefox(output, extension, preferences = {}) {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'profile-'));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const prefs = {
    'marionette.port': port,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.startup.page': 0,
    'browser.aboutwelcome.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
    'browser.newtabpage.enabled': false,
    ...preferences
  };
  await fs.writeFile(path.join(profile, 'user.js'), Object.entries(prefs)
    .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
  const binary = process.env.FIREFOX_BINARY || (process.platform === 'win32'
    ? 'C:/Program Files/Mozilla Firefox/firefox.exe' : 'firefox');
  const child = spawn(binary, ['--headless', '--no-remote', '--wait-for-browser', '--profile', profile,
    '--marionette', '--remote-allow-system-access'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } });
  let log = '';
  child.stdout.on('data', data => { log += data; });
  child.stderr.on('data', data => { log += data; });
  let launchError;
  child.on('error', error => { launchError = error; });
  let socket;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Firefox exited (${child.exitCode}): ${log}`);
    try {
      socket = await new Promise((resolve, reject) => {
        const candidate = net.createConnection({ port, host: '127.0.0.1' });
        candidate.once('connect', () => resolve(candidate));
        candidate.once('error', error => { candidate.destroy(); reject(error); });
      });
      break;
    } catch { await delay(200); }
  }
  if (!socket) { child.kill(); throw new Error(`Firefox did not start: ${log}`); }
  let buffer = Buffer.alloc(0);
  let serial = 0;
  const pending = new Map();
  const fail = error => {
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
    pending.clear();
  };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Firefox test connection closed')));
  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (true) {
      const colon = buffer.indexOf(58);
      if (colon < 0) break;
      const length = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + length) break;
      const response = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString());
      buffer = buffer.subarray(colon + 1 + length);
      if (!Array.isArray(response)) continue; // Initial protocol greeting.
      const [, id, error, result] = response;
      const job = pending.get(id);
      if (!job) continue;
      pending.delete(id);
      clearTimeout(job.timer);
      if (error) job.reject(new Error(`${error.error}: ${error.message}`));
      else job.resolve(result);
    }
  });
  const command = (name, parameters = {}, timeout = 180_000) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Firefox command timed out: ${name}`)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    const message = JSON.stringify([0, id, name, parameters]);
    socket.write(`${Buffer.byteLength(message)}:${message}`);
  });
  const execute = async (script, args = []) => (await command('WebDriver:ExecuteScript',
    { script, args, newSandbox: true, sandbox: 'default', line: 1, filename: 'wupage-firefox-test' })).value;
  const executeAsync = async (script, args = [], timeout = 180_000) => (await command('WebDriver:ExecuteAsyncScript',
    { script, args, newSandbox: true, sandbox: 'default', scriptTimeout: timeout,
      line: 1, filename: 'wupage-firefox-test' }, timeout + 1000)).value;
  const close = async () => {
    try { await command('Marionette:Quit', { flags: ['eForceQuit'] }, 5000); } catch { /* Process may already have exited. */ }
    socket.destroy();
    if (child.exitCode === null) child.kill();
    await fs.writeFile(path.join(output, 'firefox.log'), log);
  };
  try {
    const session = await command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
    await command('Addon:Install', { path: extension, temporary: true });
    const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
    await command('Marionette:SetContext', { value: 'chrome' });
    const base = await execute('return WebExtensionPolicy.getByID(arguments[0]).getURL("");', [manifest.browser_specific_settings.gecko.id]);
    await command('Marionette:SetContext', { value: 'content' });
    return { command, execute, executeAsync, base, session, profile, close };
  } catch (error) { await close(); throw error; }
}
