// 이벤트 레이스 (허브 '도전' -> 이벤트). 실기록 2026-11-03: 할로윈 3103 챕터 1~7 승리·보상 수령 7회, 새로고침 67건.
//
// 구역: UserData.RaceZones 의 ZoneId >= 1000 (3000·3001·3103·3311). 정의는 battleTable BattleArea 5<ZoneId> (content.json 표 패치 포함),
//   누적 보상은 battleTable EventRaceReward (ZoneId 5<ZoneId>, Point 이상이면 우편).
// 흐름(기록):
//   MsgRefreshEventRaceReq {} -> MsgRefreshEventRaceAns {Seq, Result 1, UpdateData {UserInfo, RaceZone [이벤트 구역 전체]}}
//   MsgBattleStartReq {ZoneId, BattleId, RaceType 6}: 연료 대신 EventRaceTicket -NeedTicket(1), 구역 LeftTryCount -1, 레이스 TryCount +1.
//     RivalScale {Vs, Floor, Weights, By:'car'} 이 있는 레이스는 상대 능력치 합 T = max(Floor, round(내 최종 능력치 합 x (1+Vs))),
//     능력치 = round(T x 차종 기본 능력치 비율) (makeOpponent 와 같은 계산. 기록 8건 모두 일치).
//   MsgBattleResultReq (승리): 레이스 State 1 -> 18, 코인 +RewardCoin, 경험치(아래), 숙련도 +2, RewardWinPoint = WinPoint.
//     경험치: 기록된 챕터는 실측값(event-races.json xp: 90->120 ... 144->200), 없으면 round(1.5 x RewardXP - 15) (추정: 기록 7건 중 4건 정확, 3건 1~2 차이).
//   MsgRaceRewardReq {ZoneId, RaceId}: State 18 -> 17, WinPoint -> 0, CurrentPoint += WinPoint, 다음 챕터 NewRace (State 1),
//     마지막 본편 챕터(순번 19 이하의 끝) 수령 뒤에는 남은 레이스(20·30)를 모두 연다.
//     우편: 첫 승 보상 '<제목>: <챕터 제목>' / 'First win of "<챕터 제목>".' (event-races.json firstWin, 기록된 3103 만),
//           누적 보상 '<제목>: <Point> XP' / 'Event reward of <제목> (<Point> event XP).' (RewardInfo State 1 -> 2).
//     응답 {Seq, Result 1, Race(수령 전), RaceZone [{ZoneId, CurrentPoint, DeltaCurrentPoint, DeltaProgress, RewardInfo, ExpireTime,
//       ChangeRace, NewRace}], ItemInfo [], NewCars [], UserInfo, RebornGot {Title, KitModel, Mails, Letters [], Kit []}} + MsgNotifyEvent {MailBox}.
// 추정(기록 없음): 패배 처리(스토리와 같은 패배 경험치, State 유지), 기록 없는 챕터의 보상·RewardCoin(600)·RewardXP,
//   기간이 끝난 이벤트(ExpireTime 경과)는 오프라인에서 Duration(분)만큼 연장, LeftTryCount 는 날이 바뀌면 MaxTryCount 로.
import { readFileSync, existsSync } from 'node:fs';
import { register, type Ctx, type Msg } from '../rpc.js';
import { table, areaOf, makeOpponent, finalAttr, carDefOf, carName, syncGirl, ATTRS } from '../gamecalc.js';
import { levelUp, addMastery, bumpProperty } from './battle.js';
import { refreshQuests } from '../quests.js';

const ST = { PLAYABLE: 1, CLEAR: 2, WIN: 16 } as const;
const now = () => Date.now() / 1000;
export const isEventZone = (zoneId: number) => Number(zoneId) >= 1000;

const DATA_PATH = new URL('../../src/data/event-races.json', import.meta.url).pathname;
let data: Record<string, any> | null = null;
const evData = (zoneId: number): any => {
  if (!data) data = existsSync(DATA_PATH) ? JSON.parse(readFileSync(DATA_PATH, 'utf8')) : {};
  return data![String(zoneId)] ?? null;
};
const raceData = (zoneId: number, idx: number): any => evData(zoneId)?.races?.[String(idx)] ?? {};

function eventTitle(zoneId: number): string {
  const t = evData(zoneId)?.title;
  if (t) return t;
  const txt = table('text_en.json');
  const v = txt?.[`name_${50000 + Number(zoneId)}`] ?? txt?.Text?.[`name_${50000 + Number(zoneId)}`];
  return typeof v === 'string' ? v : `Event ${zoneId}`;
}

// 상대 차종: 그 모델(ModelHigh)의 가장 낮은 등급 차량 (기록 12건: GT500 -> 11503★3, WRX Break -> 15403★3, GT-R -> 11704★4, R32 -> 15703★3).
//   표시 등급(Grade)은 battleTable Opponent.Grade. 연료 = 15 + 5 x 차량 등급, FuelConsume20404 = floor(연료 x 2/3) (기록 ★3 30/20, ★4 35/23, ★5 40/26, ★6 45/30).
function cartypeOf(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const cars: any[] = (table('cars.json')?.Car ?? []).filter((c: any) => c.ModelHigh === model).sort((a: any, b: any) => a.Grade - b.Grade);
  return Number(cars[0]?.Id) || undefined;
}
const sumOf = (a: any) => ATTRS.reduce((s, k) => s + (Number(a?.[k]) || 0), 0);
/** RivalScale 상대 능력치 합: max(Floor, round(내 최종 능력치 합 x (1+Vs))) */
function scaledSum(rs: any, snap: any, car: any): number {
  return Math.max(Number(rs.Floor) || 0, Math.round(sumOf(finalAttr(snap, car)) * (1 + (Number(rs.Vs) || 0))));
}

function trackOf(ar: any): any {
  const t = (table('trackTable.json')?.Track ?? []).find((x: any) => Number(x.TrackId) === Number(ar.TrackId));
  return { TrackId: Number(ar.TrackId) || 99, Attrs: t?.Attrs ?? {}, Thema: Number(ar.Thema) || 1, LightingIndex: 0, ...(ar.Reborn ? { Reborn: ar.Reborn } : {}) };
}

/** battleTable 정의로 새 이벤트 레이스 레코드 (기록된 Reborn 확장 정보가 있으면 그 값).
 *  상대 능력치: RivalScale 이 있으면 만드는 시점의 현재 차량 기준(기록: 3103-12 생성 1014 = 차량 8 1267 x 0.8, 3103-13 631 = 717 x 0.88),
 *  없으면 기록된 생성 시점 합(opp.sum), 그것도 없으면 battleTable Difficulty. */
function buildRace(zoneId: number, ar: any, snap?: any, car?: any): any {
  const idx = Number(ar.RaceIndex);
  const d = raceData(zoneId, idx);
  const rs = d.RivalScale;
  const sum = rs && snap && car ? scaledSum(rs, snap, car) : Number(d.opp?.sum) || Number(ar.Opponent?.Difficulty) || 1000;
  const type = Number(d.opp?.Cartype) || cartypeOf(ar.Opponent?.CarModel);
  const opp = makeOpponent(sum, type);
  const def = carDefOf(opp.Cartype);
  const fc = 15 + 5 * (Number(def?.Grade) || 3);
  Object.assign(opp, {
    Grade: Number(ar.Opponent?.Grade) || Number(def?.Grade) || opp.Grade, CarName: carName(opp.Cartype),
    Price: Number(def?.SellPrice) || opp.Price, MasteryCapacity: Number(def?.SoftLimit) || opp.MasteryCapacity,
    FuelConsume: fc, FuelConsume20404: Math.floor((fc * 2) / 3), ColorIndex: Number(ar.Opponent?.CarColor) || opp.ColorIndex,
    ...(d.opp?.extra ?? {}), // Reborn 보스 연출 (기록: 유령 R32 Paint·Kit·Ghost·Behaviour·Bgm·Aura·AuraPower)
  });
  return {
    RaceId: 5000000 + Number(zoneId) * 100 + idx, State: ST.PLAYABLE, PosId: Number(ar.RacePos) || 1, ZoneId: Number(zoneId),
    RaceLifeType: 1, RaceMode: Number(d.RaceMode ?? ar.RaceMode) || 1, RaceIndex: idx,
    RewardCoin: Number(d.RewardCoin) || 600, RewardXP: Number(d.RewardXP) || Math.round(30 + (Number(ar.Opponent?.Difficulty) || 1000) / 20),
    OpponentCarInfo: opp, Track: d.Track ?? trackOf(ar), WinPoint: Number(ar.WinPoint) || 0, TryCount: 0,
    ...(d.RivalScale ? { RivalScale: d.RivalScale } : {}), ...(d.Chapter ? { Chapter: d.Chapter } : {}),
    ...(d.TimeLimit ?? ar.TimeLimit ? { TimeLimit: Number(d.TimeLimit ?? ar.TimeLimit) } : {}),
  };
}

const eventZones = (snap: any): any[] => (snap.RaceZones?.RaceZone ?? []).filter((z: any) => isEventZone(z.ZoneId));
const dayKey = () => new Date(Date.now() - 8 * 3600e3).toISOString().slice(0, 10); // 일일 초기화 기준(08:00 UTC)과 같은 날 구분

/** 기간 연장·하루 도전 횟수 초기화·첫 레이스 보장 */
function maintain(snap: any): void {
  const t = now();
  snap.eventTryDay ??= {};
  for (const z of eventZones(snap)) {
    const area = areaOf(z.ZoneId);
    if (Number(z.ExpireTime) > 0 && Number(z.ExpireTime) < t && area?.Duration) z.ExpireTime = Math.floor(t) + Number(area.Duration) * 60;
    const max = Number(z.MaxTryCount) || Number(area?.TryCount) || 99;
    if (!snap.eventTryDay[z.ZoneId]) snap.eventTryDay[z.ZoneId] = dayKey();
    else if (snap.eventTryDay[z.ZoneId] !== dayKey()) { z.LeftTryCount = max; snap.eventTryDay[z.ZoneId] = dayKey(); }
    z.Race ??= [];
    if (!z.Race.length && area?.Race?.length) {
      const first = [...area.Race].sort((a: any, b: any) => a.RaceIndex - b.RaceIndex)[0];
      z.Race.push(buildRace(z.ZoneId, first));
    }
  }
}

register('MsgRefreshEventRaceReq', (_body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'MsgRefreshEventRaceAns', body: { Seq: 1, Result: 0 } }];
  maintain(snap);
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgRefreshEventRaceAns', body: { Seq: 1, Result: 1, UpdateData: {
    UserInfo: snap.UserInfo, RaceZone: eventZones(snap), ...(snap.EventRaceTime ? { EventRaceTime: snap.EventRaceTime } : {}) } } }];
});

/** 이벤트 레이스 시작: 입장권·도전 횟수 차감, RivalScale 이면 상대 능력치를 내 차에 맞춘다. 실패면 거절 응답, 성공이면 null */
export function eventStart(snap: any, zone: any, race: any, car: any): Msg[] | null {
  const ui = snap.UserInfo;
  const need = Number(areaOf(zone.ZoneId)?.NeedTicket) || 1;
  maintain(snap);
  // 결과 없이 같은 레이스를 다시 시작하면 다시 차감하지 않는다 (기록 3103-13: 두 번째 시작에 입장권 9 그대로, TryCount 1 그대로)
  const restart = Number(snap.eventPending) === Number(race.RaceId);
  if (!restart) {
    if ((Number(ui.EventRaceTicket) || 0) < need || Number(zone.LeftTryCount ?? 1) <= 0) {
      return [{ name: 'MsgBattleStartAns', body: { Seq: 1, Result: 0, UserInfo: ui } }];
    }
    ui.EventRaceTicket = Number(ui.EventRaceTicket) - need;
    zone.LeftTryCount = Number(zone.LeftTryCount ?? Number(zone.MaxTryCount) ?? 99) - 1;
    race.TryCount = (Number(race.TryCount) || 0) + 1;
  }
  snap.eventPending = Number(race.RaceId);
  const rs = race.RivalScale;
  if (rs && (rs.By ?? 'car') === 'car') {
    race.OpponentCarInfo = { ...race.OpponentCarInfo, Attributes: makeOpponent(scaledSum(rs, snap, car), race.OpponentCarInfo?.Cartype).Attributes };
  }
  return null;
}

/** 이벤트 레이스 결과 (승리: State 18, 코인 RewardCoin, 경험치, 숙련도 +2) */
export function eventResult(body: any, ctx: Ctx, snap: any, zone: any, race: any, car: any): Msg[] {
  const ui = snap.UserInfo;
  const withdraw = !!body.Withdraw;
  const win = !withdraw && (!!body.IsPlayerWin || !!(ctx.cheat.enabled && ctx.cheat.forceWinBattles));
  const d = raceData(zone.ZoneId, race.RaceIndex);
  const rx = Number(race.RewardXP) || 0;
  const xp = win ? (Number(d.xp) || Math.round(1.5 * rx - 15)) : Math.floor((rx + 1) * 0.3);
  const coin = win ? Number(race.RewardCoin) || 0 : 0;
  const winPoint = win && race.State & ST.PLAYABLE && !(race.State & ST.WIN) ? Number(race.WinPoint) || 0 : 0;
  let clear: any = null;
  if (win) {
    const miss = Number(body.MissCnt) || 0, bad = Number(body.BadCnt) || 0;
    const grade = miss === 0 && bad === 0 ? 1 : miss === 0 ? 2 : 3;
    const prev = race.ClearRec ?? {};
    const bit = 1 << (grade - 1);
    clear = prev.Flag && Number(prev.Flag) < bit ? { Grade: Number(prev.Grade), Flag: Number(prev.Flag) } : { Grade: grade, Flag: bit };
    race.ClearRec = clear;
    race.State = (race.State & ~ST.PLAYABLE) | ST.CLEAR | ST.WIN; // 처음 승리 1 -> 18, 수령 뒤 재승리 17 -> 18
  }
  ui.Coin = (Number(ui.Coin) || 0) + coin;
  ui.Charexp = (Number(ui.Charexp) || 0) + xp;
  delete ui.LevelUp;
  levelUp(snap);
  const faBefore = finalAttr(snap, car);
  car.DeltaMastery = 0;
  addMastery(car, win ? 2 : withdraw ? 0 : 1);
  const propChanged = win && bumpProperty(snap, 'DQUEST_RACE', 1);
  delete snap.eventPending;
  if (!withdraw) { snap.eventStats ??= {}; const st = (snap.eventStats[zone.ZoneId] ??= { Battles: 0, Wins: 0 }); st.Battles++; if (win) st.Wins++; }
  // 동승 캐릭터 친밀도 +10 (기록 7건: 20405 534 -> 544 -> ... -> 594, 결과 UpdateGirlInfo 에 캐릭터 레코드). 패배도 같다고 추정.
  const updateGirl: any[] = [];
  const passenger = withdraw ? null : (snap.MyGirls?.MyGirlInfo ?? []).find((g: any) => Number(g.Girlid) === Number(ui.PassengerGirl));
  if (passenger) { passenger.Familiarity = (Number(passenger.Familiarity) || 0) + 10; syncGirl(passenger); updateGirl.push(passenger); }
  const questChanges = refreshQuests(snap);
  const uiOut = { ...ui };
  ctx.store.putUser(ctx.session.accountId, snap);
  const action = [2, 3, 4, 5, 6].map((a, i) => ({ Action: a, Count: Number([body.MissCnt, body.BadCnt, body.GoodCnt, body.PerfectCnt, body.ExcellentCnt][i]) || 0 }));
  return [{
    name: 'MsgBattleResultAns',
    body: {
      Seq: 1, Result: 1, IsPlayerWin: win, UserInfo: uiOut, ItemInfo: [], Race: race, RaceZone: [{ ZoneId: zone.ZoneId, ChangeRace: [race] }],
      ...(clear ? { ClearRec: clear } : {}), BattleScore: withdraw ? 0 : Number(body.BattleScore) || 0,
      RaceAction: { Action: action, ComboCount: Number(body.ComboCount) || 0 }, BoostCompensation: 0, PerfectStart: !!body.PerfectStart,
      MyTimeRecord: withdraw ? 0 : body.TimeRecord, OpponentTimeRecord: withdraw ? 0 : body.OpponentTimeRecord, LeftBoost: body.LeftBoost ?? 0,
      MyMaxSpeed: body.LinearMaxSpeed, MyMaxDriftSpeed: body.CornerMaxSpeed, Withdraw: withdraw,
      DeltaInfo: { Charexp: xp, Coin: coin, Cash: 0 }, OpponentCarInfo: race.OpponentCarInfo, RaceType: body.RaceType ?? 6, RaceLevel: body.RaceLevel ?? 1,
      BaseCoin: Number(race.RewardCoin) || 0, CoinRatio: 1, RewardWinPoint: winPoint, Track: race.Track,
      MyCarInfo: { ...car, FinalAttr: faBefore }, NewCars: [], UpdateGirlInfo: updateGirl, GgraphPatch: { Gnode: [] },
      ...(propChanged ? { PropertySet: snap.PropertySet } : {}),
    },
  }, ...(questChanges.length ? [{ name: 'MsgUpdateNquest', body: { Seq: 2, NquestInfo: questChanges } }] : [])];
}

function addMail(snap: any, itemtype: number, itemnum: number, subject: string, content: string): any {
  snap.MailBox ??= { Version: 1, Mail: [], Count: 0 };
  snap.mailSeq = (Number(snap.mailSeq) || Math.max(0, ...snap.MailBox.Mail.map((m: any) => Number(m.MailId) || 0))) + 1;
  const m = { MailId: snap.mailSeq, MailType: 4, BoxType: 0, Itemnum: itemnum, Itemtype: itemtype, Subject: subject, Content: content,
    ExpireTime: Math.floor(now()) + 14 * 86400 }; // 기록 만료 시각은 고정 날짜(1795219199). 오프라인은 14일 (추정)
  snap.MailBox.Mail.push(m);
  snap.MailBox.Count = snap.MailBox.Mail.length;
  return m;
}

/** 이벤트 레이스 보상 수령 */
export function eventReward(body: any, ctx: Ctx, snap: any, zone: any, race: any): Msg[] {
  if (!(race.State & ST.CLEAR)) return [{ name: 'MsgRaceRewardAns', body: { Seq: 1, Result: 0 } }];
  const before = structuredClone(race);
  const zid = Number(zone.ZoneId);
  const title = eventTitle(zid);
  const delta = Number(race.WinPoint) || 0;
  race.State = (race.State & ~ST.CLEAR) | ST.PLAYABLE; // 18 -> 17
  race.WinPoint = 0;
  zone.CurrentPoint = (Number(zone.CurrentPoint) || 0) + delta;
  const mails: any[] = [];
  // 누적 보상 (Point 이하 달성, RewardInfo State 1 -> 2)
  const rows: any[] = (table('battleTable.json')?.EventRaceReward ?? []).filter((r: any) => Number(r.ZoneId) === 50000 + zid);
  for (const ri of zone.RewardInfo ?? []) {
    const row = rows.find((r) => Number(r.RewardId) === Number(ri.RewardId));
    if (!row || Number(ri.State) !== 1 || Number(row.Point) > zone.CurrentPoint) continue;
    ri.State = 2;
    (row.ItemId ?? []).forEach((it: number, i: number) => mails.push(addMail(snap, Number(it), Number(row.Amount?.[i]) || 1,
      `${title}: ${row.Point} XP`, `Event reward of ${title} (${row.Point} event XP).`)));
  }
  // 첫 승 보상 (WinPoint 가 남아 있던 첫 수령 때만)
  const ch = race.Chapter?.Title;
  if (delta > 0 && ch) for (const [it, n] of raceData(zid, race.RaceIndex).firstWin ?? []) {
    mails.push(addMail(snap, Number(it), Number(n), `${title}: ${ch}`, `First win of "${ch}".`));
  }
  // 다음 레이스
  const newRace: any[] = [];
  if (delta > 0) {
    const defs = [...(areaOf(zid)?.Race ?? [])].sort((a: any, b: any) => a.RaceIndex - b.RaceIndex);
    const have = new Set((zone.Race ?? []).map((r: any) => Number(r.RaceIndex)));
    const next = defs.find((ar: any) => Number(ar.RaceIndex) > Number(race.RaceIndex) && !have.has(Number(ar.RaceIndex)));
    const open = !next ? [] : Number(next.RaceIndex) < 20 ? [next] : defs.filter((ar: any) => Number(ar.RaceIndex) >= 20 && !have.has(Number(ar.RaceIndex)));
    const car = (snap.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(snap.UserInfo?.Currentcar));
    for (const ar of open) { const r = buildRace(zid, ar, snap, car); zone.Race.push(r); newRace.push(r); }
  }
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgRaceRewardAns',
    body: {
      Seq: 1, Result: 1, Race: before,
      RaceZone: [{ ZoneId: zid, CurrentPoint: zone.CurrentPoint, DeltaCurrentPoint: delta, DeltaProgress: delta, RewardInfo: zone.RewardInfo ?? [],
        ExpireTime: zone.ExpireTime ?? 0, ChangeRace: [race], ...(newRace.length ? { NewRace: newRace } : {}) }],
      ItemInfo: [], NewCars: [], UserInfo: snap.UserInfo,
      RebornGot: { Title: title, KitModel: evData(zid)?.kitModel ?? null, Mails: mails.map((m) => ({ MailId: m.MailId, Itemtype: m.Itemtype, Itemnum: m.Itemnum, Subject: m.Subject })), Letters: [], Kit: [] },
    },
  }, ...(mails.length ? [{ name: 'MsgNotifyEvent', body: { Seq: 2, MailBox: snap.MailBox } }] : [])];
}

// ── Reborn 이벤트 상태·보상표 (실기록 2026-11-03: LocalRebornStatusReq 2건, LocalRebornRewardsReq 1건)
//   상태 {Seq, Result 1, Events [{Id, Title, Zone(5xxxx), Open, Why 'season', Ends, Season {Start, End, ClaimUntil(End + 7일)}, Day(SeasonDay),
//     Rivals {}, Drops 0, AuraDrops 0, CosmeticDrops 0, Xp(CurrentPoint), Battles, Wins, Next {Point, Items} | null,
//     Milestones [{Point, Items, Amounts, Given}], Rank null}]}. Reborn 이벤트(이벤트 Id 가 기록된 구역)만.
//   보상표 {Zone} -> {Seq, Result 1, Rewards {Id, Title, Zone, Xp, Track [{Point, Items [{Id, Count}], Cosmetics [], Given}], Ranking(기록된 순위 보상표)}}
//   오프라인은 순위가 없으므로 Rank 는 null. Battles·Wins 는 이 서버에서 센 값.
function rebornEvent(snap: any, z: any) {
  const d = evData(z.ZoneId);
  const rows: any[] = (table('battleTable.json')?.EventRaceReward ?? []).filter((r: any) => Number(r.ZoneId) === 50000 + Number(z.ZoneId))
    .sort((a: any, b: any) => a.Point - b.Point);
  const given = (id: number) => (z.RewardInfo ?? []).some((ri: any) => Number(ri.RewardId) === id && Number(ri.State) === 2);
  const ms = rows.map((r) => ({ Point: Number(r.Point), Items: r.ItemId ?? [], Amounts: r.Amount ?? [], Given: given(Number(r.RewardId)) }));
  const next = ms.find((m) => !m.Given);
  const end = Number(z.ExpireTime) || 0;
  const st = snap.eventStats?.[z.ZoneId] ?? { Battles: 0, Wins: 0 };
  return {
    Id: d.reborn.Id, Title: eventTitle(z.ZoneId), Zone: 50000 + Number(z.ZoneId), Open: !end || end > now(), Why: 'season', Ends: end,
    Season: { Start: Number(d.reborn.SeasonStart) || 0, End: end, ClaimUntil: end ? end + 7 * 86400 : 0 }, Day: Number(z.SeasonDay) || 1,
    Rivals: {}, Drops: 0, AuraDrops: 0, CosmeticDrops: 0, Xp: Number(z.CurrentPoint) || 0, Battles: st.Battles, Wins: st.Wins,
    Next: next ? { Point: next.Point, Items: next.Items } : null, Milestones: ms, Rank: null,
  };
}
const rebornZones = (snap: any) => eventZones(snap).filter((z) => evData(z.ZoneId)?.reborn?.Id);

register('LocalRebornStatusReq', (_body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'LocalRebornStatusAns', body: { Seq: 1, Result: 0 } }];
  maintain(snap);
  return [{ name: 'LocalRebornStatusAns', body: { Seq: 1, Result: 1, Events: rebornZones(snap).map((z) => rebornEvent(snap, z)) } }];
});

register('LocalRebornRewardsReq', (body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const z = snap && rebornZones(snap).find((x) => 50000 + Number(x.ZoneId) === Number(body?.Zone));
  if (!z) return [{ name: 'LocalRebornRewardsAns', body: { Seq: 1, Result: 0 } }];
  const e = rebornEvent(snap, z);
  return [{ name: 'LocalRebornRewardsAns', body: { Seq: 1, Result: 1, Rewards: {
    Id: e.Id, Title: e.Title, Zone: e.Zone, Xp: e.Xp,
    Track: e.Milestones.map((m: any) => ({ Point: m.Point, Items: m.Items.map((id: number, i: number) => ({ Id: id, Count: Number(m.Amounts[i]) || 1 })), Cosmetics: [], Given: m.Given })),
    Ranking: evData(z.ZoneId).reborn.Ranking ?? { MinBattles: 1, Tiers: [] },
    ...(evData(z.ZoneId).reborn.Static ?? {}), // 기록된 보상표 그대로: Rivals·Pool·LevelRewards·FirstWins
  } } }];
});

// ── 레이스 프리셋 (실기록 2026-11-03: {RacePresetSet {RacePreset [{PresetType 5, Girlid, Carid}]}} -> 같은 내용 + Result 1)
//   같은 PresetType 은 바꾸고 새 것은 더한다(추정: 기록 1건).
register('MsgChangeRacePresetReq', (body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const list: any[] = body?.RacePresetSet?.RacePreset ?? [];
  if (!snap || !Array.isArray(list)) return [{ name: 'MsgChangeRacePresetAns', body: { Seq: 1, Result: 0 } }];
  snap.RacePresetSet ??= { RacePreset: [] };
  snap.RacePresetSet.RacePreset ??= [];
  for (const p of list) {
    const i = snap.RacePresetSet.RacePreset.findIndex((x: any) => Number(x.PresetType) === Number(p.PresetType));
    if (i >= 0) snap.RacePresetSet.RacePreset[i] = p; else snap.RacePresetSet.RacePreset.push(p);
  }
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgChangeRacePresetAns', body: { Seq: 1, Result: 1, RacePresetSet: { RacePreset: list } } }];
});
