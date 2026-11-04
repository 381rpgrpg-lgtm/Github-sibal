// 부품 강화·판매·잠금, 차량 판매·분해·전시, 꾸미기 도감, 일일 미션 보상, 주간 레이스 정보.
// 실계정 직접 요청으로 실측 (2026-11-01, probe/rec2). 근거는 각 핸들러 주석.
import { readFileSync, existsSync } from 'node:fs';
import { wraceSet, myRank } from './weekly.js';
import { register, type Msg } from '../rpc.js';
import { table, partDef, carDefOf, ATTRS } from '../gamecalc.js';
import { grantItem } from '../inventory.js';
import { bumpProperty } from './battle.js';
import { questEvent } from '../quests.js';

const base = (grade: number) => (table('partLevelBases.json')?.PartLevelBase ?? []).find((b: any) => b.BaseName === `grade${grade}`);
const levelRow = (grade: number, lv: number) => base(grade)?.PartLevel?.find((l: any) => Number(l.Id) === lv) ?? null;
const items = (snap: any): any[] => snap.Items?.ItemInfo ?? [];

// ── 부품 강화 MsgCombinePartsReq {Itemid, ConsumeParts:[Itemid...]} -> MsgCombinePartsAns
// 실측 2건: ★1 Lv1 대상 + 같은 종류 ★1 Lv1 재료 1개 -> ItemExp 0->91, 100코인
//           + 같은 종류 1 + 다른 종류 1 -> 91+91+45=227, Lv1 필요 182 -> Lv2 Exp 45, 140코인
//   재료 경험치 = partLevelBases[재료 등급][재료 레벨].MixExp, 다른 Category 는 절반(버림)
//   비용 = 경험치 합을 10 단위로 올림 (91->100, 136->140)
//   능력치: Lv2 에서 floor(기본 x 1.15) ({18,0,9,-10} -> {20,0,10,-12}). 레벨당 +0.15 배로 추정.
//   응답 {Result 1, Upgraded{부품 + PrevItemLevel, PrevItemExp}, Consumed[재료], UserInfo}
const partAttrs = (def: any, lv: number) => {
  const out: any = {};
  for (const k of ATTRS) out[k] = Math.floor((Number(def.Attributes?.[k]) || 0) * (1 + 0.15 * (lv - 1)));
  return out;
};
register('MsgCombinePartsReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const fail = (why: string, Result = 2): Msg[] => { console.warn(`[parts] 강화 거절: ${why}`); return [{ name: 'MsgCombinePartsAns', body: { Seq: 1, Result } }]; };
  if (!snap) return fail('계정 없음');
  const list = items(snap);
  const target = list.find((x) => Number(x.Itemid) === Number(body?.Itemid));
  const tdef = target && partDef(target.Itemtype);
  if (!target || !tdef) return fail('대상 부품 없음');
  const mats = (body?.ConsumeParts ?? []).map((id: any) => list.find((x) => Number(x.Itemid) === Number(id)));
  if (!mats.length || mats.some((m: any) => !m || m === target || m.IsLocked || Number(m.Equipcarid) > 0)) return fail('재료 부품 오류');
  let exp = 0;
  for (const m of mats) {
    const md = partDef(m.Itemtype);
    const e = Number(levelRow(Number(md?.Grade) || 1, Number(m.ItemLevel) || 1)?.MixExp) || 0;
    exp += Number(md?.Category) === Number(tdef.Category) ? e : Math.floor(e / 2);
  }
  const cost = Math.ceil(exp / 10) * 10;
  const ui = snap.UserInfo;
  if ((Number(ui.Coin) || 0) < cost) return fail('코인 부족', 3);
  ui.Coin -= cost;
  const prev = { PrevItemLevel: Number(target.ItemLevel) || 1, PrevItemExp: Number(target.ItemExp) || 0 };
  let lv = prev.PrevItemLevel, cur = prev.PrevItemExp + exp;
  const max = Number(tdef.LevelMax) || 36;
  while (lv < max) {
    const need = Number(levelRow(Number(tdef.Grade) || 1, lv)?.Exp) || 0;
    if (!need || cur < need) break;
    cur -= need; lv++;
  }
  if (lv >= max) cur = 0;
  target.ItemLevel = lv; target.ItemExp = cur;
  if (lv !== prev.PrevItemLevel) target.Attributes = partAttrs(tdef, lv);
  const consumed = mats.map((m: any) => ({ ...m }));
  snap.Items.ItemInfo = list.filter((x) => !mats.includes(x));
  bumpProperty(snap, 'DQUEST_PARTSUP', 1);
  questEvent(snap, 24, (p) => !p[1] || Number(tdef.Grade) >= Number(p[1]));
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgCombinePartsAns', body: { Seq: 1, Result: 1, Upgraded: { ...target, ...prev }, Consumed: consumed, UserInfo: ui } }];
});

// ── 부품 판매 MsgSellPartsReq {Itemid:[...]} -> MsgDeleteParts {ItemInfo:[{Itemid, Itemtype, StackNum 0}], UserInfo}
//   실측: ★1 Lv1 30코인씩 (partLevelBases SellPrice). 장착·잠금 부품은 거절(추정).
register('MsgSellPartsReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'MsgDeleteParts', body: { Seq: 1, ItemInfo: [] } }];
  const ids = new Set((Array.isArray(body?.Itemid) ? body.Itemid : [body?.Itemid]).map(Number));
  const sold: any[] = [];
  let coin = 0;
  for (const it of items(snap)) {
    if (!ids.has(Number(it.Itemid)) || it.IsLocked || Number(it.Equipcarid) > 0 || !partDef(it.Itemtype)) continue;
    coin += Number(levelRow(Number(partDef(it.Itemtype)?.Grade) || 1, Number(it.ItemLevel) || 1)?.SellPrice) || 0;
    sold.push(it);
  }
  snap.Items.ItemInfo = items(snap).filter((x) => !sold.includes(x));
  snap.UserInfo.Coin = (Number(snap.UserInfo.Coin) || 0) + coin;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgDeleteParts', body: { Seq: 1, ItemInfo: sold.map((x) => ({ Itemid: x.Itemid, Itemtype: x.Itemtype, StackNum: 0 })), UserInfo: snap.UserInfo } }];
});

// ── 부품 잠금 MsgLockPartsReq {ItemInfo:{Itemid, IsLocked}} -> {Result 1, ItemInfo:[부품]} (실측)
register('MsgLockPartsReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const it = snap && items(snap).find((x) => Number(x.Itemid) === Number(body?.ItemInfo?.Itemid));
  if (!it) return [{ name: 'MsgLockPartsAns', body: { Seq: 1, Result: 2 } }];
  it.IsLocked = !!body.ItemInfo.IsLocked;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgLockPartsAns', body: { Seq: 1, Result: 1, ItemInfo: [it] } }];
});

const cars = (snap: any): any[] => snap.Cars?.CarInfo ?? [];
const findCar = (snap: any, id: any) => cars(snap).find((c) => Number(c.Carid) === Number(id));

// ── 차량 전시 MsgExhibitCarReq {CarInfo:{Carid, IsExhibited}} -> {Result 1, CarInfo} (실측)
register('MsgExhibitCarReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = snap && findCar(snap, body?.CarInfo?.Carid);
  if (!car) return [{ name: 'MsgExhibitCarAns', body: { Seq: 1, Result: 2 } }];
  car.IsExhibited = !!body.CarInfo.IsExhibited;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgExhibitCarAns', body: { Seq: 1, Result: 1, CarInfo: { ...car, CarEffect: car.CarEffect ?? [] } } }];
});

// 판매·분해 공통: 현재 차량·잠긴 차량 제외, 장착 부품은 보관함으로 (추정)
function removeCars(snap: any, ids: number[]): any[] {
  const out = ids.map((id) => findCar(snap, id)).filter((c: any) => c && Number(c.Carid) !== Number(snap.UserInfo?.Currentcar) && !c.IsLocked);
  const set = new Set(out.map((c: any) => Number(c.Carid)));
  for (const it of items(snap)) if (set.has(Number(it.Equipcarid))) { it.Equipcarid = 0; it.Equipindex = 0; }
  snap.Cars.CarInfo = cars(snap).filter((c) => !set.has(Number(c.Carid)));
  return out;
}

// ── 차량 판매 MsgSellCarReq {CarInfo:{Carid}} | {MultiCarInfo:[{Carid}]} -> {Result 1, Cost{Coin: Price 합}, CarInfo{Carid}, UserInfo}
//   실측: 10502(★2) 판매 -> Cost Coin 2350 (차량 Price)
register('MsgSellCarReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'MsgSellCarAns', body: { Seq: 1, Result: 2 } }];
  const ids = body?.MultiCarInfo ? body.MultiCarInfo.map((c: any) => Number(c.Carid)) : [Number(body?.CarInfo?.Carid)];
  const sold = removeCars(snap, ids);
  if (!sold.length) return [{ name: 'MsgSellCarAns', body: { Seq: 1, Result: 2 } }];
  const coin = sold.reduce((s: number, c: any) => s + (Number(c.Price) || Number(carDefOf(c.Cartype)?.SellPrice) || 0), 0);
  snap.UserInfo.Coin = (Number(snap.UserInfo.Coin) || 0) + coin;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgSellCarAns', body: { Seq: 1, Result: 1, Cost: { Coin: coin },
    ...(body?.MultiCarInfo ? { MultiCarInfo: sold.map((c: any) => ({ Carid: c.Carid })) } : { CarInfo: { Carid: sold[0].Carid } }), UserInfo: snap.UserInfo } }];
});

// ── 차량 분해 MsgDisassembleCarReq {CarID:[...]} -> {Result 1, RemovedCarID, ItemInfo [], RewardInfo{ItemInfo:[코어 61006]}}
//   실측: ★1 차량 -> 61006 x1 (cars.json CoreCount)
register('MsgDisassembleCarReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'MsgDisassembleCarAns', body: { Seq: 1, Result: 2 } }];
  const gone = removeCars(snap, (body?.CarID ?? []).map(Number));
  if (!gone.length) return [{ name: 'MsgDisassembleCarAns', body: { Seq: 1, Result: 2 } }];
  const cores = gone.reduce((s: number, c: any) => s + (Number(carDefOf(c.Cartype)?.CoreCount) || 1), 0);
  grantItem(snap, 61006, cores);
  const core = items(snap).find((x) => Number(x.Itemtype) === 61006);
  questEvent(snap, 20, () => true, gone.length);
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgDisassembleCarAns', body: { Seq: 1, Result: 1, RemovedCarID: gone.map((c: any) => c.Carid), ItemInfo: [],
    RewardInfo: { Coin: 0, Charexp: 0, Cash: 0, Familiartity: 0, CarInfo: [],
      ItemInfo: [{ Itemid: core?.Itemid, Itemtype: 61006, Count: cores, StackNum: core?.Count, DeltaNum: cores }] } } }];
});

// ── 꾸미기 도감 MsgCosmeticCollectionReq -> {Result 1, Ids:[도감에 보이는 것], Exchange:[교환 가능]}
//   실측(할로윈 시즌): Ids = 시즌(season) 아이템 9종 + 계정이 본 적 있는 일반 아이템 4종, Exchange = 시즌 아이템 중 common 제외 8종.
//   '본 적 있는' 기록은 서버 전용이라 오프라인은 시즌 아이템 + 보유 아이템으로 둔다.
register('MsgCosmeticCollectionReq', (_b, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const owned = (snap?.Cosmetics?.Owned ?? []).map((c: any) => String(c.Id));
  const cp = new URL('../../data/content.json', import.meta.url).pathname;
  const defs: any[] = existsSync(cp) ? JSON.parse(readFileSync(cp, 'utf8')).cosmetics ?? [] : [];
  const seasonal = defs.filter((d) => d.season);
  const ids = [...new Set([...owned, ...seasonal.map((d) => String(d.id))])];
  return [{ name: 'MsgCosmeticCollectionAns', body: { Seq: 1, Result: 1, Ids: ids,
    Exchange: seasonal.filter((d) => d.rarity !== 'common').map((d) => String(d.id)) } }];
});

// ── 일일 미션 보상 MsgGetDailyQuestRewardReq. 실측 2건:
//   DQUEST 1(미완료) -> {Seq, UserInfo} 만.
//   DQUEST 2(레이스 3·데이트 3·강화 1 모두 달성, 2026-11-02) -> 코인 1000 + 캐시 10, DQUEST 0,
//     {Seq, RewardInfo{Coin, Charexp 0, Cash, Familiartity 0, ItemInfo[{61001},{61002}], CarInfo []}, UserInfo, PropertySet}.
//   vconst DQUEST_REWARD_CASH 는 5 이지만 실서버는 10 을 줬다 -> 기록값 사용. 업적 403(일일 미션 완료) +1 은 achievements.ts.
register('MsgGetDailyQuestRewardReq', (_b, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const dq = (snap?.PropertySet?.Property ?? []).find((x: any) => x.PropertyName === 'DQUEST');
  if (!snap || !dq || Number(dq.Nvalue) !== 2) return [{ name: 'MsgGetDailyQuestRewardAns', body: { Seq: 1, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  const coin = Number((table('vconstTable.json')?.Vconst ?? []).find((c: any) => c?.Name === 'DQUEST_REWARD_COIN')?.Dval) || 1000, cash = 10;
  snap.UserInfo.Coin = (Number(snap.UserInfo.Coin) || 0) + coin;
  snap.UserInfo.Cash = (Number(snap.UserInfo.Cash) || 0) + cash;
  dq.Nvalue = 0;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgGetDailyQuestRewardAns', body: { Seq: 1,
    RewardInfo: { Coin: coin, Charexp: 0, Cash: cash, Familiartity: 0, ItemInfo: [{ Itemtype: 61001, Count: coin, DeltaNum: coin }, { Itemtype: 61002, Count: cash, DeltaNum: cash }], CarInfo: [] },
    UserInfo: snap.UserInfo, PropertySet: snap.PropertySet } }];
});

// ── 주간 레이스 정보 MsgGetWRaceInfoReq -> {WraceSet{WSeasonId, StartDate, EndDate, WRace[...]}, MyWRaceRec{MyRank[...]}, UserInfo}
//   레이스·트랙 구성은 실측 템플릿(src/data/wrace-template.json). 오프라인이라 순위는 비운다. 시즌 기간은 이번 주.
//   주행은 weekly.ts, 시즌 보상(MsgWRaceRewardReq)은 미구현.
register('MsgGetWRaceInfoReq', (_b, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const set = snap ? wraceSet(snap) : null;
  if (!snap || !set) return [{ name: 'MsgGetWRaceInfoAns', body: { Seq: 1, Result: 0 } }];
  // 내 이번 시즌 최고 기록만 순위에 넣는다 (weekly.ts). 오프라인이라 다른 플레이어 순위는 없다.
  return [{ name: 'MsgGetWRaceInfoAns', body: { Seq: 1, WraceSet: set, MyWRaceRec: { MyRank: myRank(snap, set.WRace) }, UserInfo: snap.UserInfo } }];
});

// ── 꾸미기 장착 MsgCosmeticEquipReq {Carid, Type, Id} -> {Result 1, Cosmetics, CarInfo:[차량]}
//   실측: plate_halloween -> 차량 PlateStyle = 'plate_halloween'. 종류 -> 필드는 클라이언트 표
//   (underglow Underglow, smoke TyreSmoke, flame NitroFlame, lights LightTint, windows WindowTint, rims RimStyle,
//    calipers CaliperColor, plate PlateStyle, trail DriftTrail, paint Paint, aura Aura). 보유한 것만, 빈 Id 는 해제(추정).
const COSMETIC_FIELD: Record<string, string> = { underglow: 'Underglow', smoke: 'TyreSmoke', flame: 'NitroFlame', lights: 'LightTint',
  windows: 'WindowTint', rims: 'RimStyle', calipers: 'CaliperColor', plate: 'PlateStyle', trail: 'DriftTrail', paint: 'Paint', aura: 'Aura' };
register('MsgCosmeticEquipReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = snap && findCar(snap, body?.Carid);
  const field = COSMETIC_FIELD[String(body?.Type)];
  const id = body?.Id ? String(body.Id) : '';
  const owned = (snap?.Cosmetics?.Owned ?? []).some((c: any) => String(c.Id) === id);
  if (!car || !field || (id && !owned)) return [{ name: 'MsgCosmeticEquipAns', body: { Seq: 1, Result: 2 } }];
  if (id) car[field] = id; else delete car[field];
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgCosmeticEquipAns', body: { Seq: 1, Result: 1, Cosmetics: snap.Cosmetics, CarInfo: [{ ...car, CarEffect: car.CarEffect ?? [] }] } }];
});
