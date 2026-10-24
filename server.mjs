#!/usr/bin/env node
// Idea board: serves the whiteboard page, keeps it live over server-sent
// events, and exposes the board to Claude as an MCP server at /mcp.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_ASSET_BYTES } from './lib/assets.mjs';
import { ConflictError, OpError } from './lib/board.mjs';
import { ASSET_NAME } from './lib/brainstorm.mjs';
import { BoardStore } from './lib/store.mjs';
import { createMcpHandler, createToolRunner, Presence } from './lib/mcp.mjs';
import { Agent } from './lib/agent.mjs';
import { Library, libraryFile } from './lib/colab/library.mjs';
import { OpenRouter, readKey } from './lib/colab/openrouter.mjs';
import { ColabRun } from './lib/colab/run.mjs';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const NOT_BUILT = 'Idea board is not built yet. Run: npm install && npm run build';
const ASSET_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function parseArgs(argv) {
  const options = { file: 'idea-board.json', port: Number(process.env.IDEA_BOARD_PORT) || 4777, agent: true, open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--no-agent') options.agent = false;
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else options.file = arg;
  }
  return options;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { reject(Object.assign(new Error('body is not valid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// An uploaded picture, read as raw bytes. Past the cap we stop buffering and
// let the 413 answer close the connection rather than reading the rest.
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('picture is larger than 30 MB'), { status: 413, closeConnection: true });
    if (Number(req.headers['content-length']) > maxBytes) return reject(tooLarge());
    let size = 0;
    const chunks = [];
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.off('data', onData);
        chunks.length = 0;
        reject(tooLarge());
      } else chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

// The /api/colab routes. Returns false for a path it does not own.
async function colabRoute(run, pathname, req, res) {
  const { library, openrouter } = run;
  const fail = (error) => {
    if (error instanceof OpError) return sendJson(res, error.status ?? 400, { error: error.message });
    throw error;
  };
  if (pathname === '/api/colab' && req.method === 'GET') {
    sendJson(res, 200, { status: run.status, hasKey: openrouter.hasKey(), library: library.get() });
  } else if (pathname === '/api/colab/models' && req.method === 'GET') {
    try { sendJson(res, 200, { models: await openrouter.models() }); }
    catch (error) { sendJson(res, 502, { error: error.message }); }
  } else if (pathname === '/api/colab/library' && req.method === 'PUT') {
    const body = (await readBody(req)) ?? {};
    try { sendJson(res, 200, { library: library.save({ rules: body.rules, roles: body.roles }) }); }
    catch (error) { fail(error); }
  } else if (pathname === '/api/colab/start' && req.method === 'POST') {
    if (run.status.state !== 'idle') return sendJson(res, 409, { error: 'an agent run is already in progress' }), true;
    if (!openrouter.hasKey()) return sendJson(res, 400, { error: 'No OpenRouter key found. Set OPENROUTER_API_KEY or put the key in ~/.config/openrouter/key.' }), true;
    try { await run.prepare(); run.start(); sendJson(res, 200, { status: run.status }); }
    catch (error) { fail(error); }
  } else if (pathname === '/api/colab/stop' && req.method === 'POST') {
    run.stop();
    sendJson(res, 200, { status: run.status });
  } else return false;
  return true;
}

export function createServer({ store, agent, presence, colab, port, distDir = DIST_DIR }) {
  const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const mcp = createMcpHandler(createToolRunner(store, presence));

  return http.createServer(async (req, res) => {
    // Only this machine, and only this page: block DNS rebinding and
    // cross-site requests from other tabs.
    if (!allowedHosts.has(req.headers.host)) return sendJson(res, 403, { error: 'unexpected Host header' });
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return sendJson(res, 403, { error: 'cross-origin requests are not allowed' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === '/mcp') {
        if (req.method === 'POST') {
          const reply = await mcp(await readBody(req));
          if (reply === null) { res.writeHead(202); return res.end(); }
          return sendJson(res, 200, reply);
        }
        if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
        res.writeHead(405, { allow: 'POST, DELETE' });
        return res.end();
      }

      if (url.pathname === '/api/board' && req.method === 'GET') {
        return sendJson(res, 200, { board: store.board, presence: presence.attached(), agent: agent ? (agent.running ? 'working' : 'idle') : 'off' });
      }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        send({ type: 'board', board: store.board });
        if (colab) send({ type: 'colab', status: colab.status });
        const unsubscribe = store.subscribe(send);
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }

      if (url.pathname === '/api/op' && req.method === 'POST') {
        const { op } = (await readBody(req)) ?? {};
        try {
          if (op?.type === 'setColabLineup' && colab && colab.status.state !== 'idle') throw new ConflictError('a run is in progress');
          const result = store.apply(op, 'user');
          if (op.type === 'chat') agent?.nudge();
          return sendJson(res, 200, result);
        } catch (error) {
          if (error instanceof OpError) return sendJson(res, error.status ?? 400, { error: error.message });
          throw error;
        }
      }

      if (colab && url.pathname.startsWith('/api/colab')) {
        const handled = await colabRoute(colab, url.pathname, req, res);
        if (handled) return;
      }

      if (url.pathname === '/api/undo' && req.method === 'POST') return sendJson(res, 200, store.undo());
      if (url.pathname === '/api/redo' && req.method === 'POST') return sendJson(res, 200, store.redo());

      if (url.pathname === '/api/undo-turn' && req.method === 'POST') {
        const { turn } = (await readBody(req)) ?? {};
        if (typeof turn !== 'string' || !turn) return sendJson(res, 400, { error: 'turn is required' });
        return sendJson(res, 200, store.undoTurn(turn));
      }

      if (url.pathname === '/api/history' && req.method === 'GET') {
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
        const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
        if (!Number.isInteger(limit) || limit < 1 || (before !== undefined && !Number.isInteger(before))) {
          return sendJson(res, 400, { error: 'limit and before must be whole numbers' });
        }
        return sendJson(res, 200, store.history({ limit: Math.min(limit, 500), before }));
      }

      if (url.pathname === '/api/versions') {
        if (req.method === 'GET') return sendJson(res, 200, { versions: store.versions.list() });
        if (req.method === 'POST') {
          const { name } = (await readBody(req)) ?? {};
          if (typeof name !== 'string' || !name.trim()) return sendJson(res, 400, { error: 'name is required' });
          return sendJson(res, 200, { version: store.saveVersion(name.trim().slice(0, 200), 'user') });
        }
      }

      const versionRoute = /^\/api\/versions\/([^/]+?)(\/restore)?$/.exec(url.pathname);
      if (versionRoute) {
        const [, id, restore] = versionRoute;
        if (!restore && req.method === 'GET') return sendJson(res, 200, store.versions.read(id));
        if (restore && req.method === 'POST') return sendJson(res, 200, store.restoreVersion(id, 'user'));
      }

      if (url.pathname === '/api/export' && req.method === 'POST') return sendJson(res, 200, { path: store.exportDesignDoc() });

      if (url.pathname === '/api/assets' && req.method === 'POST') {
        const bytes = await readRawBody(req, MAX_ASSET_BYTES);
        try { return sendJson(res, 200, { asset: store.assets.ingestBuffer(bytes).asset }); }
        catch (error) {
          if (error instanceof OpError) return sendJson(res, 400, { error: error.message });
          throw error;
        }
      }

      if (url.pathname === '/api/assets/url' && req.method === 'POST') {
        const { url: address } = (await readBody(req)) ?? {};
        if (typeof address !== 'string' || !address.trim()) return sendJson(res, 400, { error: 'url is required' });
        try { return sendJson(res, 200, { asset: (await store.assets.ingestUrl(address.trim())).asset }); }
        catch (error) {
          if (error instanceof OpError) return sendJson(res, error.status ?? 400, { error: error.message });
          throw error;
        }
      }

      if (url.pathname.startsWith('/assets/') && req.method === 'GET') {
        // The name is checked before the disk is touched, so nothing but a
        // stored picture can ever be served from here.
        const name = url.pathname.slice('/assets/'.length);
        if (!ASSET_NAME.test(name)) return sendJson(res, 400, { error: 'not a picture file name' });
        let bytes;
        try { bytes = store.assets.read(name); }
        catch (error) {
          if (error.code === 'ENOENT') return sendJson(res, 404, { error: 'not found' });
          throw error;
        }
        res.writeHead(200, {
          'content-type': ASSET_TYPES[name.slice(name.lastIndexOf('.') + 1)],
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'content-length': bytes.length,
        });
        return res.end(bytes);
      }

      if (req.method === 'GET') {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!fs.existsSync(path.join(distDir, 'index.html'))) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end(NOT_BUILT);
        }
        const file = path.join(distDir, name);
        if (!file.startsWith(distDir + path.sep) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        return fs.createReadStream(file).pipe(res);
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      if (!res.headersSent) {
        if (error.closeConnection) res.setHeader('connection', 'close');
        sendJson(res, error.status || 500, { error: error.message });
      }
      if (!error.status) console.error(error);
    }
  });
}

/** The command that opens `url` in the default browser on `platform` (a process.platform value). */
export function browserCommand(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  // start is built into cmd; its first quoted argument is a window title, hence the empty one.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

function openBrowser(url) {
  const { command, args } = browserCommand(process.platform, url);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    // No browser opener (a server with no desktop, say): the URL is printed anyway.
    child.on('error', () => {});
    child.unref();
  } catch {
    // As above.
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: idea-board [board-file] [--port 4777] [--no-agent] [--no-open]\n\nboard-file defaults to ./idea-board.json');
    return;
  }
  const store = new BoardStore(options.file);
  const presence = new Presence(store);
  const mcpUrl = `http://${HOST}:${options.port}/mcp`;
  const library = new Library(libraryFile());
  const openrouter = new OpenRouter({ key: () => readKey() });
  const colab = new ColabRun({ store, presence, library, openrouter });
  const agent = options.agent ? new Agent(store, presence, { mcpUrl, cwd: path.dirname(store.file), quiet: () => colab.status.state !== 'idle' }) : null;
  // When a run ends, a user message the background agent held back is answered.
  store.subscribe((event) => { if (event.type === 'colab' && event.status.state === 'idle') agent?.nudge(); });
  colab.recoverAfterRestart();
  const server = createServer({ store, agent, presence, colab, port: options.port });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${options.port} is in use. Try --port <other>.` : error.message);
    process.exit(1);
  });
  // Coalesced typing may still be waiting to be written to the history file.
  const shutdown = () => {
    store.historyLog.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.listen(options.port, HOST, () => {
    console.log(`Idea board:  http://${HOST}:${options.port}`);
    console.log(`Board file:  ${store.file}`);
    console.log(`MCP for an interactive session:  claude mcp add --transport http idea-board ${mcpUrl}`);
    if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) console.log('Build:       npm run build   (the page is not built yet; run npm install first if needed)');
    if (!agent) console.log('Background Claude is off (--no-agent): chat waits for a session using wait_for_chat.');
    if (options.open) openBrowser(`http://${HOST}:${options.port}`);
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
