// 여러 핸들러가 쓰는 게임 계산. 근거는 각 함수 주석(클라이언트 코드 또는 실서버 기록).
import { readFileSync, existsSync } from 'node:fs';
import { readTable } from './upserts.js';

const TABLES = new URL('../data/tables/', import.meta.url).pathname;
const cache: Record<string, any> = {};
export function table(name: string): any {
  if (!(name in cache)) cache[name] = readTable(TABLES + name, name); // content.json 표 패치 적용 (upserts.ts)
  return cache[name];
}
let maps: { girls: Map<number, any>; cars: Map<number, any>; parts: Map<number, any>; areas: Map<number, any>; attr: Map<number, any> } | null = null;
function m() {
  if (maps) return maps;
  maps = {
    girls: new Map((table('girlTable.json')?.Girl ?? []).map((g: any) => [Number(g.Id), g])),
    cars: new Map((table('cars.json')?.Car ?? []).map((c: any) => [Number(c.Id), c])),
    parts: new Map((table('parts.json')?.Part ?? []).map((p: any) => [Number(p.Id), p])),
    areas: new Map((table('battleTable.json')?.BattleArea ?? []).map((a: any) => [Number(a.Id), a])),
    attr: new Map((table('vconstTable.json')?.GirlAttrTable?.GirlAttr ?? []).map((a: any) => [Number(a.AttrType), a])),
  };
  return maps;
}
export const girlDef = (id: number) => m().girls.get(Number(id)) ?? null;
let carNames: Map<string, string> | null = null;
/** 차량 표시 이름 (carNames.json: name_<차종> -> 'TINY' 등). 실기록 RewardInfo.CarInfo.CarName. */
export function carName(cartype: number): string {
  if (!carNames) carNames = new Map((table('carNames.json')?.CarName ?? []).map((x: any) => [String(x.Id), String(x.Name)]));
  return carNames.get(`name_${cartype}`) ?? '';
}
export const carDefOf = (id: number) => m().cars.get(Number(id)) ?? null;
export const partDef = (id: number) => m().parts.get(Number(id)) ?? null;
/** 존 번호(RaceZone.ZoneId) -> battleTable BattleArea (Id 50000+존) */
export const areaOf = (zoneId: number) => m().areas.get(50000 + Number(zoneId)) ?? null;
export const areaRace = (zoneId: number, raceIndex: number) =>
  (areaOf(zoneId)?.Race ?? []).find((r: any) => Number(r.RaceIndex) === Number(raceIndex)) ?? null;

export const ATTRS = ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift'] as const;

/** 현재 등급의 캐릭터 표 행. 한계 돌파로 Rarity 가 기본 행보다 높으면 girlTable Id = (TransGirlid || Girlid) x 10 + Rarity 행
 *  (예 20302 Rarity 2 -> 203022: FamiliaritySection 789/4263/947, 기본 행 500/2700/600). 그 행이 없으면 기본 행.
 *  실기록 근거: 20302 Rarity 2 호감도 958~4412 에서 NextCoin 400 (= 단계 2) -> 기본 행 경계(3200)가 아니라 203022 경계(5052). */
export function girlRow(girlId: number, rarity?: number, transId?: number): any {
  const id = Number(transId) > 0 ? Number(transId) : Number(girlId);
  const base = girlDef(id);
  const r = Number(rarity) || 0;
  if (!base || !r || r === Number(base.Rarity)) return base;
  return girlDef(id * 10 + r) ?? base;
}
/** 내 캐릭터 레코드(MyGirlInfo)의 현재 등급 행 */
export const myGirlRow = (g: any) => girlRow(Number(g?.Girlid), Number(g?.Rarity) || 0, Number(g?.TransGirlid) || 0);

/** 친밀도 단계 1..4: 현재 등급 행의 FamiliaritySection1..3 누적 (기본값 400 / +230 / +1300). 기록 0->1, 440->2, 630->3.
 *  rarity 를 주면 한계 돌파 행(girlRow)을 쓴다. */
export function famLevel(girlId: number, fam: number, rarity?: number): number {
  const d = girlRow(girlId, rarity) ?? {};
  let edge = 0, lv = 1;
  for (const s of [d.FamiliaritySection1 ?? 400, d.FamiliaritySection2 ?? 230, d.FamiliaritySection3 ?? 1300]) {
    edge += Number(s);
    if (fam >= edge) lv++; else break;
  }
  return Math.min(lv, 4);
}
/** 내 캐릭터 레코드의 친밀도 단계 (현재 Rarity 행 기준) */
export const girlFamLevel = (g: any) => famLevel(Number(g?.Girlid), Number(g?.Familiarity) || 0, Number(g?.Rarity) || 0);
/** 호감도 최대치 = 현재 등급 행 FamiliaritySection1~3 합 (예 20208: 700+1400+3400 = 5500). 한계 돌파 행 사용은 추정. */
export function girlFamMax(girlId: number, rarity?: number): number {
  const d = girlRow(girlId, rarity) ?? {};
  return (Number(d.FamiliaritySection1) || 0) + (Number(d.FamiliaritySection2) || 0) + (Number(d.FamiliaritySection3) || 0);
}

/** 캐릭터 NextCoin = 100 x Rarity x 친밀도 단계 (현재 등급 행). 실기록 2026-11-12 집계: 서로 다른 (캐릭터, Rarity, 호감도, NextCoin)
 *  2,019건 모두 일치 (예 20201 Rarity 5 단계 4 -> 2000, 20505 Rarity 4 -> 400/800/1200/1600, 20302 Rarity 2 호감도 4212 -> 400).
 *  예전 식 100 x (단계 + Rarity - 1) 은 369건만 맞았다. 친밀도가 바뀔 때마다 맞춘다. */
export function syncGirl(g: any) {
  if (!g || !g.Girlid) return;
  const rarity = Number(g.Rarity) || Number(girlDef(Number(g.Girlid))?.Rarity) || 1;
  g.NextCoin = 100 * rarity * famLevel(Number(g.Girlid), Number(g.Familiarity) || 0, rarity);
}

/** 탑승 캐릭터 능력치 보너스 (클라이언트 passengerBonus / GetPassengerNormalBonusAvailable).
 *  조건: 친밀도 단계 2 이상, Emotion 1·2(화남) 아님, 캐릭터 Rarity <= 차량 Grade.
 *  값: [0, Attr0..Attr3][단계] 를 GirlAttrTable[AttrBias] 비율로 나눠 버림 (Acc, Drift, MaxSpd, Stability 순). AttrType 2 는 x 차량 레벨. */
export function passengerBonus(snap: any, car: any): Record<string, number> {
  const out: Record<string, number> = { AttribMaxSpd: 0, AttribAcc: 0, AttribStability: 0, AttribDrift: 0 };
  const gid = Number(snap.UserInfo?.PassengerGirl);
  const g = (snap.MyGirls?.MyGirlInfo ?? []).find((x: any) => Number(x.Girlid) === gid);
  const row0 = girlDef(Number(g?.TransGirlid) > 0 ? Number(g.TransGirlid) : gid);
  if (!g || !row0 || !car) return out;
  // 클라이언트 GetPassengerNormalBonusAvailable / GetPassengerBonus: 한계 돌파한 캐릭터(Rarity > 기본 행 Rarity)는 단계 1 이어도 보너스,
  //   등급 비교는 기본 행 Rarity <= 차량 Grade, 보너스 값은 max(기본 Rarity, 현재 Rarity) 등급 행의 Attr0..3.
  const lv = girlFamLevel(g);
  const expanded = (Number(g.Rarity) || 0) > Number(row0.Rarity);
  if ((!expanded && lv < 2) || g.Emotion === 1 || g.Emotion === 2) return out;
  const carGrade = Number(car.Grade) || Number(carDefOf(car.Cartype)?.Grade) || 1;
  if (Number(row0.Rarity) > carGrade) return out;
  const d = girlRow(gid, Math.max(Number(row0.Rarity) || 0, Number(g.Rarity) || 0), Number(g.TransGirlid) || 0) ?? row0;
  const bias = m().attr.get(Number(d.AttrBias))?.AttrBias;
  if (!bias) return out;
  const base = [0, d.Attr0, d.Attr1, d.Attr2, d.Attr3][lv] || 0;
  const mul = Number(d.AttrType) !== 2 ? 1 : Number(car.UpgradeLevel) || 1;
  const share = (i: number) => Math.trunc(base * bias[i]) * mul;
  out.AttribAcc = share(0); out.AttribDrift = share(1); out.AttribMaxSpd = share(2); out.AttribStability = share(3);
  return out;
}

/** 레이스 시작 응답의 MyCarInfo.FinalAttr = 차량 + 숙련도 + 장착 부품 + CarEffect + 탑승 캐릭터 보너스
 *  (클라이언트 GetCarTotalAttribute. 2026-11-01 실기록 2-12: {147,148,175,155} 정확히 일치) */
export function finalAttr(snap: any, car: any, opts: { room?: boolean } = {}): Record<string, number> {
  const out: Record<string, number> = { AttribMaxSpd: 0, AttribAcc: 0, AttribStability: 0, AttribDrift: 0 };
  const add = (a: any) => { if (a) for (const k of ATTRS) out[k] += Number(a[k]) || 0; };
  add(car.Attributes); add(car.MasteryAttr);
  const seen = new Set<number>();
  for (const it of snap.Items?.ItemInfo ?? []) {
    if (Number(it.Equipcarid) === Number(car.Carid) && Number(it.Equipindex) > 0 && !seen.has(Number(it.Equipindex))) {
      seen.add(Number(it.Equipindex)); add(it.Attributes);
    }
  }
  for (const e of car.CarEffect ?? []) add(e.EAttr);
  add(passengerBonus(snap, car));
  const room = opts.room ? girlRoomBonus(snap) : 0;
  if (room) for (const k of ATTRS) out[k] += room;
  return out;
}

/** 탑승 캐릭터 방 보너스: 탑승 캐릭터에게 TrueHeroineRoom 기억(girlMemoryTable 3019 등)이 있으면 네 능력치 모두 + vconst girlRoomBonus (32).
 *  실기록 2026-11-12 레이스 시작 재생: 20202 (방 있음, 한계 돌파 아님) 8/8건, 20302 (방 있음, 돌파) 33/33건이 네 능력치 모두 정확히 +32 모자랐고,
 *  방 없는 20201 은 일치. 주간 레이스(RaceType 3) 시작 1건은 +32 없이 일치 -> 스토리 레이스(battle.ts)만 opts.room.
 *  이벤트·월드 투어·대전 레이스와, 탑승 보너스가 꺼진 조건(단계·기분)에서도 붙는지는 미확인. */
export function girlRoomBonus(snap: any): number {
  const gid = Number(snap?.UserInfo?.PassengerGirl);
  if (!(gid > 0)) return 0;
  const mem = (snap.GirlMemorySet?.GirlMemory ?? []).find((x: any) => Number(x.Girlid) === gid)?.Memory ?? [];
  if (!mem.some((m: any) => m.MemoryName === 'TrueHeroineRoom')) return 0;
  const v = (table('vconstTable.json')?.Vconst ?? []).find((x: any) => x.Name === 'girlRoomBonus');
  return Number(v?.Dval) || 0;
}

/** 부품 세트 효과 -> car.CarEffect (EType 4). 실데이터 2026-11-05 10604 (세트 3 부품 37201·37204·37202 장착):
 *   CarEffect [{EType 4, ESet 2, EId 3, EAttr {MaxSpd 5, Stab 5}}, {EType 4, ESet 3, EId 3, EAttr {Acc 15, Drift 15}}]
 *   = parts.json SetEffects[Setid].SetEffectValueN x SetEffectType[SetEffectN] 가중치 (세트 3: 2개 10 x 0.5, 3개 30 x 0.5). 2·3·4개 단계 누적.
 *   finalAttr 는 CarEffect 를 더한다. 추정: 소수는 버림, 차종 제한 추가 효과(CarLimitFlag·CarEffect 필드)는 미반영, EType 4 외 효과는 그대로 둔다. */
export function applySetEffects(snap: any, car: any): void {
  if (!car) return;
  const pt = table('parts.json') ?? {};
  const count = new Map<number, number>();
  for (const it of snap.Items?.ItemInfo ?? []) {
    if (Number(it.Equipcarid) !== Number(car.Carid) || !(Number(it.Equipindex) > 0)) continue;
    const sid = Number(partDef(it.Itemtype)?.Setid) || 0;
    if (sid) count.set(sid, (count.get(sid) ?? 0) + 1);
  }
  const effects: any[] = [];
  for (const [sid, n] of count) {
    const se = (pt.SetEffects ?? []).find((x: any) => Number(x.Setid) === sid);
    for (const k of [2, 3, 4]) {
      if (n < k || !se?.['SetEffect' + k]) continue;
      const ty = (pt.SetEffectType ?? []).find((x: any) => Number(x.Id) === Number(se['SetEffect' + k])) ?? {};
      const v = Number(se['SetEffectValue' + k]) || 0;
      const EAttr: any = {};
      for (const a of ATTRS) EAttr[a] = Math.floor(v * (Number(ty[a]) || 0));
      effects.push({ EType: 4, ESet: k, EId: sid, EAttr });
    }
  }
  const others = (car.CarEffect ?? []).filter((e: any) => Number(e.EType) !== 4);
  if (effects.length || car.CarEffect) car.CarEffect = [...others, ...effects];
}

/** 레이스 상대 난이도 표시 (RelativeDifficulty). 실기록: 내 최종 능력치 합 / 상대 합 1.53 -> 1, 1.29·1.24·1.20·1.14·1.088 -> 2,
 *  1.075·1.0·0.956 -> 3, 0.917·0.85·0.83·0.784 -> 4, 0.730·0.709·0.69~0.54 -> 5 (2026-11-02 봇 기록 26건 추가).
 *  경계값은 그 사이에서 추정 (1.3 이상 1, 1.08 이상 2, 0.94 이상 3, 0.75 이상 4, 그 아래 5). */
export function relativeDifficulty(mine: Record<string, number>, opp: any): number {
  const a = ATTRS.reduce((s, k) => s + (Number(mine[k]) || 0), 0);
  const b = ATTRS.reduce((s, k) => s + (Number(opp?.Attributes?.[k]) || 0), 0) || 1;
  const r = a / b;
  return r >= 1.3 ? 1 : r >= 1.08 ? 2 : r >= 0.94 ? 3 : r >= 0.75 ? 4 : 5;
}

/** 레이스 상대 차량: 차량 기본 능력치를 battleTable Opponent.Difficulty 합계에 맞춰 늘린다.
 *  (실기록 6건: 상대 능력치 합 = Difficulty, 예 3-25 11002 기본 532 -> 597)
 *  차종: battleCars ShowProb 가중 무작위 (추정: 실서버의 차종 선택 규칙은 미확인). */
export function makeOpponent(difficulty: number, cartype?: number): any {
  let type = cartype;
  if (!type) {
    const list: any[] = (table('battleCars.json')?.BattleCar ?? []).filter((x: any) => carDefOf(x.CarId) && Number(x.ShowProb) > 0);
    const total = list.reduce((s, x) => s + Number(x.ShowProb), 0);
    let r = Math.random() * total;
    type = Number((list.find((x) => (r -= Number(x.ShowProb)) < 0) ?? list[0])?.CarId) || 10101;
  }
  const d = carDefOf(type) ?? {};
  const base = d.Attributes ?? { AttribMaxSpd: 100, AttribAcc: 100, AttribStability: 100, AttribDrift: 100 };
  const sum = ATTRS.reduce((s, k) => s + (Number(base[k]) || 0), 0) || 1;
  const Attributes: any = {};
  for (const k of ATTRS) Attributes[k] = Math.round((Number(base[k]) || 0) * difficulty / sum);
  return {
    Carid: 0, Cartype: type, ItemInfo: [], UpgradeLevel: 1, SlotNum: 1, Mastery: 0, Price: Number(d.SellPrice) || 100,
    Attributes, MasteryCapacity: Number(d.SoftLimit) || 40, MasteryAttr: { AttribMaxSpd: 0, AttribAcc: 0, AttribStability: 0, AttribDrift: 0 },
    ...carFuel(Number(d.Grade) || 1), NthGeneration: 1, IsExhibited: false, ColorTable: d.ColorTable, ColorIndex: Number(d.ColorIndex) || 1,
    DecalIndex: -1, PlateName: '', CoatingSkill: 0, CoatingValue: 0, CoatingCount: 0, CoatingTime: 0, CoatingCoin: 8000,
    Grade: Number(d.Grade) || 1, CarName: '', IsLocked: false, ExpansionLevel: 0, CarExp: 0,
  };
}

/** 차량 연료 소모: 15 + 5 x cars.json 기본 등급, FuelConsume20404 = floor(x 2/3).
 *  실기록 전체(2026-11-11 집계): 기본 ★1 20/13 · ★2 25/16 · ★3 30/20 · ★4 35/23 · ★5 40/26 · ★6 45/30.
 *  한계 돌파로 Grade 가 올라도 연료는 기본 등급 기준 (10201·10401 Grade 2 인데 20/13). 14-15 첫 보상 10303 = 30/20. */
export function carFuel(baseGrade: number): { FuelConsume: number; FuelConsume20404: number } {
  const fc = 15 + 5 * Math.max(1, Math.min(6, Number(baseGrade) || 1));
  return { FuelConsume: fc, FuelConsume20404: Math.floor((fc * 2) / 3) };
}

/** 보유 차량 레코드 신규 생성 (cars.json 정의 기준, 형식은 실기록 RewardInfo.CarInfo) */
export function newOwnedCar(snap: any, cartype: number): any {
  const d = carDefOf(cartype) ?? {};
  const carid = (snap.Cars?.CarInfo ?? []).reduce((mx: number, c: any) => Math.max(mx, Number(c.Carid) || 0), 0) + 1;
  const grade = Number(d.Grade) || 1;
  return {
    Carid: carid, Cartype: cartype, ItemInfo: [], UpgradeLevel: 1, SlotNum: Number(d.SlotInit) || 1, Mastery: 0,
    Price: Number(d.SellPrice) || 100, Attributes: { ...(d.Attributes ?? {}) }, MasteryCapacity: Number(d.SoftLimit) || 40,
    MasteryAttr: { AttribMaxSpd: 0, AttribAcc: 0, AttribStability: 0, AttribDrift: 0 },
    ...carFuel(grade), NthGeneration: 1, IsExhibited: false,
    ColorTable: d.ColorTable, ColorIndex: Number(d.ColorIndex) || 1, DecalIndex: -1, PlateName: '',
    CoatingSkill: 0, CoatingValue: 0, CoatingCount: 0, CoatingTime: 0, CoatingCoin: 8000,
    Grade: grade, CarName: carName(cartype), IsLocked: false, ExpansionLevel: 0, CarExp: 0,
  };
}

/** 무작위 부품 (그 등급, Distribute 1) — 상자 보상용 */
export function randomPart(grade: number): any | null {
  const pool = [...m().parts.values()].filter((p: any) => Number(p.Grade) === grade && Number(p.Distribute) === 1);
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}
export function grantPart(snap: any, def: any): any {
  snap.Items ??= { ItemInfo: [] };
  const itemid = (snap.Items.ItemInfo ?? []).reduce((mx: number, it: any) => Math.max(mx, Number(it.Itemid) || 0), 0) + 1;
  const part = { Itemid: itemid, Itemtype: Number(def.Id), Count: 1, Equipcarid: 0, Equipindex: 0,
    Attributes: { ...def.Attributes }, ItemLevel: 1, ItemExp: 0, Category: Number(def.Category) };
  snap.Items.ItemInfo.push(part);
  return part;
}
