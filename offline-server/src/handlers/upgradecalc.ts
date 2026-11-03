// 차량 강화 계산 (garage.ts 참고). 근거는 garage.ts 머리말의 실측 기록.
import { readFileSync, existsSync } from 'node:fs';

const TABLES = new URL('../../data/tables/', import.meta.url).pathname;
const load = (n: string) => (existsSync(TABLES + n) ? JSON.parse(readFileSync(TABLES + n, 'utf8')) : null);
let levels: any[] | null = null;
let cars: Map<number, any> | null = null;
let maxLevel = 10;
function init() {
  if (levels) return;
  levels = load('carLevelTable.json')?.CarLevels ?? [];
  cars = new Map((load('cars.json')?.Car ?? []).map((c: any) => [Number(c.Id), c]));
  const v = (load('vconstTable.json')?.Vconst ?? []).find((x: any) => x.Name === 'maxUpgradeLevel');
  if (v?.Val?.[0]) maxLevel = Number(v.Val[0]);
}
export function carDef(cartype: number) { init(); return cars!.get(Number(cartype)) ?? null; }
export function carLevelRow(grade: number, level: number) {
  init();
  return levels!.find((g: any) => Number(g.Grade) === grade)?.CarLevel?.find((l: any) => Number(l.Level) === level) ?? null;
}
// 대상 등급별 경험치 1당 코인. 실측: ★1 8, ★2 32.5. 그 위는 같은 비율(4.0625배)로 추정.
const COST_PER_EXP: Record<number, number> = { 1: 8, 2: 32.5 };
const costPerExp = (g: number) => COST_PER_EXP[g] ?? 32.5 * 4.0625 ** (g - 2);
const ATTRS = ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift'];

export function upgradePreview(snap: any, car: any, sources: any[]):
  { error: string } | { exp: number; cost: number; bonus: number; expected: any } {
  init();
  const list: any[] = snap.Cars?.CarInfo ?? [];
  const grade = Number(car.Grade) || Number(carDef(car.Cartype)?.Grade) || 1;
  const startLv = Number(car.UpgradeLevel) || 1;
  if (startLv >= maxLevel) return { error: '이미 최대 레벨' };
  let exp = 0, bonus = 0;
  for (const s of sources) {
    const src = list.find((c: any) => Number(c.Carid) === Number(s.Carid));
    if (!src) return { error: `재료 차량 없음 ${s.Carid}` };
    if (Number(src.Carid) === Number(car.Carid)) return { error: '대상 차량을 재료로 사용' };
    if (Number(src.Carid) === Number(snap.UserInfo?.Currentcar)) return { error: '현재 차량은 재료로 사용 불가' };
    if (src.IsLocked) return { error: '잠긴 차량은 재료로 사용 불가' };
    exp += Number(carLevelRow(Number(src.Grade) || 1, Number(src.UpgradeLevel) || 1)?.MaterialExp) || 0;
    bonus += 6 * 0.75 ** Math.max(0, grade - (Number(src.Grade) || 1));
  }
  if (!exp) return { error: '재료 없음' };
  let lv = startLv, carExp = (Number(car.CarExp) || 0) + exp;
  // 최대 레벨까지 실제로 쓰인 경험치만 비용에 넣는다 (실기록: ★2 Lv9 CarExp 18 + 재료 20 -> 필요 2 만큼 65 코인 = 650 x 2/20)
  let toMax = -(Number(car.CarExp) || 0);
  for (let l = startLv; l < maxLevel; l++) toMax += Number(carLevelRow(grade, l)?.CarExp) || 0;
  const usedExp = Math.min(exp, Math.max(0, toMax));
  while (lv < maxLevel) {
    const need = Number(carLevelRow(grade, lv)?.CarExp) || 0;
    if (!need || carExp < need) break;
    carExp -= need; lv++;
  }
  if (lv >= maxLevel) carExp = 0;
  const f = Number(carDef(car.Cartype)?.UpgradeFactor) || 2;
  const add = Math.floor(f * (lv - 1)) - Math.floor(f * (startLv - 1));
  const Attributes: any = { ...(car.Attributes ?? {}) };
  for (const k of ATTRS) Attributes[k] = (Number(Attributes[k]) || 0) + add;
  return {
    // 확률 보너스: 재료마다 6 x 0.75^(대상 등급 - 재료 등급). 실측 11건 (2026-11-01~02): ★1->★1 6, ★1->★2 4.5, ★2->★2 6,
    //   ★2 대상에 ★1+★2 = 10.5, ★1x2+★2x2 = 21. 재료가 대상보다 높은 등급일 때는 미확인(6 으로 둔다).
    exp, cost: Math.round(usedExp * costPerExp(grade)), bonus,
    expected: { UpgradeLevel: lv, CarExp: carExp, Attributes },
  };
}
