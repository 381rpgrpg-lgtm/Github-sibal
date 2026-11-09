// 운영 감시 (2026-11-09, PC 이관용): start-all.sh + run.sh + keepalive.sh 를 한 파일로 (Windows·macOS·Linux 공통).
//   node supervisor.cjs --check   점검만 (오프라인 서버 폴더, 표, 빌드, 레이스 후킹 엔진, 파이썬·Pillow, Playwright, 중계 서버, 비밀번호 변수)
//   node supervisor.cjs           중계 서버(localhost:8080, 기록 모드)와 봇 루프를 띄우고 죽으면 다시 띄운다. run/STOP 이 생기면 끝낸다.
// 환경 변수: DG_PASSWORD (실계정 비밀번호) 또는 DG_PASSWORD_FILE (비밀번호 한 줄짜리 파일, 기본: 저장소 바깥 ../../../dg-password.txt
//   = D:\dg\Github-sibal 배치면 D:\dg\dg-password.txt). 비밀번호는 저장소·로그·대화에 적지 않는다.
//   DG_LOGIN (기본 damissi), DG_SERVER_DIR, DG_PYTHON, DG_ENGINE_RACE
const fs = require('fs'), path = require('path'), { spawn, execFileSync } = require('child_process');
const DGP = require('./paths.cjs');
const RUN = path.join(__dirname, 'run');
const ENGINE = DGP.srv('data', 'client', 'static', 'engine-C3PtOFdR.js');
const ENGINE_RACE = process.env.DG_ENGINE_RACE || path.join(__dirname, 'engine-race.js');
const stamp = () => new Date().toISOString().slice(5, 19);
const note = (s) => { const line = `[${stamp()}] supervisor: ${s}`; console.log(line); try { fs.appendFileSync(path.join(RUN, 'keepalive.log'), line + '\n'); } catch {} };
const PW_FILE = process.env.DG_PASSWORD_FILE || path.resolve(__dirname, '../../../dg-password.txt');
const password = () => process.env.DG_PASSWORD || (fs.existsSync(PW_FILE) ? fs.readFileSync(PW_FILE, 'utf8').split(/\r?\n/)[0].trim() : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const relayUp = async () => { try { const r = await fetch('http://localhost:8080/api/version', { signal: AbortSignal.timeout(5000) }); return r.ok; } catch { return false; } };

async function check() {
  const rows = [];
  const ok = (name, good, detail = '') => rows.push(`${good ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  ok('offline-server folder', fs.existsSync(DGP.SERVER), DGP.SERVER);
  for (const t of ['girlTable.json', 'battleTable.json', 'parts.json', 'nquests.json', 'itemTable.json', 'cars.json']) ok(`table ${t}`, fs.existsSync(DGP.srv('data', 'tables', t)));
  ok('scripts.json', fs.existsSync(DGP.srv('data', 'scripts.json')));
  ok('src/data/date-answers.json', fs.existsSync(DGP.srv('src', 'data', 'date-answers.json')));
  ok('build dist/index.js (npm ci && npm run build)', fs.existsSync(DGP.srv('dist', 'index.js')));
  ok('client engine file', fs.existsSync(ENGINE), ENGINE);
  ok('race-hook engine available', fs.existsSync(ENGINE_RACE) || (fs.existsSync(ENGINE) && fs.readFileSync(ENGINE, 'utf8').includes('__dgRace')), ENGINE_RACE);
  try { const v = execFileSync(DGP.PY, ['-c', 'import PIL;print(PIL.__version__)'], { encoding: 'utf8' }).trim(); ok('python + Pillow', true, `${DGP.PY} Pillow ${v}`); } catch (e) { ok('python + Pillow', false, `${DGP.PY}: ${String(e.message).split('\n')[0]}`); }
  try { const { chromium } = require('playwright'); ok('playwright module', true); ok('chromium binary', fs.existsSync(chromium.executablePath()), chromium.executablePath()); } catch (e) { ok('playwright module', false, 'npm i playwright && npx playwright install chromium'); }
  ok('password (DG_PASSWORD or file)', !!password(), process.env.DG_PASSWORD ? 'env' : PW_FILE);
  ok('run/ state folder', fs.existsSync(RUN), RUN);
  ok('run/ud.json (state snapshot)', fs.existsSync(path.join(RUN, 'ud.json')));
  ok('no run/STOP', !fs.existsSync(path.join(RUN, 'STOP')));
  ok('relay :8080 (only after start)', await relayUp());
  console.log(rows.join('\n'));
  return rows.every((r) => r.startsWith('OK') || r.includes('relay :8080'));
}

let relay = null;
function startRelay() {
  const pw = password(); if (!pw) { note('password missing (DG_PASSWORD / ' + PW_FILE + '): relay not started'); return; }
  if (!fs.existsSync(ENGINE) || !fs.readFileSync(ENGINE, 'utf8').includes('__dgRace')) {
    if (fs.existsSync(ENGINE_RACE)) { fs.copyFileSync(ENGINE_RACE, ENGINE); note('race-hook engine copied into client'); }
    else note('WARN race-hook engine missing: ' + ENGINE_RACE);
  }
  const out = fs.openSync(path.join(RUN, 'relay.log'), 'a');
  relay = spawn(process.execPath, ['--no-warnings', 'dist/index.js'], {
    cwd: DGP.SERVER, stdio: ['ignore', out, out], windowsHide: true,
    env: { ...process.env, DG_RECORD: '1', DG_RECORD_ALWAYS: '*', DG_LOGIN: process.env.DG_LOGIN || 'damissi', DG_PASSWORD: pw },
  });
  relay.on('exit', (c) => { note(`relay exited ${c}`); relay = null; });
  note(`relay started pid ${relay.pid}`);
}

async function botLoop() {
  while (!fs.existsSync(path.join(RUN, 'STOP'))) {
    const t0 = Date.now();
    const out = fs.openSync(path.join(RUN, 'node.out'), 'a');
    const bot = spawn(process.execPath, [path.join(__dirname, 'bot.cjs'), RUN, '20'], { cwd: __dirname, stdio: ['ignore', out, out], windowsHide: true });
    note(`bot started pid ${bot.pid}`);
    const code = await new Promise((r) => bot.on('exit', r));
    if (fs.existsSync(path.join(RUN, 'STOP'))) break;
    const quick = Date.now() - t0 < 60e3;
    note(`bot exited ${code}${quick ? ' (quick exit -> wait 300s)' : ''}`);
    await sleep(quick ? 300e3 : 5e3);
  }
}

(async () => {
  fs.mkdirSync(RUN, { recursive: true });
  if (process.argv.includes('--check')) { process.exit((await check()) ? 0 : 1); }
  if (!(await relayUp())) { startRelay(); await sleep(4000); }
  const watch = setInterval(async () => { if (!relay && !(await relayUp()) && !fs.existsSync(path.join(RUN, 'STOP'))) startRelay(); }, 30e3);
  await botLoop();
  clearInterval(watch);
  if (relay) relay.kill();
  note('STOP: supervisor end');
})();
