// 아이템 사용: MsgUseItemReq {Item:{Itemid}} -> MsgUseItemAns
// 클라이언트 계약(소스 확인):
//  - 연료 아이템은 itemTable Category 605. 충전량은 클라이언트도 아이템 설명 문구의 첫 정수로 표시한다(FuelUsePopup).
//    → 서버도 text_en 의 같은 문구에서 읽는다 (60043 'Fuel_2' = 150).
//  - 사용 버튼은 현재 연료 < 최대일 때만 요청을 보낸다.
//  - 응답의 UserInfo 는 재화·연료를 교체하고, ItemInfo[{..., StackNum, DeltaNum}] 은 인벤토리를 갱신한다(StackNum 0 = 삭제).
// 구현: 연료(605, 넘치면 Fuelbonus), 대전·이벤트 티켓(641·642), 상자(603)의 부품 칸 부족 거절(Result 8). 그 외(상자 내용물 등)는 미구현(Result 2 + 로그).
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg } from '../rpc.js';
import { itemDef } from '../inventory.js';
import { table, partDef } from '../gamecalc.js';
import { fuelNow } from './battle.js';

const CAT_FUEL = 605;
const FUEL_FILL_SEC = 15;
const TEXT = new URL('../../data/tables/text_en.json', import.meta.url).pathname;
let texts: Record<string, string> | null = null;
function fuelAmount(def: any): number {
  if (!texts) texts = existsSync(TEXT) ? JSON.parse(readFileSync(TEXT, 'utf8')) : {};
  for (const w of String(texts![def.Description] ?? '').split(/\s+/)) if (/^[+-]?\d+$/.test(w)) return parseInt(w, 10);
  return 0;
}

register('MsgUseItemReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const fail = (why: string): Msg[] => {
    console.warn(`[items] 사용 거절: ${why} ${JSON.stringify(body).slice(0, 200)}`);
    return [{ name: 'MsgUseItemAns', body: { Seq: 1, Result: 2, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  };
  if (!snap) return fail('계정 없음');
  const list: any[] = snap.Items?.ItemInfo ?? [];
  const item = list.find((x) => Number(x.Itemid) === Number(body?.Item?.Itemid));
  if (!item || !(Number(item.Count ?? item.StackNum) > 0)) return fail('아이템 없음');
  const def: any = itemDef(Number(item.Itemtype));
  const cat = Number(def?.Category);
  const ui = snap.UserInfo;
  // 실기록 2026-11-05 (MsgUseItemReq 0003~0055): 응답 {Seq, Result 1, UserInfo, RequestedItem {Itemid, Itemtype}, ItemInfo [{Itemid, Itemtype, StackNum 남은 수}]}
  const consume = (): Msg[] => {
    const left = Number(item.Count ?? item.StackNum) - 1;
    if (left > 0) { item.Count = left; item.StackNum = left; } else snap.Items.ItemInfo = list.filter((x) => x !== item);
    ctx.store.putUser(ctx.session.accountId, snap);
    return [{ name: 'MsgUseItemAns', body: { Seq: 1, Result: 1, UserInfo: ui, RequestedItem: { Itemid: Number(item.Itemid), Itemtype: Number(item.Itemtype) },
      ItemInfo: [{ Itemid: Number(item.Itemid), Itemtype: Number(item.Itemtype), StackNum: Math.max(left, 0) }] } }];
  };
  // 대전 티켓(641): FightTicket += itemTable Param (실기록 60114 +5, 60115 +10, 60109 +1).
  // 이벤트 티켓(642): EventRaceTicket += Param (기록 없음, 641 과 같은 방식으로 추정).
  if (cat === 641) { ui.FightTicket = (Number(ui.FightTicket) || 0) + (Number(def.Param) || 1); return consume(); }
  if (cat === 642) { ui.EventRaceTicket = (Number(ui.EventRaceTicket) || 0) + (Number(def.Param) || 1); return consume(); }
  // 상자(603): 상점 정의 PartSlotNeed 보다 부품 빈 칸이 적으면 Result 8 (실기록 61202 VIP 파츠 박스: 빈 칸 1·2 에서 8, 3 에서 성공).
  //   내용물 뽑기(GachaId 확률)는 미구현.
  if (cat === 603) {
    const store = (table('itemTable.json')?.StoreItem ?? []).find((s: any) => Number(s.Id) === parseInt(String(def.Resources), 10));
    const partsFree = Number(ui.PartsSlotNum) - list.filter((x) => partDef(x.Itemtype) && !(Number(x.Equipcarid) > 0)).length;
    if (store?.PartSlotNeed !== undefined && partsFree < Number(store.PartSlotNeed)) {
      return [{ name: 'MsgUseItemAns', body: { Seq: 1, Result: 8, UserInfo: ui, RequestedItem: { Itemid: Number(item.Itemid), Itemtype: Number(item.Itemtype) } } }];
    }
  }
  if (!def || cat !== CAT_FUEL) return fail(`미구현 아이템 종류 (Category ${def?.Category})`);

  const max = Math.trunc(Number(ui.Fuelvalue) || 0);
  const cur = fuelNow(ui);
  // 실기록 0055: 연료가 가득 찬 상태(Fuelvalue 691, Fueltime 지남)에서 60043(150) 사용 -> Result 1, Fuelvalue 그대로, UserInfo.Fuelbonus 150.
  //   가득 차 있으면 넘치는 연료는 Fuelbonus 에 쌓인다. 가득 차지 않았을 때 넘치는 분도 Fuelbonus 로 간다고 추정.
  const amount = fuelAmount(def);
  if (cur >= max) { ui.Fuelbonus = (Number(ui.Fuelbonus) || 0) + amount; return consume(); }
  const after = Math.min(max, cur + amount);
  if (cur + amount > max) ui.Fuelbonus = (Number(ui.Fuelbonus) || 0) + (cur + amount - max);
  const nowS = Date.now() / 1000;
  ui.Fueltime = after >= max ? nowS : nowS + (max - after) * FUEL_FILL_SEC;

  const left = Number(item.Count ?? item.StackNum) - 1;
  if (left > 0) { item.Count = left; item.StackNum = left; } else snap.Items.ItemInfo = list.filter((x) => x !== item);
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgUseItemAns',
    body: { Seq: 1, Result: 1, UserInfo: ui, ItemInfo: [{ ...item, Count: Math.max(left, 0), StackNum: Math.max(left, 0), DeltaNum: -1 }] },
  }];
});
