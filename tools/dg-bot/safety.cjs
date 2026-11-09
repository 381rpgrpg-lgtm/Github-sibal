// 안전 관문 (2026-11-05). bot.cjs 의 rpc() 가 모든 요청 전후에 부른다 — 어떤 코드 경로든 같은 검사를 받는다.
//
// 1) 보호 목록 (run/protect.json): 매 로그인마다 자동으로 다시 계산하고 파일로 남긴다.
//    - 서버는 차량·부품 번호를 재사용한다 (2026-11-05: Carid 13 이 다섯 번 다른 차종으로, 부품 142·143 재사용)
//      -> 항목은 번호 + 종류(Cartype/Itemtype) 쌍으로 대조한다. 같은 번호에 다른 종류면 다른 물건이다.
//    - 자동 보호 차량: 현재 차량, ★4 이상, ★3, 잠금·전시 차량.
//      2026-11-08 (사용자 위임 "네가 판단하고 금지조건 수정해"): ★3 은 강화 재료(MsgUpgradeCarReq)로만 허용한다 (mat: true).
//      주력 ★5 를 키우는 게 ★3 조합 퀘스트 10901(보상 경험치 200·코인 3000)보다 본편 진행에 낫다고 판단. 분해·판매·조합은 계속 막는다.
//      (예전 규칙: ★3 육성 대상 2대·손댄 ★3·★3 2대 이하 보호, 남는 ★3 Lv1 만 재료)
//    - 자동 보호 부품: 현재 차량에 장착된 부품, ★4 이상, 잠금.
//    - 수동 보호 (protect.json 의 manual.cars [{Carid, Cartype}] / manual.parts [{Itemid, Itemtype}]): 항상 보호.
//      그 번호의 물건이 사라지거나 종류가 바뀌면(재사용) 수동 항목은 자동으로 지운다(로그).
//    - 차량을 없애는 요청(강화 재료·분해·조합·판매)과 부품을 없애는 요청(판매·조합 재료)은 보내기 전에 보호 목록과 대조해,
//      걸리면 보내지 않는다 (GUARD 로그 + run/ALERT). 조합은 allowCombine([id...]) 으로 명시 허용한 것만.
// 2) 재화: Gold Cash(PriceGoldCash)·실결제(PriceRealMoney*) 상품은 구매 금지. 캐시는 최소 사용(금지 아님):
//    캐시 상품은 1회 CASH_ITEM_MAX 이하, 하루 합계 CASH_DAY_MAX 이하만. 모든 응답의 UserInfo.Cash 감소를 기록하고
//    하루 상한을 넘으면 ALERT + 그날 캐시 지출 요청 차단.
// 3) 이상 감지: 정상 응답 이름(실기록 기준 EXPECT)이 없으면 ANOMALY (같은 요청 1시간에 한 번 기록).
//    퀘스트 진척 감시 progressTick(key, value): 같은 목표를 N판 탔는데 값이 그대로면 그 목표는 6시간 쉬게 한다.
const fs = require('fs');
const T = '/home/user/Github-sibal/offline-server/data/tables/';
const CASH_ITEM_MAX = 10, CASH_DAY_MAX = 30;
const EXPECT = {
  MsgBuyProductReq: 'MsgBuyProductAns', MsgCarSlotOpenReq: 'MsgCarSlotOpenAns', MsgCollectFamiliarityReq: 'MsgCollectFamiliarityAns',
  MsgCombineCarReq: 'MsgCombineCarAns', MsgCombinePartsReq: 'MsgCombinePartsAns', MsgDateProposeReq: 'MsgDateProposeAns',
  MsgDateStartReq: 'MsgDateStartAns', MsgDisassembleCarReq: 'MsgDisassembleCarAns', MsgEquipPartsReq: 'MsgChangeParts',
  MsgGetDailyQuestRewardReq: 'MsgGetDailyQuestRewardAns', MsgGetGirlMemoryRewardReq: 'MsgGetGirlMemoryRewardAns', MsgGetMailItemReq: 'MsgGetMailItemAns',
  MsgGetMemoryRewardReq: 'MsgGetMemoryRewardAns', MsgGirlRarityExpandReq: 'MsgGirlRarityExpandAns', MsgMasteryExpandReq: 'MsgMasteryExpandAns',
  MsgMasteryUpReq: 'MsgMasteryUpAns', MsgRaceRewardReq: 'MsgRaceRewardAns', MsgRefreshEventRaceReq: 'MsgRefreshEventRaceAns',
  MsgScriptProgressReq: 'MsgScriptProgressAns', MsgSelectPassengerReq: 'MsgSelectPassengerAns', MsgSellPartsReq: 'MsgDeleteParts',
  MsgSetCurrentCarReq: 'MsgSetCurrentCarAns', MsgUpdateNquestReq: 'MsgUpdateNquestAns', MsgUpgradeCarReq: 'MsgUpgradeCarAns',
  MsgUpgradeInfoReq: 'MsgUpgradeInfoAns', MsgUseItemReq: 'MsgUseItemAns', MsgLoginReq: 'MsgUserData',
  MsgWRaceRewardReq: 'MsgWRaceRewardAns', MsgWorldTourRewardReq: 'MsgWorldTourRewardAns', MsgBattleMatchReq: 'MsgBattleMatchAns', MsgExpandSlotReq: 'MsgExpandSlotAns', // 클라이언트 코드 기준 (기록 없음)
};
// 캐시를 쓸 수 있는 요청 (상한 안에서만). 그 밖의 요청에서 캐시가 줄면 ALERT.
const CASH_SPENDERS = new Set(['MsgBuyProductReq', 'MsgMasteryExpandReq', 'MsgExpandSlotReq', 'MsgNquestObjectiveClearReq', 'MsgGirlExpansionCritClearReq', 'MsgDateProposeReq']);

let OUT = '.', log = console.log;
let lastUd = null, lastCash = null, protectCache = null, allowCombineIds = new Set();
const anomalyAt = {};
const CARS = new Map(JSON.parse(fs.readFileSync(T + 'cars.json', 'utf8')).Car.map((c) => [c.Id, c]));
const PARTS = new Map(JSON.parse(fs.readFileSync(T + 'parts.json', 'utf8')).Part.map((p) => [p.Id, p]));
let STORE = null;
async function store() {
  if (!STORE) {
    const { readTable } = await import('/home/user/Github-sibal/offline-server/dist/upserts.js');
    STORE = new Map(readTable(T + 'itemTable.json', 'itemTable.json').StoreItem.map((s) => [s.Id, s]));
  }
  return STORE;
}
const day = () => new Date().toISOString().slice(0, 10);
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(`${OUT}/${f}`, 'utf8')); } catch { return d; } };
const writeJ = (f, v) => fs.writeFileSync(`${OUT}/${f}`, JSON.stringify(v, null, 1));
function alert(s) { log('ALERT ' + s); fs.appendFileSync(`${OUT}/ALERT`, `[${new Date().toISOString().slice(5, 19)}] ${s}\n`); }
const carGrade = (c) => Number(c?.Grade) || Number(CARS.get(Number(c?.Cartype))?.Grade) || 1;
const partGrade = (it) => Number(PARTS.get(Number(it?.Itemtype))?.Grade) || 0;

function init(outDir, logger) { OUT = outDir; log = logger; }

/** 보호 목록 계산 (ud 기준) + protect.json 갱신 */
function computeProtect(ud) {
  const cars = ud?.Cars?.CarInfo ?? [], items = ud?.Items?.ItemInfo ?? [];
  const cur = Number(ud?.UserInfo?.Currentcar);
  const file = readJ('protect.json', {});
  const manual = { cars: file.manual?.cars ?? [], parts: file.manual?.parts ?? [] };
  // 수동 항목 정리: 번호가 없어졌거나 종류가 바뀌었으면(재사용) 지운다
  const keepCar = manual.cars.filter((m) => cars.some((c) => c.Carid === Number(m.Carid) && c.Cartype === Number(m.Cartype)));
  const keepPart = manual.parts.filter((m) => items.some((p) => p.Itemid === Number(m.Itemid) && p.Itemtype === Number(m.Itemtype)));
  if (keepCar.length !== manual.cars.length || keepPart.length !== manual.parts.length) log(`protect: manual entries removed (gone or id reused): cars ${manual.cars.length - keepCar.length}, parts ${manual.parts.length - keepPart.length}`);
  const g3 = cars.filter((c) => carGrade(c) === 3 && c.Carid !== cur)
    .sort((a, b) => b.UpgradeLevel - a.UpgradeLevel || (Number(b.CarExp) || 0) - (Number(a.CarExp) || 0) || a.Carid - b.Carid);
  const grow3 = new Set(g3.slice(0, 2).map((c) => c.Carid));
  const pc = [];
  for (const c of cars) {
    const why = c.Carid === cur ? 'current' : carGrade(c) >= 4 ? '★4+' : c.IsLocked ? 'locked' : c.IsExhibited ? 'exhibited'
      : keepCar.some((m) => Number(m.Carid) === c.Carid) ? 'manual' : carGrade(c) === 3 ? '★3' : null;
    if (why) pc.push({ Carid: c.Carid, Cartype: c.Cartype, why, ...(why === '★3' ? { mat: true } : {}) });
  }
  const pp = [];
  for (const it of items) {
    if (!PARTS.has(Number(it.Itemtype))) continue;
    const why = Number(it.Equipcarid) === cur && cur > 0 ? 'on current car' : partGrade(it) >= 4 ? '★4+' : it.IsLocked ? 'locked'
      : keepPart.some((m) => Number(m.Itemid) === it.Itemid) ? 'manual' : null;
    if (why) pp.push({ Itemid: it.Itemid, Itemtype: it.Itemtype, why });
  }
  protectCache = { cars: pc, parts: pp };
  writeJ('protect.json', { updated: new Date().toISOString(), note: 'manual 에 {Carid, Cartype} / {Itemid, Itemtype} 를 넣으면 항상 보호. auto 는 매 로그인마다 다시 계산.', manual: { cars: keepCar, parts: keepPart }, auto: protectCache });
  return protectCache;
}
// 마지막 로그인에 없던 번호(방금 상자에서 나온 차 등)는 모르는 물건 -> 보호 (다음 로그인 뒤 다시 판단)
const carProtected = (id) => !(lastUd?.Cars?.CarInfo ?? []).some((x) => x.Carid === Number(id)) ? { Cartype: '?', why: 'unknown since last login' }
  : (protectCache?.cars ?? []).find((c) => c.Carid === Number(id) && (lastUd?.Cars?.CarInfo ?? []).some((x) => x.Carid === c.Carid && x.Cartype === c.Cartype));
const partProtected = (id) => {
  const it = (lastUd?.Items?.ItemInfo ?? []).find((x) => x.Itemid === Number(id));
  if (!it) return { Itemtype: '?', why: 'unknown since last login' };
  if (!PARTS.has(Number(it.Itemtype))) return null; // 부품이 아닌 아이템(아이템 칸 정리 판매)은 부품 보호 대상 아님
  return (protectCache?.parts ?? []).find((p) => p.Itemid === it.Itemid && p.Itemtype === it.Itemtype);
};

function cashSpentToday() { return readJ('cash.json', {})[day()] ?? 0; }

/** 보내기 전 검사. {ok:false, reason} 이면 보내지 않는다. */
async function beforeSend(name, body) {
  const block = (reason) => { alert(`GUARD ${name} blocked: ${reason}`); return { ok: false, reason }; };
  const cars = (ids) => ids.map(Number).filter(Boolean);
  if (name === 'MsgUpgradeCarReq') {
    for (const id of cars((body?.SourceCarInfo ?? []).map((c) => c.Carid))) { const p = carProtected(id); if (p && !p.mat) return block(`material car ${id} (${p.Cartype}) protected: ${p.why}`); }
  }
  if (name === 'MsgDisassembleCarReq' || name === 'MsgSellCarReq') {
    const ids = cars([].concat(body?.CarID ?? body?.CarInfo?.Carid ?? body?.Carid ?? []));
    for (const id of ids) { const p = carProtected(id); if (p) return block(`car ${id} (${p.Cartype}) protected: ${p.why}`); }
  }
  if (name === 'MsgCombineCarReq') {
    for (const id of cars([body?.TargetCarID, body?.SourceCarID])) {
      if (allowCombineIds.has(id)) continue;
      const p = carProtected(id); if (p) return block(`combine car ${id} (${p.Cartype}) protected: ${p.why} (allowCombine 필요)`);
    }
  }
  if (name === 'MsgSellPartsReq') {
    for (const id of [].concat(body?.Itemid ?? [])) { const p = partProtected(id); if (p) return block(`part ${id} (${p.Itemtype}) protected: ${p.why}`); }
  }
  if (name === 'MsgCombinePartsReq') {
    for (const id of [].concat(body?.ConsumeParts ?? [])) { const p = partProtected(id); if (p) return block(`material part ${id} (${p.Itemtype}) protected: ${p.why}`); }
  }
  if (name === 'MsgBuyProductReq') {
    const s = (await store()).get(Number(body?.StoreItemId));
    if (s && (s.PriceGoldCash !== undefined || s.PriceRealMoney !== undefined || s.PriceRealMoneyInt !== undefined || s.PriceRealMoneyJP !== undefined))
      return block(`store item ${s.Id} is Gold Cash / real money`);
    if (s && s.PriceCash !== undefined && s.PriceCoin === undefined && s.PriceSocialPoint === undefined) {
      const price = Number(s.SalePrice ?? s.PriceCash) * (Number(body?.Buycount) || 1);
      if (price > CASH_ITEM_MAX) return block(`cash item ${s.Id} price ${price} > ${CASH_ITEM_MAX}`);
      if (cashSpentToday() + price > CASH_DAY_MAX) return block(`cash day cap ${CASH_DAY_MAX} (spent ${cashSpentToday()})`);
    }
  }
  if (CASH_SPENDERS.has(name) && cashSpentToday() >= CASH_DAY_MAX && name !== 'MsgBuyProductReq') return block(`cash day cap reached (${cashSpentToday()})`);
  return { ok: true };
}

// ── 무작위 결과 표본 (run/samples.jsonl, 한 줄 = 한 건) ──
// 서버에만 있는 확률·규칙(상자 내용물, 강화 대성공, 조합 결과, 데이트 중 사건, 삐침, 레이스 드롭, 대전 상대)을 표본으로 쌓아
// 오프라인 서버가 분포를 추정하는 데 쓴다. 기록만 하고 판단에는 쓰지 않는다.
function sample(rec) { try { fs.appendFileSync(`${OUT}/samples.jsonl`, JSON.stringify({ t: new Date().toISOString().slice(0, 19), ...rec }) + '\n'); } catch {} }
const brief = (ri) => ri ? { coin: ri.Coin || undefined, cash: ri.Cash || undefined, items: (ri.ItemInfo ?? []).map((x) => [x.Itemtype, x.Count ?? x.DeltaNum ?? x.StackNum]), cars: (ri.CarInfo ?? []).map((c) => c.Cartype), grade: ri.ContainerGrade || undefined } : null;
function collect(name, body, msgs) {
  const get = (n) => msgs.find((m) => m.name === n)?.body;
  const chunks = (b) => (b?.Script?.Chunk ?? []).map((c) => c.ScriptName).filter((n) => /^Date_Event_/.test(n));
  if (name === 'MsgUseItemReq') { const a = get('MsgUseItemAns'); if (a?.Result === 1 && a.RewardInfo) sample({ kind: 'box', item: a.RequestedItem?.Itemtype, got: brief(a.RewardInfo) }); }
  if (name === 'MsgBuyProductReq') { const a = get('MsgBuyProductAns'); if (a?.Result === 1) sample({ kind: 'shop', id: Number(body?.StoreItemId), got: brief(a.RewardInfo) }); }
  if (name === 'MsgUpgradeCarReq') {
    const a = get('MsgUpgradeCarAns'), cars = lastUd?.Cars?.CarInfo ?? [];
    const tgt = cars.find((c) => c.Carid === Number(body?.TargetCarInfo?.Carid));
    if (a) sample({ kind: 'upgrade', result: a.Result, target: tgt && [tgt.Cartype, tgt.UpgradeLevel, tgt.CarExp ?? 0], mats: (body?.SourceCarInfo ?? []).map((s) => { const c = cars.find((x) => x.Carid === Number(s.Carid)); return c ? [c.Cartype, c.UpgradeLevel] : s.Carid; }),
      after: a.ResultCarInfo && [a.ResultCarInfo.UpgradeLevel, a.ResultCarInfo.CarExp], bonus: !!a.BonusCarInfo, keys: Object.keys(a).filter((k) => !['Seq', 'UserInfo', 'ResultCarInfo'].includes(k)) });
  }
  if (name === 'MsgCombineCarReq') {
    const a = get('MsgCombineCarAns'), cars = lastUd?.Cars?.CarInfo ?? [];
    const ct = (id) => cars.find((c) => c.Carid === Number(id))?.Cartype;
    if (a) sample({ kind: 'combine', result: a.Result, target: ct(body?.TargetCarID), source: ct(body?.SourceCarID), got: a.ResultCarInfo?.Cartype });
  }
  if (name === 'MsgCombinePartsReq') { const a = get('MsgCombinePartsAns'); if (a?.Upgraded) sample({ kind: 'partsCombine', part: a.Upgraded.Itemtype, prev: [a.Upgraded.PrevItemLevel, a.Upgraded.PrevItemExp], after: [a.Upgraded.ItemLevel, a.Upgraded.ItemExp], mats: (a.Consumed ?? []).map((x) => x.Itemtype) }); }
  if (name === 'MsgDateStartReq' || name === 'MsgScriptProgressReq') {
    const ev = msgs.flatMap((m) => chunks(m.body));
    if (ev.length) sample({ kind: 'dateEvent', req: name, girl: Number(body?.GirlInfo?.Girlid) || undefined, place: body?.DatePlace, index: body?.Index, events: ev });
  }
  for (const m of msgs) { // 삐침: 어떤 응답이든 GirlInfo 에 Emotion 2 또는 삐침 원인이 나오면
    for (const g of [].concat(m.body?.GirlInfo ?? [], m.body?.UpdateGirlInfo ?? [])) {
      if (g && (Number(g.Emotion) === 2 || Number(g.CauseOfPeevish) > 0)) sample({ kind: 'peevish', req: name, girl: g.Girlid, emotion: g.Emotion, cause: g.CauseOfPeevish, solution: g.SolutionForPeevish, fam: g.Familiarity });
    }
  }
  if (name === 'MsgRaceRewardReq') { const a = get('MsgRaceRewardAns'); if (a?.RewardInfo) sample({ kind: 'raceReward', zone: body?.ZoneId, race: body?.RaceId, got: brief(a.RewardInfo) }); }
  if (name === 'MsgBattleResultReq') { const a = get('MsgBattleResultAns'); if (a) sample({ kind: 'raceResult', type: a.RaceType, race: a.Race?.RaceId ?? a.BattleId, win: a.IsPlayerWin, drops: (a.ItemInfo ?? []).map((x) => x.Itemtype), coin: a.DeltaInfo?.Coin, grade: a.ClearRec?.Grade }); }
  if (/^MsgBattleMatch/.test(name) || msgs.some((m) => m.name === 'MsgBattleMatchResult')) {
    for (const m of msgs.filter((x) => /BattleMatch/.test(x.name))) sample({ kind: 'duelMatch', msg: m.name, body: JSON.stringify(m.body).slice(0, 1500) });
  }
}

/** 받은 뒤 처리: 상태 추적, 캐시 지출 기록, 정상 응답 확인, 표본 수집 */
function onResponse(name, body, msgs) {
  try { collect(name, body, msgs); } catch (e) { log('sample err ' + e.message); }
  const ud = msgs.find((m) => m.name === 'MsgUserData')?.body;
  if (name === 'MsgLoginReq' && ud) { lastUd = ud; computeProtect(ud); }
  const cash = msgs.map((m) => m.body?.UserInfo?.Cash ?? (m.name === 'MsgUserData' ? m.body?.UserInfo?.Cash : undefined)).find((v) => v !== undefined);
  if (cash !== undefined) {
    const c = Number(cash);
    if (lastCash !== null && c < lastCash) {
      const spent = lastCash - c, j = readJ('cash.json', {});
      j[day()] = (j[day()] ?? 0) + spent; writeJ('cash.json', j);
      log(`cash -${spent} by ${name} (today ${j[day()]})`);
      if (!CASH_SPENDERS.has(name) && name !== 'MsgLoginReq') alert(`cash decreased by unexpected request ${name}: -${spent}`);
      if (j[day()] > CASH_DAY_MAX) alert(`cash day cap exceeded: ${j[day()]} > ${CASH_DAY_MAX}`);
    }
    lastCash = c;
  }
  const exp = EXPECT[name];
  if (exp && !msgs.some((m) => m.name === exp) && Date.now() - (anomalyAt[name] ?? 0) > 3600e3) {
    anomalyAt[name] = Date.now();
    alert(`ANOMALY ${name}: expected ${exp}, got [${msgs.map((m) => m.name).join(',') || 'none'}] body ${JSON.stringify(body).slice(0, 120)}`);
  }
}

/** 퀘스트 진척 감시: 같은 목표로 N판 탔는데 값이 그대로면 true (그 목표는 6시간 쉬게 한다) */
// 경주가 실제로 끝나지 않은 시도(허브 못 감·시작 안 됨 등)는 세지 않는다: 봇이 경주 뒤 progressUndo() 로 이번 판의 증가를 되돌린다
//   (2026-11-05: CPU 경합으로 '허브 못 감' 6번이 '진척 없음 6판' 오경보가 되어 10205 동승 목표를 6시간 쉼)
let pendingTicks = [];
function progressTick(key, value, limit = 6) {
  const j = readJ('progress.json', {});
  const e = j[key] ?? { val: value, races: 0 };
  if (e.skipUntil && Date.now() < e.skipUntil) return true;
  if (e.val !== value) { e.val = value; e.races = 0; delete e.skipUntil; }
  e.races++; pendingTicks.push(key);
  let stuck = false;
  if (e.races > limit) { e.skipUntil = Date.now() + 6 * 3600e3; e.races = 0; stuck = true; alert(`ANOMALY no progress: ${key} stayed ${value} for ${limit} races -> skip 6h`); }
  j[key] = e; writeJ('progress.json', j);
  return stuck;
}
function progressUndo() { const j = readJ('progress.json', {}); for (const k of pendingTicks) if (j[k]?.races > 0) j[k].races--; pendingTicks = []; writeJ('progress.json', j); }
function progressCommit() { pendingTicks = []; }
function progressSkipped(key) { const e = readJ('progress.json', {})[key]; return !!(e?.skipUntil && Date.now() < e.skipUntil); }
function allowCombine(ids) { allowCombineIds = new Set(ids.map(Number)); }

module.exports = { init, beforeSend, onResponse, computeProtect, progressTick, progressSkipped, progressUndo, progressCommit, allowCombine, carGrade, get protect() { return protectCache; } };
