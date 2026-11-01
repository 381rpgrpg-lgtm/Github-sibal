// 본인 계정 로그인으로 암호화된 에셋 팩(.dgp)을 data/packs/ 로 내려받고 sha256 검증한다.
// 사용: node scripts/fetch-packs.mjs <login> <password> [--concurrency N]
//
// - /api/packs 매니페스트를 받아 data/packs.json 에 저장하고, 각 팩 본체
//   (/a/<assetBase>/pack/<id>.dgp)를 data/packs/<id>.dgp 로 받는다.
// - 복호화하지 않는다. api/keys(복호화 키)는 호출하지 않는다. 받은 파일은 암호화 상태 그대로다.
// - 재개 가능(이미 있고 크기+sha256 일치하면 건너뜀), 실패 시 지수 백오프 재시도.
//
// 참고: 서버는 요청 User-Agent 로 웹브라우저를 막는다(launcher_only 게이트). 게임
// 클라이언트의 UA 를 그대로 보내 자기식별한다 — scripts/sign.py 와 동일한 방식.
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const BASE = cfg.upstream;
const UA = 'DriftGirlsReborn/1.0.4 (Android 14)'; // 게임 클라이언트 자기식별(sign.py 와 동일)

const argv = process.argv.slice(2);
const login = argv[0], password = argv[1];
const ci = argv.indexOf('--concurrency');
const CONC = ci >= 0 ? Math.max(1, parseInt(argv[ci + 1], 10) || 5) : 5;
if (!login || !password) {
  console.error('사용: node scripts/fetch-packs.mjs <login> <password> [--concurrency N]');
  process.exit(1);
}

const b64urlDec = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const DATA = new URL('../data/', import.meta.url).pathname;
const PACKDIR = DATA + 'packs/';
mkdirSync(PACKDIR, { recursive: true });

// 서버가 요구하는 현재 빌드 해시: 잘못된 build 로 login 하면 에러 바디의 build 필드로 돌아온다.
async function currentBuild() {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dg-build': 'probe', 'user-agent': UA },
    body: JSON.stringify({ login, password }),
  });
  const j = await r.json().catch(() => ({}));
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

// 인증 서명(매니페스트 엔드포인트용): message = METHOD\npath+search\nnonce\nsha256_hex(body)
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
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, buf };
}

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const haveValid = (p, size, sha) =>
  existsSync(p) && statSync(p).size === size && sha256File(p) === sha;

async function fetchPack(assetBase, pack) {
  const dest = PACKDIR + pack.id + '.dgp';
  if (haveValid(dest, pack.size, pack.sha256)) return 'skip';
  const url = BASE + assetBase + 'pack/' + pack.id + '.dgp';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length === pack.size && createHash('sha256').update(buf).digest('hex') === pack.sha256) {
          writeFileSync(dest, buf);
          return 'ok';
        }
      }
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
  return 'fail';
}

(async () => {
  const build = await currentBuild();
  if (!build) throw new Error('현재 빌드 해시를 얻지 못했습니다');
  session = await doLogin(build);
  console.log('로그인 성공. account', session.account, 'assetBase', session.assetBase);

  const man = await signed('/api/packs', 'GET');
  if (man.status !== 200) throw new Error('/api/packs HTTP ' + man.status + ' ' + man.buf.toString());
  writeFileSync(DATA + 'packs.json', man.buf);
  const manifest = JSON.parse(man.buf.toString());
  const packs = manifest.packs;
  const totalBytes = packs.reduce((a, p) => a + p.size, 0);
  console.log(`매니페스트: 팩 ${packs.length}개, ${(totalBytes / 1048576).toFixed(0)} MiB, 포맷 ${manifest.format}, version ${manifest.version}`);
  console.log('복호화하지 않습니다 — 암호화된 .dgp 를 그대로 저장합니다.');

  let done = 0, ok = 0, skip = 0;
  const failed = [];
  let idx = 0;
  async function worker() {
    while (idx < packs.length) {
      const p = packs[idx++];
      const res = await fetchPack(session.assetBase, p);
      if (res === 'ok') ok++; else if (res === 'skip') skip++; else failed.push(p.id);
      done++;
      if (done % 10 === 0 || done === packs.length) {
        console.log(`[${done}/${packs.length}] ok=${ok} skip=${skip} fail=${failed.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  console.log(`\n완료: ${ok + skip}/${packs.length} 검증 통과 (새로 받음 ${ok}, 기존 ${skip})`);
  if (failed.length) { console.error('실패:', failed); process.exit(1); }
  console.log('저장 위치: data/packs/<id>.dgp,  매니페스트: data/packs.json');
})().catch((e) => { console.error(e); process.exit(1); });
