// 오프라인 실시간 대전(Live Duel) 로컬 서버: 실서버가 없을 때 /api/pvp 웹소켓을 직접 처리한다 (src/pvprelay.ts 에서 호출).
// 근거
//  - 실기록(data/recorded-ws/*.jsonl, 2026-11-05 중계 5건): hello·auth·welcome(config·profile), social.hello·social.community,
//    ping/pong, profile, intro.seen/intro.ok, queue(1초마다 searching, 300초 timeout, range 확장표), rooms.list/rooms, rooms.stop.
//    대기열에 다른 사람이 없어 match 이후는 한 번도 기록되지 않았다.
//  - match 이후(room·ready·match·loaded·go·s/o·finish·opp.finish·result·rematch)는 클라이언트 코드(PvpController·PvpRace·
//    RemoteDriver·SSPvpDuel·SSPvpRooms·BS_RESULT)가 읽는 필드에 맞췄다. 추정한 값은 '// 추정:' 으로 표시.
//  - 상대는 봇(봇 차량 능력치 합 = 내 성능 ±4%). 로컬 계정 두 개가 동시에 대기하거나 방 코드로 들어오면 사람끼리도 붙는다.
// 봇 주행: 트랙 경로(trackTable Segment, 클라이언트 TrackPath 와 같은 베지어 96분할)와 드리프트 구간을 따라 속도를 정하고,
//   완주 시간 = 기록 회귀식(아래 expectedTime) x 무작위 실력차. 15Hz 로 'o' 프레임(rt,d,x,z,h,v,dr,b,n,ps)을 보낸다.
// 전적(레이팅·승패·연승)은 계정 스냅샷 snap.pvp 에 저장한다.
import { createHmac, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import type { Auth } from './auth.js';
import type { Store } from './db.js';
import { table, finalAttr, carDefOf, makeOpponent, carName, ATTRS } from './gamecalc.js';
import { streetRace, streetCheck, streetPublic, type StreetRace } from './street.js';

export interface PvpLocalDeps { auth: Auth; store: Store; strict: boolean }

// ---- 설정 (실기록 welcome.config) ----
const HZ = 15;
const READY_S = 45;
const LEAD_S = 7;
const DC_FORFEIT_S = 12;
const MAX_WAIT_S = 300;
const CHAT_MAX = 120;
const MAX_GAP_PCT = 5;
const NEAR_BAND = 0.3;
const TRACKS = [
  { trackId: 380, name: 'Night Highway', sceneries: [{ thema: 15, lightingIndex: 0 }, { thema: 10, lightingIndex: 0 }] },
  { trackId: 381, name: 'Coastal Highway', sceneries: [{ thema: 11, lightingIndex: 0 }, { thema: 15, lightingIndex: 0 }] },
  { trackId: 382, name: 'Canyon Road', sceneries: [{ thema: 2, lightingIndex: 0 }, { thema: 16, lightingIndex: 0 }] },
  { trackId: 383, name: 'Downtown', sceneries: [{ thema: 3, lightingIndex: 0 }] },
  { trackId: 384, name: 'Pacific Coast', sceneries: [{ thema: 0, lightingIndex: 0 }, { thema: 16, lightingIndex: 0 }] },
  { trackId: 385, name: 'Country Lanes', sceneries: [{ thema: 8, lightingIndex: 0 }] },
  { trackId: 386, name: 'Farm Roads', sceneries: [{ thema: 6, lightingIndex: 0 }] },
  { trackId: 154, name: 'Midnight Express', sceneries: [{ thema: 15, lightingIndex: 0 }, { thema: 12, lightingIndex: 0 }] },
  { trackId: 180, name: 'Speedway', sceneries: [{ thema: 9, lightingIndex: 0 }] },
  { trackId: 196, name: 'Night Bypass', sceneries: [{ thema: 15, lightingIndex: 0 }, { thema: 13, lightingIndex: 0 }] },
];
// 추정: 실서버 값 미확인
const BOT_MATCH_S: [number, number] = [3, 8];      // 빠른 대전에서 봇이 잡히기까지
const BOT_JOIN_S: [number, number] = [3, 7];       // 내 방에 봇이 들어오기까지
const BOT_READY_S: [number, number] = [2, 6];      // 봇 READY
const REMATCH_S = 45;                              // 재대결 선택 시간 (결과 화면을 보는 시간 포함, readySeconds 와 같게)
const LOAD_TIMEOUT_S = 90;                         // 레이스 로딩 제한
const FINISH_WAIT_S = 90;                          // 한쪽 완주 후 다른 쪽을 기다리는 시간 (기다리는 쪽의 레이스 시계 rt 기준)
const STALL_S = 30;                                // 's' 프레임이 이만큼 끊기면 완주 못 한 것으로 본다
const ROOM_IDLE_S = 20 * 60;                       // 개인 방 방치 만료
const SIM_MAX_S = 360;                             // 봇 주행 계산 한도
const RACE_WALL_MAX_S = 900;                       // 레이스 전체 제한 (벽시계). 느린 기기는 프레임 dt 가 0.1초로 잘려 레이스 시계가 늦게 간다

const now = () => Date.now() / 1000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDec = (s: string) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sumAttr = (a: any) => ATTRS.reduce((s, k) => s + (Number(a?.[k]) || 0), 0);

// 시즌: 실기록 2026-11-05 에 id '2026-11', start 2026-11-06T00:00Z, end 2026-12-06T00:00Z, claimUntil +7일.
// 추정: 매달 6일 00:00Z 에 바뀌고 id 는 시작 달. 첫 시즌(2026-11-06) 전에는 첫 시즌을 보인다.
export function pvpSeason(t = Date.now()) {
  const at = (y: number, m: number) => Date.UTC(y, m, 6);
  const d = new Date(t);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (t < at(y, m)) { m--; if (m < 0) { m = 11; y--; } }
  if (at(y, m) < Date.UTC(2026, 10, 6)) { y = 2026; m = 10; }
  const start = at(y, m), end = at(y, m + 1);
  const iso = (x: number) => new Date(x).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { id: `${y}-${String(m + 1).padStart(2, '0')}`, start: iso(start), end: iso(end), claimUntil: iso(end + 7 * 86400_000) };
}

function welcomeConfig() {
  return {
    enabled: true, season: pvpSeason(), stateHz: HZ, readySeconds: READY_S, leadSeconds: LEAD_S,
    disconnectForfeitSeconds: DC_FORFEIT_S, chatMaxLength: CHAT_MAX, maxWaitSeconds: MAX_WAIT_S, tracks: TRACKS,
    maxPreferredTracks: 3, hostPicksTrack: true, parking: { open: false, slots: 12, lots: 7 },
    rooms: { open: true, defaultPublic: true, nearBand: NEAR_BAND }, balance: { enabled: true, maxGapPct: MAX_GAP_PCT },
  };
}

// 대기열 범위: 실기록 perf 2332 -> 0초 2220~2449, 1초 2027~2682 ... 25초 466~11660. max = ceil(perf x (1+g)), min = floor(perf / (1+g))
function queueRange(perf: number, waited: number) {
  const steps: [number, number][] = [[25, 4], [18, 3], [12, 2], [8, 1.2], [5, 0.8], [3, 0.5], [2, 0.3], [1, 0.15], [0, 0.05]];
  const g = steps.find(([s]) => waited >= s)![1];
  return { min: Math.floor(perf / (1 + g)), max: Math.ceil(perf * (1 + g)) };
}

// ---- 트랙 경로 (클라이언트 TrackPath 와 같은 계산) ----
interface Geo { id: number; xs: number[]; zs: number[]; ds: number[]; length: number; goal: number; total: number; driftRate: number; zones: { start: number; end: number; right: boolean }[] }
const geoCache = new Map<number, Geo | null>();
function trackDef(id: number): any { return (table('trackTable.json')?.Track ?? []).find((t: any) => Number(t.TrackId) === Number(id)) ?? null; }
function geoOf(id: number): Geo | null {
  if (geoCache.has(id)) return geoCache.get(id)!;
  const t = trackDef(id);
  let g: Geo | null = null;
  if (t?.Segment?.length) {
    const xs: number[] = [], zs: number[] = [], ds: number[] = [];
    let len = 0;
    t.Segment.forEach((s: any, j: number) => {
      const k = [s.Pos0.X, -s.Pos0.Y, s.Tangent0.X, -s.Tangent0.Y, s.Tangent1.X, -s.Tangent1.Y, s.Pos1.X, -s.Pos1.Y];
      for (let i = j === 0 ? 0 : 1; i <= 96; i++) {
        const u = i / 96, a = (1 - u) ** 3, b = 3 * (1 - u) ** 2 * u, c = 3 * (1 - u) * u * u, d = u ** 3;
        const x = a * k[0] + b * k[2] + c * k[4] + d * k[6], z = a * k[1] + b * k[3] + c * k[5] + d * k[7];
        if (xs.length) len += Math.hypot(x - xs[xs.length - 1], z - zs[zs.length - 1]);
        xs.push(x); zs.push(z); ds.push(len);
      }
    });
    g = { id, xs, zs, ds, length: len, goal: len - (Number(t.Args?.[5]) || 300), total: Number(t.Attrs?.TotalLength) || len - 300,
      driftRate: Number(t.Attrs?.DriftRate) || 0.35, zones: [] };
    const di: number[] = t.DriftInfo ?? [];
    for (let i = 0; i + 1 < di.length; i += 2) {
      // 클라이언트 driftZones.isRight: 시작점과 중간점 접선의 외적 > 0
      const s0 = sampleGeo(g, di[i]), s1 = sampleGeo(g, (di[i] + di[i + 1]) / 2);
      g.zones.push({ start: di[i], end: di[i + 1], right: s0.tz * s1.tx - s0.tx * s1.tz > 0 });
    }
  }
  geoCache.set(id, g);
  return g;
}
function sampleGeo(g: Geo, d: number) {
  const ds = g.ds;
  let lo = 0, hi = ds.length - 1;
  if (d <= 0) hi = 1; else if (d >= ds[hi]) lo = hi - 1;
  else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ds[m] <= d) lo = m; else hi = m; }
  const seg = ds[lo + 1] - ds[lo] || 1;
  const tx = (g.xs[lo + 1] - g.xs[lo]) / seg, tz = (g.zs[lo + 1] - g.zs[lo]) / seg;
  return { x: g.xs[lo] + tx * (d - ds[lo]), z: g.zs[lo] + tz * (d - ds[lo]), tx, tz };
}

// 기대 완주 시간(초). 실기록 레이스 184건(자동 주행, RaceMode 1) 회귀: T = 4.478 + L x (0.032078 + 0.00247 x DriftRate - 0.00115 x ln(성능))
//   L = Attrs.TotalLength, 성능 = 최종 능력치 합. 오차 rms 0.64%, 최대 2.8%. (같은 회귀를 AI 상대 시간에 하면 약 1~2% 느리다)
function expectedTime(perf: number, g: Geo): number {
  return 4.478 + g.total * (0.032078 + 0.00247 * g.driftRate - 0.00115025 * Math.log(Math.max(100, perf)));
}

// ---- 봇 주행 계획 ----
interface Plan { dt: number; d: Float64Array; v: Float64Array; flags: Uint8Array; nitro: Uint8Array; finish: number; ps: boolean; end: number }
// 추정: 속도 모델(코너 0.8배, 가속 11·감속 9 m/s², 니트로 2회 x1.12 2.5초)은 그럴듯하게 고른 값. 완주 시간만 맞춘다.
function simulate(g: Geo, vmax: number, ps: boolean, nitroAt: number[], record: boolean) {
  const dt = 1 / 60, CF = 0.8, ACC = 11, BRK = 9;
  let d = 0, v = ps ? 6 : 0, t = 0, boost = 0, n = 0, fin = -1;
  const D: number[] = [], V: number[] = [], F: number[] = [], N: number[] = [];
  while (t < SIM_MAX_S) {
    const z = g.zones.find((q) => d >= q.start && d <= q.end);
    const nz = g.zones.find((q) => q.start > d);
    let vt = vmax * (z ? CF : 1);
    if (nz) { const vz = vmax * CF; if (v > vz && nz.start - d < (v * v - vz * vz) / (2 * BRK)) vt = Math.min(vt, vz); }
    if (!z && fin < 0 && n < nitroAt.length && t >= nitroAt[n]) { boost = 2.5; n++; }
    if (boost > 0) { vt *= 1.12; boost -= dt; }
    if (fin >= 0) vt = vmax * 0.4;
    if (v < vt) v = Math.min(vt, v + ACC * Math.max(0.12, 1 - v / (vmax * 1.3)) * dt * (boost > 0 ? 1.6 : 1) * (ps && t < 1.5 ? 1.5 : 1));
    else v = Math.max(vt, v - BRK * dt);
    const d0 = d;
    d += v * dt; t += dt;
    if (fin < 0 && d >= g.goal) fin = t - dt + ((g.goal - d0) / (d - d0)) * dt;
    if (record) { D.push(d); V.push(v); F.push(z ? (z.right ? 1 : 2) : 0) ; N.push(n + (boost > 0 ? 128 : 0)); }
    if (fin >= 0 && (!record || t > fin + 4)) break;
  }
  return { fin, D, V, F, N };
}
function planBot(g: Geo, target: number): Plan {
  const ps = Math.random() < 0.6;
  const nitroAt = [rand(8, 14), rand(target * 0.5, target * 0.75)];
  let lo = 8, hi = 160;
  for (let i = 0; i < 32; i++) {
    const m = (lo + hi) / 2;
    const r = simulate(g, m, ps, nitroAt, false);
    if (r.fin < 0 || r.fin > target) lo = m; else hi = m;
  }
  const r = simulate(g, hi, ps, nitroAt, true);
  return { dt: 1 / 60, d: Float64Array.from(r.D), v: Float64Array.from(r.V), flags: Uint8Array.from(r.F), nitro: Uint8Array.from(r.N),
    finish: r3(r.fin > 0 ? r.fin : target), ps, end: r.D.length / 60 };
}
// 봇의 rt 시점 상태 ('o' 프레임: 클라이언트 carState 와 같은 필드)
function botFrame(g: Geo, p: Plan, rt: number) {
  const i = Math.max(0, Math.min(p.d.length - 1, Math.floor(rt / p.dt) - 1));
  const j = Math.min(p.d.length - 1, i + 1);
  const f = Math.max(0, Math.min(1, rt / p.dt - 1 - i));
  const d = rt <= 0 ? 0 : p.d[i] + (p.d[j] - p.d[i]) * f;
  const v = rt <= 0 ? 0 : p.v[i] + (p.v[j] - p.v[i]) * f;
  const s = sampleGeo(g, d);
  const fl = p.flags[i], nb = p.nitro[i];
  return { t: 'o', rt: r3(Math.max(0, rt)), d: r3(d), x: r3(s.x), z: r3(s.z), h: Math.round(Math.atan2(s.tx, s.tz) * 10000) / 10000,
    v: r3(v), dr: fl === 1 ? 1 : fl === 2 ? -1 : 0, b: nb & 128 ? 1 : 0, n: nb & 127, ps: p.ps ? 1 : 0 };
}

// ---- 전적 (snap.pvp) ----
interface Stats { rating: number; best: number; wins: number; losses: number; battles: number; streak: number; introSeen: boolean }
function statsOf(snap: any): Stats {
  const p = snap?.pvp ?? {};
  return { rating: Number(p.rating) || 1000, best: Number(p.best) || 1000, wins: Number(p.wins) || 0, losses: Number(p.losses) || 0,
    battles: Number(p.battles) || 0, streak: Number(p.streak) || 0, introSeen: !!p.introSeen };
}
// 추정: 레이팅 = Elo (K 32, 시작 1000). 실서버 공식 미확인.
function eloDelta(me: number, opp: number, win: boolean): number {
  const e = 1 / (1 + 10 ** ((opp - me) / 400));
  return Math.round(32 * ((win ? 1 : 0) - e));
}

// ---- 참가자 ----
interface Card {
  accountId: number; name: string; level: number; carInfo: any; cartype: number; grade: number; upgradeLevel: number; perf: number;
  rating: number; wins: number; losses: number; battles: number; streak: number; best: number; mainGirl: number; passenger: number; passengerFace: number;
  street?: any; // 거리 이름 공개형 {text, rarity, combo?} (클라이언트 대전 HUD card.street)
}
interface Side {
  id: number; bot: boolean; card: Card; car: any;             // car = 레이스용 차량 레코드 (Attributes = 기본값, 봇은 합성 차량)
  player?: Player;                                             // 사람
  ready: boolean; rematch: boolean; loaded: boolean; connected: boolean;
  finish: number | null; report: any; last: any; lastAt?: number; plan?: Plan; sentFinish?: boolean; dcTimer?: NodeJS.Timeout;
}

class Player {
  conn: Conn | null = null;
  room: Room | null = null;
  queue: { since: number; tracks: number[]; timer: NodeJS.Timeout; botAt: number } | null = null;
  botRooms: { at: number; list: any[] } | null = null;
  constructor(readonly key: string, readonly server: LocalPvp) {}
  get id() { return Number(this.key) || 0; }
  send(o: any) { this.conn?.send(o); }
  snap(): any { return this.server.deps.store.getUser(this.key); }
  currentCar(snap = this.snap()): any {
    return (snap?.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(snap?.UserInfo?.Currentcar)) ?? null;
  }
  card(snap = this.snap()): Card {
    const ui = snap?.UserInfo ?? {};
    const car = this.currentCar(snap);
    const attrs = car ? finalAttr(snap, car) : { AttribMaxSpd: 0, AttribAcc: 0, AttribStability: 0, AttribDrift: 0 };
    const st = statsOf(snap);
    const pg = Number(ui.PassengerGirl) > 0 ? Number(ui.PassengerGirl) : -1;
    // 실기록 profile: carInfo = 차량 레코드 + Attributes 가 최종 능력치(탑승 캐릭터 포함), perf = 그 합 (2332 = 386+678+590+678)
    return {
      accountId: this.id, name: String(ui.Charname ?? 'Player'), level: Number(ui.Charlevel) || 1,
      carInfo: car ? { ...car, Attributes: attrs, DeltaMastery: 0 } : null, cartype: Number(car?.Cartype) || 0,
      grade: Number(car?.Grade) || Number(carDefOf(car?.Cartype)?.Grade) || 1, upgradeLevel: Number(car?.UpgradeLevel) || 1,
      perf: sumAttr(attrs), rating: st.rating, wins: st.wins, losses: st.losses, battles: st.battles, streak: st.streak, best: st.best,
      mainGirl: Number(ui.MainGirl) || 0, passenger: pg, passengerFace: pg, street: streetPublic(snap),
    };
  }
  profile(): any {
    const snap = this.snap();
    const st = statsOf(snap);
    return { ...this.card(snap), history: [], season: pvpSeason(), introSeen: st.introSeen };
  }
  /** 거리 이름 단어 (street.ts): 대전 1판을 통계에 넣고 새로 얻은 단어 id 를 돌려준다 */
  street(r: StreetRace): string[] {
    const snap = this.snap();
    if (!snap) return [];
    streetRace(snap, r);
    const got = streetCheck(snap);
    this.server.deps.store.putUser(this.key, snap);
    return got;
  }
  updateStats(fn: (s: Stats) => void): Stats {
    const snap = this.snap();
    if (!snap) return statsOf(null);
    const st = statsOf(snap);
    fn(st);
    snap.pvp = { ...(snap.pvp ?? {}), ...st, season: pvpSeason().id };
    this.server.deps.store.putUser(this.key, snap);
    return st;
  }
}

// ---- 봇 ----
const BOT_NAMES = ['Mika_R', 'NightOwl', 'Haruka86', 'DriftKing', 'Yuna', 'TofuRunner', 'SilviaS15', 'Kaito', 'RedSunset', 'Rin_7',
  'Nova', 'Hachiroku', 'MidnightCat', 'Sora', 'Akina_DH', 'Luna', 'Jin', 'Blitz', 'Hana', 'Ryo_FD', 'Aoi', 'Kenta', 'Mei', 'Zero'];
let botSeq = 0;
function makeBot(base: Card, perfNear?: number): Side {
  const id = 2_000_000_000 + (++botSeq);
  const perf = Math.max(200, Math.round(perfNear ?? base.perf * (1 + rand(-0.04, 0.04))));
  const grade = base.grade || 1;
  const pool = (table('cars.json')?.Car ?? []).filter((c: any) => Number(c.Grade) === grade && !c.UniqueCar && c.ModelHigh);
  const def = pool.length ? pick(pool) : carDefOf(10101);
  const car = makeOpponent(perf, Number(def?.Id) || 10101);
  const name = pick(BOT_NAMES);
  Object.assign(car, { UpgradeLevel: Math.max(1, base.upgradeLevel + Math.round(rand(-1, 1))), Grade: Number(def?.Grade) || grade,
    CarName: carName(Number(def?.Id)) || '', PlateName: name, ExpansionLevel: 1 });
  const battles = Math.floor(rand(4, 160));
  const wins = Math.floor(battles * rand(0.35, 0.65));
  const card: Card = {
    accountId: id, name, level: Math.max(1, base.level + Math.round(rand(-3, 3))), carInfo: { ...car, DeltaMastery: 0 },
    cartype: Number(car.Cartype), grade: car.Grade, upgradeLevel: car.UpgradeLevel, perf: sumAttr(car.Attributes),
    rating: Math.max(100, base.rating + Math.round(rand(-60, 60))), wins, losses: battles - wins, battles,
    streak: Math.random() < 0.5 ? 0 : pick([-2, -1, 1, 2, 3]), best: 0, mainGirl: 0, passenger: -1, passengerFace: -1,
  };
  card.best = Math.max(card.rating, 1000);
  return { id, bot: true, card, car, ready: false, rematch: false, loaded: false, connected: true, finish: null, report: null, last: null };
}
function humanSide(p: Player): Side | null {
  const snap = p.snap();
  const car = p.currentCar(snap);
  if (!car) return null;
  return { id: p.id, bot: false, card: p.card(snap), car, player: p, ready: false, rematch: false, loaded: false, connected: true,
    finish: null, report: null, last: null };
}

// ---- 방 ----
let roomSeq = 0;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
type Phase = 'waiting' | 'lobby' | 'loading' | 'racing' | 'rematch';
class Room {
  id = String(++roomSeq);
  code = Array.from({ length: 6 }, () => pick([...CODE_CHARS])).join('');
  phase: Phase = 'waiting';
  round = 1;
  sides: Side[] = [];
  chat: any[] = [];
  score = new Map<number, number>();
  last: { winner: number | null; times: Map<number, number> } | null = null;
  track: { trackId: number; thema: number; lightingIndex: number; scenery: number } = randomTrack([]);
  createdAt = now();
  touched = now();
  readyDeadline = 0;
  rematchDeadline = 0;
  goAt = 0;
  battleSeed = 0;
  timers = new Set<NodeJS.Timeout>();
  raceTimer: NodeJS.Timeout | null = null;
  closed = false;
  constructor(readonly server: LocalPvp, public host: number, public keeps: boolean, public isPublic: boolean) {}

  after(sec: number, fn: () => void): NodeJS.Timeout {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.closed) try { fn(); } catch (e) { console.error('[pvp] timer', e); } }, Math.max(0, sec) * 1000);
    this.timers.add(t);
    return t;
  }
  other(s: Side) { return this.sides.find((x) => x !== s) ?? null; }
  humans() { return this.sides.filter((s) => !s.bot && s.player); }
  sideOf(p: Player) { return this.sides.find((s) => s.player === p) ?? null; }

  balance() {
    const [a, b] = this.sides;
    const pa = a?.card.perf ?? 0, pb = b?.card.perf ?? 0;
    const out = new Map<number, { perf: number; raced: number; lowered: boolean; attrs?: any }>();
    const lo = Math.min(pa, pb), hi = Math.max(pa, pb);
    const applied = !!(a && b && lo > 0 && hi > lo * (1 + MAX_GAP_PCT / 100));
    for (const s of this.sides) {
      const perf = s.card.perf;
      if (applied && perf === hi) {
        // 추정: 강한 쪽 능력치를 같은 비율로 낮춰 약한 쪽 +5% 에 맞춘다 (pvp_balance_card 'Real {0} · Race {1}')
        const raced = Math.floor(lo * (1 + MAX_GAP_PCT / 100));
        const attrs: any = {};
        for (const k of ATTRS) attrs[k] = Math.floor((Number(s.card.carInfo?.Attributes?.[k]) || 0) * raced / perf);
        out.set(s.id, { perf, raced: sumAttr(attrs), lowered: true, attrs });
      } else out.set(s.id, { perf, raced: perf, lowered: false });
    }
    return { applied, map: out };
  }

  view(s: Side): any {
    const o = this.other(s);
    const bal = this.balance();
    const phase = this.phase === 'loading' ? 'racing' : this.phase;
    const mine = s.id === this.host;
    const editable = this.keeps && (this.phase === 'waiting' || this.phase === 'lobby');
    const lastWin = this.last ? (this.last.winner === null ? null : this.last.winner === s.id) : undefined;
    return {
      id: this.id, code: this.code, host: this.host, public: this.isPublic, keeps: this.keeps, phase, round: this.round,
      track: this.track, createdAt: this.createdAt,
      canPickTrack: editable && mine, canChangeCar: editable, canChangeGirl: editable,
      ...(this.phase === 'lobby' && !this.keeps ? { readyDeadline: this.readyDeadline } : {}),
      ...(this.phase === 'rematch' ? { rematchDeadline: this.rematchDeadline } : {}),
      me: { card: s.card, ready: s.ready, rematch: s.rematch, connected: s.connected },
      opp: o ? { card: o.card, ready: o.ready, rematch: o.rematch, connected: o.connected } : null,
      balance: o ? { enabled: true, applied: bal.applied, maxGapPct: MAX_GAP_PCT, me: bal.map.get(s.id), opp: bal.map.get(o.id) } : null,
      ...(this.keeps ? { score: { me: this.score.get(s.id) ?? 0, opp: o ? this.score.get(o.id) ?? 0 : 0 } } : {}),
      ...(this.keeps && this.last && lastWin !== undefined
        ? { last: { win: lastWin, myTime: this.last.times.get(s.id) ?? 0, oppTime: o ? this.last.times.get(o.id) ?? 0 : 0 } } : {}),
      chat: this.chat.slice(-60),
    };
  }
  push() {
    // 레이스 중에는 room 을 보내지 않는다 (클라이언트는 racing 이 아닌 phase 를 모두 lobby 로 바꾼다)
    for (const s of this.humans()) s.player!.send({ t: 'room', room: this.view(s) });
  }
  sendAll(o: any) { for (const s of this.humans()) s.player!.send(o); }

  // 참가자가 바뀌거나 라운드가 바뀔 때: 봇 READY 예약
  botsPrepare() {
    for (const s of this.sides) if (s.bot && !s.ready && this.phase === 'lobby') {
      this.after(rand(...BOT_READY_S), () => { if (this.phase === 'lobby' && !s.ready) { s.ready = true; this.push(); this.maybeStart(); } });
    }
  }
  join(s: Side) {
    this.sides.push(s);
    this.touched = now();
    if (this.sides.length === 2) {
      this.phase = 'lobby';
      for (const x of this.sides) { x.ready = false; x.rematch = false; }
      if (!this.keeps) {
        this.readyDeadline = now() + READY_S;
        const round = this.round;
        this.after(READY_S + 0.5, () => { if (this.phase === 'lobby' && this.round === round) this.close('not_ready'); });
      }
      this.botsPrepare();
      const bot = this.sides.find((x) => x.bot);
      if (bot && Math.random() < 0.5) this.after(rand(1.5, 3), () => this.botSay(bot, pick(['hi', 'gl hf', 'hello!', 'good luck', 'yo'])));
    }
    this.push();
  }
  botSay(bot: Side, text: string) {
    if (!this.sides.includes(bot) || this.phase === 'racing' || this.phase === 'loading') return;
    this.addChat(bot, text);
  }
  addChat(s: Side, text: string) {
    const line = { id: Date.now() * 10 + Math.floor(Math.random() * 10), at: Math.floor(now()), from: s.id, name: s.card.name, text };
    this.chat.push(line);
    if (this.chat.length > 60) this.chat.splice(0, this.chat.length - 60);
    this.sendAll({ t: 'chat', line });
  }

  setReady(s: Side, on: boolean) {
    if (this.phase !== 'lobby') return;
    s.ready = on;
    this.touched = now();
    this.push();
    this.maybeStart();
  }
  setRematch(s: Side) {
    if (this.phase !== 'rematch') return;
    s.rematch = true;
    this.push();
    if (this.sides.length === 2 && this.sides.every((x) => x.rematch)) this.startMatch();
  }
  maybeStart() {
    if (this.phase === 'lobby' && this.sides.length === 2 && this.sides.every((x) => x.ready)) this.startMatch();
  }

  // 레이스 시작: match {battleStart, room} -> loaded -> go {goAt, stateHz}
  startMatch() {
    if (this.sides.length < 2) return;
    // 사람 카드는 최신 스냅샷으로 다시 만든다 (차량·탑승 캐릭터 변경 반영)
    for (const s of this.sides) if (!s.bot && s.player) { const h = humanSide(s.player); if (h) { s.card = h.card; s.car = h.car; } }
    if (!this.track.trackId) this.track = randomTrack([]);
    this.phase = 'loading';
    this.battleSeed = Math.floor(Math.random() * 2 ** 31);
    this.touched = now();
    for (const s of this.sides) {
      Object.assign(s, { loaded: s.bot, finish: null, report: null, last: null, lastAt: undefined, plan: undefined, sentFinish: false, ready: false, rematch: false });
    }
    for (const s of this.humans()) s.player!.send({ t: 'match', battleStart: this.battleStart(s), room: this.view(s) });
    console.log(`[pvp] 레이스 시작 방 ${this.id} 라운드 ${this.round} 트랙 ${this.track.trackId}: ${this.sides.map((x) => `${x.card.name}${x.bot ? '(봇)' : ''} ${x.card.perf}`).join(' vs ')}`);
    const round = this.round;
    this.after(LOAD_TIMEOUT_S, () => { if (this.phase === 'loading' && this.round === round) this.close('load_failed'); });
    this.maybeGo();
  }
  loaded(s: Side) {
    if (this.phase === 'racing') { s.player?.send({ t: 'go', goAt: this.goAt, stateHz: HZ }); return; } // 재접속 후 다시 로딩한 경우
    if (this.phase !== 'loading') return;
    s.loaded = true;
    this.maybeGo();
  }
  maybeGo() {
    if (this.phase !== 'loading' || !this.sides.every((x) => x.loaded)) return;
    // 추정: 모두 로딩되면 goAt = 지금 + leadSeconds (클라이언트는 goAt-3 초에 카운트다운을 시작하고 그 전까지 상대 소개를 보인다)
    this.goAt = r3(now() + LEAD_S);
    this.phase = 'racing';
    this.sendAll({ t: 'go', goAt: this.goAt, stateHz: HZ });
    const g = geoOf(this.track.trackId);
    const bal = this.balance();
    for (const s of this.sides) if (s.bot && g) {
      // 봇 완주 시간 = 기대 시간 x (1 + 실력차). 추정: 표준편차 1.2%, 12% 확률로 실수 +1~3%
      let k = Math.max(-0.035, Math.min(0.035, gauss() * 0.012));
      if (Math.random() < 0.12) k += rand(0.01, 0.03);
      s.plan = planBot(g, expectedTime(bal.map.get(s.id)?.raced ?? s.card.perf, g) * (1 + k));
    }
    if (this.raceTimer) clearInterval(this.raceTimer);
    this.raceTimer = setInterval(() => { try { this.tick(); } catch (e) { console.error('[pvp] tick', e); } }, 1000 / HZ);
    const round = this.round;
    this.after(LEAD_S + RACE_WALL_MAX_S, () => { if (this.phase === 'racing' && this.round === round) this.endRace('timeout'); });
  }
  tick() {
    if (this.phase !== 'racing') { if (this.raceTimer) clearInterval(this.raceTimer); this.raceTimer = null; return; }
    const rt = now() - this.goAt;
    if (rt < 0) return;
    const g = geoOf(this.track.trackId);
    for (const s of this.sides) {
      if (!s.bot || !s.plan || !g) continue;
      const o = this.other(s);
      if (rt <= s.plan.end) {
        const f = botFrame(g, s.plan, rt);
        s.last = f;
        if (o?.player && o.connected) o.player.send(f);
      }
      if (!s.sentFinish && rt >= s.plan.finish) {
        s.sentFinish = true;
        s.finish = s.plan.finish;
        o?.player?.send({ t: 'opp.finish', time: s.finish });
        this.checkEnd();
        if (this.phase !== 'racing') return;
      }
    }
    // 한쪽만 완주: 남은 사람의 레이스 시계(rt)가 상대 기록 + FINISH_WAIT_S 를 넘거나 's' 가 STALL_S 동안 끊기면 끝낸다.
    //   벽시계로 재지 않는다: 느린 기기는 레이스 시계가 실제 시간보다 늦게 간다 (클라이언트 프레임 dt 상한 0.1초).
    const done = this.sides.filter((x) => x.finish !== null);
    if (done.length === 1) {
      for (const s of this.sides) {
        if (s.bot || s.finish !== null || !s.connected) continue;
        const stalled = now() - (s.lastAt ?? this.goAt) > STALL_S;
        if ((Number(s.last?.rt) || 0) > done[0].finish! + FINISH_WAIT_S || stalled) { this.endRace('finish'); return; }
      }
    }
  }
  // 사람의 주행 상태 's' -> 상대 사람에게 'o'
  state(s: Side, m: any) {
    if (this.phase !== 'racing') return;
    const { t: _t, ...st } = m;
    s.last = { t: 'o', ...st };
    s.lastAt = now();
    const o = this.other(s);
    if (o && !o.bot && o.connected) o.player!.send(s.last);
  }
  finished(s: Side, m: any) {
    if (this.phase !== 'racing' || s.finish !== null) return;
    const tr = Number(m?.report?.TimeRecord);
    s.finish = tr > 0 ? r3(tr) : r3(Number(s.last?.rt) || now() - this.goAt);
    s.report = m?.report ?? null;
    const o = this.other(s);
    if (o && !o.bot) o.player!.send({ t: 'opp.finish', time: s.finish });
    this.checkEnd();
  }
  checkEnd() {
    if (this.phase !== 'racing') return;
    const done = this.sides.filter((x) => x.finish !== null);
    if (done.length === this.sides.length) { this.endRace('finish'); return; }
    if (done.length !== 1) return;
    const round = this.round;
    const rest = this.sides.find((x) => x.finish === null)!;
    if (rest.bot && rest.plan) {
      // 사람이 먼저 들어오면 봇 완주(최대 15초)까지 기다린다. 더 늦으면 봇은 계획한 시간으로 들어온 것으로 친다.
      const wait = Math.min(15, Math.max(0, this.goAt + rest.plan.finish - now()));
      this.after(wait + 0.05, () => {
        if (this.phase !== 'racing' || this.round !== round) return;
        if (rest.finish === null) {
          rest.finish = rest.plan!.finish; rest.sentFinish = true;
          this.other(rest)?.player?.send({ t: 'opp.finish', time: rest.finish });
        }
        this.endRace('finish');
      });
    }
    // 남은 쪽이 사람이면 tick() 이 레이스 시계 기준으로 기다린다
  }

  // 레이스 종료 -> result. how: finish | forfeit | void | timeout
  endRace(how: 'finish' | 'forfeit' | 'void' | 'timeout', loser?: Side) {
    if (this.phase !== 'racing' && this.phase !== 'loading') return;
    if (this.raceTimer) clearInterval(this.raceTimer);
    this.raceTimer = null;
    const [a, b] = this.sides;
    let winner: Side | null = null;
    if (how === 'forfeit' && loser) winner = this.other(loser);
    else if (a && b) {
      const ta = a.finish ?? Infinity, tb = b.finish ?? Infinity;
      if (ta !== tb) winner = ta < tb ? a : b;
    }
    const counted = !!winner && how !== 'void';
    const outHow = counted ? (how === 'forfeit' ? 'forfeit' : 'finish') : 'void';
    const ratings = new Map(this.sides.map((s) => [s.id, s.card.rating]));
    for (const s of this.sides) {
      const o = this.other(s);
      const win = counted && winner === s;
      let summary: any = null;
      if (!s.bot && s.player) {
        const delta = counted && o ? eloDelta(s.card.rating, ratings.get(o.id) ?? 1000, win) : 0;
        const st = counted ? s.player.updateStats((x) => {
          x.rating = Math.max(100, x.rating + delta); x.best = Math.max(x.best, x.rating);
          x.battles++; if (win) x.wins++; else x.losses++;
          x.streak = win ? (x.streak > 0 ? x.streak + 1 : 1) : (x.streak < 0 ? x.streak - 1 : -1);
        }) : statsOf(s.player.snap());
        summary = { win, rating: st.rating, ratingDelta: delta, wins: st.wins, losses: st.losses, battles: st.battles, streak: st.streak, best: st.best };
        Object.assign(s.card, { rating: st.rating, wins: st.wins, losses: st.losses, battles: st.battles, streak: st.streak, best: st.best });
        const myTime = s.finish ?? 0, oppTime = o?.finish ?? 0;
        const res: any = { t: 'result', how: outHow, win, winner: winner?.id ?? null, myTime, oppTime, summary };
        if (!(how === 'forfeit' && loser === s)) res.answer = this.answer(s, win, myTime, oppTime);
        // 거리 이름: 새 단어는 answer.StreetWordsNew (클라이언트 pvp 'result' 처리기가 streetNames.push). 추정: 대전도 일반 통계(races 등)에 넣는다.
        if (res.answer && counted) {
          const rep = s.report ?? {};
          const snap = s.player.snap();
          const got = s.player.street({
            win, nitro: Number(rep.NitroUseNum) || 0, perfectStart: !!rep.PerfectStart, excellent: Number(rep.ExcellentCnt) || 0,
            combo: Number(rep.ComboCount) || 0, speed: Number(rep.LinearMaxSpeed) || 0, time: myTime, oppTime, thema: this.track.thema,
            car: s.player.currentCar(snap) ?? s.car, girl: Number(snap?.UserInfo?.PassengerGirl) || 0,
            pvp: { myRating: ratings.get(s.id) ?? 1000, oppRating: o ? ratings.get(o.id) ?? 1000 : 0, rating: st.rating },
          });
          if (got.length) res.answer.StreetWordsNew = got;
        }
        s.player.send(res);
      } else if (counted) {
        const d = o ? eloDelta(s.card.rating, ratings.get(o.id) ?? 1000, win) : 0;
        s.card.rating = Math.max(100, s.card.rating + d); s.card.battles++; if (win) s.card.wins++; else s.card.losses++;
      }
    }
    console.log(`[pvp] 결과 방 ${this.id} (${outHow}): ${this.sides.map((x) => `${x.card.name} ${x.finish ?? '-'}`).join(' vs ')} -> ${winner?.card.name ?? '무효'}`);
    if (this.keeps && counted && winner) this.score.set(winner.id, (this.score.get(winner.id) ?? 0) + 1);
    this.last = { winner: counted ? winner!.id : null, times: new Map(this.sides.map((s) => [s.id, s.finish ?? 0])) };
    this.round++;
    this.touched = now();
    // 기권: 기권한 쪽은 방에서 빠진다 (남은 쪽: 빠른 대전은 room.closed, 개인 방 호스트는 다시 waiting)
    if (how === 'forfeit' && loser) { this.phase = 'lobby'; this.remove(loser, 'left'); return; }
    // 다음 라운드: 빠른 대전 = rematch 선택, 개인 방(keeps) = 다시 lobby
    for (const s of this.sides) { s.ready = false; s.rematch = false; s.loaded = false; }
    const round = this.round;
    if (this.keeps) { this.phase = 'lobby'; this.botsPrepare(); }
    else {
      this.phase = 'rematch';
      this.rematchDeadline = now() + REMATCH_S;
      this.after(REMATCH_S + 0.5, () => { if (this.phase === 'rematch' && this.round === round) this.close('expired'); });
      for (const s of this.sides) if (s.bot) {
        // 추정: 봇은 75% 확률로 재대결, 아니면 방을 떠난다
        const yes = Math.random() < 0.75;
        this.after(rand(2, 5), () => {
          if (this.phase !== 'rematch' || this.round !== round) return;
          if (yes) this.setRematch(s); else this.close('opponent_left');
        });
      }
    }
    for (const s of this.sides) if (s.bot && Math.random() < 0.5) this.after(rand(3, 6), () => this.botSay(s, pick(['gg', 'gg wp', 'nice race', 'close one!', 'gg!'])));
    this.push();
  }

  // 레이스 시작 응답 (클라이언트 #loadRace: Track 은 클라이언트 트랙 표로 채워진다, RaceType 8 = PvP)
  battleStart(s: Side): any {
    const o = this.other(s)!;
    const p = s.player!;
    const snap = p.snap();
    const ui = snap?.UserInfo ?? {};
    const bal = this.balance();
    const myAttrs = bal.map.get(s.id)?.attrs ?? s.card.carInfo?.Attributes;
    const oppAttrs = bal.map.get(o.id)?.attrs ?? o.card.carInfo?.Attributes;
    const track = { TrackId: this.track.trackId, Thema: this.track.thema, LightingIndex: this.track.lightingIndex };
    return {
      Seq: 1, Result: 1, RaceType: 8, UserInfo: ui, NitroReadyNum: 0, Passenger: Number(ui.PassengerGirl) > 0 ? Number(ui.PassengerGirl) : -1,
      GirlsSpecialSkill: [], MyCarInfo: { ...s.car, FinalAttr: myAttrs },
      OpponentCarInfo: { ...(o.bot ? o.car : o.card.carInfo), Attributes: oppAttrs },
      OpponentUserInfo: { Charname: o.card.name, Charlevel: o.card.level },
      Track: track, RaceInfo: { RaceId: 0, RaceMode: 1, RaceLifeType: 1, Track: track },
      Boss: 0, ForceWin: false, MyPosition: 0, RaceLevel: 1, ReplaySeed: this.battleSeed,
      // 엔진 DuelIntro {Me, Opp: {Name, Level, Rating}} -> 레이스 전 'EXCLUSIVE 1V1' 소개 (추정: Level = 계정 레벨)
      DuelIntro: { Me: { Name: s.card.name, Level: s.card.level, Rating: s.card.rating }, Opp: { Name: o.card.name, Level: o.card.level, Rating: o.card.rating } },
      RoomId: this.id, Round: this.round,
    };
  }
  // 결과 화면용 MsgBattleResultAns 모양 (클라이언트 #maybeShowResult: answer -> MsgNotifyEvent(UserInfo·MyCarInfo) + BS_RESULT)
  //   추정: 보상 없음 (DeltaInfo 0). 실서버의 대전 보상(일일 승리 보너스 등)은 미확인.
  answer(s: Side, win: boolean, myTime: number, oppTime: number): any {
    const o = this.other(s);
    const snap = s.player!.snap();
    const car = s.player!.currentCar(snap) ?? s.car;
    const bal = this.balance();
    const rep = s.report ?? {};
    const track = { TrackId: this.track.trackId, Thema: this.track.thema, LightingIndex: this.track.lightingIndex };
    const action = [2, 3, 4, 5, 6].map((a, i) => ({ Action: a, Count: Number([rep.MissCnt, rep.BadCnt, rep.GoodCnt, rep.PerfectCnt, rep.ExcellentCnt][i]) || 0 }));
    return {
      Seq: 1, Result: 1, IsPlayerWin: win, UserInfo: snap?.UserInfo, RaceType: 8, RaceLevel: 1, ItemInfo: [], NewCars: [],
      Track: track, Race: { RaceId: 0, RaceMode: 1, RaceLifeType: 1, Track: track },
      BattleScore: Number(rep.BattleScore) || 0, RaceAction: { Action: action, ComboCount: Number(rep.ComboCount) || 0 },
      BoostCompensation: 0, PerfectStart: !!rep.PerfectStart, MyTimeRecord: myTime, OpponentTimeRecord: oppTime,
      LeftBoost: Number(rep.LeftBoost) || 0, MyMaxSpeed: rep.LinearMaxSpeed, MyMaxDriftSpeed: rep.CornerMaxSpeed, Withdraw: false,
      DeltaInfo: { Charexp: 0, Coin: 0, Cash: 0 }, BaseCoin: 0, CoinRatio: 1,
      MyCarInfo: { ...car, FinalAttr: bal.map.get(s.id)?.attrs ?? finalAttr(snap, car) },
      ...(o ? { OpponentCarInfo: { ...(o.bot ? o.car : o.card.carInfo), Attributes: bal.map.get(o.id)?.attrs ?? o.card.carInfo?.Attributes },
        OpponentUserInfo: { Charname: o.card.name, Charlevel: o.card.level } } : {}),
      GgraphPatch: { Gnode: [] }, UpdateGirlInfo: [],
    };
  }

  // 참가자 퇴장 (취소·나가기·연결 끊김)
  remove(s: Side, reason: 'left' | 'disconnect') {
    if (!this.sides.includes(s)) return;
    if (this.phase === 'racing' || this.phase === 'loading') {
      if (this.phase === 'racing' && s.loaded) { this.endRace('forfeit', s); return; }
      this.close('load_failed'); return;
    }
    this.sides = this.sides.filter((x) => x !== s);
    if (s.dcTimer) clearTimeout(s.dcTimer);
    if (s.player && s.player.room === this) s.player.room = null;
    const rest = this.humans();
    if (!rest.length) { this.close(null); return; }
    if (!this.keeps || this.phase === 'rematch' || s.id === this.host) { this.close('opponent_left'); return; }
    // 개인 방의 손님이 나가면 방은 남고 호스트는 다시 기다린다
    this.phase = 'waiting';
    for (const x of this.sides) { x.ready = false; x.rematch = false; }
    for (const h of rest) h.player!.send({ t: 'room.opp_left', reason, name: s.card.name });
    this.push();
    this.server.botJoinLater(this);
  }
  close(reason: string | null) {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.raceTimer) clearInterval(this.raceTimer);
    for (const s of this.sides) {
      if (s.dcTimer) clearTimeout(s.dcTimer);
      if (s.player) { if (reason) s.player.send({ t: 'room.closed', reason }); if (s.player.room === this) s.player.room = null; }
    }
    this.server.rooms.delete(this.id);
  }
}
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function randomTrack(prefer: number[], trackId?: number, scenery?: number) {
  const ok = TRACKS.filter((t) => prefer.includes(t.trackId));
  const t = TRACKS.find((x) => x.trackId === Number(trackId)) ?? pick(ok.length ? ok : TRACKS);
  const si = Number.isInteger(scenery) && scenery! >= 0 && scenery! < t.sceneries.length ? scenery! : Math.floor(Math.random() * t.sceneries.length);
  return { trackId: t.trackId, thema: t.sceneries[si].thema, lightingIndex: t.sceneries[si].lightingIndex, scenery: si };
}

// ---- 연결 ----
class Conn {
  nonce = b64url(randomBytes(18));
  player: Player | null = null;
  authTimer: NodeJS.Timeout;
  constructor(readonly ws: WebSocket, readonly server: LocalPvp) {
    this.send({ t: 'hello', nonce: this.nonce, time: r3(now()), v: 1 });
    this.authTimer = setTimeout(() => { if (!this.player) this.ws.close(4001, 'auth_timeout'); }, 15000);
    ws.on('message', (raw) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      try { this.onMessage(m); } catch (e) { console.error('[pvp] 처리 오류', m.t, e); this.send({ t: 'error', code: 'server_error', message: 'Something went wrong on the server.' }); }
    });
    ws.on('close', () => { clearTimeout(this.authTimer); if (this.player?.conn === this) this.server.disconnected(this.player); });
    ws.on('error', () => { /* close 로 처리 */ });
  }
  send(o: any) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }
  fail(code: string, message: string, close?: number) { this.send({ t: 'error', code, message }); if (close) this.ws.close(close, code); }

  onMessage(m: any) {
    if (m.t === 'ping') { this.send({ t: 'pong', c: m.c, s: r3(now()) }); return; }
    if (!this.player) { if (m.t === 'auth') this.auth(m); return; }
    this.server.handle(this.player, m);
  }
  // auth {token, sig = base64url(HMAC_SHA256(sigKey, "ws\n"+nonce))}. 느슨 모드(strictSignatures=false)는 토큰만 맞으면 통과
  //   (http LAN 접속은 crypto.subtle 이 없어 클라이언트가 빈 서명을 보낸다).
  auth(m: any) {
    const deps = this.server.deps;
    const session = m.token ? deps.auth.bearer('Bearer ' + String(m.token)) : null;
    if (!session) { this.fail('no_session', 'Sign in first.', 4001); return; }
    const expect = b64url(createHmac('sha256', b64urlDec(session.sigKey)).update('ws\n' + this.nonce).digest());
    if (expect !== String(m.sig ?? '') && deps.strict) { this.fail('bad_signature', 'not signed in', 4001); return; }
    clearTimeout(this.authTimer);
    this.server.attach(this, String(session.accountId));
  }
}

export class LocalPvp {
  players = new Map<string, Player>();
  rooms = new Map<string, Room>();
  worldLines: any[] = [];
  worldSeq = 0;
  constructor(readonly deps: PvpLocalDeps) {}

  serve(ws: WebSocket) { new Conn(ws, this); }

  attach(conn: Conn, key: string) {
    let p = this.players.get(key);
    if (!p) { p = new Player(key, this); this.players.set(key, p); }
    if (p.conn && p.conn !== conn) { const old = p.conn; p.conn = null; old.fail('replaced', 'Signed in elsewhere.', 4002); }
    p.conn = conn;
    conn.player = p;
    const profile = p.profile();
    conn.send({ t: 'welcome', accountId: p.id, name: profile.name, time: r3(now()), config: welcomeConfig(), profile });
    // 소셜: 오프라인이라 다른 사람이 없다. 월드 채팅은 이 서버 안에서만(나 혼자) 보이고 프로필·커뮤니티는 끈다.
    conn.send({ t: 'social.hello', config: { open: true, world: { maxLength: 120, minLevel: 0 }, dm: { maxLength: 200, friendsOnly: true },
      mail: { subjectMax: 30, textMax: 300, friendsOnly: true, keepDays: 14 }, profiles: false, community: false, phraseMax: 60 },
      unread: { total: 0, by: {} }, blocked: [], packs: [] });
    // 재접속: 진행 중인 방/레이스로 돌려보낸다
    const room = p.room;
    const s = room?.sideOf(p);
    if (room && s) {
      if (s.dcTimer) { clearTimeout(s.dcTimer); s.dcTimer = undefined; }
      s.connected = true;
      const o = room.other(s);
      if (room.phase === 'racing' || room.phase === 'loading') {
        conn.send({ t: 'resume', room: room.view(s), battleStart: room.battleStart(s), goAt: room.phase === 'racing' ? room.goAt : 0, stateHz: HZ,
          oppState: o?.last ?? null, oppFinish: o?.finish ?? null });
        if (o?.player && !o.bot) o.player.send({ t: 'opp.reconnected' });
      } else room.push();
    }
    console.log(`[pvp] 접속 ${key} (${profile.name}) perf ${profile.perf}`);
  }

  disconnected(p: Player) {
    p.conn = null;
    if (p.queue) this.unqueue(p);
    const room = p.room;
    const s = room?.sideOf(p);
    if (!room || !s) return;
    s.connected = false;
    const o = room.other(s);
    if ((room.phase === 'racing' || room.phase === 'loading') && o?.player && !o.bot) o.player.send({ t: 'opp.disconnected', timeout: DC_FORFEIT_S });
    else if (o?.player && !o.bot) room.push();
    // disconnectForfeitSeconds 안에 돌아오지 않으면 기권/퇴장
    s.dcTimer = setTimeout(() => { s.dcTimer = undefined; if (!s.connected && room.sides.includes(s) && !room.closed) room.remove(s, 'disconnect'); }, DC_FORFEIT_S * 1000);
  }

  handle(p: Player, m: any) {
    const room = p.room;
    const side = room?.sideOf(p) ?? null;
    switch (m.t) {
      case 'profile': p.send({ t: 'profile', profile: p.profile() }); return;
      case 'intro.seen': p.updateStats((s) => { s.introSeen = true; }); p.send({ t: 'intro.ok' }); return;
      case 'queue': return this.enqueue(p, m);
      case 'cancel':
        if (p.queue) { this.unqueue(p); p.send({ t: 'queue', status: 'cancelled' }); }
        if (room && side) room.remove(side, 'left');
        return;
      case 'leave':
        if (p.queue) this.unqueue(p);
        if (room && side) room.remove(side, 'left');
        return;
      case 'room.create': return this.createRoom(p, !!m.public);
      case 'room.join': return this.joinRoom(p, m);
      case 'room.public':
        if (room && side && room.keeps && room.host === p.id && room.phase === 'waiting') { room.isPublic = !!m.public; room.push(); }
        return;
      case 'room.track':
        if (!room || !side || !room.keeps || room.host !== p.id || !(room.phase === 'waiting' || room.phase === 'lobby')) {
          p.send({ t: 'error', code: 'not_host', message: 'Only the host picks the track.' }); return;
        }
        room.track = randomTrack([], Number(m.trackId) || undefined, Number(m.scenery));
        room.touched = now();
        room.push();
        return;
      case 'room.car': case 'room.girl': {
        if (!room || !side || !(room.phase === 'waiting' || room.phase === 'lobby')) return;
        const before = side.card;
        const h = humanSide(p);
        if (!h) { p.send({ t: 'error', code: 'no_car', message: 'You need a car to race.' }); return; }
        side.card = h.card; side.car = h.car;
        const changed = m.t === 'room.car' ? before.carInfo?.Carid !== h.card.carInfo?.Carid || before.perf !== h.card.perf
          : before.passenger !== h.card.passenger || before.perf !== h.card.perf;
        p.send({ t: m.t, changed, perf: h.card.perf });
        room.push();
        return;
      }
      case 'rooms.list': return this.roomsList(p, !!m.near);
      case 'rooms.stop': return;
      case 'ready': if (room && side) room.setReady(side, m.ready !== false); return;
      case 'rematch': if (room && side && m.yes !== false) room.setRematch(side); return;
      case 'chat': {
        const text = String(m.text ?? '').trim().slice(0, CHAT_MAX);
        if (!text) return;
        if (!room || !side || room.sides.length < 2) { p.send({ t: 'error', code: 'nobody', message: 'There is nobody to talk to.' }); return; }
        room.addChat(side, text);
        const bot = room.other(side);
        if (bot?.bot && /\b(gg|gl|hi|hello|hey|wp)\b|안녕/i.test(text) && Math.random() < 0.6) room.after(rand(1, 2.5), () => room.botSay(bot, pick(['gl', 'hey :)', 'gg', 'thanks!', 'ready when you are'])));
        return;
      }
      case 'loaded': if (room && side) room.loaded(side); return;
      case 's': if (room && side) room.state(side, m); return;
      case 'finish': if (room && side) room.finished(side, m); return;
      case 'friends': p.send({ t: 'friends', friends: [] }); return;
      case 'invite': p.send({ t: 'error', code: 'not_friend', message: 'You can only invite your friends.' }); return;
      case 'park.list': p.send({ t: 'park.list', lots: [] }); return;
      case 'park.join': case 'park.challenge': case 'duel.challenge':
        p.send({ t: 'error', code: 'not_available', message: 'Challenges are closed for now.' }); return;
      case 'social.world.history': p.send({ t: 'social.world', lines: this.worldLines.slice(-200) }); return;
      case 'social.world.say': {
        const text = String(m.text ?? '').trim().slice(0, 120);
        if (!text) return;
        const snap = p.snap();
        const line = { id: ++this.worldSeq, at: Math.floor(now()), from: p.id, name: String(snap?.UserInfo?.Charname ?? ''), text };
        this.worldLines.push(line);
        if (this.worldLines.length > 200) this.worldLines.shift();
        for (const q of this.players.values()) q.send({ t: 'social.world.line', line });
        return;
      }
      case 'social.friends': p.send({ t: 'social.friends', list: [], blocked: [] }); return;
      case 'social.dm.history': p.send({ t: 'social.dm.history', with: m.with, name: '', lines: [] }); return;
      case 'social.community': return; // community 꺼짐
      default:
        if (m.t.startsWith('social.')) {
          p.send({ t: 'social.refused', scope: m.t.split('.')[1] ?? '', reason: 'offline', message: 'This player is not online.' });
          return;
        }
        if (!['invite.decline', 'duel.answer', 'duel.seen', 'duel.cancel', 'park.leave', 'park.away', 'park.answer'].includes(m.t)) console.log('[pvp] 미처리 메시지', m.t);
    }
  }

  // ---- 빠른 대전 ----
  enqueue(p: Player, m: any) {
    if (p.room) { p.send({ t: 'error', code: 'busy', message: 'Leave your room first.' }); return; }
    const h = humanSide(p);
    if (!h) { p.send({ t: 'error', code: 'no_car', message: 'You need a car to race.' }); return; }
    if (p.queue) clearInterval(p.queue.timer);
    const tracks = (Array.isArray(m.tracks) ? m.tracks : []).map(Number).filter((x: number) => TRACKS.some((t) => t.trackId === x)).slice(0, 3);
    const q = { since: now(), tracks, botAt: now() + rand(...BOT_MATCH_S), timer: setInterval(() => this.queueTick(p), 1000) };
    p.queue = q;
    this.queueTick(p);
  }
  unqueue(p: Player) { if (p.queue) { clearInterval(p.queue.timer); p.queue = null; } }
  queueTick(p: Player) {
    const q = p.queue;
    if (!q) return;
    const waited = now() - q.since;
    const perf = p.card().perf;
    const range = queueRange(perf, waited);
    if (waited >= MAX_WAIT_S) {
      this.unqueue(p);
      p.send({ t: 'queue', status: 'timeout', waited, range, perf, size: 0, tracks: q.tracks });
      return;
    }
    // 같은 서버의 다른 사람이 서로의 범위 안이면 먼저 붙인다
    for (const o of this.players.values()) {
      if (o === p || !o.queue || !o.conn) continue;
      const op = o.card().perf;
      const or = queueRange(op, now() - o.queue.since);
      if (op >= range.min && op <= range.max && perf >= or.min && perf <= or.max) { this.matchHumans(p, o); return; }
    }
    if (now() >= q.botAt) { this.matchBot(p); return; }
    const size = [...this.players.values()].filter((x) => x.queue).length;
    p.send({ t: 'queue', status: 'searching', waited, range, perf, size, tracks: q.tracks });
  }
  matchBot(p: Player) {
    const tracks = p.queue?.tracks ?? [];
    this.unqueue(p);
    const h = humanSide(p);
    if (!h) { p.send({ t: 'error', code: 'no_car', message: 'You need a car to race.' }); return; }
    const room = this.newRoom(p.id, false, false);
    room.track = randomTrack(tracks);
    p.room = room;
    room.sides.push(h);
    room.join(makeBot(h.card));
  }
  matchHumans(a: Player, b: Player) {
    const prefer = [...new Set([...(a.queue?.tracks ?? []).filter((x) => (b.queue?.tracks ?? []).includes(x))])];
    const either = [...(a.queue?.tracks ?? []), ...(b.queue?.tracks ?? [])];
    this.unqueue(a); this.unqueue(b);
    const ha = humanSide(a), hb = humanSide(b);
    if (!ha || !hb) return;
    const room = this.newRoom(a.id, false, false);
    room.track = randomTrack(prefer.length ? prefer : either);
    a.room = room; b.room = room;
    room.sides.push(ha);
    room.join(hb);
  }
  newRoom(host: number, keeps: boolean, pub: boolean): Room {
    const r = new Room(this, host, keeps, pub);
    while ([...this.rooms.values()].some((x) => x.code === r.code)) r.code = Array.from({ length: 6 }, () => pick([...CODE_CHARS])).join('');
    this.rooms.set(r.id, r);
    if (keeps) {
      // 개인 방 방치 만료 검사
      const check = () => { if (r.closed) return; if (now() - r.touched > ROOM_IDLE_S && r.phase !== 'racing' && r.phase !== 'loading') r.close('expired'); else r.after(60, check); };
      r.after(60, check);
    }
    return r;
  }

  // ---- 방 ----
  createRoom(p: Player, pub: boolean) {
    if (p.room) { p.send({ t: 'error', code: 'busy', message: 'Leave your room first.' }); return; }
    if (p.queue) this.unqueue(p);
    const h = humanSide(p);
    if (!h) { p.send({ t: 'error', code: 'no_car', message: 'You need a car to race.' }); return; }
    const room = this.newRoom(p.id, true, pub);
    p.room = room;
    room.join(h);
    this.botJoinLater(room);
  }
  botJoinLater(room: Room) {
    // 추정: 아무도 안 들어오면 몇 초 뒤 봇이 들어온다
    room.after(rand(...BOT_JOIN_S), () => {
      const host = room.sides[0];
      if (room.phase === 'waiting' && room.sides.length === 1 && host) room.join(makeBot(host.card));
    });
  }
  joinRoom(p: Player, m: any) {
    if (p.room) { p.send({ t: 'error', code: 'busy', message: 'Leave your room first.' }); return; }
    if (p.queue) this.unqueue(p);
    const h = humanSide(p);
    if (!h) { p.send({ t: 'error', code: 'no_car', message: 'You need a car to race.' }); return; }
    // 목록의 봇 방 (id 'b...'): 봇이 호스트인 개인 방을 연다
    const bid = String(m.id ?? '');
    if (bid.startsWith('b')) {
      const e = p.botRooms?.list.find((x) => x.id === bid);
      if (!e) { p.send({ t: 'error', code: 'no_room', message: 'No such room (it may have ended).' }); return; }
      p.botRooms!.list = p.botRooms!.list.filter((x) => x !== e);
      const room = this.newRoom(e.bot.id, true, true);
      room.track = e.track; room.createdAt = e.createdAt;
      room.sides.push(e.bot);
      p.room = room;
      room.join(h);
      return;
    }
    const code = String(m.code ?? '').trim().toUpperCase();
    const room = m.id !== undefined ? this.rooms.get(String(m.id)) : [...this.rooms.values()].find((r) => r.code === code);
    if (!room || room.closed || room.phase !== 'waiting' || room.sides.length !== 1 || (m.id !== undefined && !room.isPublic)) {
      p.send({ t: 'error', code: 'no_room', message: m.id !== undefined ? 'No such room (it may have ended).' : 'No room with this code.' });
      return;
    }
    if (room.sides[0].id === p.id) { p.send({ t: 'error', code: 'own_room', message: 'This is your own room.' }); return; }
    p.room = room;
    room.join(h);
  }
  roomsList(p: Player, near: boolean) {
    const me = p.card();
    // 봇 방은 5분마다 새로 (추정: 2~4개, 첫 방은 내 성능 ±10%, 나머지 ±40%)
    if (!p.botRooms || now() - p.botRooms.at > 300) {
      const n = 2 + Math.floor(Math.random() * 3);
      p.botRooms = { at: now(), list: Array.from({ length: n }, (_, i) => {
        const bot = makeBot(me, me.perf * (1 + (i === 0 ? rand(-0.1, 0.1) : rand(-0.4, 0.4))));
        return { id: `b${bot.id}`, bot, track: randomTrack([]), createdAt: now() - rand(10, 600) - i };
      }) };
    }
    const entry = (id: string, host: Card, track: any, createdAt: number) => ({
      id, host: { accountId: host.accountId, name: host.name, level: host.level, cartype: host.cartype, grade: host.grade, perf: host.perf, rating: host.rating },
      gap: me.perf ? Math.round(((host.perf - me.perf) / me.perf) * 1000) / 1000 : 0, track, createdAt,
    });
    const all = [
      ...[...this.rooms.values()].filter((r) => r.keeps && r.isPublic && r.phase === 'waiting' && r.sides.length === 1 && r.sides[0].id !== p.id)
        .map((r) => entry(r.id, r.sides[0].card, r.track, r.createdAt)),
      ...p.botRooms.list.map((e) => entry(e.id, e.bot.card, e.track, e.createdAt)),
    ];
    const list = near ? all.filter((e) => Math.abs(e.gap) <= NEAR_BAND + 1e-9) : all;
    p.send({ t: 'rooms', list, total: all.length, near, at: r3(now()) });
  }
}

let instance: LocalPvp | null = null;
/** 오프라인 모드의 /api/pvp 연결을 로컬 대전 서버가 맡는다 */
export function serveLocalPvp(ws: WebSocket, deps: PvpLocalDeps): void {
  instance ??= new LocalPvp(deps);
  instance.serve(ws);
}
