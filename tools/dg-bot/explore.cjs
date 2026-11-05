// 대화형 탐색: ex/cmd.js 에 page 코드 쓰면 실행 후 ex/out.txt, ex/s.png
// 실시간 대전(웹소켓)용: DG_PROXY=1 이면 컨테이너 프록시로 외부 웹소켓 허용(인증서 무시), 모든 웹소켓 프레임을 ex/ws.jsonl 에 기록
const { chromium } = require('playwright'); const fs = require('fs');
const D = __dirname + '/ex', B = 'http://localhost:8080'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const px = process.env.DG_PROXY === '1' && (process.env.HTTPS_PROXY || process.env.https_proxy);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], ...(px ? { proxy: { server: px, bypass: 'localhost,127.0.0.1' } } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: !!px })).newPage();
  page.on('websocket', (ws) => {
    const w = (d, p) => fs.appendFileSync(D + '/ws.jsonl', JSON.stringify({ t: new Date().toISOString(), url: ws.url(), d, p: typeof p === 'string' ? p.slice(0, 4000) : '[bin]' }) + '\n');
    w('open', ''); ws.on('framesent', (f) => w('>', f.payload)); ws.on('framereceived', (f) => w('<', f.payload)); ws.on('close', () => w('close', '')); ws.on('socketerror', (e) => w('err', String(e)));
  });
  await page.route('**/*', (r) => { const u = new URL(r.request().url()); if (u.protocol === 'data:' || u.protocol === 'blob:' || (u.hostname === 'localhost' && u.port === '8080')) return r.continue(); return r.abort(); });
  const rpcs = []; page.on('request', (r) => { if (r.url().endsWith('/api/rpc')) rpcs.push((r.postData() || '').slice(0, 300)); });
  globalThis.page = page; globalThis.rpcs = rpcs; globalThis.sleep = sleep;
  fs.writeFileSync(D + '/out.txt', 'ready');
  for (;;) {
    await sleep(500);
    if (!fs.existsSync(D + '/cmd.js')) continue;
    const code = fs.readFileSync(D + '/cmd.js', 'utf8'); fs.unlinkSync(D + '/cmd.js');
    let out; try { out = await eval('(async()=>{' + code + '})()'); } catch (e) { out = 'ERR ' + e; }
    try { await page.screenshot({ path: D + '/s.png', timeout: 30000 }); } catch (e) { out += ' shotfail'; }
    fs.writeFileSync(D + '/out.txt', JSON.stringify(out) + '\nRPC:' + rpcs.splice(0).join('\n'));
  }
})();
