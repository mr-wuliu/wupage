import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { preparePdfCorpus } from '../scripts/lib/pdf-corpus.mjs';

const roots = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    expect(resolved.startsWith(path.join(os.tmpdir(), 'wupage-pdf-corpus-'))).toBe(true);
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
const temporary = async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wupage-pdf-corpus-')); roots.push(root); return root; };

describe('pinned PDF regression corpus', () => {
  it('covers distinct document families and pins every sample and inspection page', async () => {
    const entries = JSON.parse(await fs.readFile(new URL('./fixtures/pdf-corpus.json', import.meta.url), 'utf8'));
    expect(entries.length).toBeGreaterThanOrEqual(12);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/u);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(new URL(entry.url).protocol).toBe('https:');
      expect(entry.inspect.length).toBeGreaterThan(0);
      expect(entry.inspect.every(page => Number.isInteger(page) && page > 0 && page <= entry.pages)).toBe(true);
      expect(entry.tags.length).toBeGreaterThan(0);
    }
    expect(new Set(entries.flatMap(entry => entry.tags)).size).toBeGreaterThanOrEqual(15);
  });

  it('rejects a changed cached sample without contacting the source', async () => {
    const root = await temporary(), cache = path.join(root, '.npm-cache/pdf-corpus');
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'sample.pdf'), '%PDF-1.7\nchanged');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(preparePdfCorpus(root, [{ id: 'sample', sha256: '0'.repeat(64) }], true)).rejects.toThrow('sample changed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an HTML challenge page without caching it as a PDF', async () => {
    const root = await temporary();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Browser verification</html>')));
    await expect(preparePdfCorpus(root, [{ id: 'sample', url: 'https://example.org/sample.pdf' }], true)).rejects.toThrow('not a PDF');
    await expect(fs.stat(path.join(root, '.npm-cache/pdf-corpus/sample.pdf'))).rejects.toThrow();
  });

  it('validates a downloaded sample and reuses its verified cache', async () => {
    const root = await temporary(), bytes = Buffer.from('%PDF-1.7\nfixture');
    const entry = { id: 'sample', url: 'https://example.org/sample.pdf', sha256: createHash('sha256').update(bytes).digest('hex') };
    const fetch = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetch);
    await preparePdfCorpus(root, [entry], true);
    await preparePdfCorpus(root, [entry]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
