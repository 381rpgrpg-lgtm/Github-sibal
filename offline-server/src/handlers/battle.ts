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
import { grantItem } from '../inventory.js';
import { ensureGirl, newGirlRecord } from './girls.js';
import { refreshQuests, questEvent } from '../quests.js';
import { table as gtable, areaOf, areaRace, finalAttr, makeOpponent, newOwnedCar, randomPart, grantPart, carDefOf, relativeDifficulty, syncGirl } from '../gamecalc.js';

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
    ui.LevelUp = { Level: ui.Charlevel, FuelMax: ui.Fuelvalue, Coin: 0, Cash: 2 };
    snap.MailBox ??= { Version: 1, Mail: [], Count: 0 };
    snap.mailSeq = (Number(snap.mailSeq) || Math.max(0, ...snap.MailBox.Mail.map((m: any) => Number(m.MailId) || 0))) + 1;
    snap.MailBox.Mail.push({
      MailId: snap.mailSeq, MailType: 4, BoxType: 0, Itemnum: 2, Itemtype: 61002, Subject: 'Level reward',
      Content: `Player level ${ui.Charlevel} reached.`, ExpireTime: Math.floor(now()) + 7 * 86400,
    });
    snap.MailBox.Count = snap.MailBox.Mail.length;
  }
}

// 스토리 대본 이름 (실기록): 시작 EP<존2자리><순번2자리>Start (순번 = RaceIndex-10), 보스 EP<존>BossStart,
//   첫 승리 EP..Win / EP<존>BossWin. 대본 데이터가 없으면 클라이언트가 건너뛴다.
const epName = (zone: number, race: any, kind: 'Start' | 'Win') => {
  const z = String(zone).padStart(2, '0');
  if (race.Boss) return `EP${z}Boss${kind}`;
  const n = Number(race.RaceIndex) - 10;
  return n >= 1 && n <= 9 ? `EP${z}${String(n).padStart(2, '0')}${kind}` : null;
};
const isGirlRace = (race: any) => !!race.UnlockGirlInfo || Number(areaRace(race.ZoneId, race.RaceIndex)?.RaceType) === 7;
const TUT_UNLOCK_RACE = 4096;

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
  // 캐릭터 레이스 시작 시 UnlockRace 튜토리얼 비트 (실기록: 2-25 시작 응답에서 Completion |= 4096)
  if (isGirlRace(race)) ui.Completion = Number(ui.Completion) | TUT_UNLOCK_RACE;
  race.TryCount = (Number(race.TryCount) || 0) + 1;
  ctx.store.setMeta(`battle:${ctx.session.accountId}`, JSON.stringify({ zone: body.ZoneId, race: body.BattleId, level: body.RaceLevel ?? 1, at: now() }));
  ctx.store.putUser(ctx.session.accountId, snap);
  const forceWin = !!(ctx.cheat.enabled && ctx.cheat.forceWinBattles);
  const girlRace = isGirlRace(race);
  const ep = girlRace ? null : epName(Number(body.ZoneId), race, 'Start');
  const fa = finalAttr(girlRace ? { ...snap, UserInfo: { ...ui, PassengerGirl: -1 } } : snap, car);
  return [{
    name: 'MsgBattleStartAns',
    body: {
      Seq: 1, Result: 1, UserInfo: ui, NitroReadyNum: 0, Passenger: girlRace ? -1 : ui.PassengerGirl ?? 0, GirlsSpecialSkill: [],
      RaceInfo: race, RaceType: body.RaceType ?? 1, ZoneId: body.ZoneId, BattleId: body.BattleId,
      // 시작 응답 Track = trackTable 전체 + (보스 외) ClosedTrack + Thema/LightingIndex (실기록 2-12, 2-20)
      Track: { ...(track(race.Track?.TrackId) ?? {}), ...(race.Boss ? {} : { ClosedTrack: false }), Thema: race.Track?.Thema, LightingIndex: race.Track?.LightingIndex ?? 0 },
      MyCarInfo: { ...car, FinalAttr: fa },
      OpponentCarInfo: race.OpponentCarInfo, Boss: Number(race.Boss) || 0, ForceWin: forceWin, MyPosition: 0,
      RaceLevel: body.RaceLevel ?? 1, RelativeDifficulty: relativeDifficulty(fa, race.OpponentCarInfo),
      ...(girlRace ? { NewGirl: Number(race.UnlockGirlInfo?.Girlid) } : {}),
      ...(ep ? { CallScript: [{ Name: ep, Girlid: 0, FmLevel: -1 }] } : {}),
      ReplaySeed: Math.floor(Math.random() * 2 ** 31),
    },
  }];
});

// 새로 열리는 레이스 준비: 첫 플레이 보상 표시(FirstPlayRewardItemID 가 있으면 true),
//   레이스 칸에 미리 정해 두는 소액 보상 ItemInfo (실기록: 61001 코인 90, 61005 숙련도 2. 출현 확률·종류 표는 미확인 -> 추정 50%).
function openRace(zoneId: number, race: any) {
  race.State = ST.PLAYABLE;
  race.FirstPlayReward = !!areaRace(zoneId, race.RaceIndex)?.FirstPlayRewardItemID;
  race.TryCount = Number(race.TryCount) || 0;
  if (!race.Boss && !isGirlRace(race) && Math.random() < 0.5) {
    race.ItemInfo = Math.random() < 0.5 ? { Itemtype: 61001, Count: 90 } : { Itemtype: 61005, Count: 2 };
  }
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
  const snap = ctx.store.getUser(ctx.session.accountId);
  const { zone, race } = findRace(snap ?? {}, body?.ZoneId, body?.BattleId);
  const car = snap && currentCar(snap);
  if (!snap || !zone || !race || !car) return [{ name: 'MsgBattleResultAns', body: { Seq: 1, Result: 0 } }];
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
    const n = [1, 2, 4].filter((b) => fresh & b).length;
    if (Number(race.RewardCoin) > 0) { bonusCoin = Math.round((1600 * n) / 3); bonusCash = n === 3 ? 1 : 0; }
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

  const coin = raceCoin + bonusCoin + bossCoin;
  ui.Cash = (Number(ui.Cash) || 0) + bonusCash;
  const xp = win ? Number(race.RewardXP) || 0 : Math.floor((Number(race.RewardXP) || 0) * 0.3);
  const passengerOn = !girlRace;
  const fam = passengerOn ? Number(race.RewardFamiliarity) || 0 : 0;
  ui.Coin = (Number(ui.Coin) || 0) + coin;
  ui.Charexp = (Number(ui.Charexp) || 0) + xp;
  delete ui.LevelUp;
  levelUp(snap);

  // 레이스 상태
  let deltaProgress = 0;
  const extra: any = {};
  if (win) {
    race.State = boss ? (race.State & ~(ST.FAIL | ST.PLAYABLE | ST.CLEAR)) | ST.WIN   // 보스: 16 (보상 수령 단계 없음)
      : (race.State & ~(ST.FAIL | ST.PLAYABLE)) | ST.CLEAR | ST.WIN;                    // 일반·캐릭터: 18
    if (Number(body.RaceLevel ?? 1) === 1 && race.StateHard & ST.LOCKED && !boss) race.StateHard = ST.PLAYABLE;
    if (firstWin && !boss && !girlRace) {
      deltaProgress = 10;
      zone.Progress = (Number(zone.Progress) || 0) + deltaProgress;
      // 보상 상자: FirstPlayReward 가 없는 레이스는 존 Box1 확률로 부품 상자 (실기록 2-12, 존 2 Box1 0.51)
      if (!race.FirstPlayReward && Math.random() < (Number(areaOf(zone.ZoneId)?.Box1) || 0)) race.RewardBoxKind = 1;
      const order = [...zone.Race].filter((r: any) => !isGirlRace(r) && !r.Boss && Number(r.RaceIndex) < 20)
        .sort((a: any, b: any) => a.RaceIndex - b.RaceIndex);
      const next = order[order.indexOf(race) + 1] ?? zone.Race.find((r: any) => r.Boss);
      main.NewRace = [];
      if (next && next.State & ST.LOCKED) { openRace(zone.ZoneId, next); main.NewRace.push(next); }
      // 캐릭터 레이스: 같은 존 13번 승리 후 열림 (실기록 2-13 -> 2-25. 다른 존은 추정)
      if (Number(race.RaceIndex) === 13) {
        const girls = ensureGirlRaces(zone).filter((r: any) => r.State & ST.LOCKED);
        const nodes: any[] = [];
        for (const g of girls) {
          g.State = ST.PLAYABLE;
          g.UnlockGirlInfo = { Girlid: Number(g.UnlockGirlInfo?.Girlid), State: 6 };
          // 관계도 노드를 '해금 가능'(6)으로 (실기록 2-13 승리: Gnode State 6, GirlInfo State 6)
          const node = (snap.Ggraph?.Gnode ?? []).find((n: any) => Number(n.GirlInfo?.Girlid) === Number(g.UnlockGirlInfo.Girlid));
          if (node && Number(node.State) !== 7) {
            node.State = 6;
            node.GirlInfo = { ...newGirlRecord(Number(g.UnlockGirlInfo.Girlid)), Familiarity: 0, NextCoin: 100, State: 6, UnlockCritFlag: 1 };
            nodes.push(node);
          }
        }
        if (girls.length) zoneEntries.push({ ZoneId: zone.ZoneId, ChangeRace: girls });
        if (nodes.length) extra.GgraphPatch = { Gnode: nodes };
      }
      main.Progress = zone.Progress; main.DeltaProgress = deltaProgress;
    }
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
    const ep = !girlRace && firstWin ? epName(Number(zone.ZoneId), race, 'Win') : null;
    if (ep) extra.CallScript = [{ Name: ep, Girlid: 0, FmLevel: -1 }];
  } else {
    race.State = race.State | ST.FAIL;
    if (!withdraw) ui.Completion = Number(ui.Completion) | TUT_LOSE_RACE;
  }

  // 동승 캐릭터 친밀도
  const updateGirl: any[] = [];
  const passenger = passengerOn ? (snap.MyGirls?.MyGirlInfo ?? []).find((g: any) => Number(g.Girlid) === Number(ui.PassengerGirl)) : null;
  if (passenger && fam) { passenger.Familiarity = (Number(passenger.Familiarity) || 0) + fam; syncGirl(passenger); updateGirl.push(passenger); }

  // 결과 응답 FinalAttr 은 이번 숙련도 증가 전 값 (실기록: MasteryAttr 은 새 값, FinalAttr 은 이전 값 기준)
  const faBefore = finalAttr(girlRace ? { ...snap, UserInfo: { ...ui, PassengerGirl: -1 } } : snap, car);
  // 차량 숙련도 (패배 +1, 승리 +2)
  car.DeltaMastery = 0;
  addMastery(car, win ? 2 : withdraw ? 0 : 1);
  if (win) bumpProperty(snap, 'DQUEST_RACE', 1); // 일일 미션 '레이스 3회 승리' (기록 0 -> 1)
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
      BattleScore: withdraw ? 0 : Number(body.BattleScore) || 0, ItemInfo: [], Race: race,
      RaceZone: zoneEntries,
      ...(clearTop ? { ClearRec: clearTop } : {}),
      RaceAction: { Action: action, ComboCount: Number(body.ComboCount) || 0 },
      DeltaInfo: { Charexp: xp, Coin: coin, Cash: bonusCash }, BoostCompensation: boostComp,
      OpponentCarInfo: race.OpponentCarInfo, IsHeroineDrive: !!body.IsHeroineDrive, PerfectStart: !!body.PerfectStart,
      RaceType: body.RaceType ?? 1, RaceLevel: body.RaceLevel ?? 1, BaseCoin: Number(race.RewardCoin) || 0, CoinRatio: 1, RaceCoin: raceCoin,
      MyTimeRecord: withdraw ? 0 : body.TimeRecord, OpponentTimeRecord: withdraw ? 0 : body.OpponentTimeRecord, LeftBoost: body.LeftBoost ?? 0,
      MyMaxSpeed: body.LinearMaxSpeed, MyMaxDriftSpeed: body.CornerMaxSpeed, Withdraw: withdraw,
      ...(win ? {} : { RetryFuel: Number(car.FuelConsume) || 20 }),
      MyCarInfo: { ...car, FinalAttr: faBefore }, NewCars: [],
      UpdateGirlInfo: updateGirl, GgraphPatch: { Gnode: [] },
      Track: { TrackId: race.Track?.TrackId, Thema: race.Track?.Thema, LightingIndex: race.Track?.LightingIndex ?? 0 },
      ...(passenger ? { Passenger: { GirlInfo: passenger } } : {}), PropertySet: snap.PropertySet,
      ...extra,
    },
  }, ...(questChanges.length ? [{ name: 'MsgUpdateNquest', body: { Seq: 2, NquestInfo: questChanges } }] : [])];
});

/** 숙련도 n 증가: MasteryCapacity 까지, 1씩 MasteryAttr 가장 낮은 능력치(동률이면 앞쪽). (기록 3->5, {1,1,1,0}->{2,1,1,1}) */
export function addMastery(car: any, n: number) {
  for (let i = 0; i < n && (Number(car.Mastery) || 0) < (Number(car.MasteryCapacity) || 0); i++) {
    car.Mastery = (Number(car.Mastery) || 0) + 1;
    car.MasteryAttr ??= { AttribMaxSpd: 0, AttribAcc: 0, AttribStability: 0, AttribDrift: 0 };
    const keys = ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift'];
    const low = keys.reduce((a, k) => ((car.MasteryAttr[k] || 0) < (car.MasteryAttr[a] || 0) ? k : a), keys[0]);
    car.MasteryAttr[low] = (car.MasteryAttr[low] || 0) + 1;
    car.DeltaMastery = (Number(car.DeltaMastery) || 0) + 1;
  }
}

// 레이스 보상 수령 (실기록 2-11~2-15):
//   - FirstPlayReward true 면 battleTable FirstPlayRewardItemID x FirstPlayRewardNumItem 지급 (차량이면 RewardInfo.CarInfo, 아니면 ItemInfo)
//   - 레이스 칸 소액 보상 ItemInfo {Itemtype, Count} 지급 (코인이면 RewardInfo.Coin 에도)
//   - RewardBoxKind 1 이면 부품 상자: ★1 부품 1개 (RewardInfo.ItemInfo 와 최상위 ItemInfo, ContainerGrade 1)
//   - 응답 Race 는 수령 전, ChangeRace 는 State 17 / FirstPlayReward false / RewardBoxKind null
register('MsgRaceRewardReq', (body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const { zone, race } = findRace(snap ?? {}, body?.ZoneId, body?.RaceId);
  if (!snap || !zone || !race) return [{ name: 'MsgRaceRewardAns', body: { Seq: 1, Result: 0 } }];
  const before = structuredClone(race);
  const reward: any = { Coin: 0, Charexp: 0, Cash: 0, Familiartity: 0, ItemInfo: [], CarInfo: [] };
  const topItems: any[] = [];
  const newCars: any[] = [];
  if (race.State & ST.CLEAR) {
    const ar = areaRace(zone.ZoneId, race.RaceIndex);
    if (race.FirstPlayReward && ar?.FirstPlayRewardItemID) {
      const id = Number(ar.FirstPlayRewardItemID), n = Number(ar.FirstPlayRewardNumItem) || 1;
      if (carDefOf(id)) {
        for (let i = 0; i < n; i++) { const c = newOwnedCar(snap, id); snap.Cars.CarInfo.push(c); reward.CarInfo.push(c); newCars.push(c); }
      } else if (grantItem(snap, id, n)) {
        reward.ItemInfo.push({ Itemtype: id, Count: n, DeltaNum: n });
        if (id === 61001) reward.Coin += n;
      }
    }
    if (race.ItemInfo?.Itemtype && race.DailyRewardTime === undefined) {
      const { Itemtype, Count } = race.ItemInfo;
      if (grantItem(snap, Number(Itemtype), Number(Count))) {
        reward.ItemInfo.push({ Itemtype, Count, DeltaNum: Count });
        if (Number(Itemtype) === 61001) reward.Coin += Number(Count);
      }
    }
    // 보상 상자 내용: 존 BattleArea.Parts 가중치(★1..5)가 있으면 그 등급 부품 1개, 모두 0 이면 코인 RewardCoin/2
    //   (실기록: 존 1 Parts 0 -> 1-13·1-14 코인 300, 존 2 Parts [1,0,0,0,0] -> 2-12 ★1 부품)
    if (Number(race.RewardBoxKind) === 1) {
      const w: number[] = (areaOf(zone.ZoneId)?.Parts ?? []).map(Number);
      const tot = w.reduce((a, b) => a + (b || 0), 0);
      if (tot > 0) {
        let r = Math.random() * tot, g = 1;
        for (let i = 0; i < w.length; i++) { r -= w[i] || 0; if (r < 0) { g = i + 1; break; } }
        const def = randomPart(g);
        if (def) { const p = grantPart(snap, def); reward.ItemInfo.push(p); topItems.push(p); }
      } else {
        const c = Math.floor((Number(race.RewardCoin) || 0) / 2);
        if (c > 0) { grantItem(snap, 61001, c); reward.Coin += c; reward.ItemInfo.push({ Itemtype: 61001, Count: c, DeltaNum: c }); }
      }
      reward.ContainerGrade = 1;
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
      RewardInfo: reward, ItemInfo: topItems, NewCars: newCars, UserInfo: uiOut,
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
