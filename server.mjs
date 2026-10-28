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
import { AUDIT_TOOLS } from './lib/audit.mjs';
import { ASSET_NAME } from './lib/brainstorm.mjs';
import { BoardStore } from './lib/store.mjs';
import { createMcpHandler, createToolRunner, mcpInstructions, Presence, PRUNE_DENIED, TOOLS } from './lib/mcp.mjs';
import { PictureMaker } from './lib/colab/pictures.mjs';
import { Agent } from './lib/agent.mjs';
import { Library, libraryFile } from './lib/colab/library.mjs';
import { defaults } from './lib/defaults.mjs';
import { OpenRouter, readKey } from './lib/colab/openrouter.mjs';
import { ColabRun } from './lib/colab/run.mjs';
import { Pruner } from './lib/prune.mjs';
import { Room } from './lib/room.mjs';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const NOT_BUILT = 'Idea board is not built yet. Run: npm install && npm run build';
const ASSET_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const USAGE = 'Usage: idea-board [board-file] [--port 4777] [--no-open]\n\nboard-file defaults to ./idea-board.json';
const REMOVED = { '--no-agent': '--no-agent was removed: the server always tries the claude binary; set IDEA_BOARD_CLAUDE=/nonexistent to run without it.' };

// The command line as options; `error` is set for an option it does not know.
export function parseArgs(argv) {
  const options = { file: 'idea-board.json', port: Number(process.env.IDEA_BOARD_PORT) || 4777, open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) options.error ??= REMOVED[arg] ?? `unknown option ${arg}`;
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
async function colabRoute(run, room, pathname, req, res) {
  const { library, openrouter } = run;
  const fail = (error) => {
    if (error instanceof OpError) return sendJson(res, error.status ?? 400, { error: error.message });
    throw error;
  };
  if (pathname === '/api/colab' && req.method === 'GET') {
    sendJson(res, 200, { status: run.status, hasKey: openrouter.hasKey(), library: library.get(), defaults: defaults(), connections: room.connections() });
  } else if (pathname === '/api/colab/models' && req.method === 'GET') {
    try { sendJson(res, 200, { models: await openrouter.models() }); }
    catch (error) { sendJson(res, 502, { error: error.message }); }
  } else if (pathname === '/api/colab/image-models' && req.method === 'GET') {
    try { sendJson(res, 200, { models: await openrouter.imageModels() }); }
    catch (error) { sendJson(res, 502, { error: error.message }); }
  } else if (pathname === '/api/colab/library' && req.method === 'PUT') {
    const body = (await readBody(req)) ?? {};
    try {
      const saved = library.save({ rules: body.rules, roles: body.roles, prompts: body.prompts });
      // Role names and which cards can answer follow the library (after the run, like line-up edits).
      if (run.status.state === 'idle') room.lineupChanged();
      sendJson(res, 200, { library: saved });
    } catch (error) { fail(error); }
  } else if (pathname === '/api/colab/reset-spent' && req.method === 'POST') {
    room.resetSpent();
    sendJson(res, 200, { status: run.status });
  } else if (pathname === '/api/colab/request' && req.method === 'POST') {
    // The host's answer to the foreman's request; a second tab's answer is a 409.
    const { id, yes } = (await readBody(req)) ?? {};
    if (typeof id !== 'string' || typeof yes !== 'boolean') sendJson(res, 400, { error: 'id and yes are required' });
    else {
      try { sendJson(res, 200, room.requests.answer(id, yes)); }
      catch (error) { fail(error); }
    }
  } else if (pathname === '/api/colab/stop' && req.method === 'POST') {
    room.requests.cancel();
    run.stop();
    sendJson(res, 200, { status: run.status });
  } else return false;
  return true;
}

// `pictures` (a PictureMaker) backs generate_image; without one the tool says no image model is set.
export function createServer({ store, agent, presence, colab, room, pictures = null, port, distDir = DIST_DIR }) {
  const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  // A session only sees generate_image while Claude's role can make pictures.
  // ask_agents only while Claude holds the Foreman role.
  const listTools = () => TOOLS.filter((t) => (t.name !== 'generate_image' || pictures?.canMake('claude')) && (t.name !== 'ask_agents' || store.board.colab.lineup.claudeRoleId === 'foreman'));
  const mcp = createMcpHandler(createToolRunner(store, presence, { pictures, requests: room.requests, onSpend: () => store.emit({ type: 'colab', status: colab.status }) }), { listTools, instructions: () => mcpInstructions(presence.prompts().chat) });
  // The prune pass's own calls (/mcp?prune=<token>): tagged with its token, without the tools
  // it may not use, and with no presence, so the pass never touches an attached session's chat.
  const pruneTools = TOOLS.filter((t) => !PRUNE_DENIED.has(t.name));
  const pruneMcp = (token) => createMcpHandler(createToolRunner(store, null, { prune: token }), { listTools: () => pruneTools });

  // The audit's calls (/mcp?audit=1): read-only, and only the tools it may use.
  const auditTools = TOOLS.filter((t) => AUDIT_TOOLS.has(t.name));
  const auditMcp = createMcpHandler(createToolRunner(store, null, { readOnly: true }), { listTools: () => auditTools });

  return http.createServer(async (req, res) => {
    // Only this machine, and only this page: block DNS rebinding and
    // cross-site requests from other tabs.
    if (!allowedHosts.has(req.headers.host)) return sendJson(res, 403, { error: 'unexpected Host header' });
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return sendJson(res, 403, { error: 'cross-origin requests are not allowed' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === '/mcp') {
        if (req.method === 'POST') {
          const token = url.searchParams.get('prune');
          let handle = mcp;
          if (token) handle = pruneMcp(token);
          else if (url.searchParams.get('audit') === '1') handle = auditMcp;
          const reply = await handle(await readBody(req));
          if (reply === null) { res.writeHead(202); return res.end(); }
          return sendJson(res, 200, reply);
        }
        if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
        res.writeHead(405, { allow: 'POST, DELETE' });
        return res.end();
      }

      if (url.pathname === '/api/board' && req.method === 'GET') {
        return sendJson(res, 200, { board: store.board, presence: presence.attached(), agent: agent.running ? 'working' : 'idle', claude: agent.via() });
      }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        send({ type: 'board', board: store.board });
        send({ type: 'colab', status: colab.status });
        const unsubscribe = store.subscribe(send);
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }

      if (url.pathname === '/api/op' && req.method === 'POST') {
        const { op } = (await readBody(req)) ?? {};
        try {
          if (op?.type === 'chat') return sendJson(res, 200, room.userChat(op));
          if (op?.type === 'setColabLineup' && colab.status.state !== 'idle') throw new ConflictError('a run is in progress');
          const result = store.apply(op, 'user');
          if (op?.type === 'setColabLineup') room.lineupChanged();
          return sendJson(res, 200, result);
        } catch (error) {
          if (error instanceof OpError) return sendJson(res, error.status ?? 400, { error: error.message });
          throw error;
        }
      }

      if (url.pathname.startsWith('/api/colab')) {
        const handled = await colabRoute(colab, room, url.pathname, req, res);
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

// Claude (connection 1), the agents' run and the chat room, wired together and
// recovered after a restart. `agent` holds options for the Agent. `pictures` is the one
// PictureMaker the binary, the cards and the MCP runner share.
export function connect({ store, presence, library, openrouter, pictures, agent: agentOptions }) {
  // The run reads Claude's state through the agent, which is made first (it needs the run to stay quiet during one).
  let colab = null;
  const agent = new Agent(store, presence, {
    model: () => store.board.colab.lineup.claudeModel,
    canMakePictures: () => Boolean(pictures?.canMake('claude')),
    onRunStart: () => pictures?.newTurn('claude'),
    ...agentOptions,
    quiet: () => colab.status.state !== 'idle',
  });
  const pruner = new Pruner({ store, agent, library });
  colab = new ColabRun({ store, presence, claude: agent, library, openrouter, pictures, pruner });
  const room = new Room({ store, agent, presence, colab, library });
  // When a run ends, a user message the background agent held back is answered. Only the
  // run's own change to idle counts: a status re-sent while idle (the agent's work, a
  // session attaching) must not run the binary again for a message it failed on.
  let state = colab.status.state;
  store.subscribe((event) => {
    if (event.type !== 'colab') return;
    const ended = state !== 'idle' && event.status.state === 'idle';
    state = event.status.state;
    if (ended) agent.nudge();
  });
  // Messages owed from before the restart are answered with the next user message.
  room.recover();
  return { agent, colab, room };
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
  if (options.error) {
    console.error(`${options.error}\n\n${USAGE}`);
    process.exit(1);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  try {
    defaults();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const store = new BoardStore(options.file);
  const presence = new Presence(store);
  const mcpUrl = `http://${HOST}:${options.port}/mcp`;
  const library = new Library(libraryFile());
  const openrouter = new OpenRouter({ key: () => readKey() });
  const pictures = new PictureMaker({ store, library, openrouter });
  const { agent, colab, room } = connect({ store, presence, library, openrouter, pictures, agent: { mcpUrl, cwd: path.dirname(store.file) } });
  // Model display names for new roster entries; until it resolves they are id-based.
  void colab.prepare();
  const server = createServer({ store, agent, presence, colab, room, pictures, port: options.port });
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
    if (!agent.found) console.log(`Claude: the "claude" command was not found. To connect Claude from your own session run:\n  claude mcp add --transport http idea-board ${mcpUrl}\nthen ask Claude to "listen to the board chat".`);
    if (options.open) openBrowser(`http://${HOST}:${options.port}`);
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
