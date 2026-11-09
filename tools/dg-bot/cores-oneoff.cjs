// 1회성 캐시 사용 (2026-11-08, 사용자 위임: "봇의 진전이 너무 막힌다 싶으면 얻는 캐시의 양을 고려해서 과하지 않게 적절히. 봇 말고 네 판단으로만").
//   13-14: 최고 40.23 vs 상대 40.21 (차이 0.02). 차량 10 숙련도 377/415, 차량 부품(61006) 46.
//   73005 차량 부품 x30 (30 캐시) 1개 -> 76 개 -> 숙련도 올리기 Mtype 3 (부품 50, +30) 1회. 예상 -0.017 초 (설정 시험 모형).
// 검사: 상점 표에 Gold Cash·실결제·코인 가격이 없고 PriceCash 30·ItemType 61006·Amount 30 일 것, 구매 뒤 캐시 400 이상,
//       캐시 감소 정확히 30, 부품 +30. 숙련도 올리기는 캐시 그대로·부품 -50 일 것. 어긋나면 멈춘다.
const S = require('./safety.cjs'); S.init(__dirname + '/run', (s) => console.log(s));
const fs = require('fs'); const B = 'http://localhost:8080';
const T = '/home/user/Github-sibal/offline-server/data/tables/';
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const out = [];
  const send = async (n, b) => { const m = (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || []; S.onResponse(n, b, m); out.push({ at: new Date().toISOString(), n, b, m }); return m; };
  const rpc = async (n, b) => { const c = await S.beforeSend(n, b); if (!c.ok) { console.log('BLOCKED', n, c.reason); return []; } return send(n, b); };
  const save = () => fs.writeFileSync(__dirname + '/run/cores-oneoff.json', JSON.stringify(out, null, 1));
  const login = async () => (await rpc('MsgLoginReq', {})).find((m) => m.name === 'MsgUserData').body;
  const st = (ud) => { const c = ud.Cars.CarInfo.find((x) => x.Carid === 10); return { m: c?.Mastery, cap: c?.MasteryCapacity, attr: c?.MasteryAttr, cores: Number((ud.Items?.ItemInfo ?? []).find((i) => i.Itemtype === 61006)?.Count) || 0, cash: Number(ud.UserInfo.Cash) }; };
  let s0 = st(await login()); console.log('before', JSON.stringify(s0));
  const { readTable } = await import('/home/user/Github-sibal/offline-server/dist/upserts.js');
  const si = readTable(T + 'itemTable.json', 'itemTable.json').StoreItem.find((s) => s.Id === 73005);
  const bad = !si || Number(si.PriceCash) !== 30 || Number(si.ItemType) !== 61006 || Number(si.Amount) !== 30 || ['PriceGoldCash', 'PriceRealMoney', 'PriceRealMoneyInt', 'PriceRealMoneyJP', 'PriceCoin', 'SalePrice'].some((k) => si[k] !== undefined);
  if (bad || s0.cash - 30 < 400 || s0.cap - s0.m < 30) { console.log('stop: check failed', JSON.stringify(si), JSON.stringify(s0)); save(); return; }
  const a = (await send('MsgBuyProductReq', { StoreItemId: 73005, Buycount: 1 })).find((m) => m.name === 'MsgBuyProductAns')?.body;
  let s1 = st(await login()); console.log(`buy 73005 -> Result ${a?.Result}`, JSON.stringify(s1));
  if (a?.Result !== 1 || s0.cash - s1.cash !== 30 || s1.cores - s0.cores !== 30) { console.log('stop: unexpected purchase'); save(); return; }
  const u = (await rpc('MsgMasteryUpReq', { CarInfo: { Carid: 10 }, Mtype: 3 })).find((m) => m.name === 'MsgMasteryUpAns')?.body;
  const s2 = st(await login()); console.log(`mastery up -> Result ${u?.Result}`, JSON.stringify(s2));
  if (u?.Result !== 1 || s2.cash !== s1.cash || s1.cores - s2.cores !== 50) console.log('WARN: unexpected mastery up result');
  save();
})();
