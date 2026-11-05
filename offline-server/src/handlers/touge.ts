// Haunted Pass Board (할로윈 주사위 보드, 내부 이름 touge). 실기록 2026-11-05: LocalTougeBoardReq 14건, LocalTougeRollReq 8건
//   (무료 주사위 7번 + 보스 첫 승 뒤 유령 부스트 포함 1번), 보스 첫 승 MsgBattleResultReq 뒤 MsgNotifyEvent {TougeTickets}.
// 설정: src/data/touge-board.json {Board: 기록된 보드 설정(계정별 값 제외)} — scripts/make-touge-board.cjs 가 data/recorded 의 LocalTougeBoardAns 로 만든다
//   (게임 데이터라 저장소에는 넣지 않는다, make-event-races.cjs 와 같은 방침). 계정 상태: snap.touge.
//
// 흐름(기록 + 클라이언트 소스 index-hQgLZYbI.js 'TougeBoard'):
//   LocalTougeBoardReq {} -> {Seq, Result 1, Board {Open, Season, Price, Theme, Squares[40], Pumpkin[{.., p, owned}], PumpkinOwned, Laps,
//     TenPumpkin, RollBonus{rolls, items, name, given}, After, Lantern, Phantom, NoCostume, Tickets, Costumes[{.., owned}],
//     State {Pos, Laps, Rolls, Tickets, Moves, Infinite, Picks, Next}, GoldCash}}.
//     기간(Season) 밖이면 Result 2 (추정: 클라이언트는 1 이 아니면 'touge_closed').
//   LocalTougeRollReq {Count 1|10} -> {Seq, Result 1, Steps[{die, from, to, got} | {ghost, ..} | {rollBonus, die 0, name, got[]} | {bonus, ..}],
//     Paid, Ticket, UserInfo, RewardInfo {Coin, Charexp, Cash, Familiartity, ItemInfo, CarInfo, Cosmetics?, BoxesOpened?}, Cosmetics?, Board}.
//     Result 7 = 무료 주사위도 Gold Cash 도 부족 ('touge_not_enough').
//   LocalTougePickReq {Lap, Choice} -> {Seq, Result 1, Pick {costume | box | items}, RewardInfo, UserInfo, Board}. Result 10 = 차고 칸 부족('touge_no_room').
// 기록으로 확인한 규칙:
//   무료 주사위: 첫 보드 때 이미 이긴 스토리 레이스 수만큼(기록: 3103 스토리 7개 승리 -> Tickets 7), 이후 첫 승리마다 Tickets 설정만큼(event.ts 훅).
//     보스 첫 승: +1 + 유령 이동 2칸(Moves). 다음 굴림 때 유령 이동이 먼저 한 걸음({ghost:true, die 2})으로 나온다.
//   한 번 굴릴 때 Rolls +1, 무료 주사위 -1 (Paid 0, Ticket true). RollBonus: Rolls 가 rolls(8) 에 닿은 굴림에 {rollBonus} 걸음 + 차량 지급, given true.
//   칸 보상 got: 아이템/코인 {kind item, id, count}, 할로윈 상자 69903 은 바로 열림 {.., opened true} (RewardInfo.BoxesOpened, Cosmetics[{Id, Rarity, Dup, Shards}]),
//     호박 {kind cosmetic, id, count 1, owned false, pumpkin true}, 유령 칸 기본 보상 61201 x1.
//   RewardInfo.ItemInfo: 아이템 {Itemid, Itemtype, Count(증가분), StackNum(새 수량), DeltaNum}, 코인은 합쳐서 끝에 {Itemtype 61001, Count, DeltaNum}.
//   Cosmetics.Owned 추가 {Id, Time, From}: 호박 'touge', 상자 'touge:halloween'. Pity.halloween 은 상자마다 +1, 전설 이상이면 0.
//   상자 2개 칸(기록 2건): 코스메틱 1 + 코인 20000 -> 가진 것만 남은 뽑기는 코인 20000 으로 본다(Server.box.fallbackCoin).
// 추정(기록 없음): 주사위 1~6 균등, 바퀴 보상·선택(Picks)·호박 '가진 것'(PumpkinOwned)·유령/랜턴 부품·10회 보너스 호박의 세부,
//   골드 상자 내용, 차고가 차도 차량은 바로 지급(오프라인 우편은 차량을 못 담는다), Gold Cash 는 UserInfo.GoldCash(오프라인은 없음).
import { readFileSync, existsSync } from 'node:fs';
import { register, type Ctx, type Msg } from '../rpc.js';
import { grantItem, itemDef } from '../inventory.js';
import { table, carDefOf, partDef, newOwnedCar, grantPart } from '../gamecalc.js';

const CFG_PATH = new URL('../../src/data/touge-board.json', import.meta.url).pathname; // date-answers.json 처럼 저장소에 포함 (data/ 는 gitignore)
const CONTENT_PATH = new URL('../../data/content.json', import.meta.url).pathname;
const EVENTS_PATH = new URL('../../src/data/event-races.json', import.meta.url).pathname;
const R_OK = 1, R_CLOSED = 2, R_NO_GOLD = 7, R_NO_ROOM = 10;
const COIN = 61001, CASH = 61002;
const TIERS = ['common', 'rare', 'epic', 'legendary', 'ultra'];
const ST_WIN = 16; // 레이스 State 승리 비트 (event.ts ST.WIN)
const nowSec = () => Math.floor(Date.now() / 1000);
const pickOne = <T>(a: T[]): T | undefined => (a.length ? a[Math.floor(Math.random() * a.length)] : undefined);

/** 주사위 (테스트에서 바꿔 끼울 수 있게 객체로 둔다). 추정: 눈마다 같은 확률 (문구 'each face 16.67 %') */
export const tougeDice = { roll: (faces: number[]): number => faces[Math.floor(Math.random() * faces.length)] };

// ── 설정·표
let cfg: any | undefined;
function config(): any | null {
  if (cfg === undefined) {
    try { cfg = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : null; } catch (e) { console.warn(`[touge] 설정 읽기 실패: ${(e as Error).message}`); cfg = null; }
    if (!cfg?.Board) console.warn('[touge] src/data/touge-board.json 없음: 보드는 닫힌 상태로 응답');
  }
  return cfg?.Board ? cfg : null;
}
// 서버 전용 규칙 (기록·추정): die 주사위 눈(균등, 추정: 문구 'each face 16.67 %'), box 칸에서 바로 여는 상자(69903)와
//   남은 코스메틱이 없을 때의 대체 코인(실기록 2상자 칸 2건: 코스메틱 1 + 20000 코인), from Cosmetics.Owned From 값(실기록),
//   carFuel 지급 차량 연료 = base + perGrade x 등급(실기록 NSR+ ★5 40). 설정 파일의 Server 블록이 있으면 그것을 쓴다.
const SERVER_DEFAULT = { die: [1, 2, 3, 4, 5, 6], box: { item: 69903, fallbackCoin: 20000, from: 'touge:halloween' }, pumpkinFrom: 'touge', carFuel: { base: 15, perGrade: 5 } };
const server = (): any => ({ ...SERVER_DEFAULT, ...(config()?.Server ?? {}) });
let content: any | undefined;
const contentJson = (): any => (content ??= existsSync(CONTENT_PATH) ? JSON.parse(readFileSync(CONTENT_PATH, 'utf8')) : {});
let cosMap: Map<string, any> | null = null;
const cosDef = (id: string): any => (cosMap ??= new Map((contentJson().cosmetics ?? []).map((d: any) => [String(d.id), d]))).get(String(id)) ?? null;
let itemMap: Map<number, any> | null = null;
/** itemTable 행 (content.json 표 패치 포함: 69903·68401 등은 패치에만 있다) */
const itemRow = (id: number): any => (itemMap ??= new Map((table('itemTable.json')?.Item ?? []).map((r: any) => [Number(r.Id), r]))).get(Number(id)) ?? null;
const storeRow = (id: number): any => (table('itemTable.json')?.StoreItem ?? []).find((r: any) => Number(r.Id) === Number(id)) ?? null;
const girlItemRow = (id: number): any => (table('girlItemTable.json')?.GirlItemInfo ?? []).find((r: any) => Number(r.Id) === Number(id)) ?? null;
/** 의상 아이템(Info 'Girlitem') -> girlItemTable 행 (클라이언트 costumeGirlItem 과 같다) */
const costumeGirlItem = (type: number): any => { const d = itemRow(type); return d?.Info === 'Girlitem' ? girlItemRow(parseInt(String(d.Resources), 10)) : null; };

const isOpen = (B: any): boolean => { const t = Date.now(); return t >= Date.parse(B.Season?.Start) && t <= Date.parse(B.Season?.End); };

let zoneCache: number | null | undefined;
/** 무료 주사위를 주는 이벤트 구역: Tickets.event 와 같은 reborn.Id 를 가진 src/data/event-races.json 구역 (halloween_night -> 3103) */
function ticketZone(B: any): number | null {
  if (B.Tickets?.zone) return Number(B.Tickets.zone);
  if (zoneCache === undefined) {
    const ev = existsSync(EVENTS_PATH) ? JSON.parse(readFileSync(EVENTS_PATH, 'utf8')) : {};
    const hit = Object.entries(ev).find(([, v]: [string, any]) => v?.reborn?.Id === B.Tickets?.event);
    zoneCache = hit ? Number(hit[0]) : null;
  }
  return zoneCache;
}

// ── 계정 상태
interface TState { Season: string; Pos: number; Laps: number; Rolls: number; Tickets: number; Moves: number; Picks: any[]; Won: number[]; BonusGiven: boolean; Awards: string[] }

/** 이미 이긴 스토리·보스 레이스 (State 승리 비트) */
function wonRaces(snap: any, B: any): number[] {
  const T = B.Tickets ?? {};
  const want = [...(T.storyRaces ?? []), T.bossRace].map(Number);
  const z = (snap.RaceZones?.RaceZone ?? []).find((x: any) => Number(x.ZoneId) === ticketZone(B));
  return (z?.Race ?? []).filter((r: any) => Number(r.State) & ST_WIN && want.includes(Number(r.RaceIndex))).map((r: any) => Number(r.RaceIndex));
}

/** 계정 상태. 처음(또는 다른 시즌)이면 이미 이긴 레이스만큼 무료 주사위로 시작한다 (기록: 스토리 7승 상태에서 첫 보드 Tickets 7, Moves 0) */
function stateOf(snap: any, B: any): TState {
  let s: TState = snap.touge;
  if (!s || s.Season !== B.Season?.Start) {
    const T = B.Tickets ?? {};
    const won = wonRaces(snap, B);
    const boss = won.includes(Number(T.bossRace));
    const story = won.filter((i) => (T.storyRaces ?? []).map(Number).includes(i)).length;
    s = snap.touge = {
      Season: B.Season?.Start, Pos: 0, Laps: 0, Rolls: 0,
      Tickets: story * (Number(T.storyFirstWin) || 0) + (boss ? Number(T.bossFirstWin) || 0 : 0), Moves: boss ? Number(T.bossMove) || 0 : 0,
      Picks: [], Won: won, BonusGiven: false, Awards: [],
    };
  }
  return s;
}

// ── 보유 판정
const ownedCos = (snap: any) => new Set<string>((snap.Cosmetics?.Owned ?? []).map((c: any) => String(c.Id)));
const hasItem = (snap: any, type: number) => (snap.Items?.ItemInfo ?? []).some((x: any) => Number(x.Itemtype) === Number(type) && Number(x.Count ?? x.StackNum ?? 1) > 0);
/** 클라이언트 costumeOwned 와 같다: 의상이면 GirlItems 에 그 의상, 아니면 인벤토리 */
function ownsItem(snap: any, type: number): boolean {
  const gi = costumeGirlItem(type);
  if (gi && (snap.GirlItems?.GirlItemInfo ?? []).some((x: any) => Number(x.ItemType) === Number(gi.Id))) return true;
  return hasItem(snap, type);
}
const costumeOwned = (snap: any, c: any) => ownsItem(snap, Number(c.items?.[0]));
const hasCar = (snap: any, type: number) => (snap.Cars?.CarInfo ?? []).some((c: any) => Number(c.Cartype) === Number(type));
const missingParts = (snap: any, ids: number[] = []) => ids.map(Number).filter((id) => !hasItem(snap, id));

function pumpkinOwned(snap: any, B: any, p: any): boolean {
  switch (p.kind) {
    case 'cosmetic': return ownedCos(snap).has(String(p.id));
    case 'decal': case 'item': return ownsItem(snap, Number(p.id));
    case 'phantom': return !missingParts(snap, B.Phantom).length;
    case 'lantern': return !missingParts(snap, B.Lantern).length;
    case 'costume': return (B.Costumes ?? []).every((c: any) => costumeOwned(snap, c));
    default: return false; // part: 언제나 새 부품
  }
}

// ── 보드 응답 (설정 순서 그대로 + 계정별 값)
const lapDef = (B: any, n: number): any => (B.Laps ?? []).find((l: any) => Number(l.lap) === n) ?? { lap: n, kind: 'after' }; // 추정: 마지막 바퀴 뒤는 After 선택
function boardOf(snap: any, B: any, ctx: Ctx): any {
  const s = stateOf(snap, B);
  const total = (B.Pumpkin ?? []).reduce((a: number, p: any) => a + Number(p.weight), 0);
  const out: any = { Open: isOpen(B) };
  for (const [k, v] of Object.entries(B)) out[k] = v;
  out.Pumpkin = (B.Pumpkin ?? []).map((p: any) => ({ ...p, p: Number(p.weight) / total, owned: pumpkinOwned(snap, B, p) }));
  if (B.RollBonus) out.RollBonus = { ...B.RollBonus, given: !!s.BonusGiven };
  out.Costumes = (B.Costumes ?? []).map((c: any) => ({ ...c, owned: costumeOwned(snap, c) }));
  out.State = { Pos: s.Pos, Laps: s.Laps, Rolls: s.Rolls, Tickets: s.Tickets, Moves: s.Moves, Infinite: infinite(ctx), Picks: s.Picks, Next: lapDef(B, s.Laps + 1) };
  out.GoldCash = Number(snap.UserInfo?.GoldCash) || 0;
  return out;
}
/** 시험용 무한 주사위(실서버 State.Infinite '∞ (test)'). 오프라인은 config.json cheat.tougeInfinite (추정) */
const infinite = (ctx: Ctx) => !!(ctx.cheat?.enabled && ctx.cheat?.tougeInfinite);

// ── 지급 (요청 하나의 RewardInfo 를 모은다)
class Gain {
  coin = 0; cash = 0; boxes = 0; cosAdds = 0; pity = false; kit = false;
  entries: any[] = []; cars: any[] = []; cos: any[] = []; girl: any[] = [];
}

function giveCar(snap: any, g: Gain, type: number): any {
  const car = newOwnedCar(snap, type);
  // 연료: 실기록 NSR+ ★5 -> FuelConsume 40, FuelConsume20404 26 (event.ts 상대 차량과 같은 식)
  const f = server().carFuel ?? { base: 15, perGrade: 5 };
  car.FuelConsume = Number(f.base) + Number(f.perGrade) * (Number(car.Grade) || 1);
  car.FuelConsume20404 = Math.floor((car.FuelConsume * 2) / 3);
  snap.Cars ??= { CarInfo: [], Version: 1 };
  (snap.Cars.CarInfo ??= []).push(car);
  g.cars.push(car);
  return car;
}

function giveGirlItem(snap: any, g: Gain, gi: any): boolean {
  snap.GirlItems ??= { GirlItemInfo: [], Version: 1 };
  const list: any[] = (snap.GirlItems.GirlItemInfo ??= []);
  if (list.some((x) => Number(x.ItemType) === Number(gi.Id))) return false;
  const it = { ItemId: list.reduce((m, x) => Math.max(m, Number(x.ItemId) || 0), 0) + 1, ItemType: Number(gi.Id), StackNum: 1 };
  list.push(it);
  g.girl.push(it);
  return true;
}

/** 아이템 지급: 코인·캐시는 UserInfo, 의상은 GirlItems, 부품·차량은 새 레코드, 나머지는 인벤토리 묶음 */
function giveItem(snap: any, g: Gain, type: number, n: number): void {
  type = Number(type); n = Math.trunc(Number(n) || 0);
  if (!type || n <= 0) return;
  const ui = snap.UserInfo;
  if (type === COIN) { ui.Coin = (Number(ui.Coin) || 0) + n; g.coin += n; return; }
  if (type === CASH) { ui.Cash = (Number(ui.Cash) || 0) + n; g.cash += n; return; }
  const gi = costumeGirlItem(type);
  if (gi) { giveGirlItem(snap, g, gi); return; }
  const pd = partDef(type);
  if (pd) { for (let i = 0; i < n; i++) g.entries.push(grantPart(snap, pd)); return; }
  if (carDefOf(type)) { for (let i = 0; i < n; i++) giveCar(snap, g, type); return; }
  const def = itemRow(type);
  if (!def) { console.warn(`[touge] 아이템 정의 없음: ${type} x${n} (지급 안 함)`); return; }
  // inventory.ts 는 원본 표만 보므로 패치에만 있는 아이템(69903 등)은 여기서 한 묶음에 쌓는다
  if (!itemDef(type) || !grantItem(snap, type, n)) {
    snap.Items ??= { ItemInfo: [] };
    const list: any[] = (snap.Items.ItemInfo ??= []);
    const it = list.find((x) => Number(x.Itemtype) === type);
    if (it) { it.Count = (Number(it.Count) || 0) + n; it.StackNum = it.Count; }
    else list.push({ Itemid: list.reduce((m, x) => Math.max(m, Number(x.Itemid) || 0), 0) + 1, Itemtype: type, Count: n, StackNum: n });
  }
  const stack = (snap.Items?.ItemInfo ?? []).filter((x: any) => Number(x.Itemtype) === type).at(-1);
  const prev = g.entries.find((e) => Number(e.Itemtype) === type && e.DeltaNum !== undefined);
  if (prev) { prev.Count += n; prev.DeltaNum += n; prev.StackNum = Number(stack?.Count) || prev.StackNum; }
  else g.entries.push({ Itemid: stack?.Itemid, Itemtype: type, Count: n, StackNum: Number(stack?.Count) || n, DeltaNum: n });
}

function cosmeticsOf(snap: any): any {
  snap.Cosmetics ??= {};
  snap.Cosmetics.Owned ??= [];
  snap.Cosmetics.Version ??= 0;
  snap.Cosmetics.Shards ??= 0;
  snap.Cosmetics.Pity ??= {};
  return snap.Cosmetics;
}
/** 코스메틱 지급 (이미 있으면 false). RewardInfo.Cosmetics {Id, Rarity, Dup false, Shards 0} (실기록) */
function giveCosmetic(snap: any, g: Gain, id: string, from: string): boolean {
  const c = cosmeticsOf(snap);
  if (c.Owned.some((x: any) => String(x.Id) === String(id))) return false;
  c.Owned.push({ Id: String(id), Time: nowSec(), From: from });
  g.cos.push({ Id: String(id), Rarity: cosDef(id)?.rarity ?? 'common', Dup: false, Shards: 0 });
  g.cosAdds++;
  return true;
}
/** Kit 조각 (클라이언트 ownedKitPieces: Cosmetics.Kit[모델] = ['body_phantom', ..]) */
function giveKit(snap: any, g: Gain, kit: any): string[] {
  const c = cosmeticsOf(snap);
  const list: string[] = ((c.Kit ??= {})[String(kit.model).toUpperCase()] ??= []);
  const add = (kit.pieces ?? []).filter((p: string) => !list.includes(p));
  list.push(...add);
  if (add.length) g.kit = true;
  return add;
}

/** 칸에서 바로 여는 할로윈 상자 (content.json cosmeticBoxes 의 같은 item 상자 규칙: 등급 확률, 50회 천장, 가진 것 제외).
 *  가진 것이 나오면 같은 등급이나 더 흔한 등급의 없는 것(79511 설명 문구), 그것도 없으면 Server.box.fallbackCoin (실기록 20000). */
function openBoxes(snap: any, g: Gain, n: number): void {
  const sb = server().box ?? {};
  const box = (contentJson().cosmeticBoxes?.boxes ?? []).find((b: any) => Number(b.item) === Number(sb.item));
  if (!box) { console.warn(`[touge] 상자 ${sb.item} 규칙 없음: 아이템으로 지급`); giveItem(snap, g, Number(sb.item), n); return; }
  const pool = (contentJson().cosmetics ?? []).filter((d: any) => d.season === box.season && !(box.exclude ?? []).includes(d.id)
    && (!box.types || box.types.includes(d.type)) && d.box !== false);
  const top = TIERS.indexOf(box.pity?.rarity ?? 'legendary');
  const c = cosmeticsOf(snap);
  for (let i = 0; i < n; i++) {
    g.boxes++;
    const pity = Number(c.Pity[box.id]) || 0;
    const forced = !!box.pity && pity >= Number(box.pity.pulls) - 1; // 'after pulls - 1 draws without pity.rarity or rarer, the next is'
    const odds = TIERS.map((t, k) => ({ k, w: forced && k < top ? 0 : Number(box.odds?.[t]) || 0 })).filter((x) => x.w > 0 && pool.some((d: any) => d.rarity === TIERS[x.k]));
    let r = Math.random() * odds.reduce((a, x) => a + x.w, 0), tier = odds.at(-1)?.k ?? 0;
    for (const x of odds) { r -= x.w; if (r < 0) { tier = x.k; break; } }
    const owned = ownedCos(snap);
    let got: any = null;
    for (let k = tier; k >= 0 && !got; k--) got = pickOne(pool.filter((d: any) => d.rarity === TIERS[k] && !owned.has(d.id))) ?? null;
    if (got) giveCosmetic(snap, g, got.id, sb.from ?? 'touge:halloween');
    else giveItem(snap, g, COIN, Number(sb.fallbackCoin) || 20000);
    // 전설 이상이 나오면 0. 줄 것이 없어 천장이 못 터지면 '다음 1회 확정' 에 머문다 (추정)
    c.Pity[box.id] = got && TIERS.indexOf(got.rarity) >= top ? 0 : box.pity ? Math.min(pity + 1, Number(box.pity.pulls) - 1) : pity + 1;
    g.pity = true;
  }
}

/** 칸 아이템 보상 (69903 은 바로 열기) */
function itemGot(snap: any, g: Gain, id: number, n: number): any {
  if (Number(id) === Number(server().box?.item)) { openBoxes(snap, g, n); return { kind: 'item', id: Number(id), count: n, opened: true }; }
  giveItem(snap, g, id, n);
  return { kind: 'item', id: Number(id), count: n };
}

/** 세트 부품 하나 (없는 것 중 무작위). 없으면 null */
function setPart(snap: any, g: Gain, ids: number[], flag: 'phantom' | 'lantern'): any | null {
  const id = pickOne(missingParts(snap, ids));
  if (!id) return null;
  giveItem(snap, g, id, 1);
  return { kind: 'item', id, count: 1, [flag]: true, setOwned: ids.length - missingParts(snap, ids).length };
}

/** 호박 한 번: Pumpkin 확률표, 가진 것이면 PumpkinOwned(부품 재료 61006 x100) */
function drawPumpkin(snap: any, B: any, s: TState, g: Gain): any {
  const table_ = B.Pumpkin ?? [];
  let r = Math.random() * table_.reduce((a: number, p: any) => a + Number(p.weight), 0);
  let p = table_.at(-1);
  for (const x of table_) { r -= Number(x.weight); if (r < 0) { p = x; break; } }
  if (!p || pumpkinOwned(snap, B, p)) {
    const [id, n] = B.PumpkinOwned?.[0] ?? [61006, 100];
    giveItem(snap, g, id, n);
    return { kind: 'item', id: Number(id), count: Number(n), owned: true, pumpkin: true };
  }
  switch (p.kind) {
    case 'cosmetic':
      giveCosmetic(snap, g, p.id, server().pumpkinFrom ?? 'touge');
      return { kind: 'cosmetic', id: p.id, count: 1, owned: false, pumpkin: true }; // 실기록 형식
    case 'decal': case 'item':
      giveItem(snap, g, p.id, 1);
      return { kind: p.kind, id: Number(p.id), count: 1, owned: false, pumpkin: true, ...(costumeGirlItem(p.id) ? { costume: true } : {}) };
    case 'phantom': case 'lantern':
      return { ...setPart(snap, g, p.kind === 'phantom' ? B.Phantom : B.Lantern, p.kind), pumpkin: true };
    case 'costume':
      s.Picks.push({ lap: s.Laps + 1, kind: 'costume' }); // 클라이언트: 'Pick it from the list once the dice stop.'
      return { kind: 'costume', count: 1, pumpkin: true };
    default: {
      // ★5 부품: 가진 최고 차량 등급을 넘지 않고, 가진 적 없는 것 ('never above your best car', 'Always new')
      const best = (snap.Cars?.CarInfo ?? []).reduce((m: number, c: any) => Math.max(m, Number(c.Grade) || 1), 1);
      const grade = Math.min(Number(p.grade) || 5, best);
      const all: any[] = (table('parts.json')?.Part ?? []).filter((d: any) => Number(d.Grade) === grade && Number(d.Distribute) === 1);
      const def: any = pickOne(all.filter((d) => !hasItem(snap, d.Id))) ?? pickOne(all);
      if (!def) { const [id, n] = B.PumpkinOwned?.[0] ?? [61006, 100]; giveItem(snap, g, id, n); return { kind: 'item', id: Number(id), count: Number(n), owned: true, pumpkin: true }; }
      g.entries.push(grantPart(snap, def));
      return { kind: 'item', id: Number(def.Id), count: 1, pumpkin: true };
    }
  }
}

/** 칸에 섰을 때 */
function land(snap: any, B: any, s: TState, g: Gain): any {
  const sq = B.Squares?.[s.Pos] ?? {};
  switch (sq.kind) {
    case 'start': return itemGot(snap, g, sq.reward?.[0], Number(sq.reward?.[1]) || 1);
    case 'reward': return itemGot(snap, g, sq.id, Number(sq.count) || 1);
    case 'pumpkin': return drawPumpkin(snap, B, s, g);
    case 'phantom': {
      // 아주 드물게 유령 부품(chance) 또는 랜턴 부품(nextChance), 없는 것만. 아니면 기본 보상 (실기록 61201 x1)
      const r = Math.random();
      const hit = r < Number(sq.chance) ? setPart(snap, g, sq.parts, 'phantom')
        : r < Number(sq.chance) + Number(sq.nextChance || 0) ? setPart(snap, g, sq.next, 'lantern') : null;
      return hit ?? itemGot(snap, g, sq.reward?.[0], Number(sq.reward?.[1]) || 1);
    }
    case 'roll': s.Tickets++; return { kind: 'roll', count: 1 }; // '+1 Roll' 칸 (클라이언트 표시만, 현재 보드에는 없음)
    default: return null;
  }
}

/** 바퀴 완주 보상. 걸음의 lap 객체 (클라이언트 #LapClear 가 읽는 필드: kind, got, parts, set, bonus, kit, cars, also, girl, name) */
function completeLap(snap: any, B: any, s: TState, g: Gain): any {
  const n = ++s.Laps;
  const def = lapDef(B, n);
  const out: any = { lap: n, kind: def.kind, ...(def.name ? { name: def.name } : {}) };
  // 의상 선택: 없는 의상이 남았으면 Picks 에, 모두 가졌으면 NoCostume(상자 3개)
  const costume = (): boolean => {
    if ((B.Costumes ?? []).some((c: any) => !costumeOwned(snap, c))) { s.Picks.push({ lap: n, kind: 'costume' }); return true; }
    for (const [id, c] of B.NoCostume ?? []) giveItem(snap, g, id, c);
    return false;
  };
  if (def.kind === 'car') {
    // 이미 최종 차량(max)이 있으면 주지 않는다 ('You never get something you already own, except .. a second GTS-T to fuse', 추정)
    out.got = hasCar(snap, Number(def.max ?? def.id)) ? [] : [{ kind: 'car', id: Number(def.id), count: 1, mailed: false }];
    if (out.got.length) giveCar(snap, g, Number(def.id));
    if (def.costume) costume();
  } else if (def.kind === 'costume') {
    if (!costume()) out.kind = 'items'; // 클라이언트: kind 'items' 면 69903 x3 표시
  } else if (def.kind === 'cosmetic') {
    out.got = (def.ids ?? []).filter((id: string) => giveCosmetic(snap, g, id, 'touge')).map((id: string) => ({ kind: 'cosmetic', id, count: 1 }));
    if (def.cars) out.cars = def.cars.filter((id: number) => !hasCar(snap, id)).map((id: number) => { giveCar(snap, g, id); return { id, mailed: false }; });
    if (def.costume) costume();
  } else if (def.kind === 'item') {
    out.got = (def.items ?? []).map(([id, c]: [number, number]) => { giveItem(snap, g, id, c); return { kind: 'item', id: Number(id), count: Number(c) }; });
    if (def.girl) out.girl = def.girl;
    if (def.also) out.also = def.also.map((id: string) => ({ id, owned: !giveCosmetic(snap, g, id, 'touge') }));
    if (def.costume) costume();
  } else {
    s.Picks.push({ lap: n, kind: 'after' }); // After 중 하나 선택
  }
  if (def.parts) {
    const miss = missingParts(snap, def.parts);
    for (const id of miss) giveItem(snap, g, id, 1);
    out.parts = miss;
    out.set = def.set ?? 'phantom';
  }
  if (def.bonus) { for (const [id, c] of def.bonus) giveItem(snap, g, id, c); out.bonus = def.bonus.map(([id, count]: [number, number]) => ({ id, count })); }
  if (def.kit) { const add = giveKit(snap, g, def.kit); if (add.length) out.kit = add; }
  if (def.awards) { s.Awards = [...new Set([...(s.Awards ?? []), ...def.awards])]; out.awards = def.awards; } // 칭호·프레임 보관 형식 미확인: 상태에만 둔다
  return out;
}

/** 한 걸음 이동 (주사위 또는 유령 부스트). 출발 칸을 지나거나 서면 바퀴 완주 */
function move(snap: any, B: any, s: TState, die: number, g: Gain, steps: any[], extra: any = {}): void {
  const N = B.Squares?.length || 40;
  const from = s.Pos;
  s.Pos = (from + die) % N;
  const step: any = { ...extra, die, from, to: s.Pos };
  const lap = from + die >= N ? completeLap(snap, B, s, g) : null;
  step.got = land(snap, B, s, g);
  if (lap) step.lap = lap;
  steps.push(step);
}

/** 모은 지급 -> RewardInfo (+ Cosmetics 바뀜 여부). Cosmetics.Version: 추가 1개당 +1, 천장 갱신 +1 (실기록 9->10 호박, 상자 굴림마다 +2) */
function finish(snap: any, g: Gain): { reward: any; cosChanged: boolean } {
  const items = [...g.entries];
  if (g.cash) items.push({ Itemtype: CASH, Count: g.cash, DeltaNum: g.cash });
  if (g.coin) items.push({ Itemtype: COIN, Count: g.coin, DeltaNum: g.coin });
  const reward: any = { Coin: g.coin, Charexp: 0, Cash: g.cash, Familiartity: 0, ItemInfo: items, CarInfo: g.cars };
  if (g.cos.length) reward.Cosmetics = g.cos;
  if (g.boxes) reward.BoxesOpened = g.boxes;
  const cosChanged = g.cosAdds > 0 || g.pity || g.kit;
  if (cosChanged) cosmeticsOf(snap).Version = (Number(snap.Cosmetics.Version) || 0) + g.cosAdds + (g.pity ? 1 : 0) + (g.kit ? 1 : 0);
  return { reward, cosChanged };
}
const extras = (snap: any, g: Gain, cosChanged: boolean) => ({
  ...(cosChanged ? { Cosmetics: snap.Cosmetics } : {}),
  ...(g.girl.length ? { UpdateData: { GirlItemInfo: g.girl } } : {}), // 클라이언트 #patch -> ApplyUpdateData -> ApplyGirlItemInfo
});

// ── 핸들러
register('LocalTougeBoardReq', (_body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const B = config()?.Board;
  if (!snap || !B || !isOpen(B)) return [{ name: 'LocalTougeBoardAns', body: { Seq: 1, Result: R_CLOSED } }];
  const fresh = !snap.touge;
  const board = boardOf(snap, B, ctx);
  if (fresh) ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'LocalTougeBoardAns', body: { Seq: 1, Result: R_OK, Board: board } }];
});

register('LocalTougeRollReq', (body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const B = config()?.Board;
  const ans = (b: any): Msg[] => [{ name: 'LocalTougeRollAns', body: { Seq: 1, ...b } }];
  const count = [1, 10].includes(Number(body?.Count)) ? Number(body.Count) : 0;
  if (!snap || !B || !isOpen(B) || !count) return ans({ Result: R_CLOSED });
  const s = stateOf(snap, B);
  const ui = snap.UserInfo;
  // 지불: 시험 모드 > 무료 주사위(10회는 10개 있을 때만, 추정) > Gold Cash (클라이언트 잔액 = min(GoldCash, Cash))
  let ticket = false, paid = 0;
  if (infinite(ctx)) { /* 무료 */ }
  else if (s.Tickets >= count) { s.Tickets -= count; ticket = true; }
  else {
    const price = Number(count === 1 ? B.Price?.One : B.Price?.Ten) || 0;
    const gold = Math.min(Number(ui.GoldCash) || 0, Number(ui.Cash) || 0);
    if (gold < price) return ans({ Result: R_NO_GOLD, UserInfo: ui });
    ui.GoldCash = (Number(ui.GoldCash) || 0) - price; // Gold Cash 는 Cash 의 일부로 본다 (추정)
    ui.Cash = (Number(ui.Cash) || 0) - price;
    paid = price;
  }
  const g = new Gain();
  const steps: any[] = [];
  // 보스 첫 승의 유령 부스트는 다음 굴림의 첫 걸음 (실기록 {ghost:true, die 2, from 18, to 20})
  if (s.Moves > 0) { const m = s.Moves; s.Moves = 0; move(snap, B, s, m, g, steps, { ghost: true }); }
  const faces: number[] = server().die ?? [1, 2, 3, 4, 5, 6];
  for (let i = 0; i < count; i++) {
    move(snap, B, s, tougeDice.roll(faces), g, steps);
    s.Rolls++;
    const rb = B.RollBonus;
    if (rb && !s.BonusGiven && s.Rolls >= Number(rb.rolls)) {
      // 실기록: 8번째 주사위 뒤 {rollBonus:true, die 0, from 22, to 22, name 'NSR+ ★5', got [{kind car, id 11705, count 1}]}
      s.BonusGiven = true;
      const got = (rb.items ?? []).map(([id, n]: [number, number]) => { giveItem(snap, g, id, n); return { kind: carDefOf(id) ? 'car' : 'item', id: Number(id), count: Number(n) }; });
      steps.push({ rollBonus: true, die: 0, from: s.Pos, to: s.Pos, name: rb.name, got });
    }
  }
  // 10회 굴림 보너스 호박 ('Ten rolls always bring one bonus pumpkin', 클라이언트 {bonus} 걸음)
  if (count === 10 && B.TenPumpkin) steps.push({ bonus: true, die: 0, from: s.Pos, to: s.Pos, got: drawPumpkin(snap, B, s, g) });
  const { reward, cosChanged } = finish(snap, g);
  ctx.store.putUser(ctx.session.accountId, snap);
  return ans({ Result: R_OK, Steps: steps, Paid: paid, Ticket: ticket, UserInfo: ui, RewardInfo: reward, ...extras(snap, g, cosChanged), Board: boardOf(snap, B, ctx) });
});

/** 골드 차량 상자 (After 'gold_box', 상점 79610 Gold Car Box 10+1): content.json boxOdds goldRates 별 등급으로 items 대,
 *  floorGrade 이상이 하나도 없으면 마지막 1대를 floorGrade 로 (추정) */
function goldBox(snap: any, g: Gain, storeItem: number): void {
  const odds = contentJson().boxOdds?.boxes?.[String(storeItem)] ?? {};
  const n = Number(odds.items) || 11;
  const stars: Record<string, number> = odds.goldRates?.stars ?? { 3: 0.935, 4: 0.06, 5: 0.005 };
  const floor = Number(odds.goldRates?.floorGrade) || 4;
  const grades: number[] = [];
  for (let i = 0; i < n; i++) {
    let r = Math.random() * Object.values(stars).reduce((a, x) => a + Number(x), 0), gr = Number(Object.keys(stars)[0]);
    for (const [k, w] of Object.entries(stars)) { r -= Number(w); if (r < 0) { gr = Number(k); break; } }
    grades.push(gr);
  }
  if (!grades.some((x) => x >= floor)) grades[n - 1] = floor;
  const cars: any[] = table('cars.json')?.Car ?? [];
  for (const gr of grades) {
    const def = pickOne(cars.filter((c: any) => Number(c.Grade) === gr && Number(c.Distribute) > 0));
    if (def) giveCar(snap, g, Number(def.Id));
  }
}

register('LocalTougePickReq', (body, ctx: Ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const B = config()?.Board;
  const ans = (b: any): Msg[] => [{ name: 'LocalTougePickAns', body: { Seq: 1, ...b } }];
  if (!snap || !B || !isOpen(B)) return ans({ Result: R_CLOSED });
  const s = stateOf(snap, B);
  const at = s.Picks.findIndex((p) => Number(p.lap) === Number(body?.Lap));
  if (at < 0) return ans({ Result: R_CLOSED, Board: boardOf(snap, B, ctx) });
  const pick = s.Picks[at];
  const choice = String(body?.Choice ?? '');
  const g = new Gain();
  let out: any;
  if (pick.kind === 'costume') {
    const c = (B.Costumes ?? []).find((x: any) => x.id === choice);
    if (!c || costumeOwned(snap, c)) return ans({ Result: R_CLOSED, Board: boardOf(snap, B, ctx) });
    for (const id of c.items ?? []) giveItem(snap, g, Number(id), 1);
    out = { costume: c.id };
  } else {
    const a = (B.After ?? []).find((x: any) => x.id === choice);
    if (!a) return ans({ Result: R_CLOSED, Board: boardOf(snap, B, ctx) });
    if (a.kind === 'box') {
      // 차고에 11대 자리가 있어야 한다 (상점 정의 CarSlotNeed, 'touge_no_room')
      const need = Number(storeRow(a.storeItem)?.CarSlotNeed) || 11;
      const free = (Number(snap.UserInfo?.GarageSize) || 0) - (snap.Cars?.CarInfo?.length ?? 0);
      if (free < need) return ans({ Result: R_NO_ROOM, Board: boardOf(snap, B, ctx) });
      goldBox(snap, g, Number(a.storeItem));
      out = { box: a.id };
    } else {
      for (const [id, n] of a.items ?? []) giveItem(snap, g, id, n); // 상자는 인벤토리로 (클라이언트: 69903 x3 칸 표시)
      out = { items: a.items };
    }
  }
  s.Picks.splice(at, 1);
  const { reward, cosChanged } = finish(snap, g);
  ctx.store.putUser(ctx.session.accountId, snap);
  return ans({ Result: R_OK, Pick: out, RewardInfo: reward, UserInfo: snap.UserInfo, ...extras(snap, g, cosChanged), Board: boardOf(snap, B, ctx) });
});

/** 이벤트 레이스 첫 승리 훅 (event.ts eventResult 가 레이스 State 를 바꾸기 전에 부른다).
 *  Tickets 설정의 스토리 레이스면 storyFirstWin, 보스면 bossFirstWin + 유령 이동 bossMove.
 *  반환: MsgNotifyEvent TougeTickets 본문 {Added, Tickets, Moves, Why} 또는 null.
 *  실기록(3103 보스 20 첫 승): {Added 1, Tickets 1, Moves 2, Why ['boss']}. Moves 는 남은 유령 이동 합계로 본다(추정), 스토리의 Why 'story' 추정. */
export function tougeRaceWin(snap: any, zoneId: number, raceIndex: number): any | null {
  const B = config()?.Board;
  const T = B?.Tickets;
  if (!B || !T || !isOpen(B) || Number(zoneId) !== ticketZone(B)) return null;
  const idx = Number(raceIndex);
  const boss = idx === Number(T.bossRace);
  if (!boss && !(T.storyRaces ?? []).map(Number).includes(idx)) return null;
  const s = stateOf(snap, B); // 처음이면 이미 이긴 레이스로 채운다 (지금 레이스는 아직 승리 비트 없음)
  if (s.Won.includes(idx)) return null;
  s.Won.push(idx);
  const add = Number(boss ? T.bossFirstWin : T.storyFirstWin) || 0;
  s.Tickets += add;
  if (boss) s.Moves += Number(T.bossMove) || 0;
  return { Added: add, Tickets: s.Tickets, Moves: s.Moves, Why: [boss ? 'boss' : 'story'] };
}
