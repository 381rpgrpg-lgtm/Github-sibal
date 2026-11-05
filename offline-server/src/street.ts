// 거리 이름(Street Name): 레이스 방식으로 얻는 단어(접두 P · 핵심 C · 끝 E)와 그 통계(Facts).
//
// 단어 표: 클라이언트 엔진 engine-C3PtOFdR.js (deob 57582~57907 의 ii()/Qe() 정의, 모델 표 Qb 50689~, 캐릭터 pT 57504~)를
//   그대로 실행해 뽑은 표(src/data/street-words.json, streetwords.ts 가 읽음, 412개). 단어 {id, s 칸, t 표시어, r 등급 0~4, g 묶음, need [[fact, n], ...]}.
//   표시 문구(조건 설명·등급 이름)는 클라이언트가 같은 표로 만든다(factText/wordText). 판정은 클라이언트 progressOf 와 같다:
//   need 를 모두 Facts[fact] >= n 으로 만족하면 획득. 'start' 단어(need start 0)는 처음부터 가진다.
//
// Facts (실기록 MsgStreetNamesAns 21개 스냅샷 사이의 레이스 205건을 재생: 모든 카운터·Earned·New·Suggest, 결과별 StreetWordsNew 34건 일치):
//   races 결과 수(패배 포함, 스토리·이벤트·주간·월드 투어), wins/losses, night/day (Thema -> 테마, CAN·HWN 이 밤: 엔진 rle),
//   crazy = ExcellentCnt 합, crazyBest = 한 판 ExcellentCnt 최대, nitro = NitroUseNum 합, perfect = PerfectStart 수,
//   pure = 니트로 0 승리, photo = 0.2초 미만 차 승리, blowout = 10초 넘게 이긴 승리 (상대 기록 0 = 주간 레이스는 제외),
//   combo = ComboCount 최대, speed = floor(LinearMaxSpeed) 최대, g1Wins = ★1 차량 승리,
//   streak/streakBest = 최고 연승 (실기록 두 값이 늘 같다. 현재 연승은 숨은 값 cur 로 따로 센다),
//   model:<모델> (Cartype/100, 엔진 Bne 별칭), body:<차체>, country:<국가> (Qb.shown ?? cars CarFlag ?? Qb.flag),
//   grade:<차량 Grade>, paint:<도색 색 이름>, theme:<테마>, girl:<동승 캐릭터> (캐릭터 레이스처럼 동승 -1 이면 없음),
//   modelMax/modelsDriven(10판 이상 모델 수)/girlMax/girlsRidden(10판 이상)/girlsAll(모든 캐릭터 최소)/themesAll(8개 테마 최소),
//   wt = 월드 투어 최고 등급(1 브론즈 ~ 5 다이아), album = Collections 수, ach = 업적 State>=2 수, aura:<보유 코스메틱 id> = 1.
// 추정·미확인: paint 색 이름(색표 UIDiffuse 의 HSV 구간, 기록은 흰색·빨강만. 특수 도색 코스메틱은 보지 않음), PvP 통계(pvp*·slayer, 기록에 대전 결과 없음),
//   PvP 대전을 races 등 일반 카운터에도 넣는 것, 기권 결과는 세지 않음, kit:*(차고 키트 미구현), pioneer·flick·harbour·award:*
//   (오프라인에서 계산 불가: 녹화 Facts 를 이어받은 값만), 추천 이름(Suggest) 고르는 순서.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { table, carDefOf } from './gamecalc.js';
import { STREET_WORDS, STREET_MODELS, STREET_MODEL_ALIAS, STREET_GIRLS, type StreetWordDef as Word } from './streetwords.js';

type Slot = 'P' | 'C' | 'E';
const BY_ID = new Map(STREET_WORDS.map((w) => [w.id, w]));
const catalog = () => ({ words: STREET_WORDS, models: STREET_MODELS, modelAlias: STREET_MODEL_ALIAS, girls: STREET_GIRLS });
export const streetWord = (id: string): Word | null => BY_ID.get(String(id)) ?? null;

// 엔진 Yoe: Thema 번호 -> 테마 (18개 순환)
const THEME_BY_INDEX = ['CA', 'CA', 'CA', 'UT', 'UT', 'UT', 'SV', 'SV', 'SV', 'CI', 'HW', 'HW', 'HW', 'HW', 'SV', 'HWN', 'CAN', 'TK'];
const THEMES = ['CA', 'CI', 'HW', 'SV', 'TK', 'UT', 'CAN', 'HWN'];
const NIGHT = new Set(['CAN', 'HWN']);
// 엔진 Une: CarFlag 비트 -> 국가
const COUNTRY: Record<number, string> = { 1: 'DE', 2: 'JP', 4: 'US', 8: 'IT', 16: 'GB', 32: 'SE', 64: 'FR', 128: 'AE' };
export const themeOf = (thema: any): string | null => (Number.isFinite(Number(thema)) && thema !== null && thema !== '' ? THEME_BY_INDEX[((Math.trunc(Number(thema)) % 18) + 18) % 18] : null);
/** 엔진 modelKey: Cartype/100, 별칭(131->121 등) 정리 */
export function modelKey(cartype: number): number {
  const k = Math.floor(Number(cartype) / 100);
  return Number(catalog().modelAlias[String(k)]) || k;
}

// 도색 색 이름. 추정: 색표(colorTable Colors, ColorTable+ColorIndex)의 UIDiffuse 를 HSV 로 나눈다.
//   실기록: 86Color 1(ffffff)·528iColor 1(e6e6e6)·gt-rColor 1(ede9d9) -> white, italiaColor 1(ff1400) -> red.
let colors: Map<string, number> | null = null;
export function paintOf(car: any): string | null {
  colors ??= new Map(((table('colorTable.json')?.Colors ?? []) as any[]).map((c) => [`${c.Tableid}:${c.Id}`, Number(c.UIDiffuse ?? c.Diffuse)]));
  const def = carDefOf(Number(car?.Cartype));
  const x = colors.get(`${car?.ColorTable ?? def?.ColorTable}:${Number(car?.ColorIndex ?? def?.ColorIndex) || 1}`);
  if (x === undefined || !Number.isFinite(x)) return null;
  const r = ((x >> 16) & 255) / 255, g = ((x >> 8) & 255) / 255, b = (x & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), v = max, s = max ? (max - min) / max : 0;
  if (s < 0.15 || v < 0.12) return v >= 0.8 ? 'white' : v >= 0.25 ? 'silver' : 'black';
  const d = max - min;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 165) return 'green';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

// ── 저장 상태 snap.street = {facts, earned[획득 순], fresh[아직 안 본 것 = New], cur 현재 연승, pvpCur, name {Name, Public}|null, pending}
interface State { facts: Record<string, number>; earned: string[]; fresh: string[]; cur: number; pvpCur: number; name: any; pending?: any }

// Facts 응답 순서 (실기록 키 순서). 접두 묶음은 그 뒤에 이 순서로.
const BASE = ['start', 'races', 'wins', 'losses', 'night', 'day', 'crazy', 'nitro', 'perfect', 'pure', 'photo', 'blowout', 'g1Wins',
  'pvpRaces', 'pvpWins', 'slayer', 'crazyBest', 'combo', 'speed', 'streakBest', 'pvpStreakBest', 'pvpRating', 'streak', 'pvpStreak'];
const GROUPS = ['model:', 'girl:', 'body:', 'country:', 'grade:', 'paint:', 'theme:', 'kit:'];
const DERIVED = ['modelMax', 'modelsDriven', 'girlMax', 'girlsRidden', 'girlsAll', 'themesAll', 'wt', 'album', 'ach'];
const KEEP = ['pioneer', 'flick', 'harbour']; // 오프라인 계산 불가: 이어받은 값 유지

// 녹화 이어받기: data/recorded 의 가장 최근 MsgStreetNamesAns 가 같은 계정(직전 로그인 MsgUserData Charname)이면 그 상태로 시작.
let recSeed: { name: string; body: any } | null | undefined;
function recordedSeed(): { name: string; body: any } | null {
  if (recSeed !== undefined) return recSeed;
  recSeed = null;
  try {
    const dir = new URL('../data/recorded/', import.meta.url).pathname;
    if (!existsSync(dir)) return recSeed;
    const files = readdirSync(dir);
    const ts = (f: string) => Number(f.split('_')[1]) || 0;
    const st = files.filter((f) => f.endsWith('_MsgStreetNamesReq.json')).sort((a, b) => ts(b) - ts(a))[0];
    if (!st) return recSeed;
    const body = JSON.parse(readFileSync(dir + st, 'utf8')).response?.messages?.find((m: any) => m.name === 'MsgStreetNamesAns')?.body;
    const login = files.filter((f) => f.endsWith('_MsgLoginReq.json') && ts(f) < ts(st)).sort((a, b) => ts(b) - ts(a))[0];
    const ud = login ? JSON.parse(readFileSync(dir + login, 'utf8')).response?.messages?.find((m: any) => m.name === 'MsgUserData')?.body : null;
    if (body?.Facts && ud?.UserInfo?.Charname) recSeed = { name: String(ud.UserInfo.Charname), body };
  } catch { recSeed = null; }
  return recSeed;
}

export function streetState(snap: any): State {
  if (snap.street?.facts) return snap.street;
  const st: State = { facts: {}, earned: [], fresh: [], cur: 0, pvpCur: 0, name: null };
  const rec = recordedSeed();
  if (rec && rec.name === String(snap.UserInfo?.Charname ?? '')) {
    for (const [k, v] of Object.entries(rec.body.Facts ?? {})) if (!DERIVED.includes(k) && !k.startsWith('aura:')) st.facts[k] = Number(v) || 0;
    st.earned = (rec.body.Earned ?? []).filter((id: string) => streetWord(id));
    st.fresh = (rec.body.New ?? []).filter((id: string) => st.earned.includes(id));
    if (rec.body.Name) st.name = { Name: rec.body.Name, Public: rec.body.Public ?? publicName(rec.body.Name) };
    // 추정: 현재 연승은 녹화에 없다 -> 0 부터
  }
  // 예전 오프라인 저장 필드(snap.streetName, snap.streetEarned) 옮기기
  if (snap.streetName?.Name) st.name = { Name: snap.streetName.Name, Public: publicName(snap.streetName.Name) };
  for (const id of snap.streetEarned ?? []) if (streetWord(id) && !st.earned.includes(id)) st.earned.push(id);
  delete snap.streetName; delete snap.streetEarned;
  snap.street = st;
  // 처음 상태에서 이미 만족하는 단어(시작 단어 등)는 획득으로 두되 '새 단어' 연출은 하지 않는다 (추정)
  const met = check(snap, st);
  st.earned.push(...met);
  return st;
}

/** 응답용 Facts (계산 항목 포함, 실기록 키 순서) */
export function streetFacts(snap: any): Record<string, number> {
  const st = streetState(snap);
  const f = st.facts;
  const out: Record<string, number> = {};
  for (const k of BASE) out[k] = Number(f[k]) || 0;
  const grp = (p: string) => Object.keys(f).filter((k) => k.startsWith(p));
  for (const p of GROUPS) for (const k of grp(p)) out[k] = Number(f[k]) || 0;
  const vals = (p: string) => grp(p).map((k) => Number(f[k]) || 0);
  const models = vals('model:'), girls = vals('girl:');
  out.modelMax = Math.max(0, ...models);
  out.modelsDriven = models.filter((n) => n >= 10).length;
  out.girlMax = Math.max(0, ...girls);
  out.girlsRidden = girls.filter((n) => n >= 10).length;
  out.girlsAll = Math.min(...catalog().girls.map((g) => Number(f[`girl:${g}`]) || 0));
  out.themesAll = Math.min(...THEMES.map((t) => Number(f[`theme:${t}`]) || 0));
  // 월드 투어: RankTier 5 브론즈 ~ 1 다이아 (6 = 언랭크) -> 1~5. 한 번 닿은 등급은 남긴다.
  const tiers = [snap.MyWorldTour?.RankTier, snap.MyWorldTourResult?.RankTier].map(Number).filter((t) => t >= 1 && t <= 5).map((t) => 6 - t);
  f.wt = Math.max(Number(f.wt) || 0, ...tiers);
  out.wt = f.wt;
  out.album = (snap.Collections?.Collection ?? []).length;
  out.ach = (snap.MyMemorySet?.Memory ?? []).filter((m: any) => Number(m.State) >= 2).length;
  for (const k of KEEP) out[k] = Number(f[k]) || 0;
  // PvP 레이팅: 소개를 본 뒤 기본 1000 (실기록: 소개 뒤 pvpRating 0 -> 1000)
  if (!out.pvpRating && snap.pvp?.introSeen) out.pvpRating = Number(snap.pvp.rating) || 1000;
  for (const c of snap.Cosmetics?.Owned ?? []) if (c?.Id) out[`aura:${c.Id}`] = 1; // 보유 코스메틱 (실기록 Cosmetics.Owned 와 일치)
  for (const k of Object.keys(f)) if (!(k in out) && !k.startsWith('aura:')) out[k] = Number(f[k]) || 0; // award:* 등 이어받은 값
  return out;
}

function check(snap: any, st: State): string[] {
  const facts = streetFacts(snap);
  const have = new Set(st.earned);
  return catalog().words.filter((w) => !have.has(w.id) && w.need.every(([k, n]) => (Number(facts[k]) || 0) >= n)).map((w) => w.id);
}
/** 새로 만족한 단어를 획득 처리하고 돌려준다 (표 순서). */
export function streetCheck(snap: any): string[] {
  const st = streetState(snap);
  const got = check(snap, st);
  st.earned.push(...got);
  for (const id of got) if (!st.fresh.includes(id)) st.fresh.push(id);
  return got;
}

export interface StreetRace {
  win: boolean; nitro: number; perfectStart: boolean; excellent: number; combo: number; speed: number;
  time: number; oppTime: number; thema: any; car: any; girl: number;
  pvp?: { myRating: number; oppRating: number; rating: number };
}
/** 레이스 1판을 통계에 넣는다. */
export function streetRace(snap: any, r: StreetRace): void {
  const st = streetState(snap);
  const f = st.facts;
  const add = (k: string, n = 1) => { if (n) f[k] = (Number(f[k]) || 0) + n; else f[k] ??= 0; };
  const max = (k: string, v: number) => { f[k] = Math.max(Number(f[k]) || 0, v); };
  add('races');
  add(r.win ? 'wins' : 'losses');
  st.cur = r.win ? (Number(st.cur) || 0) + 1 : 0;
  max('streakBest', st.cur);
  f.streak = f.streakBest;
  const th = themeOf(r.thema);
  if (th) { add(`theme:${th}`); add(NIGHT.has(th) ? 'night' : 'day'); }
  const exc = Math.max(0, Number(r.excellent) || 0);
  add('crazy', exc); max('crazyBest', exc);
  const nitro = Math.max(0, Number(r.nitro) || 0);
  add('nitro', nitro);
  if (r.perfectStart) add('perfect');
  if (r.win && nitro === 0) add('pure');
  const gap = Number(r.oppTime) - Number(r.time);
  if (r.win && Number(r.oppTime) > 0 && Number(r.time) > 0) { if (gap < 0.2) add('photo'); if (gap > 10) add('blowout'); }
  max('combo', Math.max(0, Number(r.combo) || 0));
  max('speed', Math.max(0, Math.floor(Number(r.speed) || 0)));
  const car = r.car;
  if (car?.Cartype) {
    const mk = modelKey(Number(car.Cartype));
    const md = catalog().models[String(mk)];
    const def = carDefOf(Number(car.Cartype));
    const grade = Number(car.Grade) || Number(def?.Grade) || 0;
    add(`model:${mk}`);
    if (md?.body) add(`body:${md.body}`);
    const flag = Number(md?.shown ?? def?.CarFlag ?? md?.flag);
    if (COUNTRY[flag]) add(`country:${COUNTRY[flag]}`);
    if (grade) add(`grade:${grade}`);
    const paint = paintOf(car);
    if (paint) add(`paint:${paint}`);
    if (r.win && grade === 1) add('g1Wins');
  }
  if (Number(r.girl) > 0) add(`girl:${Number(r.girl)}`);
  if (r.pvp) {
    // 추정: 실서버 대전 결과 기록 없음. 연승은 일반 연승처럼 최고값을 pvpStreak 에도 둔다.
    add('pvpRaces');
    if (r.win) add('pvpWins');
    st.pvpCur = r.win ? (Number(st.pvpCur) || 0) + 1 : 0;
    max('pvpStreakBest', st.pvpCur);
    f.pvpStreak = f.pvpStreakBest;
    if (Number(r.pvp.rating) > 0) f.pvpRating = Number(r.pvp.rating);
    if (r.win && Number(r.pvp.oppRating) >= Number(r.pvp.myRating) + 200) add('slayer');
  }
}

// ── rpc 후처리 (rpc.ts dispatch 에서 핸들러 뒤·업적 처리 전에 부른다: ach 는 이번 판 업적 반영 전 값). 바뀌었으면 true (저장 필요).
//   MsgBattleStartReq 성공: 그 판의 테마·동승 캐릭터를 기억 (시작 응답 Track.Thema, Passenger).
//   MsgBattleResultReq 성공: 통계 반영 후 새 단어를 결과 응답 StreetWordsNew 로 (실기록 34건: 있을 때만 필드가 있다).
export function streetAfter(snap: any, name: string, req: any, messages: { name: string; body: any }[]): boolean {
  if (!snap) return false;
  if (name === 'MsgBattleStartReq') {
    const a = messages.find((m) => m.name === 'MsgBattleStartAns')?.body;
    if (!a || Number(a.Result) !== 1) return false;
    const st = streetState(snap);
    st.pending = { thema: a.Track?.Thema ?? a.RaceInfo?.Track?.Thema ?? null, girl: Number(a.Passenger ?? snap.UserInfo?.PassengerGirl) || 0, carId: Number(a.MyCarInfo?.Carid) || 0 };
    return true;
  }
  if (name !== 'MsgBattleResultReq') return false;
  const a = messages.find((m) => m.name === 'MsgBattleResultAns')?.body;
  if (!a || Number(a.Result) !== 1) return false;
  const st = streetState(snap);
  const p = st.pending ?? null;
  delete st.pending;
  if (req?.Withdraw || a.Withdraw) return true; // 추정: 기권은 '완주'가 아니라 세지 않는다
  const cars: any[] = snap.Cars?.CarInfo ?? [];
  const car = a.MyCarInfo?.Cartype ? a.MyCarInfo : cars.find((c) => Number(c.Carid) === (p?.carId || Number(snap.UserInfo?.Currentcar))) ?? null;
  streetRace(snap, {
    win: !!a.IsPlayerWin, nitro: Number(req?.NitroUseNum) || 0, perfectStart: !!req?.PerfectStart, excellent: Number(req?.ExcellentCnt) || 0,
    combo: Number(req?.ComboCount) || 0, speed: Number(req?.LinearMaxSpeed) || 0, time: Number(req?.TimeRecord) || 0,
    oppTime: Number(req?.OpponentTimeRecord) || 0, thema: p ? p.thema : a.Track?.Thema ?? a.Race?.Track?.Thema ?? null,
    car, girl: p ? p.girl : Number(snap.UserInfo?.PassengerGirl) || 0,
  });
  const got = streetCheck(snap);
  if (got.length) a.StreetWordsNew = got;
  return true;
}

// ── 이름
const TOKEN_STOP = ['with', 'from', 'that', 'than', 'every', 'never', 'thousand'];
const tokens = (t: string) => t.toLowerCase().replace(/'s?\b/g, '').split(/[^a-z0-9]+/).filter((x) => x.length > 3 && !TOKEN_STOP.includes(x));
const nameWords = (n: any): (Word | null)[] => (['P', 'C', 'E'] as const).map((k) => (n && n[k] ? streetWord(n[k]) : null));
/** 엔진 wordsCombo: 전설(3) 이상 2개 = 1, 3개 또는 2개+울트라 = 2, 울트라(4) 3개 = 3 */
function comboOf(ws: (Word | null)[]): number {
  const leg = ws.filter((w) => w && w.r >= 3).length, ultra = ws.filter((w) => w && w.r >= 4).length;
  return ultra >= 3 ? 3 : leg >= 3 || (leg >= 2 && ultra >= 1) ? 2 : leg >= 2 ? 1 : 0;
}
const nameText = (n: any) => { const [p, c, e] = nameWords(n); return p && c ? [p.t, c.t, e?.t].filter(Boolean).join(' ') : ''; };
/** 엔진 nameError (오류 문구는 클라이언트 nameErrorText 가 번역) */
export function nameError(n: any): string {
  const [p, c, e] = nameWords(n);
  if (!p || p.s !== 'P') return 'Pick a prefix';
  if (!c || c.s !== 'C') return 'Pick a core';
  if (n.E && (!e || e.s !== 'E')) return 'Pick an end';
  const seen = new Set<string>();
  for (const w of [p, c, e]) for (const t of w ? tokens(w.t) : []) { if (seen.has(t)) return 'A word is said twice'; seen.add(t); }
  return nameText(n).length > (comboOf([p, c, e]) === 3 ? 52 : 44) ? 'Too long' : '';
}
/** 엔진 publicName: {text, rarity, combo?} — 다른 사람에게 보이는 이름 (MsgStreetNameSetAns.Public, 대전 카드 street) */
export function publicName(n: any): { text: string; rarity: number; combo?: number } | null {
  const text = nameText(n);
  if (!text || nameError(n)) return null;
  const ws = nameWords(n).filter(Boolean) as Word[];
  const combo = comboOf(ws);
  return { text, rarity: ws.reduce((a, w) => Math.max(a, w.r), 0), ...(combo ? { combo } : {}) };
}
export const streetPublic = (snap: any) => (snap?.street?.name?.Public ?? null);

/** 이름 저장. 실패 Reason 은 nameError 문구 + 'A word is not earned yet'. */
export function streetSetName(snap: any, raw: any): { ok: boolean; Name?: any; Public?: any; Reason?: string } {
  const st = streetState(snap);
  if (!raw || typeof raw !== 'object') return { ok: false, Reason: 'Pick a prefix' };
  const Name = { P: String(raw.P ?? ''), C: String(raw.C ?? ''), E: String(raw.E ?? '') };
  const err = nameError(Name);
  if (err) return { ok: false, Reason: err };
  if ([Name.P, Name.C, Name.E].some((id) => id && !st.earned.includes(id))) return { ok: false, Reason: 'A word is not earned yet' };
  const Public = publicName(Name);
  st.name = { Name, Public };
  return { ok: true, Name, Public };
}

/** 추천 이름. 추정: 칸마다 등급 높은 순 -> 조건 수치 큰 순 -> 먼저 얻은 순, 이름 규칙(중복 단어·길이)에 맞는 첫 조합.
 *  실기록 Suggest 7종(p_quick/c_commuter/e_from_the_first_wave ... p_relentless/c_perfect_machine/e_who_never_loses)과 일치. */
export function streetSuggest(snap: any): { P: string | null; C: string | null; E: string | null } {
  const st = streetState(snap);
  const order = new Map(st.earned.map((id, i) => [id, i]));
  const pick = (s: Slot) => st.earned.map((id) => streetWord(id)).filter((w): w is Word => !!w && w.s === s)
    .sort((a, b) => b.r - a.r || Math.max(...b.need.map((x) => x[1])) - Math.max(...a.need.map((x) => x[1])) || order.get(a.id)! - order.get(b.id)!)
    .slice(0, 8);
  const P = pick('P'), C = pick('C'), E: (Word | null)[] = [...pick('E'), null];
  for (const p of P) for (const c of C) for (const e of E) {
    const n = { P: p.id, C: c.id, E: e?.id ?? '' };
    if (!nameError(n)) return { P: p.id, C: c.id, E: e?.id ?? null };
  }
  return { P: P[0]?.id ?? null, C: C[0]?.id ?? null, E: null };
}

/** MsgStreetNamesAns 본문 (Seq·Result 제외). 실기록 {Open, Name, Public, Suggest, Earned, New, Facts}. */
export function streetView(snap: any): any {
  const st = streetState(snap);
  return { Open: true, Name: st.name?.Name ?? null, Public: st.name?.Public ?? null, Suggest: streetSuggest(snap),
    Earned: [...st.earned], New: [...st.fresh], Facts: streetFacts(snap) };
}
/** MsgStreetNameSeenReq {Ids}: 새 단어 표시 끄기 */
export function streetSeen(snap: any, ids: any): void {
  const st = streetState(snap);
  const set = new Set((Array.isArray(ids) ? ids : []).map(String));
  st.fresh = st.fresh.filter((id) => !set.has(id));
}
