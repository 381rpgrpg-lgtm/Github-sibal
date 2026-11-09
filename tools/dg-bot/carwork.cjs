const DGP = require('./paths.cjs');
// 차량 육성 작업 (2026-11-05 사용자 지시: ★2 보호 차량 사용, 코인은 적정선에서 사용, 3·7번 차 적절성 판단)
//   1) 3·7번(★2 Lv10, 숙련도 한계 돌파 상태)을 조합 -> 무작위 ★3 (퀘스트 10505, 이후 10901 '★3 두 대 조합 -> ★4' 재료)
//   2) ★3 차량(Lv10 미만, 8번 ★4 제외)을 Lv10 까지: 재료 = ★1·★2 차량. 재료가 없으면 소셜 포인트 차량 상자(72007, 150 SP) ->
//      코인 중고 차량 상자(73008) 순으로 산다. 코인은 RESERVE 아래로 쓰지 않는다. 캐시가 줄면 즉시 중단.
// node carwork.cjs [--no-combine]   결과는 run/carwork.log
const fs = require('fs');
const B = 'http://localhost:8080';
const LOG = __dirname + '/run/carwork.log';
const T = (DGP.srv('data/tables') + '/');
const RESERVE = 150000;
const MAIN = 8; // 주력 ★4 TOFU++
// --extra-mats=13,14,15 : 재료로 쓸 ★3 (사용자 선택 2026-11-05: ★3 2대(9·10) 육성, 나머지 3대 재료)
const EXTRA = new Set(((process.argv.find((a) => a.startsWith('--extra-mats=')) ?? '').split('=')[1] ?? '').split(',').filter(Boolean).map(Number));
const GROW = new Set(((process.argv.find((a) => a.startsWith('--grow=')) ?? '').split('=')[1] ?? '').split(',').filter(Boolean).map(Number));
const MAXCOIN = Number((process.argv.find((a) => a.startsWith('--max-coinbox=')) ?? '=8').split('=')[1]);
let coinBoxes = 0;
const log = (s) => { const l = `[${new Date().toISOString().slice(5, 19)}] ${s}`; console.log(l); fs.appendFileSync(LOG, l + '\n'); };
const CARS = JSON.parse(fs.readFileSync(T + 'cars.json', 'utf8')).Car;
const LV = JSON.parse(fs.readFileSync(T + 'carLevelTable.json', 'utf8')).CarLevels;
const grade = (c) => Number(c.Grade) || CARS.find((x) => x.Id === c.Cartype)?.Grade || 1;
const lvRow = (g, l) => LV.find((x) => x.Grade === g)?.CarLevel.find((r) => r.Level === l) ?? {};
const matExp = (c) => Number(lvRow(grade(c), Number(c.UpgradeLevel) || 1).MaterialExp) || 0;
const needToMax = (c) => { let n = -(Number(c.CarExp) || 0); for (let l = Number(c.UpgradeLevel) || 1; l < 10; l++) n += Number(lvRow(grade(c), l).CarExp) || 0; return Math.max(0, n); };
(async () => {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  const H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
  // 안전 관문(safety.cjs) 경유. --dry-run 이면 차량을 없애는 요청(강화·조합·분해)과 구매는 보내지 않고 계획만 기록한다.
  const SAFE = require('./safety.cjs'); SAFE.init(__dirname + '/run', log);
  const DRY = process.argv.includes('--dry-run');
  const WRITE = new Set(['MsgUpgradeCarReq', 'MsgCombineCarReq', 'MsgDisassembleCarReq', 'MsgBuyProductReq']);
  const rpc = async (n, b = {}) => {
    const chk = await SAFE.beforeSend(n, b); if (!chk.ok) return [];
    if (DRY && WRITE.has(n)) { log(`DRY would send ${n} ${JSON.stringify(b)}`); globalThis.__dryDone = true; return []; }
    const m = (await (await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name: n, body: b }) })).json()).messages || [];
    SAFE.onResponse(n, b, m); return m;
  };
  const pick = (m, n) => m.find((x) => x.name === n)?.body;
  const login = async () => pick(await rpc('MsgLoginReq'), 'MsgUserData');
  let ud = await login();
  const cash0 = Number(ud.UserInfo.Cash);
  const cashOk = (u) => { if (Number(u?.Cash ?? cash0) < cash0) { log(`ABORT: cash decreased ${cash0} -> ${u.Cash}`); process.exit(1); } };
  log(`start coin ${ud.UserInfo.Coin} cash ${cash0} SP ${ud.UserInfo.SocialPoint} cars ${ud.Cars.CarInfo.map((c) => `${c.Carid}:${c.Cartype}★${grade(c)}Lv${c.UpgradeLevel}`).join(' ')}`);

  // 1) 조합
  if (!process.argv.includes('--no-combine')) {
    const a = ud.Cars.CarInfo.find((c) => c.Carid === 3), b = ud.Cars.CarInfo.find((c) => c.Carid === 7);
    if (a && b && grade(a) === 2 && grade(b) === 2 && a.UpgradeLevel === 10 && b.UpgradeLevel === 10) {
      SAFE.allowCombine([3, 7]);
      const m = await rpc('MsgCombineCarReq', { TargetCarID: 3, SourceCarID: 7 });
      SAFE.allowCombine([]);
      fs.writeFileSync(__dirname + '/run/combine.json', JSON.stringify(m, null, 1));
      const r = pick(m, 'MsgCombineCarAns');
      cashOk(r?.UserInfo);
      log(`combine 3(${a.Cartype}) + 7(${b.Cartype}): Result ${r?.Result} -> ${JSON.stringify(r?.CarInfo ?? r?.ResultCarInfo ?? r?.NewCarInfo ?? null).slice(0, 200)} msgs ${m.map((x) => x.name).join(',')}`);
      if (r?.Result !== 1) { log('combine failed, stop'); return; }
      ud = await login();
    } else log('combine skipped (cars 3/7 not both ★2 Lv10)');
  }

  // 2) ★3 육성
  for (let step = 0; step < 60; step++) {
    const ui = ud.UserInfo, cars = ud.Cars.CarInfo;
    const target = cars.filter((c) => c.Carid !== MAIN && grade(c) === 3 && c.UpgradeLevel < 10 && !EXTRA.has(c.Carid) && (!GROW.size || GROW.has(c.Carid))).sort((x, y) => y.UpgradeLevel - x.UpgradeLevel || (Number(y.CarExp) || 0) - (Number(x.CarExp) || 0))[0];
    if (!target) { log('no ★3 below Lv10: done'); break; }
    const mats = cars.filter((c) => c.Carid !== target.Carid && c.Carid !== MAIN && c.Carid !== Number(ui.Currentcar) && (grade(c) <= 2 || EXTRA.has(c.Carid)) && !c.IsLocked && !c.IsExhibited); // ★3 은 --extra-mats 로 지정한 것만 (2026-11-05 사고: 자동 규칙이 육성 대상 10번 ★3 을 재료로 씀)
    const need = needToMax(target);
    const have = mats.reduce((s, c) => s + matExp(c), 0);
    const garageFree = Number(ui.GarageSize) - cars.length;
    const canSP = Number(ui.SocialPoint) >= 150;
    const canCoin = Number(ui.Coin) - 6900 >= RESERVE && coinBoxes < MAXCOIN;
    if (mats.length && (have >= need || garageFree === 0 || (!canSP && !canCoin))) {
      // 넘치지 않게: 작은 것부터 넣되 need 를 채우면 멈춤
      const use = []; let sum = 0;
      for (const c of mats.sort((x, y) => matExp(x) - matExp(y))) { if (sum >= need) break; use.push(c); sum += matExp(c); }
      const info = pick(await rpc('MsgUpgradeInfoReq', { TargetCarInfo: { Carid: target.Carid }, SourceCarInfo: use.map((c) => ({ Carid: c.Carid })) }), 'MsgUpgradeInfoAns');
      const cost = Number(info?.Cost?.Coin ?? 1e9);
      if (cost > Number(ui.Coin) - 20000) { log(`upgrade cost ${cost} too high, stop`); break; }
      const r = pick(await rpc('MsgUpgradeCarReq', { TargetCarInfo: { Carid: target.Carid }, SourceCarInfo: use.map((c) => ({ Carid: c.Carid })) }), 'MsgUpgradeCarAns');
      cashOk(r?.UserInfo);
      log(`upgrade ${target.Carid}(${target.Cartype}) Lv${target.UpgradeLevel}+${target.CarExp ?? 0} with ${use.map((c) => `${c.Cartype}(${matExp(c)})`).join(',')} need ${need} cost ${cost}: Result ${r?.Result} -> Lv ${r?.ResultCarInfo?.UpgradeLevel} exp ${r?.ResultCarInfo?.CarExp}`);
      if (r?.Result !== 1) break;
    } else if (garageFree > 0 && (canSP || canCoin)) {
      const id = canSP ? 72007 : 73008;
      if (!canSP) coinBoxes++;
      const r = pick(await rpc('MsgBuyProductReq', { StoreItemId: id, Buycount: 1 }), 'MsgBuyProductAns');
      cashOk(r?.UserInfo);
      const got = (r?.RewardInfo?.CarInfo ?? []).map((c) => `${c.Carid}:${c.Cartype}★${grade(c)}`).join(',');
      log(`buy ${id === 72007 ? 'social' : 'coin'} car box: Result ${r?.Result} ${got} coin ${r?.UserInfo?.Coin} SP ${r?.UserInfo?.SocialPoint}`);
      if (r?.Result !== 1) break;
    } else { log(`stop: mats ${mats.length} need ${need} garageFree ${garageFree} SP ${ui.SocialPoint} coin ${ui.Coin}`); break; }
    if (DRY && globalThis.__dryDone) { log('DRY: stop after first planned write'); break; }
    ud = await login();
  }
  const u = ud.UserInfo;
  log(`end coin ${u.Coin} cash ${u.Cash} SP ${u.SocialPoint} cars ${ud.Cars.CarInfo.map((c) => `${c.Carid}:${c.Cartype}★${grade(c)}Lv${c.UpgradeLevel}+${c.CarExp ?? 0}`).join(' ')}`);
})();
