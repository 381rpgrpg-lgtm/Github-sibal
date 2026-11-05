// 오프라인 서버(8090)에서 레이스 1회 단계별 소요시간 측정. node timing.cjs <zone> <raceIndex> <pos x> <pos y> [fast]
const { chromium } = require('playwright'); const fs = require('fs');
const B = 'http://localhost:8090'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [zone, idx, px, py, mode] = process.argv.slice(2); const T0 = Date.now();
const t = () => ((Date.now() - T0) / 1000).toFixed(1);
const log = (s) => console.log(`[${t()}s] ${s}`);
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.route('**/*', (r) => { const u = new URL(r.request().url()); if (u.protocol === 'data:' || u.protocol === 'blob:' || (u.hostname === 'localhost' && u.port === '8090')) return r.continue(); return r.abort(); });
  let hub = false, result = null;
  page.on('request', (r) => { if (!r.url().endsWith('/api/rpc')) return; const pd = r.postData() || ''; const n = (pd.match(/"name":"(\w+)"/) || [])[1];
    if (n === 'MsgSpecialMessageListReq') hub = true; if (/Battle/.test(n)) log('REQ ' + n); });
  page.on('response', async (res) => { try { if (!res.url().endsWith('/api/rpc')) return; const req = JSON.parse(res.request().postData() || '{}');
    if (req.name === 'MsgBattleResultReq') { result = req.body; log(`RESULT win=${req.body.IsPlayerWin} time=${(+req.body.TimeRecord).toFixed(2)} opp=${(+req.body.OpponentTimeRecord).toFixed(2)}`); } } catch {} });
  log('browser up'); await page.goto(B + '/', { waitUntil: 'domcontentloaded' }); log('page loaded');
  await page.waitForSelector('input', { timeout: 180000 }); const ins = await page.$$('input');
  await ins[0].fill('damissi'); await ins[1].fill('offline'); await ins[1].press('Enter'); log('login sent');
  for (let i = 0; i < 300 && !hub; i++) await sleep(200); log('hub reached');
  await sleep(8000); for (let i = 0; i < 3; i++) { await page.mouse.click(1240, 103); await sleep(2500); }
  await page.mouse.click(640, 590); await sleep(2000); await page.mouse.click(1052, 100); await sleep(2000); log('popups closed');
  await page.mouse.click(1030, 640); await sleep(15000); await page.mouse.click(350, 612); await sleep(3000); await page.mouse.click(968, 468); await sleep(2000); log('race map'); await page.screenshot({path: __dirname + '/tm1.png'}).catch(()=>{});
  await page.evaluate(fs.readFileSync(__dirname + '/driver4.js', 'utf8'));
  await page.mouse.click(+px, +py); await sleep(5000); log('node panel'); await page.screenshot({path: __dirname + '/tm2.png'}).catch(()=>{});
  await page.mouse.click(190, 657); log('start clicked');
  let last = null;
  for (let i = 0; i < 3000 && !result; i++) {
    const st = await page.evaluate('JSON.stringify(globalThis.__dgRace ? {s: __dgRace.raceState, c: __dgRace.countdown != null, rt: +(__dgRace.realRacingTime||0).toFixed(1)} : null)').catch(() => null);
    const k = st && JSON.parse(st); const key = k ? `${k.s}/${k.c}` : 'none';
    if (key !== last) { log('state ' + key + (k ? ' racetime ' + k.rt : '')); last = key; }
    if (k && k.s < 2 && !k.c && i % 12 === 0) await page.mouse.click(1240, 672); // 대화 넘기기
    if (mode === 'fast' && k && k.s === 2 && !globalThis.__ff) { globalThis.__ff = 1; log('FAST-FORWARD on'); await page.evaluate(`(() => { const r = globalThis.__dgRace; const step = () => { let n = 0; while (r.raceState === 2 && n++ < 400) r.advance(0.02); if (r.raceState === 2) setTimeout(step, 0); }; step(); })()`); }
    await sleep(250);
  }
  log('done'); await browser.close();
})();
