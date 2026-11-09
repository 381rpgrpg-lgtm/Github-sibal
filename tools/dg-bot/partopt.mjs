import { createRequire as __cr } from 'module'; const DGP = __cr(import.meta.url)('./paths.cjs');
// 한 차량의 최적 부품 조합 (오프라인 서버 gamecalc.finalAttr 가중 합 기준, 읽기 전용). node partopt.mjs <ud.json> <Carid> [가중치 파일]
//   가중치 파일(JSON [MaxSpd, Acc, Stability, Drift], 없으면 [1,1,1,1]): 2026-11-07 13-12 에서 합계 +63(가속 위주)은 효과 0,
//   앞서 최고속 +56 은 -0.09 초 -> 직선 위주 경주는 최고속 비중을 키워 실험한다.
//   후보: 장착 안 된 부품 + 그 차에 이미 단 부품 (다른 차에 단 부품은 건드리지 않음). 한 차에 같은 분류(Category)는 1개.
//   plan: 칸별로 끼울 부품. 이미 그 차에 있는 부품은 지금 칸에 그대로 두고, 나머지만 빈/교체 칸에 넣는다.
//   (2026-11-07: 봇이 빈 칸만 채워서 차 10 1번 칸에 ★3 이 남고 ★5 37001 이 창고에 있었다. 교체는 무료 — 실기록 2026-11-02)
import { readFileSync } from 'node:fs';
const { finalAttr } = await import(DGP.url('dist/gamecalc.js'));
const ud = JSON.parse(readFileSync(process.argv[2], 'utf8')); const carId = Number(process.argv[3]);
const PT = new Map(JSON.parse(readFileSync(DGP.srv('data/tables/parts.json'), 'utf8')).Part.map((p) => [p.Id, p]));
const car = ud.Cars.CarInfo.find((c) => c.Carid === carId);
if (!car) { console.log(JSON.stringify({ error: 'no car' })); process.exit(0); }
const slots = Number(car.SlotNum) || 1;
const all = (ud.Items?.ItemInfo ?? []).filter((i) => PT.has(i.Itemtype));
const pool = all.filter((i) => !(i.Equipcarid > 0) || i.Equipcarid === carId);
const W = (() => { try { const w = JSON.parse(readFileSync(process.argv[4], 'utf8')); if (Array.isArray(w) && w.length === 4) return w.map(Number); } catch {} return [1, 1, 1, 1]; })();
const KEYS = ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift'];
const sum = (a) => KEYS.reduce((x, k, j) => x + W[j] * (Number(a[k]) || 0), 0);
const withSet = (set) => ({ ...ud, Items: { ...ud.Items, ItemInfo: (ud.Items?.ItemInfo ?? []).map((i) => {
  const k = set.findIndex((s) => s.Itemid === i.Itemid);
  if (k >= 0) return { ...i, Equipcarid: carId, Equipindex: k + 1 };
  return i.Equipcarid === carId ? { ...i, Equipcarid: 0, Equipindex: 0 } : i;
}) } });
const curA = finalAttr(ud, car), curSum = sum(curA);
let best = { s: curSum, set: null };
const rec = (start, set, cats) => {
  if (set.length) { const s = sum(finalAttr(withSet(set), car)); if (s > best.s) best = { s, set: [...set] }; }
  if (set.length === slots) return;
  for (let k = start; k < pool.length; k++) {
    const c = PT.get(pool[k].Itemtype).Category; if (cats.has(c)) continue;
    set.push(pool[k]); cats.add(c); rec(k + 1, set, cats); set.pop(); cats.delete(c);
  }
};
rec(0, [], new Set());
const name = (i) => `${i.Itemtype}(★${PT.get(i.Itemtype).Grade})`;
const out = { car: carId, slots, weights: W, current: { sum: curSum, attr: curA, parts: all.filter((i) => i.Equipcarid === carId).sort((a, b) => a.Equipindex - b.Equipindex).map(name) } };
if (best.set) {
  const plan = new Array(slots).fill(null);
  for (const p of best.set) if (p.Equipcarid === carId && p.Equipindex >= 1 && p.Equipindex <= slots && !plan[p.Equipindex - 1]) plan[p.Equipindex - 1] = p;
  const rest = best.set.filter((p) => !plan.includes(p));
  for (let k = 0; k < slots && rest.length; k++) if (!plan[k]) plan[k] = rest.shift();
  out.best = { sum: best.s, attr: finalAttr(withSet(best.set), car), parts: best.set.map(name) };
  out.plan = plan.map((p, k) => (p ? { slot: k + 1, Itemid: p.Itemid, Itemtype: p.Itemtype, keep: p.Equipcarid === carId && p.Equipindex === k + 1 } : null)).filter(Boolean);
}
console.log(JSON.stringify(out));
