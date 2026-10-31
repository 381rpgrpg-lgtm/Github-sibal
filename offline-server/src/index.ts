// 로컬 권위 서버 진입점. HTTP 라우팅만 (WebSocket /api/pvp 는 실시간 단계에서 추가).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { SqliteStore } from './db.js';
import { Auth } from './auth.js';
import { loadGameData } from './content.js';
import { dispatch, type Ctx } from './rpc.js';
import './handlers/boot.js';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const CLIENT_DIR = new URL('../data/client/', import.meta.url).pathname;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

// 평문 웹 클라이언트 서빙 (data/client/). 사용자가 scripts/fetch-client.mjs 로 채운다.
function serveClient(res: ServerResponse, relPath: string): boolean {
  const rel = relPath === '/' ? 'index.html' : normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\//, '');
  const file = join(CLIENT_DIR, rel);
  if (!file.startsWith(CLIENT_DIR) || !existsSync(file) || !statSync(file).isFile()) return false;
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  createReadStream(file).pipe(res);
  return true;
}
const store = new SqliteStore(new URL('../data/state.db', import.meta.url).pathname);
const auth = new Auth(!!cfg.strictSignatures);
const data = loadGameData();

function json(res: ServerResponse, status: number, obj: unknown) {
  const s = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
  });
  res.end(s);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') return json(res, 204, {});

    // 공개(인증 불필요)
    if (path === '/api/login' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { session } = auth.login(String(body.login ?? ''), String(body.password ?? ''));
      return json(res, 200, {
        token: session.token,
        sigKey: session.sigKey,
        expires: session.expires,
        time: Math.floor(Date.now() / 1000),
        assetBase: '/a/local/',
        packs: data.packs ? 'local' : 'none',
        content: data.content?.version ?? 'local',
        account: { id: session.accountId, Charname: body.login ?? 'Player' },
      });
    }
    // api/client 매니페스트: data/client/api-client.json 그대로
    if (path === '/api/client' && method === 'GET') {
      const mf = join(CLIENT_DIR, 'api-client.json');
      if (existsSync(mf)) return json(res, 200, JSON.parse(readFileSync(mf, 'utf8')));
      return json(res, 503, { error: 'client_not_fetched' });
    }
    // 웹 클라이언트 정적 파일 (/, /static/*, /favicon 등). 인증 불필요.
    if (method === 'GET' && (path === '/' || path.startsWith('/static/') || path === '/index.html')) {
      if (serveClient(res, path)) return;
      return json(res, 503, { error: 'client_not_fetched', hint: 'run: node scripts/fetch-client.mjs' });
    }

    if (path === '/api/content' && method === 'GET') return json(res, 200, data.content);
    if (path === '/api/scripts' && method === 'GET') {
      const jp = url.searchParams.get('lang') === 'jp';
      const scr = jp ? data.scriptsJp : data.scripts;
      if (!scr) return json(res, 503, { error: 'scripts_not_loaded' });
      return json(res, 200, scr);
    }
    if (path === '/api/packs' && method === 'GET') {
      if (!data.packs) return json(res, 503, { error: 'packs_not_loaded' });
      return json(res, 200, data.packs);
    }

    // 인증 필요
    const body = method === 'GET' ? '' : await readBody(req);
    const session = auth.verify({
      method,
      path,
      search: url.search,
      body,
      headers: req.headers as Record<string, string | undefined>,
    });
    if (!session) return json(res, 401, { error: 'unauthorized' });

    if (path === '/api/session') return json(res, 200, { ok: true, account: session.accountId });

    if (path === '/api/rpc' && method === 'POST') {
      const { name, body: msgBody } = JSON.parse(body || '{}');
      const ctx: Ctx = { store, data, session, cheat: cfg.cheat };
      const result = await dispatch(String(name), msgBody ?? {}, ctx);
      return json(res, 200, result);
    }

    return json(res, 404, { error: 'not_found', path });
  } catch (e) {
    console.error('[server] error', e);
    return json(res, 500, { error: String((e as Error).message) });
  }
});

server.listen(cfg.port, () => {
  console.log(`offline-server listening on http://localhost:${cfg.port}`);
  console.log(`  strictSignatures=${cfg.strictSignatures}  cheat.enabled=${cfg.cheat?.enabled}`);
});
