// 스토리 레이스(에피소드) 시작/결과. 형식은 실서버 기록(data/recorded, 2026-11-01 레이스 1-2)을 기준으로 맞췄다.
//
// 확인된 규칙 (근거)
//  - 레이스 State 비트: 플레이가능 1, 클리어 2, 실패 4, 잠김 8, 승리 16          (클라이언트 enum)
//      패배 1 -> 5 (기록), 1-1 승리 상태 17 (시드)
//  - 연료: Fuelvalue=최대, Fueltime=가득 차는 시각. 연료 1 = fuelFillTime(15)초.  (클라이언트 fuelState, 기록 +300s)
//  - 튜토리얼 비트(UserInfo.Completion): 시작 시 InformationFirstGirl(512), 패배 시 LoseRace(268435456) (기록)
//  - 패배: XP = floor(RewardXP*0.3), 코인 0, 동승 캐릭터 친밀도 +RewardFamiliarity   (기록 42 -> 12, +10)
//  - 숙련도: 패배 +1, 승리 +2 (MasteryCapacity 까지), 1씩 MasteryAttr 가장 낮은 능력치(동률이면 앞쪽)에 (기록 3->5, {1,1,1,0}->{2,1,1,1})
//  - 승리 (기록 2026-11-01 1-2, State 5 -> 18): State = CLEAR|WIN (PLAYABLE·FAIL 해제). CLEAR 는 '보상 미수령' 표시로,
//      MsgRaceRewardReq 에서 CLEAR 를 지우고 PLAYABLE 을 켠다(18 -> 17). StateHard 8 -> 1.
//      RaceCoin = BaseCoin(RewardCoin) x CoinRatio(1), XP = RewardXP 전액, 친밀도 +RewardFamiliarity, DQUEST_RACE +1.
//      다음 레이스(잠김 8)는 State 1 로 바꿔 RaceZone.NewRace 로 보낸다. Progress +10, DeltaProgress 10.
//  - 등급 보상: Race.ClearRec {Grade, Flag(최고 등급 비트 S1 A2 B4 C8 D16), Bonus(받은 S/A/B 보너스 비트 1|2|4)}
//      최상위 ClearRec {Grade, Flag(이번에 새로 받은 보너스 S64 A128 B256), RewardInfo}. 결과 화면은 Flag&65/130/260 으로 체크 표시.
//      기록: 첫 S 클리어 = S·A·B 보너스 동시 → 코인 1600 + 캐시 2 (RewardInfo.Coin 2200 = 600 + 1600).
// 추정(기록 없음): 등급 판정 기준(S: 미스·배드 0 / A: 미스 0 / B: 그 외), 보너스를 하나씩 받을 때의 금액 배분
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg, type Ctx } from '../rpc.js';

const ST = { PLAYABLE: 1, CLEAR: 2, FAIL: 4, LOCKED: 8, WIN: 16 } as const;
const TUT_INFO_FIRST_GIRL = 512;
const TUT_FIRST_SELECT = 256;
const TUT_LOSE_RACE = 268435456;
const FUEL_FILL_SEC = 15;

const tables = new URL('../../data/tables/', import.meta.url).pathname;
const cache: Record<string, any> = {};
function table(name: string) {
  if (!(name in cache)) cache[name] = existsSync(tables + name) ? JSON.parse(readFileSync(tables + name, 'utf8')) : null;
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
function spendFuel(ui: any, amount: number) {
  ui.Fueltime = Math.max(Number(ui.Fueltime) || 0, now()) + amount * FUEL_FILL_SEC;
}

/** PropertySet.Property[] 의 Nvalue 증가 (일일 미션 카운터 등) */
export function bumpProperty(snap: any, name: string, by: number) {
  snap.PropertySet ??= { Property: [] };
  snap.PropertySet.Property ??= [];
  const p = snap.PropertySet.Property.find((x: any) => x.PropertyName === name);
  if (p) p.Nvalue = (Number(p.Nvalue) || 0) + by;
  else snap.PropertySet.Property.push({ PropertyName: name, Nvalue: by });
}

function withFinalAttr(car: any) {
  const a = car.Attributes ?? {}, m = car.MasteryAttr ?? {};
  const FinalAttr: any = {};
  for (const k of ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift']) FinalAttr[k] = (a[k] || 0) + (m[k] || 0);
  return { ...car, FinalAttr };
}

function levelUp(ui: any) {
  const rows: any[] = (table('playerLevelTable.json')?.Level ?? []).filter((r: any) => r.Id);
  for (;;) {
    const cur = rows.find((r) => Number(r.Id) === Number(ui.Charlevel));
    const next = rows.find((r) => Number(r.Id) === Number(ui.Charlevel) + 1);
    if (!cur || !next || Number(ui.Charexp) < Number(next.AccExp)) break;
    ui.Charlevel = Number(ui.Charlevel) + 1;
    if (next.Gasoline) ui.Fuelvalue = Number(next.Gasoline); // 레벨별 최대 연료
  }
}

register('MsgBattleStartReq', (body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const { race } = findRace(snap ?? {}, body?.ZoneId, body?.BattleId);
  const car = snap && currentCar(snap);
  if (!snap || !race || !car || race.State & ST.LOCKED) {
    return [{ name: 'MsgBattleStartAns', body: { Seq: 1, Result: 0, BattleId: body?.BattleId } }];
  }
  const ui = snap.UserInfo;
  const cost = Number(car.FuelConsume) || 20;
  if (!ctx.cheat.enabled || !ctx.cheat.infiniteFuel) {
    if (fuelNow(ui) < cost) return [{ name: 'MsgBattleStartAns', body: { Seq: 1, Result: 0, UserInfo: ui } }];
    spendFuel(ui, cost);
  }
  if (Number(ui.Completion) & TUT_FIRST_SELECT) ui.Completion = Number(ui.Completion) | TUT_INFO_FIRST_GIRL;
  race.TryCount = (Number(race.TryCount) || 0) + 1;
  ctx.store.setMeta(`battle:${ctx.session.accountId}`, JSON.stringify({ zone: body.ZoneId, race: body.BattleId, level: body.RaceLevel ?? 1, at: now() }));
  ctx.store.putUser(ctx.session.accountId, snap);
  const forceWin = !!(ctx.cheat.enabled && ctx.cheat.forceWinBattles);
  return [{
    name: 'MsgBattleStartAns',
    body: {
      Seq: 1, Result: 1, UserInfo: ui, NitroReadyNum: 0, Passenger: ui.PassengerGirl ?? 0, GirlsSpecialSkill: [],
      RaceInfo: race, RaceType: body.RaceType ?? 1, ZoneId: body.ZoneId, BattleId: body.BattleId,
      Track: { ...(track(race.Track?.TrackId) ?? {}), ClosedTrack: false, Thema: race.Track?.Thema, LightingIndex: race.Track?.LightingIndex ?? 0 },
      MyCarInfo: withFinalAttr(car), OpponentCarInfo: race.OpponentCarInfo, Boss: 0, ForceWin: forceWin, MyPosition: 0,
      RaceLevel: body.RaceLevel ?? 1, RelativeDifficulty: 1, NewCollections: { Collection: [] },
      ReplaySeed: Math.floor(Math.random() * 2 ** 31),
    },
  }];
});

register('MsgBattleResultReq', (body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const { zone, race } = findRace(snap ?? {}, body?.ZoneId, body?.BattleId);
  const car = snap && currentCar(snap);
  if (!snap || !zone || !race || !car) return [{ name: 'MsgBattleResultAns', body: { Seq: 1, Result: 0 } }];
  const ui = snap.UserInfo;
  const win = !!body.IsPlayerWin || !!(ctx.cheat.enabled && ctx.cheat.forceWinBattles);
  const changed: any[] = [race];
  const newRaces: any[] = [];
  let deltaProgress = 0;

  // 보상
  const baseCoin = Number(race.RewardCoin) || 0;
  const raceCoin = win ? baseCoin : 0;
  // 등급 보너스 (승리 시)
  let clearTop: any = null, bonusCoin = 0, bonusCash = 0;
  if (win) {
    const miss = Number(body.MissCnt) || 0, bad = Number(body.BadCnt) || 0;
    const grade = miss === 0 && bad === 0 ? 1 : miss === 0 ? 2 : 3; // 1=S 2=A 3=B (추정 기준)
    const prev = race.ClearRec ?? {};
    const earned = [1, 2, 4].filter((b, i) => i + 1 >= grade).reduce((a, b) => a | b, 0); // S면 S|A|B
    const fresh = earned & ~(Number(prev.Bonus) || 0);
    const n = [1, 2, 4].filter((b) => fresh & b).length;
    bonusCoin = Math.round((1600 * n) / 3); bonusCash = Math.round((2 * n) / 3); // 기록: 3개 = 1600 / 2
    const bestBit = 1 << (grade - 1);
    const prevBest = Number(prev.Flag) || 0;
    race.ClearRec = {
      Grade: prevBest && prevBest < bestBit ? Number(prev.Grade) || grade : grade,
      Flag: prevBest && prevBest < bestBit ? prevBest : bestBit,
      Bonus: (Number(prev.Bonus) || 0) | earned,
    };
    clearTop = {
      Grade: grade, Flag: [64, 128, 256].filter((_, i) => fresh & (1 << i)).reduce((a, b) => a | b, 0),
      RewardInfo: { Coin: bonusCoin, Charexp: 0, Cash: bonusCash, Familiartity: 0, ItemInfo: [], CarInfo: [] },
    };
  }
  const coin = raceCoin + bonusCoin;
  ui.Cash = (Number(ui.Cash) || 0) + bonusCash;
  const xp = win ? Number(race.RewardXP) || 0 : Math.floor((Number(race.RewardXP) || 0) * 0.3);
  const fam = Number(race.RewardFamiliarity) || 0;
  ui.Coin = (Number(ui.Coin) || 0) + coin;
  ui.Charexp = (Number(ui.Charexp) || 0) + xp;
  levelUp(ui);

  // 레이스 상태
  if (win) {
    const firstWin = !(race.State & ST.WIN);
    race.State = (race.State & ~(ST.FAIL | ST.PLAYABLE)) | ST.CLEAR | ST.WIN;
    if (Number(body.RaceLevel ?? 1) === 1 && race.StateHard & ST.LOCKED) race.StateHard = ST.PLAYABLE;
    if (firstWin) {
      deltaProgress = 10;
      zone.Progress = (Number(zone.Progress) || 0) + deltaProgress;
      const order = [...zone.Race].filter((r: any) => Number(r.RaceLifeType ?? 1) === 1)
        .sort((a: any, b: any) => a.RaceIndex - b.RaceIndex);
      const next = order[order.indexOf(race) + 1];
      if (next && next.State & ST.LOCKED) { next.State = ST.PLAYABLE; newRaces.push(next); }
      if (!next) { // 존 마지막(보스) 승리 → 다음 존 해금
        const zones = snap.RaceZones.RaceZone;
        const nz = zones.find((z: any) => Number(z.ZoneId) === Number(zone.ZoneId) + 1);
        if (nz && nz.Locked) {
          nz.Locked = false;
          const first = [...nz.Race].sort((a: any, b: any) => a.RaceIndex - b.RaceIndex)[0];
          if (first) { first.State = ST.PLAYABLE; }
        }
      }
    }
  } else {
    race.State = race.State | ST.FAIL;
    ui.Completion = Number(ui.Completion) | TUT_LOSE_RACE;
  }

  // 동승 캐릭터 친밀도
  const updateGirl: any[] = [];
  const passenger = (snap.MyGirls?.MyGirlInfo ?? []).find((g: any) => Number(g.Girlid) === Number(ui.PassengerGirl));
  if (passenger && fam) { passenger.Familiarity = (Number(passenger.Familiarity) || 0) + fam; updateGirl.push(passenger); }

  // 차량 숙련도 (패배 +1, 승리 +2)
  car.DeltaMastery = 0;
  for (let i = 0; i < (win ? 2 : 1) && (Number(car.Mastery) || 0) < (Number(car.MasteryCapacity) || 0); i++) {
    car.Mastery = (Number(car.Mastery) || 0) + 1;
    car.MasteryAttr ??= { AttribMaxSpd: 0, AttribAcc: 0, AttribStability: 0, AttribDrift: 0 };
    const keys = ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift'];
    const low = keys.reduce((a, k) => ((car.MasteryAttr[k] || 0) < (car.MasteryAttr[a] || 0) ? k : a), keys[0]);
    car.MasteryAttr[low] = (car.MasteryAttr[low] || 0) + 1;
    car.DeltaMastery += 1;
  }
  if (win) bumpProperty(snap, 'DQUEST_RACE', 1); // 일일 미션 '레이스 3회 승리' (기록 0 -> 1)

  ctx.store.putUser(ctx.session.accountId, snap);
  const action = [2, 3, 4, 5, 6].map((a, i) => ({
    Action: a, Count: Number([body.MissCnt, body.BadCnt, body.GoodCnt, body.PerfectCnt, body.ExcellentCnt][i]) || 0,
  }));
  return [{
    name: 'MsgBattleResultAns',
    body: {
      Seq: 1, Result: 1, IsPlayerWin: win, UserInfo: ui,
      RewardInfo: { Coin: coin, Charexp: xp, Cash: bonusCash, Familiartity: fam, ItemInfo: [], CarInfo: [] },
      BattleScore: Number(body.BattleScore) || 0, ItemInfo: [], Race: race,
      RaceZone: [{
        ZoneId: zone.ZoneId, ChangeRace: changed,
        ...(newRaces.length ? { NewRace: newRaces } : {}),
        ...(deltaProgress ? { Progress: zone.Progress, DeltaProgress: deltaProgress } : {}),
      }],
      ...(clearTop ? { ClearRec: clearTop } : {}),
      RaceAction: { Action: action, ComboCount: Number(body.ComboCount) || 0 },
      DeltaInfo: { Charexp: xp, Coin: coin, Cash: bonusCash }, BoostCompensation: 0,
      OpponentCarInfo: race.OpponentCarInfo, IsHeroineDrive: !!body.IsHeroineDrive, PerfectStart: !!body.PerfectStart,
      RaceType: body.RaceType ?? 1, RaceLevel: body.RaceLevel ?? 1, BaseCoin: baseCoin, CoinRatio: 1, RaceCoin: raceCoin,
      MyTimeRecord: body.TimeRecord, OpponentTimeRecord: body.OpponentTimeRecord, LeftBoost: body.LeftBoost ?? 0,
      MyMaxSpeed: body.LinearMaxSpeed, MyMaxDriftSpeed: body.CornerMaxSpeed, Withdraw: false,
      RetryFuel: Number(car.FuelConsume) || 20, MyCarInfo: withFinalAttr(car), NewCars: [],
      UpdateGirlInfo: updateGirl, GgraphPatch: { Gnode: [] }, Track: race.Track,
      Passenger: passenger ? { GirlInfo: passenger } : {}, SpotSale: [], PropertySet: snap.PropertySet,
    },
  }];
});

// 레이스 보상 수령: {ZoneId, RaceId} -> {Seq, Result, Race(수령 전), RaceZone[{ZoneId, ChangeRace[수령 후]}], ItemInfo, NewCars, UserInfo}
// 기록: Race.State 18 그대로, ChangeRace.State 17 (CLEAR 해제, PLAYABLE), RewardBoxKind/ItemInfo null. 코인 등은 결과에서 이미 지급.
register('MsgRaceRewardReq', (body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const { zone, race } = findRace(snap ?? {}, body?.ZoneId, body?.RaceId);
  if (!snap || !zone || !race) return [{ name: 'MsgRaceRewardAns', body: { Seq: 1, Result: 0 } }];
  const before = structuredClone(race);
  if (race.State & ST.CLEAR) race.State = (race.State & ~ST.CLEAR) | ST.PLAYABLE;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgRaceRewardAns',
    body: {
      Seq: 1, Result: 1, Race: before,
      RaceZone: [{ ZoneId: zone.ZoneId, ChangeRace: [{ ...race, RewardBoxKind: null, ItemInfo: null }] }],
      ItemInfo: [], NewCars: [], UserInfo: snap.UserInfo,
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
      if (!mine.Memory.some((x: any) => Number(x.Id) === Number(m.Id))) mine.Memory.push({ ...m, RewardState: 2 });
    }
  }
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgUpdateGirlMemoryAns', body: { Seq: 1, GirlMemorySet: snap.GirlMemorySet, UpdateGirlInfo: [] } }];
});
