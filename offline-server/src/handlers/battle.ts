// 스토리 레이스(에피소드) 시작/결과. 형식은 실서버 기록(data/recorded, 2026-11-01 레이스 1-2)을 기준으로 맞췄다.
//
// 확인된 규칙 (근거)
//  - 레이스 State 비트: 플레이가능 1, 클리어 2, 실패 4, 잠김 8, 승리 16          (클라이언트 enum)
//      패배 1 -> 5 (기록), 1-1 승리 상태 17 (시드)
//  - 연료: Fuelvalue=최대, Fueltime=가득 차는 시각. 연료 1 = fuelFillTime(15)초.  (클라이언트 fuelState, 기록 +300s)
//  - 튜토리얼 비트(UserInfo.Completion): 시작 시 InformationFirstGirl(512), 패배 시 LoseRace(268435456) (기록)
//  - 패배: XP = floor((RewardXP+1)*0.3) (아래 주석), 코인 0, 동승 캐릭터 친밀도 +RewardFamiliarity   (기록 42 -> 12, +10)
//  - 숙련도: 패배 +1, 승리 +2 (MasteryCapacity 까지), 1씩 MasteryAttr 가장 낮은 능력치(동률이면 앞쪽)에 (기록 3->5, {1,1,1,0}->{2,1,1,1})
//  - 승리 (기록 2026-11-01 1-2, State 5 -> 18): State = CLEAR|WIN (PLAYABLE·FAIL 해제). CLEAR 는 '보상 미수령' 표시로,
//      MsgRaceRewardReq 에서 CLEAR 를 지우고 PLAYABLE 을 켠다(18 -> 17). StateHard 8 -> 1.
//      RaceCoin = BaseCoin(RewardCoin) x CoinRatio(1), XP = RewardXP 전액, 친밀도 +RewardFamiliarity, DQUEST_RACE +1.
//      다음 레이스(잠김 8)는 State 1 로 바꿔 RaceZone.NewRace 로 보낸다. Progress +10, DeltaProgress 10.
//  - 등급 보상: Race.ClearRec {Grade, Flag(최고 등급 비트 S1 A2 B4 C8 D16), Bonus(받은 S/A/B 보너스 비트 1|2|4)}
//      최상위 ClearRec {Grade, Flag(이번에 새로 받은 보너스 S64 A128 B256), RewardInfo}. 결과 화면은 Flag&65/130/260 으로 체크 표시.
//      기록: 첫 S 클리어 = S·A·B 보너스 동시 → 코인 1600 + 캐시 2 (RewardInfo.Coin 2200 = 600 + 1600).
// 등급 판정: S 미스·배드 0, A 미스 0 (기록 3-15: 배드 1 -> A), B 그 외(추정). 보너스를 하나씩 받을 때의 금액 배분은 추정.
import { readFileSync, existsSync } from 'node:fs';
import { readTable } from '../upserts.js';
import { register, type Msg, type Ctx } from '../rpc.js';
import { grantItem } from '../inventory.js';
import { ensureGirl, newGirlRecord } from './girls.js';
import { evalGirlUnlocks } from '../girlunlock.js';
import { refreshQuests, questEvent } from '../quests.js';
import { isEventZone, eventStart, eventResult, eventReward } from './event.js';
import { weeklyStart, weeklyResult } from './weekly.js';
import { worldTourStart, worldTourResult } from './worldtour.js';
import { table as gtable, areaOf, areaRace, finalAttr, makeOpponent, newOwnedCar, randomPart, grantPart, carDefOf, relativeDifficulty, syncGirl, girlDef } from '../gamecalc.js';
import { ridePeevish } from '../peevish.js';

const ST = { PLAYABLE: 1, CLEAR: 2, FAIL: 4, LOCKED: 8, WIN: 16 } as const;
function timeAttackScript(zoneId: number, kind: 'Start' | 'Win'): string | null {
  const zz = String(zoneId).padStart(2, '0');
  const names = [...new Set(((table('girlMemoryTable.json')?.StoryCollection ?? []) as any[])
    .map((m) => String(m.ScriptName ?? '')).filter((n) => new RegExp(`^EP${zz}\\d\\dTimeattack${kind}$`).test(n)))];
  return names.length === 1 ? names[0] : null;
}
const TUT_INFO_FIRST_GIRL = 512;
const TUT_FIRST_SELECT = 256;
const TUT_LOSE_RACE = 268435456;
const FUEL_FILL_SEC = 15;

const tables = new URL('../../data/tables/', import.meta.url).pathname;
const cache: Record<string, any> = {};
function table(name: string) {
  if (!(name in cache)) cache[name] = readTable(tables + name, name); // content.json 표 패치 적용
  return cache[name];
}
let trackById: Map<number, any> | null = null;
function track(id: number) {
  if (!trackById) {
    trackById = new Map();
    for (const t of table('trackTable.json')?.Track ?? []) trackById.set(Number(t.TrackId), t);
  }
  return trackById.get(Number(id)) ?? null;
}

function findRace(snap: any, zoneId: number, raceId: number) {
  const zone = (snap.RaceZones?.RaceZone ?? []).find((z: any) => Number(z.ZoneId) === Number(zoneId));
  const race = zone?.Race?.find((r: any) => Number(r.RaceId) === Number(raceId));
  return { zone, race };
}

function currentCar(snap: any) {
  return (snap.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(snap.UserInfo?.Currentcar)) ?? null;
}

const now = () => Date.now() / 1000;

/** 현재 연료 (클라이언트 fuelState 와 동일 공식) */
export function fuelNow(ui: any): number {
  const max = Math.trunc(Number(ui.Fuelvalue) || 0);
  const left = (Number(ui.Fueltime) || 0) - now();
  return left > 0 ? Math.max(max - Math.ceil(left / FUEL_FILL_SEC), 0) : max;
}
// 보너스 연료(UserInfo.Fuelbonus, 최대치를 넘는 연료: 연료 상자를 가득 찬 상태에서 쓰면 쌓인다)를 먼저 쓴다.
//   실기록 2026-11-05: 보너스 215 -> 180 -> 145 -> 110 -> 75 (레이스마다 FuelConsume 35), 그동안 Fuelvalue·Fueltime 그대로.
function spendFuel(ui: any, amount: number) {
  const bonus = Math.max(0, Number(ui.Fuelbonus) || 0);
  const fromBonus = Math.min(bonus, amount);
  if (fromBonus > 0) ui.Fuelbonus = bonus - fromBonus;
  const rest = amount - fromBonus;
  if (rest > 0) ui.Fueltime = Math.max(Number(ui.Fueltime) || 0, now()) + rest * FUEL_FILL_SEC;
}

/** PropertySet.Property[] 의 Nvalue 증가 (일일 미션 카운터). vconstTable <이름>_MAX 가 있으면 그 값에서 멈춘다
 *  (DQUEST_RACE 3, DQUEST_DATE 3, DQUEST_PARTSUP 1). 반환: 값이 바뀌었으면 true.
 *  실기록: 응답 PropertySet 은 값이 바뀐 요청에만 실린다 (4번째 승리·2번째 강화 응답에는 없음). */
export function bumpProperty(snap: any, name: string, by: number): boolean {
  snap.PropertySet ??= { Property: [] };
  snap.PropertySet.Property ??= [];
  const maxRow = (table('vconstTable.json')?.Vconst ?? []).find((c: any) => c?.Name === `${name}_MAX`);
  const max = Number(maxRow?.Dval) || Infinity;
  let p = snap.PropertySet.Property.find((x: any) => x.PropertyName === name);
  if (!p) { p = { PropertyName: name, Nvalue: 0 }; snap.PropertySet.Property.push(p); }
  const prev = Number(p.Nvalue) || 0;
  p.Nvalue = Math.min(max, prev + by);
  // 일일 미션 3개(레이스·데이트·강화)가 모두 상한이면 DQUEST 1 -> 2 (실기록 2026-11-02: 세 번째 데이트 결과에서 2)
  if (name.startsWith('DQUEST_') && p.Nvalue !== prev) {
    const dq = snap.PropertySet.Property.find((x: any) => x.PropertyName === 'DQUEST');
    const vmax = (n: string) => Number((table('vconstTable.json')?.Vconst ?? []).find((c: any) => c?.Name === `${n}_MAX`)?.Dval) || 1;
    const done = ['DQUEST_RACE', 'DQUEST_DATE', 'DQUEST_PARTSUP'].every((n) =>
      Number(snap.PropertySet.Property.find((x: any) => x.PropertyName === n)?.Nvalue) >= vmax(n));
    if (dq && done && Number(dq.Nvalue) === 1) dq.Nvalue = 2; // 보상 수령 후 0 (실측)
  }
  return p.Nvalue !== prev;
}

// 레벨업. 기록(2026-11-01, 데이트 결과로 Lv1 -> 2): Charexp 는 다음 레벨 기준으로 다시 센다(214+27=241 -> Lv2, Charexp 5 = 241-236),
//   Fuelvalue = 새 레벨 Gasoline(418), Fueltime = 지금(연료 가득), UserInfo.LevelUp {Level, FuelMax, Coin 0, Cash 2},
//   우편 'Level reward' 61002(캐시) x2. 추정: 레벨마다 캐시 2.
export function levelUp(snap: any) {
  const ui = snap.UserInfo;
  const rows: any[] = (table('playerLevelTable.json')?.Level ?? []).filter((r: any) => r.Id);
  for (;;) {
    const cur = rows.find((r) => Number(r.Id) === Number(ui.Charlevel));
    const next = rows.find((r) => Number(r.Id) === Number(ui.Charlevel) + 1);
    if (!cur || !next || Number(ui.Charexp) < Number(cur.Exp)) break;
    ui.Charexp = Number(ui.Charexp) - Number(cur.Exp);
    ui.Charlevel = Number(ui.Charlevel) + 1;
    if (next.Gasoline) ui.Fuelvalue = Number(next.Gasoline);
    ui.Fueltime = now();
    // 레벨 보상 캐시: 평소 2, 10레벨에서 12 (실기록 2026-11-03 Lv10 1건. 10의 배수마다 +10 은 추정)
    const lvCash = ui.Charlevel % 10 === 0 ? 12 : 2;
    ui.LevelUp = { Level: ui.Charlevel, FuelMax: ui.Fuelvalue, Coin: 0, Cash: lvCash };
    snap.MailBox ??= { Version: 1, Mail: [], Count: 0 };
    snap.mailSeq = (Number(snap.mailSeq) || Math.max(0, ...snap.MailBox.Mail.map((m: any) => Number(m.MailId) || 0))) + 1;
    snap.MailBox.Mail.push({
      MailId: snap.mailSeq, MailType: 4, BoxType: 0, Itemnum: lvCash, Itemtype: 61002, Subject: 'Level reward',
      Content: `Player level ${ui.Charlevel} reached.`, ExpireTime: Math.floor(now()) + 7 * 86400,
    });
    snap.MailBox.Count = snap.MailBox.Mail.length;
  }
}

// 스토리 대본 이름 (실기록): 시작 EP<존2자리><순번2자리>Start (순번 = RaceIndex-10), 보스 EP<존>BossStart,
//   첫 승리 EP..Win / EP<존>BossWin. 대본 데이터가 없으면 클라이언트가 건너뛴다.
// 에피소드 대본 이름. girlMemoryTable StoryCollection 에 있는 이름만 보낸다 (실기록 2026-11-02: 대본이 없는 4-14·5-15·4-11 승리는
//   CallScript 없음, 있는 4-12·4-13·4-16 등은 있음). 타임어택(RaceMode 2) 캐릭터 레이스는 EP<존><nn>Timeattack<kind> (4-25).
let storyNames: Set<string> | null = null;
const storyExists = (n: string) => (storyNames ??= new Set(((table('girlMemoryTable.json')?.StoryCollection ?? []) as any[]).map((x) => String(x.ScriptName)))).has(n);
const epName = (zone: number, race: any, kind: 'Start' | 'Win') => {
  const z = String(zone).padStart(2, '0');
  let name: string | null = null;
  if (race.Boss) name = `EP${z}Boss${kind}`;
  else if (Number(race.RaceMode) === 2) name = timeAttackScript(zone, kind);
  else { const n = Number(race.RaceIndex) - 10; if (n >= 1 && n <= 9) name = `EP${z}${String(n).padStart(2, '0')}${kind}`; }
  return name && storyExists(name) ? name : null;
};
const isGirlRace = (race: any) => !!race.UnlockGirlInfo || Number(areaRace(race.ZoneId, race.RaceIndex)?.RaceType) === 7;
const TUT_UNLOCK_RACE = 4096;

register('MsgBattleStartReq', (body, ctx: Ctx): Msg[] => {
  if (Number(body?.RaceType) === 3) return weeklyStart(body, ctx); // 주간 레이스 (weekly.ts)
  if (Number(body?.RaceType) === 4) return worldTourStart(body, ctx); // 월드 투어 (worldtour.ts)
  const snap = ctx.store.getUser(ctx.session.accountId);
  const { zone, race } = findRace(snap ?? {}, body?.ZoneId, body?.BattleId);
  const car = snap && currentCar(snap);
  if (!snap || !race || !car || race.State & ST.LOCKED) {
    return [{ name: 'MsgBattleStartAns', body: { Seq: 1, Result: 0, BattleId: body?.BattleId } }];
  }
  const ui = snap.UserInfo;
  const cost = Number(car.FuelConsume) || 20;
  const ev = isEventZone(body?.ZoneId);
  if (ev) { const fail = eventStart(snap, zone, race, car); if (fail) return fail; } // 이벤트: 연료 대신 입장권 (event.ts)
  else if (!ctx.cheat.enabled || !ctx.cheat.infiniteFuel) {
    if (fuelNow(ui) + Math.max(0, Number(ui.Fuelbonus) || 0) < cost) return [{ name: 'MsgBattleStartAns', body: { Seq: 1, Result: 0, UserInfo: ui } }];
    spendFuel(ui, cost);
  }
  if (Number(ui.Completion) & TUT_FIRST_SELECT) ui.Completion = Number(ui.Completion) | TUT_INFO_FIRST_GIRL;
  // 캐릭터 레이스 시작 시 UnlockRace 튜토리얼 비트 (실기록: 2-25 시작 응답에서 Completion |= 4096)
  if (isGirlRace(race)) ui.Completion = Number(ui.Completion) | TUT_UNLOCK_RACE;
  if (!ev) race.TryCount = (Number(race.TryCount) || 0) + 1; // 이벤트는 eventStart 에서
  // 니트로 아이템(60022 'Nitro_0'): 가지고 있으면 시작 응답 NitroReadyNum 1, 결과 때 1개 소모 (실기록 2026-11-02 3-5:
  //   시작 NitroReadyNum 1, 결과 최상위 ItemInfo {Itemid, Itemtype 60022, StackNum 0}). 한 번에 1개만 쓰는 것은 추정.
  const nitroItem = (snap.Items?.ItemInfo ?? []).find((x: any) => Number(x.Itemtype) === 60022 && Number(x.Count) > 0);
  const nitroReady = nitroItem ? 1 : 0;
  ctx.store.setMeta(`battle:${ctx.session.accountId}`, JSON.stringify({ zone: body.ZoneId, race: body.BattleId, level: body.RaceLevel ?? 1, at: now(), nitro: nitroReady }));
  ctx.store.putUser(ctx.session.accountId, snap);
  const forceWin = !!(ctx.cheat.enabled && ctx.cheat.forceWinBattles);
  const girlRace = isGirlRace(race);
  // 시작 대본은 아직 이기지 못한 레이스에만 (실기록: 이미 이긴 1-2 재도전 시작 응답에 CallScript 없음)
  // 타임어택(RaceMode 2, 실기록 4-25): 시작 응답에 OpponentCarInfo·ClosedTrack 없음, 첫 시도 대본 EP<존><nn>TimeattackStart
  //   (girlMemoryTable 에 그 존의 TimeattackStart 대본이 하나뿐일 때 그것을 쓴다. 번호 규칙은 미확인)
  const timeAttack = Number(race.RaceMode) === 2;
  const ep = ev || race.State & ST.WIN || (girlRace && !timeAttack) ? null : epName(Number(body.ZoneId), race, 'Start');
  const fa = finalAttr(girlRace ? { ...snap, UserInfo: { ...ui, PassengerGirl: -1 } } : snap, car);
  return [{
    name: 'MsgBattleStartAns',
    body: {
      Seq: 1, Result: 1, UserInfo: ui, NitroReadyNum: nitroReady, Passenger: girlRace ? -1 : ui.PassengerGirl ?? 0, GirlsSpecialSkill: [],
      RaceInfo: race, RaceType: body.RaceType ?? 1, ZoneId: body.ZoneId, BattleId: body.BattleId,
      // 시작 응답 Track = trackTable 전체 + (보스 외) ClosedTrack + Thema/LightingIndex (실기록 2-12, 2-20)
      Track: { ...(track(race.Track?.TrackId) ?? {}), ...(race.Boss || timeAttack || ev ? {} : { ClosedTrack: false }), Thema: race.Track?.Thema, LightingIndex: race.Track?.LightingIndex ?? 0,
        ...(ev && race.Track?.Reborn ? { Reborn: { ...(track(race.Track?.TrackId)?.Reborn ?? {}), ...race.Track.Reborn } } : {}) },
      MyCarInfo: { ...car, FinalAttr: fa },
      ...(timeAttack ? {} : { OpponentCarInfo: race.OpponentCarInfo }), Boss: Number(race.Boss) || 0, ForceWin: forceWin, MyPosition: 0,
      RaceLevel: body.RaceLevel ?? 1,
      // 이벤트: RelativeDifficulty 없음, RaceZone [{ZoneId, LeftTryCount, ExpireTime}] (기록 3103 시작 8건)
      ...(ev ? { RaceZone: [{ ZoneId: zone.ZoneId, LeftTryCount: zone.LeftTryCount, ExpireTime: zone.ExpireTime ?? 0 }] } : { RelativeDifficulty: relativeDifficulty(fa, race.OpponentCarInfo) }),
      ...(girlRace ? { NewGirl: Number(race.UnlockGirlInfo?.Girlid) } : {}),
      ...(ep ? { CallScript: [{ Name: ep, Girlid: 0, FmLevel: -1 }] } : {}),
      ReplaySeed: Math.floor(Math.random() * 2 ** 31),
    },
  }];
});

// 새로 열리는 레이스 준비: 첫 플레이 보상 표시(FirstPlayRewardItemID 가 있으면 true),
//   battleTable OpenQuestId 가 있고 그 퀘스트를 아직 보상 받지 않았으면 State 8 + LockQuestId (실기록 3-14, 퀘스트 10302 보상 시 열림),
//   레이스 칸 소액 보상 ItemInfo. 실기록: 존 2 [2-14 코인 90, 2-15 숙련도 2], 존 3 [3-12 도색 쿠폰 60035, 3-13 경기 티켓 60010,
//   3-14 코인 105, 3-15 숙련도 2], 존 1 과 각 존 첫 레이스는 없음. 출현 확률·종류 표는 미확인 -> 추정: 존 2 이상 첫 레이스 외 70%,
//   종류 균등, 코인 = 60 + 15 x 존.
const RACE_ITEMS = (zone: number) => [{ Itemtype: 61001, Count: 60 + 15 * zone }, { Itemtype: 61005, Count: 2 }, { Itemtype: 60035, Count: 1 }, { Itemtype: 60010, Count: 1 }];
function openRace(zoneId: number, race: any, snap?: any) {
  const ar = areaRace(zoneId, race.RaceIndex);
  race.State = ST.PLAYABLE;
  race.FirstPlayReward = !!ar?.FirstPlayRewardItemID;
  race.TryCount = Number(race.TryCount) || 0;
  const q = Number(ar?.OpenQuestId) || 0;
  if (q && snap && !(snap.NquestInfos?.NquestInfo ?? []).some((x: any) => Number(x.QuestId) === q && Number(x.State) === 7)) {
    race.State = ST.LOCKED; race.LockQuestId = q;
  }
  const first = Number(race.RaceIndex) === Math.min(...(areaOf(zoneId)?.Race ?? []).filter((r: any) => Number(r.RaceType) === 1).map((r: any) => Number(r.RaceIndex)));
  if (!race.Boss && !isGirlRace(race) && Number(zoneId) >= 2 && !first && Math.random() < 0.7) {
    const pool = RACE_ITEMS(Number(zoneId));
    race.ItemInfo = pool[Math.floor(Math.random() * pool.length)];
  }
}

/** 퀘스트 보상 수령으로 잠금이 풀리는 레이스 (LockQuestId). 바뀐 레이스를 존별로 돌려준다. (실기록 10302 -> 3-14 State 1, LockQuestId null) */
export function unlockQuestRaces(snap: any, questId: number): { ZoneId: number; ChangeRace: any[] }[] {
  const out: { ZoneId: number; ChangeRace: any[] }[] = [];
  for (const z of snap.RaceZones?.RaceZone ?? []) {
    const rs = (z.Race ?? []).filter((r: any) => Number(r.LockQuestId) === questId);
    // 알림에는 LockQuestId null, 저장 레코드에서는 필드를 지운다 (실기록: 이후 시작 응답의 RaceInfo 에 LockQuestId 없음)
    for (const r of rs) { r.State = ST.PLAYABLE; delete r.LockQuestId; }
    if (rs.length) out.push({ ZoneId: Number(z.ZoneId), ChangeRace: rs.map((r: any) => ({ ...r, LockQuestId: null })) });
  }
  return out;
}

// 존 해금 시 캐릭터 레이스(battleTable RaceType 7, GirlId) 생성. 실기록 존 3: RaceId 50<존><순번>, RewardCoin 0,
//   UnlockGirlInfo {Girlid}, State 8, 상대 = Difficulty 기준 차량, RewardXP = round(30 + Difficulty/20) (실기록 6건 일치), 순번 역순.
function ensureGirlRaces(zone: any): any[] {
  const out: any[] = [];
  const first = [...(zone.Race ?? [])].sort((a: any, b: any) => a.RaceIndex - b.RaceIndex)[0];
  const defs = [...(areaOf(zone.ZoneId)?.Race ?? [])].filter((ar: any) => Number(ar.RaceType) === 7 && ar.GirlId)
    .sort((a: any, b: any) => b.RaceIndex - a.RaceIndex);
  for (const ar of defs) {
    let r = zone.Race.find((x: any) => Number(x.RaceIndex) === Number(ar.RaceIndex));
    if (!r) {
      r = {
        RaceId: 5000000 + Number(zone.ZoneId) * 100 + Number(ar.RaceIndex), State: ST.LOCKED, StateHard: ST.LOCKED, StateVHard: ST.LOCKED,
        PosId: Number(ar.RacePos) || 1, ZoneId: zone.ZoneId, RaceLifeType: 1, RaceMode: 1, RaceIndex: Number(ar.RaceIndex),
        RewardCoin: 0, RewardXP: Math.round(30 + (Number(ar.Opponent?.Difficulty) || 400) / 20), RewardFamiliarity: 10,
        OpponentCarInfo: makeOpponent(Number(ar.Opponent?.Difficulty) || 400),
        Track: { TrackId: Number(ar.TrackId) || 99, Attrs: track(ar.TrackId)?.Attrs ?? {}, Thema: first?.Track?.Thema ?? 1, LightingIndex: 0 },
        FirstPlayReward: false, TryCount: 0, UnlockGirlInfo: { Girlid: Number(ar.GirlId) },
      };
      zone.Race.push(r);
    }
    out.push(r);
  }
  return out;
}

register('MsgBattleResultReq', (body, ctx: Ctx): Msg[] => {
  if (Number(body?.RaceType) === 3) return weeklyResult(body, ctx); // 주간 레이스 (weekly.ts)
  if (Number(body?.RaceType) === 4) return worldTourResult(body, ctx); // 월드 투어 (worldtour.ts)
  const snap = ctx.store.getUser(ctx.session.accountId);
  const { zone, race } = findRace(snap ?? {}, body?.ZoneId, body?.BattleId);
  const car = snap && currentCar(snap);
  if (!snap || !zone || !race || !car) return [{ name: 'MsgBattleResultAns', body: { Seq: 1, Result: 0 } }];
  if (isEventZone(zone.ZoneId)) return eventResult(body, ctx, snap, zone, race, car);
  const ui = snap.UserInfo;
  // 기권: 실클라이언트 withdrawRace 요청 {Withdraw:true, IsPlayerWin:false}. 실기록: 경험치 패배 몫, 친밀도 +, 기록 0.
  const withdraw = !!body.Withdraw;
  const win = !withdraw && (!!body.IsPlayerWin || !!(ctx.cheat.enabled && ctx.cheat.forceWinBattles));
  const girlRace = isGirlRace(race);
  const boss = !!race.Boss;
  const firstWin = win && !(race.State & ST.WIN);
  const zoneEntries: any[] = [];
  const main: any = { ZoneId: zone.ZoneId, ChangeRace: [race] };
  zoneEntries.push(main);

  // 코인: 기본(RewardCoin) + 남은 부스트 보상(LeftBoost x RewardCoin x 0.3, 실기록 1 x 180)
  const baseCoin = win ? Number(race.RewardCoin) || 0 : 0;
  const boostComp = win ? (Number(body.LeftBoost) || 0) * Math.trunc((Number(race.RewardCoin) || 0) * 0.3) : 0;
  const raceCoin = baseCoin + boostComp;

  // 등급 보너스 (실기록 12건: 처음 S = S·A·B 보너스 → 코인 1600 + 캐시 1. 보스·캐릭터 레이스는 0)
  let clearTop: any = null, bonusCoin = 0, bonusCash = 0;
  if (win) {
    const miss = Number(body.MissCnt) || 0, bad = Number(body.BadCnt) || 0;
    const grade = miss === 0 && bad === 0 ? 1 : miss === 0 ? 2 : 3; // 1=S 2=A 3=B (추정 기준: 기록은 모두 S)
    const prev = race.ClearRec ?? {};
    const earned = [1, 2, 4].filter((_, i) => i + 1 >= grade).reduce((a, b) => a | b, 0);
    const fresh = earned & ~(Number(prev.Bonus) || 0);
    // 실기록 2026-11-02: 첫 S(S·A·B) = 코인 1600 + 캐시 1 (4-11 등 10건), 첫 A(배드 1, A·B 만, Flag 384) = 코인 1600 + 캐시 0 (3-15)
    //   -> S 보너스 = 캐시 1, A+B = 코인 1600. A·B 를 따로 받을 때의 배분(800/800)은 추정.
    if (Number(race.RewardCoin) > 0) { bonusCoin = (fresh & 2 ? 800 : 0) + (fresh & 4 ? 800 : 0); bonusCash = fresh & 1 ? 1 : 0; }
    const bestBit = 1 << (grade - 1);
    const prevBest = Number(prev.Flag) || 0;
    race.ClearRec = {
      Grade: prevBest && prevBest < bestBit ? Number(prev.Grade) || grade : grade,
      Flag: prevBest && prevBest < bestBit ? prevBest : bestBit,
      Bonus: (Number(prev.Bonus) || 0) | earned,
    };
    clearTop = {
      // Flag: 이번에 새로 받은 보너스 S64 A128 B256, 새로 받은 게 없으면 이미 받은 보너스 비트(1|2|4) (실기록 1-2 재도전: 7)
      Grade: grade, Flag: fresh ? [64, 128, 256].filter((_, i) => fresh & (1 << i)).reduce((a, b) => a | b, 0) : Number(prev.Bonus) || 0,
      RewardInfo: { Coin: bonusCoin, Charexp: 0, Cash: bonusCash, Familiartity: 0, ItemInfo: [], CarInfo: [] },
    };
  }

  // 보스 보상 (실기록: 1-20 코인 2000 + 차량 10101, 2-20 코인 2100 + 차량 10201). 추정: 1900+100x존, ★1 차량 무작위.
  let bossCoin = 0;
  const rewardCars: any[] = [];
  if (win && boss && firstWin) {
    bossCoin = 1900 + 100 * Number(zone.ZoneId);
    const ones = (gtable('cars.json')?.Car ?? []).filter((c: any) => Number(c.Grade) === 1 && Number(c.Distribute) > 0);
    const pick = ones[Math.floor(Math.random() * ones.length)];
    if (pick && (snap.Cars?.CarInfo?.length ?? 0) < Number(ui.GarageSize || 6)) {
      const c = newOwnedCar(snap, Number(pick.Id));
      snap.Cars.CarInfo.push(c); rewardCars.push(c);
    }
  }

  // 일일 보상 레이스: DailyRewardTime 이 남아 있으면 승리 시 캐시 1, DailyRewardTime 0 (실기록 2026-11-02 1-2: RewardInfo.Cash 1,
  //   Race.DailyRewardTime 0, 등급 보너스 없음. 지도에서 지폐 아이콘으로 표시)
  if (win && Number(race.DailyRewardTime) > Date.now() / 1000) { bonusCash += 1; race.DailyRewardTime = 0; }
  // 니트로 아이템 소모 (시작 때 NitroReadyNum 1 이었으면)
  const resultItems: any[] = [];
  try {
    const meta = JSON.parse(ctx.store.getMeta(`battle:${ctx.session.accountId}`) || '{}');
    const it = meta.nitro && (snap.Items?.ItemInfo ?? []).find((x: any) => Number(x.Itemtype) === 60022 && Number(x.Count) > 0);
    if (it && !withdraw) {
      it.Count = Number(it.Count) - 1;
      resultItems.push({ Itemid: it.Itemid, Itemtype: 60022, StackNum: it.Count });
      if (it.Count <= 0) snap.Items.ItemInfo = snap.Items.ItemInfo.filter((x: any) => x !== it);
    }
  } catch { /* 메타 없음 */ }
  const coin = raceCoin + bonusCoin + bossCoin;
  ui.Cash = (Number(ui.Cash) || 0) + bonusCash;
  // 패배 XP: 실기록 3종 42->12, 81->24 (9건), 99->30 (16건). floor(x*0.3)·round(x*0.3) 는 각각 하나씩 어긋나고
  //   floor((x+1)*0.3) 이 셋 모두 맞는다 (공식 자체는 추정).
  const xp = win ? Number(race.RewardXP) || 0 : Math.floor(((Number(race.RewardXP) || 0) + 1) * 0.3);
  const passengerOn = !girlRace;
  const fam = passengerOn ? Number(race.RewardFamiliarity) || 0 : 0;
  ui.Coin = (Number(ui.Coin) || 0) + coin;
  ui.Charexp = (Number(ui.Charexp) || 0) + xp;
  delete ui.LevelUp;
  levelUp(snap);

  // 레이스 상태
  let deltaProgress = 0;
  const extra: any = {};
  const lockedUpdate: any[] = []; // 퀘스트 잠금으로 열린 레이스: 실기록은 MsgUpdateData 로도 보낸다
  if (win) {
    race.State = boss ? (race.State & ~(ST.FAIL | ST.PLAYABLE | ST.CLEAR)) | ST.WIN   // 보스: 16 (보상 수령 단계 없음)
      : (race.State & ~(ST.FAIL | ST.PLAYABLE)) | ST.CLEAR | ST.WIN;                    // 일반·캐릭터: 18
    if (Number(body.RaceLevel ?? 1) === 1 && race.StateHard & ST.LOCKED && !boss) race.StateHard = ST.PLAYABLE;
    // 보상 상자: 보스가 아닌 레이스 첫 승리 때 존 Box1 확률 (실기록 22건: 첫 플레이 보상 레이스 3-11, 캐릭터 레이스 3-25 에도 붙음)
    // 큰 상자(RewardBoxKind 2): 존 Box2 확률 (실기록 1건: 5-14). 두 확률을 한 번의 뽑기로 나누는 방식은 추정.
    if (firstWin && !boss) {
      const box = Math.random(), b2 = Number(areaOf(zone.ZoneId)?.Box2) || 0, b1 = Number(areaOf(zone.ZoneId)?.Box1) || 0;
      if (box < b2) race.RewardBoxKind = 2; else if (box < b2 + b1) race.RewardBoxKind = 1;
    }
    if (firstWin && !boss && !girlRace) {
      deltaProgress = 10;
      zone.Progress = (Number(zone.Progress) || 0) + deltaProgress;
      const order = [...zone.Race].filter((r: any) => !isGirlRace(r) && !r.Boss && Number(r.RaceIndex) < 20)
        .sort((a: any, b: any) => a.RaceIndex - b.RaceIndex);
      const next = order[order.indexOf(race) + 1] ?? zone.Race.find((r: any) => r.Boss);
      main.NewRace = [];
      if (next && next.State & ST.LOCKED) {
        openRace(zone.ZoneId, next, snap); main.NewRace.push(next);
        if (next.LockQuestId) lockedUpdate.push({ ZoneId: zone.ZoneId, ChangeRace: [next] });
      }
      main.Progress = zone.Progress; main.DeltaProgress = deltaProgress;
    }
    // 재승리: 주 구역 항목에도 NewRace [], Progress, DeltaProgress 0 (실기록 1-2 재도전)
    if (!firstWin && !boss && !girlRace) { main.NewRace = []; main.Progress = zone.Progress; main.DeltaProgress = 0; }
    if (firstWin && girlRace) {
      // 캐릭터 해금 (실기록 2-25: UnlockGirlInfo 전체, NewGirl, GgraphPatch, DelRace, Completion |= 4096)
      const gid = Number(race.UnlockGirlInfo?.Girlid ?? areaRace(zone.ZoneId, race.RaceIndex)?.GirlId);
      const g = ensureGirl(snap, gid);
      Object.assign(g, { Familiarity: 0, NextCoin: 100, UnlockCritFlag: 1 });
      race.UnlockGirlInfo = { Girlid: gid, State: 6 };
      const node = (snap.Ggraph?.Gnode ?? []).find((n: any) => Number(n.GirlInfo?.Girlid) === gid);
      if (node) { node.State = 7; node.GirlInfo = g; }
      extra.UnlockGirlInfo = g; extra.NewGirl = gid; extra.GgraphPatch = { Gnode: node ? [node] : [] };
      main.NewRace = []; main.Progress = zone.Progress; main.DeltaProgress = 0;
      zoneEntries.push({ ZoneId: zone.ZoneId, DelRace: [structuredClone(race)] });
      zone.Race = zone.Race.filter((r: any) => r !== race);
    }
    if (firstWin && boss) {
      main.NewRace = []; main.BossCleared = true; main.Progress = zone.Progress; main.DeltaProgress = 0;
      // 실기록: 에피소드 2 보스 클리어 응답에서 SystemOpenFlag 4096 -> 4097 (주간 레이스 개방 WRaceOpen=3 시점과 일치, 의미는 추정)
      // 실기록: 에피소드 1 보스 클리어 응답에서 Completion 에 EpisodeProgress(2097152)
      //   + RecommendFriend(16) (친구 기능 개방, 실기록 diag6 1-20)
      if (Number(zone.ZoneId) === 1) ui.Completion = Number(ui.Completion) | 2097152 | 16;
      if (Number(zone.ZoneId) === 2) { ui.SystemOpenFlag = Number(ui.SystemOpenFlag) | 1; ui.FightTicket ??= 10; } // 실기록: FightTicket 10 등장
      const nz = snap.RaceZones.RaceZone.find((z: any) => Number(z.ZoneId) === Number(zone.ZoneId) + 1);
      if (nz && nz.Locked) {
        nz.Locked = false; nz.Progress = 0;
        const first = [...nz.Race].filter((r: any) => !isGirlRace(r)).sort((a: any, b: any) => a.RaceIndex - b.RaceIndex)[0];
        for (const r of nz.Race) if (!isGirlRace(r)) r.FirstPlayReward = !!areaRace(nz.ZoneId, r.RaceIndex)?.FirstPlayRewardItemID;
        if (first) openRace(nz.ZoneId, first);
        const girls = ensureGirlRaces(nz);
        zoneEntries.push({ ...nz, IsNew: true });
        for (const g of girls) zoneEntries.push({ ZoneId: nz.ZoneId, NewRace: [g] });
      }
    }
    // 캐릭터 연락처 해금 조건 재평가 (girlunlock.ts): 바뀐 캐릭터 레이스는 존별 ChangeRace, 노드는 GgraphPatch
    if (firstWin) {
      const u = evalGirlUnlocks(snap);
      for (const [zid, rs] of u.races) zoneEntries.push({ ZoneId: zid, ChangeRace: rs });
      if (u.nodes.length) extra.GgraphPatch = { Gnode: [...(extra.GgraphPatch?.Gnode ?? []), ...u.nodes] };
    }
    const ep = (!girlRace || Number(race.RaceMode) === 2) && firstWin ? epName(Number(zone.ZoneId), race, 'Win') : null;
    if (ep) extra.CallScript = [{ Name: ep, Girlid: 0, FmLevel: -1 }];
  } else {
    race.State = race.State | ST.FAIL;
    if (!withdraw) ui.Completion = Number(ui.Completion) | TUT_LOSE_RACE;
  }

  // 동승 캐릭터 친밀도
  const updateGirl: any[] = [];
  const passenger = passengerOn ? (snap.MyGirls?.MyGirlInfo ?? []).find((g: any) => Number(g.Girlid) === Number(ui.PassengerGirl)) : null;
  // 삐침 조건 12(라이벌 동승): 동승한 캐릭터의 그 삐침은 풀리고, 그 캐릭터를 라이벌로 둔 캐릭터는 횟수가 찬다 (peevish.ts, 실기록 2026-11-10 20505)
  //   푸는 레이스에서도 친밀도는 오른다 (실기록 +10) -> 친밀도보다 먼저
  if (passengerOn && !withdraw && Number(ui.PassengerGirl) > 0) updateGirl.push(...ridePeevish(snap, Number(ui.PassengerGirl), girlDef));
  // 삐친 캐릭터(Emotion 1)는 레이스로 호감도가 오르지 않는다 (클라이언트 안내 battle_result_notice_peevish)
  if (passenger && fam && Number(passenger.Emotion) !== 1) { passenger.Familiarity = (Number(passenger.Familiarity) || 0) + fam; syncGirl(passenger); if (!updateGirl.includes(passenger)) updateGirl.push(passenger); }

  // 결과 응답 FinalAttr 은 이번 숙련도 증가 전 값 (실기록: MasteryAttr 은 새 값, FinalAttr 은 이전 값 기준)
  const faBefore = finalAttr(girlRace ? { ...snap, UserInfo: { ...ui, PassengerGirl: -1 } } : snap, car);
  // 차량 숙련도 (패배 +1, 승리 +2)
  car.DeltaMastery = 0;
  addMastery(car, win ? 2 : withdraw ? 0 : 1);
  const propChanged = win && bumpProperty(snap, 'DQUEST_RACE', 1); // 일일 미션 '레이스 3회 승리' (기록 0 -> 1, 3 에서 멈춤)
  // 퀘스트 사건: 6 = 그 캐릭터를 태우고 레이스 n회, 2(순번 없음) = 존 승리 + 탑승 캐릭터, 30 = 히로인 드라이브
  if (!withdraw) {
    const pg = passengerOn ? Number(ui.PassengerGirl) : -1;
    questEvent(snap, 6, (p) => Number(p[1]) === pg);
    if (win) questEvent(snap, 2, (p) => !p[2] && Number(p[1]) === Number(zone.ZoneId) && (!p[4] || Number(p[4]) === pg));
    if (body.IsHeroineDrive) questEvent(snap, 30, (p) => Number(p[1]) === pg);
  }
  const questChanges = refreshQuests(snap);

  // LevelUp 은 다음 레이스 결과까지 UserInfo 에 남는다 (실기록: 2-12 결과·보상 수령·2-13 시작 응답에 유지, 2-13 결과에서 사라짐)
  const uiOut = { ...ui };
  ctx.store.putUser(ctx.session.accountId, snap);
  const action = [2, 3, 4, 5, 6].map((a, i) => ({
    Action: a, Count: Number([body.MissCnt, body.BadCnt, body.GoodCnt, body.PerfectCnt, body.ExcellentCnt][i]) || 0,
  }));
  const rewardCoin = baseCoin + bonusCoin + bossCoin;
  return [{
    name: 'MsgBattleResultAns',
    body: {
      Seq: 1, Result: 1, IsPlayerWin: win, UserInfo: uiOut,
      RewardInfo: { Coin: rewardCoin, Charexp: xp, Cash: bonusCash, Familiartity: fam, ItemInfo: [], CarInfo: rewardCars },
      BattleScore: withdraw ? 0 : Number(body.BattleScore) || 0, ItemInfo: resultItems, Race: race,
      RaceZone: zoneEntries,
      ...(clearTop ? { ClearRec: clearTop } : {}),
      RaceAction: { Action: action, ComboCount: Number(body.ComboCount) || 0 },
      DeltaInfo: { Charexp: xp, Coin: coin, Cash: bonusCash }, BoostCompensation: boostComp,
      OpponentCarInfo: race.OpponentCarInfo, IsHeroineDrive: !!body.IsHeroineDrive, PerfectStart: !!body.PerfectStart,
      RaceType: body.RaceType ?? 1, RaceLevel: body.RaceLevel ?? 1, BaseCoin: Number(race.RewardCoin) || 0, CoinRatio: 1, ...(win ? { RaceCoin: raceCoin } : {}), // 패배 응답엔 RaceCoin 없음 (실기록 20건)
      MyTimeRecord: withdraw ? 0 : body.TimeRecord, OpponentTimeRecord: withdraw ? 0 : body.OpponentTimeRecord, LeftBoost: body.LeftBoost ?? 0,
      MyMaxSpeed: body.LinearMaxSpeed, MyMaxDriftSpeed: body.CornerMaxSpeed, Withdraw: withdraw,
      ...(win ? {} : { RetryFuel: Number(car.FuelConsume) || 20 }),
      MyCarInfo: { ...car, FinalAttr: faBefore }, NewCars: rewardCars, // 실기록 3-20: 보스 보상 차량이 NewCars 에도
      UpdateGirlInfo: updateGirl, GgraphPatch: { Gnode: [] },
      Track: { TrackId: race.Track?.TrackId, Thema: race.Track?.Thema, LightingIndex: race.Track?.LightingIndex ?? 0 },
      ...(passenger ? { Passenger: { GirlInfo: passenger } } : {}), ...(propChanged ? { PropertySet: snap.PropertySet } : {}),
      ...extra,
    },
  }, ...(questChanges.length ? [{ name: 'MsgUpdateNquest', body: { Seq: 2, NquestInfo: questChanges } }] : []),
  ...(lockedUpdate.length ? [{ name: 'MsgUpdateData', body: { Seq: 3, UpdateData: { RaceZone: lockedUpdate } } }] : [])];
});

/** 숙련도 n 증가: MasteryCapacity 까지, 1씩 MasteryAttr 가장 낮은 능력치(동률이면 앞쪽). (기록 3->5, {1,1,1,0}->{2,1,1,1}) */
// 숙련도 1 점씩: 상한 대비 채운 비율(MasteryAttr / 능력치별 상한)이 가장 낮은 능력치에 (같으면 MaxSpd·Acc·Stab·Drift 순).
//   능력치별 상한 = cars.json SoftLimitAttrMax1..4 + ExpAttrMax1..4 x ExpansionLevel (1..4 = MaxSpd, Acc, Stab, Drift).
//   실측 2026-11-08 ★5 11705 한계 돌파 1회 뒤 숙련도 올리기 2회: {53,54,74,87} -> {59,60,82,97} -> {65,66,91,106} (상한 {82,83,115,135})
//   를 정확히 재현한다. 0 에서 268 까지 채우면 SoftLimitAttrMax {53,54,74,87} 와 같다. 상한 정보가 없는 차는 예전처럼 가장 낮은 값부터.
const MKEYS = ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift'];
function masteryCaps(car: any): number[] | null {
  const d = carDefOf(car?.Cartype); if (!d) return null;
  const e = Number(car.ExpansionLevel) || 0;
  const caps = MKEYS.map((_, i) => (Number(d[`SoftLimitAttrMax${i + 1}`]) || 0) + (Number(d[`ExpAttrMax${i + 1}`]) || 0) * e);
  return caps.every((c) => c > 0) ? caps : null;
}
export function addMastery(car: any, n: number) {
  const caps = masteryCaps(car);
  for (let i = 0; i < n && (Number(car.Mastery) || 0) < (Number(car.MasteryCapacity) || 0); i++) {
    car.Mastery = (Number(car.Mastery) || 0) + 1;
    car.MasteryAttr ??= { AttribMaxSpd: 0, AttribAcc: 0, AttribStability: 0, AttribDrift: 0 };
    const v = (k: string) => Number(car.MasteryAttr[k]) || 0;
    const low = caps
      ? MKEYS.reduce((a, k, j) => (v(k) / caps[j] < v(a) / caps[MKEYS.indexOf(a)] ? k : a), MKEYS[0])
      : MKEYS.reduce((a, k) => (v(k) < v(a) ? k : a), MKEYS[0]);
    car.MasteryAttr[low] = v(low) + 1;
    car.DeltaMastery = (Number(car.DeltaMastery) || 0) + 1;
  }
}

// 레이스 보상 수령 (실기록 2-11~2-15):
//   - FirstPlayReward true 면 battleTable FirstPlayRewardItemID x FirstPlayRewardNumItem 지급 (차량이면 RewardInfo.CarInfo, 아니면 ItemInfo)
//   - 레이스 칸 소액 보상 ItemInfo {Itemtype, Count} 지급 (코인이면 RewardInfo.Coin 에도)
//   - RewardBoxKind 1 이면 부품 상자: ★1 부품 1개 (RewardInfo.ItemInfo 와 최상위 ItemInfo, ContainerGrade 1), 2 면 부품 2개 (ContainerGrade 2)
//   - 응답 Race 는 수령 전, ChangeRace 는 State 17 / FirstPlayReward false / RewardBoxKind null
register('MsgRaceRewardReq', (body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const { zone, race } = findRace(snap ?? {}, body?.ZoneId, body?.RaceId);
  if (!snap || !zone || !race) return [{ name: 'MsgRaceRewardAns', body: { Seq: 1, Result: 0 } }];
  if (isEventZone(zone.ZoneId)) return eventReward(body, ctx, snap, zone, race);
  const before = structuredClone(race);
  const reward: any = { Coin: 0, Charexp: 0, Cash: 0, Familiartity: 0, ItemInfo: [], CarInfo: [] };
  const topItems: any[] = [];
  const newCars: any[] = [];
  let masteryCar: any = null;
  if (race.State & ST.CLEAR) {
    const ar = areaRace(zone.ZoneId, race.RaceIndex);
    // 지급 항목: 아이템(Itemid·StackNum 포함)은 지급 순서대로, 코인·캐시는 맨 뒤 (실기록 3-12/3-13/3-14)
    const cur: any[] = [];
    const give = (id: number, n: number, part?: any) => {
      if (part) { reward.ItemInfo.push(part); topItems.push(part); return; }
      if (!grantItem(snap, id, n)) return;
      if (id === 61001) { reward.Coin += n; cur.push({ Itemtype: id, Count: n, DeltaNum: n }); return; }
      if (id === 61002) { reward.Cash += n; cur.push({ Itemtype: id, Count: n, DeltaNum: n }); return; }
      const it = (snap.Items?.ItemInfo ?? []).find((x: any) => Number(x.Itemtype) === id);
      if (it && Number(it.Itemtype) < 61000) {
        reward.ItemInfo.push({ Itemid: it.Itemid, Itemtype: id, Count: n, StackNum: it.Count, DeltaNum: n });
        topItems.push({ Itemid: it.Itemid, Itemtype: id, Count: n, StackNum: it.Count });
      } else reward.ItemInfo.push({ Itemtype: id, Count: n, DeltaNum: n });
    };
    if (race.FirstPlayReward && ar?.FirstPlayRewardItemID) {
      const id = Number(ar.FirstPlayRewardItemID), n = Number(ar.FirstPlayRewardNumItem) || 1;
      if (carDefOf(id)) {
        for (let i = 0; i < n; i++) { const c = newOwnedCar(snap, id); snap.Cars.CarInfo.push(c); reward.CarInfo.push(c); newCars.push(c); }
      } else give(id, n);
    }
    // 레이스 칸 보상: 코인·숙련도(61xxx)는 매번 남고, 아이템(60xxx)은 한 번 받으면 사라진다 (실기록 2-14/2-15 유지, 3-12/3-13 null)
    if (race.ItemInfo?.Itemtype && race.DailyRewardTime === undefined) {
      const { Itemtype, Count } = race.ItemInfo;
      give(Number(Itemtype), Number(Count));
      if (Number(Itemtype) < 61000) delete race.ItemInfo;
    }
    // 보상 상자 내용: 존 BattleArea.Parts 가중치(★1..5)가 있으면 그 등급 부품 1개, 모두 0 이면 코인 RewardCoin/2
    //   (실기록: 존 1 Parts 0 -> 1-13·1-14 코인 300, 존 2·3 Parts [1,0,0,0,0] -> ★1 부품)
    if (Number(race.RewardBoxKind) === 1) {
      const w: number[] = (areaOf(zone.ZoneId)?.Parts ?? []).map(Number);
      const tot = w.reduce((a, b) => a + (b || 0), 0);
      if (tot > 0) {
        let r = Math.random() * tot, g = 1;
        for (let i = 0; i < w.length; i++) { r -= w[i] || 0; if (r < 0) { g = i + 1; break; } }
        const def = randomPart(g);
        if (def) give(0, 0, grantPart(snap, def));
      } else {
        const c = Math.floor((Number(race.RewardCoin) || 0) / 2);
        if (c > 0) give(61001, c);
      }
      reward.ContainerGrade = 1;
    } else if (Number(race.RewardBoxKind) === 2) {
      // 실기록 1건(5-14, 존 5 Parts [0.945, 0.055]): 같은 부위 ★1 34001 + ★2 34101, ContainerGrade 2.
      //   추정: 가중치로 뽑은 등급 g 의 부품 + 같은 부위 g+1 등급 부품 (없으면 같은 등급).
      const w: number[] = (areaOf(zone.ZoneId)?.Parts ?? []).map(Number);
      const tot = w.reduce((a, b) => a + (b || 0), 0);
      let r = Math.random() * (tot || 1), g = 1;
      if (tot > 0) for (let i = 0; i < w.length; i++) { r -= w[i] || 0; if (r < 0) { g = i + 1; break; } }
      const first = randomPart(g);
      if (first) {
        give(0, 0, grantPart(snap, first));
        const sameCat = (gr: number) => { for (let i = 0; i < 20; i++) { const p = randomPart(gr); if (p && Number(p.Category) === Number(first.Category)) return p; } return null; };
        const second = sameCat(g + 1) ?? sameCat(g);
        if (second) give(0, 0, grantPart(snap, second));
      }
      reward.ContainerGrade = 2;
    }
    reward.ItemInfo.push(...cur);
    const gotMastery = reward.ItemInfo.find((x: any) => Number(x.Itemtype) === 61005);
    if (gotMastery) {
      const c = (snap.Cars?.CarInfo ?? []).find((x: any) => Number(x.Carid) === Number(snap.UserInfo?.Currentcar));
      if (c) masteryCar = { ...c, DeltaMastery: Number(gotMastery.Count) || 0 };
    }
    race.State = (race.State & ~ST.CLEAR) | ST.PLAYABLE;
    race.FirstPlayReward = false;
    delete race.RewardBoxKind;
  }
  ctx.store.putUser(ctx.session.accountId, snap);
  const uiOut = { ...snap.UserInfo };
  return [{
    name: 'MsgRaceRewardAns',
    body: {
      Seq: 1, Result: 1, Race: before,
      RaceZone: [{ ZoneId: zone.ZoneId, ChangeRace: [{ ...race, RewardBoxKind: null, ItemInfo: race.ItemInfo ?? null }] }],
      // 받은 것이 없으면 RewardInfo 를 싣지 않는다 (실기록 1-2 재도전 보상 수령). 숙련도를 받으면 MyCarInfo(DeltaMastery) (실기록 3-5)
      ...(reward.ItemInfo.length || reward.CarInfo.length || reward.Coin || reward.Cash ? { RewardInfo: reward } : {}),
      ItemInfo: topItems, ...(masteryCar ? { MyCarInfo: masteryCar } : {}), NewCars: newCars, UserInfo: uiOut,
    },
  }];
});

// 동승 캐릭터 변경: {Passenger: girlid|0} -> {Seq, Result:1, UserInfo}  (기록)
register('MsgSelectPassengerReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const id = Number(body?.Passenger) || 0;
  const owned = id === 0 || (snap?.MyGirls?.MyGirlInfo ?? []).some((g: any) => Number(g.Girlid) === id);
  if (!snap || !owned) return [{ name: 'MsgSelectPassengerAns', body: { Seq: 1, Result: 0 } }];
  snap.UserInfo.PassengerGirl = id;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgSelectPassengerAns', body: { Seq: 1, Result: 1, UserInfo: snap.UserInfo } }];
});

// 캐릭터 메모리(대사 이벤트) 기록: 요청 항목을 합치고 RewardState 2 로 표시 (기록)
register('MsgUpdateGirlMemoryReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'MsgUpdateGirlMemoryAns', body: { Seq: 1, UpdateGirlInfo: [] } }];
  snap.GirlMemorySet ??= { GirlMemory: [], Version: 1 };
  for (const gm of body?.GirlMemorySet?.GirlMemory ?? []) {
    let mine = snap.GirlMemorySet.GirlMemory.find((x: any) => Number(x.Girlid) === Number(gm.Girlid));
    if (!mine) { mine = { Girlid: Number(gm.Girlid), Memory: [] }; snap.GirlMemorySet.GirlMemory.push(mine); }
    for (const m of gm.Memory ?? []) {
      // 이미 있으면 FmFlag 를 OR (실기록: 2 에 4 가 더해져 6)
      const ex = mine.Memory.find((x: any) => Number(x.Id) === Number(m.Id));
      if (ex) { if (m.FmFlag !== undefined) ex.FmFlag = (Number(ex.FmFlag) || 0) | Number(m.FmFlag); }
      else mine.Memory.push({ ...m, RewardState: 2 });
    }
  }
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgUpdateGirlMemoryAns', body: { Seq: 1, GirlMemorySet: snap.GirlMemorySet, UpdateGirlInfo: [] } }];
});
