// 업적(MyMemorySet, achievementTable.json). 실서버 기록(2026-11-01~02, 59건의 MsgNotifyEvent Memoryset)으로 맞춘 규칙.
//
// 레코드 {Id, Count, State}: State 1 진행 중, 2 달성(수령 가능), 3 보상 수령. (클라이언트는 4 도 완료로 본다: 공유 추정)
//   - 같은 Condition 의 단계(1001~1005 등)는 진행값이 처음 0 보다 커질 때 한꺼번에 생기고 같은 Count 를 가진다.
//   - 목표(Value1) 에 닿은 단계는 State 2, Count = 목표값으로 고정. 이후 그 레코드는 바뀌지 않는다.
//   - Value2 가 대상(구역·등급·차종·캐릭터)인 조건(102·103·113·202·203·308)은 대상마다 따로 생기고 Count 0/1.
// 진행 알림: 바뀐 레코드만 MsgNotifyEvent {Memoryset:{Memory:[...]}} 로 응답의 첫 메시지 뒤에 붙인다 (Id 오름차순).
//
// 조건별 진행(기록 근거 / 추정 표시):
//   101 레이스 승리 +1            105 PerfectStart(승리 시) +1      108 NitroUseNum 합 (패배 포함, 기록)
//   106 LinearMaxSpeed 최대(버림) 107 CornerMaxSpeed 최대(버림)
//   102 구역 보스 처치(보스 레이스 승리 비트)  103 보스 처치 시 그 구역 모든 레이스 ClearRec.Grade 1(S) (추정: 기록은 모두 S)
//   201 차량 획득 대수 +n (새 Carid)  202 그 등급 차량 획득(추정)  203 그 차종 획득(추정)
//   204 차량 강화 +1   205 강화 UpgradeSuccess +1   208 부품 강화(조합) +1
//   302 데이트 결과(DateResult) 가 Value2 인 데이트 +1   303 연락처 수(데이트 1회 이상 + 캐릭터 레이스 획득)   304 CG 수(추정: 기록상 히로인 수와 같이 증가)
//   309 히로인 의상(GirlItems) 수   401 플레이어 레벨   402 획득 코인 누계 (응답 전후 코인 증가분; 소비와 같은 요청이면 순증가만)
// 미구현(진행 없음): 104 Crazy 승리, 109 주간 레이스 아이템, 110 월드 투어, 113, 206 차량 조합, 207, 209, 301, 305, 306, 308, 403~407.
import { table, carDefOf } from './gamecalc.js';

type Ach = { Index: number; Condition: number; Value1?: number; Value2?: number; RewardIndex?: number; RewardValue?: number };
let defs: Ach[] | null = null;
export function achDefs(): Ach[] {
  if (!defs) defs = (table('achievementTable.json')?.Achievements ?? []) as Ach[];
  return defs;
}
let rg: Set<number> | null = null;
function girlRaceIds(): Set<number> {
  if (!rg) rg = new Set((table('battleTable.json')?.BattleArea ?? []).flatMap((a: any) => (a.Race ?? [])
    .filter((r: any) => Number(r.RaceType) === 7 && r.GirlId).map((r: any) => Number(r.GirlId))));
  return rg;
}
const TARGETED = new Set([102, 103, 113, 202, 203, 308]);

export interface AchBefore { coin: number; carIds: Set<number>; mailIds: Set<number> }
export function achBefore(snap: any): AchBefore | null {
  if (!snap) return null;
  return { coin: Number(snap.UserInfo?.Coin) || 0, carIds: new Set((snap.Cars?.CarInfo ?? []).map((c: any) => Number(c.Carid))),
    mailIds: new Set((snap.MailBox?.Mail ?? []).map((m: any) => Number(m.MailId))) };
}

const mem = (snap: any): any[] => { snap.MyMemorySet ??= { Memory: [] }; return (snap.MyMemorySet.Memory ??= []); };

/** 조건 cond 의 진행값을 갱신. value(prev) 가 새 Count. 바뀐 레코드를 changed 에 넣는다. */
function apply(snap: any, cond: number, value: (prev: number) => number, changed: Map<number, any>, target?: number) {
  const list = mem(snap);
  const tiers = achDefs().filter((a) => a.Condition === cond && (!TARGETED.has(cond) || target === undefined || Number(a.Value2) === target));
  if (!tiers.length) return;
  const recs = tiers.map((a) => list.find((x) => Number(x.Id) === a.Index));
  const prevOpen = recs.find((r) => r && Number(r.State) === 1);
  const prev = prevOpen ? Number(prevOpen.Count) || 0 : Math.max(0, ...recs.map((r) => Number(r?.Count) || 0));
  const next = value(prev);
  if (next === prev && recs.every(Boolean)) return;
  if (next <= 0 && !recs.some(Boolean)) return;
  tiers.forEach((a, i) => {
    let r = recs[i];
    if (r && Number(r.State) !== 1) return;
    const goal = Number(a.Value1) || 1;
    if (!r) { r = { Id: a.Index, Count: 0, State: 1 }; list.push(r); }
    const c = Math.min(next, goal);
    const st = next >= goal ? 2 : 1;
    if (r.Count !== c || r.State !== st || !recs[i]) { r.Count = c; r.State = st; changed.set(a.Index, r); }
  });
}

/** 요청 처리 후 호출: 업적 진행을 반영하고 알림 메시지를 붙인다. 반환: 바뀐 것이 있으면 true (스냅샷 저장 필요). */
export function achAfter(snap: any, before: AchBefore, name: string, req: any, messages: { name: string; body: any }[]): boolean {
  if (!snap) return false;
  const changed = new Map<number, any>();
  const ui = snap.UserInfo ?? {};
  const ok = messages[0]?.body?.Result === undefined || Number(messages[0]?.body?.Result) === 1;

  if (name === 'MsgBattleResultReq' && ok) {
    const win = !!req?.IsPlayerWin;
    if (win) apply(snap, 101, (p) => p + 1, changed);
    if (win && req?.PerfectStart) apply(snap, 105, (p) => p + 1, changed);
    const lin = Math.floor(Number(req?.LinearMaxSpeed) || 0), cor = Math.floor(Number(req?.CornerMaxSpeed) || 0);
    if (lin > 0) apply(snap, 106, (p) => Math.max(p, lin), changed);
    if (cor > 0) apply(snap, 107, (p) => Math.max(p, cor), changed);
    const n = Number(req?.NitroUseNum) || 0;
    if (n > 0) apply(snap, 108, (p) => p + n, changed);
  }
  if (name === 'MsgUpgradeCarReq' && ok) {
    apply(snap, 204, (p) => p + 1, changed);
    if (messages[0]?.body?.UpgradeSuccess) apply(snap, 205, (p) => p + 1, changed);
  }
  if (name === 'MsgCombinePartsReq' && ok) apply(snap, 208, (p) => p + 1, changed);
  for (const m of messages) {
    const r = Number(m.body?.DateReward?.DateResult);
    if (r) for (const a of achDefs()) if (a.Condition === 302 && Number(a.Value2) === r) { apply(snap, 302, (p) => p + 1, changed); break; }
  }

  // 상태형
  for (const z of snap.RaceZones?.RaceZone ?? []) {
    const zid = Number(z.ZoneId);
    const races: any[] = z.Race ?? [];
    // 저장된 RaceZone 에는 BossCleared 가 없다: 보스(RaceIndex 20) State 승리 비트(16)로 판단
    if (!races.some((r) => Number(r.RaceIndex) === 20 && Number(r.State) & 16)) continue;
    if (!achDefs().some((a) => (a.Condition === 102 || a.Condition === 103) && Number(a.Value2) === zid)) continue;
    apply(snap, 102, () => 1, changed, zid);
    const main = races.filter((r) => Number(r.RaceIndex) <= 20); // 본편 11~20 (캐릭터 레이스 21+ 제외, 추정)
    if (main.every((r) => Number(r.ClearRec?.Grade) === 1)) apply(snap, 103, () => 1, changed, zid);
  }
  // 303 연락처: 데이트를 1회 이상 한 캐릭터 + 캐릭터 레이스로 얻은 캐릭터 (기록: 관계도로 열리기만 한 20102 는 세지 않음)
  const raceGirls = girlRaceIds();
  const girls = (snap.MyGirls?.MyGirlInfo ?? []).filter((g: any) => Number(g.State) === 7
    && (Number(g.NthDate) > 0 || raceGirls.has(Number(g.Girlid)))).length;
  if (girls) { apply(snap, 303, () => girls, changed); apply(snap, 304, () => girls, changed); }
  const dresses = (snap.GirlItems?.GirlItemInfo ?? []).length;
  if (dresses) apply(snap, 309, () => dresses, changed);
  const lv = Number(ui.Charlevel) || 0;
  if (lv) apply(snap, 401, () => lv, changed);

  // 증가분
  const earned = (Number(ui.Coin) || 0) - before.coin;
  if (earned > 0) apply(snap, 402, (p) => p + earned, changed);
  const newCars = (snap.Cars?.CarInfo ?? []).filter((c: any) => !before.carIds.has(Number(c.Carid)));
  if (newCars.length) {
    apply(snap, 201, (p) => p + newCars.length, changed);
    for (const c of newCars) {
      const g = Number(c.Grade) || Number(carDefOf(c.Cartype)?.Grade) || 0;
      if (achDefs().some((a) => a.Condition === 202 && Number(a.Value2) === g)) apply(snap, 202, () => 1, changed, g);
      if (achDefs().some((a) => a.Condition === 203 && Number(a.Value2) === Number(c.Cartype))) apply(snap, 203, () => 1, changed, Number(c.Cartype));
    }
  }

  const seq = Number(messages[0]?.body?.Seq) || 0;
  let at = Math.min(1, messages.length);
  if (changed.size) {
    messages.splice(at++, 0, {
      name: 'MsgNotifyEvent',
      body: { Seq: seq + 1, Memoryset: { Memory: [...changed.values()].sort((a, b) => a.Id - b.Id).map((r) => ({ ...r })) } },
    });
  }
  // 새 우편(레벨 보상 등): MsgNotifyEvent {MailBox: 현재 우편함 전체} 를 업적 알림 뒤에 (실기록 4건: 레벨 3·4·5 보상)
  const newMail = (snap.MailBox?.Mail ?? []).some((m: any) => !before.mailIds.has(Number(m.MailId)));
  if (newMail && !messages.some((m) => m.body?.MailBox)) messages.splice(at, 0, { name: 'MsgNotifyEvent', body: { Seq: seq + 2, MailBox: snap.MailBox } });
  return changed.size > 0;
}
