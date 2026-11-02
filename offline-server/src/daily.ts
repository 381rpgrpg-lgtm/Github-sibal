// 일일 초기화. 실기록(2026-11-01 07:00:13 UTC 요청 중, 2026-11-02 08:56 UTC 로그인):
//   기준 시각 = 미국 태평양(America/Los_Angeles) 자정 (Tvalue 1793516400 = 11-01 00:00 PDT, 1793606400 = 11-02 00:00 PST).
//   PropertySet DQUEST.Tvalue 가 지나면 첫 요청에서:
//     - DQUEST_RACE / DQUEST_DATE / DQUEST_PARTSUP Nvalue 0, DQUEST.Tvalue = 다음 기준 시각, DQUEST.Nvalue 1
//     - dailyRaceDay = 태평양 날짜의 일수(1970-01-01 기준), EventRaceNextRefreshTime = 다음 기준 시각
//     - 출석: Daygift {ReturnUser 2, DayTerm 1, DayCount n+1, CarInfo [], ItemInfo [{Itemid 0, Itemtype, Count, StackNum, DeltaNum}],
//       GirlItemInfo [], Version 1}, 보상은 dailyBonusTable(Term 1, Day=DayCount) NewReward x NewAmount 를 우편으로
//       ('Attendance event reward', 'Received reward for N day(s) attendance.', 7일 만료). 기록: 2일 61006x10, 3일 61202x1, 4일 61002x20.
//     - 일일 보상 레이스: 클리어한 일반 레이스 중 최대 7개에 DailyRewardTime = 다음 기준 시각 (기록: 6개 중 6개, 10개 중 7개. 선택 규칙은 추정: 무작위)
//   알림: 로그인이면 MsgUserData 에 그대로(Daygift 포함), 그 외 요청이면 MsgNotifyEvent {PropertySet}, {Daygift, MailBox}, {DailyRewardRaces} 3개.
//   추정: 28일 이후는 1일로 돌아감, EventRaceTicket 은 12 미만이면 12 로.
import { table } from './gamecalc.js';

const TZ = 'America/Los_Angeles';
function laParts(ms: number): { y: number; m: number; d: number; h: number; mi: number } {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
  } catch {
    const t = new Date(ms - 8 * 3600_000); // ICU 없는 환경: PST 고정
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
  }
}
/** 다음 태평양 자정 (초) */
export function nextResetSec(nowMs: number): number {
  const { y, m, d } = laParts(nowMs);
  for (const off of [7, 8]) {
    const t = Date.UTC(y, m - 1, d + 1, off);
    const p = laParts(t);
    if (p.h === 0 && p.mi === 0) return t / 1000;
  }
  return Date.UTC(y, m - 1, d + 1, 8) / 1000;
}
const laDayNumber = (nowMs: number) => { const { y, m, d } = laParts(nowMs); return Math.floor(Date.UTC(y, m - 1, d) / 86400_000); };

function prop(snap: any, name: string): any {
  snap.PropertySet ??= { Property: [] };
  snap.PropertySet.Property ??= [];
  let p = snap.PropertySet.Property.find((x: any) => x.PropertyName === name);
  if (!p) { p = { PropertyName: name, Nvalue: 0 }; snap.PropertySet.Property.push(p); }
  return p;
}

export interface DailyResult { Daygift: any; DailyRewardRaces: any[] }

/** 기준 시각이 지났으면 초기화하고 결과를 돌려준다. 아니면 null. */
export function dailyReset(snap: any, nowMs = Date.now()): DailyResult | null {
  if (!snap?.UserInfo) return null;
  const dq = prop(snap, 'DQUEST');
  const now = nowMs / 1000;
  if (Number(dq.Tvalue) && now < Number(dq.Tvalue)) return null;
  const next = nextResetSec(nowMs);
  dq.Nvalue = 1; // 일일 미션 진행 중 (2 = 모두 달성, 0 = 보상 수령 완료: 실측)
  dq.Tvalue = next;
  for (const n of ['DQUEST_RACE', 'DQUEST_DATE', 'DQUEST_PARTSUP']) prop(snap, n).Nvalue = 0;
  snap.dailyRaceDay = laDayNumber(nowMs);
  const ui = snap.UserInfo;
  ui.EventRaceNextRefreshTime = next;
  if ((Number(ui.EventRaceTicket) || 0) < 12) ui.EventRaceTicket = 12;

  // 출석
  const rows: any[] = (table('dailyBonusTable.json')?.DailyBonus ?? []).filter((r: any) => Number(r.Term) === 1);
  const maxDay = Math.max(1, ...rows.map((r) => Number(r.Day) || 0));
  const prevCount = Number(snap.attendanceDay) || Number(snap.Daygift?.DayCount) || 0;
  const day = (prevCount % maxDay) + 1;
  snap.attendanceDay = day;
  const row = rows.find((r) => Number(r.Day) === day);
  const itemtype = Number(row?.NewReward ?? row?.Reward) || 0, amount = Number(row?.NewAmount ?? row?.Amount) || 0;
  const gift = { ReturnUser: 2, DayTerm: 1, DayCount: day, CarInfo: [], GirlItemInfo: [], Version: 1,
    ItemInfo: itemtype ? [{ Itemid: 0, Itemtype: itemtype, Count: amount, StackNum: amount, DeltaNum: amount }] : [] };
  if (itemtype) {
    snap.MailBox ??= { Version: 1, Mail: [], Count: 0 };
    snap.mailSeq = (Number(snap.mailSeq) || Math.max(0, ...snap.MailBox.Mail.map((m: any) => Number(m.MailId) || 0))) + 1;
    snap.MailBox.Mail.push({ MailId: snap.mailSeq, MailType: 4, BoxType: 0, Itemnum: amount, Itemtype: itemtype,
      Subject: 'Attendance event reward', Content: `Received reward for ${day} day(s) attendance.`, ExpireTime: Math.floor(now) + 7 * 86400 });
    snap.MailBox.Count = snap.MailBox.Mail.length;
  }

  // 일일 보상 레이스
  const cleared: any[] = [];
  for (const z of snap.RaceZones?.RaceZone ?? []) {
    if (Number(z.ZoneId) >= 1000) continue; // 이벤트·챌린지 구역 제외
    for (const r of z.Race ?? []) {
      delete r.DailyRewardTime;
      if (Number(r.State) & 16 && Number(r.RaceIndex) < 20) cleared.push({ z, r });
    }
  }
  for (let i = cleared.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cleared[i], cleared[j]] = [cleared[j], cleared[i]]; }
  const picked = cleared.slice(0, 7).sort((a, b) => Number(a.r.RaceId) - Number(b.r.RaceId));
  for (const { r } of picked) r.DailyRewardTime = next;
  return { Daygift: gift, DailyRewardRaces: picked.map(({ z, r }) => ({ ZoneId: Number(z.ZoneId), RaceId: Number(r.RaceId), DailyRewardTime: next })) };
}
