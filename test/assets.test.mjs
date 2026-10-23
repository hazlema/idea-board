import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AssetStore, MAX_ASSET_BYTES, sniffImageType } from '../lib/assets.mjs';
import { OpError } from '../lib/board.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const NAME = /^[0-9a-f]{32}\.png$/;

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-board-assets-'));
  return { dir, store: new AssetStore(path.join(dir, 'board.assets')), done: () => fs.rmSync(dir, { recursive: true }) };
}

async function withPictureServer(fn) {
  const server = http.createServer((req, res) => {
    if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); }
    else if (req.url === '/redirect') { res.writeHead(302, { location: '/pic.png' }); res.end(); }
    else if (req.url === '/big') { res.writeHead(200, { 'content-length': String(MAX_ASSET_BYTES + 1) }); res.end(PNG); }
    else if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); }
    else if (req.url === '/missing') { res.writeHead(404); res.end(); }
    // /slow never answers
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); server.close(); }
}

test('sniffImageType reads magic bytes', () => {
  assert.equal(sniffImageType(PNG), 'png');
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
  assert.equal(sniffImageType(Buffer.from('GIF89a......')), 'gif');
  assert.equal(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'webp');
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
});

test('ingestBuffer stores by content hash and rejects non-images', () => {
  const { dir, store, done } = tempStore();
  try {
    const first = store.ingestBuffer(PNG);
    assert.match(first.asset, NAME);
    assert.equal(first.bytes, PNG.length);
    assert.ok(fs.existsSync(path.join(dir, 'board.assets', first.asset)));
    assert.deepEqual(store.read(first.asset), PNG);
    assert.equal(store.ingestBuffer(Buffer.from(PNG)).asset, first.asset);
    assert.throws(() => store.ingestBuffer(Buffer.from('%PDF-1.4')), (e) => e instanceof OpError && /not an image/.test(e.message));
    assert.throws(() => store.ingestBuffer(Buffer.alloc(MAX_ASSET_BYTES + 1)), (e) => e instanceof OpError && /larger than 30 MB/.test(e.message));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'board.assets')), [first.asset]);
  } finally { done(); }
});

test('the assets folder is only created by the first write', () => {
  const { dir, store, done } = tempStore();
  try {
    assert.equal(fs.existsSync(path.join(dir, 'board.assets')), false);
    assert.throws(() => store.ingestBuffer(Buffer.from('nope')), OpError);
    assert.equal(fs.existsSync(path.join(dir, 'board.assets')), false);
  } finally { done(); }
});

test('resolve only accepts asset file names', () => {
  const { dir, store, done } = tempStore();
  try {
    const name = `${'a'.repeat(32)}.png`;
    assert.equal(store.resolve(name), path.join(dir, 'board.assets', name));
    for (const bad of ['../board.json', 'evil.svg', `${'a'.repeat(32)}.svg`, `${'A'.repeat(32)}.png`, `${'a'.repeat(31)}.png`, `x/${name}`, `${name}/`]) {
      assert.throws(() => store.resolve(bad), OpError, bad);
    }
  } finally { done(); }
});

test('ingestUrl handles Google Images links, HTML pages and timeouts', () => withPictureServer(async (base) => {
  const { store, done } = tempStore();
  try {
    const direct = await store.ingestUrl(`${base}/pic.png`);
    assert.match(direct.asset, NAME);
    const google = await store.ingestUrl(`https://www.google.com/imgres?imgurl=${encodeURIComponent(`${base}/pic.png`)}&imgrefurl=x`);
    assert.equal(google.asset, direct.asset);
    assert.equal((await store.ingestUrl(`${base}/redirect`)).asset, direct.asset);
    await assert.rejects(store.ingestUrl(`${base}/page`), (e) => e instanceof OpError && /not an image \(got text\/html\)/.test(e.message));
    await assert.rejects(store.ingestUrl(`${base}/slow`, { timeoutMs: 200 }), (e) => e instanceof OpError && /could not download: timed out/.test(e.message));
    await assert.rejects(store.ingestUrl(`${base}/big`), (e) => e instanceof OpError && /larger than 30 MB/.test(e.message));
    await assert.rejects(store.ingestUrl(`${base}/missing`), (e) => e instanceof OpError && /404/.test(e.message));
    await assert.rejects(store.ingestUrl('file:///etc/passwd'), OpError);
    await assert.rejects(store.ingestUrl('not a url'), OpError);
    await assert.rejects(store.ingestUrl('http://127.0.0.1:1/pic.png'), (e) => e instanceof OpError && /could not download/.test(e.message));
  } finally { done(); }
}));

test('ingestUrl stops reading once a body passes the limit', async () => {
  const { store, done } = tempStore();
  try {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    });
    const fetchImpl = async () => Object.assign(new Response(body, { status: 200 }), { });
    await assert.rejects(store.ingestUrl('http://example.test/endless', { fetchImpl }), (e) => e instanceof OpError && /larger than 30 MB/.test(e.message));
    assert.equal(cancelled, true);
    const toFile = async () => Object.defineProperty(new Response(PNG), 'url', { value: 'file:///etc/passwd' });
    await assert.rejects(store.ingestUrl('http://example.test/x', { fetchImpl: toFile }), OpError);
  } finally { done(); }
});
