// 주간 레이스 주행 (허브 '도전' -> 주간, RaceType 3). 실기록 2026-11-03~04: 시작 6건·결과 4건 (WRaceId 2, 트랙 361, 시즌 617).
//   시작 {RaceType 3, WRaceId, BuffFlag} -> 대전 티켓(UserInfo.FightTicket) -1, 연료는 그대로.
//     응답 {Seq, Result 1, UserInfo, NitroReadyNum 0, MyCarInfo, Passenger, GirlsSpecialSkill [], RaceType 3, WRaceId, BuffFlag,
//       Track(트랙 표 전체 + Thema·LightingIndex), RaceInfo {RaceId: WRaceId, RaceMode 2(타임어택), RaceLifeType 1, Track, TimeLimit},
//       Boss 0, ForceWin, MyPosition 0, RaceLevel 1, ReplaySeed}
//   결과 -> {IsPlayerWin, UserInfo, RaceType 3, ItemInfo [], NewCars [], Race {RaceId, RaceMode 2, RaceLifeType 1}, BattleScore, RaceAction,
//       ..., DeltaInfo {Charexp 0, Coin 600, Cash 0}, BaseCoin 600, CoinRatio 1, RaceCoin 600, WraceSet(내 기록이 든 순위), MyWRaceRec, MyCarInfo,
//       GgraphPatch, UpdateGirlInfo} + 퀘스트 목표 Type 1(주간 레이스 참가, 10301 '3회') +1.
// 추정·오프라인: 순위는 혼자라 1위(RankPercent 0), 제한 시간 = 트랙 TotalLength / 23.58 (기록 1건: 1747.57 -> 74.1),
//   패배(시간 초과) 코인 0. 시즌 종료 순위 보상(MsgWRaceRewardReq, 캐시)은 실기록이 없어 미구현.
import { readFileSync, existsSync } from 'node:fs';
import type { Ctx, Msg } from '../rpc.js';
import { table, finalAttr } from '../gamecalc.js';
import { questEvent, refreshQuests } from '../quests.js';
import { evalGirlUnlocks } from '../girlunlock.js';

const WEEK = 7 * 86400;
export const weeklySeason = () => { const t = Math.floor(Date.now() / 1000); return { start: t - (t % WEEK), id: Math.floor(t / WEEK) }; };
let tmpl: any = null;
export function wraceTemplate(): any {
  if (!tmpl) {
    const p = new URL('../../src/data/wrace-template.json', import.meta.url).pathname;
    tmpl = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { WRace: [] };
  }
  return tmpl;
}
const trackFull = (id: number) => (table('trackTable.json')?.Track ?? []).find((x: any) => Number(x.TrackId) === Number(id)) ?? null;
const currentCar = (snap: any) => (snap.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(snap.UserInfo?.Currentcar)) ?? null;

/** 이번 시즌 내 최고 기록 (snap.wraceBest = {season, best: {WRaceId: 초}}).
 *  시즌이 바뀌면 지난 기록은 snap.wracePrev 로 옮기고, 그 결과를 계정 데이터 WraceResult/MyWRaceResult 로 싣는다
 *  (클라이언트는 이 결과가 있을 때 주간 레이스 결과 창과 '보상 받기' -> MsgWRaceRewardReq {WSeasonId} 를 띄운다, misc2.ts).
 *  추정: 결과 형식은 WraceSet/MyWRaceRec 과 같은 모양(클라이언트 GetResultWRace/GetResultMyWRank 가 같은 필드를 읽는다), 혼자라 1위. */
export function myBest(snap: any): Record<string, number> {
  const s = weeklySeason().id;
  if (snap.wraceBest?.season !== s) {
    const old = snap.wraceBest;
    if (old && Object.values(old.best ?? {}).some((t: any) => Number(t) > 0)) {
      snap.wracePrev = { season: Number(old.season), best: old.best };
      const races = wraceTemplate().WRace.map((w: any) => ({ ...w, WSeasonId: Number(old.season),
        Rank: old.best[w.WRaceId] ? [{ Rank: 1, UserName: snap.UserInfo?.Charname ?? '', TimeRecord: old.best[w.WRaceId] }] : [] }));
      const start = Number(old.season) * WEEK;
      snap.WraceResult = { WRace: races, WSeasonId: Number(old.season), StartDate: start, EndDate: start + WEEK, Version: 1 };
      snap.MyWRaceResult = { MyRank: races.map((w: any) => ({ WRaceId: w.WRaceId, LeftTry: 0, TryCost: { Cash: 0 },
        ...(old.best[w.WRaceId] ? { TimeRecord: old.best[w.WRaceId], Rank: 1, RankPercent: 0 } : {}) })) };
    }
    snap.wraceBest = { season: s, best: {} };
  }
  return snap.wraceBest.best;
}
export function myRank(snap: any, races: any[]): any[] {
  const best = myBest(snap);
  return races.map((w: any) => ({ WRaceId: w.WRaceId, LeftTry: 0, TryCost: { Cash: 0 },
    ...(best[w.WRaceId] ? { TimeRecord: best[w.WRaceId], Rank: 1, RankPercent: 0 } : {}) }));
}
export function wraceSet(snap: any): any {
  const { start, id } = weeklySeason();
  const best = myBest(snap);
  const races = wraceTemplate().WRace.map((w: any) => ({ ...w, WSeasonId: id,
    Rank: best[w.WRaceId] ? [{ Rank: 1, UserName: snap.UserInfo?.Charname ?? '', TimeRecord: best[w.WRaceId] }] : [] }));
  return { WRace: races, WSeasonId: id, StartDate: start, EndDate: start + WEEK, Version: 1 };
}

export function weeklyStart(body: any, ctx: Ctx): Msg[] {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = snap && currentCar(snap);
  const w = wraceTemplate().WRace.find((x: any) => Number(x.WRaceId) === Number(body?.WRaceId));
  const ui = snap?.UserInfo;
  if (!snap || !car || !w || (Number(ui.FightTicket) || 0) <= 0) return [{ name: 'MsgBattleStartAns', body: { Seq: 1, Result: 0, ...(ui ? { UserInfo: ui } : {}) } }];
  ui.FightTicket = Number(ui.FightTicket) - 1;
  const tr = trackFull(w.Track?.TrackId);
  const len = Number(tr?.Attrs?.TotalLength ?? w.Track?.Attrs?.TotalLength) || 1750;
  const timeLimit = Math.round((len / 23.58) * 10) / 10;
  snap.wracePending = { id: Number(w.WRaceId), timeLimit };
  ctx.store.putUser(ctx.session.accountId, snap);
  const track = { TrackId: w.Track?.TrackId, Attrs: w.Track?.Attrs ?? tr?.Attrs ?? {}, Thema: w.Track?.Thema, LightingIndex: w.Track?.LightingIndex ?? 0 };
  return [{
    name: 'MsgBattleStartAns',
    body: {
      Seq: 1, Result: 1, UserInfo: ui, NitroReadyNum: 0, MyCarInfo: { ...car, FinalAttr: finalAttr(snap, car) }, Passenger: ui.PassengerGirl ?? 0,
      GirlsSpecialSkill: [], RaceType: 3, WRaceId: Number(w.WRaceId), BuffFlag: Number(body?.BuffFlag) || 0,
      Track: { ...(tr ?? {}), Thema: w.Track?.Thema, LightingIndex: w.Track?.LightingIndex ?? 0 },
      RaceInfo: { RaceId: Number(w.WRaceId), RaceMode: 2, RaceLifeType: 1, Track: track, TimeLimit: timeLimit },
      Boss: 0, ForceWin: !!(ctx.cheat.enabled && ctx.cheat.forceWinBattles), MyPosition: 0, RaceLevel: 1,
      ReplaySeed: Math.floor(Math.random() * 2 ** 31),
    },
  }];
}

export function weeklyResult(body: any, ctx: Ctx): Msg[] {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = snap && currentCar(snap);
  const pend = snap?.wracePending;
  if (!snap || !car || !pend) return [{ name: 'MsgBattleResultAns', body: { Seq: 1, Result: 0 } }];
  delete snap.wracePending;
  const ui = snap.UserInfo;
  const withdraw = !!body.Withdraw;
  const win = !withdraw && !!body.IsPlayerWin;
  const coin = win ? 600 : 0;
  ui.Coin = (Number(ui.Coin) || 0) + coin;
  const t = Number(body.TimeRecord) || 0;
  const best = myBest(snap);
  if (win && t > 0 && (!best[pend.id] || t < best[pend.id])) best[pend.id] = t;
  if (!withdraw) questEvent(snap, 1, () => true);
  const questChanges = refreshQuests(snap);
  // 연락처 해금 조건 9(주간 레이스 컷오프) 재평가: 노드는 GgraphPatch, 캐릭터 레이스 상태는 다음 로그인 데이터로 반영 (girlunlock.ts)
  const unlock = win ? evalGirlUnlocks(snap) : { nodes: [] as any[] };
  ctx.store.putUser(ctx.session.accountId, snap);
  const set = wraceSet(snap);
  const action = [2, 3, 4, 5, 6].map((a, i) => ({ Action: a, Count: Number([body.MissCnt, body.BadCnt, body.GoodCnt, body.PerfectCnt, body.ExcellentCnt][i]) || 0 }));
  return [{
    name: 'MsgBattleResultAns',
    body: {
      Seq: 1, Result: 1, IsPlayerWin: win, UserInfo: ui, RaceType: 3, RaceLevel: 1, ItemInfo: [], NewCars: [],
      Race: { RaceId: pend.id, RaceMode: 2, RaceLifeType: 1 }, BattleScore: withdraw ? 0 : Number(body.BattleScore) || 0,
      RaceAction: { Action: action, ComboCount: Number(body.ComboCount) || 0 }, BoostCompensation: 0, PerfectStart: !!body.PerfectStart,
      MyTimeRecord: withdraw ? 0 : t, OpponentTimeRecord: 0, LeftBoost: body.LeftBoost ?? 0, MyMaxSpeed: body.LinearMaxSpeed,
      MyMaxDriftSpeed: body.CornerMaxSpeed, Withdraw: withdraw, DeltaInfo: { Charexp: 0, Coin: coin, Cash: 0 },
      BaseCoin: 600, CoinRatio: 1, ...(win ? { RaceCoin: coin } : {}), WraceSet: set, MyWRaceRec: { MyRank: myRank(snap, set.WRace) },
      MyCarInfo: { ...car, FinalAttr: finalAttr(snap, car) }, GgraphPatch: { Gnode: unlock.nodes }, UpdateGirlInfo: [],
    },
  }, ...(questChanges.length ? [{ name: 'MsgUpdateNquest', body: { Seq: 2, NquestInfo: questChanges } }] : [])];
}
