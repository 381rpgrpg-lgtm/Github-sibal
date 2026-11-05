// 실시간 대전(Live Duel) 웹소켓 /api/pvp.
// 클라이언트(PvpClient, 클라이언트 코드 #open/#socket): 같은 서버의 /api/pvp 로 접속 -> 서버 {t:'hello', nonce, time, v}
//   -> 클라이언트 {t:'auth', token, sig = HMAC(세션 sigKey, "ws\n"+nonce)} -> 서버 {t:'welcome', ...} 뒤로 queue·room·race 등 JSON 메시지.
// 기록 모드(DG_RECORD=1): 실서버 /api/pvp 로 그대로 중계하고, 클라이언트의 auth 만 실서버 세션 토큰·서명으로 바꿔 끼운다.
//   모든 프레임을 data/recorded-ws/<시각>_pvp.jsonl 에 남긴다 (오프라인 대전 서버 구현의 근거).
// 오프라인 모드(실서버 없음): 로컬 대전 서버(src/pvplocal.ts)가 직접 처리한다. 상대는 봇(같은 서버에 접속한 다른 계정이면 사람끼리).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Upstream } from './upstream.js';
import { serveLocalPvp, type PvpLocalDeps } from './pvplocal.js';

const REC_DIR = new URL('../data/recorded-ws/', import.meta.url).pathname;
const wss = new WebSocketServer({ noServer: true });

export function handlePvpUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, upstream: Upstream | null, local?: PvpLocalDeps): boolean {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path !== '/api/pvp') return false;
  if (!upstream) {
    // 오프라인: 로컬 대전 서버 (local 이 없으면 예전처럼 닫는다)
    if (!local) { socket.destroy(); return true; }
    wss.handleUpgrade(req, socket, head, (client) => serveLocalPvp(client, local));
    return true;
  }
  wss.handleUpgrade(req, socket, head, (client) => relay(client, upstream));
  return true;
}

function relay(client: WebSocket, upstream: Upstream) {
  mkdirSync(REC_DIR, { recursive: true });
  const file = join(REC_DIR, `${Date.now()}_pvp.jsonl`);
  const rec = (dir: string, data: string) => { try { appendFileSync(file, JSON.stringify({ t: Date.now(), dir, data: data.slice(0, 20000) }) + '\n'); } catch { /* 기록 실패는 무시 */ } };
  const up = new WebSocket(upstream.base_.replace(/^http/, 'ws') + '/api/pvp');
  let nonce = '';
  const pending: string[] = [];
  up.on('open', () => { rec('up-open', ''); for (const m of pending.splice(0)) up.send(m); });
  up.on('message', (raw) => {
    const s = String(raw);
    rec('<', s);
    try { const j = JSON.parse(s); if (j.t === 'hello') nonce = String(j.nonce ?? ''); } catch { /* JSON 아님 */ }
    if (client.readyState === WebSocket.OPEN) client.send(s);
  });
  client.on('message', async (raw) => {
    let s = String(raw);
    try {
      const j = JSON.parse(s);
      if (j.t === 'auth') { s = JSON.stringify(await upstream.wsAuth(nonce)); rec('>', JSON.stringify({ t: 'auth', note: 'replaced with upstream token/sig' })); }
      else rec('>', s);
    } catch { rec('>', s); }
    if (up.readyState === WebSocket.OPEN) up.send(s); else pending.push(s);
  });
  const closeBoth = (who: string, code?: number, reason?: string) => {
    rec('close', JSON.stringify({ who, code, reason: String(reason ?? '') }));
    try { client.close(); } catch { /* */ }
    try { up.close(); } catch { /* */ }
  };
  up.on('close', (c, r) => closeBoth('upstream', c, String(r)));
  client.on('close', (c, r) => closeBoth('client', c, String(r)));
  up.on('error', (e) => { rec('error', 'upstream ' + e.message); closeBoth('upstream-error'); });
  client.on('error', (e) => { rec('error', 'client ' + e.message); closeBoth('client-error'); });
}
