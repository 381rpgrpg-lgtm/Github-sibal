// 아이템 사용: MsgUseItemReq {Item:{Itemid}} -> MsgUseItemAns
// 클라이언트 계약(소스 확인):
//  - 연료 아이템은 itemTable Category 605. 충전량은 클라이언트도 아이템 설명 문구의 첫 정수로 표시한다(FuelUsePopup).
//    → 서버도 text_en 의 같은 문구에서 읽는다 (60043 'Fuel_2' = 150).
//  - 사용 버튼은 현재 연료 < 최대일 때만 요청을 보낸다.
//  - 응답의 UserInfo 는 재화·연료를 교체하고, ItemInfo[{..., StackNum, DeltaNum}] 은 인벤토리를 갱신한다(StackNum 0 = 삭제).
// 추정(실서버 기록 없음): 최대치를 넘는 충전분은 버린다. 연료 외 아이템 사용은 미구현(Result 2 + 로그).
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg } from '../rpc.js';
import { itemDef } from '../inventory.js';
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
  const def = itemDef(Number(item.Itemtype));
  if (!def || Number(def.Category) !== CAT_FUEL) return fail(`미구현 아이템 종류 (Category ${def?.Category})`);

  const ui = snap.UserInfo;
  const max = Math.trunc(Number(ui.Fuelvalue) || 0);
  const cur = fuelNow(ui);
  if (cur >= max) return fail('연료가 이미 가득 참');
  const after = Math.min(max, cur + fuelAmount(def));
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
