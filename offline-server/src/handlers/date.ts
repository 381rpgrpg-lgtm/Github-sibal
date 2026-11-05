// 데이트 (장소 데이트). 흐름·형식은 실서버 기록(data/recorded, 2026-11-01: 튜토리얼 20105 공원, 20101 공원)을 따른다.
//
// MsgDateProposeReq {GirlInfo} -> {Seq, Result 1, GirlInfo, UserInfo}
// MsgDateStartReq {GirlInfo:{Girlid}, DatePlace} -> MsgDateStartAns {Seq, Result 1, UserInfo(코인 -Price), GirlInfo:{Girlid}, DatePlace, ItemInfo []}
//   + MsgLoadScript {Script:{Chunk:[...]}}  — 대본은 서버가 scripts.json(Script/Text) 으로 조립한다.
//   친밀도 단계 lv: girlTable FamiliaritySection1..3 누적(400 / +230 / +1300) → 1..4 (기록: 0→1, 440→2, 630→3)
//   일반 데이트 (Completion 에 Date(1024) 비트 있음):
//     Chunk1 = 장소 대본(lv) + 문항 2개(Text 의 <girl><Place>Stage<lv>SCRIPT/OPT, SEL_END Index 1·2)
//     Chunk2 = {Index 3}, {Index 4}
//     Index 1·2 답변 -> {ActionResult 3|1, ReactionType 0, Script:[DATE_NOTICE date_notice_10|11 ["1.5","2"|"3"], SCRIPT S<v>_ANS_<답><lv>]}
//       Index 2 답변 뒤에는 채팅 이벤트(Date_Event_Chat_*, QUESTION 에 Index 5)와 종료 대본(Date_End_*) 덩어리가 붙는다.
//     Depth 1 Index 5 답변(ANSWER 행 Parameter [등급, 대본, 친밀도]) -> {GirlInfo(친밀도+값), Script:[답 대본]}
//     Index 3 -> 결과 {UserInfo, DeltaInfo{Charexp}, GirlInfo(+DeltaFamiliarity, BonusFamiliarity), DateReward{DateResult, Satisfaction, RewardInfo{Charexp}}}
//     Index 4 -> {Seq, Index, Depth 0} + MsgDateResultAns {GirlInfo, UserInfo, DatePlace, DateResult, UpdateGirlInfo [], GirlMemorySet, GgraphPatch, CallScript [], PropertySet}
//   튜토리얼 데이트 (Date 비트 없음): 장소 대본 + 채팅 이벤트(QUESTION Index 1) + Date_End_Basic, 결과 Index 2, 종료 Index 3.
//   기록된 수치: 친밀도 = 장소 Familiarity x (만족도 3: 1.0, 4: 1.25) + 첫 데이트 보너스 112, 경험치 = 장소 XP,
//     DateCoolTime = 지금 + 30초, NthDate +1, LastDatePlace, DatingState[{Placeid, MaxRecord}], DQUEST_DATE +1,
//     첫 데이트 후 관계도 다음 노드(State 4 -> 7) 개방, 기억: (일반만) Date_Start + 장소 + 종료 대본, FmFlag |= 1<<(lv-1).
// 추정(원본 서버 표가 클라이언트에 없음):
//   - 문항별 '좋아하는 답'은 src/data/date-answers.json (반응 대사 비교로 만든 표, 기록 2문항 일치)
//   - 만족도 = 3 + 좋아함 - 싫어함 + 채팅(Best 2 / Good 1 / Pass 0), 1..5. 배율 1:0.5 2:0.75 3:1 4:1.25 5:1.5
//   - 종료 대본: 좋아함>싫어함 Good, 같으면 Basic, 적으면 Bad. 채팅 이벤트는 조건(ChatConditionA..C) 충족 중 무작위(튜토리얼은 A)
//   - 백화점(DateType 3) 데이트는 아래 departmentStart/departmentProgress.
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg, type Ctx } from '../rpc.js';
import { bumpProperty, levelUp } from './battle.js';
import { ensureGirl, expansionReady } from './girls.js';
import { evalGirlUnlocks } from '../girlunlock.js';
import { refreshQuests, questEvent } from '../quests.js';

const DATA = new URL('../../data/', import.meta.url).pathname;
const TUT_DATE = 1024;
const MULT: Record<number, number> = { 1: 0.5, 2: 0.75, 3: 1, 4: 1.25, 5: 1.5 };
// 첫 장소 보너스: girlTable FirstDatePlaceBonus (20105·20101·20102 = 112, 20207 = 103). 실기록 두 건 모두 그 장소 첫 데이트.
import { girlDef as gdef, table, syncGirl } from '../gamecalc.js';
// 쿨타임: girlTable DateCoolTime(분, 20105 = 0.5 -> 30초). 쿨타임 중에는 클라이언트가 캐시 초기화 화면만 띄우고
//   신청을 보내지 않는다 (사용자 확인 2026-11-02). 캐시 초기화 요청은 캐시 소비라 기록하지 않았다 -> 미구현.
const COOLTIME_SEC = 30;
/** 캐릭터별 쿨타임(초) = girlTable DateCoolTime(분) x 60, 없으면 30초 */
const coolSec = (girl: number) => { const m = Number(girls?.get(girl)?.DateCoolTime); return m > 0 ? Math.round(m * 60) : COOLTIME_SEC; };

interface Row { Id: number; ScriptName: string; FamiliarityLv: number; Step?: number; Function: string; TextTag?: string; Sound?: string;
  Parameter1?: string; Parameter2?: string; Parameter3?: string; Parameter4?: string; Parameter5?: string }
let rows: Map<string, Row[]> | null = null; // `${id}|${name}|${lv}`
let texts: Set<string> | null = null;
let places: Map<number, any> | null = null;
let girls: Map<number, any> | null = null;
let memories: any[] | null = null;
let answers: Record<string, number> = {};
function init() {
  if (rows) return;
  rows = new Map(); texts = new Set();
  const sc = existsSync(DATA + 'scripts.json') ? JSON.parse(readFileSync(DATA + 'scripts.json', 'utf8')) : { Script: [], Text: [] };
  for (const r of sc.Script ?? []) {
    const k = `${r.Id}|${r.ScriptName}|${r.FamiliarityLv}`;
    (rows.get(k) ?? rows.set(k, []).get(k)!).push(r);
  }
  for (const list of rows.values()) list.sort((a, b) => (a.Step ?? 0) - (b.Step ?? 0));
  for (const t of sc.Text ?? []) texts.add(t.Id);
  const tb = (n: string) => (existsSync(DATA + 'tables/' + n) ? JSON.parse(readFileSync(DATA + 'tables/' + n, 'utf8')) : {});
  places = new Map((tb('datingPlaces.json').Place ?? []).map((p: any) => [Number(p.Id), p]));
  girls = new Map((tb('girlTable.json').Girl ?? []).map((g: any) => [Number(g.Id), g]));
  memories = tb('girlMemoryTable.json').GirlMemory ?? [];
  const ans = new URL('../../src/data/date-answers.json', import.meta.url).pathname;
  if (existsSync(ans)) answers = JSON.parse(readFileSync(ans, 'utf8')).liked ?? {};
}

const toIns = (r: Row, extra: any = {}) => {
  const o: any = {};
  if (r.Step !== undefined) o.Step = r.Step;
  o.Function = r.Function;
  if (r.TextTag) o.TextTag = r.TextTag;
  if (r.Sound) o.Sound = r.Sound;
  const p = [r.Parameter1, r.Parameter2, r.Parameter3, r.Parameter4, r.Parameter5].filter((x) => x !== undefined && x !== null);
  // 원본 데이터의 'face_boring ' 같은 공백: CHANGE 는 실서버 응답에서 제거돼 있고(Date_Park), FACE 는 그대로였다(Shopping_B)
  if (p.length) o.Parameter = p.map((x) => (r.Function === 'CHANGE' ? String(x).trim() : String(x)));
  return { ...o, ...extra };
};
// 해당 단계 행이 없으면 더 낮은 단계 행을 쓴다(기록: 20105 단계 2 튜토리얼 데이트에 Date_Event_Chat_A 단계 1 행, 덩어리 표기는 2).
const scriptRows = (girl: number, name: string, lv: number): Row[] => {
  for (let l = lv; l >= 1; l--) { const r = rows!.get(`${girl}|${name}|${l}`); if (r) return r; }
  return rows!.get(`${girl}|${name}|-1`) ?? [];
};
const chunk = (girl: number, name: string, lv: number, ins: any[]) => ({ Id: girl, ScriptName: name, FamiliarityLv: lv, Instruction: ins });

function famLevel(g: any, fam: number): number {
  const d = girls!.get(Number(g.Girlid)) ?? {};
  let edge = 0, lv = 1;
  for (const s of [d.FamiliaritySection1 ?? 400, d.FamiliaritySection2 ?? 230, d.FamiliaritySection3 ?? 1300]) {
    edge += Number(s);
    if (fam >= edge) lv++; else break;
  }
  return Math.min(lv, 4);
}

// 장소 대본 (CHANGE 의 ND 를 장소 Id 로, 장소 AmbiSound 를 5번째 인자로)
function placeIns(girl: number, place: any, lv: number) {
  return scriptRows(girl, place.ScriptName, lv).map((r) => {
    const o = toIns(r);
    if (o.Function === 'CHANGE' && o.Parameter) {
      if (o.Parameter[0] === 'ND') o.Parameter[0] = String(place.Id);
      // 5번째 인자 = 장소 AmbiSound, 없으면 'NONE' (실기록: 공원 se_date_ambi_outdoor_2, 영화관·경기장 NONE)
      if (o.Parameter.length < 5) o.Parameter.push(place.AmbiSound || 'NONE');
    }
    return o;
  });
}

// 문항 v(1|2) — Text 태그에서 줄 번호 순서로 찾는다.
function tagsLike(re: RegExp): string[] {
  const out: [number, string][] = [];
  for (const t of texts!) { const m = re.exec(t); if (m) out.push([Number(m[1]), t]); }
  return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}
function questionIns(girl: number, sname: string, lv: number, v: number, index: number) {
  const base = `${girl}${sname}Stage${lv}`;
  const q = tagsLike(new RegExp(`^${base}SCRIPT(\\d+)$`))[v - 1];
  const o1 = tagsLike(new RegExp(`^${base}1OPT(\\d+)$`))[v - 1];
  const o2 = tagsLike(new RegExp(`^${base}2OPT(\\d+)$`))[v - 1];
  if (!q || !o1 || !o2) return [];
  return [{ Function: 'SCRIPT', TextTag: q }, { Function: 'SEL_START' }, { Function: 'OPT', TextTag: o1 }, { Function: 'OPT', TextTag: o2 }, { Function: 'SEL_END', Index: index }];
}
const answerTag = (girl: number, sname: string, lv: number, v: number, a: number) =>
  tagsLike(new RegExp(`^${girl}${sname}S${v}_ANS_${a}${lv}SCRIPT(\\d+)$`))[0];

function chatChunk(girl: number, lv: number, fam: number, tutorial: boolean, qIndex: number) {
  const d = girls!.get(girl) ?? {};
  const letters = tutorial ? ['A'] : ['A', 'B', 'C', 'D', 'E'].filter((L) => {
    const cond = d[`ChatCondition${L}`];
    return cond !== undefined && fam >= Number(cond) && scriptRows(girl, `Date_Event_Chat_${L}`, lv).length;
  });
  const L = letters[Math.floor(Math.random() * letters.length)];
  if (!L) return null;
  const name = `Date_Event_Chat_${L}`;
  const ins = scriptRows(girl, name, lv).map((r) => toIns(r, r.Function === 'QUESTION' ? { Index: qIndex } : {}));
  return { name, chunk: chunk(girl, name, lv, ins) };
}

// 문항 뒤(또는 문항 없는 장소에서 시작 때) 붙는 사건. 실기록 2026-11-02: Date_Event_Chat_A(문항 있음), Date_Event_Chat_B(20105 단계 3, 문항 없음),
//   Date_Event_Hint(문항 없음), Date_Event_Gift(GIFT 행에 Index 5 -> Depth 1 Index 5 요청에 GiftFromGirl). 고르는 규칙은 추정: 조건 맞는 채팅 + Hint + Gift 중 균등.
function eventChunk(girl: number, lv: number, fam: number, tutorial: boolean, qIndex: number) {
  if (tutorial) { const c = chatChunk(girl, lv, fam, true, qIndex); return c ? { ...c, ask: true } : null; }
  const d = girls!.get(girl) ?? {};
  const pool = ['A', 'B', 'C', 'D', 'E'].filter((L) => d[`ChatCondition${L}`] !== undefined && fam >= Number(d[`ChatCondition${L}`]))
    .map((L) => `Date_Event_Chat_${L}`).concat(['Date_Event_Hint', 'Date_Event_Gift'])
    .filter((n) => scriptRows(girl, n, lv).length);
  const name = pool[Math.floor(Math.random() * pool.length)];
  if (!name) return null;
  const rs = scriptRows(girl, name, lv);
  const ask = rs.some((r) => r.Function === 'QUESTION' || r.Function === 'GIFT');
  const ins = rs.map((r) => toIns(r, r.Function === 'QUESTION' || r.Function === 'GIFT' ? { Index: qIndex } : {}));
  return { name, chunk: chunk(girl, name, lv, ins), ask, gift: rs.some((r) => r.Function === 'GIFT') };
}
/** 장소에 문항(Stage 대본)이 있는지. 티켓 장소(경기장 등)는 없다 -> 시작·사건·종료 후 바로 결과 (실기록 20105 경기장) */
const hasQuestions = (girl: number, sname: string, lv: number) => questionIns(girl, sname, lv, 1, 1).length > 0;
/** 장소 선호 (girlTable PreferencePlaceA / DislikePlace). 실기록: 20105 영화관 = 선호 -> 시작 대본 CHANGE 뒤 DATE_NOTICE date_notice_7
 *  ['1.5','2'] + Date_Event_Preference_A 덩어리. 싫어하는 장소는 date_notice_9 + Date_Event_Npreferred (추정: 기록 없음) */
function placeMood(girl: number, placeId: number, lastPlace = 0): { notice: any; event: string } | null {
  const d = girls!.get(girl) ?? {};
  // 직전과 같은 장소 (실기록 20101 공원 연속): date_notice_8 ['1.5','3'] + Date_Boring. vconst IgnoreSameDatePlace 장소는 제외.
  //   선호·비선호보다 먼저 본다(추정: 겹친 기록 없음)
  const ignore: number[] = (table('vconstTable.json')?.Vconst ?? []).find((c: any) => c?.Name === 'IgnoreSameDatePlace')?.Val ?? [];
  if (lastPlace && lastPlace === placeId && !ignore.includes(placeId))
    return { notice: { Function: 'DATE_NOTICE', TextTag: 'date_notice_8', Parameter: ['1.5', '3'] }, event: 'Date_Boring' };
  if (Number(d.PreferencePlaceA) === placeId) return { notice: { Function: 'DATE_NOTICE', TextTag: 'date_notice_7', Parameter: ['1.5', '2'] }, event: 'Date_Event_Preference_A' };
  if (Number(d.DislikePlace) === placeId) return { notice: { Function: 'DATE_NOTICE', TextTag: 'date_notice_9', Parameter: ['1.5', '3'] }, event: 'Date_Event_Npreferred' };
  return null;
}

interface DateState { girl: number; place: number; lv: number; tutorial: boolean; likes: number; dislikes: number;
  chat: string | null; chatSat: number; resultIndex: number; finalIndex: number; satisfaction?: number; end?: string;
  events?: string[]; gift?: boolean;
  dept?: { scripts: string[]; gift?: { index: number; count: number; delta: number } } }
const key = (ctx: Ctx) => `date:${ctx.session.accountId}`;
const getState = (ctx: Ctx): DateState | null => { const s = ctx.store.getMeta(key(ctx)); return s ? JSON.parse(s) : null; };
const setState = (ctx: Ctx, s: DateState | null) => ctx.store.setMeta(key(ctx), s ? JSON.stringify(s) : '');
const myGirl = (snap: any, id: number) => (snap.MyGirls?.MyGirlInfo ?? []).find((g: any) => Number(g.Girlid) === Number(id));

register('MsgDateProposeReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const g = snap && myGirl(snap, body?.GirlInfo?.Girlid);
  if (!g) return [{ name: 'MsgDateProposeAns', body: { Seq: 1, Result: 2 } }];
  // 차량 반응 (실기록: ★2 차량 10602 + 20105(Rarity 1) -> Car_Reaction_Good + DATE_NOTICE date_notice_3 ['1.5','2'],
  //   ★1 차량 + Rarity 1 -> 없음. 추정: 차량 등급 > Rarity 면 Good, < 면 Bad(date_notice_4), 같으면 없음)
  init();
  const girl = Number(g.Girlid), lv = famLevel(g, Number(g.Familiarity) || 0);
  const car = (snap.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(snap.UserInfo?.Currentcar));
  const grade = Number(car?.Grade) || 1, rarity = Number(g.Rarity) || Number(girls!.get(girl)?.Rarity) || 1;
  const react = grade > rarity ? 'Car_Reaction_Good' : grade < rarity ? 'Car_Reaction_Bad' : null;
  const rs = react ? scriptRows(girl, react, lv) : [];
  const script = rs.length ? { Chunk: [chunk(girl, react!, lv, rs.flatMap((r, i) => {
    const o = toIns(r);
    return i === 0 ? [o, { Function: 'DATE_NOTICE', TextTag: react === 'Car_Reaction_Good' ? 'date_notice_3' : 'date_notice_4', Parameter: ['1.5', react === 'Car_Reaction_Good' ? '2' : '3'] }] : [o];
  }))] } : null;
  // 차량 반응 기억도 이때 생긴다 (실기록: 제안 직후 GirlMemorySet 에 2033 Car_Reaction_Good, FmFlag 단계 비트, RewardState 2)
  const def = script && memories!.find((m: any) => Number(m.GirlId) === girl && m.Scriptname === react);
  if (def) {
    snap.GirlMemorySet ??= { GirlMemory: [], Version: 1 };
    let gm = snap.GirlMemorySet.GirlMemory.find((x: any) => Number(x.Girlid) === girl);
    if (!gm) { gm = { Girlid: girl, Memory: [] }; snap.GirlMemorySet.GirlMemory.push(gm); }
    let m = gm.Memory.find((x: any) => Number(x.Id) === Number(def.Id));
    if (!m) { m = { Id: Number(def.Id), FmFlag: 0, RewardState: 2, MemoryName: react }; gm.Memory.push(m); }
    m.FmFlag = (Number(m.FmFlag) || 0) | (1 << (lv - 1));
    ctx.store.putUser(ctx.session.accountId, snap);
  }
  return [{ name: 'MsgDateProposeAns', body: { Seq: 1, Result: 1, GirlInfo: g, UserInfo: snap.UserInfo, ...(script ? { Script: script } : {}) } }];
});

register('MsgDateStartReq', (body, ctx): Msg[] => {
  init();
  const snap = ctx.store.getUser(ctx.session.accountId);
  const fail = (why: string, Result = 2): Msg[] => {
    console.warn(`[date] 시작 거절: ${why} ${JSON.stringify(body)}`);
    return [{ name: 'MsgDateStartAns', body: { Seq: 1, Result, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  };
  if (!snap) return fail('계정 없음');
  const g = myGirl(snap, body?.GirlInfo?.Girlid);
  if (!g) return fail('보유하지 않은 캐릭터');
  // 백화점: 튜토리얼 기록은 DateType 3, 일반 기록(2026-11-05, 클라이언트 OnClickDept)은 장소 없이 {GirlInfo:{Girlid}} 만 보낸다
  if (Number(body?.DateType) === 3 || body?.DatePlace === undefined) return departmentStart(snap, g, ctx);
  const place = places!.get(Number(body?.DatePlace));
  if (!place) return fail(`장소 데이트가 아님 (DateType ${body?.DateType ?? '-'}: 백화점 등은 실서버 기록이 더 필요해 미구현)`);
  const ui = snap.UserInfo;
  const girl = Number(g.Girlid), lv = famLevel(g, Number(g.Familiarity) || 0);
  if (lv < (Number(place.UnlockFmLevel) || 1)) return fail(`호감도 단계 부족 (${lv} < ${place.UnlockFmLevel})`); // 추정: 거절 코드 미확인
  const price = Number(place.Price) || 0;
  if ((Number(ui.Coin) || 0) < price) return fail('코인 부족', 3);
  // 티켓 장소: 티켓 1장 소모. 실기록(경기장 60010): 시작 응답 ItemInfo [{Itemid, Itemtype, Count 남은 수, StackNum 남은 수}]
  const ticket = Number(place.Ticketid) || 0;
  const ticketItems: any[] = [];
  if (ticket) {
    const it = (snap.Items?.ItemInfo ?? []).find((x: any) => Number(x.Itemtype) === ticket && Number(x.Count) > 0);
    // 티켓이 없으면 클라이언트가 '입장 불가'를 띄우고 요청을 보내지 않는다 (사용자 확인 2026-11-02). 아래는 안전장치.
    if (!it) return fail(`티켓 ${ticket} 없음`);
    it.Count = Number(it.Count) - 1;
    ticketItems.push({ Itemid: it.Itemid, Itemtype: ticket, Count: it.Count, StackNum: it.Count });
    if (it.Count <= 0) snap.Items.ItemInfo = snap.Items.ItemInfo.filter((x: any) => x !== it);
  }
  ui.Coin -= price;
  const mood = placeMood(girl, Number(place.Id), Number(g.LastDatePlace) || 0);
  const tutorial = !(Number(ui.Completion) & TUT_DATE);
  const chunks: any[] = [];
  let st: DateState;
  const intro = placeIns(girl, place, lv);
  if (mood && !tutorial) intro.splice(intro.findIndex((o) => o.Function === 'CHANGE') + 1, 0, mood.notice);
  const moodChunk = mood && !tutorial && scriptRows(girl, mood.event, lv).length
    ? chunk(girl, mood.event, lv, scriptRows(girl, mood.event, lv).map((r) => {
      const o = toIns(r);
      // CHANGE: ND -> 장소 Id, 표정이 없으면 face_basic, 5번째 = 장소 AmbiSound 또는 NONE (실기록 Preference_A·Date_Boring)
      if (o.Function === 'CHANGE' && o.Parameter) {
        if (o.Parameter[0] === 'ND') o.Parameter[0] = String(place.Id);
        if (o.Parameter.length < 4) o.Parameter.push('face_basic');
        if (o.Parameter.length < 5) o.Parameter.push(place.AmbiSound || 'NONE');
      }
      return o;
    })) : null;
  const events = moodChunk ? [mood!.event] : [];
  if (tutorial || !hasQuestions(girl, place.ScriptName, lv)) {
    // 문항 없음: 시작, 사건(문항·선물이 있으면 Index 1), 종료, 결과·마침 인덱스
    const ev = eventChunk(girl, lv, Number(g.Familiarity) || 0, tutorial, 1);
    chunks.push(chunk(girl, place.ScriptName, lv, intro));
    if (moodChunk) chunks.push(moodChunk);
    if (ev) { chunks.push(ev.chunk); events.push(ev.name); }
    chunks.push(chunk(girl, 'Date_End_Basic', lv, scriptRows(girl, 'Date_End_Basic', lv).map((r) => toIns(r))));
    const r = ev?.ask ? 2 : 1;
    chunks.push(chunk(girl, place.ScriptName, lv, [{ Index: r }, { Index: r + 1 }]));
    st = { girl, place: place.Id, lv, tutorial, likes: 0, dislikes: 0, chat: ev?.ask && !ev.gift ? ev.name : null, chatSat: 0,
      resultIndex: r, finalIndex: r + 1, end: 'Date_End_Basic', events, gift: !!ev?.gift };
  } else {
    const qs = [...questionIns(girl, place.ScriptName, lv, 1, 1), ...questionIns(girl, place.ScriptName, lv, 2, 2)];
    if (moodChunk) { chunks.push(chunk(girl, place.ScriptName, lv, intro), moodChunk, chunk(girl, place.ScriptName, lv, qs)); }
    else chunks.push(chunk(girl, place.ScriptName, lv, [...intro, ...qs]));
    chunks.push(chunk(girl, place.ScriptName, lv, [{ Index: 3 }, { Index: 4 }]));
    st = { girl, place: place.Id, lv, tutorial, likes: 0, dislikes: 0, chat: null, chatSat: 0, resultIndex: 3, finalIndex: 4, events };
  }
  setState(ctx, st);
  ctx.store.putUser(ctx.session.accountId, snap);
  return [
    { name: 'MsgDateStartAns', body: { Seq: 1, Result: 1, UserInfo: ui, GirlInfo: { Girlid: girl }, DatePlace: place.Id, ItemInfo: ticketItems } },
    { name: 'MsgLoadScript', body: { Seq: 2, Script: { Chunk: chunks } } },
  ];
});

// 데이트 중 나가기. 실기록(2026-11-02, 20101 공원 시작 직후): 요청 {} -> MsgDateResultAns 하나
//   {Seq, GirlInfo(DateCoolTime = 지금 + 쿨타임, 그 밖은 그대로), UserInfo, GgraphPatch {Gnode []}, CallScript [], GirlMemorySet}.
//   장소 비용(코인 100)은 돌려주지 않고, 친밀도·NthDate·일일 미션도 그대로.
register('MsgDateStopReq', (_body, ctx): Msg[] => {
  init();
  const snap = ctx.store.getUser(ctx.session.accountId);
  const st = getState(ctx);
  const g = snap && st && myGirl(snap, st.girl);
  setState(ctx, null);
  if (!snap || !g) return [{ name: 'MsgDateResultAns', body: { Seq: 1, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  g.DateCoolTime = Math.floor(Date.now() / 1000) + coolSec(Number(g.Girlid));
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgDateResultAns', body: { Seq: 1, GirlInfo: g, UserInfo: snap.UserInfo, GgraphPatch: { Gnode: [] }, CallScript: [],
    GirlMemorySet: snap.GirlMemorySet ?? { GirlMemory: [], Version: 1 } } }];
});

register('MsgScriptProgressReq', (body, ctx): Msg[] => {
  init();
  const snap = ctx.store.getUser(ctx.session.accountId);
  const st = getState(ctx);
  const index = Number(body?.Index) || 0, depth = Number(body?.Depth) || 0;
  const head = { Seq: 1, Index: index, Depth: depth };
  if (!snap || !st) {
    console.warn(`[date] 진행 중인 데이트 없음 ${JSON.stringify(body)}`);
    return [{ name: 'MsgScriptProgressAns', body: head }];
  }
  const g = myGirl(snap, st.girl);
  const place = places!.get(st.place);
  const ui = snap.UserInfo;
  const save = () => { setState(ctx, st); ctx.store.putUser(ctx.session.accountId, snap); };
  if (st.dept) return departmentProgress(snap, g, st, body, head, ctx, save);

  // 채팅 이벤트 답 (튜토리얼은 Depth 0 Index 1, 일반은 Depth 1 Index 5)
  const isChat = (st.tutorial || st.resultIndex === 2) && !st.gift ? depth === 0 && index === 1 : depth === 1 && index === 5;
  // 선물 사건 (실기록 20102 단계 1: GiftFromGirl {ItemInfo [{61001, 100, DeltaNum 100}], CarInfo [], GirlItemInfo []} + UserInfo.
  //   추정: 코인 100 x 친밀도 단계)
  if (st.gift && ((depth === 1 && index === 5) || (depth === 0 && index === 1 && st.resultIndex === 2))) {
    const coin = 100 * st.lv;
    ui.Coin = (Number(ui.Coin) || 0) + coin;
    st.gift = false;
    save();
    return [{ name: 'MsgScriptProgressAns', body: { ...head, GiftFromGirl: { ItemInfo: [{ Itemtype: 61001, Count: coin, DeltaNum: coin }], CarInfo: [], GirlItemInfo: [] }, UserInfo: ui } }];
  }
  if (isChat && st.chat) {
    const ansRows = scriptRows(st.girl, st.chat, st.lv).filter((r) => r.Function === 'ANSWER');
    const a = ansRows[(Number(body?.AnswerSelect) || 1) - 1] ?? ansRows[ansRows.length - 1];
    const [grade, sname, fam] = [a?.Parameter1 ?? 'Pass', a?.Parameter2 ?? '', Number(a?.Parameter3) || 0];
    g.Familiarity = (Number(g.Familiarity) || 0) + fam;
    syncGirl(g);
    st.chatSat = grade === 'Best' ? 2 : grade === 'Good' ? 1 : 0;
    save();
    return [{ name: 'MsgScriptProgressAns', body: { ...head, GirlInfo: g,
      Script: { Chunk: [chunk(st.girl, sname, st.lv, scriptRows(st.girl, sname, st.lv).map((r) => toIns(r)))] } } }];
  }

  // 일반 데이트 문항 1·2
  if (!st.tutorial && st.resultIndex === 3 && depth === 0 && (index === 1 || index === 2)) {
    const ans = Number(body?.AnswerSelect) || 1;
    const liked = answers[`${st.girl}|${place.ScriptName}|${st.lv}|${index}`] ?? 1;
    const good = ans === liked;
    if (good) st.likes++; else st.dislikes++;
    const resChunk = chunk(st.girl, place.ScriptName, st.lv, [
      { Function: 'DATE_NOTICE', TextTag: good ? 'date_notice_10' : 'date_notice_11', Parameter: ['1.5', good ? '2' : '3'] },
      ...(answerTag(st.girl, place.ScriptName, st.lv, index, ans) ? [{ Function: 'SCRIPT', TextTag: answerTag(st.girl, place.ScriptName, st.lv, index, ans) }] : []),
    ]);
    const chunks = [resChunk];
    if (index === 2) {
      const ev = eventChunk(st.girl, st.lv, Number(g.Familiarity) || 0, false, 5);
      if (ev) { chunks.push(ev.chunk); (st.events ??= []).push(ev.name); if (ev.gift) st.gift = true; else if (ev.ask) st.chat = ev.name; }
      // 종료 대본 (실기록: 좋아함 0 -> Basic, 좋아함 1 -> Basic 1건·Good 1건, 싫어함 2 -> Bad (2026-11-05 5건). 추정: 2개 Good, 1개 Good/Basic 반반)
      st.end = st.dislikes >= 2 ? 'Date_End_Bad' : st.likes >= 2 ? 'Date_End_Good' : st.likes === 1 ? (Math.random() < 0.5 ? 'Date_End_Good' : 'Date_End_Basic') : 'Date_End_Basic';
      if (!scriptRows(st.girl, st.end, st.lv).length) st.end = 'Date_End_Basic';
      chunks.push(chunk(st.girl, st.end, st.lv, scriptRows(st.girl, st.end, st.lv).map((r) => toIns(r))));
    }
    save();
    return [{ name: 'MsgScriptProgressAns', body: { ...head, ActionResult: good ? 3 : 1, ReactionType: 0, Script: { Chunk: chunks } } }];
  }

  // 결과
  if (depth === 0 && index === st.resultIndex) {
    // 만족도 = 3 + 좋아한 답 - 싫어한 답 (실기록 2026-11-05 통제 실험 포함: 좋아함 2 -> 5 (28/29건), 싫어함 2 -> 1 (5/5건, 20405 lv3).
    //   예전 기록 해석 '좋아함 1·싫어함 1 -> 4' 는 1건뿐이라 3 으로 둔다(추정). 문항 없는 데이트는 3)
    const sat = Math.max(1, Math.min(5, 3 + st.likes - st.dislikes));
    st.satisfaction = sat;
    const delta = Math.round((Number(place.Familiarity) || 0) * MULT[sat]);
    const firstAtPlace = !(g.DatingState ?? []).some((x: any) => Number(x.Placeid) === st.place);
    const bonus = firstAtPlace ? Number(gdef(st.girl)?.FirstDatePlaceBonus) || 0 : 0;
    st.end ??= 'Date_End_Basic';
    (st as any).firstDate = (Number(g.NthDate) || 0) === 0;
    g.Familiarity = (Number(g.Familiarity) || 0) + delta + bonus;
    syncGirl(g);
    g.SameDateCnt = Number(g.LastDatePlace) === st.place ? (Number(g.SameDateCnt) || 0) + 1 : 0;
    g.NthDate = (Number(g.NthDate) || 0) + 1;
    g.LastDatePlace = st.place;
    g.DateCoolTime = Math.floor(Date.now() / 1000) + coolSec(Number(g.Girlid));
    g.DatingState ??= [];
    const ds = g.DatingState.find((x: any) => Number(x.Placeid) === st.place);
    if (ds) ds.MaxRecord = Math.max(Number(ds.MaxRecord) || 0, sat); else g.DatingState.push({ Placeid: st.place, MaxRecord: sat });
    const xp = Number(place.XP) || 0;
    ui.Charexp = (Number(ui.Charexp) || 0) + xp;
    delete ui.LevelUp;
    levelUp(snap);
    const uiOut = { ...ui };
    // 친밀도 단계 장면: 단계 3 / 최대(4)에 오른 뒤 첫 데이트 결과에 FamiliarityLv3 / FamiliarityLvMax 덩어리
    //   (실기록: 20105 백화점 데이트로 단계 3 도달 -> 다음 경기장 데이트 결과에 FamiliarityLv3, 그다음 영화관 결과에는 없음).
    //   본 적 있는지는 기억(girlMemoryTable FamiliarityLv3) 기록으로 판단. 선물·문항 행이 있는 장면은 건너뜀(추정).
    const scene = st.lv >= 4 ? 'FamiliarityLvMax' : st.lv >= 3 ? 'FamiliarityLv3' : null;
    const seen = (snap.GirlMemorySet?.GirlMemory ?? []).find((x: any) => Number(x.Girlid) === st.girl)?.Memory ?? [];
    const sceneDef = scene && memories!.find((m: any) => Number(m.GirlId) === st.girl && m.Scriptname === scene);
    const sceneRows = scene ? scriptRows(st.girl, scene, st.lv) : [];
    const showScene = !!scene && sceneRows.length > 0 && !sceneRows.some((r) => r.Function === 'GIFT' || r.Function === 'QUESTION')
      && !(sceneDef && seen.some((x: any) => Number(x.Id) === Number(sceneDef.Id)));
    if (showScene) (st.events ??= []).push(scene!);
    save();
    return [{ name: 'MsgScriptProgressAns', body: { ...head, UserInfo: uiOut, DeltaInfo: { Charexp: xp },
      GirlInfo: { ...g, DeltaFamiliarity: delta, BonusFamiliarity: bonus },
      DateReward: { DateResult: sat, Satisfaction: sat, RewardInfo: { Charexp: xp } },
      ...(showScene ? { Script: { Chunk: [chunk(st.girl, scene!, st.lv, sceneRows.map((r) => toIns(r)))] } } : {}) } }];
  }

  // 종료
  if (depth === 0 && index === st.finalIndex) {
    const sat = st.satisfaction ?? 3;
    // 기억
    snap.GirlMemorySet ??= { GirlMemory: [], Version: 1 };
    let gm = snap.GirlMemorySet.GirlMemory.find((x: any) => Number(x.Girlid) === st.girl);
    if (!gm) { gm = { Girlid: st.girl, Memory: [] }; snap.GirlMemorySet.GirlMemory.push(gm); }
    // 기억: 시작·장소·종료 + 이번 데이트의 사건(채팅·힌트·선호·단계 장면). 실기록: 이름은 girlMemoryTable Scriptname 또는 Girlscript
    //   (20105 Chat_B 는 Scriptname '20105_Event_Chat_B', MemoryName 'Date_Event_Chat_B'). Chat_B 의 FmFlag 는 기록상 64(의미 미확인 -> 단계 비트로 둠)
    const names = [...(st.tutorial ? [] : ['Date_Start']), place.ScriptName, st.end ?? 'Date_End_Basic', ...(st.events ?? [])];
    for (const n of names) {
      const def = memories!.find((m: any) => Number(m.GirlId) === st.girl && (m.Scriptname === n || m.Girlscript === n));
      if (!def) continue;
      let m = gm.Memory.find((x: any) => Number(x.Id) === Number(def.Id));
      if (!m) { m = { Id: Number(def.Id), FmFlag: 0, RewardState: 2, MemoryName: def.Girlscript ?? n }; gm.Memory.push(m); }
      m.FmFlag = (Number(m.FmFlag) || 0) | (1 << (st.lv - 1));
    }
    // 기분(Emotion: 0 보통, 1 삐침, 2 화남(차단), 3 즐거움 — 클라이언트 열거형). 실기록 전이(이전, 만족도 -> 이후), 2026-11-05 실험 포함:
    //   보통: 4·5 -> 즐거움(12건), 1·3 -> 보통(6건) / 즐거움: 3·4·5 -> 즐거움(66건), 2 -> 보통(5건), 1 -> 보통(문항 없음 1건)
    //   싫어한 답이 있는 만족도 1 데이트 -> 화남 (즐거움 -> 화남 1건, 화남 유지 4건; 클라이언트 안내 '다른 대답을 해 보세요')
    //   화남: 3·5 -> 보통 (2건). 백화점 데이트(만족도 0)는 그대로. 삐침(1)은 서버 주기 판정(girlTable PeevishCondition/Value) — 미구현, 그대로 둔다.
    //   추정: 싫어함 1개로 만족도 2 가 된 경우도 화남, 화남에서 4 -> 보통
    {
      const e = Number(g.Emotion) || 0;
      if (e !== 1 && sat > 0) {
        if (sat <= 2 && st.dislikes > 0) g.Emotion = 2;
        else if (e === 2) g.Emotion = sat >= 3 ? 0 : 2;
        else if (e === 3) g.Emotion = sat >= 3 ? 3 : 0;
        else g.Emotion = sat >= 4 ? 3 : 0;
      }
    }
    //   CauseOfPeevish·SolutionForPeevish(0) 는 기분이 0 이 아니게 될 때 레코드에 생긴다 (실기록: 기분 3·2 결과에만 있음)
    if (Number(g.Emotion) !== 0) { g.CauseOfPeevish ??= 0; g.SolutionForPeevish ??= 0; }
    // 첫 데이트 후 관계도 다음 노드 개방
    const patch: any[] = [];
    if ((st as any).firstDate) {
      const nodes: any[] = snap.Ggraph?.Gnode ?? [];
      const mine = nodes.find((n) => Number(n.GirlInfo?.Girlid) === st.girl);
      const next = mine && nodes.find((n) => Number(n.NodeId) === Number(mine.NodeId) + 1);
      if (next && Number(next.State) !== 7 && next.GirlInfo?.Girlid) {
        next.State = 7;
        const ng = ensureGirl(snap, Number(next.GirlInfo.Girlid));
        Object.assign(ng, { Familiarity: 0, NextCoin: 100 });
        next.GirlInfo = ng;
        patch.push(next);
      }
    }
    // 연락처 해금 조건 (호감도 단계·데이트 조건). 바뀐 캐릭터 레이스는 MsgUpdateData 로 (추정: 데이트로 열리는 기록 없음)
    const unlock = evalGirlUnlocks(snap, st.girl);
    for (const n of unlock.nodes) if (!patch.includes(n)) patch.push(n);
    const raceUpdate = [...unlock.races].map(([ZoneId, ChangeRace]) => ({ ZoneId, ChangeRace }));
    const propChanged = bumpProperty(snap, 'DQUEST_DATE', 1);
    // 퀘스트 사건 4: [횟수, 캐릭터|[FIRSTGIRL], 장소?, 만족도 이상?] (10101 호텔뷔페 42082, 10204 만족도 4 이상 3회)
    questEvent(snap, 4, (p) => (!p[1] || p[1] === '[FIRSTGIRL]' ? Number(snap.UserInfo?.FirstGirl) : Number(p[1])) === st.girl
      && (!p[2] || Number(p[2]) === st.place) && (!p[3] || sat >= Number(p[3])));
    const questChanges = refreshQuests(snap);
    setState(ctx, null);
    ctx.store.putUser(ctx.session.accountId, snap);
    return [
      { name: 'MsgScriptProgressAns', body: head },
      { name: 'MsgDateResultAns', body: {
        Seq: 2, GirlInfo: g, UserInfo: ui, DatePlace: st.place, DateResult: sat, UpdateGirlInfo: [],
        GirlMemorySet: snap.GirlMemorySet, GgraphPatch: { Gnode: patch }, CallScript: [], ...(propChanged ? { PropertySet: snap.PropertySet } : {}),
      } },
      ...(questChanges.length ? [{ name: 'MsgUpdateNquest', body: { Seq: 3, NquestInfo: questChanges } }] : []),
      ...(raceUpdate.length ? [{ name: 'MsgUpdateData', body: { Seq: 4, UpdateData: { RaceZone: raceUpdate } } }] : []),
    ];
  }

  console.warn(`[date] 처리하지 않은 진행 단계 ${JSON.stringify(body)}`);
  return [{ name: 'MsgScriptProgressAns', body: head }];
});

// ── 백화점 데이트 (DateType 3) ─────────────────────────────────────────────
// 실기록 1건(2026-11-01, 20105 친밀도 630 단계 3, 첫 백화점 = 튜토리얼):
//   시작 {Result 1, UserInfo, GirlInfo:{Girlid}} + 대본 [CHANGE ["40017", 캐릭터, "SYSTEM", "face_basic"], Date_Department 행, {SHOPLIST [캐릭터] Index 1}, {Index 2}]
//     Completion 에 DepartmentStore(536870912) 비트, 코인 차감 없음.
//   Index 1 AnswerSelect = 선물 비트 합 (클라이언트 ShopList FLAGS [0 아이쇼핑, 1, 2, 4, 8, 64]):
//     64(선물 5 = 전용 드레스): 친밀도 + PresentFamiliarityRise5(600), ItemFlag |= 64, 캐릭터 아이템(girlItemTable 같은 캐릭터 Slot 10) 지급,
//     GirlItemInfo [{ItemId, ItemType, StackNum 1}], SpecialDressSlot = ItemId, SpecialDressVisibleCheck true, AppearanceChanged true,
//     대본 Date_Event_Shopping_B (CHANGE 3번째 인자 = 아이템, POPUP 행 Index 3). 튜토리얼이라 PresentPrice5(6890) 미차감.
//   Depth 1 Index 3 -> {GiftForGirl {Girlid, GiftIndex 5, Count 1}, GirlInfo {Girlid, Familiarity, DeltaFamiliarity}}
//   Index 2 -> DateResultAns {GirlInfo(DateCoolTime +30초), UserInfo, GgraphPatch [], CallScript [], UpdateGirlInfo [], GirlMemorySet}
//     기억: Date_Department, Date_Event_Shopping_B (FmFlag 단계 비트), 아이템 {Id: 아이템, RewardState 1}
// 실기록 2026-11-05 (20404, 튜토리얼 아님): 선물 1~4 동시(15) -> 코인 -5,800, 친밀도 +720, 액세서리 4개 지급·장착, 대본 Date_Event_Shopping_A
//   (UNLOCK [캐릭터, ACC], CHANGE [40017, 캐릭터, SYSTEM, face_joyful], POPUP GIFT Index 3), 결과 DateCoolTime +30초.
//   선물 5(64) -> 코인 -PresentPrice5(7,540), 친밀도 +720, 82511(DR_hidden_001) 지급, SpecialDressSlot = ItemId, Shopping_B.
// 추정(기록 없음): 아이쇼핑(0: EyeShoppingFamiliarity/XP,
//   Date_Event_Eyeshopping), 튜토리얼 외 선물 5 가격 차감, 여러 선물 동시 구매 시 GiftIndex(가장 높은 번호)·Count(개수).
const TUT_DEPARTMENT = 536870912;
const DEPT_PLACE = '40017';
const GIFT_FLAGS = [0, 1, 2, 4, 8, 64];

function departmentStart(snap: any, g: any, ctx: Ctx): Msg[] {
  const ui = snap.UserInfo;
  const girl = Number(g.Girlid), lv = famLevel(g, Number(g.Familiarity) || 0);
  const tutorial = !(Number(ui.Completion) & TUT_DEPARTMENT);
  ui.Completion = Number(ui.Completion) | TUT_DEPARTMENT;
  const ins = [{ Function: 'CHANGE', Parameter: [DEPT_PLACE, String(girl), 'SYSTEM', 'face_basic'] },
    ...scriptRows(girl, 'Date_Department', lv).map((r) => toIns(r)),
    { Function: 'SHOPLIST', Parameter: [String(girl)], Index: 1 }, { Index: 2 }];
  setState(ctx, { girl, place: 0, lv, tutorial, likes: 0, dislikes: 0, chat: null, chatSat: 0, resultIndex: -1, finalIndex: 2,
    dept: { scripts: ['Date_Department'] } });
  ctx.store.putUser(ctx.session.accountId, snap);
  return [
    { name: 'MsgDateStartAns', body: { Seq: 1, Result: 1, UserInfo: ui, GirlInfo: { Girlid: girl } } },
    { name: 'MsgLoadScript', body: { Seq: 2, Script: { Chunk: [chunk(girl, 'Date_Department', lv, ins)] } } },
  ];
}

function departmentProgress(snap: any, g: any, st: DateState, body: any, head: any, ctx: Ctx, save: () => void): Msg[] {
  const ui = snap.UserInfo;
  const girl = st.girl, lv = st.lv;
  const d = gdef(girl) ?? {};
  const index = Number(body?.Index) || 0, depth = Number(body?.Depth) || 0;
  if (depth === 0 && index === 1) {
    const sel = Number(body?.AnswerSelect) || 0;
    const picked = GIFT_FLAGS.map((f, i) => (i > 0 && sel & f ? i : 0)).filter(Boolean);
    let delta = 0, xp = 0, name = 'Date_Event_Eyeshopping';
    const items: any[] = [];
    const extraGirl: any = {};
    if (!picked.length) {
      delta = Number(d.EyeShoppingFamiliarity) || 0; xp = Number(d.EyeShoppingXP) || 0;
    } else {
      const cost: Record<string, number> = { Coin: 0, Cash: 0, SocialPoint: 0 };
      for (const i of picked) {
        if (Number(g.ItemFlag) & GIFT_FLAGS[i]) continue; // 이미 산 선물
        const unit = ['Coin', 'Cash', 'SocialPoint'][Number(d[`PresentPriceUnit${i}`]) || 0];
        if (!(st.tutorial && i === 5)) cost[unit] += Number(d[`PresentPrice${i}`]) || 0;
        delta += Number(d[`PresentFamiliarityRise${i}`]) || 0;
      }
      if ((Number(ui.Coin) || 0) < cost.Coin || (Number(ui.Cash) || 0) < cost.Cash || (Number(ui.SocialPoint) || 0) < cost.SocialPoint) {
        console.warn(`[date] 백화점 선물 재화 부족 ${JSON.stringify(cost)}`);
        return [{ name: 'MsgScriptProgressAns', body: { ...head, Result: 3, UserInfo: ui } }];
      }
      ui.Coin -= cost.Coin; ui.Cash -= cost.Cash; ui.SocialPoint = (Number(ui.SocialPoint) || 0) - cost.SocialPoint;
      // 선물 1~4 = 그 캐릭터 전용 액세서리 (girlItemTable SellPrice<0, Id%100 == 40+i). 실기록 2026-11-05 20404 AnswerSelect 15:
      //   82541(Slot 6)·82542(5)·82543(7)·82544(8) 지급, 코인 -5,800 (500+1100+1800+2400), 친밀도 +720 (PresentFamiliarityRise 180 x4,
      //   친밀도 4290 > PresentFamiliarityCap 3960 이어도 올랐다), 빈 칸이면 바로 장착 (Slot 5..8 -> AccessorySlot1..4 = ItemId).
      const girlItems = (table('girlItemTable.json')?.GirlItemInfo ?? []).filter((x: any) => Number(x.GirlId) === girl);
      for (const i of picked.filter((k) => k >= 1 && k <= 4 && !(Number(g.ItemFlag) & GIFT_FLAGS[k]))) {
        const acc = girlItems.find((x: any) => Number(x.SellPrice) < 0 && Number(x.Id) % 100 === 40 + i);
        if (!acc) continue;
        snap.GirlItems ??= { GirlItemInfo: [], Version: 1 };
        const list = snap.GirlItems.GirlItemInfo ??= [];
        const itemId = list.reduce((m: number, x: any) => Math.max(m, Number(x.ItemId) || 0), 0) + 1;
        const it = { ItemId: itemId, ItemType: Number(acc.Id), StackNum: 1 };
        list.push(it); items.push(it);
        const slotKey = `AccessorySlot${Number(acc.Slot) - 4}`;
        if (Number(acc.Slot) >= 5 && Number(acc.Slot) <= 8 && !(Number(g[slotKey]) > 0)) { g[slotKey] = itemId; extraGirl.AppearanceChanged = true; }
      }
      g.ItemFlag = picked.reduce((f, i) => f | GIFT_FLAGS[i], Number(g.ItemFlag) || 0);
      name = picked.includes(5) ? 'Date_Event_Shopping_B' : 'Date_Event_Shopping_A';
      if (picked.includes(5)) {
        // 선물 5 = 그 캐릭터의 숨겨진 드레스 (Slot 10, Resource 'DR_hidden_*', 실기록 80511)
        const dresses = (table('girlItemTable.json')?.GirlItemInfo ?? []).filter((x: any) => Number(x.GirlId) === girl && Number(x.Slot) === 10);
        const dress = dresses.find((x: any) => /hidden/i.test(String(x.Resource))) ?? dresses[0];
        if (dress) {
          snap.GirlItems ??= { GirlItemInfo: [], Version: 1 };
          const list = snap.GirlItems.GirlItemInfo ??= [];
          const itemId = list.reduce((m: number, x: any) => Math.max(m, Number(x.ItemId) || 0), 0) + 1;
          const it = { ItemId: itemId, ItemType: Number(dress.Id), StackNum: 1 };
          list.push(it); items.push(it);
          Object.assign(g, { SpecialDressSlot: itemId, SpecialDressVisibleCheck: true });
          extraGirl.AppearanceChanged = true;
        }
      }
      st.dept!.gift = { index: Math.max(...picked), count: picked.length, delta };
    }
    g.Familiarity = (Number(g.Familiarity) || 0) + delta;
    syncGirl(g);
    if (xp) { ui.Charexp = (Number(ui.Charexp) || 0) + xp; levelUp(snap); }
    st.dept!.scripts.push(name);
    // CHANGE 의 3번째 인자는 선물 5 드레스만 (Shopping_A 기록은 'SYSTEM' 그대로)
    const dressType = picked.includes(5) ? items[items.length - 1]?.ItemType : undefined;
    const ins = scriptRows(girl, name, lv).map((r) => {
      const o = toIns(r, r.Function === 'POPUP' ? { Index: 3 } : {});
      if (o.Function === 'CHANGE' && o.Parameter) { o.Parameter[0] = DEPT_PLACE; if (dressType) o.Parameter[2] = String(dressType); }
      return o;
    });
    // 한계 돌파 조건이 다 갖춰지면(수영복 구입 등) 알림 목록에 넣는다 (실기록 0084: GirlRarityExpandId [20404])
    let rxIds: number[] | null = null;
    if (expansionReady(snap, g) && !(snap.GirlRarityExpandId ?? []).map(Number).includes(girl)) {
      snap.GirlRarityExpandId = [...(snap.GirlRarityExpandId ?? []), girl];
      rxIds = snap.GirlRarityExpandId;
    }
    save();
    return [{ name: 'MsgScriptProgressAns', body: { Seq: 1, Index: index, ...(items.length ? { GirlItemInfo: items } : {}),
      Script: { Chunk: [chunk(girl, name, lv, ins)] }, UserInfo: ui, GirlInfo: { ...g, DeltaFamiliarity: delta, ...extraGirl },
      ...(rxIds ? { GirlRarityExpandId: rxIds } : {}) } }];
  }
  if (depth === 1 && index === 3) {
    const gift = st.dept!.gift;
    return [{ name: 'MsgScriptProgressAns', body: { Seq: 1, Index: index,
      ...(gift ? { GiftForGirl: { Girlid: girl, GiftIndex: gift.index, Count: gift.count } } : {}),
      GirlInfo: { Girlid: girl, Familiarity: g.Familiarity, DeltaFamiliarity: gift?.delta ?? 0 } } }];
  }
  if (depth === 0 && index === st.finalIndex) {
    g.DateCoolTime = Math.floor(Date.now() / 1000) + coolSec(Number(g.Girlid));
    snap.GirlMemorySet ??= { GirlMemory: [], Version: 1 };
    let gm = snap.GirlMemorySet.GirlMemory.find((x: any) => Number(x.Girlid) === girl);
    if (!gm) { gm = { Girlid: girl, Memory: [] }; snap.GirlMemorySet.GirlMemory.push(gm); }
    // 기록 순서: 받은 아이템 {Id, RewardState 1} 이 대본 기억보다 먼저
    //   이 캐릭터의 아이템만 (2026-11-05 재생 비교: 다른 캐릭터 수영복 80511 이 끼어들던 문제)
    const ownDefs = new Set((table('girlItemTable.json')?.GirlItemInfo ?? []).filter((x: any) => Number(x.GirlId) === girl).map((x: any) => Number(x.Id)));
    for (const it of snap.GirlItems?.GirlItemInfo ?? []) {
      if (!ownDefs.has(Number(it.ItemType))) continue;
      if (!gm.Memory.some((x: any) => Number(x.Id) === Number(it.ItemType))) gm.Memory.push({ Id: Number(it.ItemType), RewardState: 1 });
    }
    for (const n of st.dept!.scripts) {
      const def = memories!.find((m: any) => Number(m.GirlId) === girl && m.Scriptname === n);
      if (!def) continue;
      let m = gm.Memory.find((x: any) => Number(x.Id) === Number(def.Id));
      if (!m) { m = { Id: Number(def.Id), FmFlag: 0, RewardState: 2, MemoryName: n }; gm.Memory.push(m); }
      m.FmFlag = (Number(m.FmFlag) || 0) | (1 << (lv - 1));
    }
    setState(ctx, null);
    ctx.store.putUser(ctx.session.accountId, snap);
    return [
      { name: 'MsgScriptProgressAns', body: head },
      { name: 'MsgDateResultAns', body: { Seq: 2, GirlInfo: g, UserInfo: ui, GgraphPatch: { Gnode: [] }, CallScript: [], UpdateGirlInfo: [],
        GirlMemorySet: snap.GirlMemorySet } },
    ];
  }
  console.warn(`[date] 백화점: 처리하지 않은 진행 단계 ${JSON.stringify(body)}`);
  return [{ name: 'MsgScriptProgressAns', body: head }];
}
