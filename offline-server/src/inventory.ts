// 인벤토리 공용 로직. 아이템 정의는 data/tables/itemTable.json (Item[].Id / Stack / Category).
// 클라이언트는 응답 본문의 Items(전체) 를 받으면 인벤토리를 교체하고, UserInfo 를 받으면 재화를 교체한다(#patch).
import { readFileSync, existsSync } from 'node:fs';

const TABLE = new URL('../data/tables/itemTable.json', import.meta.url).pathname;
let itemDefs: Map<number, { Stack: number; Category?: number; Info?: string }> | null = null;

export function itemDef(type: number) {
  if (!itemDefs) {
    itemDefs = new Map();
    if (existsSync(TABLE)) {
      for (const r of JSON.parse(readFileSync(TABLE, 'utf8')).Item ?? []) itemDefs.set(Number(r.Id), r);
    }
  }
  return itemDefs.get(Number(type)) ?? null;
}

function nextItemId(snap: any): number {
  return (snap.Items?.ItemInfo ?? []).reduce((m: number, it: any) => Math.max(m, Number(it.Itemid) || 0), 0) + 1;
}

/** 아이템 지급. 같은 종류 칸을 Stack 한도까지 채우고 남으면 새 칸. 정의 없는 타입은 false. */
export function grantItem(snap: any, itemtype: number, count: number): boolean {
  const def = itemDef(itemtype);
  if (!def || count <= 0) return false;
  snap.Items ??= { ItemInfo: [] };
  snap.Items.ItemInfo ??= [];
  const max = Math.max(1, Number(def.Stack) || 1);
  let left = count;
  for (const it of snap.Items.ItemInfo) {
    if (left <= 0) break;
    if (Number(it.Itemtype) !== Number(itemtype)) continue;
    const room = max - (Number(it.Count) || 0);
    if (room <= 0) continue;
    const add = Math.min(room, left);
    it.Count = (Number(it.Count) || 0) + add;
    it.StackNum = it.Count;
    left -= add;
  }
  while (left > 0) {
    const add = Math.min(max, left);
    snap.Items.ItemInfo.push({ Itemid: nextItemId(snap), Itemtype: Number(itemtype), Count: add, StackNum: add });
    left -= add;
  }
  return true;
}
