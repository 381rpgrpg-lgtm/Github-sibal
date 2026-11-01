// 부품 장착·탈착, 탈착 비용, 슬롯 확장, 일반 퀘스트 수락. 형식은 실서버 기록(data/recorded, 2026-11-01)을 따른다.
//
// MsgEquipPartsReq {Itemid, Equipindex, Equipcarid}  (탈착은 Equipindex 0, Equipcarid 0)
//   -> MsgChangeParts {Seq, Result 1, ItemInfo:[부품], UserInfo, CarInfo(+CarEffect [])}
//   기록: 첫 장착 때 Completion 에 EquipParts(65536) 비트. 탈착 시 코인 차감 = MsgGetPriceAns.Cost.Coin (1★ Lv1 = 30).
// MsgGetPriceReq {ItemInfo:{Itemid}} -> {Seq, Result 1, ItemInfo:{Itemid}, Cost:{Coin}}
//   탈착 비용 = partLevelBases grade<부품 Grade> 의 해당 레벨 SellPrice (기록 30 = grade1 Lv1 SellPrice).
// MsgCarSlotCostReq {CarInfo:{Carid, SlotNum}} -> {Seq, Result 1, CarInfo(변경 없음), Cost:{Coin}}  기록: 슬롯 2 = 코인 100
// MsgUpdateNquestReq {NquestInfo:{QuestId, State}} -> {Seq, Result 1, RequestedQuestId, RequestedState,
//   NquestInfo:[{QuestId, State, Objective:[{ObjId, CurrentValue 0, CompleteCash, CashCleared false}]}]}  (nquests.json 정의 순서)
// 추정(기록 없음): 실측 외 슬롯 비용(carSlotOpenTables 가 비어 있음 → 거절),
//   이미 부품이 있는 칸에 장착할 때 기존 부품을 무료로 빼는 동작, 퀘스트 목표 진행도 갱신(미구현).
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg } from '../rpc.js';

const TABLES = new URL('../../data/tables/', import.meta.url).pathname;
const load = (n: string) => (existsSync(TABLES + n) ? JSON.parse(readFileSync(TABLES + n, 'utf8')) : null);
let partDefs: Map<number, any> | null = null;
let levelBases: any[] | null = null;
let quests: Map<number, any> | null = null;
function init() {
  if (partDefs) return;
  partDefs = new Map((load('parts.json')?.Part ?? []).map((p: any) => [Number(p.Id), p]));
  levelBases = load('partLevelBases.json')?.PartLevelBase ?? [];
  quests = new Map((load('nquests.json')?.Quest ?? []).map((q: any) => [Number(q.Id), q]));
}
const TUT_EQUIP_PARTS = 65536;
// 슬롯 비용 (실측): ★1 차량 슬롯 2 = 100코인, ★2 차량 슬롯 2 = 200코인. 최대 슬롯은 cars.json Slot(★1 2, ★2 3).
//   ★1 슬롯 3 요청은 실서버 Result 2. 그 외 조합(슬롯 3 이상, ★3 이상)은 실측 없음 -> 거절.
const SLOT_COST: Record<string, { Coin?: number; Cash?: number }> = { '1|2': { Coin: 100 }, '2|2': { Coin: 200 } };
import { carDef } from './upgradecalc.js';
const slotCost = (car: any, slot: number) => {
  const max = Number(carDef(car.Cartype)?.Slot) || 2;
  if (slot > max) return null;
  return SLOT_COST[`${Number(car.Grade) || 1}|${slot}`] ?? null;
};

function detachCost(part: any): number {
  init();
  const grade = Number(partDefs!.get(Number(part.Itemtype))?.Grade) || 1;
  const base = levelBases!.find((b: any) => b.BaseName === `grade${grade}`);
  return Number(base?.PartLevel?.find((l: any) => Number(l.Id) === (Number(part.ItemLevel) || 1))?.SellPrice) || 0;
}
const findCar = (snap: any, id: number) => (snap.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(id)) ?? null;
const withEffect = (car: any) => ({ ...car, CarEffect: car.CarEffect ?? [] });

register('MsgGetPriceReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const part = (snap?.Items?.ItemInfo ?? []).find((x: any) => Number(x.Itemid) === Number(body?.ItemInfo?.Itemid));
  if (!part) return [{ name: 'MsgGetPriceAns', body: { Seq: 1, Result: 2, ItemInfo: { Itemid: body?.ItemInfo?.Itemid } } }];
  return [{ name: 'MsgGetPriceAns', body: { Seq: 1, Result: 1, ItemInfo: { Itemid: part.Itemid }, Cost: { Coin: detachCost(part) } } }];
});

register('MsgEquipPartsReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const fail = (why: string, Result = 2): Msg[] => {
    console.warn(`[parts] 장착 거절: ${why} ${JSON.stringify(body)}`);
    return [{ name: 'MsgChangeParts', body: { Seq: 1, Result, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  };
  if (!snap) return fail('계정 없음');
  const ui = snap.UserInfo;
  const items: any[] = snap.Items?.ItemInfo ?? [];
  const part = items.find((x) => Number(x.Itemid) === Number(body?.Itemid));
  if (!part) return fail('부품 없음');
  const carid = Number(body?.Equipcarid) || 0, index = Number(body?.Equipindex) || 0;
  const changed: any[] = [];
  let car: any = null;
  if (!carid) {
    // 탈착: 코인 차감
    car = findCar(snap, Number(part.Equipcarid));
    const cost = detachCost(part);
    if ((Number(ui.Coin) || 0) < cost) return fail('코인 부족', 3);
    ui.Coin -= cost;
    part.Equipcarid = 0; part.Equipindex = 0;
    changed.push(part);
  } else {
    car = findCar(snap, carid);
    if (!car) return fail('차량 없음');
    if (index < 1 || index > (Number(car.SlotNum) || 1)) return fail(`열리지 않은 슬롯 ${index}/${car.SlotNum}`);
    const prev = items.find((x) => x !== part && Number(x.Equipcarid) === carid && Number(x.Equipindex) === index);
    if (prev) { prev.Equipcarid = 0; prev.Equipindex = 0; changed.push(prev); }
    part.Equipcarid = carid; part.Equipindex = index;
    changed.push(part);
    ui.Completion = Number(ui.Completion) | TUT_EQUIP_PARTS;
  }
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgChangeParts',
    body: { Seq: 1, Result: 1, ItemInfo: changed, UserInfo: ui, ...(car ? { CarInfo: withEffect(car) } : {}) },
  }];
});

register('MsgCarSlotCostReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = snap && findCar(snap, body?.CarInfo?.Carid);
  const slot = Number(body?.CarInfo?.SlotNum) || 0;
  const cost = car ? slotCost(car, slot) : null;
  if (!car || !cost) {
    console.warn(`[parts] 슬롯 비용 미확인: 슬롯 ${slot} (기록 없음)`);
    return [{ name: 'MsgCarSlotCostAns', body: { Seq: 1, Result: 2 } }];
  }
  return [{ name: 'MsgCarSlotCostAns', body: { Seq: 1, Result: 1, CarInfo: car, Cost: cost } }];
});

register('MsgCarSlotOpenReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = snap && findCar(snap, body?.CarInfo?.Carid);
  const slot = (Number(car?.SlotNum) || 1) + 1;
  const cost = car ? slotCost(car, slot) : null;
  if (!snap || !car || !cost) return [{ name: 'MsgCarSlotOpenAns', body: { Seq: 1, Result: 2 } }];
  const ui = snap.UserInfo;
  if ((Number(ui.Coin) || 0) < (cost.Coin ?? 0)) return [{ name: 'MsgCarSlotOpenAns', body: { Seq: 1, Result: 3, UserInfo: ui } }];
  if ((Number(ui.Cash) || 0) < (cost.Cash ?? 0)) return [{ name: 'MsgCarSlotOpenAns', body: { Seq: 1, Result: 7, UserInfo: ui } }];
  ui.Coin -= cost.Coin ?? 0; ui.Cash -= cost.Cash ?? 0;
  car.SlotNum = slot;
  ctx.store.putUser(ctx.session.accountId, snap);
  // 실측 응답: {Seq, Result 1, CarInfo(SlotNum 갱신), Cost, UserInfo}
  return [{ name: 'MsgCarSlotOpenAns', body: { Seq: 1, Result: 1, CarInfo: car, Cost: cost, UserInfo: ui } }];
});

register('MsgUpdateNquestReq', (body, ctx): Msg[] => {
  init();
  const snap = ctx.store.getUser(ctx.session.accountId);
  const id = Number(body?.NquestInfo?.QuestId), state = Number(body?.NquestInfo?.State);
  const def = quests!.get(id);
  if (!snap || !def) return [{ name: 'MsgUpdateNquestAns', body: { Seq: 1, Result: 2, RequestedQuestId: id, RequestedState: state } }];
  snap.NquestInfos ??= { NquestInfo: [], Version: 1 };
  const list: any[] = snap.NquestInfos.NquestInfo ??= [];
  let q = list.find((x) => Number(x.QuestId) === id);
  if (!q) {
    q = { QuestId: id, State: state, Objective: (def.Objective ?? []).map((o: any) => ({ ObjId: o.ObjId, CurrentValue: 0, CompleteCash: Number(o.Cash) || 0, CashCleared: false })) };
    list.push(q);
  } else q.State = state;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgUpdateNquestAns', body: { Seq: 1, Result: 1, RequestedQuestId: id, RequestedState: state, NquestInfo: [q] } }];
});
