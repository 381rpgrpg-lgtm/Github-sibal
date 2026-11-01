// 여러 핸들러가 쓰는 게임 계산. 근거는 각 함수 주석(클라이언트 코드 또는 실서버 기록).
import { readFileSync, existsSync } from 'node:fs';

const TABLES = new URL('../data/tables/', import.meta.url).pathname;
const cache: Record<string, any> = {};
export function table(name: string): any {
  if (!(name in cache)) cache[name] = existsSync(TABLES + name) ? JSON.parse(readFileSync(TABLES + name, 'utf8')) : null;
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

/** 친밀도 단계 1..4: girlTable FamiliaritySection1..3 누적 (400 / +230 / +1300). 기록 0->1, 440->2, 630->3. */
export function famLevel(girlId: number, fam: number): number {
  const d = girlDef(girlId) ?? {};
  let edge = 0, lv = 1;
  for (const s of [d.FamiliaritySection1 ?? 400, d.FamiliaritySection2 ?? 230, d.FamiliaritySection3 ?? 1300]) {
    edge += Number(s);
    if (fam >= edge) lv++; else break;
  }
  return Math.min(lv, 4);
}

/** 탑승 캐릭터 능력치 보너스 (클라이언트 passengerBonus / GetPassengerNormalBonusAvailable).
 *  조건: 친밀도 단계 2 이상, Emotion 1·2(화남) 아님, 캐릭터 Rarity <= 차량 Grade.
 *  값: [0, Attr0..Attr3][단계] 를 GirlAttrTable[AttrBias] 비율로 나눠 버림 (Acc, Drift, MaxSpd, Stability 순). AttrType 2 는 x 차량 레벨. */
export function passengerBonus(snap: any, car: any): Record<string, number> {
  const out: Record<string, number> = { AttribMaxSpd: 0, AttribAcc: 0, AttribStability: 0, AttribDrift: 0 };
  const gid = Number(snap.UserInfo?.PassengerGirl);
  const g = (snap.MyGirls?.MyGirlInfo ?? []).find((x: any) => Number(x.Girlid) === gid);
  const d = girlDef(gid);
  if (!g || !d || !car) return out;
  const lv = famLevel(gid, Number(g.Familiarity) || 0);
  if (lv < 2 || g.Emotion === 1 || g.Emotion === 2) return out;
  const carGrade = Number(car.Grade) || Number(carDefOf(car.Cartype)?.Grade) || 1;
  if (Number(d.Rarity) > carGrade) return out;
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
export function finalAttr(snap: any, car: any): Record<string, number> {
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
  return out;
}

/** 레이스 상대 난이도 표시 (RelativeDifficulty). 실기록: 내 최종 능력치 합 / 상대 합 1.53 -> 1, 1.24·1.20·1.14 -> 2.
 *  경계값은 추정 (1.3 이상 1, 1.0 이상 2, 그 아래 3). */
export function relativeDifficulty(mine: Record<string, number>, opp: any): number {
  const a = ATTRS.reduce((s, k) => s + (Number(mine[k]) || 0), 0);
  const b = ATTRS.reduce((s, k) => s + (Number(opp?.Attributes?.[k]) || 0), 0) || 1;
  const r = a / b;
  return r >= 1.3 ? 1 : r >= 1.0 ? 2 : 3;
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
    FuelConsume: 20, FuelConsume20404: 13, NthGeneration: 1, IsExhibited: false, ColorTable: d.ColorTable, ColorIndex: Number(d.ColorIndex) || 1,
    DecalIndex: -1, PlateName: '', CoatingSkill: 0, CoatingValue: 0, CoatingCount: 0, CoatingTime: 0, CoatingCoin: 8000,
    Grade: Number(d.Grade) || 1, CarName: '', IsLocked: false, ExpansionLevel: 0, CarExp: 0,
  };
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
    FuelConsume: grade >= 2 ? 25 : 20, FuelConsume20404: grade >= 2 ? 16 : 13, NthGeneration: 1, IsExhibited: false,
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
