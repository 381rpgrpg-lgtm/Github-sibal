// 캐릭터 연락처 해금 조건 (girlTable.json GirlUnlockCrit). 실기록 2026-11-02 존 3:
//   3-13 승리 -> 20405(조건 1개: 8 [50003,13]) 모두 충족 -> 관계도 노드·GirlInfo State 6, 캐릭터 레이스 3-25 State 1 + UnlockGirlInfo {Girlid, State 6}
//   3-14 승리 -> 20104(조건 3개 중 Rid 2 충족) -> State 5, UnlockCritFlag 2, 레이스 3-26 은 State 8 그대로 + UnlockGirlInfo {State 5}
//   GirlInfo: 신규 레코드 + Familiarity 0, NextCoin 100 x Rarity, NextFamiliarityTime 지금+12시간,
//             UnlockCritFlag = 충족한 조건 비트(1 << (Rid-1)), UnlockCritOverride = 그 캐릭터의 조건 행 전체.
// 조건 종류(text_kr girl_unlock_condition_N): 1 X 호감도 3단계, 2 X 호감도 4단계, 3 장소 데이트 4점 이상, 4 구역 보스 클리어,
//   5 조건 완료 후 X 와 데이트, 6/7 월드 투어 랭크, 8 구역 P1 의 P2 레이스 클리어, 9 주간 레이스 컷오프.
//   10 한계 돌파한 히로인 N명 보유 (text_kr girl_unlock_condition_n_count, 클라이언트 GirlUnlockConditionCell case 10).
//   구현: 1·2·4·8, 5(데이트 종료 시 나머지 조건이 모두 충족돼 있으면 충족. 그 데이트로 조건 2가 채워져도 같은 데이트가 5로 인정됨 —
//   실기록 2026-11-13 20501). 충족 비트는 노드 GirlInfo.UnlockCritFlag 에 누적.
//   2026-11-06 추가 (실기록 없음, 클라이언트 표시 코드 기준):
//     6/7: 지금까지 도달한 최고 월드 투어 티어(snap.wtBestTier 또는 현재 RankTier)가 골드(3)/플래티넘(2) 이상. 티어 번호 5 브론즈 … 2 플래티넘.
//     9: 리그 = Parameter1 + vconst UnlockCrit9Offset(표 0, 없으면 클라이언트 기본 2), 컷오프 = battleTable.CutoffTime[시즌 % WeeklyRaceReward 마지막 Week]
//        .Track(리그 1) / Track<리그>. 이번 시즌 내 최고 기록(익스퍼트 이상은 하위 레이스 WRaceChild 합산)이 컷오프 이하면 충족.
//        Parameter2(30·40)는 클라이언트가 쓰지 않아 뜻 미확인 -> 무시 (추정).
//     10: 기본 등급(girlTable Rarity)보다 등급이 오른 보유 히로인 수 >= Parameter1.
//   미충족으로 보는 것: 3 (데이터에 쓰임 없음).
import { table, girlFamLevel } from './gamecalc.js';
import { newGirlRecord, ensureGirl } from './handlers/girls.js';
import { weeklySeason, wraceTemplate } from './handlers/weekly.js';

let crits: Map<number, any[]> | null = null;
function critsByGirl(): Map<number, any[]> {
  if (!crits) {
    crits = new Map();
    for (const c of table('girlTable.json')?.GirlUnlockCrit ?? []) {
      const id = Number(c.Girlid);
      if (!crits.has(id)) crits.set(id, []);
      crits.get(id)!.push(c);
    }
  }
  return crits;
}

/** 그 캐릭터를 여는 캐릭터 레이스(battleTable BattleArea Race, RaceType 7, GirlId)가 있는가. 20501·20502 는 없다. */
let girlRaceIds: Set<number> | null = null;
function hasGirlRace(gid: number): boolean {
  if (!girlRaceIds) {
    girlRaceIds = new Set();
    for (const a of table('battleTable.json')?.BattleArea ?? []) for (const r of a.Race ?? []) if (Number(r.RaceType) === 7 && r.GirlId) girlRaceIds.add(Number(r.GirlId));
  }
  return girlRaceIds.has(Number(gid));
}

const zoneOfArea = (snap: any, area: number) => (snap.RaceZones?.RaceZone ?? []).find((z: any) => Number(z.ZoneId) === area - 50000);
const raceWon = (snap: any, area: number, idx: number) =>
  (zoneOfArea(snap, area)?.Race ?? []).some((r: any) => Number(r.RaceIndex) === idx && Number(r.State) & 16);

const vconstNum = (name: string, def: number): number => {
  const r = (table('vconstTable.json')?.Vconst ?? []).find((x: any) => x?.Name === name);
  const v = Number(r?.Dval ?? r?.Val?.[0]);
  return r && Number.isFinite(v) ? v : def;
};
/** 지금까지 도달한 가장 높은 월드 투어 티어 (숫자가 작을수록 높음, 6 = 언랭크). */
export function wtBestTier(snap: any): number {
  const cur = Number(snap.MyWorldTour?.RankTier) || 6;
  return Math.min(cur >= 1 ? cur : 6, Number(snap.wtBestTier) || 6);
}
/** 조건 9: 주간 레이스 리그 컷오프 통과 (클라이언트 GirlUnlockConditionCell case 9 와 같은 표 계산). */
function weeklyCutoffPassed(snap: any, p1: number): boolean {
  const league = p1 + Math.trunc(vconstNum('UnlockCrit9Offset', 2));
  const bt = table('battleTable.json') ?? {};
  const rw: any[] = bt.WeeklyRaceReward ?? [];
  const lastWeek = rw.length ? Number(rw[rw.length - 1].Week) : 0;
  const season = weeklySeason().id;
  const idx = lastWeek ? season % lastWeek : -1;
  const row = idx >= 0 && idx < 8 ? (bt.CutoffTime ?? [])[idx] : null;
  const cutoff = Number(row?.[league === 1 ? 'Track' : `Track${league}`]) || 0;
  if (!cutoff) return false;
  const best: Record<string, number> = snap.wraceBest?.season === season ? (snap.wraceBest.best ?? {}) : {};
  const w = (wraceTemplate().WRace ?? []).find((x: any) => Number(x.WRaceId) === league);
  const kids: number[] = Array.isArray(w?.WRaceChild) ? w.WRaceChild.map(Number) : [];
  const rec = kids.length ? (kids.every((k) => Number(best[k]) > 0) ? kids.reduce((s, k) => s + Number(best[k]), 0) : 0) : Number(best[league]) || 0;
  return rec > 0 && rec <= cutoff;
}
/** 조건 10: 기본 등급보다 등급이 오른(한계 돌파한) 보유 히로인 수. */
function rankedUpGirls(snap: any): number {
  const defs: any[] = table('girlTable.json')?.Girl ?? [];
  return (snap.MyGirls?.MyGirlInfo ?? []).filter((g: any) => Number(g.State) === 7
    && Number(g.Rarity) > (Number(defs.find((d: any) => Number(d.Id) === Number(g.Girlid))?.Rarity) || 1)).length;
}

function critMet(snap: any, c: any): boolean {
  const p1 = Number(c.Parameter1), p2 = Number(c.Parameter2);
  const girl = (id: number) => (snap.MyGirls?.MyGirlInfo ?? []).find((g: any) => Number(g.Girlid) === id && Number(g.State) === 7);
  switch (Number(c.CritType)) {
    case 1: { const g = girl(p1); return !!g && girlFamLevel(g) >= 3; }
    case 2: { const g = girl(p1); return !!g && girlFamLevel(g) >= 4; }
    case 4: return raceWon(snap, p1, 20);
    case 8: return raceWon(snap, p1, p2);
    case 6: return wtBestTier(snap) <= 3;
    case 7: return wtBestTier(snap) <= 2;
    case 9: return weeklyCutoffPassed(snap, p1);
    case 10: return rankedUpGirls(snap) >= p1;
    default: return false;
  }
}

/** 해금 조건 재평가. datedGirl: 방금 데이트를 마친 캐릭터(조건 5). 바뀐 관계도 노드와 (존별) 캐릭터 레이스를 돌려준다. */
export function evalGirlUnlocks(snap: any, datedGirl?: number): { nodes: any[]; races: Map<number, any[]> } {
  const nodes: any[] = [];
  const races = new Map<number, any[]>();
  const gnodes: any[] = snap.Ggraph?.Gnode ?? [];
  for (const [gid, list] of critsByGirl()) {
    const node = gnodes.find((n) => Number(n.GirlInfo?.Girlid) === gid);
    if (!node || Number(node.State) === 7) continue;
    if ((snap.MyGirls?.MyGirlInfo ?? []).some((g: any) => Number(g.Girlid) === gid && Number(g.State) === 7)) continue;
    const bit = (c: any) => 1 << (Number(c.Rid) - 1);
    let flag = Number(node.GirlInfo?.UnlockCritFlag) || 0;
    if (Number(node.State) < 5) flag = 0;
    for (const c of list) if (Number(c.CritType) !== 5 && critMet(snap, c)) flag |= bit(c);
    for (const c of list) {
      if (Number(c.CritType) !== 5 || Number(c.Parameter1) !== Number(datedGirl)) continue;
      if (list.every((o) => o === c || flag & bit(o))) flag |= bit(c);
    }
    const all = list.every((c) => flag & (1 << (Number(c.Rid) - 1)));
    // 캐릭터 레이스(BattleArea RaceType 7)가 없는 캐릭터(20501·20502)는 조건을 다 채우면 바로 열린다 (State 7, 보유 목록에 추가).
    //   실기록 2026-11-13 05:59 20501: 20403 호감도 7772 -> 8002(4단계)로 만든 데이트 하나가 조건 2와 5를 함께 채움 ->
    //   데이트 결과 GgraphPatch 노드 24 State 7, GirlInfo {신규 레코드, Familiarity 0, NextCoin 400(100 x Rarity 4),
    //   NextFamiliarityTime 지금+12시간, UnlockCritFlag 7}. UnlockCritOverride 없음. 다음 로그인 MyGirlInfo 에 State 7 로 나옴.
    if (all && !hasGirlRace(gid)) {
      const g = ensureGirl(snap, gid);
      Object.assign(g, { Familiarity: 0, NextCoin: 100 * (Number(g.Rarity) || 1), State: 7,
        NextFamiliarityTime: Math.floor(Date.now() / 1000) + 12 * 3600, UnlockCritFlag: flag });
      delete g.UnlockCritOverride; // 실기록: 잠긴 동안 MyGirlInfo 에 있던 State 5 레코드에서 빠진다
      node.State = 7;
      node.GirlInfo = g;
      nodes.push(node);
      continue;
    }
    const state = all ? 6 : flag ? 5 : Number(node.State) || 4;
    // 로그인 데이터의 미개방 노드 GirlInfo 는 {Girlid} 뿐이다: 저장된 플래그가 없으면 상태가 같을 때 바뀐 것으로 보지 않는다
    const stored = node.GirlInfo?.UnlockCritFlag;
    if (state === Number(node.State) && (stored === undefined || flag === Number(stored))) continue;
    if (state === 4) continue;
    const base = newGirlRecord(gid);
    node.State = state;
    node.GirlInfo = {
      ...base, Familiarity: 0, NextCoin: 100 * (Number(base.Rarity) || 1), State: state,
      NextFamiliarityTime: Math.floor(Date.now() / 1000) + 12 * 3600,
      UnlockCritFlag: flag, UnlockCritOverride: list.map((c) => ({ ...c })),
    };
    nodes.push(node);
    for (const z of snap.RaceZones?.RaceZone ?? []) {
      const r = (z.Race ?? []).find((x: any) => Number(x.UnlockGirlInfo?.Girlid) === gid);
      if (!r) continue;
      r.UnlockGirlInfo = { Girlid: gid, State: state };
      r.State = state === 6 ? 1 : 8;
      const k = Number(z.ZoneId);
      if (!races.has(k)) races.set(k, []);
      races.get(k)!.push(r);
    }
  }
  return { nodes, races };
}
