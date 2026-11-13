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
// 대상 등급별 경험치 1당 코인. 실측: ★1 8, ★2 32.5, ★3 50.25 (2026-11-05 10203 강화 8건: 20 -> 1005, 10 -> 502, 120 -> 6030),
//   ★4 72.125, ★5 178.1875, 비용 = floor(쓰인 경험치 x 단가). 실측 강화 조회 126가지 조합 (2026-11-01~13) 모두 일치:
//   ★3 10 -> 502, ★4 10 -> 721, 39 -> 2812, 60 -> 4327, 160 -> 11540, ★5 10 -> 1781, 20 -> 3563, 40 -> 7127, 620 -> 110476.
//   ★6 은 ★4->★5 비율(2.4705배)로 추정. (예전: ★4 72.1 반올림, ★5 추정 103.5 는 42% 낮았다)
const COST_PER_EXP: Record<number, number> = { 1: 8, 2: 32.5, 3: 50.25, 4: 72.125, 5: 178.1875 };
const costPerExp = (g: number) => COST_PER_EXP[g] ?? 178.1875 * (178.1875 / 72.125) ** (g - 5);
// 확률 보너스(= 대성공 확률 %, 재료마다 더함): 6 x 등급 차 배율 x 레벨 배율. 실측 강화 조회 63가지 조합 (2026-11-01~13):
//   등급 차(대상 - 재료) 0 -> 6, 1 -> 4.5, 2 -> 3, 3 이상 -> 1.2 (★1->★4, ★2->★5, ★1->★5 모두 1.2).
//   재료 레벨 L: x (1 + (L-1) x 25/27) [추정, 표본 2개: ★2 Lv2 -> ★4 5.8, ★3 Lv10 x2 -> ★5 56]. 0.1 단위 반올림.
//   재료가 대상보다 높은 등급이면 미확인 (6).
const GRADE_DIFF_F = [1, 0.75, 0.5, 0.2];
export function materialBonus(targetGrade: number, matGrade: number, matLevel: number): number {
  const d = targetGrade - matGrade;
  const f = d <= 0 ? 1 : GRADE_DIFF_F[Math.min(d, 3)];
  return 6 * f * (1 + (Math.max(1, matLevel) - 1) * 25 / 27);
}
const ATTRS = ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift'];

/** bonusExp: 대성공으로 더 받는 경험치(비용 없음). 실기록 2026-11-08 ★5 Lv3 CarExp 60 + 재료 620 + 대성공 310 -> Lv9 CarExp 30 */
export function upgradePreview(snap: any, car: any, sources: any[], bonusExp = 0):
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
    bonus += materialBonus(grade, Number(src.Grade) || 1, Number(src.UpgradeLevel) || 1);
  }
  if (!exp) return { error: '재료 없음' };
  let lv = startLv, carExp = (Number(car.CarExp) || 0) + exp + bonusExp;
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
    exp, cost: Math.floor(usedExp * costPerExp(grade) + 1e-9), bonus: Math.round(bonus * 10) / 10,
    expected: { UpgradeLevel: lv, CarExp: carExp, Attributes },
  };
}
