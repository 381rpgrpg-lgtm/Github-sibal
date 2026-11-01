// 스토리 레이스(에피소드) 시작/결과. 형식은 실서버 기록(data/recorded, 2026-11-01 레이스 1-2)을 기준으로 맞췄다.
//
// 확인된 규칙 (근거)
//  - 레이스 State 비트: 플레이가능 1, 클리어 2, 실패 4, 잠김 8, 승리 16          (클라이언트 enum)
//      패배 1 -> 5 (기록), 1-1 승리 상태 17 (시드)
//  - 연료: Fuelvalue=최대, Fueltime=가득 차는 시각. 연료 1 = fuelFillTime(15)초.  (클라이언트 fuelState, 기록 +300s)
//  - 튜토리얼 비트(UserInfo.Completion): 시작 시 InformationFirstGirl(512), 패배 시 LoseRace(268435456) (기록)
//  - 패배: XP = floor(RewardXP*0.3), 코인 0, 동승 캐릭터 친밀도 +RewardFamiliarity   (기록 42 -> 12, +10)
//  - 숙련도: 레이스마다 Mastery +1 (MasteryCapacity 까지), MasteryAttr 가장 낮은 능력치 +1 (기록)
// 추정(기록 없음): 승리 보상 = RewardCoin/RewardXP 전액, 다음 레이스 해금, ClearRec 등급 계산, 존 Progress +10
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

  // 보상
  const baseCoin = Number(race.RewardCoin) || 0;
  const coin = win ? baseCoin : 0;
  const xp = win ? Number(race.RewardXP) || 0 : Math.floor((Number(race.RewardXP) || 0) * 0.3);
  const fam = Number(race.RewardFamiliarity) || 0;
  ui.Coin = (Number(ui.Coin) || 0) + coin;
  ui.Charexp = (Number(ui.Charexp) || 0) + xp;
  levelUp(ui);

  // 레이스 상태
  if (win) {
    const firstWin = !(race.State & ST.WIN);
    race.State = (race.State & ~ST.FAIL) | ST.PLAYABLE | ST.WIN;
    if (Number(body.RaceLevel ?? 1) === 1 && race.StateHard & ST.LOCKED) race.StateHard = ST.PLAYABLE;
    race.ClearRec = { Grade: Number(body.MissCnt) === 0 ? 1 : Number(body.MissCnt) <= 3 ? 2 : 3, Flag: 1, Bonus: 7 };
    if (firstWin) {
      zone.Progress = (Number(zone.Progress) || 0) + 10;
      const order = [...zone.Race].sort((a: any, b: any) => a.RaceIndex - b.RaceIndex);
      const next = order[order.indexOf(race) + 1];
      if (next && next.State & ST.LOCKED) { next.State = ST.PLAYABLE; changed.push(next); }
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

  // 차량 숙련도
  if ((Number(car.Mastery) || 0) < (Number(car.MasteryCapacity) || 0)) {
    car.Mastery = (Number(car.Mastery) || 0) + 1;
    car.MasteryAttr ??= { AttribMaxSpd: 0, AttribAcc: 0, AttribStability: 0, AttribDrift: 0 };
    const keys = ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift'];
    const low = keys.reduce((a, k) => ((car.MasteryAttr[k] || 0) < (car.MasteryAttr[a] || 0) ? k : a), keys[0]);
    car.MasteryAttr[low] = (car.MasteryAttr[low] || 0) + 1;
    car.DeltaMastery = 1;
  }

  ctx.store.putUser(ctx.session.accountId, snap);
  const action = [2, 3, 4, 5, 6].map((a, i) => ({
    Action: a, Count: Number([body.MissCnt, body.BadCnt, body.GoodCnt, body.PerfectCnt, body.ExcellentCnt][i]) || 0,
  }));
  return [{
    name: 'MsgBattleResultAns',
    body: {
      Seq: 1, Result: 1, IsPlayerWin: win, UserInfo: ui,
      RewardInfo: { Coin: coin, Charexp: xp, Cash: 0, Familiartity: fam, ItemInfo: [], CarInfo: [] },
      BattleScore: Number(body.BattleScore) || 0, ItemInfo: [], Race: race,
      RaceZone: [{ ZoneId: zone.ZoneId, ChangeRace: changed }],
      RaceAction: { Action: action, ComboCount: Number(body.ComboCount) || 0 },
      DeltaInfo: { Charexp: xp, Coin: coin, Cash: 0 }, BoostCompensation: 0,
      OpponentCarInfo: race.OpponentCarInfo, IsHeroineDrive: !!body.IsHeroineDrive, PerfectStart: !!body.PerfectStart,
      RaceType: body.RaceType ?? 1, RaceLevel: body.RaceLevel ?? 1, BaseCoin: baseCoin, CoinRatio: 1,
      MyTimeRecord: body.TimeRecord, OpponentTimeRecord: body.OpponentTimeRecord, LeftBoost: body.LeftBoost ?? 0,
      MyMaxSpeed: body.LinearMaxSpeed, MyMaxDriftSpeed: body.CornerMaxSpeed, Withdraw: false,
      RetryFuel: Number(car.FuelConsume) || 20, MyCarInfo: withFinalAttr(car), NewCars: [],
      UpdateGirlInfo: updateGirl, GgraphPatch: { Gnode: [] }, Track: race.Track,
      Passenger: passenger ? { GirlInfo: passenger } : {}, SpotSale: [],
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
