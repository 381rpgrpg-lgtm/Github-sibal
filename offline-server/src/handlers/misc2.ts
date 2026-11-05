// 기타 미구현 메시지 모음: 차량 잠금·목록·번호판, 메인 캐릭터, 닉네임, 거리 이름, 상점 NEW 표시, 퀘스트 목표 캐시 완료,
// 슬롯 확장, 캐릭터 아이템 판매, 시즌 보상(주간 레이스·월드 투어), 친구(오프라인은 혼자), 쿠폰, 마일리지 상자.
// 클라이언트 계약은 deob 클라이언트(OnDispatch_*, #patch, ApplyReward, applyGirlAnswer, applySocialAnswer)에서 확인:
//   - 응답의 UserInfo 는 재화를 교체, CarInfo(객체 또는 배열)는 같은 Carid 차량을 통째로 교체, Cars.CarInfo 는 차고 전체 교체,
//     ItemInfo[{Itemid, Itemtype, StackNum}] 는 인벤토리 갱신(StackNum 이 새 수량, 데칼 외에는 0 = 삭제),
//     RewardInfo(Display 없음)는 ApplyReward(CarInfo·UserInfo·ItemInfo), GirlInfo 는 캐릭터 레코드 병합,
//     GirlItemInfo[{ItemId, StackNum 0}] 는 캐릭터 아이템 삭제, NewShopItems 배열은 상점 NEW 목록 교체.
//   - NquestInfo 는 MsgUpdateNquest(·Ans) 로만 반영된다.
//   - 공통 오류 팝업(MsgCommonErrorHandling): Result 7 = 캐시 부족(buy_cash), 3 = 코인 부족(buy_coin).
// 근거 표기: 실기록 = 실서버 녹화(data/recorded), 클라이언트 = deob 클라이언트 코드, 추정 = 기록 없음.
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg } from '../rpc.js';
import { table, carDefOf, newOwnedCar } from '../gamecalc.js';
import { grantItem, itemDef } from '../inventory.js';
import { refreshQuests, questDefs } from '../quests.js';
import { levelUp } from './battle.js';
import { weeklySeason } from './weekly.js';
import { streetSetName } from '../street.js';

const R_OK = 1, R_FAIL = 2, R_NO_COIN = 3, R_NO_CASH = 7;
const GIRL_OPEN = 7;
const vconst = (name: string, i = 0): number => {
  const r = (table('vconstTable.json')?.Vconst ?? []).find((x: any) => x?.Name === name);
  return Number(r?.Val?.[i] ?? r?.Dval) || 0;
};
const uid = (ctx: any) => ctx.session.accountId;
const cars = (snap: any): any[] => snap?.Cars?.CarInfo ?? [];
const findCar = (snap: any, id: any) => cars(snap).find((c) => Number(c.Carid) === Number(id));
const myOpenGirl = (snap: any, id: any) => (snap?.MyGirls?.MyGirlInfo ?? []).find((g: any) => Number(g.Girlid) === Number(id) && Number(g.State) === GIRL_OPEN);

// ── 보상 지급 공용 (쿠폰·시즌 보상·마일리지 상자) ─────────────────────────────
//   RewardInfo 형식은 다른 보상 응답의 실기록과 같다: {Coin, Charexp, Cash, Familiartity 0, ItemInfo[...], CarInfo[...]}.
//   재화(61001 코인 / 61002 캐시 / 61003 경험치)는 UserInfo 에 더하고 ItemInfo 에 {Itemtype, Count, DeltaNum} 만 (Itemid 없음).
//   61007 토큰은 grantItem 이 모르는 재화라 여기서 UserInfo.Token 에 더한다 (추정).
//   차량 타입(cars.json)은 새 차량으로 지급 (차고가 차 있어도 지급: 추정).
function giveRewards(snap: any, rows: { type: number; amount: number }[]): any {
  const ui = snap.UserInfo;
  const reward: any = { Coin: 0, Charexp: 0, Cash: 0, Familiartity: 0, ItemInfo: [], CarInfo: [] };
  const expBefore = Number(ui.Charexp) || 0, lvBefore = Number(ui.Charlevel) || 0;
  for (const { type, amount } of rows) {
    const n = Math.trunc(Number(amount) || 0);
    if (!type || n <= 0) continue;
    if (carDefOf(type)) {
      snap.Cars ??= { CarInfo: [], Version: 1 };
      snap.Cars.CarInfo ??= [];
      for (let i = 0; i < n; i++) { const c = newOwnedCar(snap, type); snap.Cars.CarInfo.push(c); reward.CarInfo.push(c); }
      continue;
    }
    const def: any = itemDef(type);
    if (!def) { console.warn(`[misc2] 보상 정의 없음: ${type} x${n}`); continue; }
    if (Number(def.Category) === 610 && String(def.Info) === 'token') {
      ui.Token = (Number(ui.Token) || 0) + n;
      reward.ItemInfo.push({ Itemtype: type, Count: n, DeltaNum: n });
      continue;
    }
    if (!grantItem(snap, type, n)) { console.warn(`[misc2] 보상 지급 실패: ${type} x${n}`); continue; }
    if (type === 61001) reward.Coin += n;
    if (type === 61002) reward.Cash += n;
    if (type === 61003) reward.Charexp += n;
    if (Number(def.Category) === 610) { reward.ItemInfo.push({ Itemtype: type, Count: n, DeltaNum: n }); continue; }
    const stacks = (snap.Items?.ItemInfo ?? []).filter((x: any) => Number(x.Itemtype) === type);
    stacks.forEach((it: any, i: number) => reward.ItemInfo.push({ Itemid: it.Itemid, Itemtype: type, Count: i === 0 ? n : 0, StackNum: it.Count, DeltaNum: i === 0 ? n : 0 }));
  }
  // 경험치를 받았으면 레벨업 계산 (quests.ts 보상과 같은 방식: LevelUp 을 지우고 다시 계산, 레벨업이면 RewardInfo.UserInfo)
  if ((Number(ui.Charexp) || 0) > expBefore) {
    delete ui.LevelUp;
    levelUp(snap);
    if ((Number(ui.Charlevel) || 0) > lvBefore) reward.UserInfo = { ...ui };
  }
  return reward;
}

// ── 차량 잠금 MsgLockCarReq {CarInfo:{Carid, IsLocked}} -> {Seq, Result 1, CarInfo: 차량}
//   클라이언트: 응답 CarInfo.IsLocked 이면 'car_lock_notice' 안내, #patch 가 CarInfo 로 차량을 교체.
//   형식은 부품 잠금(MsgLockPartsAns, 실기록)·전시(MsgExhibitCarAns, 실기록)와 같게 추정. 잠긴 차는 판매·분해·재료에서 빠진다(inventory2.ts).
register('MsgLockCarReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const car = snap && findCar(snap, body?.CarInfo?.Carid);
  if (!car) return [{ name: 'MsgLockCarAns', body: { Seq: 1, Result: R_FAIL } }];
  car.IsLocked = !!body.CarInfo.IsLocked;
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgLockCarAns', body: { Seq: 1, Result: R_OK, CarInfo: car } }];
});

// ── 차량 목록 MsgCarListReq {} -> {Seq, Result 1, Cars} (추정: 클라이언트 메시지 표에만 있고 보내는 곳 없음. #patch 가 Cars 로 차고 교체)
register('MsgCarListReq', (_b, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  if (!snap) return [{ name: 'MsgCarListAns', body: { Seq: 1, Result: R_FAIL } }];
  return [{ name: 'MsgCarListAns', body: { Seq: 1, Result: R_OK, Cars: snap.Cars ?? { CarInfo: [], Version: 1 } } }];
});

// ── 메인 캐릭터 MsgSetMainGirlReq {GirlInfo: 캐릭터 레코드} -> {Seq, Result 1, UserInfo(MainGirl)}
//   클라이언트: 응답이 오면 mainGreetingOn = true (메인 화면 인사), UserInfo 는 #patch. 열린(State 7) 캐릭터만 (추정).
register('MsgSetMainGirlReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const g = myOpenGirl(snap, body?.GirlInfo?.Girlid);
  if (!snap || !g) return [{ name: 'MsgSetMainGirlAns', body: { Seq: 1, Result: R_FAIL, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  snap.UserInfo.MainGirl = Number(g.Girlid);
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgSetMainGirlAns', body: { Seq: 1, Result: R_OK, UserInfo: snap.UserInfo } }];
});

// ── 이름 검사 (닉네임·번호판 공용). 클라이언트 NickPopup: 3~12자(minLenNick/maxLenNick), 공백·특수문자 불가(#Enter 의 aZ),
//   forbiddenNames 표(IsForbidden: 공백·기호·숫자를 지운 뒤 포함 여부). 서버도 같은 규칙으로 다시 검사한다 (추정: 실서버 규칙 미확인).
const SPECIAL = "`~!@#$%^&*()-_=+[{]}\\|;:'\",<.>/?";
let forbidden: string[] | null = null;
function isForbidden(name: string): boolean {
  forbidden ??= (table('forbiddenNames.json') ?? []) as string[];
  let s = name;
  for (const ch of [' ', '_', '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '-', '+', '?', ',', '.', ';', "'", '"', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) s = s.split(ch).join('');
  return Array.isArray(forbidden) && forbidden.some((f) => typeof f === 'string' && f && s.includes(f));
}
function validName(v: any): boolean {
  if (typeof v !== 'string' || v.length < 3 || v.length > 12) return false;
  for (const ch of v) if (SPECIAL.includes(ch) || /\s/u.test(ch) || !/[\p{L}\p{Nd}]/u.test(ch)) return false;
  return !isForbidden(v);
}

// ── 닉네임 사용 가능 확인 MsgNicknameAvailableCkeckReq {Name} -> {Seq, Result 1 | 2, Name}
//   클라이언트: Result 1 이면 a5I.Name 으로 확인 팝업 후 MsgSetNicknameReq, 1001 = 중복, 그 외 = 형식 오류.
//   오프라인은 다른 플레이어가 없어 중복(1001)은 없다 (추정).
register('MsgNicknameAvailableCkeckReq', (body, _ctx): Msg[] => [
  { name: 'MsgNicknameAvailableCkeckAns', body: { Seq: 1, Result: validName(body?.Name) ? R_OK : R_FAIL, Name: body?.Name ?? '' } },
]);

// ── 닉네임 변경 MsgSetNicknameReq {Name} -> {Seq, Result 1, Name, UserInfo(Charname)}
//   클라이언트 OnSetNicknameAns: Result 1 이면 창을 닫음, UserInfo 는 #patch. 비용·횟수 제한은 기록이 없어 없음 (추정).
register('MsgSetNicknameReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  if (!snap || !validName(body?.Name)) return [{ name: 'MsgSetNicknameAns', body: { Seq: 1, Result: R_FAIL, Name: body?.Name ?? '' } }];
  snap.UserInfo.Charname = String(body.Name);
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgSetNicknameAns', body: { Seq: 1, Result: R_OK, Name: snap.UserInfo.Charname, UserInfo: snap.UserInfo } }];
});

// ── 거리 이름 설정 MsgStreetNameSetReq {Name:{P, C, E}} -> {Seq, Result 1, Name, Public}
//   클라이언트 StreetNamesClient.setName: Result 1 이면 view.Name/Public 갱신, Public.combo 가 있으면 콤보 연출, 없으면 'street_saved'.
//   실패는 Reason 문구를 nameErrorText 로 번역해 보여 준다. Public = 엔진 publicName {text, rarity, combo?} (street.ts).
//   실서버 응답 기록은 없다 (추정: 실패 Result 2, 획득하지 않은 단어는 'A word is not earned yet').
register('MsgStreetNameSetReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const r = snap ? streetSetName(snap, body?.Name) : { ok: false, Reason: 'Try again in a moment.' };
  if (!snap || !r.ok) return [{ name: 'MsgStreetNameSetAns', body: { Seq: 1, Result: R_FAIL, Reason: r.Reason } }];
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgStreetNameSetAns', body: { Seq: 1, Result: R_OK, Name: r.Name, Public: r.Public } }];
});

// ── 상점 NEW 표시 끄기 MsgHideNewShopItemReq {HideNewShopItems:[StoreItemId...]} -> {Seq, Result 1, NewShopItems}
//   스냅샷 NewShopItems 는 StoreItemId 배열 (실기록 MsgUserData). 클라이언트는 목록에서 직접 지우지 않고 #patch 의
//   NewShopItems 배열로만 newTagShopItemList 를 바꾸므로 남은 목록을 응답에 넣는다 (추정: 실서버 응답 형식 미확인).
register('MsgHideNewShopItemReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  if (!snap) return [{ name: 'MsgHideNewShopItemAns', body: { Seq: 1, Result: R_FAIL } }];
  const hide = new Set((Array.isArray(body?.HideNewShopItems) ? body.HideNewShopItems : []).map(Number));
  snap.NewShopItems = (Array.isArray(snap.NewShopItems) ? snap.NewShopItems : []).filter((id: any) => !hide.has(Number(id)));
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgHideNewShopItemAns', body: { Seq: 1, Result: R_OK, NewShopItems: snap.NewShopItems } }];
});

// ── 퀘스트 목표 캐시로 완료 MsgNquestObjectiveClearReq {QuestId, ObjId}
//   클라이언트: 목표의 CompleteCash 로 확인 팝업 후 요청. 진행률 계산에서 CashCleared 목표는 목표치(Param[0])로 친다.
//   스냅샷 목표 레코드 {ObjId, CurrentValue, CompleteCash(-1 = 불가), CashCleared} (실기록 MsgUserData).
//   처리 (추정): 수락(State 3) 퀘스트만, CompleteCash < 0 이면 Result 2, 캐시 부족 Result 7, 성공 시 Cash 차감·CashCleared true·
//   CurrentValue = 목표치, 모든 목표 달성이면 State 6. 응답 {Seq, Result 1, UserInfo, NquestInfo:[레코드]} + MsgUpdateNquest.
//   주의: quests.ts evaluate() 는 CashCleared 를 모르므로 상태형 목표(Type 2·5·7·16·18·26·27)는 나중 갱신에서 실제 값으로 되돌아갈 수 있다.
//   여기서는 refreshQuests 뒤에 다시 맞춘다. (quests.ts 가 CashCleared 를 달성으로 치도록 고치는 것이 근본 해결)
register('MsgNquestObjectiveClearReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const fail = (Result: number, why: string): Msg[] => {
    console.warn(`[misc2] 퀘스트 목표 캐시 완료 거절: ${why} ${JSON.stringify(body)}`);
    return [{ name: 'MsgNquestObjectiveClearAns', body: { Seq: 1, Result, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  };
  if (!snap) return fail(R_FAIL, '계정 없음');
  const qid = Number(body?.QuestId), oid = Number(body?.ObjId);
  const def = questDefs().get(qid);
  const rec = (snap.NquestInfos?.NquestInfo ?? []).find((x: any) => Number(x.QuestId) === qid);
  const od = (def?.Objective ?? []).find((x: any) => Number(x.ObjId) === oid);
  const o = (rec?.Objective ?? []).find((x: any) => Number(x.ObjId) === oid);
  if (!def || !rec || !od || !o) return fail(R_FAIL, '퀘스트·목표 없음');
  if (Number(rec.State) !== 3) return fail(R_FAIL, `수락 상태 아님 (State ${rec.State})`);
  const needOf = (objId: any) => Number((def.Objective ?? []).find((x: any) => Number(x.ObjId) === Number(objId))?.Param?.[0]) || 1;
  const need = needOf(oid);
  const cost = Number(o.CompleteCash ?? od.Cash ?? -1);
  if (!(cost >= 0)) return fail(R_FAIL, '캐시 완료 불가 목표');
  if (o.CashCleared || Number(o.CurrentValue) >= need) return fail(R_FAIL, '이미 달성');
  const ui = snap.UserInfo;
  if ((Number(ui.Cash) || 0) < cost) return fail(R_NO_CASH, '캐시 부족');
  ui.Cash = Number(ui.Cash) - cost;
  o.CashCleared = true;
  o.CurrentValue = need;
  const changes = refreshQuests(snap);
  for (const x of rec.Objective) if (x.CashCleared) x.CurrentValue = needOf(x.ObjId);
  if (Number(rec.State) === 3 && (def.Objective ?? []).every((d: any) => {
    const r = rec.Objective.find((x: any) => Number(x.ObjId) === Number(d.ObjId));
    return r && (r.CashCleared || Number(r.CurrentValue) >= (Number(d.Param?.[0]) || 1));
  })) rec.State = 6;
  ctx.store.putUser(uid(ctx), snap);
  return [
    { name: 'MsgNquestObjectiveClearAns', body: { Seq: 1, Result: R_OK, UserInfo: ui, NquestInfo: [rec] } },
    { name: 'MsgUpdateNquest', body: { Seq: 2, NquestInfo: [rec, ...changes.filter((x) => x !== rec)] } },
  ];
});

// ── 슬롯 확장 MsgExpandSlotReq {SlotType, GirlInfo?}
//   실기록 2026-11-05 (0009·0011·0013, 응답 {Seq, Result 1, UserInfo, SlotType}):
//     SlotType 2 차고: 캐시 6 (= 현재 GarageSize, 클라이언트 OnClickExpandCell 의 표시 비용), GarageSize 6 -> 12 (stepGarage 6)
//     SlotType 0 아이템: 캐시 15 (inventorySlotExpandCash), ItemSlotNum 19 -> 29 (stepItemSlot 10)
//     SlotType 1 부품: 캐시 10 (partsSlotExpandCash), PartsSlotNum 8 -> 16 (stepPartsSlot 8)
//   SlotType 3 캐릭터 아이템 (클라이언트 FittingRoom: {SlotType 3, GirlInfo:{Girlid}}, 비용 girlItemSlotExpandCash 10, +girlItemSlotStep 8):
//     그 캐릭터의 GirlItemSlotNum 증가, 응답에 GirlInfo 추가 (클라이언트는 GirlInfo 가 있으면 'slot_expand_complete' 안내) — 추정.
//   추정: 최대치(inventorySlotMax 89, partsSlotMax 79, garageSlotMax 68, girlItemSlotMax 39)에서 자르고, 이미 최대면 Result 2,
//     캐시 부족 Result 7 (클라이언트 buy_cash 안내와 같은 코드).
const SLOT: Record<number, { field: string; cost: string | null; step: string; max: string }> = {
  0: { field: 'ItemSlotNum', cost: 'inventorySlotExpandCash', step: 'stepItemSlot', max: 'inventorySlotMax' },
  1: { field: 'PartsSlotNum', cost: 'partsSlotExpandCash', step: 'stepPartsSlot', max: 'partsSlotMax' },
  2: { field: 'GarageSize', cost: null, step: 'stepGarage', max: 'garageSlotMax' },
  3: { field: 'GirlItemSlotNum', cost: 'girlItemSlotExpandCash', step: 'girlItemSlotStep', max: 'girlItemSlotMax' },
};
register('MsgExpandSlotReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const type = Number(body?.SlotType);
  const fail = (Result: number, why: string): Msg[] => {
    console.warn(`[misc2] 슬롯 확장 거절: ${why} ${JSON.stringify(body)}`);
    return [{ name: 'MsgExpandSlotAns', body: { Seq: 1, Result, ...(snap ? { UserInfo: snap.UserInfo } : {}), SlotType: type } }];
  };
  const s = SLOT[type];
  if (!snap || !s) return fail(R_FAIL, '알 수 없는 SlotType');
  const ui = snap.UserInfo;
  const girl = type === 3 ? myOpenGirl(snap, body?.GirlInfo?.Girlid) : null;
  if (type === 3 && !girl) return fail(R_FAIL, '캐릭터 없음');
  const holder = girl ?? ui;
  const cur = Number(holder[s.field]) || (type === 3 ? vconst('girlItemSlotInit') || 15 : 0);
  const max = vconst(s.max) || Infinity;
  if (cur >= max) return fail(R_FAIL, '이미 최대');
  const cost = s.cost ? vconst(s.cost) : cur;
  if ((Number(ui.Cash) || 0) < cost) return fail(R_NO_CASH, '캐시 부족');
  ui.Cash = Number(ui.Cash) - cost;
  holder[s.field] = Math.min(cur + vconst(s.step), max);
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgExpandSlotAns', body: { Seq: 1, Result: R_OK, UserInfo: ui, SlotType: type, ...(girl ? { GirlInfo: girl } : {}) } }];
});

// ── 캐릭터 아이템 판매 MsgSellGirlItemReq {Itemid:[ItemId...]}
//   클라이언트 FittingRoom: SellPrice > -1 인 아이템만 판매 버튼, 가격 표시 = girlItemTable SellPrice.
//   추정(기록 없음): 코인으로 지급, 하나라도 판매 불가(없음·SellPrice -1·착용 중: DressSlot/SpecialDressSlot/AccessorySlot1~4)이면 전체 Result 2.
//   응답 MsgSellGirlItemAns {Seq, Result 1, UserInfo} + MsgDeleteGirlItemAns {Seq 2, GirlItemInfo:[{ItemId, ItemType, StackNum 0}]}
//   (클라이언트 applyGirlAnswer 가 StackNum 0 항목을 지우고, OnDispatch_MsgDeleteGirlItemAns 가 화면을 갱신).
const WEAR_SLOTS = ['DressSlot', 'SpecialDressSlot', 'AccessorySlot1', 'AccessorySlot2', 'AccessorySlot3', 'AccessorySlot4'];
register('MsgSellGirlItemReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const fail = (why: string): Msg[] => {
    console.warn(`[misc2] 캐릭터 아이템 판매 거절: ${why} ${JSON.stringify(body)}`);
    return [{ name: 'MsgSellGirlItemAns', body: { Seq: 1, Result: R_FAIL, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  };
  if (!snap) return fail('계정 없음');
  const ids = [...new Set<number>((Array.isArray(body?.Itemid) ? body.Itemid : [body?.Itemid]).map(Number))];
  const list: any[] = snap.GirlItems?.GirlItemInfo ?? [];
  const worn = new Set<number>();
  for (const g of snap.MyGirls?.MyGirlInfo ?? []) for (const k of WEAR_SLOTS) if (Number(g[k]) > 0) worn.add(Number(g[k]));
  const defs: any[] = table('girlItemTable.json')?.GirlItemInfo ?? [];
  let coin = 0;
  const sold: any[] = [];
  for (const id of ids) {
    const it = list.find((x) => Number(x.ItemId) === id);
    const price = Number(defs.find((d) => Number(d.Id) === Number(it?.ItemType))?.SellPrice ?? -1);
    if (!it) return fail(`아이템 없음 ${id}`);
    if (worn.has(id)) return fail(`착용 중 ${id}`);
    if (!(price >= 0)) return fail(`판매 불가 ${id}`);
    coin += price;
    sold.push(it);
  }
  if (!sold.length) return fail('요청 비어 있음');
  snap.GirlItems.GirlItemInfo = list.filter((x) => !sold.includes(x));
  snap.UserInfo.Coin = (Number(snap.UserInfo.Coin) || 0) + coin;
  ctx.store.putUser(uid(ctx), snap);
  return [
    { name: 'MsgSellGirlItemAns', body: { Seq: 1, Result: R_OK, UserInfo: snap.UserInfo } },
    { name: 'MsgDeleteGirlItemAns', body: { Seq: 2, GirlItemInfo: sold.map((x) => ({ ItemId: x.ItemId, ItemType: x.ItemType, StackNum: 0 })) } },
  ];
});

// ── 코팅 MsgCarCoatingReq {CarInfo: 차량, Randtype 1 코인 | 2 캐시(스킬 종류 고정, 수치만)}
//   실기록 2026-11-05 (차량 8, 데칼 104): 코인 8,000 -> 스킬 14 값 2, CoatingCount 1, 다음 CoatingCoin 12,000 / 12,000 -> 스킬 9 값 11, Count 2, 다음 16,000.
//   응답 {Seq, Result 1, UserInfo, CarInfo(CoatingSkill, CoatingValue, CoatingCount, CoatingTime 지금, CoatingCoin 다음 비용)}.
//   비용 = vconst coatingCoin[오늘 횟수] (8000, 12000, 16000, 20000, ...; 안내문: '매일 0시에 초기화'), 캐시 방식 추가 비용 vconst coatingCash 25.
//   스킬은 decals.json CoatingInfo 의 Skillrate 가중치로 뽑고 값은 [Skillvaluemin, Skillvaluemax] 균등 (추정: 표본 2건).
//   데칼이 없는 차량(DecalIndex -1)은 클라이언트가 막는다 -> Result 2. 일일 초기화 기준은 다른 일일 항목처럼 UTC 날짜로 둔다 (추정).
register('MsgCarCoatingReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const fail = (Result: number, why: string): Msg[] => {
    console.warn(`[misc2] 코팅 거절: ${why} ${JSON.stringify(body).slice(0, 160)}`);
    return [{ name: 'MsgCarCoatingAns', body: { Seq: 1, Result, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  };
  if (!snap) return fail(R_FAIL, '계정 없음');
  const car = findCar(snap, body?.CarInfo?.Carid);
  if (!car) return fail(R_FAIL, '차량 없음');
  if (Number(car.DecalIndex ?? -1) === -1) return fail(R_FAIL, '데칼 없음');
  const vc = (n: string) => (table('vconstTable.json')?.Vconst ?? []).find((v: any) => v.Name === n);
  const steps: number[] = vc('coatingCoin')?.Val ?? [8000, 12000, 16000, 20000, 25000];
  const today = new Date().toISOString().slice(0, 10);
  const day = (snap.coatingDay ??= {});
  if (day.date !== today) { day.date = today; day.n = {}; }
  const n = Number(day.n[car.Carid] ?? 0);
  const coin = steps[Math.min(n, steps.length - 1)];
  const cashMode = Number(body?.Randtype) === 2;
  const cash = cashMode ? Number(vc('coatingCash')?.Dval) || 25 : 0;
  const ui = snap.UserInfo;
  if ((Number(ui.Coin) || 0) < coin) return fail(R_NO_COIN, '코인 부족');
  if ((Number(ui.Cash) || 0) < cash) return fail(R_NO_CASH, '캐시 부족');
  const skills: any[] = table('decals.json')?.CoatingInfo ?? [];
  let sk = cashMode ? skills.find((x) => Number(x.Skillnum) === Number(car.CoatingSkill)) : null;
  if (!sk) { const tot = skills.reduce((a, x) => a + (Number(x.Skillrate) || 0), 0); let r = Math.random() * tot;
    sk = skills.find((x) => (r -= Number(x.Skillrate) || 0) < 0) ?? skills[skills.length - 1]; }
  if (!sk) return fail(R_FAIL, '코팅 표 없음');
  const lo = Number(sk.Skillvaluemin) || 1, hi = Number(sk.Skillvaluemax) || lo;
  ui.Coin = Number(ui.Coin) - coin; ui.Cash = (Number(ui.Cash) || 0) - cash;
  day.n[car.Carid] = n + 1;
  Object.assign(car, { CoatingSkill: Number(sk.Skillnum), CoatingValue: lo + Math.floor(Math.random() * (hi - lo + 1)),
    CoatingCount: (Number(car.CoatingCount) || 0) + 1, CoatingTime: Date.now() / 1000, CoatingCoin: steps[Math.min(n + 1, steps.length - 1)] });
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgCarCoatingAns', body: { Seq: 1, Result: R_OK, UserInfo: ui, CarInfo: car } }];
});

// ── 차량 꾸미기 MsgCustomizeCarReq {CarInfo:[{Carid, PlateName | ColorIndex | DecalIndex}]}
//   클라이언트 SSCarCustomize: 번호판은 이 메시지로 보낸다(3~12자, forbiddenNames 검사), 비용 = 코인 차종 Grade² x 200 (#M8 plateCost).
//   색상·데칼은 클라이언트가 MsgUseItemReq{Item, CarInfo} 로 보낸다(items.ts 담당) — 여기서는 혹시 오는 경우만 받는다 (추정):
//     ColorIndex 는 차량 OwnedColors 에 있는 색만, DecalIndex 는 -1(해제) 또는 보유 데칼 아이템(Category 621~625)의 Resources 와 같을 때만, 무료.
//   응답 {Seq, Result 1, CarInfo:[차량], UserInfo}, 코인 부족 Result 3, 그 외 오류 Result 2 (추정). 클라이언트는 Result 1 이면 'popup_customize_changed'.
register('MsgCustomizeCarReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const fail = (Result: number, why: string): Msg[] => {
    console.warn(`[misc2] 차량 꾸미기 거절: ${why} ${JSON.stringify(body)}`);
    return [{ name: 'MsgCustomizeCarAns', body: { Seq: 1, Result, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  };
  if (!snap) return fail(R_FAIL, '계정 없음');
  const reqs: any[] = Array.isArray(body?.CarInfo) ? body.CarInfo : body?.CarInfo ? [body.CarInfo] : [];
  if (!reqs.length) return fail(R_FAIL, '요청 비어 있음');
  const decals = new Set((snap.Items?.ItemInfo ?? []).map((it: any) => itemDef(Number(it.Itemtype)) as any)
    .filter((d: any) => d && Number(d.Category) >= 621 && Number(d.Category) <= 625).map((d: any) => Number(d.Resources)));
  const plans: { car: any; set: Record<string, any> }[] = [];
  let coin = 0;
  for (const r of reqs) {
    const car = findCar(snap, r?.Carid);
    if (!car) return fail(R_FAIL, `차량 없음 ${r?.Carid}`);
    const set: Record<string, any> = {};
    if (r.PlateName !== undefined) {
      const name = String(r.PlateName);
      if (!validName(name) || name === String(car.PlateName ?? '')) return fail(R_FAIL, '번호판 이름 오류');
      const grade = Number(carDefOf(car.Cartype)?.Grade) || Number(car.Grade) || 1;
      coin += grade * grade * 200;
      set.PlateName = name;
    }
    if (r.ColorIndex !== undefined) {
      const ci = Number(r.ColorIndex);
      if (!(car.OwnedColors ?? [Number(car.ColorIndex)]).map(Number).includes(ci)) return fail(R_FAIL, '보유하지 않은 색상');
      set.ColorIndex = ci;
    }
    if (r.DecalIndex !== undefined) {
      const di = Number(r.DecalIndex);
      if (di !== -1 && !decals.has(di)) return fail(R_FAIL, '보유하지 않은 데칼');
      set.DecalIndex = di;
    }
    if (!Object.keys(set).length) return fail(R_FAIL, '바꿀 항목 없음');
    plans.push({ car, set });
  }
  const ui = snap.UserInfo;
  if ((Number(ui.Coin) || 0) < coin) return fail(R_NO_COIN, '코인 부족');
  ui.Coin = (Number(ui.Coin) || 0) - coin;
  for (const p of plans) Object.assign(p.car, p.set);
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgCustomizeCarAns', body: { Seq: 1, Result: R_OK, CarInfo: plans.map((p) => p.car), UserInfo: ui } }];
});

// ── 시즌 보상 공용: 한 번만 받는다 (snap.seasonClaims = {wrace: [시즌], worldTour: [시즌]})
const claimed = (snap: any, kind: 'wrace' | 'worldTour'): number[] => ((snap.seasonClaims ??= {})[kind] ??= []);

// ── 주간 레이스 시즌 보상 MsgWRaceRewardReq {WSeasonId}
//   클라이언트: 지난 시즌 결과(MsgGetWRaceInfoAns.WraceResult/MyWRaceResult)가 있을 때 결과 창의 '보상 받기'에서 보낸다.
//   응답 후 WraceResult/MyWRaceResult 를 지우고 RewardInfo 로 획득 연출 (OnWRaceRewardAns).
//   보상 표: battleTable WeeklyRaceReward {Week 1~8, League 1~6, Rank 1~15, Reward, Amount}.
//   추정(기록 없음): 오프라인은 혼자라 기록이 있는 리그마다 1위. League = 주간 레이스 WRaceId(1~6, 하위 41~63 은 앞자리),
//     Week = (WSeasonId - 1) % 8 + 1. 지난 시즌 기록: snap.wracePrev {season, best} 또는 아직 지워지지 않은 snap.wraceBest(시즌 < 이번 시즌).
//   주의: weekly.ts myBest() 는 새 시즌이 되면 wraceBest 를 바로 비우고, MsgGetWRaceInfoAns 에 WraceResult 를 넣지 않으므로
//     지금은 클라이언트가 이 요청을 보낼 일이 거의 없다(보낼 결과가 없으면 Result 2).
register('MsgWRaceRewardReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const fail = (why: string): Msg[] => {
    console.warn(`[misc2] 주간 레이스 보상 거절: ${why} ${JSON.stringify(body)}`);
    return [{ name: 'MsgWRaceRewardAns', body: { Seq: 1, Result: R_FAIL, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  };
  if (!snap) return fail('계정 없음');
  const now = weeklySeason().id;
  const prev = snap.wracePrev?.best ? snap.wracePrev : snap.wraceBest?.season !== undefined && Number(snap.wraceBest.season) < now ? snap.wraceBest : null;
  const season = Number(prev?.season);
  if (!prev || !season) return fail('지난 시즌 기록 없음');
  if (body?.WSeasonId !== undefined && Number(body.WSeasonId) !== season) return fail(`시즌 불일치 (지난 시즌 ${season})`);
  if (claimed(snap, 'wrace').includes(season)) return fail('이미 받음');
  const leagues = new Set<number>();
  for (const [id, t] of Object.entries(prev.best ?? {})) if (Number(t) > 0) leagues.add(Number(id) >= 10 ? Math.floor(Number(id) / 10) : Number(id));
  const week = ((season - 1) % 8 + 8) % 8 + 1;
  const rows = (table('battleTable.json')?.WeeklyRaceReward ?? [])
    .filter((r: any) => Number(r.Week) === week && leagues.has(Number(r.League)) && Number(r.Rank) === 1)
    .map((r: any) => ({ type: Number(r.Reward), amount: Number(r.Amount) }));
  if (!rows.length) return fail('보상 표 없음');
  const reward = giveRewards(snap, rows);
  claimed(snap, 'wrace').push(season);
  delete snap.wracePrev;
  delete snap.WraceResult; delete snap.MyWRaceResult;
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgWRaceRewardAns', body: { Seq: 1, Result: R_OK, RewardInfo: reward, UserInfo: snap.UserInfo } }];
});

// ── 월드 투어 시즌 보상 MsgWorldTourRewardReq {}
//   클라이언트: WorldTourRewardPopup '받기'. 응답 후 WorldTourResult/MyWorldTourResult 를 지우고 RewardInfo 로 연출.
//   보상 표: battleTable WorldTourReward {Season 1~114, Rank 1~5, Reward(아이템 또는 차량), Amount}.
//   Rank 는 등급(RankTier 1 다이아 ~ 5 브론즈, 클라이언트 WT_diamond..WT_bronze)으로 본다 (추정).
//   지난 시즌 결과는 실서버 스냅샷 형식 snap.MyWorldTourResult {RankTier, ...} / snap.WorldTourResult {Season} 에서 읽는다.
//   오프라인에는 월드 투어(대전)가 없어 결과가 생기지 않는다. 결과가 있으면 RankTier(1~5)를 쓰고, 없으면 혼자이므로 1 (추정),
//   6 이상(미배치)은 Result 2. 누적 SponsorBonus 의 시즌 말 지급 방식은 미확인(미구현).
register('MsgWorldTourRewardReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const fail = (why: string): Msg[] => {
    console.warn(`[misc2] 월드 투어 보상 거절: ${why} ${JSON.stringify(body)}`);
    return [{ name: 'MsgWorldTourRewardAns', body: { Seq: 1, Result: R_FAIL, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  };
  if (!snap) return fail('계정 없음');
  const res = snap.MyWorldTourResult;
  if (!res) return fail('지난 시즌 결과 없음');
  const season = Number(snap.WorldTourResult?.Season ?? snap.WorldTourResult?.SeasonId ?? res.Season) || (Number(snap.WorldTour?.Season) || 1) - 1;
  if (claimed(snap, 'worldTour').includes(season)) return fail('이미 받음');
  const tier = res.RankTier === undefined ? 1 : Number(res.RankTier);
  if (!(tier >= 1 && tier <= 5)) return fail(`보상 등급 아님 (RankTier ${res.RankTier})`);
  const all: any[] = table('battleTable.json')?.WorldTourReward ?? [];
  // 표 시즌 행 = SeasonId % (표 최대 Season) + 1 (클라이언트 WorldTourRewardListPopup: 2026-11 SeasonId 142 -> 행 29)
  const maxS = all.reduce((m, r) => Math.max(m, Number(r.Season) || 0), 1);
  const sid = Number(snap.WorldTourResult?.SeasonId ?? res.SeasonId) || season - 1;
  const use = (sid % maxS) + 1;
  const rows = all.filter((r) => Number(r.Season) === use && Number(r.Rank) === tier).map((r) => ({ type: Number(r.Reward), amount: Number(r.Amount) }));
  if (!rows.length) return fail('보상 표 없음');
  const reward = giveRewards(snap, rows);
  claimed(snap, 'worldTour').push(season);
  delete snap.MyWorldTourResult; delete snap.WorldTourResult;
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgWorldTourRewardAns', body: { Seq: 1, Result: R_OK, RewardInfo: reward, UserInfo: snap.UserInfo } }];
});

// ── 친구: 오프라인에는 다른 플레이어가 없다. 응답 필드는 클라이언트 applySocialAnswer 기준:
//   MsgFriendListAns {Friends, Invitations} (초대 수 = Invitations.length), MsgFriendCandidateListAns·MsgSearchFriendAns {Friends},
//   MsgListSocialFriendsAns {Friend | FriendList}, MsgRecommendFriendAns 는 Result 만 본다(13 = 'No such user exists.',
//   14 = 이미 추천인 입력, 그 외 = 'Registered {0} as a referral.' 이라 오프라인은 13), MsgVisitAns {Visit}.
//   신청·수락·삭제·선물·방문은 상대가 없으니 Result 2 (추정). 신청·삭제는 요청의 Friend 를 돌려줘 클라이언트가 해당 칸을 지우게 한다.
register('MsgFriendListReq', (body): Msg[] => [{ name: 'MsgFriendListAns', body: { Seq: 1, Result: R_OK, Friends: [], Invitations: [], Version: Number(body?.Version) || 0 } }]);
register('MsgFriendCandidateListReq', (body): Msg[] => [{ name: 'MsgFriendCandidateListAns', body: { Seq: 1, Result: R_OK, Friends: [], Version: Number(body?.Version) || 0 } }]);
register('MsgSearchFriendReq', (): Msg[] => [{ name: 'MsgSearchFriendAns', body: { Seq: 1, Result: R_OK, Friends: [] } }]);
register('MsgListSocialFriendsReq', (): Msg[] => [{ name: 'MsgListSocialFriendsAns', body: { Seq: 1, Result: R_OK, Friend: [] } }]);
register('MsgRecommendFriendReq', (): Msg[] => [{ name: 'MsgRecommendFriendAns', body: { Seq: 1, Result: 13 } }]);
for (const [req, echo] of [['MsgAddFriend', true], ['MsgInviteFriend', true], ['MsgAcceptFriend', false], ['MsgDelFriend', true],
  ['MsgDelInvitation', true], ['MsgGiveToFriend', false], ['MsgVisit', false]] as const) {
  register(`${req}Req`, (body): Msg[] => [{ name: `${req}Ans`, body: { Seq: 1, Result: R_FAIL, ...(echo && body?.Friend ? { Friend: body.Friend } : {}) } }]);
}

// ── 쿠폰 MsgUseCouponReq {CouponString}
//   클라이언트 OptionPopup.OnUseCouponAns: Code 0(또는 없음) = 성공(RewardInfo 를 ApplyReward, 'coupon_success'),
//   Code 84 = 번호 오류, 82 = 만료, Result 72 = 이미 사용(Code 가 0 이 아니어야 이 분기에 닿는다), 그 외 = 번호 오류.
//   실서버는 보상을 우편으로 보내지만('The item has been mailed') 오프라인은 바로 지급한다 (추정).
//   쿠폰 정의: data/coupons.json (선택, data/ 는 gitignore) { "CODE": [{"Itemtype": 61001, "Count": 1000}, ...] }.
//   대소문자·앞뒤 공백 무시, 계정당 코드마다 한 번 (snap.usedCoupons). 응답 {Seq, Result 1, Code 0, RewardInfo, UserInfo}.
const COUPONS = new URL('../../data/coupons.json', import.meta.url).pathname;
function couponRewards(code: string): { type: number; amount: number }[] | null {
  if (!existsSync(COUPONS)) return null;
  let all: Record<string, any>;
  try { all = JSON.parse(readFileSync(COUPONS, 'utf8')); } catch (e) { console.warn(`[misc2] coupons.json 읽기 실패: ${(e as Error).message}`); return null; }
  const key = Object.keys(all ?? {}).find((k) => k.trim().toUpperCase() === code);
  const rows = key !== undefined ? all[key] : null;
  if (!Array.isArray(rows)) return null;
  return rows.map((r: any) => ({ type: Number(r?.Itemtype), amount: Number(r?.Count) || 1 })).filter((r) => r.type > 0);
}
register('MsgUseCouponReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const code = String(body?.CouponString ?? '').trim().toUpperCase();
  const rows = code ? couponRewards(code) : null;
  if (!snap || !rows || !rows.length) return [{ name: 'MsgUseCouponAns', body: { Seq: 1, Result: R_FAIL, Code: 84 } }];
  snap.usedCoupons ??= [];
  if (snap.usedCoupons.includes(code)) return [{ name: 'MsgUseCouponAns', body: { Seq: 1, Result: 72, Code: 72 } }];
  const reward = giveRewards(snap, rows);
  snap.usedCoupons.push(code);
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgUseCouponAns', body: { Seq: 1, Result: R_OK, Code: 0, RewardInfo: reward, UserInfo: snap.UserInfo } }];
});

// ── 마일리지 상자 MsgGetMileageBoxReq {}
//   클라이언트 SSCarCustomize: UserInfo.DecalMileage 100 마다 상자 1개(표시 최대 99), 100 이상일 때만 요청.
//   'MILEAGE_TOOLTIP': 100 포인트마다 데칼이 든 마일리지 상자. 응답 RewardInfo.ItemInfo[0] 을 획득 팝업으로 보여준다(OnGetMileageBoxAns).
//   추정(기록 없음): DecalMileage -100, itemTable Category 625 데칼(9종) 중 균등 무작위 1개.
//   응답 {Seq, Result 1, UserInfo, RewardInfo{..., ItemInfo:[{Itemid, Itemtype, Count 1, StackNum, DeltaNum 1}]}}, 100 미만이면 Result 2.
register('MsgGetMileageBoxReq', (_b, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const ui = snap?.UserInfo;
  if (!snap || (Number(ui.DecalMileage) || 0) < 100) return [{ name: 'MsgGetMileageBoxAns', body: { Seq: 1, Result: R_FAIL, ...(ui ? { UserInfo: ui } : {}) } }];
  const pool: any[] = (table('itemTable.json')?.Item ?? []).filter((r: any) => Number(r.Category) === 625);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (!pick) return [{ name: 'MsgGetMileageBoxAns', body: { Seq: 1, Result: R_FAIL, UserInfo: ui } }];
  ui.DecalMileage = Number(ui.DecalMileage) - 100;
  const reward = giveRewards(snap, [{ type: Number(pick.Id), amount: 1 }]);
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgGetMileageBoxAns', body: { Seq: 1, Result: R_OK, UserInfo: ui, RewardInfo: reward } }];
});
