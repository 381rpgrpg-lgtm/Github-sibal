// F 기능 1회 시험 (안전 관문 경유): FM 부스트 정보(조회), 코스메틱 수집(조회), 보유 데칼 적용(무료), 코인 코팅 1회
const S = require('./safety.cjs'); S.init(__dirname + '/run', (s) => console.log(s));
const fs = require('fs');
const B = 'http://localhost:8080';
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const out = [];
  const rpc = async (n, b) => { const c = await S.beforeSend(n, b); if (!c.ok) { console.log('BLOCKED', n); return []; } const m = (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || []; S.onResponse(n, b, m); out.push({ n, b, m }); return m; };
  const show = (ms) => ms.forEach((x) => { const v = { ...x.body }; if (v.UserInfo) v.UserInfo = { Cash: v.UserInfo.Cash, Coin: v.UserInfo.Coin }; console.log('  ', x.name, JSON.stringify(v).slice(0, 600)); });
  const ud = (await rpc('MsgLoginReq', {})).find((m) => m.name === 'MsgUserData').body;
  for (const g of (process.env.FM ? [20405] : [])) { console.log('FMBoostInfo', g); show(await rpc('MsgFMBoostInfoReq', { GirlInfo: { Girlid: g } })); }
  
  const car = ud.Cars.CarInfo.find((c) => c.Carid === 8);
  const decal = ud.Items.ItemInfo.find((x) => x.Itemtype === 61305);
  if (car && decal && car.DecalIndex === -1) { console.log('Decal 61305 -> car 8'); show(await rpc('MsgUseItemReq', { Item: { Itemid: decal.Itemid }, CarInfo: [{ Carid: 8, DecalIndex: 104 }] })); }
  const ud2 = (await rpc('MsgLoginReq', {})).find((m) => m.name === 'MsgUserData').body;
  const car2 = ud2.Cars.CarInfo.find((c) => c.Carid === 8);
  console.log('car 8 decal', car2.DecalIndex, 'coating', car2.CoatingSkill, car2.CoatingValue, car2.CoatingCoin, 'mileage', ud2.UserInfo.DecalMileage);
  if (car2.DecalIndex !== -1 && process.argv[2] === 'coat') { console.log('Coating (coin)'); show(await rpc('MsgCarCoatingReq', { CarInfo: car2, Randtype: 1 })); }
  fs.writeFileSync(__dirname + '/run/f-trial.json', JSON.stringify(out, null, 1));
})();
