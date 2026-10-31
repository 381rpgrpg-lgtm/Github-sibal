// 로컬 권위 서버 진입점. HTTP 라우팅만 (WebSocket /api/pvp 는 실시간 단계에서 추가).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { SqliteStore } from './db.js';
import { Auth } from './auth.js';
import { loadGameData } from './content.js';
import { dispatch, type Ctx } from './rpc.js';
import './handlers/boot.js';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
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
