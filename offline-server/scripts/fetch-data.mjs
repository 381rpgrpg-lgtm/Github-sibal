// 본인 계정 로그인으로 평문 게임 데이터(content/scripts/packs)를 data/ 에 내려받는다.
// 사용: node scripts/fetch-data.mjs <login> <password>
// 에셋 팩(암호화)은 받지 않는다 — 복호화는 이 스크립트 범위 밖.
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const BASE = cfg.upstream;
const [login, password] = process.argv.slice(2);
if (!login || !password) { console.error('사용: node scripts/fetch-data.mjs <login> <password>'); process.exit(1); }

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const b64urlDec = (s) => Buffer.from(String(s).replace(/-/g,'+').replace(/_/g,'/'),'base64');
const DATA = new URL('../data/', import.meta.url).pathname;
const UA = 'DriftGirlsReborn/1.0.4 (Android 14)'; // 실서버는 앱 UA 가 아니면 launcher_only 로 거부한다
mkdirSync(DATA, { recursive: true });

// 로그인 시 서버가 요구하는 빌드 해시: 현재 클라이언트 페이지에서 추출
async function currentBuild() {
  // 잘못된 build 로 login 하면 426 응답 바디의 build 필드에 현재 빌드 해시가 온다.
  const r = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dg-build': 'probe', 'user-agent': UA },
    body: '{}',
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch {}
  if (!j.build) console.error(`빌드 확인 응답: HTTP ${r.status} ${text.slice(0, 200)}`);
  return j.build || null;
}

let session;
async function doLogin(build) {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dg-build': build, 'user-agent': UA },
    body: JSON.stringify({ login, password }),
  });
  if (!r.ok) throw new Error('login HTTP ' + r.status + ' ' + (await r.text()));
  return { ...(await r.json()), build };
}

async function signed(path, method = 'GET', bodyObj = null) {
  const bodystr = method === 'GET' || bodyObj == null ? '' : JSON.stringify(bodyObj);
  const nonce = String(Date.now() * 1000);
  const bodyHash = createHash('sha256').update(bodystr).digest('hex');
  const msg = `${method}\n${path}\n${nonce}\n${bodyHash}`;
  const sig = b64url(createHmac('sha256', b64urlDec(session.sigKey)).update(msg).digest());
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-dg-build': session.build,
      authorization: 'Bearer ' + session.token,
      'x-dg-c': nonce, 'x-dg-s': sig, 'user-agent': UA,
    },
    body: method === 'GET' ? undefined : bodystr,
  });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
}

const build = await currentBuild();
if (!build) throw new Error('현재 빌드 해시를 확인하지 못했습니다.');
session = await doLogin(build);
console.log('로그인 성공. account', session.account?.id, 'build', build);

for (const [path, file] of [
  ['/api/content', 'content.json'],
  ['/api/scripts', 'scripts.json'],
  ['/api/scripts?lang=jp', 'scripts_jp.json'],
  ['/api/packs', 'packs.json'],
]) {
  const { status, buf } = await signed(path);
  if (status === 200) { writeFileSync(DATA + file, buf); console.log(`  ${path} -> data/${file} (${buf.length} bytes)`); }
  else console.warn(`  ${path} -> HTTP ${status} (건너뜀)`);
}
// 부트 스냅샷 시드(선택): 본인 현재 상태를 오프라인 시작점으로.
const login2 = await signed('/api/rpc', 'POST', { name: 'MsgLoginReq', body: {} });
if (login2.status === 200) { writeFileSync(DATA + 'userdata-seed.json', login2.buf); console.log('  MsgLoginReq -> data/userdata-seed.json (시작 상태 시드)'); }
console.log('완료. 에셋(암호화 팩)은 받지 않았습니다.');
