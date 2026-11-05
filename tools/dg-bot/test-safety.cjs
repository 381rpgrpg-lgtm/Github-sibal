// safety.cjs 단위 시험 (네트워크 없음). run/ud.json 을 바탕으로 가상 상황을 만들어 관문 판정을 확인한다.
const fs = require('fs');
const os = require('path');
const OUT = __dirname + '/run/safety-test';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const S = require('./safety.cjs');
const logs = [];
S.init(OUT, (s) => logs.push(s));
const base = JSON.parse(fs.readFileSync(__dirname + '/run/ud.json', 'utf8'));
let pass = 0, fail = 0;
const expect = (label, cond) => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`); };
const login = (ud) => S.onResponse('MsgLoginReq', {}, [{ name: 'MsgUserData', body: ud }]);
(async () => {
  // 현재 상태: 8 ★4(현재), 9 ★3 Lv10
  login(base);
  const pr = S.protect;
  console.log('protect cars', JSON.stringify(pr.cars), 'parts', pr.parts.length);
  expect('current ★4 car 8 protected', !(await S.beforeSend('MsgDisassembleCarReq', { CarID: [8] })).ok);
  expect('★3 Lv10 car 9 protected as material', !(await S.beforeSend('MsgUpgradeCarReq', { TargetCarInfo: { Carid: 8 }, SourceCarInfo: [{ Carid: 9 }] })).ok);
  expect('unknown car id 77 blocked', !(await S.beforeSend('MsgUpgradeCarReq', { TargetCarInfo: { Carid: 8 }, SourceCarInfo: [{ Carid: 77 }] })).ok);

  // 가상: ★3 Lv1 세 대 추가 (10·13·14) + ★1 1대(15). 9 Lv10 과 10 이 육성 대상 -> 13·14 는 남는 ★3 Lv1 (재료 허용), 15 허용
  const ud2 = JSON.parse(JSON.stringify(base));
  const mk = (Carid, Cartype, Grade) => ({ Carid, Cartype, Grade, UpgradeLevel: 1, CarExp: 0, Mastery: 0, ExpansionLevel: 0, ItemInfo: [] });
  ud2.Cars.CarInfo.push(mk(10, 10403, 3), mk(13, 10503, 3), mk(14, 10303, 3), mk(15, 10101, 1));
  login(ud2);
  expect('grow ★3 car 10 (lowest id Lv1) protected', !(await S.beforeSend('MsgUpgradeCarReq', { TargetCarInfo: { Carid: 9 }, SourceCarInfo: [{ Carid: 10 }] })).ok);
  expect('spare ★3 Lv1 car 13 allowed as material', (await S.beforeSend('MsgUpgradeCarReq', { TargetCarInfo: { Carid: 10 }, SourceCarInfo: [{ Carid: 13 }, { Carid: 14 }] })).ok);
  expect('★1 car 15 allowed', (await S.beforeSend('MsgUpgradeCarReq', { TargetCarInfo: { Carid: 10 }, SourceCarInfo: [{ Carid: 15 }] })).ok);
  expect('combine 9+10 blocked without allowCombine', !(await S.beforeSend('MsgCombineCarReq', { TargetCarID: 9, SourceCarID: 10 })).ok);
  S.allowCombine([9, 10]);
  expect('combine 9+10 allowed with allowCombine', (await S.beforeSend('MsgCombineCarReq', { TargetCarID: 9, SourceCarID: 10 })).ok);
  S.allowCombine([]);

  // 가상: 번호 재사용 — 수동 보호 {Carid 15, Cartype 10101} 뒤에 15 번이 다른 차종이 되면 수동 항목 삭제
  fs.writeFileSync(OUT + '/protect.json', JSON.stringify({ manual: { cars: [{ Carid: 15, Cartype: 10101 }], parts: [] } }));
  login(ud2);
  expect('manual protect car 15 (10101) blocks', !(await S.beforeSend('MsgDisassembleCarReq', { CarID: [15] })).ok);
  const ud3 = JSON.parse(JSON.stringify(ud2)); ud3.Cars.CarInfo.find((c) => c.Carid === 15).Cartype = 10201;
  login(ud3);
  expect('manual entry dropped after id reuse (15 now 10201)', JSON.parse(fs.readFileSync(OUT + '/protect.json', 'utf8')).manual.cars.length === 0 && (await S.beforeSend('MsgDisassembleCarReq', { CarID: [15] })).ok);

  // 부품
  login(base);
  const parts = base.Items.ItemInfo.filter((x) => x.Equipcarid === 8);
  expect('part on current car blocked from sale', !(await S.beforeSend('MsgSellPartsReq', { Itemid: [parts[0].Itemid] })).ok);
  expect('★4 part 101 blocked as combine material', !(await S.beforeSend('MsgCombinePartsReq', { Itemid: 106, ConsumeParts: [101] })).ok);
  expect('spare ★3 part 106 sale allowed', (await S.beforeSend('MsgSellPartsReq', { Itemid: [106] })).ok);
  const nonPart = base.Items.ItemInfo.find((x) => x.Itemtype === 60035) ?? base.Items.ItemInfo.find((x) => x.Itemtype === 60110);
  expect('non-part item sale (item tidy) allowed', (await S.beforeSend('MsgSellPartsReq', { Itemid: [nonPart.Itemid], Itemcnt: [1] })).ok);

  // 상점
  expect('coin car box 73008 allowed', (await S.beforeSend('MsgBuyProductReq', { StoreItemId: 73008, Buycount: 1 })).ok);
  expect('social car box 72007 allowed', (await S.beforeSend('MsgBuyProductReq', { StoreItemId: 72007, Buycount: 1 })).ok);
  expect('free box 71026 allowed', (await S.beforeSend('MsgBuyProductReq', { StoreItemId: 71026, Buycount: 1 })).ok);
  const { readTable } = await import('/home/user/Github-sibal/offline-server/dist/upserts.js');
  const st = readTable('/home/user/Github-sibal/offline-server/data/tables/itemTable.json', 'itemTable.json').StoreItem;
  const gold = st.find((s) => s.PriceGoldCash !== undefined), real = st.find((s) => s.PriceRealMoney !== undefined);
  const cashBig = st.find((s) => s.PriceCash !== undefined && s.PriceCoin === undefined && Number(s.SalePrice ?? s.PriceCash) > 10 && s.PriceRealMoney === undefined && s.PriceGoldCash === undefined);
  const cashSmall = st.find((s) => s.PriceCash !== undefined && s.PriceCoin === undefined && Number(s.SalePrice ?? s.PriceCash) <= 10 && Number(s.SalePrice ?? s.PriceCash) > 0 && s.PriceRealMoney === undefined && s.PriceGoldCash === undefined);
  expect(`Gold Cash item ${gold?.Id} blocked`, !(await S.beforeSend('MsgBuyProductReq', { StoreItemId: gold.Id, Buycount: 1 })).ok);
  expect(`real money item ${real?.Id} blocked`, !(await S.beforeSend('MsgBuyProductReq', { StoreItemId: real.Id, Buycount: 1 })).ok);
  expect(`cash item ${cashBig?.Id} price ${cashBig?.SalePrice ?? cashBig?.PriceCash} > 10 blocked`, !(await S.beforeSend('MsgBuyProductReq', { StoreItemId: cashBig.Id, Buycount: 1 })).ok);
  if (cashSmall) expect(`small cash item ${cashSmall.Id} (${cashSmall.SalePrice ?? cashSmall.PriceCash}) allowed`, (await S.beforeSend('MsgBuyProductReq', { StoreItemId: cashSmall.Id, Buycount: 1 })).ok);

  // 캐시 추적·이상 감지
  const ui = (cash) => ({ ...base.UserInfo, Cash: cash });
  S.onResponse('MsgBuyProductReq', { StoreItemId: 1 }, [{ name: 'MsgBuyProductAns', body: { Result: 1, UserInfo: ui(Number(base.UserInfo.Cash) - 5) } }]);
  expect('cash spend recorded (5)', JSON.parse(fs.readFileSync(OUT + '/cash.json', 'utf8'))[new Date().toISOString().slice(0, 10)] === 5);
  S.onResponse('MsgRaceRewardReq', {}, [{ name: 'MsgRaceRewardAns', body: { Result: 1, UserInfo: ui(Number(base.UserInfo.Cash) - 8) } }]);
  expect('unexpected cash decrease alerted', fs.readFileSync(OUT + '/ALERT', 'utf8').includes('unexpected request MsgRaceRewardReq'));
  S.onResponse('MsgSellPartsReq', { Itemid: [1] }, [{ name: 'MsgSellPartsAns', body: {} }]);
  expect('wrong answer name -> ANOMALY', fs.readFileSync(OUT + '/ALERT', 'utf8').includes('ANOMALY MsgSellPartsReq'));
  let stuck = false; for (let i = 0; i < 7; i++) stuck = S.progressTick('q10804:67', 0) || stuck;
  expect('no progress after 7 races -> skip', stuck && S.progressSkipped('q10804:67'));
  expect('progress change clears counter', !S.progressTick('q999:1', 0) && !S.progressTick('q999:1', 1));
  console.log(`\n${pass} pass / ${fail} fail`);
  console.log('ALERT file:\n' + fs.readFileSync(OUT + '/ALERT', 'utf8'));
})();
