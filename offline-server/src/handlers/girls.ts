// 캐릭터(걸) 관련. 데이터 모델은 클라이언트 소스에서 읽은 필드 기준:
//   MyGirls.MyGirlInfo[]: { Girlid, State(7=열림), Familiarity, Rarity, DateCoolTime, ... }
//   UserInfo.PassengerGirl: 동승 캐릭터, UserInfo.FirstGirl: 튜토리얼 첫 선택 캐릭터
// 정의: data/tables/girlTable.json (Girl[].Id / Rarity)
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg } from '../rpc.js';

const GIRL_OPEN = 7;
const TABLE = new URL('../../data/tables/girlTable.json', import.meta.url).pathname;
let girlDefs: Map<number, any> | null = null;
function girlDef(id: number) {
  if (!girlDefs) {
    girlDefs = new Map();
    if (existsSync(TABLE)) for (const g of JSON.parse(readFileSync(TABLE, 'utf8')).Girl ?? []) girlDefs.set(Number(g.Id), g);
  }
  return girlDefs.get(Number(id)) ?? null;
}

export function ensureGirl(snap: any, girlid: number): any {
  snap.MyGirls ??= { MyGirlInfo: [], Version: 1 };
  snap.MyGirls.MyGirlInfo ??= [];
  let g = snap.MyGirls.MyGirlInfo.find((x: any) => Number(x.Girlid) === Number(girlid));
  if (!g) {
    g = newGirlRecord(girlid);
    snap.MyGirls.MyGirlInfo.push(g);
    snap.MyGirls.Version = (snap.MyGirls.Version ?? 0) + 1;
  }
  return g;
}

// 신규 캐릭터 레코드. 형식·초기값은 실서버 MsgFirstSelectAns.SelectGirl 기록(2026-11-01) 그대로.
//   NextFamiliarityTime 은 기록상 요청 시점 + 약 13시간. NextCoin 200, GirlItemSlotNum 15.
export function newGirlRecord(girlid: number): any {
  return {
    Girlid: Number(girlid), Familiarity: 400, Emotion: 0, ItemFlag: 0, NthDate: 0, State: GIRL_OPEN,
    Rarity: girlDef(girlid)?.Rarity ?? 1, DateCoolTime: 0, DateCoolTimeResetCost: 1, LastDatePlace: 0,
    SameDateCnt: 0, DatingState: [], GirlItemSlotNum: 15, NextCoin: 200,
    NextFamiliarityTime: Math.floor(Date.now() / 1000) + 13 * 3600,
  };
}

// Ggraph(관계도)에서 해당 캐릭터 노드를 열고(State 7) 맨 앞으로 옮긴 뒤 NodeId 를 1.. 로 다시 매긴다.
function openGraphNode(snap: any, girlid: number) {
  const nodes: any[] = snap.Ggraph?.Gnode ?? [];
  const i = nodes.findIndex((n) => Number(n.GirlInfo?.Girlid) === Number(girlid));
  if (i < 0) return;
  const [node] = nodes.splice(i, 1);
  node.State = GIRL_OPEN;
  nodes.unshift(node);
  nodes.forEach((n, k) => (n.NodeId = k + 1));
}

const TUTORIAL_FIRST_SELECT = 256; // UserInfo.Completion 비트 (실서버: 109 -> 365)

// 튜토리얼 첫 선택: {SelectGirl:{Girlid}} -> MsgFirstSelectAns {Seq, UserInfo, Ggraph, SelectGirl, GirlItemInfo}
// 클라이언트는 응답을 기다리지 않고 SELECT_<id> 스크립트로 진행하며, Completion 비트로 튜토리얼 단계를 판단한다.
register('MsgFirstSelectReq', (body, ctx): Msg[] => {
  const girlid = Number(body?.SelectGirl?.Girlid);
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap || !girlDef(girlid)) return [{ name: 'MsgFirstSelectAns', body: { Result: 0 } }];
  const g = ensureGirl(snap, girlid);
  Object.assign(g, { ...newGirlRecord(girlid), ...g, State: GIRL_OPEN });
  openGraphNode(snap, girlid);
  const ui = snap.UserInfo;
  ui.FirstGirl = girlid;
  ui.MainGirl = girlid;
  ui.PassengerGirl = girlid;
  ui.Completion = (Number(ui.Completion) || 0) | TUTORIAL_FIRST_SELECT;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgFirstSelectAns',
    body: { Seq: 1, UserInfo: ui, Ggraph: snap.Ggraph, SelectGirl: g, GirlItemInfo: [] },
  }];
});

// 친밀도 코인 수령 (관계도에서 캐릭터별). 실기록 2건(2026-11-02, 20101·20207):
//   요청 {GirlInfo: 클라이언트가 가진 캐릭터 레코드} -> {Result 1, GirlInfo(NextFamiliarityTime = 지금 + 12시간), UserInfo(Coin + NextCoin)}
//   Familiarity 는 바뀌지 않는다. 시간 전 요청은 Result 2 (추정: 기록 없음).
register('MsgCollectFamiliarityReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const id = Number(body?.GirlInfo?.Girlid);
  const g = (snap?.MyGirls?.MyGirlInfo ?? []).find((x: any) => Number(x.Girlid) === id && Number(x.State) === GIRL_OPEN);
  const now = Date.now() / 1000;
  if (!snap || !g) return [{ name: 'MsgCollectFamiliarityAns', body: { Result: 2 } }];
  // 실기록 2026-11-02 (31건): 삐친 상태(Emotion 2)면 수령 시각이 지났어도 Result 2 (GirlInfo·UserInfo 그대로). Emotion 3 은 Result 1.
  if (Number(g.NextFamiliarityTime) > now || Number(g.Emotion) === 2)
    return [{ name: 'MsgCollectFamiliarityAns', body: { Result: 2, GirlInfo: g, UserInfo: snap.UserInfo } }];
  const coin = Number(g.NextCoin) || 100;
  snap.UserInfo.Coin = (Number(snap.UserInfo.Coin) || 0) + coin;
  g.NextFamiliarityTime = Math.floor(now) + 12 * 3600;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgCollectFamiliarityAns', body: { Seq: 1, Result: 1, GirlInfo: g, UserInfo: snap.UserInfo } }];
});

// 캐릭터 의상 장착·해제. 실기록(2026-11-02, 20105 드레스): 요청 {GirlInfo:{Girlid, <슬롯 필드>: GirlItems ItemId | -1(해제), SpecialDressVisibleCheck?}}
//   -> {Seq, Result 1, UpdateGirlInfo [캐릭터 레코드 전체], GgraphPatch {Gnode []}, GirlItemInfo []}. 해제 후에도 필드는 -1 로 남는다.
//   슬롯 필드는 클라이언트가 아이템 종류로 정한다(SpecialDressSlot 등). 이름에 'Slot' 이 든 필드와 SpecialDressVisibleCheck 만 받는다.
register('MsgUpdateMyGirlInfoReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const req = body?.GirlInfo ?? {};
  const g = (snap?.MyGirls?.MyGirlInfo ?? []).find((x: any) => Number(x.Girlid) === Number(req.Girlid) && Number(x.State) === GIRL_OPEN);
  if (!snap || !g) return [{ name: 'MsgUpdateMyGirlInfoAns', body: { Result: 2 } }];
  const owned = new Set((snap.GirlItems?.GirlItemInfo ?? []).map((x: any) => Number(x.ItemId)));
  for (const [k, v] of Object.entries(req)) {
    if (k === 'Girlid' || k === 'GirlItemSlotNum') continue;
    if (k === 'SpecialDressVisibleCheck') { g[k] = !!v; continue; }
    if (!/Slot/.test(k)) continue;
    const id = Number(v);
    if (id !== -1 && !owned.has(id)) return [{ name: 'MsgUpdateMyGirlInfoAns', body: { Result: 2 } }];
    g[k] = id;
  }
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgUpdateMyGirlInfoAns', body: { Seq: 1, Result: 1, UpdateGirlInfo: [g], GgraphPatch: { Gnode: [] }, GirlItemInfo: [] } }];
});

// ── 한계 돌파 (레어도 확장) ──────────────────────────────────────────────
// 실기록 2026-11-05 (20404 클로디아 1 -> 2): 0088 MsgGirlExpansionInfoReq, 0089 MsgGirlRarityExpandReq (Result 1),
//   그 전 거절 기록 다수 (0057 등, Result 2 = {Seq, Result 2, UserInfo}).
// 클라이언트 GirlExpansionPopup.SetData 의 조건:
//   공통 1 호감도 단계 4, 공통 2 Emotion 3, 공통 3 '수영복 선물' = 첫 수영복(girlItemTable 같은 캐릭터·Slot 10·SellPrice<0·Id%100==11) 보유
//     (기록: 수영복 없을 때 나머지 조건이 다 맞아도 Result 2, 백화점에서 수영복을 산 뒤 Result 1),
//   추가 = girlTable SGirlExpansionCritSet[TargetRarity = Rarity+1].SGirlExpansionCrit 각각 CurrentValue >= Param1, 코인 >= ExpansionCoin.
// 성공: 코인 -ExpansionCoin, Rarity +1, Familiarity 0, NextCoin = 100 x (단계 + Rarity - 1) (기록 200),
//   GirlInfo.GirlExpansionCritInfo = 다음 단계 조건 진행값, GirlRarityExpandId 에서 제거, 퀘스트 Type 7 [1, 캐릭터, 목표 등급] 갱신.
// 진행값: 기록상 Param1 에서 잘린다 (데이트 21회인데 6/6, 다음 단계 별점 28/28·승리 24/24·연락처 4/4).
//   실서버 누적 카운터라 정확한 식은 없다. 추정: 저장된 값(GirlExpansionCritInfo)이 있으면 그 값, 없으면
//   1 데이트 수 = NthDate, 2 데이트 별점 합 = DatingState MaxRecord 합, 13 에피소드 = 보스(RaceIndex 20) 이긴 가장 높은 구역,
//   14·16 레이스 승리·진행 = 이긴 레이스 수(하한), 17 연락처 = 열린 캐릭터 수 - 1, 그 외 0. 모두 Param1 에서 자른다.
import { famLevel, syncGirl, table } from '../gamecalc.js';
import { refreshQuests } from '../quests.js';

const myOpenGirl = (snap: any, id: number) => (snap?.MyGirls?.MyGirlInfo ?? []).find((x: any) => Number(x.Girlid) === id && Number(x.State) === GIRL_OPEN);
const firstSwimsuit = (girl: number) => (table('girlItemTable.json')?.GirlItemInfo ?? [])
  .find((i: any) => Number(i.GirlId) === girl && Number(i.Slot) === 10 && Number(i.SellPrice) < 0 && Number(i.Id) % 100 === 11)?.Id;
const critSet = (girl: number, target: number) => (girlDef(girl)?.SGirlExpansionCritSet ?? []).find((s: any) => Number(s.TargetRarity) === target) ?? null;

export function critProgress(snap: any, g: any, set: any): any[] {
  const stored = new Map<number, any>((g.GirlExpansionCritInfo ?? []).map((c: any) => [Number(c.Critid), c]));
  const zones: any[] = (snap.RaceZones?.RaceZone ?? []).filter((z: any) => Number(z.ZoneId) < 1000);
  const wins = zones.reduce((n, z) => n + (z.Race ?? []).filter((r: any) => Number(r.State) & 16).length, 0);
  const episode = zones.filter((z) => (z.Race ?? []).some((r: any) => Number(r.RaceIndex) === 20 && Number(r.State) & 16)).reduce((m, z) => Math.max(m, Number(z.ZoneId)), 0);
  const opened = (snap.MyGirls?.MyGirlInfo ?? []).filter((x: any) => Number(x.State) === GIRL_OPEN).length;
  return (set?.SGirlExpansionCrit ?? []).map((c: any) => {
    const s = stored.get(Number(c.Critid));
    const est: Record<number, number> = { 1: Number(g.NthDate) || 0, 2: (g.DatingState ?? []).reduce((n: number, d: any) => n + (Number(d.MaxRecord) || 0), 0),
      13: episode, 14: wins, 16: wins, 17: Math.max(0, opened - 1) };
    const v = s ? Number(s.CurrentValue) || 0 : est[Number(c.CritType)] ?? 0;
    return { Critid: Number(c.Critid), CurrentValue: Math.min(v, Number(c.Param1) || v), ClearCash: Number(s?.ClearCash ?? c.ClearCash) || 0 };
  });
}

/** 한계 돌파 조건(코인 제외)을 다 갖췄는지. 실기록: 백화점에서 수영복을 산 응답에 GirlRarityExpandId [캐릭터] 가 붙었다 (0084). */
export function expansionReady(snap: any, g: any): boolean {
  const id = Number(g?.Girlid);
  const set = critSet(id, (Number(g?.Rarity) || 1) + 1);
  const swim = firstSwimsuit(id);
  if (!set || swim === undefined) return false;
  return famLevel(id, Number(g.Familiarity) || 0) >= 4 && Number(g.Emotion) === 3
    && (snap.GirlItems?.GirlItemInfo ?? []).some((x: any) => Number(x.ItemType) === Number(swim))
    && critProgress(snap, g, set).every((c, i) => c.CurrentValue >= Number(set.SGirlExpansionCrit[i].Param1));
}

register('MsgGirlExpansionInfoReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const id = Number(body?.GirlInfo?.Girlid);
  const g = myOpenGirl(snap, id);
  if (!snap || !g) return [{ name: 'MsgGirlExpansionInfoAns', body: { Seq: 1, Result: 2 } }];
  const set = critSet(id, (Number(g.Rarity) || 1) + 1);
  return [{ name: 'MsgGirlExpansionInfoAns', body: { Seq: 1, Result: 1, GirlInfo: { Girlid: id, GirlExpansionCritInfo: critProgress(snap, g, set) } } }];
});

register('MsgGirlRarityExpandReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const id = Number(body?.GirlInfo?.Girlid);
  const g = myOpenGirl(snap, id);
  if (!snap || !g) return [{ name: 'MsgGirlRarityExpandAns', body: { Seq: 1, Result: 2, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  const ui = snap.UserInfo;
  const rarity = Number(g.Rarity) || Number(girlDef(id)?.Rarity) || 1;
  const set = critSet(id, rarity + 1);
  const swim = firstSwimsuit(id);
  const crits = critProgress(snap, g, set);
  const ok = !!set && famLevel(id, Number(g.Familiarity) || 0) >= 4 && Number(g.Emotion) === 3
    && swim !== undefined && (snap.GirlItems?.GirlItemInfo ?? []).some((x: any) => Number(x.ItemType) === Number(swim))
    && crits.every((c, i) => c.CurrentValue >= Number(set.SGirlExpansionCrit[i].Param1))
    && (Number(ui.Coin) || 0) >= (Number(set.ExpansionCoin) || 0);
  if (!ok) return [{ name: 'MsgGirlRarityExpandAns', body: { Seq: 1, Result: 2, UserInfo: ui } }];
  ui.Coin = Number(ui.Coin) - (Number(set.ExpansionCoin) || 0);
  g.Rarity = rarity + 1;
  g.Familiarity = 0;
  syncGirl(g);
  delete g.GirlExpansionCritInfo;
  const next = critSet(id, rarity + 2);
  if (next) g.GirlExpansionCritInfo = critProgress(snap, g, next);
  snap.GirlRarityExpandId = (snap.GirlRarityExpandId ?? []).filter((x: any) => Number(x) !== id);
  const questChanges = refreshQuests(snap);
  ctx.store.putUser(ctx.session.accountId, snap);
  return [
    { name: 'MsgGirlRarityExpandAns', body: { Seq: 1, Result: 1, UserInfo: ui, GirlInfo: g, GirlRarityExpandId: snap.GirlRarityExpandId } },
    ...(questChanges.length ? [{ name: 'MsgUpdateNquest', body: { Seq: 2, NquestInfo: questChanges } }] : []),
  ];
});
