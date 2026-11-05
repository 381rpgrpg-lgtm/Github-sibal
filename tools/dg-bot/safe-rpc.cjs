// 단일 RPC (안전 관문 경유): node safe-rpc.cjs <Msg> '<json body>'  — 로그인으로 보호 목록·캐시 기준을 먼저 잡는다
const S = require('./safety.cjs'); S.init(__dirname + '/run', (s) => console.log(s));
const B = 'http://localhost:8080';
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const rpc = async (n, b) => { const c = await S.beforeSend(n, b); if (!c.ok) return []; const m = (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || []; S.onResponse(n, b, m); return m; };
  await rpc('MsgLoginReq', {});
  const [n, b] = [process.argv[2], JSON.parse(process.argv[3] || '{}')];
  for (const x of await rpc(n, b)) { const v = { ...x.body }; if (v.UserInfo) v.UserInfo = { Cash: v.UserInfo.Cash, Coin: v.UserInfo.Coin, ItemSlotNum: v.UserInfo.ItemSlotNum, PartsSlotNum: v.UserInfo.PartsSlotNum, GarageSize: v.UserInfo.GarageSize }; console.log(x.name, JSON.stringify(v).slice(0, 700)); }
})();
