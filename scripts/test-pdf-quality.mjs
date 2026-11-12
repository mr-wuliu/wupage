// Reproducible batch regression. Each case gets a fresh browser profile, a
// local translator and its own evidence directory; failures do not skip cases.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { preparePdfCorpus } from './lib/pdf-corpus.mjs';
import { writePdfQualityReport } from './lib/pdf-quality-report.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2), option = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
assert.ok(args.every(arg => arg === '--download' || /^--(?:profile|browsers|ids|workers)=/u.test(arg)), 'Unknown PDF test option');
const workers = Number(option('workers', '1'));
assert.ok(Number.isInteger(workers) && workers >= 1 && workers <= 3, 'PDF workers must be 1, 2 or 3');
const profile = option('profile', 'standard');
assert.ok(['smoke', 'standard', 'stress', 'full'].includes(profile), 'Unknown PDF test profile');
const browsers = [...new Set(option('browsers', 'chrome').split(','))];
assert.ok(browsers.length && browsers.every(value => ['chrome', 'edge', 'firefox'].includes(value)), 'Unknown browser');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/pdf-corpus.json'), 'utf8'));
const ids = option('ids', '').split(',').filter(Boolean);
assert.ok(ids.every(id => manifest.some(entry => entry.id === id)), 'Unknown PDF corpus ID');
const entries = manifest.filter(entry => !ids.length || ids.includes(entry.id));
const output = path.join(root, '.npm-cache/pdf-quality', profile);
await fs.mkdir(output, { recursive: true });
const cases = [];
for (const browser of browsers) {
  if (profile === 'smoke') cases.push({ browser, id: 'fixture', mode: 'baseline' });
  else for (const entry of entries) {
    if (profile !== 'stress') cases.push({ browser, id: entry.id, mode: 'baseline' });
    if (profile === 'stress' || profile === 'full') cases.push({ browser, id: entry.id, mode: 'expanded' });
    if (profile === 'full' && ['drg', 'attention', 'plos'].includes(entry.id)) cases.push({ browser, id: entry.id, mode: 'anonymous-fonts' });
  }
}
const results = [];
const startedAt = new Date().toISOString();
const buildHashes = Object.fromEntries(await Promise.all(browsers.map(async browser => [browser,
  createHash('sha256').update(await fs.readFile(path.join(root, browser === 'firefox' ? 'dist-firefox/pdf.js' : 'dist/pdf.js'))).digest('hex')])));
const buildSha256 = Object.entries(buildHashes).map(([browser, hash]) => `${browser}: ${hash}`).join(' / ');
const report = () => ({ startedAt, profile, workers, mock: true, buildSha256,
  sampleCount: profile === 'smoke' ? 0 : entries.length,
  samplePages: profile === 'smoke' ? 0 : entries.reduce((sum, entry) => sum + entry.pages, 0),
  passed: results.length === cases.length && results.every(result => result.passed), expectedCases: cases.length,
  tags: profile === 'smoke' ? ['绕排', '表格', '公式与引用', '裁剪与旋转', '三栏', '图像页', '导出']
    : [...new Set(entries.flatMap(entry => entry.tags ?? []))].sort(), results });
await writePdfQualityReport(output, report());
if (profile !== 'smoke') await preparePdfCorpus(root, entries, args.includes('--download'));
let reportWriting = Promise.resolve();
async function runCase(test) {
  const currentBuild = createHash('sha256').update(await fs.readFile(path.join(root, test.browser === 'firefox' ? 'dist-firefox/pdf.js' : 'dist/pdf.js'))).digest('hex');
  assert.equal(currentBuild, buildHashes[test.browser], 'Build changed during PDF tests; rerun against one build');
  const directory = path.join(output, test.browser, test.id, test.mode);
  await fs.mkdir(directory, { recursive: true });
  await fs.rm(path.join(directory, 'report.json'), { force: true });
  const command = [path.join(root, 'scripts/test-pdf-academic.mjs'), `--output=${directory}`];
  if (test.id !== 'fixture') command.push(`--corpus=${test.id}`);
  if (test.browser !== 'chrome') command.push(`--${test.browser}`);
  if (test.mode === 'expanded') command.push('--expansion=0.65', '--allow-safe-rejection');
  if (test.mode === 'anonymous-fonts') command.push('--anonymize-fonts');
  const start = Date.now();
  const child = spawn(process.execPath, command, { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  const exitCode = await new Promise(resolve => { child.on('error', error => { log += String(error); resolve(-1); }); child.on('close', code => resolve(code)); });
  await fs.writeFile(path.join(directory, 'run.log'), log);
  const detail = await fs.readFile(path.join(directory, 'report.json'), 'utf8').then(JSON.parse).catch(() => undefined);
  const result = { ...test, passed: exitCode === 0 && detail?.passed === true, seconds: (Date.now() - start) / 1000,
    buildSha256: buildHashes[test.browser],
    outcome: detail?.checks?.some(check => check.outcome === 'safely-rejected') ? 'safely-rejected' : 'translated',
    pages: detail?.checks?.reduce((sum, check) => sum + check.pages, 0) ?? 0, checks: detail?.checks ?? [],
    error: exitCode === 0 ? undefined : detail?.error ?? log.slice(-5000), directory };
  results.push(result);
  const snapshot = structuredClone(report());
  reportWriting = reportWriting.then(() => writePdfQualityReport(output, snapshot));
  await reportWriting;
  console.log(`${result.passed ? result.outcome === 'safely-rejected' ? 'SAFE REJECT' : 'PASS' : 'FAIL'} ${test.browser}/${test.id}/${test.mode}: ${result.pages} pages (${result.seconds.toFixed(1)}s)`);
  if (!result.passed) console.log(result.error);
}
let nextCase = 0;
await Promise.all(Array.from({ length: Math.min(workers, cases.length) }, async () => {
  while (nextCase < cases.length) await runCase(cases[nextCase++]);
}));
console.log(`PDF quality: ${results.filter(result => result.passed && result.outcome === 'translated').length} translated, ${results.filter(result => result.passed && result.outcome === 'safely-rejected').length} safely rejected, ${results.filter(result => !result.passed).length} failed; report: ${path.join(output, 'report.json')}`);
process.exitCode = results.every(result => result.passed) ? 0 : 1;
