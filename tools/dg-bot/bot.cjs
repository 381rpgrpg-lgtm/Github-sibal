// 무인 진행 봇: 중계 서버(localhost:8080, DG_RECORD_ALWAYS='*')를 통해 실계정으로
//  (1) 관리 작업은 RPC 로 직접 (레이스 보상 수령, 퀘스트 수락·완료, 업적·기억·우편·일일미션·친밀도 수령, 재료 구매·강화)
//  (2) 레이스는 실제 클라이언트(헤드리스 Chromium)로 플레이 — 판정·기록은 게임 엔진이 계산, 봇은 버튼 누르는 시점만 정한다.
//  결과 화면은 헤드리스에서 렌더링이 멈추므로 결과 요청이 나간 뒤 페이지를 새로 연다.
// node bot.cjs <outdir> [hours]
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2];
const HOURS = Number(process.argv[3] || 20);
const B = 'http://localhost:8080';
const DRIVER = fs.readFileSync(__dirname + '/driver4.js', 'utf8');
const T0 = Date.now();
const log = (s) => fs.appendFileSync(`${OUT}/bot.log`, `[${new Date().toISOString().slice(5, 19)}] ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = fs.existsSync(`${OUT}/stats.json`) ? JSON.parse(fs.readFileSync(`${OUT}/stats.json`, 'utf8')) : { races: [], actions: [] };
const saveStats = () => fs.writeFileSync(`${OUT}/stats.json`, JSON.stringify(stats, null, 1));
const act = (s) => { log('ACT ' + s); stats.actions.push(`${new Date().toISOString().slice(5, 16)} ${s}`); saveStats(); };

// 노드 좌표 (RacePos -> 지도 화면 좌표, 1280x720). 스크린샷으로 확인한 값.
const POS = { 1: [655, 240], 2: [828, 250], 3: [975, 250], 4: [1093, 275], 7: [558, 315], 8: [729, 320], 9: [985, 375],
  10: [1213, 320], 11: [578, 470], 15: [490, 585], 17: [828, 600], 19: [1077, 570],
  5: [1178, 200], 6: [478, 400], 12: [720, 500], 13: [922, 495], 14: [1113, 435], 16: [664, 620], 18: [975, 628] }; // 18: 구역 7 지도 7-5 (2026-11-04 캡처) // 2026-11-03 구역 2·6 지도 캡처
const battle = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/battleTable.json', 'utf8'));
const CARS_T = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/cars.json', 'utf8')).Car;
const racePos = (zone, idx) => battle.BattleArea.find((a) => a.Id === 50000 + zone)?.Race.find((r) => r.RaceIndex === idx)?.RacePos;

// 보호 차량: 현재 차량, Lv5 이상, 한계 돌파, ★3 이상, 현재 차량보다 높은 등급, 현재 차량과 같은 차종 계열(예 106xx) — 재료·분해 금지
// (2026-11-03 사고: 분해 퀘스트가 ★3 10103 을, 강화가 같은 차종 10602 를 써 버림)
// 2026-11-05 사용자 지시: ★2 육성 퀘스트는 끝났으니 ★2 보호 차량도 쓴다 -> Lv5·한계 돌파·같은 계열 보호는 ★3 이상에만. ★3 이상은 계속 보호.
const carGradeOf = (c) => Number(c.Grade) || Number(CARS_T.find((x) => x.Id === c.Cartype)?.Grade) || 1;
const isProtected = (c, cur) => c.Carid === cur?.Carid || carGradeOf(c) >= 3 || c.IsLocked || c.IsExhibited || carGradeOf(c) > carGradeOf(cur ?? {});
// 실제 연료: UserInfo.Fuelvalue 는 최대치, Fueltime 은 가득 차는 시각(서버). 1 = 15초 (실측)
const fuelOf = (ui) => { const left = Number(ui.Fueltime) - Date.now() / 1000; return left > 0 ? Number(ui.Fuelvalue) - Math.ceil(left / 15) : Number(ui.Fuelvalue); };

// ── RPC (중계 서버 경유) ──
let H = null;
async function api() {
  const build = (await (await fetch(B + '/api/version')).json()).build;
  const lr = await (await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dg-build': build }, body: JSON.stringify({ login: 'damissi', password: 'x' }) })).json();
  H = { authorization: 'Bearer ' + lr.token, 'x-dg-build': build, 'content-type': 'application/json' };
}
// 모든 요청은 안전 관문(safety.cjs)을 지난다: 보호 목록·Gold Cash·캐시 상한 검사(보내기 전), 캐시 지출·정상 응답 확인(받은 뒤)
const SAFE = require('./safety.cjs');
SAFE.init(OUT, log);
async function rpc(name, body = {}) {
  const chk = await SAFE.beforeSend(name, body);
  if (!chk.ok) return [];
  if (!H) await api();
  let r = await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name, body }) });
  if (r.status === 401) { await api(); r = await fetch(B + '/api/rpc', { method: 'POST', headers: H, body: JSON.stringify({ name, body }) }); }
  const j = await r.json();
  const msgs = j.messages || [];
  SAFE.onResponse(name, body, msgs);
  return msgs;
}
const pick = (msgs, n) => msgs.find((m) => m.name === n)?.body;

// ── 아이템 칸 정리 (2026-11-05 사용자 지시: 아이템 칸이 차면 봇이 판단해 정리) ──
// 클라이언트 레이스 시작 조건: ItemSlotNum - (부품·데칼(분류 621~625) 을 뺀 아이템 행 수) >= 1, 아니면 'racestart_fail_no_item_inventory_space'.
// 빈 칸이 ITEM_WANT 미만이면 손실 없는 것부터 행을 없앤다 (한 행 = 한 종류, 묶음 전체를 써야 칸이 빈다):
//   1) 바로 환산: 코인·캐시·XP(610), 대전 티켓(641), 이벤트 티켓(642) — 30개 이하 묶음만 (60110 x990 같은 큰 묶음은 둔다)
//   2) 소녀 아이템(612·615·616): 그 소녀가 열려 있고(State 7) 옷장 칸이 남으면 사용 -> 옷장으로 옮겨짐
//   3) 연료 상자(605): 사용 (가득 차면 서버가 거절 -> 6시간 건너뜀)
//   4) 상자(603): 상점 정의에 ItemSlotNeed 가 없을 때만 (있으면 내용물이 다시 칸을 차지). CarSlotNeed·PartSlotNeed 는 빈 칸이 충분할 때만
//   5) 그래도 모자라면 판매(MsgSellPartsReq {Itemid, Itemcnt}): 도색 쿠폰(608, 낮은 등급부터) -> 데이트 티켓(602, 적은 묶음부터)
// 팔지 않음: 판매가 없음(-1·없음), 코어(61006, 한계 돌파 재료), 상자, 소녀 아이템·선물, 티켓, 데이트 쿨타임(601). 칸 확장(캐시)은 하지 않는다.
const ITEM_WANT = 3;
const COINBOX_DAY = 8; // 코인 중고 차량 상자 하루 최대 (6,900 x 8 ≈ 5.5만, 코인 15만 초과분에서만)
const TIDY_SKIP = {}; // Itemtype -> 다시 시도할 시각 (사용 거절 시)
let ITEMT = null;
async function itemTables() {
  if (!ITEMT) {
    const D = '/home/user/Github-sibal/offline-server/data/tables/';
    const { readTable } = await import('/home/user/Github-sibal/offline-server/dist/upserts.js');
    const t = readTable(D + 'itemTable.json', 'itemTable.json');
    ITEMT = { item: new Map(t.Item.map((i) => [i.Id, i])), store: new Map(t.StoreItem.map((s) => [s.Id, s])),
      parts: new Set(JSON.parse(fs.readFileSync(D + 'parts.json', 'utf8')).Part.map((p) => p.Id)),
      gitem: new Map(JSON.parse(fs.readFileSync(D + 'girlItemTable.json', 'utf8')).GirlItemInfo.map((g) => [g.Id, g])),
      text: (() => { try { const x = JSON.parse(fs.readFileSync(D + 'text_kr.json', 'utf8')); return x.Text ?? x; } catch { return {}; } })() };
  }
  return ITEMT;
}
const itemRowCnt = (x) => Number(x.StackNum ?? x.Count ?? 1);
function itemFreeOf(ud, T) {
  const counted = (ud.Items?.ItemInfo ?? []).filter((x) => itemRowCnt(x) > 0 && !T.parts.has(x.Itemtype) && !((c) => c >= 621 && c <= 625)(T.item.get(x.Itemtype)?.Category ?? 0));
  return Number(ud.UserInfo.ItemSlotNum) - counted.length;
}
async function tidyItems(ud0) {
  const T = await itemTables();
  let ud = ud0;
  if (itemFreeOf(ud, T) >= ITEM_WANT) return ud;
  log(`item slots free ${itemFreeOf(ud, T)} < ${ITEM_WANT}: tidy`);
  const cat = (x) => T.item.get(x.Itemtype)?.Category ?? 0;
  const refresh = async () => { ud = pick(await rpc('MsgLoginReq'), 'MsgUserData') ?? ud; };
  const rows = () => (ud.Items?.ItemInfo ?? []).filter((x) => itemRowCnt(x) > 0 && !T.parts.has(x.Itemtype) && !(TIDY_SKIP[x.Itemtype] > Date.now()));
  const partsFree = () => Number(ud.UserInfo.PartsSlotNum) - (ud.Items?.ItemInfo ?? []).filter((x) => T.parts.has(x.Itemtype) && !(x.Equipcarid > 0)).length;
  const girlFree = (gid) => { const g = (ud.MyGirls?.MyGirlInfo ?? []).find((x) => x.Girlid === gid); if (!g || g.State !== 7) return -1;
    const own = (ud.GirlItems?.GirlItemInfo ?? []).filter((x) => T.gitem.get(x.ItemType)?.GirlId === gid).length;
    const worn = ['DressSlot', 'SpecialDressSlot', 'AccessorySlot1', 'AccessorySlot2', 'AccessorySlot3', 'AccessorySlot4'].filter((k) => g[k] > 0).length;
    return (Number(g.GirlItemSlotNum) || 0) - (own - worn); };
  // 행 하나를 사용으로 없앤다 (묶음 전부). 거절되면 그 종류는 6시간 건너뜀
  const useRow = async (x, why, canUse = () => true) => {
    let n = itemRowCnt(x), used = 0, a = null;
    while (n-- > 0 && canUse()) {
      a = pick(await rpc('MsgUseItemReq', { Item: { Itemid: x.Itemid } }), 'MsgUseItemAns');
      if (a?.Result !== 1) break;
      used++;
      if ((a.RewardInfo?.CarInfo ?? []).length || (a.RewardInfo?.ItemInfo ?? []).length) await refresh();
    }
    act(`item tidy use ${x.Itemtype} x${used} (${why}): Result ${a?.Result} ${JSON.stringify(a?.RewardInfo ? { c: a.RewardInfo.Coin, x: a.RewardInfo.Charexp, i: (a.RewardInfo.ItemInfo ?? []).map((r) => r.Itemtype), car: (a.RewardInfo.CarInfo ?? []).map((r) => r.Cartype) } : null)}`);
    if (a?.Result !== 1) TIDY_SKIP[x.Itemtype] = Date.now() + 6 * 3600e3;
    await refresh();
  };
  const flag = Number(ud.UserInfo.SystemOpenFlag) || 0;
  // 1)~4) 사용
  const plan = [
    (x) => cat(x) === 610 && itemRowCnt(x) <= 30 && 'coin/xp',
    (x) => cat(x) === 641 && (flag & 3) && itemRowCnt(x) <= 30 && 'battle ticket',
    (x) => cat(x) === 642 && (flag & 4096) && itemRowCnt(x) <= 30 && 'event ticket',
    (x) => [612, 615, 616].includes(cat(x)) && (() => { const gi = T.gitem.get(parseInt(T.item.get(x.Itemtype)?.Resources, 10)); return gi && girlFree(gi.GirlId) >= itemRowCnt(x); })() && 'girl item',
    (x) => cat(x) === 605 && 'fuel',
    (x) => { if (cat(x) !== 603) return false; const s = T.store.get(parseInt(T.item.get(x.Itemtype)?.Resources, 10));
      if (!s || s.ItemSlotNeed !== undefined) return false;
      if (s.CarSlotNeed !== undefined && Number(ud.UserInfo.GarageSize) - (ud.Cars?.CarInfo ?? []).length < s.CarSlotNeed * itemRowCnt(x)) return false;
      if (s.PartSlotNeed !== undefined && partsFree() < s.PartSlotNeed + 2 * (itemRowCnt(x) - 1)) return false; // 부품 상자: 한 번에 최대 2개 나옴
      return 'box'; },
  ];
  for (const rule of plan) {
    for (const x of rows().filter((r) => rule(r))) {
      if (itemFreeOf(ud, T) >= ITEM_WANT) return ud;
      const why = rule(x); if (!why) continue;
      const s = T.store.get(parseInt(T.item.get(x.Itemtype)?.Resources, 10));
      await useRow(x, why, () => !(s?.PartSlotNeed !== undefined && partsFree() < s.PartSlotNeed) && !(s?.CarSlotNeed !== undefined && Number(ud.UserInfo.GarageSize) - (ud.Cars?.CarInfo ?? []).length < s.CarSlotNeed));
    }
  }
  // 5) 판매: 도색 쿠폰(낮은 등급부터) -> 데이트 티켓(적은 묶음부터)
  const grade = (x) => Number(String(T.item.get(x.Itemtype)?.Info ?? '').match(/grade(\d)/)?.[1] ?? 9);
  const sell = rows().filter((x) => [608, 602].includes(cat(x)) && Number(T.item.get(x.Itemtype)?.SellPrice) > 0 && x.Itemtype !== 61006)
    .sort((a, b) => (cat(b) - cat(a)) || (grade(a) - grade(b)) || (itemRowCnt(a) - itemRowCnt(b)));
  for (const x of sell) {
    if (itemFreeOf(ud, T) >= ITEM_WANT) break;
    const n = itemRowCnt(x);
    // 응답은 MsgDeleteParts {ItemInfo:[{Itemid, StackNum 0}]} (Result 필드 없음, 실기록 1534_...MsgSellPartsReq)
    const m = await rpc('MsgSellPartsReq', n > 1 ? { Itemid: [x.Itemid], Itemcnt: [n] } : { Itemid: [x.Itemid] });
    const ok = (pick(m, 'MsgDeleteParts')?.ItemInfo ?? []).some((r) => r.Itemid === x.Itemid);
    act(`item tidy sell ${x.Itemtype} x${n} (${T.text[T.item.get(x.Itemtype)?.Name] ?? ''}): ${ok ? 'sold' : 'failed ' + m.map((z) => z.name).join(',')}`);
    if (!ok) TIDY_SKIP[x.Itemtype] = Date.now() + 6 * 3600e3;
    await refresh();
  }
  log(`item slots free ${itemFreeOf(ud, T)} after tidy`);
  return ud;
}

// ── 관리 작업 ──
async function manage() {
  let ud = pick(await rpc('MsgLoginReq'), 'MsgUserData');
  if (!ud) { log('login failed'); return null; }
  const ui = ud.UserInfo;
  // 레이스 보상 (State 2 비트)
  for (const z of ud.RaceZones.RaceZone) for (const r of z.Race) if (r.State & 2 && z.ZoneId < 1000) {
    const a = pick(await rpc('MsgRaceRewardReq', { ZoneId: z.ZoneId, RaceId: r.RaceId }), 'MsgRaceRewardAns');
    act(`race reward ${r.RaceId}: ${JSON.stringify(a?.RewardInfo ?? null).slice(0, 160)}`);
  }
  // 아이템 칸 확보 (위 tidyItems). 부품 상자를 열면 부품이 늘어나므로 부품 칸 정리보다 먼저
  try { ud = await tidyItems(ud); } catch (e) { log('item tidy error ' + e.message); }
  // 부품 칸 확보: 레이스 보상 부품이 들어갈 칸이 없으면 시작이 막힌다 (부품 화면으로 이동). 빈 칸 2개 유지, 장착 안 된 ★1 부품부터 판다
  { const parts = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/parts.json', 'utf8')).Part;
    const inv = (ud.Items?.ItemInfo ?? []).filter((it) => parts.some((p) => p.Id === it.Itemtype));
    // 칸 = 장착 안 된 부품 수 기준 (2026-11-04: 미장착 11 / PartsSlotNum 8 에서 이벤트 레이스가 '부품 보관함이 가득' 으로 시작 안 됨)
    //   파는 순서: ★1·★2 (낮은 등급·능력치 합 순) -> 같은 종류가 둘 이상인 ★3 의 남는 것. ★4 이상과 종류별 마지막 1개는 팔지 않는다
    const gradeOf = (it) => parts.find((p) => p.Id === it.Itemtype)?.Grade ?? 9;
    const sumOf = (it) => Object.values(it.Attributes ?? parts.find((p) => p.Id === it.Itemtype)?.Attributes ?? {}).reduce((x, y) => x + Number(y || 0), 0);
    const free = inv.filter((it) => !(it.Equipcarid > 0) && !it.IsLocked);
    const over = free.length + 2 - Number(ui.PartsSlotNum || 8);
    const low = free.filter((it) => gradeOf(it) <= 2).sort((x, y) => gradeOf(x) - gradeOf(y) || sumOf(x) - sumOf(y));
    const seen = new Set(inv.filter((it) => it.Equipcarid > 0).map((it) => it.Itemtype));
    const dup3 = free.filter((it) => gradeOf(it) === 3).sort((x, y) => sumOf(y) - sumOf(x)).filter((it) => { if (seen.has(it.Itemtype)) return true; seen.add(it.Itemtype); return false; }).sort((x, y) => sumOf(x) - sumOf(y));
    const sell = [...low, ...dup3].slice(0, Math.max(0, over));
    if (sell.length) { const d = pick(await rpc('MsgSellPartsReq', { Itemid: sell.map((x) => x.Itemid) }), 'MsgDeleteParts'); act(`sell parts (slots) ${sell.map((x) => x.Itemtype)}: deleted ${(d?.ItemInfo ?? []).length}`); } }
  // 퀘스트: 수락(2->3), 완료(6->7), 상점 구매형 목표(28: 코인·소셜포인트 상품) 수행
  const quests = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/nquests.json', 'utf8')).Quest;
  const items = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/itemTable.json', 'utf8')).StoreItem;
  for (const q of ud.NquestInfos?.NquestInfo ?? []) {
    if (q.State === 2) { await rpc('MsgUpdateNquestReq', { NquestInfo: { QuestId: q.QuestId, State: 3 } }); act(`quest accept ${q.QuestId}`); }
    if (q.State === 6) { const a = pick(await rpc('MsgUpdateNquestReq', { NquestInfo: { QuestId: q.QuestId, State: 7 } }), 'MsgUpdateNquestAns'); act(`quest reward ${q.QuestId}: ${JSON.stringify(a?.RewardInfo ?? null).slice(0, 120)}`); }
    if (q.State === 3 || q.State === 2) {
      const def = quests.find((x) => x.Id === q.QuestId);
      for (const o of def?.Objective ?? []) {
        const cur = q.Objective?.find((x) => x.ObjId === o.ObjId);
        // 부품 강화형 목표(24: [횟수, 대상 등급 이상]): 장착 안 된 그 등급 부품을 대상으로, 남는 ★1 부품을 재료로 조합
        if (Number(o.Type) === 24 && cur && q.State === 3 && cur.CurrentValue < Number(o.Param[0])) {
          for (let n = cur.CurrentValue; n < Number(o.Param[0]); n++) {
            const u2 = pick(await rpc('MsgLoginReq'), 'MsgUserData');
            const parts = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/parts.json', 'utf8')).Part;
            const g = (it) => parts.find((p) => p.Id === it.Itemtype)?.Grade ?? 0;
            const inv = (u2.Items?.ItemInfo ?? []).filter((it) => parts.some((p) => p.Id === it.Itemtype));
            const tgt = inv.find((it) => g(it) >= Number(o.Param[1] || 1) && !(it.Equipcarid > 0)) ?? inv.find((it) => g(it) >= Number(o.Param[1] || 1));
            const free = inv.filter((it) => it !== tgt && !(it.Equipcarid > 0) && !it.IsLocked).sort((a, b) => g(a) - g(b));
            const mat = free[0]; // ★1 우선, 없으면 남는 가장 낮은 등급 부품
            if (!tgt || !mat) { log('quest combine: no parts'); break; }
            const a = pick(await rpc('MsgCombinePartsReq', { Itemid: tgt.Itemid, ConsumeParts: [mat.Itemid] }), 'MsgCombinePartsAns');
            act(`quest combine ${tgt.Itemtype}<-${mat.Itemtype}: Result ${a?.Result}`);
            if (a?.Result !== 1) break;
          }
        }
        // 차량 분해형 목표(20: [횟수]): 현재 차량·키우는 두 번째 ★2(가장 높은 레벨)를 뺀 가장 낮은 등급 차를 1대씩 분해, 없으면 코인 상자(73008)
        if (Number(o.Type) === 20 && cur && q.State === 3 && cur.CurrentValue < Number(o.Param[0])) {
          for (let n = cur.CurrentValue; n < Number(o.Param[0]); n++) {
            let u2 = pick(await rpc('MsgLoginReq'), 'MsgUserData');
            const spare = () => { const cars = u2.Cars.CarInfo, cur = cars.find((c) => c.Carid === u2.UserInfo.Currentcar);
              return cars.filter((c) => !isProtected(c, cur)).sort((a, b) => a.Grade - b.Grade)[0]; };
            let car = spare();
            if (!car && u2.UserInfo.Coin >= 6900 && u2.Cars.CarInfo.length < u2.UserInfo.GarageSize) {
              const b = pick(await rpc('MsgBuyProductReq', { StoreItemId: 73008, Buycount: 1 }), 'MsgBuyProductAns');
              act(`coin box for disassemble: Result ${b?.Result} ${b?.RewardInfo?.CarInfo?.[0]?.Cartype ?? ''}`);
              u2 = pick(await rpc('MsgLoginReq'), 'MsgUserData'); car = spare();
            }
            if (!car) { log('quest disassemble: no spare car'); break; }
            const a = pick(await rpc('MsgDisassembleCarReq', { CarID: [car.Carid] }), 'MsgDisassembleCarAns');
            act(`quest disassemble car ${car.Carid} (${car.Cartype}): Result ${a?.Result}`);
            if (a?.Result !== 1) break;
          }
        }
        // 캐릭터 한계 돌파 목표(7: [1, 캐릭터, 목표 등급], 예 10802 클로디아 2등급): girlTable SGirlExpansionCritSet 조건을 아는 것만 확인하고
        //   (1 데이트 n회 = NthDate, 13 에피소드 n 클리어, 17 연락처 n개) 코인이 되면 MsgGirlRarityExpandReq {GirlInfo:{Girlid}} (클라이언트 코드 형식)
        if (Number(o.Type) === 7 && o.Param.length === 3 && cur && q.State === 3 && cur.CurrentValue < Number(o.Param[0] || 1)) {
          const gid = Number(o.Param[1]), target = Number(o.Param[2]);
          const g = (ud.MyGirls?.MyGirlInfo ?? []).find((x) => x.Girlid === gid && x.State === 7);
          const set = (GIRLT.Girl.find((x) => x.Id === gid)?.SGirlExpansionCritSet ?? []).find((x) => Number(x.TargetRarity) === target);
          if (g && set && Number(g.Rarity) < target) {
            const zoneWon = (n) => ud.RaceZones.RaceZone.some((z) => z.ZoneId === n && z.Race.some((r) => r.RaceIndex === 20 && r.State & 16));
            const contacts = (ud.MyGirls?.MyGirlInfo ?? []).filter((x) => x.State === 7).length - 1;
            const ok = (c) => c.CritType === 1 ? Number(g.NthDate) >= c.Param1 : c.CritType === 13 ? zoneWon(c.Param1) : c.CritType === 17 ? contacts >= c.Param1 : false;
            const crits = set.SGirlExpansionCrit ?? [];
            // 공통 조건(클라이언트 GirlExpansionPopup.SetData): 호감도 4단계, 기분 Emotion 3, 첫 수영복(girlItem Slot 10·판매가<0·Id%100==11) 보유.
            //   2026-11-04 Result 2 의 원인은 수영복 없음이었다. 수영복은 백화점 데이트(장소 없이 Start)의 SHOPLIST 에서 산다:
            //   액세서리 4개(플래그 1|2|4|8, 친밀도 3 이상) 다 산 뒤 수영복(64). 2026-11-05 클로디아: 15 -> 5,800코인, 64 -> 7,540코인 + 82511 지급, 확장 Result 1.
            const bikini = (GITEM.find((i) => i.GirlId === gid && i.Slot === 10 && Number(i.SellPrice) < 0 && i.Id % 100 === 11) ?? {}).Id;
            const hasBikini = (ud.GirlItems?.GirlItemInfo ?? []).some((x) => x.ItemType === bikini);
            const gdef = GIRLT.Girl.find((x) => x.Id === gid) ?? {};
            const flag = Number(g.ItemFlag) || 0;
            const deptOpen = famLv(Number(ud.UserInfo.FirstGirl), Number((ud.MyGirls?.MyGirlInfo ?? []).find((x) => x.Girlid === Number(ud.UserInfo.FirstGirl))?.Familiarity) || 0) >= 3;
            const nowS = Date.now() / 1000;
            if (bikini && !hasBikini && deptOpen && famLv(gid, Number(g.Familiarity) || 0) >= 3 && Number(g.Emotion) !== 2 && !(Number(g.DateCoolTime) > nowS - 5)) {
              const buy = (flag & 15) !== 15 ? (15 & ~flag) : 64;
              const cost = buy === 64 ? Number(gdef.PresentPrice5) || 0 : [1, 2, 3, 4].filter((k) => buy & [0, 1, 2, 4, 8][k]).reduce((s, k) => s + (Number(gdef['PresentPrice' + k]) || 0), 0);
              const cashUnit = buy === 64 ? gdef.PresentPriceUnit5 : [1, 2, 3, 4].map((k) => gdef['PresentPriceUnit' + k]).find((u) => u);
              if (!cashUnit && Number(ud.UserInfo.Coin) >= cost + 20000) { // 코인 결제만 (PriceUnit 없음 = 코인)
                try {
                  const out = require('child_process').execFileSync('node', [__dirname + '/dates.cjs', String(gid), '0', String(buy)], { encoding: 'utf8', timeout: 120000 });
                  act(`department date ${gid} present ${buy} (${cost} coin): ${out.trim().split('\n').pop().slice(0, 200)}`);
                } catch (e) { log('department date error ' + e.message.slice(0, 200)); }
              }
            }
            if (crits.every(ok) && hasBikini && Number(g.Emotion) === 3 && famLv(gid, Number(g.Familiarity) || 0) >= 4 && Number(ud.UserInfo.Coin) >= Number(set.ExpansionCoin) + 20000 && Date.now() - (globalThis['__rxAt' + gid] ?? 0) > 3600e3) {
              globalThis['__rxAt' + gid] = Date.now(); // 거절되면 1시간에 한 번만
              const ms = await rpc('MsgGirlRarityExpandReq', { GirlInfo: { Girlid: gid } });
              act(`girl rarity expand ${gid} -> ${target}: ${JSON.stringify(ms.map((m) => [m.name, m.body?.Result])).slice(0, 160)}`);
            } else if (!globalThis['__rx' + gid]) { globalThis['__rx' + gid] = 1; log(`girl rarity expand ${gid}: waiting (${crits.map((c) => c.CritType + ':' + (ok(c) ? 'ok' : 'no')).join(' ')}, dates ${g.NthDate}, emotion ${g.Emotion}, swimsuit ${hasBikini}, flag ${flag})`); }
          }
        }
        // 부품 장착형 목표(27: [수, 부품 Id]): 가진 그 부품을 현재 차량에 단다. 빈 칸이 있으면 그 칸, 없으면 퀘스트가 요구하지 않는
        //   장착 부품 중 능력치 합이 가장 낮은 칸과 바꾼다 (MsgEquipPartsReq {Itemid, Equipindex, Equipcarid}, 실기록 형식. 예 10604·10702)
        if (Number(o.Type) === 27 && o.Param[1] && cur && q.State === 3 && cur.CurrentValue < Number(o.Param[0] || 1)) {
          const u2 = pick(await rpc('MsgLoginReq'), 'MsgUserData');
          const carId = u2.UserInfo.Currentcar, car = u2.Cars.CarInfo.find((c) => c.Carid === carId);
          const items = u2.Items?.ItemInfo ?? [];
          const it = items.find((i) => i.Itemtype === Number(o.Param[1]) && !(i.Equipcarid > 0));
          if (it && car) {
            const need = new Set((u2.NquestInfos?.NquestInfo ?? []).filter((x) => x.State === 3).flatMap((x) => (quests.find((d) => d.Id === x.QuestId)?.Objective ?? [])
              .filter((d) => Number(d.Type) === 27 && d.Param[1]).map((d) => Number(d.Param[1]))));
            const eq = items.filter((i) => i.Equipcarid === carId);
            const used = new Set(eq.map((i) => i.Equipindex));
            const sum = (i) => Object.values(i.Attributes ?? {}).reduce((a, b) => a + Number(b || 0), 0);
            let idx = Array.from({ length: Number(car.SlotNum) || 1 }, (_, k) => k + 1).find((k) => !used.has(k));
            if (!idx) idx = eq.filter((i) => !need.has(i.Itemtype)).sort((a, b) => sum(a) - sum(b))[0]?.Equipindex;
            if (idx) { const a = pick(await rpc('MsgEquipPartsReq', { Itemid: it.Itemid, Equipindex: idx, Equipcarid: carId }), 'MsgChangeParts');
              act(`quest equip ${it.Itemtype} -> car ${carId} slot ${idx}: Result ${a?.Result}`); }
          }
        }
        if (Number(o.Type) === 28 && cur && cur.CurrentValue < Number(o.Param[0])) {
          const si = items.find((x) => x.Id === Number(o.Param[1]));
          if (si && si.PriceRealMoney === undefined && si.PriceGoldCash === undefined) { // 캐시 상품은 safety 관문의 상한(1회 10, 하루 30) 안에서만
            // 부품 칸 확보 (PartSlotNeed): 장착 안 된 ★1 부품을 판다 (실서버: 칸이 모자라면 Result 8)
            if (si.PartSlotNeed) {
              const u2 = pick(await rpc('MsgLoginReq'), 'MsgUserData');
              const parts = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/parts.json', 'utf8')).Part;
              const inv = (u2.Items?.ItemInfo ?? []).filter((it) => parts.some((p) => p.Id === it.Itemtype));
              const over = inv.length + Number(si.PartSlotNeed) - Number(u2.UserInfo.PartsSlotNum || 8);
              const sell = inv.filter((it) => !(it.Equipcarid > 0) && !it.IsLocked && (parts.find((p) => p.Id === it.Itemtype)?.Grade ?? 9) === 1).slice(0, Math.max(0, over));
              if (sell.length) { const d = pick(await rpc('MsgSellPartsReq', { Itemid: sell.map((x) => x.Itemid) }), 'MsgDeleteParts'); act(`sell parts ${sell.map((x) => x.Itemtype)}: deleted ${(d?.ItemInfo ?? []).length}`); }
            }
            const a = pick(await rpc('MsgBuyProductReq', { StoreItemId: si.Id, Buycount: 1 }), 'MsgBuyProductAns');
            act(`quest buy ${si.Id}: Result ${a?.Result}`);
          }
        }
      }
    }
  }
  // 업적 보상
  const ach = (ud.MyMemorySet?.Memory ?? []).filter((m) => m.State === 2).map((m) => ({ Id: m.Id }));
  if (ach.length) { const a = pick(await rpc('MsgGetMemoryRewardReq', { MyMemorySet: { Memory: ach } }), 'MsgGetMemoryRewardAns'); act(`achievements ${ach.length}: ${JSON.stringify(a?.ItemInfo ?? null).slice(0, 160)}`); }
  // 캐릭터 기억 보상
  const gm = (ud.GirlMemorySet?.GirlMemory ?? []).map((g) => ({ Girlid: g.Girlid, Memory: g.Memory.filter((m) => m.RewardState === 2).map((m) => ({ Id: m.Id })) })).filter((g) => g.Memory.length);
  if (gm.length) { const a = pick(await rpc('MsgGetGirlMemoryRewardReq', { GirlMemorySet: { GirlMemory: gm } }), 'MsgGetGirlMemoryRewardAns'); act(`girl memories ${gm.reduce((s, g) => s + g.Memory.length, 0)}: ${JSON.stringify(a?.ItemInfo ?? null).slice(0, 120)}`); }
  // 이벤트 레이스: 목록 갱신, 승리 보상 수령(State 2 -> 포인트·코인, 수령해야 다음 챕터가 열린다: 실측 3103)
  try {
    const ev = pick(await rpc('MsgRefreshEventRaceReq', {}), 'MsgRefreshEventRaceAns');
    eventZones = ev?.UpdateData?.RaceZone ?? eventZones;
    for (const z of eventZones) for (const r of z.Race ?? []) if (r.State & 2) {
      const a = pick(await rpc('MsgRaceRewardReq', { ZoneId: z.ZoneId, RaceId: r.RaceId }), 'MsgRaceRewardAns');
      act(`event reward ${z.ZoneId}/${r.RaceId}: Result ${a?.Result}`);
    }
    if (eventZones.some((z) => (z.Race ?? []).some((r) => r.State & 2))) eventZones = pick(await rpc('MsgRefreshEventRaceReq', {}), 'MsgRefreshEventRaceAns')?.UpdateData?.RaceZone ?? eventZones;
  } catch (e) { log('event err ' + e); }
  // 우편
  for (const m of ud.MailBox?.Mail ?? []) { await rpc('MsgGetMailItemReq', { Mail: { MailId: m.MailId } }); act(`mail ${m.MailId} ${m.Subject} ${m.Itemtype}x${m.Itemnum}`); }
  // 시즌 보상 (클라이언트 WeeklyRaceResultPopup.OnClickGetReward / WorldTourRewardPopup.OnClickGet):
  //   지난 시즌 결과가 계정 데이터에 있으면 수령. 같은 시즌은 한 번만 (run/season.json)
  { const sf = `${OUT}/season.json`, done = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : {};
    const ws = ud.WraceResult?.WSeasonId;
    if (ws && !done['w' + ws]) {
      const a = pick(await rpc('MsgWRaceRewardReq', { WSeasonId: ws }), 'MsgWRaceRewardAns');
      act(`weekly season ${ws} reward: Result ${a?.Result} ${JSON.stringify(a?.RewardInfo ?? a?.Reward ?? null).slice(0, 160)}`);
      done['w' + ws] = new Date().toISOString(); fs.writeFileSync(sf, JSON.stringify(done));
    }
    const wt = ud.WorldTourResult?.SeasonId ?? ud.WorldTourResult?.Season;
    if (ud.MyWorldTourResult && wt && !done['t' + wt]) {
      const a = pick(await rpc('MsgWorldTourRewardReq', {}), 'MsgWorldTourRewardAns');
      act(`world tour season ${wt} reward: Result ${a?.Result} ${JSON.stringify(a?.RewardInfo ?? null).slice(0, 160)}`);
      done['t' + wt] = new Date().toISOString(); fs.writeFileSync(sf, JSON.stringify(done));
    } }
  // 일일 미션: 데이트 3회 (dates.cjs, 실측 흐름). 사라(퀘스트 10503) 우선, 같은 장소 연속(지루함) 피해 공원·대학·카페 순환, 쿨타임 30초
  try {
    const dqd = (ud.PropertySet?.Property ?? []).find((p) => p.PropertyName === 'DQUEST_DATE');
    const dqAll = (ud.PropertySet?.Property ?? []).find((p) => p.PropertyName === 'DQUEST');
    if (dqAll?.Nvalue === 1 && (dqd?.Nvalue ?? 0) < 3 && ud.UserInfo.Coin > 2000) {
      const open = (id) => (ud.MyGirls?.MyGirlInfo ?? []).find((g) => g.Girlid === id && g.State === 7);
      const girls = [20302, 20405, 20101, 20102].filter(open);
      const places = [41011, 42071, 41022];
      for (let n = dqd?.Nvalue ?? 0, i = 0; n < 3 && i < 6; i++) {
        const g = open(girls[0]); const last = Number(g?.LastDatePlace) || 0;
        const place = places.find((p) => p !== last) ?? 41011;
        const out = require('child_process').execFileSync('node', [__dirname + '/dates.cjs', String(girls[0]), String(place)], { encoding: 'utf8', timeout: 120000 });
        const line = out.trim().split('\n').pop(); act(`date ${girls[0]}@${place}: ${line.slice(0, 200)}`);
        if (/DQUEST_DATE=(\d)/.test(line)) n = Number(RegExp.$1); else break;
        await sleep(35000);
        ud = pick(await rpc('MsgLoginReq'), 'MsgUserData');
      }
    }
  } catch (e) { log('date err ' + String(e).slice(0, 200)); }
  // 퀘스트 데이트: 목표 Type 4 [횟수, 캐릭터, 장소?, 최소 평가] / Type 7 [1, 캐릭터, '', 호감 단계] (데이트로 호감 상승).
  //   장소가 정해져 있으면 그 장소, 아니면 그 캐릭터와 최근에 안 간 장소 순환 (같은 장소 반복은 평가 3으로 떨어짐, 실측 2026-11-03).
  //   한 번 관리에 최대 3회, 코인 2만 이상일 때만. 쿨타임 지난 캐릭터만.
  try {
    if (ud.UserInfo.Coin > 20000) {
      const nowS = Date.now() / 1000, gid = (p) => (p === '[FIRSTGIRL]' ? Number(ud.UserInfo.FirstGirl) : Number(p));
      const open = (id) => (ud.MyGirls?.MyGirlInfo ?? []).find((g) => g.Girlid === id && g.State === 7 && !(Number(g.DateCoolTime) > nowS - 5));
      const PL = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/datingPlaces.json', 'utf8')).Place; // 가격 0 = 데이트 티켓 장소 (티켓 없으면 시작 실패 Result 2, 2026-11-04 43152)
      const places = (ud.DateZone?.Place ?? []).filter((p) => p.State === 1 && p.Placeid >= 41011 && p.Placeid <= 44244 && Number(PL.find((x) => x.Id === p.Placeid)?.Price) > 0).map((p) => p.Placeid);
      const hf = `${OUT}/dateplaces.json`; let hist = {}; try { hist = JSON.parse(fs.readFileSync(hf, 'utf8')); } catch {}
      const want = new Map();
      for (const q of ud.NquestInfos?.NquestInfo ?? []) if (q.State === 3) for (const o of QUESTS.find((x) => x.Id === q.QuestId)?.Objective ?? []) {
        const cur = q.Objective?.find((x) => x.ObjId === o.ObjId)?.CurrentValue ?? 0;
        if (cur >= Number(o.Param[0] || 1)) continue;
        // 한계 돌파 목표(7 [1, 캐릭터, 등급])는 데이트 횟수 조건(CritType 1)이 남았을 때만 데이트 (넘으면 데이트로 더 진행되지 않음)
        if (Number(o.Type) === 7 && o.Param.length === 3) { const gg = gid(o.Param[1]); const gi = (ud.MyGirls?.MyGirlInfo ?? []).find((x) => x.Girlid === gg);
          const need = (GIRLT.Girl.find((x) => x.Id === gg)?.SGirlExpansionCritSet ?? []).find((x) => Number(x.TargetRarity) === Number(o.Param[2]))?.SGirlExpansionCrit?.find((c) => c.CritType === 1)?.Param1 ?? 0;
          if (!gi || Number(gi.NthDate) >= need) continue; }
        if (Number(o.Type) === 4 || Number(o.Type) === 7) { const g = gid(o.Param[1]); const pl = Number(o.Type) === 4 ? Number(o.Param[2]) || 0 : 0;
          if (g && (!want.has(g) || pl)) want.set(g, { q: q.QuestId, place: pl }); }
      }
      for (const g of unlockDateTargets(ud)) if (!want.has(g)) want.set(g, { q: 'unlock', place: 0 });
      let n = 0;
      for (const [g, w] of want) {
        if (n >= 3 || !open(g)) continue;
        const h = hist[g] ?? [], last = Number(open(g)?.LastDatePlace) || 0;
        // 특별 장소(SpecialDate, 예 고급 리조트 40016 RestrictionFamiliarity 3)는 그 호감도 단계가 되기 전에는 거절됨(Date_Special_Deny) -> 일반 장소로 호감도부터
        const sp = PL.find((x) => x.Id === w.place), gd = GIRLT.Girl.find((x) => x.Id === g), fam = Number(open(g)?.Familiarity) || 0;
        //   그 캐릭터의 특별 데이트(girlTable SpecialDate)는 친밀도 SpecialDateCondition 이상이어야 함 (클로디아 40016 = 3600. 미달이면 거절되고 코인 1300 소모, 2026-11-04)
        if (sp && String(sp.SpecialDate) === 'True' && (famLv(g, fam) < Number(sp.RestrictionFamiliarity || 1) || (Number(gd?.SpecialDate) === sp.Id && fam < Number(gd?.SpecialDateCondition || 0)))) w.place = 0;
        const place = w.place || places.find((p) => !h.includes(p) && p !== last) || places.find((p) => p !== last) || 41011;
        const out = require('child_process').execFileSync('node', [__dirname + '/dates.cjs', String(g), String(place)], { encoding: 'utf8', timeout: 120000 });
        const line = out.trim().split('\n').pop(); act(`quest date ${w.q} ${g}@${place}: ${line.slice(0, 160)}`);
        hist[g] = [place, ...h.filter((p) => p !== place)].slice(0, Math.max(1, places.length - 1)); fs.writeFileSync(hf, JSON.stringify(hist));
        n++; await sleep(5000);
      }
      if (n) ud = pick(await rpc('MsgLoginReq'), 'MsgUserData');
    }
  } catch (e) { log('quest date err ' + String(e).slice(0, 200)); }
  // 일일 미션
  const dq = (ud.PropertySet?.Property ?? []).find((p) => p.PropertyName === 'DQUEST');
  if (dq?.Nvalue === 2) { await rpc('MsgGetDailyQuestRewardReq', {}); act('daily mission reward'); }
  // 친밀도 코인
  const now = Date.now() / 1000;
  for (const g of ud.MyGirls?.MyGirlInfo ?? []) if (g.State === 7 && g.NextFamiliarityTime && g.NextFamiliarityTime < now) {
    await rpc('MsgCollectFamiliarityReq', { GirlInfo: g }); act(`familiarity coin ${g.Girlid}`);
  }
  ud = pick(await rpc('MsgLoginReq'), 'MsgUserData');
  // 차량 강화: 무료 일일 상자(71026), 코인 상자(73008, 코인 > 20000 이고 차고 여유) -> 현재 차량 재료 강화
  try {
    const cars = ud.Cars.CarInfo, cur = ud.UserInfo.Currentcar;
    if (cars.length < ud.UserInfo.GarageSize) {
      const free = (ud.OnedayFreeShop ?? []).find((x) => x.StoreItemId === 71026);
      if (free && !(free.ExipreTime > now)) { const a = pick(await rpc('MsgBuyProductReq', { StoreItemId: 71026, Buycount: 1 }), 'MsgBuyProductAns'); act(`free box: Result ${a?.Result} ${a?.RewardInfo?.CarInfo?.[0]?.Cartype ?? ''}`); }
    }
    ud = pick(await rpc('MsgLoginReq'), 'MsgUserData');
    // 강화 대상 (2026-11-05): ★3 육성·조합 퀘스트(10803/10805 '★3 Lv10 1·2대', 10901 '조합으로 ★4')를 위해 Lv10 미만 ★3 중 레벨 높은 것 먼저
    //   (★3 은 레벨당 경험치 40, ★4 는 80). ★3 이 없거나 다 Lv10 이면 가장 높은 등급 차량.
    const curCar = ud.Cars.CarInfo.find((c) => c.Carid === ud.UserInfo.Currentcar);
    const others = ud.Cars.CarInfo.filter((c) => c.Carid !== curCar.Carid && !c.IsLocked && !c.IsExhibited);
    // ★3 육성 대상 = 레벨·경험치 높은 ★3 2대 (사용자 선택 2026-11-05: ★3 2대 육성, 나머지 ★3 은 재료).
    //   육성 대상이 2대 다 정해졌을 때만 남는 ★3 Lv1 을 재료로 쓴다 (2대 미만이면 어떤 ★3 도 재료 금지 — 같은 날 사고: 육성 대상 ★3 이 재료로 쓰임)
    const g3all = ud.Cars.CarInfo.filter((c) => carGradeOf(c) === 3 && c.Carid !== curCar.Carid)
      .sort((a, b) => b.UpgradeLevel - a.UpgradeLevel || (Number(b.CarExp) || 0) - (Number(a.CarExp) || 0) || a.Carid - b.Carid);
    const grow3 = new Set(g3all.slice(0, 2).map((c) => c.Carid));
    const spare3 = (c) => g3all.length > 2 && carGradeOf(c) === 3 && !grow3.has(c.Carid) && Number(c.UpgradeLevel) === 1 && !(Number(c.ExpansionLevel) > 0) && !c.IsLocked && !c.IsExhibited;
    const g3 = g3all.filter((c) => grow3.has(c.Carid) && c.UpgradeLevel < 10);
    const best = ud.Cars.CarInfo.slice().sort((a, b) => carGradeOf(b) - carGradeOf(a) || b.UpgradeLevel - a.UpgradeLevel)[0];
    const target = g3[0] ?? (best.UpgradeLevel < 10 ? best : null);
    // 재료 상자 (사용자 지시: 코인은 쌓아 둘 필요 없이 적정선에서): 강화 대상이 있고 재료(★1·★2)가 없고 차고가 비면
    //   소셜 포인트 차량 상자(72007, 150 SP) -> 코인 중고 차량 상자(73008, 코인 15만 초과분만). 하루 코인 상자 최대 COINBOX_DAY 개.
    const matsNow = target ? others.filter((c) => c.Carid !== target.Carid && (!isProtected(c, curCar) || spare3(c)) && carGradeOf(c) <= carGradeOf(target)) : [];
    if (target && !matsNow.length && ud.Cars.CarInfo.length < ud.UserInfo.GarageSize) {
      const day = new Date().toISOString().slice(0, 10), cbf = `${OUT}/coinbox.json`;
      const cb = fs.existsSync(cbf) ? JSON.parse(fs.readFileSync(cbf, 'utf8')) : {};
      const sp = Number(ud.UserInfo.SocialPoint) >= 150, coin = Number(ud.UserInfo.Coin) - 6900 >= 150000 && (cb[day] ?? 0) < COINBOX_DAY;
      if (sp || coin) {
        const id = sp ? 72007 : 73008, cash0 = Number(ud.UserInfo.Cash);
        const a = pick(await rpc('MsgBuyProductReq', { StoreItemId: id, Buycount: 1 }), 'MsgBuyProductAns');
        if (Number(a?.UserInfo?.Cash ?? cash0) < cash0) { log('car box spent cash! stop boxes'); globalThis.__noBox = 1; }
        if (!sp) { cb[day] = (cb[day] ?? 0) + 1; fs.writeFileSync(cbf, JSON.stringify(cb)); }
        act(`${sp ? 'social' : 'coin'} car box ${id}: Result ${a?.Result} ${(a?.RewardInfo?.CarInfo ?? []).map((c) => c.Cartype).join(',')}`);
        ud = pick(await rpc('MsgLoginReq'), 'MsgUserData');
      }
    }
    // 넘치지 않게: 필요한 경험치까지만 재료를 넣는다 (작은 것부터)
    const LVT = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/carLevelTable.json', 'utf8')).CarLevels;
    const lvRow = (g, l) => LVT.find((x) => x.Grade === g)?.CarLevel.find((r) => r.Level === l) ?? {};
    const matExp = (c) => Number(lvRow(carGradeOf(c), Number(c.UpgradeLevel) || 1).MaterialExp) || 0;
    let need = target ? -(Number(target.CarExp) || 0) : 0;
    if (target) for (let l = target.UpgradeLevel; l < 10; l++) need += Number(lvRow(carGradeOf(target), l).CarExp) || 0;
    const pool = target ? ud.Cars.CarInfo.filter((c) => c.Carid !== target.Carid && c.Carid !== curCar.Carid && !c.IsLocked && !c.IsExhibited && (!isProtected(c, curCar) || spare3(c)) && carGradeOf(c) <= carGradeOf(target)).sort((a, b) => matExp(a) - matExp(b)) : [];
    const mats = []; let got = 0; for (const c of pool) { if (got >= need) break; mats.push(c); got += matExp(c); }
    if (mats.length && ud.UserInfo.Coin > 8000) {
      const info = pick(await rpc('MsgUpgradeInfoReq', { TargetCarInfo: { Carid: target.Carid }, SourceCarInfo: mats.map((c) => ({ Carid: c.Carid })) }), 'MsgUpgradeInfoAns');
      const cost = info?.Cost?.Coin ?? 1e9;
      if (cost < ud.UserInfo.Coin - 3000) {
        const a = pick(await rpc('MsgUpgradeCarReq', { TargetCarInfo: { Carid: target.Carid }, SourceCarInfo: mats.map((c) => ({ Carid: c.Carid })) }), 'MsgUpgradeCarAns');
        act(`upgrade car ${target.Carid} with ${mats.map((c) => c.Cartype)} cost ${cost}: Result ${a?.Result} -> Lv ${a?.ResultCarInfo?.UpgradeLevel}`);
      }
    }
  } catch (e) { log('upgrade err ' + e); }
  return pick(await rpc('MsgLoginReq'), 'MsgUserData');
}

// 다음 목표 레이스: 가장 높은 열린 구역에서 아직 이기지 않은 플레이 가능 레이스 (본편 -> 보스 -> 캐릭터)
// 캐릭터 연락처 해금 조건(girlTable GirlUnlockCrit)에서 데이트가 필요한 캐릭터: 관계도 노드 State 5(일부 충족)인 캐릭터의
//   조건 1·2 [캐릭터 X 호감도 3·4단계] 미충족이면 X, 조건 5 [나머지 충족 뒤 X 와 데이트]는 1·2·8 이 다 충족됐으면 X.
//   (예 20206 주아: 7-15 승리 + 20102·20107 호감도 3단계 + 20107 데이트 -> 7-26 캐릭터 레이스 -> 연락처 -> 8-1 퀘스트 10706)
const GIRLT = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/girlTable.json', 'utf8'));
const GITEM = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/girlItemTable.json', 'utf8')).GirlItemInfo;
function famLv(id, fam) { const d = GIRLT.Girl.find((x) => x.Id === id) ?? {}; let edge = 0, lv = 1;
  for (const sct of [d.FamiliaritySection1 ?? 400, d.FamiliaritySection2 ?? 230, d.FamiliaritySection3 ?? 1300]) { edge += Number(sct); if (fam >= edge) lv++; else break; } return Math.min(lv, 4); }
function unlockDateTargets(ud) {
  const mine = (id) => (ud.MyGirls?.MyGirlInfo ?? []).find((g) => g.Girlid === id && g.State === 7);
  const lvOf = (id) => { const g = mine(id); return g ? famLv(id, Number(g.Familiarity) || 0) : 0; };
  const won = (area, idx) => (ud.RaceZones.RaceZone.find((z) => z.ZoneId === area - 50000)?.Race ?? []).some((r) => r.RaceIndex === idx && r.State & 16);
  const out = [];
  // 진행 중 퀘스트가 연락처를 요구하는 캐릭터(목표 Type 5)의 노드를 먼저
  const qGirls = new Set((ud.NquestInfos?.NquestInfo ?? []).filter((q) => q.State === 3).flatMap((q) => (QUESTS.find((x) => x.Id === q.QuestId)?.Objective ?? [])
    .filter((o) => Number(o.Type) === 5).map((o) => Number(o.Param[1]))));
  const nodes = [...(ud.Ggraph?.Gnode ?? [])].sort((a, b) => (qGirls.has(b.GirlInfo?.Girlid) ? 1 : 0) - (qGirls.has(a.GirlInfo?.Girlid) ? 1 : 0));
  for (const n of nodes) {
    if (n.State !== 5 || !n.GirlInfo?.Girlid) continue;
    const crits = GIRLT.GirlUnlockCrit.filter((c) => c.Girlid === n.GirlInfo.Girlid);
    const met = (c) => c.CritType === 1 ? lvOf(c.Parameter1) >= 3 : c.CritType === 2 ? lvOf(c.Parameter1) >= 4 : c.CritType === 8 ? won(c.Parameter1, c.Parameter2) : c.CritType === 4 ? true : null;
    for (const c of crits) if ((c.CritType === 1 || c.CritType === 2) && !met(c) && mine(c.Parameter1)) out.push(c.Parameter1);
    if (crits.filter((c) => [1, 2, 8].includes(c.CritType)).every((c) => met(c))) for (const c of crits) if (c.CritType === 5 && mine(c.Parameter1)) out.push(c.Parameter1);
  }
  return [...new Set(out)];
}
// 지도를 열면 처음 보이는 구역: 열린 본편 구역 중 가장 높은 것
const latestZone = (ud) => Math.max(...ud.RaceZones.RaceZone.filter((z) => z.ZoneId < 1000 && !z.Locked).map((z) => z.ZoneId));
function nextRace(ud, skip = new Set()) {
  const zones = ud.RaceZones.RaceZone.filter((z) => z.ZoneId < 1000 && !z.Locked).sort((a, b) => b.ZoneId - a.ZoneId);
  for (const z of zones) {
    const cand = z.Race.filter((r) => r.State & 1 && !(r.State & 16) && !(r.State & 8) && POS[racePos(z.ZoneId, r.RaceIndex)] && !skip.has(r.RaceId)).sort((a, b) => a.RaceIndex - b.RaceIndex);
    if (cand.length) return { zone: z.ZoneId, race: cand[0], latest: zones[0].ZoneId };
  }
  return null;
}

// 파밍 레이스: 이미 이긴 본편 레이스(11~16, 위치 아는 것). 일일 보상 레이스(캐시+1) 우선, 다음은 가장 높은 구역(이동이 짧음)
//   재승리 = 숙련도 +2, 코인 RewardCoin(600) (실기록 1-12)
function farmRace(ud) {
  const zones = ud.RaceZones.RaceZone.filter((z) => z.ZoneId < 1000 && !z.Locked);
  const latest = Math.max(...zones.map((z) => z.ZoneId));
  const now = Date.now() / 1000, all = [];
  for (const z of zones) for (const r of z.Race)
    if (r.State & 16 && r.State & 1 && r.RaceIndex >= 11 && r.RaceIndex <= 19 && POS[racePos(z.ZoneId, r.RaceIndex)])
      all.push({ zone: z.ZoneId, race: r, latest, daily: Number(r.DailyRewardTime) > now });
  all.sort((a, b) => (b.daily - a.daily) || (b.zone - a.zone) || (a.race.RaceIndex - b.race.RaceIndex));
  return all[0] ?? null;
}

// 한계 돌파 퀘스트(목표 Type 29, 예 10602 -> 6-13 개방): 한계 돌파 안 한 ★2 차량(가장 높은 레벨)을 현재 차량으로 Lv10·숙련도 최대까지 키운 뒤 돌파.
//   (TOFU 는 이미 1회 돌파 -> 재시도 Result 2, ★4 Lv1·★2 Lv9 도 Result 2: Lv10·숙련도 최대가 조건으로 추정)
const QUESTS = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/nquests.json', 'utf8')).Quest;
const TEXT_KR = (() => { try { const t = JSON.parse(fs.readFileSync('/home/user/Github-sibal/offline-server/data/tables/text_kr.json', 'utf8')); return t.Text ?? t; } catch { return {}; } })();
function expandQuestActive(ud) {
  for (const q of ud.NquestInfos?.NquestInfo ?? []) {
    if (q.State !== 3) continue;
    const def = QUESTS.find((x) => x.Id === q.QuestId);
    for (const o of def?.Objective ?? []) if (Number(o.Type) === 29 && (q.Objective.find((x) => x.ObjId === o.ObjId)?.CurrentValue ?? 0) < Number(o.Param[0])) return true;
  }
  return false;
}
const expandCar = (ud) => ud.Cars.CarInfo.filter((c) => c.Grade === 2 && !(Number(c.ExpansionLevel) > 0)).sort((a, b) => b.UpgradeLevel - a.UpgradeLevel || b.Mastery - a.Mastery)[0];
const attrSum = (c) => Object.values(c.Attributes).reduce((a, b) => a + b, 0) + Object.values(c.MasteryAttr ?? {}).reduce((a, b) => a + b, 0);
// 쉬운 파밍 레이스: 상대 능력치 합(battleTable Difficulty)이 내 차량 합의 85% 이하인 이긴 레이스 중 가장 어려운 것
function easyRace(ud, car) {
  const zones = ud.RaceZones.RaceZone.filter((z) => z.ZoneId < 1000 && !z.Locked);
  const latest = Math.max(...zones.map((z) => z.ZoneId)), lim = attrSum(car) * 0.85, all = [];
  for (const z of zones) for (const r of z.Race) {
    const d = Number(battle.BattleArea.find((a) => a.Id === 50000 + z.ZoneId)?.Race.find((x) => x.RaceIndex === r.RaceIndex)?.Opponent?.Difficulty) || 0;
    if (r.State & 16 && r.State & 1 && r.RaceIndex >= 11 && r.RaceIndex <= 19 && d && d <= lim && POS[racePos(z.ZoneId, r.RaceIndex)]) all.push({ zone: z.ZoneId, race: r, latest, d });
  }
  all.sort((a, b) => b.d - a.d);
  return all[0] ?? null;
}

// 이벤트 챕터 레이스: 아직 안 이긴 챕터 중 포인트(WinPoint)가 있는 것. 카드 순서 0 = 3103 Halloween Night Open(전 차종)
// 이벤트 지도 노드 좌표 (PosId -> 화면, 이야기 지도와 다름. 2026-11-03 핼러윈 캡처)
const EVENT_POS = { 15: [463, 590], 12: [750, 500], 8: [840, 410] };
const EVENT_CARD = { 3103: 0, 3000: 1, 3001: 2 }; // 카드 순서: 할로윈, Panic at Atratasus, Detective Claire
// 이벤트별 지도 좌표 (PosId 가 같아도 지도가 다르다). 3001 PosId 13: 2026-11-04 캡처
const EVENT_POS_Z = { 3001: { 13: [918, 515] } };
// 차량 조건이 맞지 않는 이벤트 (3000 Panic at Atratasus = 독일차만, 현재 ★4 는 일본차)
const EVENT_NOCAR = new Set([3000]);
// 이벤트 참가 조건 LimitGirlId·LimitGirlFMLevel 중 하나라도 맞는지
function eventGirlOk(ud, ez) {
  if (!ud) return true;
  const ar = battle.BattleArea.find((a) => a.Id === 50000 + ez);
  const lim = (ar?.LimitGirlId ?? []).map((g, i) => [g, Number(ar.LimitGirlFMLevel?.[i]) || 1]);
  return !lim.length || lim.some(([g, lv]) => { const m = (ud.MyGirls?.MyGirlInfo ?? []).find((x) => x.Girlid === g && x.State === 7); return m && famLv(g, Number(m.Familiarity) || 0) >= lv; });
}
function eventRace() {
  if (globalThis.__noEvent) return null;
  // 이벤트가 '결과 없음'으로 끝나면(예: 아이템 보관함 가득) 6시간 동안 이벤트 전체를 쉰다 (run/EVENTBLOCK 시각)
  try { if (Date.now() - fs.statSync(`${OUT}/EVENTBLOCK`).mtimeMs < 6 * 3600e3) return null; } catch {}
  for (const z of eventZones) {
    const card = EVENT_CARD[z.ZoneId]; if (card === undefined || EVENT_NOCAR.has(z.ZoneId) || !eventGirlOk(globalThis.__ud, z.ZoneId)) continue;
    const r = (z.Race ?? []).filter((x) => x.State & 1 && !(x.State & 16) && Number(x.WinPoint) > 0 && !(globalThis.__noResSkip ?? []).includes(x.RaceId)).sort((a, b) => a.RaceIndex - b.RaceIndex)[0]; // 결과 없음 반복(예 보관함 가득) 레이스는 건너뜀
    if (r) return { mode: 'event', card, zone: z.ZoneId, race: r, posId: r.PosId };
  }
  return null;
}

// ── 브라우저 ──
let browser, page, lastResult = null, raceStartAt = 0, eventZones = [];
const reqSeen = []; // 브라우저가 보낸 RPC 이름 (화면 전환 확인용)
let ogt = '';
async function openGame() {
  const t0 = Date.now(), mark = (n) => { ogt += ` ${n}:${Math.round((Date.now() - t0) / 1000)}`; }; ogt = '';
  if (browser) { try { await browser.close(); } catch {} }
  mark('closed');
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.route('**/*', async (r) => { const u = new URL(r.request().url());
    if (!(u.protocol === 'data:' || u.protocol === 'blob:' || (u.hostname === 'localhost' && u.port === '8080'))) return r.abort();
    // 빨리감기 때 결과 요청은 '주행 시작 + 기록 + 8초' 까지 붙잡는다 (실제 주행처럼 보이게: 경과 시간 검사 대비)
    if (u.pathname === '/api/rpc' && raceStartAt) {
      const pd = r.request().postData() || '';
      if (pd.includes('"MsgBattleResultReq"')) {
        try { const b = JSON.parse(pd).body; const need = raceStartAt + ((Number(b.TimeRecord) || 40) + 8) * 1000 - Date.now();
          if (need > 0) { log(`hold result ${Math.round(need / 1000)}s`); await sleep(need); } } catch {}
      }
    }
    return r.continue(); });
  page.on('response', async (res) => {
    try {
      if (!res.url().endsWith('/api/rpc')) return;
      const req = JSON.parse(res.request().postData() || '{}');
      if (req.name === 'MsgBattleResultReq') { const j = await res.json(); lastResult = { req: req.body, ans: j.messages?.[0]?.body }; }
    } catch {}
  });
  let hubSeen = false;
  page.on('request', (r) => { if (!r.url().endsWith('/api/rpc')) return; const pd = r.postData() || '';
    if (pd.includes('MsgSpecialMessageListReq')) hubSeen = true;
    try { reqSeen.push(JSON.parse(pd).name); if (reqSeen.length > 200) reqSeen.splice(0, 100); } catch {} });
  mark('launched');
  await page.goto(B + '/', { waitUntil: 'domcontentloaded' });
  mark('loaded');
  await page.waitForSelector('input', { timeout: 180000 });
  mark('input');
  const ins = await page.$$('input');
  await ins[0].fill('damissi'); await ins[1].fill('offline'); await ins[1].press('Enter');
  for (let i = 0; i < 120 && !hubSeen; i++) await sleep(2000);
  mark('hub');
  await sleep(8000);
  for (let i = 0; i < 3; i++) { await page.mouse.click(1240, 103); await sleep(2500); }
  await page.mouse.click(640, 590); await sleep(2000);
  return hubSeen;
}
const evalJ = (s) => page.evaluate(s);
async function shot(n) { try { await page.screenshot({ path: `${OUT}/${n}.png`, timeout: 60000 }); } catch (e) { log('shot fail ' + n); } }

// 도전 화면 좌표 (1280x720, 2026-11-03 캡처): 허브 Challenge(1190,640) -> 이벤트(485,450)/주간(175,450)
//   이벤트 카드: 0 Halloween Night Open(전 차종) 205, 1 Panic at Atratasus(독일차) 585, 2 Detective Claire(비독일차) 965 / 노드(463,590) / Start(190,640)
//   주간: Prepare(1040,665) -> Import current settings(1040,388) -> Start Race(1040,665)
const EVENT_CARD_X = [205, 585, 965];
async function playRace(t) {
  const pos = t.mode === 'story' || !t.mode ? racePos(t.zone, t.race.RaceIndex) : null;
  const xy = pos ? POS[pos] : null;
  if ((t.mode === 'story' || !t.mode) && !xy) { log(`unknown RacePos ${pos} for ${t.zone}-${t.race.RaceIndex}`); return 'nopos'; }
  const tp0 = Date.now(), tp = (n) => phases.push(`${n}:${Math.round((Date.now() - tp0) / 1000)}`); const phases = [];
  if (!(await openGame())) { log('hub not reached'); return 'nohub'; }
  tp('hub');
  if (t.mode === 'worldtour') {
    // 월드 투어 (2026-11-05 기록): 허브 Challenge(1190,640) -> World Tour 카드(795,450) -> Start Race(1080,662)
    //   -> MsgBattleMatchReq (상대·트랙) -> 매칭 화면 카운트다운 뒤 자동 MsgBattleStartReq {RaceType 4} -> 대화 -> 주행 -> MsgBattleResultReq
    //   하루 시도 횟수(LeftTry 7)와 Big Race Ticket 1장씩 사용. 루프에서 LeftTry·티켓을 확인하고 들어온다
    // 화면 확인: World Tour 카드를 누르면 MsgOpenWorldTourReq 가 나간다. 안 나갔으면(2026-11-05: Challenge 대신 이벤트 목록이 열림) 뒤로 가서 다시
    let opened = false;
    for (let k = 0; k < 3 && !opened; k++) {
      if (k) { for (let j = 0; j < 3; j++) { await page.mouse.click(60, 25); await sleep(3000); } }
      reqSeen.length = 0;
      await page.mouse.click(460, 610); await sleep(2500); // 허브의 '새 거리 단어' 팝업 OK (2026-11-05: 월드 투어 브론즈 단어 팝업이 클릭을 가로챔)
      await page.mouse.click(1190, 640); await sleep(7000);
      await page.mouse.click(795, 450); await sleep(9000);
      opened = reqSeen.includes('MsgOpenWorldTourReq');
      if (!opened) { log(`world tour screen not opened (try ${k + 1}): ${reqSeen.slice(-6).join(',')}`); await shot('wt-fail'); }
    }
    if (!opened) return 'noresult';
    await evalJ(DRIVER); await evalJ('window.__botSmart = true; window.__botLead = 0; window.__botLeadEnd = 0');
    tp('map'); await shot('last-panel');
    lastResult = null; raceStartAt = 0;
    reqSeen.length = 0;
    await page.mouse.click(1080, 662); await sleep(15000);
    if (!reqSeen.includes('MsgBattleMatchReq')) { log(`world tour match not requested: ${reqSeen.join(',')}`); await shot('wt-fail'); return 'noresult'; }
    return await finishRace(t, tp, phases);
  }
  if (t.mode === 'event' || t.mode === 'weekly') {
    await page.mouse.click(460, 610); await sleep(2500);         // '새 거리 단어' 팝업 OK (없으면 빈 곳)
    await page.mouse.click(1190, 640); await sleep(7000);        // Challenge
    if (t.mode === 'event') { await page.mouse.click(485, 450); await sleep(8000); await page.mouse.click(EVENT_CARD_X[t.card], 450); await sleep(8000); }
    else { await page.mouse.click(175, 450); await sleep(8000); await page.mouse.click(1040, 665); await sleep(5000); await page.mouse.click(1040, 388); await sleep(2500); await page.mouse.click(818, 502); await sleep(2500); } // 현재 설정 가져오기 확인 창
    await evalJ(DRIVER); await evalJ('window.__botSmart = false; window.__botLead = 0; window.__botLeadEnd = 0');
    tp('map');
    if (t.mode === 'event') {
      // 새 챕터 노드: 지도 스크린샷에서 'NEW' 표식을 찾는다 (findnew.py), 못 찾으면 기록된 좌표
      let ep = EVENT_POS_Z[t.zone]?.[t.posId] ?? EVENT_POS[t.posId];
      try { await page.screenshot({ path: `${OUT}/evmap.png`, timeout: 60000 });
        const o = require('child_process').execFileSync('python3', [__dirname + '/findnew.py', `${OUT}/evmap.png`], { encoding: 'utf8' }).trim();
        if (/^\d+ \d+$/.test(o)) { ep = o.split(' ').map(Number); log(`event node PosId ${t.posId} at ${o}`); } } catch (e) { log('findnew err ' + e); }
      if (!ep) { log(`event node not found PosId ${t.posId}`); return 'nopos'; }
      await page.mouse.click(ep[0], ep[1]); await sleep(4000); }
    await shot('last-panel');
    lastResult = null; raceStartAt = 0;
    await page.mouse.click(t.mode === 'event' ? 190 : 1040, t.mode === 'event' ? 640 : 665); await sleep(8000);
    return await finishRace(t, tp, phases);
  }
  await page.mouse.click(1030, 640); await sleep(15000);       // Race
  await page.mouse.click(350, 612); await sleep(3000);         // 거리 단어 팝업 OK (없으면 왼쪽 패널 빈 곳)
  await page.mouse.click(968, 468); await sleep(2000);         // 팝업이 없을 때 위 클릭이 연 동승자 호감도 창 닫기 (X)
  for (let i = 0; i < t.latest - t.zone; i++) { await page.mouse.click(425, 682); await sleep(4500); }
  await evalJ(DRIVER); await evalJ(`window.__botSmart = ${!!t.smart}`);
  { const rd = (f) => { try { return Number(fs.readFileSync(`${OUT}/${f}`, 'utf8')) || 0; } catch { return 0; } };
    t.lead = rd('LEAD'); t.leadEnd = rd('LEADEND'); await evalJ(`window.__botLead = ${t.lead}; window.__botLeadEnd = ${t.leadEnd}`); }
  tp('map');
  // 노드 패널이 열렸는지 확인: 패널 닫기(X) 버튼 (376,95) 이 흰색. 안 열렸으면 다시 클릭 (7-25: 클릭이 안 먹고 Start 자리에 '동승자 고르기'가 눌렸음, 2026-11-03)
  let opened = false;
  for (let k = 0; k < 3 && !opened; k++) {
    await page.mouse.click(xy[0], xy[1]); await sleep(5000);
    await shot('last-panel');
    try { opened = require('child_process').execFileSync('python3', ['-I', '-c', "import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGB');print(int(min(im.getpixel((376,95)))>200))", `${OUT}/last-panel.png`], { encoding: 'utf8' }).trim() === '1'; } catch (e) { log('panel check err ' + e); opened = true; }
    if (!opened) log(`panel not open (try ${k + 1})`);
  }
  if (!opened) return 'noresult';
  lastResult = null; raceStartAt = 0;
  await page.mouse.click(190, 657); await sleep(8000);          // Start
  return await finishRace(t, tp, phases);
}
async function finishRace(t, tp, phases) {
  // 시작 전 대화 넘기기
  for (let i = 0; i < 60; i++) {
    const st = await evalJ('JSON.stringify(globalThis.__dgRace ? {s: __dgRace.raceState, c: __dgRace.countdown} : null)').then(JSON.parse).catch(() => null);
    if (st && (st.s >= 2 || st.c !== null)) break;
    await page.mouse.click(1240, 672); await sleep(3000);
  }
  // 레이스 끝까지 (최대 12분). 주행이 시작되면 엔진을 고정 간격(0.02초)으로 바로 진행한다 (화면 그리기와 무관, 기록 동일: 오프라인 검증 43.19 = 43.19)
  const ff = !fs.existsSync(`${OUT}/NOFF`);
  for (let i = 0; i < 1440 && !lastResult; i++) {
    // 시작 대기 240초: 할로윈 보스(3103-20 The Yurei)는 로딩만 약 130초 (2026-11-05 확인, 120초 제한으로 '시작 안 됨' 3회)
    if (!raceStartAt && i >= 480) { log('race did not start in 240s'); break; }
    if (!raceStartAt) {
      const st = await evalJ('globalThis.__dgRace ? __dgRace.raceState : -1').catch(() => -1);
      if (st === 2) { raceStartAt = Date.now(); tp('go');
        if (ff) await evalJ(`(() => { const r = globalThis.__dgRace; const step = () => { let n = 0; while (r.raceState === 2 && n++ < 200) r.advance(0.02); if (r.raceState === 2) setTimeout(step, 0); }; step(); })()`).catch((e) => log('ff err ' + e)); }
    }
    await sleep(500);
  }
  const grades = await evalJ('JSON.stringify(window.__bot && {g: __bot.grades.map(g=>g.g).join(""), min: __bot.grades.map(g=>g.min), boosts: __bot.boosts||0, smart: !!window.__botSmart})').catch(() => null);
  if (!lastResult) { log('no result'); await shot('noresult'); return 'noresult'; }
  const q = lastResult.req, a = lastResult.ans;
  const rec = { at: new Date().toISOString().slice(5, 16), race: t.mode === 'event' ? `event${t.card}` : t.mode === 'weekly' ? 'weekly' : t.mode === 'worldtour' ? 'worldtour' : `${t.zone}-${t.race.RaceIndex}`, id: q.BattleId, win: q.IsPlayerWin, crazy: q.ExcellentCnt,
    great: q.PerfectCnt, good: q.GoodCnt, bad: q.BadCnt, miss: q.MissCnt, ps: q.PerfectStart, nitro: q.NitroUseNum, time: +(q.TimeRecord || 0).toFixed(2),
    opp: +(q.OpponentTimeRecord || 0).toFixed(2), mode: t.mode ?? 'story', result: a?.Result, grade: a?.ClearRec?.Grade, coin: a?.RewardInfo?.Coin, grades };
  tp('result'); rec.phases = phases.join(' ') + ' |' + ogt;
  stats.races.push(rec); saveStats();
  log('RACE ' + JSON.stringify(rec));
  if (t.race && q.BattleId !== t.race.RaceId) log(`WARN started ${q.BattleId} instead of ${t.race.RaceId}`);
  return q.IsPlayerWin ? 'win' : 'lose';
}

(async () => {
  log(`bot start, ${HOURS}h`);
  const fails = fs.existsSync(`${OUT}/fails.json`) ? JSON.parse(fs.readFileSync(`${OUT}/fails.json`, 'utf8')) : {};
  const saveFails = () => fs.writeFileSync(`${OUT}/fails.json`, JSON.stringify(fails));
  const noRes = fs.existsSync(`${OUT}/nores.json`) ? JSON.parse(fs.readFileSync(`${OUT}/nores.json`, 'utf8')) : {};
  const saveNoRes = () => fs.writeFileSync(`${OUT}/nores.json`, JSON.stringify(noRes));
  const noResSkip = () => Object.keys(noRes).filter((k) => noRes[k].n >= 2 && Date.now() - noRes[k].at < 6 * 3600e3).map(Number);
  let farmCount = 0;
  while (Date.now() - T0 < HOURS * 3600e3) {
    if (fs.existsSync(`${OUT}/STOP`)) { log('STOP file'); break; }
    if (fs.existsSync(`${OUT}/RELOAD`)) { fs.unlinkSync(`${OUT}/RELOAD`); log('RELOAD'); break; }
    if (fs.existsSync(`${OUT}/PAUSE`)) { if (!globalThis.__paused) log('PAUSE'); globalThis.__paused = 1; await sleep(5000); continue; } globalThis.__paused = 0;
    let ud; const nAct = stats.actions.length;
    try { ud = await manage(); } catch (e) { log('manage err ' + e); await sleep(60000); continue; }
    if (!ud) { await sleep(120000); continue; }
    globalThis.__ud = ud; // eventRace() 의 참가 조건 확인용
    globalThis.__noResSkip = noResSkip();
    // 한계 돌파 퀘스트 모드
    if (expandQuestActive(ud)) {
      const ec = expandCar(ud);
      if (ec && ec.UpgradeLevel >= 10 && ec.Mastery >= ec.MasteryCapacity) {
        const a = pick(await rpc('MsgMasteryExpandReq', { CarInfo: { Carid: ec.Carid }, ExpansionCash: 28 }), 'MsgMasteryExpandAns');
        act(`mastery expand car ${ec.Carid}: Result ${a?.Result} cap ${a?.CarInfo?.MasteryCapacity}`);
        if (a?.Result === 1) { const best = ud.Cars.CarInfo.slice().sort((x, y) => y.Grade - x.Grade || y.UpgradeLevel - x.UpgradeLevel)[0];
          await rpc('MsgSetCurrentCarReq', { CarInfo: { Carid: best.Carid } }); act(`current car -> ${best.Carid}`); }
        continue;
      }
      if (ec && ud.UserInfo.Currentcar !== ec.Carid) { await rpc('MsgSetCurrentCarReq', { CarInfo: { Carid: ec.Carid } }); act(`current car -> ${ec.Carid} (expand quest)`); continue; }
    } else if (ud.Cars.CarInfo.find((c) => c.Carid === ud.UserInfo.Currentcar)?.Grade < Math.max(...ud.Cars.CarInfo.map((c) => c.Grade))) {
      const best = ud.Cars.CarInfo.slice().sort((x, y) => y.Grade - x.Grade || y.UpgradeLevel - x.UpgradeLevel)[0];
      await rpc('MsgSetCurrentCarReq', { CarInfo: { Carid: best.Carid } }); act(`current car -> ${best.Carid} (best)`); continue;
    }
    const curCarNow = ud.Cars.CarInfo.find((c) => c.Carid === ud.UserInfo.Currentcar);
    const questCar = expandQuestActive(ud) && curCarNow?.Grade === 2;
    const frontier = questCar ? null : (nextRace(ud, new Set([...Object.keys(fails).filter((k) => fails[k] >= 3).map(Number), ...noResSkip()])) ?? nextRace(ud, new Set(noResSkip()))); // 3패 이상 레이스는 다른 안 이긴 레이스가 있으면 뒤로 (예 8-14 연패 중 8-25 캐릭터 레이스 먼저)
    const farm = questCar ? (eventRace() ?? easyRace(ud, curCarNow)) : farmRace(ud);
    // 앞 레이스에서 3번 이상 졌으면 파밍 4판마다 1번 도전 (60분 대기 없앰). 앞 레이스가 없으면 파밍만.
    let t = frontier;
    const evt = eventRace();
    // 레이스 드롭 수집 퀘스트(목표 Type 9, 아이템 6300x: 예 10603 '6지역 파츠 부속품 10개') 진행 중이면 가장 높은 구역 파밍 우선
    const dropObjs = (ud.NquestInfos?.NquestInfo ?? []).flatMap((q) => q.State !== 3 ? [] : (QUESTS.find((x) => x.Id === q.QuestId)?.Objective ?? [])
      .filter((o) => Number(o.Type) === 9 && /에피소드\s*\d+/.test(TEXT_KR[o.Desc] ?? '') && (q.Objective.find((x) => x.ObjId === o.ObjId)?.CurrentValue ?? 0) < Number(o.Param[0])));
    // 진척 감시 (safety.progressTick): 같은 퀘스트 목표로 N판 탔는데 값이 그대로면 그 목표는 6시간 쉬고 ALERT (2026-11-05: 동승 퀘스트 형식 오류로 8-12·8-14 반복)
    const qval = (o) => (ud.NquestInfos?.NquestInfo ?? []).find((q) => q.QuestId === o.Id)?.Objective?.find((x) => x.ObjId === o.ObjId)?.CurrentValue ?? 0;
    const dropQuest = dropObjs.length > 0 && !SAFE.progressSkipped(`drop:${dropObjs[0].Id}:${dropObjs[0].ObjId}`);
    if (dropQuest && !questCar) { // 목표 설명의 '에피소드 N' 구역(예 10701 '에피소드 6지역'), 없으면 이긴 본편이 있는 가장 높은 구역 (일일 보상 우선순위 무시)
      const zs = ud.RaceZones.RaceZone.filter((z) => z.ZoneId < 1000 && !z.Locked && z.Race.some((r) => r.State & 16 && r.RaceIndex >= 11 && r.RaceIndex <= 19));
      const ep = Number((TEXT_KR[dropObjs[0].Desc] ?? '').match(/에피소드\s*(\d+)/)?.[1]) || 0;
      const top = ep && zs.some((z) => z.ZoneId === ep) ? ep : Math.max(...zs.map((z) => z.ZoneId));
      const zr = (zs.find((z) => z.ZoneId === top)?.Race ?? []).filter((r) => r.State & 16 && r.State & 1 && r.RaceIndex >= 11 && r.RaceIndex <= 19 && POS[racePos(top, r.RaceIndex)]);
      if (zr.length && (!t || t.farm || t.mode === 'event' || (fails[t.race?.RaceId] ?? 0) >= 3)) { /* 아직 안 이긴 앞 레이스가 있으면 그것 먼저 (3패 뒤에는 파밍) */ const r = zr[Math.floor(Math.random() * zr.length)]; t = { zone: top, race: r, latest: latestZone(ud), farm: true }; SAFE.progressTick(`drop:${dropObjs[0].Id}:${dropObjs[0].ObjId}`, qval(dropObjs[0]), 15); }
    }
    // 동승 승리 퀘스트(목표 Type 2 [횟수, 구역, '', 최소 등급, 캐릭터], 예 10704 '에피소드 7구역에서 조은과 동승해 A등급 승리'):
    //   그 캐릭터를 동승자로 바꾸고 그 구역의 이긴 본편을 탄다 (MsgSelectPassengerReq {Passenger}, 실기록 형식)
    const rideObj = (ud.NquestInfos?.NquestInfo ?? []).flatMap((q) => q.State !== 3 ? [] : (QUESTS.find((x) => x.Id === q.QuestId)?.Objective ?? [])
      .filter((o) => Number(o.Type) === 2 && o.Param[4] && o.Param[1] && (q.Objective.find((x) => x.ObjId === o.ObjId)?.CurrentValue ?? 0) < Number(o.Param[0] || 1)))[0];
    const unlockGirl = unlockDateTargets(ud)[0];
    if (!rideObj && unlockGirl && Number(ud.UserInfo.PassengerGirl) !== unlockGirl) { const a = pick(await rpc('MsgSelectPassengerReq', { Passenger: unlockGirl }), 'MsgSelectPassengerAns'); act(`passenger -> ${unlockGirl} (girl unlock): Result ${a?.Result}`); }
    if (rideObj && !questCar && !SAFE.progressSkipped(`ride:${rideObj.Id}:${rideObj.ObjId}`)) { // 한 번이면 끝나므로 드롭 파밍보다 먼저
      const gid = Number(rideObj.Param[4]), rz = Number(rideObj.Param[1]);
      const girlOpen = (ud.MyGirls?.MyGirlInfo ?? []).some((g) => g.Girlid === gid && g.State === 7);
      const zone = ud.RaceZones.RaceZone.find((z) => z.ZoneId === rz && !z.Locked);
      // 형식 2가지: [횟수, 구역, '', 최소 등급, 캐릭터] (10704, 이긴 본편 아무거나) / [횟수, 구역, 레이스 번호, '', 캐릭터] (10804 '8-15 를 클로디아와')
      //   레이스 번호가 있으면 그 레이스만 센다 -> 이기지 않았어도 그 레이스를 목표로 (2026-11-05: 번호를 무시해 8-12·8-14 만 돌던 문제)
      const ri = Number(rideObj.Param[2]) || 0;
      const zr = (zone?.Race ?? []).filter((r) => (ri ? r.RaceIndex === ri : (r.State & 16 && r.RaceIndex >= 11 && r.RaceIndex <= 19)) && r.State & 1 && POS[racePos(rz, r.RaceIndex)]);
      if (girlOpen && zr.length) {
        if (Number(ud.UserInfo.PassengerGirl) !== gid) { const a = pick(await rpc('MsgSelectPassengerReq', { Passenger: gid }), 'MsgSelectPassengerAns'); act(`passenger -> ${gid} (quest ride): Result ${a?.Result}`); }
        t = { zone: rz, race: zr[Math.floor(Math.random() * zr.length)], latest: latestZone(ud), farm: !ri, quest: true };
        SAFE.progressTick(`ride:${rideObj.Id}:${rideObj.ObjId}`, qval(rideObj), 6);
      }
    }
    // 이벤트 레이스 실행 퀘스트(목표 Type 1 [횟수, 이벤트 구역], 예 10801 '지아의 사건수첩 레이스 5회'): 그 이벤트의 열린 레이스를 탄다 (승패 무관, 입장권 사용)
    const evObj = (ud.NquestInfos?.NquestInfo ?? []).flatMap((q) => q.State !== 3 ? [] : (QUESTS.find((x) => x.Id === q.QuestId)?.Objective ?? [])
      .filter((o) => Number(o.Type) === 1 && Number(o.Param[1]) >= 1000 && (q.Objective.find((x) => x.ObjId === o.ObjId)?.CurrentValue ?? 0) < Number(o.Param[0] || 1)))[0];
    if (evObj && !questCar && !globalThis.__noEvent && Number(ud.UserInfo.EventRaceTicket) > 0) {
      const ez = Number(evObj.Param[1]), z = eventZones.find((x) => x.ZoneId === ez);
      const r = (z?.Race ?? []).filter((x) => x.State & 1).sort((a, b) => a.RaceIndex - b.RaceIndex)[0];
      // 참가 조건(BattleArea LimitGirlId·LimitGirlFMLevel, 예 3001: 20208·20202·20503 호감도 4단계): 하나도 못 맞추면 건너뜀 (2026-11-04 확인: 조건 창이 떠 시작 안 됨)
      const ar = battle.BattleArea.find((a) => a.Id === 50000 + ez);
      const lim = (ar?.LimitGirlId ?? []).map((g, i) => [g, Number(ar.LimitGirlFMLevel?.[i]) || 1]);
      const girlOk = !lim.length || lim.some(([g, lv]) => { const m = (ud.MyGirls?.MyGirlInfo ?? []).find((x) => x.Girlid === g && x.State === 7); return m && famLv(g, Number(m.Familiarity) || 0) >= lv; });
      if (!girlOk) { if (!globalThis.__evSkipLogged) log(`event ${ez}: girl fondness condition not met, skip`); globalThis.__evSkipLogged = 1; }
      else if (r && EVENT_CARD[ez] !== undefined && (EVENT_POS_Z[ez]?.[r.PosId] ?? EVENT_POS[r.PosId]) && !SAFE.progressSkipped(`event:${evObj.Id}:${evObj.ObjId}`)) {
        t = { mode: 'event', card: EVENT_CARD[ez], zone: ez, race: r, posId: r.PosId, farm: true, quest: true };
        SAFE.progressTick(`event:${evObj.Id}:${evObj.ObjId}`, qval(evObj), 6);
      }
    }
    const questFarm = !!(t?.farm && (dropQuest || t.quest));
    if (farm && !questFarm && (!frontier || ((fails[frontier.race.RaceId] ?? 0) >= 3 && farmCount < 4))) { t = farm; t.farm = t.mode !== 'event'; farmCount++; }
    else farmCount = 0;
    if (!questCar && !questFarm && evt && (!t || t.farm)) t = evt; // 이벤트 챕터(포인트·코인·부품)는 파밍보다 우선
    // 주간 레이스: 하루 3회까지 (퀘스트 10301 참여 3회, 순위 보상 캐시). 대전 티켓(FightTicket) 사용, ★4 현재 설정 가져오기
    const wkFile = `${OUT}/weekly.json`, today = new Date().toISOString().slice(0, 10);
    let wk = {}; try { wk = JSON.parse(fs.readFileSync(wkFile, 'utf8')); } catch {}
    if (!questCar && (wk[today] ?? 0) < 3 && Number(ud.UserInfo.FightTicket) > 0) { t = { mode: 'weekly', zone: 0, race: null }; wk[today] = (wk[today] ?? 0) + 1; fs.writeFileSync(wkFile, JSON.stringify(wk)); }
    // 월드 투어: 무료 시도(MyWorldTour.LeftTry, 하루 7회)가 남아 있으면 탄다 (보상 코인 600·토큰 3·경험치, 시즌 티어 보상).
    //   남은 횟수는 서버 값만 믿는다 (초기화 시각 미확인). 0 이면 1시간 뒤 다시 확인. 결과 없음 2회면 6시간 쉼 (noRes 'worldtour')
    //   매칭(MsgBattleMatchReq) 때 Big Race Ticket(FightTicket) 1장을 쓴다 (2026-11-05 기록 29 -> 28 -> 27). 주간 레이스용으로 3장은 남긴다
    if (!questCar && !fs.existsSync(`${OUT}/NOWT`) && (!t || t.farm) && Number(ud.UserInfo.FightTicket) > 3 && !(noRes.worldtour?.n >= 2 && Date.now() - noRes.worldtour.at < 6 * 3600e3)
        && Date.now() - (globalThis.__wtNoFree ?? 0) > 3600e3) {
      const o = pick(await rpc('MsgOpenWorldTourReq', { Cmd: 1 }), 'MsgOpenWorldTourAns');
      const left = Number(o?.MyWorldTour?.LeftTry ?? -1);
      if (left > 0) t = { mode: 'worldtour', zone: 0, race: null, farm: false, left };
      else { globalThis.__wtNoFree = Date.now(); log(`world tour: no free try (LeftTry ${left}, tier ${o?.MyWorldTour?.RankTier}-${o?.MyWorldTour?.RankTierGrade})`); }
    }
    const fuelNow = fuelOf(ud.UserInfo);
    if (!t) { const busy = stats.actions.filter((a, i) => i >= nAct && !a.includes('familiarity coin')).length;
      log(`no playable race; sleeping ${busy ? '1m' : '30m'}`); await sleep(busy ? 60e3 : 1800e3); continue; }
    const car = ud.Cars.CarInfo.find((c) => c.Carid === ud.UserInfo.Currentcar);
    if (fuelNow < (car?.FuelConsume ?? 25)) { const w = ((car?.FuelConsume ?? 25) - fuelNow) * 15 + 5; log(`fuel ${fuelNow}; sleeping ${w}s`); await sleep(w * 1000); continue; }
    const key = t.race?.RaceId ?? t.mode;
    log(`${t.mode === 'event' ? 'event' : t.mode === 'weekly' ? 'weekly' : t.mode === 'worldtour' ? 'worldtour' : t.farm ? 'farm' : 'target'} ${t.zone}-${t.race?.RaceIndex} (${key})${t.daily ? ' daily' : ''} fuel ${fuelNow} coin ${ud.UserInfo.Coin} cash ${ud.UserInfo.Cash} lv ${ud.UserInfo.Charlevel}`);
    t.smart = (fails[key] ?? 0) >= 2 || fs.existsSync(`${OUT}/SMART`); if (t.smart) log('smart nitro mode');
    let r;
    try { r = await playRace(t); } catch (e) { log('play err ' + e); r = 'err'; }
    if (r === 'lose' && !t.farm) fails[key] = (fails[key] ?? 0) + 1;
    if (r === 'win' && !t.farm) fails[key] = 0; saveFails();
    if (r === 'noresult' && t.mode === 'event') fs.writeFileSync(`${OUT}/EVENTBLOCK`, new Date().toISOString());
    if (r === 'noresult') { const o = noRes[key] ?? { n: 0 }; noRes[key] = { n: Date.now() - (o.at ?? 0) < 6 * 3600e3 ? o.n + 1 : 1, at: Date.now() }; saveNoRes();
      if (noRes[key].n >= 2) log(`skip ${key} for 6h after ${noRes[key].n} no-results`); }
    if (r === 'win' && noRes[key]) { delete noRes[key]; saveNoRes(); }
    if (r === 'nopos' && t.mode === 'event') globalThis.__noEvent = 1; // 이번 실행 동안 이벤트 건너뜀
    else if (r === 'nopos') { log('stopping: unknown node position'); break; }
    if (['nohub', 'noresult', 'err'].includes(r)) await sleep(30000);
  }
  try { await browser?.close(); } catch {}
  log('bot end');
})();
