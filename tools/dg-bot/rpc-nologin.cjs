// 조회용 단일 RPC (MsgLoginReq 없이, 안전 관문 경유): node rpc-nologin.cjs <Msg> '<json>' — 봇 경주 중에도 상태를 건드리지 않는 조회에만 쓴다
const S = require('./safety.cjs'); S.init(__dirname + '/run', () => {});
const fs = require('fs'); const B = 'http://localhost:8080';
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const [n, b] = [process.argv[2], JSON.parse(process.argv[3] || '{}')];
  const c = await S.beforeSend(n, b); if (!c.ok) { console.log('BLOCKED'); return; }
  const m = (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || [];
  if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(m, null, 1));
  for (const x of m) console.log(x.name, JSON.stringify(x.body).slice(0, 3000));
})();
