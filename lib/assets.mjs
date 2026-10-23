// Pictures live as files beside the board (<base>.assets/), named by content,
// so the same picture added twice is stored once. The board only keeps names.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OpError } from './board.mjs';
import { ASSET_NAME } from './brainstorm.mjs';

export const MAX_ASSET_BYTES = 30 * 1024 * 1024;
const tooBig = () => Object.assign(new OpError('picture is larger than 30 MB'), { status: 413 });

// The kind of picture these bytes are, from the file's first bytes (never from
// what a sender claims), or null when they are not a supported picture.
export function sniffImageType(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// A Google Images result link carries the real picture address in `imgurl`.
function unwrapGoogleImages(url) {
  const host = url.hostname.toLowerCase();
  if (host !== 'google.com' && !host.endsWith('.google.com')) return url;
  if (!url.pathname.startsWith('/imgres')) return url;
  const target = url.searchParams.get('imgurl');
  if (!target) return url;
  try { return new URL(target); } catch { throw new OpError('could not download: the Google Images link has no usable picture address'); }
}

function parseWebUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new OpError('could not download: that is not a valid web address'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OpError('could not download: only http and https addresses work');
  return url;
}

export class AssetStore {
  constructor(dir) {
    this.dir = dir;
  }

  // Absolute path of a stored picture; the only way a name becomes a path.
  resolve(name) {
    if (typeof name !== 'string' || !ASSET_NAME.test(name)) throw new OpError('not a picture file name');
    return path.join(this.dir, name);
  }

  read(name) {
    return fs.readFileSync(this.resolve(name));
  }

  ingestBuffer(buf) {
    if (buf.length > MAX_ASSET_BYTES) throw tooBig();
    const type = sniffImageType(buf);
    if (!type) throw new OpError('not an image (use a png, jpg, gif or webp picture)');
    const asset = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${type}`;
    const file = this.resolve(asset);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
    }
    return { asset, bytes: buf.length };
  }

  async ingestUrl(value, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    const url = unwrapGoogleImages(parseWebUrl(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OpError('could not download: only http and https addresses work');

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { accept: 'image/png,image/jpeg,image/gif,image/webp,image/*;q=0.8,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (compatible; idea-board)' },
      });
      // A redirect must not lead anywhere but the web.
      if (response.url && !/^https?:/i.test(response.url)) throw new OpError('could not download: only http and https addresses work');
      if (!response.ok) throw new OpError(`could not download: the server answered ${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) throw tooBig();

      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.length;
          if (size > MAX_ASSET_BYTES) {
            reader.cancel().catch(() => {});
            throw tooBig();
          }
          chunks.push(chunk);
        }
      }
      const bytes = Buffer.concat(chunks);
      if (!sniffImageType(bytes)) {
        const kind = (response.headers.get('content-type') ?? '').split(';')[0].trim() || 'unknown type';
        throw new OpError(`not an image (got ${kind})`);
      }
      return this.ingestBuffer(bytes);
    } catch (error) {
      if (error instanceof OpError) throw error;
      throw new OpError(`could not download: ${timedOut ? 'timed out' : (error.cause?.code ?? error.message)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
