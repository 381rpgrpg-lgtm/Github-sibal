// 코인 코팅 1회 (안전 관문 경유): node coat-once.cjs <Carid>. 결과를 run/samples-coating.jsonl 에 남긴다
const S = require('./safety.cjs'); S.init(__dirname + '/run', (s) => console.log(s));
const fs = require('fs'); const B = 'http://localhost:8080';
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const rpc = async (n, b) => { const c = await S.beforeSend(n, b); if (!c.ok) { console.log('BLOCKED', n); return []; } const m = (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || []; S.onResponse(n, b, m); return m; };
  const ud = (await rpc('MsgLoginReq', {})).find((m) => m.name === 'MsgUserData').body;
  const car = ud.Cars.CarInfo.find((c) => c.Carid === Number(process.argv[2]));
  if (!car || car.DecalIndex === -1) { console.log('no car or no decal'); return; }
  const before = { skill: car.CoatingSkill, value: car.CoatingValue, count: car.CoatingCount, cost: car.CoatingCoin, coin: ud.UserInfo.Coin };
  const a = (await rpc('MsgCarCoatingReq', { CarInfo: car, Randtype: 1 })).find((m) => m.name === 'MsgCarCoatingAns')?.body;
  const c = a?.CarInfo ?? {};
  const rec = { at: new Date().toISOString(), car: car.Carid, before, result: a?.Result, skill: c.CoatingSkill, value: c.CoatingValue, count: c.CoatingCount, nextCost: c.CoatingCoin, coin: a?.UserInfo?.Coin };
  fs.appendFileSync(__dirname + '/run/samples-coating.jsonl', JSON.stringify(rec) + '\n'); console.log(JSON.stringify(rec));
})();
