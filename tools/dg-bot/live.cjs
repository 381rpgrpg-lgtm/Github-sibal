// 상주형 하네스: 브라우저를 띄워 로그인해 두고, cmd.json 이 생기면 실행 후 done.json 에 결과를 쓴다.
// cmd.json: {"id":n, "actions":[{"click":[x,y]}|{"wait":ms}|{"shot":"name"}|{"key":"Escape"}]}
const { chromium } = require('playwright');
const fs = require('fs');
const DIR = process.argv[2];
const log = (s) => fs.appendFileSync(`${DIR}/live.log`, `[${new Date().toISOString().slice(11, 19)}] ${s}\n`);
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.protocol === 'data:' || u.protocol === 'blob:' || (u.hostname === 'localhost' && u.port === '8080')) return r.continue();
    log('BLOCKED ' + r.request().url()); return r.abort();
  });
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !m.text().includes('api/pvp')) log(`console.${m.type()} ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => log('pageerror ' + String(e).slice(0, 300)));
  if (process.env.FAKE_DGA) {
    // 앱(APK)의 DGAndroid 브리지를 흉내낸다 (note 호출을 로그로 남김)
    await page.exposeFunction('__fakeNote', (k, v) => log(`DGAndroid.note ${k}=${String(v).slice(0, 120)}`));
    await page.addInitScript(() => {
      const ok = (o) => JSON.stringify(o);
      window.DGAndroid = {
        info: () => ok({ version: '1.0.4', versionCode: 5, build: 'x' }), safeArea: () => ok({ left: 0, top: 0, right: 0, bottom: 0 }),
        safeMode: () => ok({ level: 0, id: 0 }), syncPacks: () => ok({ state: 'done', total: 0, done: 0 }), packStatus: () => ok({ state: 'done' }),
        pausePacks() {}, dropPack() {}, repairClient() {}, openExternal() {}, setLanguage() {}, setCompatibilityMode() {}, exit() {},
        note: (k, v) => { try { window.__fakeNote(k, v); } catch (e) {} },
      };
    });
  }
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input', { timeout: 90000 });
  const ins = await page.$$('input');
  await ins[0].fill('damissi'); await ins[1].fill('offline'); await ins[1].press('Enter');
  log('login submitted');
  fs.writeFileSync(`${DIR}/ready`, '1');
  let last = -1;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const f = `${DIR}/cmd.json`;
    if (!fs.existsSync(f)) continue;
    let cmd; try { cmd = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (cmd.id === last) continue;
    last = cmd.id;
    if (cmd.quit) break;
    for (const a of cmd.actions || []) {
      try {
        if (a.wait) await page.waitForTimeout(a.wait);
        if (a.click) { await page.mouse.click(a.click[0], a.click[1]); log(`click ${a.click} ${a.note || ''}`); }
        if (a.key) { await page.keyboard.press(a.key); log('key ' + a.key); }
        if (a.eval) { const r = await page.evaluate(a.eval); log('eval ' + JSON.stringify(r).slice(0, 1500)); }
        if (a.down) { await page.keyboard.down(a.down); log('down ' + a.down); }
        if (a.up) { await page.keyboard.up(a.up); log('up ' + a.up); }
        if (a.shot) { await page.screenshot({ path: `${DIR}/${a.shot}.png` }); log('shot ' + a.shot); }
      } catch (e) { log('action error ' + e); }
    }
    fs.writeFileSync(`${DIR}/done.json`, JSON.stringify({ id: cmd.id }));
  }
  await browser.close();
})();
