// 1회성 (2026-11-08): 차량 10 (★5 11705, 숙련도 268/268) 숙련도 한계 돌파 + 숙련도 올리기. 캐시·골드캐시를 쓰지 않는다 (차량 부품 61006 만).
//   한계 돌파 비용 = cars.json ExpCash (실기록 ★2 10602 = 28, ★4 10604 = 36 과 같은 규칙 -> 11705 = 53 부품). 늘어나는 숙련도 = Expansion 147.
//   숙련도 올리기 Mtype 3 = 부품 50 개로 +30 (실기록 4건). Mtype 1·2·4 는 골드캐시일 수 있어 쓰지 않는다.
//   한 단계마다 캐시가 그대로인지, 부품이 예상만큼만 줄었는지 확인하고, 아니면 멈춘다.
const S = require('./safety.cjs'); S.init(__dirname + '/run', (s) => console.log(s));
const fs = require('fs'); const B = 'http://localhost:8080';
const CAR = 10, CARTYPE = 11705, EXPAND_COST = 53, UPS = Number(process.argv[2] ?? 2);
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  const out = [];
  const rpc = async (n, b) => { const c = await S.beforeSend(n, b); if (!c.ok) { console.log('BLOCKED', n, c.reason); return []; } const m = (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || []; S.onResponse(n, b, m); out.push({ at: new Date().toISOString(), n, b, m }); return m; };
  const save = () => fs.writeFileSync(__dirname + '/run/mastery-oneoff.json', JSON.stringify(out, null, 1));
  const login = async () => (await rpc('MsgLoginReq', {})).find((m) => m.name === 'MsgUserData').body;
  const state = (ud) => { const c = ud.Cars.CarInfo.find((x) => x.Carid === CAR); const p = (ud.Items?.ItemInfo ?? []).find((i) => i.Itemtype === 61006); return { c, cores: Number(p?.Count) || 0, cash: Number(ud.UserInfo.Cash) }; };
  const show = (s) => `mastery ${s.c.Mastery}/${s.c.MasteryCapacity} exp${s.c.ExpansionLevel} attr ${JSON.stringify(s.c.MasteryAttr)} cores ${s.cores} cash ${s.cash}`;
  let s0 = state(await login());
  console.log('before', show(s0));
  if (!s0.c || s0.c.Cartype !== CARTYPE) { console.log('stop: car 10 changed'); save(); return; }
  if (s0.c.Mastery >= s0.c.MasteryCapacity && Number(s0.c.ExpansionLevel) === 0) {
    if (s0.cores < EXPAND_COST) { console.log('stop: not enough cores'); save(); return; }
    const a = (await rpc('MsgMasteryExpandReq', { CarInfo: { Carid: CAR }, ExpansionCash: EXPAND_COST })).find((m) => m.name === 'MsgMasteryExpandAns')?.body;
    const s1 = state(await login());
    console.log(`expand -> Result ${a?.Result}`, show(s1));
    if (a?.Result !== 1 || s1.cash !== s0.cash || s0.cores - s1.cores !== EXPAND_COST) { console.log('stop: unexpected expand result'); save(); return; }
    s0 = s1;
  }
  for (let k = 0; k < UPS; k++) {
    if (s0.cores < 50 || s0.c.Mastery >= s0.c.MasteryCapacity) { console.log('no more ups (cores or cap)'); break; }
    const a = (await rpc('MsgMasteryUpReq', { CarInfo: { Carid: CAR }, Mtype: 3 })).find((m) => m.name === 'MsgMasteryUpAns')?.body;
    const s1 = state(await login());
    console.log(`up ${k + 1} -> Result ${a?.Result}`, show(s1));
    if (a?.Result !== 1 || s1.cash !== s0.cash || s0.cores - s1.cores > 50) { console.log('stop: unexpected up result'); break; }
    s0 = s1;
  }
  save();
})();
