import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function preparePdfCorpus(root, entries, download = false) {
  const cache = path.join(root, '.npm-cache/pdf-corpus');
  await fs.mkdir(cache, { recursive: true });
  for (const entry of entries) {
    assert.match(entry.id, /^[a-z0-9-]+$/u);
    const file = path.join(cache, entry.id + '.pdf');
    let bytes = await fs.readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!bytes) {
      assert.ok(download, `Missing ${entry.id}; pass --download to fetch the public sample.`);
      const response = await fetch(entry.url, { signal: AbortSignal.timeout(60_000) });
      assert.ok(response.ok, `${entry.id}: HTTP ${response.status}`);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        assert.ok(size < 25_000_000, `${entry.id}: sample exceeds 25 MB`);
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    }
    assert.ok(bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')), `${entry.id}: not a PDF`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (entry.sha256) assert.equal(sha256, entry.sha256, `${entry.id}: sample changed; review before updating its checksum`);
    await fs.writeFile(file, bytes);
    console.log(`${entry.id}: verified ${bytes.length} bytes, SHA-256 ${sha256}`);
  }
}
