// 로컬 권위 서버 진입점. HTTP 라우팅만 (WebSocket /api/pvp 는 실시간 단계에서 추가).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, createReadStream, statSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { SqliteStore } from './db.js';
import { Auth, signResponse, type Session } from './auth.js';
import { loadGameData } from './content.js';
import { dispatch, type Ctx } from './rpc.js';
import { Upstream } from './upstream.js';
import { buildPatchedClient } from './clientpatch.js';
import './handlers/boot.js';
import './handlers/main.js';
import './handlers/mail.js';
import './handlers/girls.js';
import './handlers/battle.js';
import './handlers/shop.js';
import './handlers/garage.js';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const CLIENT_DIR = new URL('../data/client/', import.meta.url).pathname;
const ASSET_DIR = new URL('../data/', import.meta.url).pathname; // data/assets/** (사용자가 제공한 평문 에셋)
const ASSET_BASE = '/a/local/';
const TABLE_DIR = new URL('../data/tables/', import.meta.url).pathname; // decrypted/data/*.json
const missLog = new Map<string, number>(); // 서빙 실패한 경로 (연결 검증용)
const PLAINTEXT_ASSETS = existsSync(join(ASSET_DIR, 'assets'));
const DIAG_DIR = new URL('../data/diag/', import.meta.url).pathname;
const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname; // PWA 아이콘 (원본 APK 런처 아이콘)
// 웹 클라이언트 호환성 패치 (src/clientpatch.ts). 앱은 이 build/해시 기준으로 파일을 검증·갱신한다.
const patchedClient = buildPatchedClient(CLIENT_DIR, {
  pictureMode: cfg.client?.pictureMode ?? 'auto',
  carEffects: cfg.client?.carEffects ?? 'on',
  glTrace: cfg.client?.glTrace ?? 'off',
  appOnly: cfg.client?.appOnly !== false,
});
for (const a of patchedClient.applied) console.log('[client] 패치 적용:', a);
function clientBuild(): string | null {
  return patchedClient.build;
}
// 통과형 서비스워커: 설치 즉시 활성화하고 fetch 를 가로채지 않는다(모든 요청은 서버로 직행).
const PASSTHROUGH_SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

// 평문 웹 클라이언트 서빙 (data/client/). 사용자가 scripts/fetch-client.mjs 로 채운다.
function serveClient(res: ServerResponse, relPath: string, root = CLIENT_DIR): boolean {
  const rel = relPath === '/' ? 'index.html' : normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\//, '');
  if (root === CLIENT_DIR) {
    const patched = patchedClient?.files.get(rel);
    if (patched) {
      res.writeHead(200, { 'content-type': MIME[rel.slice(rel.lastIndexOf('.'))] ?? 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(patched);
      return true;
    }
  }
  const file = join(root, rel);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return false;
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
const upstream = Upstream.fromEnv(cfg.upstream);
if (upstream) console.log('[record] 기록 모드 ON: 미구현 RPC 는 실서버로 보내고 data/recorded/ 에 저장');

type SignCtx = { session: Session; nonce: string } | null;

function json(res: ServerResponse, status: number, obj: unknown, sign: SignCtx = null) {
  const s = JSON.stringify(obj);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': 'x-dg-s',
  };
  // 인증 요청(x-dg-c 동반)의 응답은 서명한다 — 클라이언트가 검증함.
  if (sign) headers['x-dg-s'] = signResponse(sign.session, sign.nonce, s);
  res.writeHead(status, headers);
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
    // 요청에 토큰+nonce 가 있으면 응답에 서명한다(공개 경로여도 클라이언트가 인증 호출했으면 검증하므로).
    const bearer = auth.bearer(req.headers['authorization'] as string | undefined);
    const nonce = req.headers['x-dg-c'] as string | undefined;
    const signCtx: SignCtx = bearer && nonce ? { session: bearer, nonce } : null;
    const reply = (st: number, obj: unknown) => json(res, st, obj, signCtx);
    if (method === 'OPTIONS') return reply(204, {});

    // 공개(인증 불필요)
    // 앱(APK) 부팅: ClientCache.prepare() 가 먼저 /api/version 의 build 를 확인하고, 없으면 "Cannot connect to server".
    if (path === '/api/version' && method === 'GET') {
      return reply(200, { build: clientBuild(), maintenance: null, time: Date.now() / 1000 });
    }
    // 앱 자체 업데이트 확인(ShellUpdater): 설치된 버전과 같은 값을 돌려줘 업데이트 안내가 뜨지 않게 한다.
    if (path === '/android/version.json' && method === 'GET') {
      return reply(200, { versionCode: 5, versionName: '1.0.4', minVersionCode: 4, apk: '', size: 0, sha256: '', notes: '' });
    }
    // 앱 진단 기록(Diag.send): 로컬에 저장만 한다(크래시 분석용).
    if (path === '/android/diag' && method === 'POST') {
      const body = await readBody(req);
      mkdirSync(DIAG_DIR, { recursive: true });
      writeFileSync(join(DIAG_DIR, `diag-${Date.now()}.json`), body);
      console.log(`[diag] 앱 진단 기록 저장 (${body.length} bytes)`);
      return reply(200, { ok: true });
    }
    // 진단 보조: 클라이언트 위치 표식(where/gpu). 앱이 튕겨도 마지막 위치가 서버 로그에 남는다.
    if (path === '/__offline/where' && method === 'POST') {
      const body = await readBody(req);
      try {
        const j = JSON.parse(body);
        console.log(`[where] ${j.k}: ${String(j.v).slice(0, 200)}`);
        mkdirSync(DIAG_DIR, { recursive: true });
        appendFileSync(join(DIAG_DIR, 'where.log'), `${new Date(Number(j.t) || Date.now()).toISOString()} ${j.k} ${j.v}\n`);
      } catch { /* 무시 */ }
      res.writeHead(204); return res.end();
    }
    // GL 추적·프레임 측정 (src/gltrace.ts). first/ctx/prog 는 파일에만, perf 는 콘솔에도 한 줄로.
    if (path === '/__offline/gltrace' && method === 'POST') {
      const body = await readBody(req);
      try {
        const j = JSON.parse(body);
        const line = `${new Date(Number(j.t) || Date.now()).toISOString()} ${j.k} ${j.n ?? ''} ${j.v ?? ''}${j.i ? ' ' + JSON.stringify(j.i) : ''}`;
        mkdirSync(DIAG_DIR, { recursive: true });
        appendFileSync(join(DIAG_DIR, 'gltrace.log'), line + '\n');
        if (j.k === 'perf') {
          const i = j.i ?? {};
          console.log(`[perf] ${i.fps}fps p50 ${i.p50}ms p95 ${i.p95}ms max ${i.max}ms draws/f ${i.drawsPerFrame} long ${i.longN}/${i.longMs}ms canvas ${i.canvas} dpr ${i.dpr} @${j.v}`);
        } else if (j.k === 'ctx') console.log(`[gl] ctx ${j.v}`);
      } catch { /* 무시 */ }
      res.writeHead(204); return res.end();
    }
    if (path === '/api/login' && method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { session } = auth.login(String(body.login ?? ''), String(body.password ?? ''));
      return reply(200, {
        token: session.token,
        sigKey: session.sigKey,
        expires: session.expires,
        time: Math.floor(Date.now() / 1000),
        assetBase: ASSET_BASE,
        packs: data.packs ? 'local' : 'none',
        content: data.content?.version ?? 'local',
        account: { id: session.accountId, Charname: body.login ?? 'Player' },
      });
    }
    // api/client 매니페스트: data/client/api-client.json 그대로
    if (path === '/api/client' && method === 'GET') {
      if (patchedClient.manifest) return reply(200, patchedClient.manifest);
      return reply(503, { error: 'client_not_fetched' });
    }
    // 평문 에셋: <base href>=/a/local/ 기준 상대경로 요청 → data/<경로>
    if (method === 'GET' && path.startsWith(ASSET_BASE)) {
      const rel = decodeURIComponent(path.slice(ASSET_BASE.length));
      // 클라이언트는 테이블을 <assetBase>/data/*.json 으로 요청한다 → data/tables/
      if (rel.startsWith('data/') && serveClient(res, '/' + rel.slice(5), TABLE_DIR)) return;
      if (serveClient(res, '/' + rel, ASSET_DIR)) return;
      missLog.set(rel, (missLog.get(rel) ?? 0) + 1);
      return reply(404, { error: 'asset_missing', path: rel });
    }
    if (method === 'GET' && path === '/__offline/misses') {
      return reply(200, Object.fromEntries([...missLog].sort((a, b) => b[1] - a[1])));
    }
    // PWA: Chrome 에서 '홈 화면에 추가' 하면 주소창 없는 전체 화면·가로로 실행된다.
    //   (2026-11-01 실기기: 같은 폰에서 앱 WebView 는 10fps·드라이버 크래시, Chrome 은 60fps·크래시 없음)
    if (method === 'GET' && path === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(JSON.stringify({
        name: 'Drift Girls Reborn (Offline)', short_name: 'Drift Girls', id: '/', start_url: '/', scope: '/',
        display: 'fullscreen', orientation: 'landscape', background_color: '#000000', theme_color: '#000000',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      }));
    }
    if (method === 'GET' && /^\/icons\/icon(-maskable)?-(192|512)\.png$/.test(path)) {
      const f = join(PUBLIC_DIR, path.slice('/icons/'.length));
      if (existsSync(f)) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
        return res.end(readFileSync(f));
      }
    }
    // 웹 클라이언트 정적 파일 (/, /static/*, /favicon 등). 인증 불필요.
    if (method === 'GET' && (path === '/' || path.startsWith('/static/') || path === '/index.html')) {
      if (serveClient(res, path)) return;
      return reply(503, { error: 'client_not_fetched', hint: 'run: node scripts/fetch-client.mjs' });
    }

    if (path === '/api/content' && method === 'GET') return reply(200, data.content);
    if (path === '/api/scripts' && method === 'GET') {
      const jp = url.searchParams.get('lang') === 'jp';
      const scr = jp ? data.scriptsJp : data.scripts;
      if (!scr) return reply(503, { error: 'scripts_not_loaded' });
      return reply(200, scr);
    }
    // 평문 에셋 모드(data/assets 존재): 내려받을 팩이 없다고 알린다 → 클라이언트는 /a/local/ 평문 경로를 직접 요청.
    if (path === '/api/packs' && method === 'GET') {
      if (PLAINTEXT_ASSETS) {
        return reply(200, { format: 1, version: 'plaintext-local', created: 0, hashLength: 0, packs: [], paths: {} });
      }
      if (!data.packs) return reply(503, { error: 'packs_not_loaded' });
      return reply(200, data.packs);
    }
    // 서비스워커: 자체 작성한 통과형(가로채지 않음). 원본 sw.js 는 사용하지 않는다.
    if (path === '/sw.js' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'service-worker-allowed': '/' });
      return res.end(PASSTHROUGH_SW);
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
    if (!session) return reply(401, { error: 'unauthorized' });

    if (path === '/api/session') return reply(200, { ok: true, account: session.accountId });

    if (path === '/api/rpc' && method === 'POST') {
      const { name, body: msgBody } = JSON.parse(body || '{}');
      const ctx: Ctx = { store, data, session, cheat: cfg.cheat, showNotices: !!cfg.showNotices, upstream };
      const result = await dispatch(String(name), msgBody ?? {}, ctx);
      return reply(200, result);
    }

    // 공지/뉴스: 오프라인에서는 비어 있음 (형식은 실서버 응답과 동일, build 필드는 넣지 않음)
    const now = Date.now() / 1000;
    if (path === '/api/notices/active' && method === 'GET') return reply(200, { notices: [], special: null, time: now });
    if (path === '/api/news' && method === 'GET') return reply(200, { items: [], due: null, time: now });
    if (path === '/api/news/seen' && method === 'POST') return reply(200, { ok: true, time: now });

    return reply(404, { error: 'not_found', path });
  } catch (e) {
    console.error('[server] error', e);
    return json(res, 500, { error: String((e as Error).message) });
  }
});

server.listen(cfg.port, () => {
  console.log(`offline-server listening on http://localhost:${cfg.port}`);
  console.log(`  strictSignatures=${cfg.strictSignatures}  cheat.enabled=${cfg.cheat?.enabled}`);
});
