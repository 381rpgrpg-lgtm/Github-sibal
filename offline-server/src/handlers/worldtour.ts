// 월드 투어 (허브 '도전' -> 월드 투어, 비동기 대전 RaceType 4). 실기록 2026-11-05 (시즌 142, 봇 계정 1개):
//   열기 6건, 매칭 4건, 시작 4건, 결과 4건 (승·패·승·승: 세 번째 결과로 배치 끝 -> 브론즈 5, 네 번째 승리로 브론즈 4).
// 흐름 (클라이언트 SSWorldRace / SSMatching / startWorldTourRace):
//   MsgOpenWorldTourReq {Cmd 1} -> MsgOpenWorldTourAns {Seq, Cmd, WorldTour, MyWorldTour, MyWorldTourHOFInfo} (+ 지난 시즌 결과)
//   MsgBattleMatchReq {} -> MsgBattleMatchAns {MatchEndTime, MyWorldTour, UserInfo, Track} + MsgBattleMatchResult {상대, MyRecord,
//     OpponentRecord, MatchReward, MatchTourType, BattleStartTime, Track} (같은 응답에 둘 다). 대전 티켓 -1, LeftTry -1 (실기록 29->28->27->26, 7->6->5->4).
//     실패: Result 7 = 캐시 부족(buy_cash 팝업), 3 = 코인 부족, 그 외는 클라이언트가 조용히 무시 (OnDispatch_MsgBattleMatchAns).
//   카운트다운(BattleStartTime) 뒤 MsgBattleStartReq {RaceType 4} -> 연료 소모 없음. 결과 MsgBattleResultReq {RaceType 4, ..., OpponentTimeRecord,
//     OpponentTimeEstimated} (상대 시간은 클라이언트가 OpponentCarInfo.Attributes 로 주행을 흉내 내 계산한다: engine raceSim.projectFinishTime).
//   매칭 중 나가기 MsgStopMatchReq -> MsgStopMatchAns {MyWorldTour} (도움말: 나가도 참가 횟수는 쓴 것으로 친다).
// 실서버 상대는 다른 계정(봇 포함)이다. 오프라인은 내 차 성능 근처로 만든 봇 (아래 makeBot, 전부 추정).
import { register, type Ctx, type Msg } from '../rpc.js';
import { table, finalAttr, carDefOf, carName, ATTRS, syncGirl } from '../gamecalc.js';
import { nextResetSec } from '../daily.js';
import { questEvent, refreshQuests } from '../quests.js';
import { levelUp } from './battle.js';

const R_OK = 1, R_FAIL = 2, R_NO_CASH = 7;
const vconst = (name: string, def: number): number => {
  const r = (table('vconstTable.json')?.Vconst ?? []).find((x: any) => x?.Name === name);
  const v = Number(r?.Val?.[0] ?? r?.Dval);
  return Number.isFinite(v) && r ? v : def;
};
const FREE_TRY = () => vconst('WorldTourFreeTryCount', 7);       // 하루 무료 참가 7 (실기록 LeftTry 7)
const NEED_TICKET = () => vconst('fightRaceNeededTicket', 1);     // 매칭마다 대전 티켓 1 (실기록 29 -> 28 -> 27 -> 26)
const SEARCH_SEC = () => vconst('WTMatchingSearchingTime', 7);    // MatchEndTime = 요청 + 7초 (실기록 4건 6.93~6.96초)
const WIN_POINT = () => vconst('WTMatchingWinFactor', 50);        // MatchReward.WinRacePoint 50 / DeltaPvpPoint +50 (실기록)
const LOSE_POINT = () => vconst('WTMatchingLoseFactor', -40);     // MatchReward.LoseRacePoint -40 / DeltaPvpPoint -40 (실기록)
const HOF_POINT = () => vconst('WTHOFDefaultRankPoint', 1500);    // MyWorldTourHOFInfo.RankPoint 1500 (실기록)
const COUNTDOWN = 3;            // BattleStartTime = MatchEndTime + 3 (실기록 4건)
const PLACEMENT = 3;            // 언랭크 배치 경기 수: BeginRankTierGrade 3 (실기록), 도움말 '언랭크에서 3회 참가'
const SPONSOR_BONUS = 500;      // MatchReward.SponsorBonus 500, 승리 시 DeltaSponsorBonus 500 (실기록 4건, 언랭크·브론즈 5). 추정: 등급과 관계없이 500
const WIN_COIN = 600;           // 승리 Coin 600 = BaseCoin 600 x CoinRatio 1 (실기록 3건), 패배 0
const TOKEN = { win: 3, lose: 1 }; // DeltaInfo.Token 승 3 / 패 1 (실기록)
const FAMILIARITY = 10;         // 동승 캐릭터 친밀도 +10 (실기록 4건 940->950->960, 1609->1619, 2089->2099, 승패 모두)
const HISTORY_MAX = 20;         // 추정: TourHistory 보관 개수 (실기록 최대 4건, 최신이 앞)
const TRY_CASH = 5;             // 추정: 무료 참가(LeftTry)를 다 쓴 뒤 1회 참가비 TryCost.Cash (실기록은 LeftTry > 0 이라 늘 0)
const TRACK = { TrackId: 383, Thema: 2, LightingIndex: 0 }; // 실기록 4건 모두 383 / Thema 2. 추정: 시즌·매칭과 관계없이 고정
// 승격전 연승 수 (등급 = 승격 전 등급): 브론즈1->실버 2 (실기록 StraightWinMaxCount 2), 실버1->골드 3, 골드1->플래티넘 4,
//   플래티넘1->다이아 5 (도움말 world_tour_help_left_grade_1~4. 골드1 은 한국어·일본어 4연승, 영어 3연승 -> 4). 다이아 0.
const STRAIGHT: Record<number, number> = { 1: 0, 2: 5, 3: 4, 4: 3, 5: 2 };

// ── 시즌: 미국 태평양 시각 달력 월 (실기록 StartDate 1793516400 = 11-01 00:00 PDT, EndDate 1796112000 = 12-01 00:00 PST).
//   SeasonId = (년-2015)x12 + (월-1) = 142 (2026-11), Season = SeasonId + 1 = 143.
const TZ = 'America/Los_Angeles';
let fmt: Intl.DateTimeFormat | null = null;
function laParts(ms: number): { y: number; m: number; d: number; h: number } {
  try {
    fmt ??= new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour };
  } catch {
    const t = new Date(ms - 8 * 3600_000); // ICU 없는 환경: PST 고정
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours() };
  }
}
/** 그 달 1일 태평양 자정 (초) */
function monthStart(y: number, m: number): number {
  for (const off of [7, 8]) {
    const t = Date.UTC(y, m - 1, 1, off);
    const p = laParts(t);
    if (p.d === 1 && p.h === 0) return t / 1000;
  }
  return Date.UTC(y, m - 1, 1, 8) / 1000;
}
export function worldTourSeason(nowMs = Date.now()) {
  const { y, m } = laParts(nowMs);
  const id = (y - 2015) * 12 + (m - 1);
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { SeasonId: id, StartDate: monthStart(y, m), EndDate: monthStart(ny, nm), Year: y, Month: m, Season: id + 1, IsPreSeason: false };
}

const uid = (ctx: Ctx) => ctx.session.accountId;
const now = () => Date.now() / 1000;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const rint = (a: number, b: number) => Math.floor(rnd(a, b + 1));
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const sumAttr = (a: any) => ATTRS.reduce((s, k) => s + (Number(a?.[k]) || 0), 0);
const currentCar = (snap: any) => (snap.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(snap.UserInfo?.Currentcar)) ?? null;
const trackFull = (id: number) => (table('trackTable.json')?.Track ?? []).find((x: any) => Number(x.TrackId) === Number(id)) ?? null;
const trackShort = () => ({ TrackId: TRACK.TrackId, Attrs: trackFull(TRACK.TrackId)?.Attrs ?? {}, Thema: TRACK.Thema, LightingIndex: TRACK.LightingIndex });

/** 새 시즌 기록 (키 순서는 실기록 MyWorldTour) */
function freshRecord(charmMax = 0): any {
  return {
    Rank: 0, RankTier: 6, RankTierGrade: PLACEMENT, BeginRankTierGrade: PLACEMENT, SponsorBonus: 0, TryCount: 0, WinCount: 0, LoseCount: 0,
    PvpPoint: 0, RankPoint: 0, CharmPoint: 0, CharmMaxPoint: charmMax, CarPoint: 0, TunningPoint: 0, StraightWinMaxCount: 0, StraightWinCount: 0,
    LeftTry: FREE_TRY(), TryCost: { Cash: 0 }, TourHistory: { TourResult: [], Version: 1 },
  };
}

/** 매력·차량 포인트. 실기록과 일치: CharmPoint = 모든 캐릭터 Familiarity 합 (15578), CharmMaxPoint = 지금까지 CharmPoint 최댓값
 *  (로그인 기록에서 함께 오르다가 CharmPoint 가 20833 -> 15103 으로 내려가도 20833 유지), CarPoint = 보유 차량 Attributes 합의 최댓값 (1178).
 *  실서버는 열기·매칭 때 갱신한다 (결과 응답 MyWorldTour 의 CharmPoint 는 그 판의 친밀도 증가 전 값). */
function refreshPoints(snap: any, mwt: any) {
  mwt.CharmPoint = (snap.MyGirls?.MyGirlInfo ?? []).reduce((s: number, g: any) => s + Math.max(0, Number(g.Familiarity) || 0), 0);
  mwt.CharmMaxPoint = Math.max(Number(mwt.CharmMaxPoint) || 0, mwt.CharmPoint);
  mwt.CarPoint = Math.max(0, ...(snap.Cars?.CarInfo ?? []).map((c: any) => sumAttr(c.Attributes)));
}

/** 시즌·일일 상태를 맞춘다. 내부 상태는 snap.wtState {tryReset}, 진행 중 매칭은 snap.wtMatch. */
function ensure(snap: any, nowMs = Date.now()): any {
  const season = worldTourSeason(nowMs);
  const st = (snap.wtState ??= {});
  const prev = snap.WorldTour;
  if (!snap.MyWorldTour) { snap.MyWorldTour = freshRecord(); st.tryReset = nextResetSec(nowMs); }
  if (prev && Number(prev.SeasonId) < season.SeasonId) {
    // 시즌 교체: 지난 기록을 MyWorldTourResult/WorldTourResult 로 (MsgWorldTourRewardReq 가 읽는다, misc2.ts).
    //   추정: 배치(언랭크)로 끝난 시즌은 보상이 없으므로 결과를 만들지 않는다 (보상 표는 Rank 1~5, 클라이언트 '언랭크는 보상 없음').
    //   추정: 새 시즌은 언랭크 배치부터 다시 (실기록 시즌 142 시작 기록이 RankTier 6).
    const old = snap.MyWorldTour;
    if (Number(old.RankTier) <= 5 && Number(old.TryCount) > 0) {
      const { TourHistory, ...res } = old;
      snap.MyWorldTourResult = res;
      snap.WorldTourResult = { ...prev };
    }
    snap.MyWorldTour = freshRecord(Number(old.CharmMaxPoint) || 0);
    st.tryReset = nextResetSec(nowMs);
    delete snap.wtMatch;
  }
  snap.WorldTour = season;
  snap.MyWorldTourHOFInfo ??= { Rank: 0, MaxRank: 0, RankPoint: HOF_POINT(), BackupRacerState: 0, BackupRacerEnabledTime: 0 };
  const mwt = snap.MyWorldTour;
  mwt.TourHistory ??= { TourResult: [], Version: 1 };
  // 하루 무료 참가: 태평양 자정에 7 로 (추정: 일일 초기화와 같은 기준 시각. 실서버 스냅샷 값은 다음 기준 시각까지 그대로 둔다)
  if (!Number(st.tryReset)) st.tryReset = nextResetSec(nowMs);
  else if (nowMs / 1000 >= Number(st.tryReset)) { mwt.LeftTry = FREE_TRY(); st.tryReset = nextResetSec(nowMs); }
  mwt.TryCost = { Cash: Number(mwt.LeftTry) > 0 ? 0 : TRY_CASH };
  return mwt;
}
const recordOut = (mwt: any) => structuredClone(mwt);
const recordNoHistory = (mwt: any) => { const { TourHistory, ...r } = mwt; return structuredClone(r); };

// ── 오프라인 상대 (전부 추정). 실서버 상대 4건: 언랭크 3 등급 계정, 차량 능력치 합 676·3726·400·1665 (내 차 2332) - 성능이 아니라 순위로 매칭.
//   오프라인은 혼자라 '내 최종 능력치 합 x 배율' 로 만든다. 배율은 등급이 오를수록 높게 (언랭크 0.70~0.95 ... 다이아 0.95~1.12).
//   참고 (실기록): 내 차 2332 완벽 주행 63.6~64.3초, 상대 추정 시간 400 -> 69.0초, 676 -> 67.9초, 1665 -> 66.0초, 3726 -> 63.0초.
//   상대 능력치가 경험치도 정한다 (결과 주석).
const FACTOR: Record<number, [number, number]> = { 6: [0.7, 0.95], 5: [0.75, 1.0], 4: [0.8, 1.03], 3: [0.85, 1.06], 2: [0.9, 1.09], 1: [0.95, 1.12] };
const NAME_A = ['Neo', 'Kaze', 'Red', 'Blue', 'Night', 'Drift', 'Turbo', 'Ghost', 'Silver', 'Mad', 'Lucky', 'Rapid', 'Iron', 'Shadow', 'Storm', 'Zero', 'Midnight', 'Apex'];
const NAME_B = ['Racer', 'Rider', 'Fox', 'Wolf', 'Hawk', 'Cat', 'King', 'Ace', 'Star', 'Bolt', 'Jet', 'Tiger', 'Runner', 'Queen', 'Kid', 'Line'];
const botName = () => pick(NAME_A) + pick(NAME_B) + (Math.random() < 0.5 ? String(rint(1, 99)) : '');

function makeBot(snap: any, car: any, mwt: any) {
  const ui = snap.UserInfo;
  const tier = Math.min(6, Math.max(1, Number(mwt.RankTier) || 6));
  const [lo, hi] = FACTOR[tier];
  const target = Math.max(400, Math.round(sumAttr(finalAttr(snap, car)) * rnd(lo, hi)));
  // 차종: 내 차 등급 +-1, 뽑기 대상(Distribute > 0), 기본 능력치 합이 목표 이하. 없으면 같은 등급 아무거나.
  const myGrade = Number(car.Grade) || Number(carDefOf(car.Cartype)?.Grade) || 1;
  const all: any[] = (table('cars.json')?.Car ?? []).filter((c: any) => Number(c.Distribute) > 0 && c.Attributes);
  let pool = all.filter((c) => Math.abs(Number(c.Grade) - myGrade) <= 1 && sumAttr(c.Attributes) <= target);
  if (!pool.length) pool = all.filter((c) => Number(c.Grade) === myGrade);
  if (!pool.length) pool = all;
  const d = pick(pool) ?? { Id: 10101, Grade: 1, Attributes: { AttribMaxSpd: 100, AttribAcc: 100, AttribStability: 100, AttribDrift: 100 } };
  const base = sumAttr(d.Attributes) || 1;
  const Attributes: any = {};
  for (const k of ATTRS) Attributes[k] = Math.round((Number(d.Attributes[k]) || 0) * target / base);
  const grade = Number(d.Grade) || 1;
  const cap = Number(d.SoftLimit) || 40;
  const mastery = Math.round(cap * Math.random());
  const q = Math.floor(mastery / 4);
  const fuel = 15 + 5 * grade; // 실기록: 등급 1 -> 20, 2 -> 25, 4 -> 35
  const carid = rint(1, 60);
  // OpponentCarInfo.Attributes = 상대 주행 능력치 그대로 (클라이언트 enemyAttributes, 매칭 화면 성능 비교). 키 순서는 실기록.
  const oppCar = {
    Carid: carid, Cartype: Number(d.Id), ItemInfo: [], UpgradeLevel: Math.min(10, Math.max(1, 1 + Math.floor((target / base - 1) / 0.08))),
    SlotNum: Number(d.SlotInit) || 1, Mastery: mastery, Price: Number(d.SellPrice) || 100, Attributes, MasteryCapacity: cap,
    MasteryAttr: { AttribMaxSpd: q + (mastery - 4 * q), AttribAcc: q, AttribStability: q, AttribDrift: q },
    FuelConsume: fuel, FuelConsume20404: Math.round(fuel * 0.65), NthGeneration: 1, IsExhibited: false,
    ColorTable: d.ColorTable, ColorIndex: Number(d.ColorIndex) || 1, DecalIndex: -1, PlateName: '', CoatingSkill: 0, CoatingValue: 0,
    CoatingCount: 0, CoatingTime: 0, CoatingCoin: 8000, Grade: grade, CarName: carName(Number(d.Id)), IsLocked: false, ExpansionLevel: 0,
    CarExp: 0, OwnedColors: [Number(d.ColorIndex) || 1], CarEffect: [], DeltaMastery: 0,
  };
  const maxLv = Math.max(1, ...(table('playerLevelTable.json')?.Level ?? []).map((r: any) => Number(r.Id) || 0));
  const name = botName();
  const charid = rint(100000, 999999);
  const girls: any[] = (table('girlTable.json')?.Girl ?? []).filter((g: any) => Number(g.Id) < 20900 && Number(g.Rarity) <= grade);
  const user = {
    Charname: name, Charlevel: Math.min(maxLv, Math.max(1, (Number(ui.Charlevel) || 1) + rint(-4, 4))), Currentcar: carid,
    MainGirl: Number(ui.FirstGirl) || 20105, PassengerGirl: Number(pick(girls)?.Id) || 0,
    UserId: { Sid: 0, Charid: charid, Accountid: String(charid), Charname: name },
  };
  // 상대 기록 (TourHistory 없음, 키 순서는 실기록 OpponentRecord). 언랭크 상대는 실기록처럼 새 시즌 계정 모양.
  const rec: any = { ...recordNoHistory(freshRecord()), LeftTry: FREE_TRY(), TryCost: { Cash: 0 } };
  if (tier <= 5) {
    const w = rint(3, 30), l = rint(1, 25);
    Object.assign(rec, {
      RankTier: tier, RankTierGrade: Math.min(5, Math.max(1, (Number(mwt.RankTierGrade) || 5) + rint(-1, 1))), BeginRankTierGrade: 5,
      SponsorBonus: w * SPONSOR_BONUS, TryCount: w + l, WinCount: w, LoseCount: l, PvpPoint: Math.max(0, w * WIN_POINT() + l * LOSE_POINT()),
      CharmPoint: rint(2000, 40000), CarPoint: base, StraightWinMaxCount: STRAIGHT[tier] ?? 0, LeftTry: rint(0, FREE_TRY()),
    });
    rec.RankPoint = rec.PvpPoint;
    rec.CharmMaxPoint = rec.CharmPoint + rint(0, 3000);
  }
  return { car: oppCar, user, record: rec };
}

// ── 순위 (추정이 많다). 실기록: 언랭크 3 -> 2 -> 1 (승패 무관 한 판마다 RankTierGrade -1, 화면 '첫 승격까지 남은 경기 수'),
//   세 번째 결과에서 RankTier 5(브론즈) RankTierGrade 5, BeginRankTierGrade 5, StraightWinMaxCount 2, StraightWinCount 0 (2승 1패, 매력 15841),
//   네 번째(승) 브론즈 5 -> 4 (StraightWinCount 0 그대로).
//   추정: 배치 등급은 매력 포인트 / vconst FMPointMax 비율로 브론즈 5 ~ 실버 5 (도움말 '매력 포인트가 최대일 때 실버5 로 시작'),
//     배치 3전 전승이면 한 단계 위. 브론즈~플래티넘은 승리 시 등급 -1(1 이 최상, 실기록 5 -> 4), 패배 시 +1(최대 5, 아래 티어로 강등 없음).
//     등급 1 에서는 승격전: 연승(StraightWinCount)이 StraightWinMaxCount 에 닿으면 위 티어 5 등급, 패배하면 연승 0·등급 2.
//     다이아(1)는 변동 없음 (명예의 전당 순위·ELO 는 미구현).
function setTier(mwt: any, tier: number, grade: number) {
  mwt.RankTier = tier; mwt.RankTierGrade = grade;
  mwt.StraightWinMaxCount = STRAIGHT[tier] ?? 0; mwt.StraightWinCount = 0;
}
function applyRank(snap: any, mwt: any, win: boolean) {
  const tier = Number(mwt.RankTier) || 6;
  if (tier >= 6) {
    mwt.RankTierGrade = Math.max(0, (Number(mwt.RankTierGrade) || PLACEMENT) - 1);
    if (mwt.RankTierGrade > 0) return;
    const ratio = (Number(mwt.CharmPoint) || 0) / Math.max(1, vconst('FMPointMax', 1701286));
    const idx = Math.min(5, Math.floor(ratio * 5) + (Number(mwt.WinCount) >= PLACEMENT ? 1 : 0));
    const [t, g] = idx >= 5 ? [4, 5] : [5, 5 - idx];
    setTier(mwt, t, g);
    mwt.BeginRankTierGrade = g;
    return;
  }
  if (tier <= 1) return;
  const g = Number(mwt.RankTierGrade) || 5;
  if (!win) { mwt.StraightWinCount = 0; mwt.RankTierGrade = Math.min(5, g + 1); return; }
  if (g > 1) { mwt.RankTierGrade = g - 1; return; }
  mwt.StraightWinCount = (Number(mwt.StraightWinCount) || 0) + 1;
  if (mwt.StraightWinCount >= (Number(mwt.StraightWinMaxCount) || STRAIGHT[tier])) setTier(mwt, tier - 1, tier - 1 === 1 ? 1 : 5);
}

// ── 열기
register('MsgOpenWorldTourReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  if (!snap) return [{ name: 'MsgOpenWorldTourAns', body: { Seq: 1, Cmd: Number(body?.Cmd) || 1 } }];
  const mwt = ensure(snap);
  refreshPoints(snap, mwt);
  ctx.store.putUser(uid(ctx), snap);
  return [{
    name: 'MsgOpenWorldTourAns',
    body: {
      Seq: 1, Cmd: Number(body?.Cmd) || 1, WorldTour: snap.WorldTour, MyWorldTour: recordOut(mwt), MyWorldTourHOFInfo: snap.MyWorldTourHOFInfo,
      // 지난 시즌 결과가 있으면 클라이언트가 보상 창(WorldTourRewardPopup -> MsgWorldTourRewardReq)을 띄운다
      ...(snap.MyWorldTourResult ? { WorldTourResult: snap.WorldTourResult ?? null, MyWorldTourResult: snap.MyWorldTourResult } : {}),
    },
  }];
});

// ── 매칭: 티켓·참가 횟수는 매칭 때 쓴다 (실기록: 매칭 응답 LeftTry 6, TryCount 0 -> 결과 때 TryCount 1)
register('MsgBattleMatchReq', (_body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  const car = snap && currentCar(snap);
  const fail = (result: number, why: string): Msg[] => {
    console.warn(`[worldtour] 매칭 거절: ${why}`);
    return [{ name: 'MsgBattleMatchAns', body: { Seq: 1, Result: result, ...(snap?.MyWorldTour ? { MyWorldTour: recordOut(snap.MyWorldTour) } : {}), ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  };
  if (!snap || !car) return fail(R_FAIL, '계정·차량 없음');
  const ui = snap.UserInfo;
  const mwt = ensure(snap);
  const need = NEED_TICKET();
  if ((Number(ui.FightTicket) || 0) < need) return fail(R_FAIL, `대전 티켓 부족 (${ui.FightTicket ?? 0})`); // 클라이언트는 보내기 전에 막는다
  const cash = Number(mwt.LeftTry) > 0 ? 0 : Number(mwt.TryCost?.Cash) || 0;
  if (cash > (Number(ui.Cash) || 0)) return fail(R_NO_CASH, `참가 캐시 부족 (${cash})`);
  ui.FightTicket = Number(ui.FightTicket) - need;
  if (cash) ui.Cash = Number(ui.Cash) - cash;
  else mwt.LeftTry = Math.max(0, Number(mwt.LeftTry) - 1);
  mwt.TryCost = { Cash: mwt.LeftTry > 0 ? 0 : TRY_CASH };
  refreshPoints(snap, mwt);
  const bot = makeBot(snap, car, mwt);
  const t = now();
  const matchEnd = Math.round((t + SEARCH_SEC()) * 1000) / 1000;
  // MatchTourType: 1·4 = 접속 중인 상대(라이브 표시), 2 = 오프라인 상대 (클라이언트 #EnemyDataLoad; 실기록 2·1·2). 봇은 2.
  //   결과 TourResult.TourType 도 이 값 (실기록 승 2, 패 1 - 승패가 아니라 상대 종류).
  const match = {
    at: t, user: bot.user, car: bot.car, record: bot.record, tourType: 2,
    reward: { SponsorBonus: SPONSOR_BONUS, WinRacePoint: WIN_POINT(), LoseRacePoint: LOSE_POINT() },
  };
  snap.wtMatch = match;
  ctx.store.putUser(uid(ctx), snap);
  const track = trackShort();
  return [
    { name: 'MsgBattleMatchAns', body: { Seq: 1, Result: R_OK, MatchEndTime: matchEnd, MyWorldTour: recordOut(mwt), UserInfo: ui, Track: track } },
    {
      name: 'MsgBattleMatchResult',
      body: {
        Seq: 2, Result: R_OK, OpponentUserInfo: match.user, OpponentCarInfo: match.car, MyRecord: recordOut(mwt), OpponentRecord: match.record,
        MatchReward: match.reward, MatchTourType: match.tourType, BattleStartTime: Math.round((matchEnd + COUNTDOWN) * 1000) / 1000, Track: track,
      },
    },
  ];
});

// ── 매칭 중단 (기록 없음, 클라이언트 OnDispatch_MsgStopMatchAns / ApplyMyWorldTour 기준). 쓴 티켓·참가 횟수는 돌려주지 않는다 (도움말).
register('MsgStopMatchReq', (_body, ctx): Msg[] => {
  const snap = ctx.store.getUser(uid(ctx));
  if (!snap) return [{ name: 'MsgStopMatchAns', body: { Seq: 1, Result: R_FAIL } }];
  const mwt = ensure(snap);
  delete snap.wtMatch;
  ctx.store.putUser(uid(ctx), snap);
  return [{ name: 'MsgStopMatchAns', body: { Seq: 1, Result: R_OK, MyWorldTour: recordOut(mwt) } }];
});

// ── 시작 {RaceType 4}: 연료·티켓 소모 없음 (실기록: 매칭 후와 같은 UserInfo). 응답 키는 실기록 순서.
export function worldTourStart(body: any, ctx: Ctx): Msg[] {
  const snap = ctx.store.getUser(uid(ctx));
  const car = snap && currentCar(snap);
  const m = snap?.wtMatch;
  if (!snap || !car || !m) return [{ name: 'MsgBattleStartAns', body: { Seq: 1, Result: R_FAIL, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  const ui = snap.UserInfo;
  m.started = now();
  ctx.store.putUser(uid(ctx), snap);
  const tr = trackFull(TRACK.TrackId);
  return [{
    name: 'MsgBattleStartAns',
    body: {
      Seq: 1, Result: R_OK, UserInfo: ui, NitroReadyNum: 0, // 추정: 니트로 아이템 미사용 (실기록 0, 다만 기록 계정에 니트로 아이템이 없었다)
      MyCarInfo: { ...car, FinalAttr: finalAttr(snap, car) }, Passenger: ui.PassengerGirl ?? 0, GirlsSpecialSkill: [], RaceType: 4,
      Track: { ...(tr ?? { TrackId: TRACK.TrackId }), Thema: TRACK.Thema, LightingIndex: TRACK.LightingIndex },
      RaceInfo: { RaceId: 0, RaceMode: 1, RaceLifeType: 1, Track: trackShort() },
      OpponentCarInfo: m.car, OpponentUserInfo: m.user, OpponentName: m.user.Charname, IsMultiPlay: false, Boss: 0,
      ForceWin: !!(ctx.cheat.enabled && ctx.cheat.forceWinBattles), MyPosition: 0, RaceLevel: Number(body?.RaceLevel) || 1,
      StartTime: Math.round(now() * 1000) / 1000, ReplaySeed: Math.floor(Math.random() * 2 ** 31),
    },
  }];
}

// ── 결과. 실기록 (승 3건·패 1건):
//   승: DeltaInfo {Charexp, Coin 600, Cash 0, Token 3, SponsorBonus 500}, BaseCoin 600, CoinRatio 1, RaceCoin 600, ClearRec {Grade, Flag 0}
//   패: DeltaInfo {Charexp, Coin 0, Cash 0, Token 1, SponsorBonus 0}, BaseCoin 0, CoinRatio 1 (RaceCoin·ClearRec 없음)
//   SponsorBonus 는 MyWorldTour.SponsorBonus 에 쌓일 뿐 코인으로 주지 않는다 (UserInfo.Coin +600 만. 도움말: 시즌 종료 때 받는다).
//   MyWorldTour: TryCount·WinCount/LoseCount +1, PvpPoint +50/-40, RankPoint = PvpPoint, 순위 갱신 (applyRank),
//   TourResult (TourHistory 맨 앞에 추가, Version +1). 동승 캐릭터 친밀도 +10 -> UpdateGirlInfo. 퀘스트 목표 Type 1 [n, 4000](월드 투어 참가) +1.
// 경험치: 스토리 레이스와 같은 꼴. 기준 = round(30 + 상대 OpponentCarInfo.Attributes 합 / 20) (스토리 RewardXP = round(30 + Difficulty/20)),
//   승리는 기준 그대로, 패배는 floor((기준 + 1) x 0.3) (스토리 패배 공식). 실기록 4건 모두 일치: 합 676 승 64, 3726 패 65, 400 승 50, 1665 승 113.
// 추정: 기권(Withdraw)은 패배로 처리, 차량 숙련도 변화 없음 (기록 차량은 숙련도가 가득이라 미확인), PvpPoint 는 0 아래로 내려가지 않음.
export function worldTourResult(body: any, ctx: Ctx): Msg[] {
  const snap = ctx.store.getUser(uid(ctx));
  const car = snap && currentCar(snap);
  const m = snap?.wtMatch;
  if (!snap || !car || !m) return [{ name: 'MsgBattleResultAns', body: { Seq: 1, Result: R_FAIL, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  delete snap.wtMatch;
  const ui = snap.UserInfo;
  const mwt = ensure(snap);
  const withdraw = !!body?.Withdraw;
  const win = !withdraw && (!!body?.IsPlayerWin || !!(ctx.cheat.enabled && ctx.cheat.forceWinBattles));
  const myTime = withdraw ? 0 : Number(body?.TimeRecord) || 0;
  const oppTime = withdraw ? 0 : Number(body?.OpponentTimeRecord) || 0;
  const faBefore = finalAttr(snap, car);

  const coin = win ? WIN_COIN : 0;
  const token = win ? TOKEN.win : TOKEN.lose;
  const sponsor = win ? Number(m.reward?.SponsorBonus) || 0 : 0;
  const deltaPoint = win ? Number(m.reward?.WinRacePoint) || 0 : Number(m.reward?.LoseRacePoint) || 0;
  const baseXp = Math.round(30 + sumAttr(m.car?.Attributes) / 20);
  const xp = win ? baseXp : Math.floor((baseXp + 1) * 0.3);
  ui.Coin = (Number(ui.Coin) || 0) + coin;
  ui.Token = (Number(ui.Token) || 0) + token;
  ui.Charexp = (Number(ui.Charexp) || 0) + xp;
  delete ui.LevelUp;
  levelUp(snap);

  const tierBefore = Number(mwt.RankTier) || 6, gradeBefore = Number(mwt.RankTierGrade) || 0;
  mwt.TryCount = (Number(mwt.TryCount) || 0) + 1;
  if (win) mwt.WinCount = (Number(mwt.WinCount) || 0) + 1; else mwt.LoseCount = (Number(mwt.LoseCount) || 0) + 1;
  mwt.PvpPoint = Math.max(0, (Number(mwt.PvpPoint) || 0) + deltaPoint);
  mwt.RankPoint = mwt.PvpPoint;
  mwt.SponsorBonus = (Number(mwt.SponsorBonus) || 0) + sponsor;
  applyRank(snap, mwt, win);

  const action = [2, 3, 4, 5, 6].map((a, i) => ({ Action: a, Count: Number([body?.MissCnt, body?.BadCnt, body?.GoodCnt, body?.PerfectCnt, body?.ExcellentCnt][i]) || 0 }));
  const raceAction = { Action: action, ComboCount: Number(body?.ComboCount) || 0 };
  // TourResult.MyCarInfo: 내 차 레코드에 Attributes = 이번 판 최종 능력치 (실기록 {386,678,590,678} = 시작 응답 FinalAttr), FinalAttr 키 없음
  const { FinalAttr: _fa, ...carRec } = car;
  const tourResult = {
    Result: win ? 1 : 2, TourType: m.tourType, SeasonId: snap.WorldTour.SeasonId, NthRace: mwt.TryCount, DeltaPvpPoint: deltaPoint,
    DeltaSponsorBonus: sponsor, OppUserId: m.user.UserId, OpponentRankTier: Number(m.record?.RankTier) || 6,
    OpponentRankTierGrade: Number(m.record?.RankTierGrade) || 0, OpponentCarInfo: m.car, TourDate: Math.floor(now()),
    MyCarInfo: { ...structuredClone(carRec), Attributes: faBefore, DeltaMastery: 0 }, MyActionlist: raceAction,
    MyTimeRecord: myTime, OppTimeRecord: oppTime, MyRankTier: tierBefore, MyRankTierGrade: gradeBefore,
  };
  const hist = mwt.TourHistory;
  hist.TourResult = [tourResult, ...(hist.TourResult ?? [])].slice(0, HISTORY_MAX);
  hist.Version = (Number(hist.Version) || 1) + 1;

  // 동승 캐릭터 친밀도 (실기록: 승패 모두 +10, UpdateGirlInfo 에 그 캐릭터 레코드)
  const updateGirl: any[] = [];
  const pg = (snap.MyGirls?.MyGirlInfo ?? []).find((g: any) => Number(g.Girlid) === Number(ui.PassengerGirl) && Number(g.State) === 7);
  if (pg && Number(pg.Emotion) !== 1) { pg.Familiarity = (Number(pg.Familiarity) || 0) + FAMILIARITY; syncGirl(pg); updateGirl.push(pg); } // 삐침(1)이면 오르지 않음 (클라이언트 안내)
  if (!withdraw) questEvent(snap, 1, (p) => Number(p[1]) === 4000); // 퀘스트 17999 '월드 투어 70회 참가' [70, 4000]
  const questChanges = refreshQuests(snap);
  ctx.store.putUser(uid(ctx), snap);

  const miss = Number(body?.MissCnt) || 0, bad = Number(body?.BadCnt) || 0;
  const grade = miss === 0 && bad === 0 ? 1 : miss === 0 ? 2 : 3; // battle.ts 와 같은 등급 판정 (실기록 승 2건 모두 미스·배드 0 -> Grade 1)
  return [{
    name: 'MsgBattleResultAns',
    body: {
      Seq: 1, Result: R_OK, IsPlayerWin: win, UserInfo: { ...ui }, RaceType: 4, RaceLevel: Number(body?.RaceLevel) || 1, ItemInfo: [], NewCars: [],
      Race: { RaceId: 0, RaceMode: 1, RaceLifeType: 1, Track: trackShort() }, Track: trackShort(),
      BattleScore: withdraw ? 0 : Number(body?.BattleScore) || 0, RaceAction: raceAction, BoostCompensation: 0, PerfectStart: !!body?.PerfectStart,
      MyTimeRecord: myTime, OpponentTimeRecord: oppTime, LeftBoost: body?.LeftBoost ?? 0, MyMaxSpeed: body?.LinearMaxSpeed,
      MyMaxDriftSpeed: body?.CornerMaxSpeed, Withdraw: withdraw,
      DeltaInfo: { Charexp: xp, Coin: coin, Cash: 0, Token: token, SponsorBonus: sponsor }, BaseCoin: coin, CoinRatio: 1, ...(win ? { RaceCoin: coin } : {}),
      OpponentCarInfo: m.car, OpponentUserInfo: m.user, MyWorldTour: recordOut(mwt), TourResult: tourResult,
      MyCarInfo: { ...car, FinalAttr: faBefore, DeltaMastery: 0 }, UpdateGirlInfo: updateGirl, GgraphPatch: { Gnode: [] },
      ...(win ? { ClearRec: { Grade: grade, Flag: 0 } } : {}),
    },
  }, ...(questChanges.length ? [{ name: 'MsgUpdateNquest', body: { Seq: 2, NquestInfo: questChanges } }] : [])];
}
