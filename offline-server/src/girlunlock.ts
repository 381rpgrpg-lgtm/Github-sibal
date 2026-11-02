// 캐릭터 연락처 해금 조건 (girlTable.json GirlUnlockCrit). 실기록 2026-11-02 존 3:
//   3-13 승리 -> 20405(조건 1개: 8 [50003,13]) 모두 충족 -> 관계도 노드·GirlInfo State 6, 캐릭터 레이스 3-25 State 1 + UnlockGirlInfo {Girlid, State 6}
//   3-14 승리 -> 20104(조건 3개 중 Rid 2 충족) -> State 5, UnlockCritFlag 2, 레이스 3-26 은 State 8 그대로 + UnlockGirlInfo {State 5}
//   GirlInfo: 신규 레코드 + Familiarity 0, NextCoin 100 x Rarity, NextFamiliarityTime 지금+12시간,
//             UnlockCritFlag = 충족한 조건 비트(1 << (Rid-1)), UnlockCritOverride = 그 캐릭터의 조건 행 전체.
// 조건 종류(text_kr girl_unlock_condition_N): 1 X 호감도 3단계, 2 X 호감도 4단계, 3 장소 데이트 4점 이상, 4 구역 보스 클리어,
//   5 조건 완료 후 X 와 데이트, 6/7 월드 투어 랭크, 8 구역 P1 의 P2 레이스 클리어, 9 주간 레이스 컷오프.
//   구현: 1·2·4·8, 5(데이트 종료 시 나머지 조건이 모두 충족돼 있으면 충족). 충족 비트는 노드 GirlInfo.UnlockCritFlag 에 누적.
//   미충족으로 보는 것: 3·6·7·9·10 (월드 투어·주간 레이스 미구현, 3·10 은 데이터에 쓰임 없음/의미 미확인).
import { table, famLevel } from './gamecalc.js';
import { newGirlRecord } from './handlers/girls.js';

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

const zoneOfArea = (snap: any, area: number) => (snap.RaceZones?.RaceZone ?? []).find((z: any) => Number(z.ZoneId) === area - 50000);
const raceWon = (snap: any, area: number, idx: number) =>
  (zoneOfArea(snap, area)?.Race ?? []).some((r: any) => Number(r.RaceIndex) === idx && Number(r.State) & 16);

function critMet(snap: any, c: any): boolean {
  const p1 = Number(c.Parameter1), p2 = Number(c.Parameter2);
  const girl = (id: number) => (snap.MyGirls?.MyGirlInfo ?? []).find((g: any) => Number(g.Girlid) === id && Number(g.State) === 7);
  switch (Number(c.CritType)) {
    case 1: { const g = girl(p1); return !!g && famLevel(p1, Number(g.Familiarity) || 0) >= 3; }
    case 2: { const g = girl(p1); return !!g && famLevel(p1, Number(g.Familiarity) || 0) >= 4; }
    case 4: return raceWon(snap, p1, 20);
    case 8: return raceWon(snap, p1, p2);
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
