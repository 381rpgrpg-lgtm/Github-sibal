// 일반 퀘스트(nquests.json). 형식·상태는 실서버 기록(2026-11-01, 퀘스트 10101~10301)을 따른다.
//
// 상태: 2 제시(트리거 충족) / 3 수락 / 6 목표 달성(보상 대기) / 7 보상 수령 완료.
// 트리거(모두 충족해야 제시):
//   1 [최소, 최대] 플레이어 레벨 범위 (추정: 10301 [1,12] 이 레벨 4 에서 제시됨)
//   2 [존, 순번]   해당 레이스 승리
//   3 [캐릭터, ?, 단계] 그 캐릭터 보유 + 친밀도 단계 이상 (10204 [20207,1,1] 이 해금 직후 제시)
//   4 [퀘스트]     선행 퀘스트 보상 수령(State 7)
//   7 [모델, 수]   해당 ModelHigh 차량 보유
// 목표: 상태형(지금 상태로 계산) 2·5·7·16·18·26·27, 나머지는 사건형(수락 후 해당 행동마다 +1 / +값).
//   CompleteCash = 목표 Cash, 없으면 -1 (기록).
// 수락(3): 즉시 평가해 모두 달성이면 6. 보상(7): Reward ItemType/Amount 지급, RewardInfo(Coin·Charexp 합산 + ItemInfo),
//   UserInfo, ItemInfo [], NquestInfo 에 이 퀘스트(7)와 새로 제시된 퀘스트(2).
// 추정(기록 없음): 사건형 목표 대부분의 세부 조건, 거절(State 4/5) 처리, 트리거 1 의 의미.
import { table, famLevel, carDefOf, partDef } from './gamecalc.js';
import { grantItem } from './inventory.js';

const S_OFFER = 2, S_ACCEPT = 3, S_DONE = 6, S_REWARDED = 7;
let defs: Map<number, any> | null = null;
export function questDefs(): Map<number, any> {
  if (!defs) defs = new Map((table('nquests.json')?.Quest ?? []).map((q: any) => [Number(q.Id), q]));
  return defs;
}
const list = (snap: any): any[] => {
  snap.NquestInfos ??= { NquestInfo: [], Version: 1 };
  return (snap.NquestInfos.NquestInfo ??= []);
};
const firstGirl = (snap: any) => Number(snap.UserInfo?.FirstGirl) || 0;
const girlId = (snap: any, p: any) => (!p || p === '[FIRSTGIRL]' ? firstGirl(snap) : Number(p));
const myGirl = (snap: any, id: number) => (snap.MyGirls?.MyGirlInfo ?? []).find((g: any) => Number(g.Girlid) === id && Number(g.State) === 7);
const raceWon = (snap: any, zone: number, idx: number) => {
  const z = (snap.RaceZones?.RaceZone ?? []).find((x: any) => Number(x.ZoneId) === zone);
  const r = z?.Race?.find((x: any) => Number(x.RaceIndex) === idx);
  return !!(r && Number(r.State) & 16);
};
const carGrade = (c: any) => Number(c.Grade) || Number(carDefOf(c.Cartype)?.Grade) || 1;

/** 상태형 목표 값 (사건형이면 null) */
function stateValue(snap: any, o: any): number | null {
  const p = o.Param ?? [];
  const cars: any[] = snap.Cars?.CarInfo ?? [];
  switch (Number(o.Type)) {
    case 2: if (p[1] && p[2]) return raceWon(snap, Number(p[1]), Number(p[2])) ? 1 : 0; return null;
    case 5: return myGirl(snap, girlId(snap, p[1])) ? 1 : 0;
    // 7: [1, 캐릭터, 목표 등급] = 한계 돌파 등급 (10802 '클로디아를 한계돌파 해 2등급'), [1, 캐릭터, '', 단계]·[1, 캐릭터, 1, 1, 단계] = 호감도 단계
    case 7: { const g = myGirl(snap, girlId(snap, p[1])); if (!g) return 0;
      if (p.length === 3) return (Number(g.Rarity) || 1) >= Number(p[2] || 1) ? 1 : 0;
      return famLevel(Number(g.Girlid), Number(g.Familiarity) || 0) >= Number(p[p.length - 1] || 1) ? 1 : 0; }
    case 16: return cars.filter((c) => carGrade(c) >= Number(p[2] || 1) && Number(c.UpgradeLevel) >= Number(p[3] || 1)).length;
    case 18: return cars.filter((c) => carGrade(c) >= Number(p[1] || 1)).length;
    case 26: { const cur = cars.find((c) => Number(c.Carid) === Number(snap.UserInfo?.Currentcar)); return cur && carGrade(cur) >= Number(p[2] || 1) ? 1 : 0; }
    // 27 [수, 부품 Id, 등급]: 부품 Id 가 있으면 그 부품 장착 (실기록 2026-11-03 10604: 33211·36211 장착 시 각각 1), 없으면 그 등급 이상 장착 수
    case 27: return (snap.Items?.ItemInfo ?? []).filter((it: any) => Number(it.Equipcarid) > 0
      && (p[1] ? Number(it.Itemtype) === Number(p[1]) : Number(partDef(it.Itemtype)?.Grade) >= Number(p[2] || 1))).length;
    default: return null;
  }
}

function freshRecord(q: any) {
  return { QuestId: Number(q.Id), State: S_OFFER, Objective: (q.Objective ?? []).map((o: any) => ({
    ObjId: Number(o.ObjId), CurrentValue: 0, CompleteCash: o.Cash !== undefined ? Number(o.Cash) : -1, CashCleared: false })) };
}

function triggersMet(snap: any, q: any): boolean {
  const ui = snap.UserInfo ?? {};
  const done = (id: number) => list(snap).some((x) => Number(x.QuestId) === id && Number(x.State) === S_REWARDED);
  for (const t of q.Trigger ?? []) {
    const p = t.Param ?? [];
    switch (Number(t.Type)) {
      case 1: if (Number(ui.Charlevel) < Number(p[0]) || Number(ui.Charlevel) > Number(p[1])) return false; break;
      case 2: if (!raceWon(snap, Number(p[0]), Number(p[1]))) return false; break;
      case 3: { const g = myGirl(snap, Number(p[0])); if (!g || famLevel(Number(g.Girlid), Number(g.Familiarity) || 0) < Number(p[2] || 1)) return false; break; }
      case 4: if (!done(Number(p[0]))) return false; break;
      case 7: if (!(snap.Cars?.CarInfo ?? []).some((c: any) => carDefOf(c.Cartype)?.ModelHigh === p[0])) return false; break;
      default: return false;
    }
  }
  return (q.Trigger ?? []).length > 0;
}

/** 목표 갱신: 상태형은 다시 계산, 수락 중인 퀘스트가 모두 달성이면 6 */
function evaluate(snap: any, rec: any): boolean {
  const q = questDefs().get(Number(rec.QuestId));
  if (!q) return false;
  let changed = false;
  for (const o of q.Objective ?? []) {
    const r = rec.Objective.find((x: any) => Number(x.ObjId) === Number(o.ObjId));
    if (!r) continue;
    const need = Number(o.Param?.[0]) || 1;
    // 캐시로 완료한 목표(MsgNquestObjectiveClearReq, CashCleared)는 상태형이어도 다시 계산하지 않고 달성으로 둔다
    if (r.CashCleared) { if (Number(r.CurrentValue) < need) { r.CurrentValue = need; changed = true; } continue; }
    const v = stateValue(snap, o);
    if (v !== null) { const nv = Math.min(v, need); if (nv !== r.CurrentValue) { r.CurrentValue = nv; changed = true; } }
  }
  if (Number(rec.State) === S_ACCEPT) {
    const allDone = (q.Objective ?? []).every((o: any) => {
      const r = rec.Objective.find((x: any) => Number(x.ObjId) === Number(o.ObjId));
      return r && Number(r.CurrentValue) >= (Number(o.Param?.[0]) || 1);
    });
    if (allDone) { rec.State = S_DONE; changed = true; }
  }
  return changed;
}

/** 제시 가능한 새 퀘스트 + 진행 중 퀘스트 갱신. 바뀐 레코드 목록 반환 (MsgUpdateNquest 알림용). */
export function refreshQuests(snap: any): any[] {
  const out: any[] = [];
  const mine = list(snap);
  // 제시(2) 상태의 목표 값은 갱신하지 않는다 (기록: 10202 제시 시 이미 달성한 목표도 0, 수락 시 1)
  for (const rec of mine) if (Number(rec.State) === S_ACCEPT && evaluate(snap, rec)) out.push(rec);
  for (const q of questDefs().values()) {
    if (mine.some((x) => Number(x.QuestId) === Number(q.Id))) continue;
    if (!triggersMet(snap, q)) continue;
    const rec = freshRecord(q);
    mine.push(rec); out.push(rec);
  }
  return out;
}

/** 사건형 목표 진행 (수락 중 퀘스트만). kind: 목표 Type, match(o.Param) 가 true 면 +by */
export function questEvent(snap: any, type: number, match: (p: any[]) => boolean, by = 1): void {
  for (const rec of list(snap)) {
    if (Number(rec.State) !== S_ACCEPT) continue;
    const q = questDefs().get(Number(rec.QuestId));
    for (const o of q?.Objective ?? []) {
      if (Number(o.Type) !== type || !match(o.Param ?? [])) continue;
      const r = rec.Objective.find((x: any) => Number(x.ObjId) === Number(o.ObjId));
      if (r) r.CurrentValue = Math.min((Number(r.CurrentValue) || 0) + by, Number(o.Param?.[0]) || 1);
    }
  }
}
export const firstGirlOf = firstGirl;

/** MsgUpdateNquestReq 처리. 반환: 응답 body (Seq 제외) */
export function updateQuest(snap: any, questId: number, state: number, levelUp: (snap: any) => void): any {
  const q = questDefs().get(questId);
  const mine = list(snap);
  let rec = mine.find((x) => Number(x.QuestId) === questId);
  const base = { Result: 1, RequestedQuestId: questId, RequestedState: state };
  if (!q) return { ...base, Result: 2 };
  if (!rec) { rec = freshRecord(q); mine.push(rec); }
  if (state === S_ACCEPT) {
    rec.State = S_ACCEPT;
    evaluate(snap, rec);
    return { ...base, NquestInfo: [rec] };
  }
  if (state === S_REWARDED) {
    evaluate(snap, rec);
    if (Number(rec.State) !== S_DONE) return { ...base, Result: 2, NquestInfo: [rec] };
    rec.State = S_REWARDED;
    const ui = snap.UserInfo;
    const reward: any = { Coin: 0, Charexp: 0, Cash: 0, Familiartity: 0, ItemInfo: [], CarInfo: [] };
    const types: number[] = q.Reward?.ItemType ?? [], amts: number[] = q.Reward?.Amount ?? [];
    types.forEach((t, i) => {
      const n = Number(amts[i]) || 1;
      if (!grantItem(snap, Number(t), n)) return;
      if (Number(t) === 61001) reward.Coin += n;
      if (Number(t) === 61003) reward.Charexp += n;
      if (Number(t) === 61002) reward.Cash += n;
      const it = (snap.Items?.ItemInfo ?? []).find((x: any) => Number(x.Itemtype) === Number(t));
      reward.ItemInfo.push(it ? { Itemid: it.Itemid, Itemtype: Number(t), Count: n, StackNum: it.Count, DeltaNum: n } : { Itemtype: Number(t), Count: n, DeltaNum: n });
    });
    // 기록 순서: 61003(경험치) → 아이템 → 61001(코인)·61002(캐시) (실기록 10302, 10303)
    const rank = (t: number) => (t === 61003 ? 0 : t === 61001 || t === 61002 ? 2 : 1);
    reward.ItemInfo.sort((a: any, b: any) => rank(Number(a.Itemtype)) - rank(Number(b.Itemtype)));
    // LevelUp: 경험치를 주는 보상이면 새로 계산 (레벨업이면 설정, 아니면 지움). 레벨업이면 RewardInfo.UserInfo 도 (실기록 10402 보상 -> 6레벨)
    const lvBefore = Number(ui.Charlevel);
    if (reward.Charexp > 0) delete ui.LevelUp;
    levelUp(snap);
    if (Number(ui.Charlevel) > lvBefore) reward.UserInfo = { ...ui };
    const offered = refreshQuests(snap).filter((x) => x !== rec);
    const uiOut = { ...ui };
    return { ...base, NquestInfo: [rec, ...offered], RewardInfo: reward, UserInfo: uiOut, ItemInfo: [] };
  }
  rec.State = state; // 거절 등 (추정)
  return { ...base, NquestInfo: [rec] };
}
