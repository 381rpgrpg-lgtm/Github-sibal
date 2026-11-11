// 차고: 차량 강화. 형식은 실서버 기록(data/recorded, 2026-11-01)을 따른다.
//
// MsgUpgradeCarReq {TargetCarInfo:{Carid}, SourceCarInfo?:[{Carid}]}
//  - 튜토리얼 강화(재료 없음, Completion 에 ReinforceCar(8192) 비트가 없을 때) — 기록:
//      Result 1, UpgradeSuccess true, ResultCarInfo(UpgradeLevel 1 -> 2, Attributes 각 +2, CarExp 0),
//      NormalDeltaExp 10(= carLevelTable 해당 등급·레벨 CarExp), BonusDeltaExp 0, RemovedCarInfo [], RemovedPartsInfo [],
//      UserInfo(Completion |= 8192, 코인 차감 없음), PropertySet(DQUEST_PARTSUP 1)
//  - 재료 없이 다시 요청 — 기록: {Seq, Result 2, UserInfo}
//  - 재료 차량 강화 (실서버 실측 2026-11-01, MsgUpgradeInfoReq 5건 + MsgUpgradeCarReq 2건):
//      경험치 = 재료마다 carLevelTable[재료 등급][재료 레벨].MaterialExp 합 (★1 Lv1 10, ★2 Lv1 20, ★1 Lv3 28)
//      레벨업: CarExp 가 대상 등급의 CarExp(레벨당 필요치) 이상이면 레벨 +1, 최대 maxUpgradeLevel(10)
//      능력치 = 기존 + floor(UpgradeFactor x (새레벨-1)) - floor(UpgradeFactor x (옛레벨-1))   (TOFU 3.139: Lv1->3 각 +6)
//      비용 = 경험치 x 대상 등급 단가 (★1 8코인, ★2 32.5코인. 실측 80/160/240, 650/1560)
//      ChanceupBonus.CarLevelBonus = 재료당 6, SuccessChance 100, 재료 차량 삭제(RemovedCarInfo [{Carid}])
//  - MsgUpgradeInfoReq: 같은 계산의 예상치 {Result 1, SuccessChance, ChanceupBonus, Cost, ExpectedCarInfo}
//  - MsgSetCurrentCarReq {CarInfo:{Carid}} -> {Seq, Result 1, UserInfo}
// 추정(실측 없음): ★3 이상 대상의 단가(★1·★2 비율 4.06 배씩 증가로 가정), 재료 차량에 장착된 부품 처리(함께 삭제),
//   최대 레벨에서 남는 경험치(버림).
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg } from '../rpc.js';
import { bumpProperty, addMastery } from './battle.js';
import { questEvent } from '../quests.js';
import { carLevelRow, carDef, upgradePreview } from './upgradecalc.js';

const TUT_REINFORCE_CAR = 8192;
const R_OK = 1, R_FAIL = 2;
const ATTRS = ['AttribMaxSpd', 'AttribAcc', 'AttribStability', 'AttribDrift'];
const TABLES = new URL('../../data/tables/', import.meta.url).pathname;

let carLevels: any[] | null = null;
function levelExp(grade: number, level: number): number {
  if (!carLevels) carLevels = existsSync(TABLES + 'carLevelTable.json')
    ? JSON.parse(readFileSync(TABLES + 'carLevelTable.json', 'utf8')).CarLevels ?? [] : [];
  const g = carLevels!.find((x: any) => Number(x.Grade) === grade);
  return Number(g?.CarLevel?.find((x: any) => Number(x.Level) === level)?.CarExp) || 0;
}

register('MsgUpgradeCarReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const ui = snap?.UserInfo;
  const fail = (why: string): Msg[] => {
    console.warn(`[garage] 강화 거절: ${why}`);
    return [{ name: 'MsgUpgradeCarAns', body: { Seq: 1, Result: R_FAIL, ...(ui ? { UserInfo: ui } : {}) } }];
  };
  if (!snap) return fail('계정 없음');
  const car = (snap.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(body?.TargetCarInfo?.Carid));
  if (!car) return fail('대상 차량 없음');
  const sources: any[] = body?.SourceCarInfo ?? [];
  if (sources.length) {
    const pv = upgradePreview(snap, car, sources);
    if ('error' in pv) return fail(pv.error);
    // 재료 등급 하한 (실기록 2026-11-05): ★5 대상 + ★1 재료 -> Result 2 (같은 ★1 차량이 ★4 대상에는 성공, ★5 대상에 ★2 재료는 성공).
    //   강화 정보(MsgUpgradeInfoReq)는 같은 조합에도 Result 1 이었다. 추정: 등급 차 3 초과면 거절
    const tg = Number(car.Grade) || 1;
    const low = sources.map((x: any) => (snap.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(x.Carid)))
      .find((c: any) => c && tg - (Number(c.Grade) || 1) > 3);
    if (low) return fail(`재료 등급 너무 낮음 (★${low.Grade} -> ★${tg})`);
    if ((Number(ui.Coin) || 0) < pv.cost) return [{ name: 'MsgUpgradeCarAns', body: { Seq: 1, Result: 3, UserInfo: ui } }];
    ui.Coin -= pv.cost;
    Object.assign(car, pv.expected);
    const ids = new Set(sources.map((x: any) => Number(x.Carid)));
    snap.Cars.CarInfo = snap.Cars.CarInfo.filter((c: any) => !ids.has(Number(c.Carid)));
    const removedParts = (snap.Items?.ItemInfo ?? []).filter((it: any) => ids.has(Number(it.Equipcarid)));
    if (removedParts.length) snap.Items.ItemInfo = snap.Items.ItemInfo.filter((it: any) => !removedParts.includes(it));
    const propChanged = bumpProperty(snap, 'DQUEST_PARTSUP', 1);
    questEvent(snap, 17, () => true); // 퀘스트: 차량 n회 강화
    ctx.store.putUser(ctx.session.accountId, snap);
    return [{ name: 'MsgUpgradeCarAns', body: {
      Seq: 1, Result: R_OK, UpgradeSuccess: true, ResultCarInfo: { ...car } /* CarEffect 는 원래 있는 차만 (실기록: 코인 상자 차량은 키 없음) */, UserInfo: ui,
      RemovedCarInfo: [...ids].map((Carid) => ({ Carid })), RemovedPartsInfo: removedParts.map((p: any) => ({ Itemid: p.Itemid })),
      NormalDeltaExp: pv.exp, BonusDeltaExp: 0,
      // PropertySet 은 일일 미션 값이 바뀐 때만 (실기록 2026-11-02: 그날 첫 강화에만 있음)
      ...(propChanged ? { PropertySet: snap.PropertySet } : {}),
    } }];
  }
  if (Number(ui.Completion) & TUT_REINFORCE_CAR) return fail('재료 없음 (튜토리얼 강화는 이미 완료)');

  // 튜토리얼 강화
  const deltaExp = levelExp(Number(car.Grade) || 1, Number(car.UpgradeLevel) || 1);
  car.UpgradeLevel = (Number(car.UpgradeLevel) || 1) + 1;
  car.CarExp = 0;
  car.Attributes ??= {};
  for (const k of ATTRS) car.Attributes[k] = (Number(car.Attributes[k]) || 0) + 2;
  ui.Completion = Number(ui.Completion) | TUT_REINFORCE_CAR;
  const propChanged = bumpProperty(snap, 'DQUEST_PARTSUP', 1); // 일일 미션 '차량·부품 강화 1회' (기록 0 -> 1)
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgUpgradeCarAns',
    body: {
      Seq: 1, Result: R_OK, UpgradeSuccess: true, ResultCarInfo: car, UserInfo: ui,
      RemovedCarInfo: [], RemovedPartsInfo: [], NormalDeltaExp: deltaExp, BonusDeltaExp: 0,
      ...(propChanged ? { PropertySet: snap.PropertySet } : {}),
    },
  }];
});

register('MsgUpgradeInfoReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = (snap?.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(body?.TargetCarInfo?.Carid));
  if (!snap || !car) return [{ name: 'MsgUpgradeInfoAns', body: { Seq: 1, Result: R_FAIL } }];
  const pv = upgradePreview(snap, car, body?.SourceCarInfo ?? []);
  if ('error' in pv) {
    console.warn(`[garage] 강화 조회 거절: ${pv.error}`);
    // 실기록 2026-11-02 (37건): 대상이 이미 최대 레벨이면 {Seq, Result 101} 만 온다
    if (pv.error === '이미 최대 레벨') return [{ name: 'MsgUpgradeInfoAns', body: { Seq: 1, Result: 101 } }];
    return [{ name: 'MsgUpgradeInfoAns', body: { Seq: 1, Result: R_FAIL } }];
  }
  return [{ name: 'MsgUpgradeInfoAns', body: {
    Seq: 1, Result: 1, SuccessChance: 100, ChanceupBonus: { CarLevelBonus: pv.bonus, TotalBonus: pv.bonus },
    Cost: { Coin: pv.cost }, ExpectedCarInfo: { ...car, ...pv.expected },
  } }];
});

register('MsgSetCurrentCarReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = (snap?.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(body?.CarInfo?.Carid));
  if (!snap || !car) return [{ name: 'MsgSetCurrentCarAns', body: { Seq: 1, Result: R_FAIL } }];
  snap.UserInfo.Currentcar = Number(car.Carid);
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgSetCurrentCarAns', body: { Seq: 1, Result: 1, UserInfo: snap.UserInfo } }];
});

// ── 숙련도 한계 돌파 MsgMasteryExpandReq {CarInfo:{Carid}, ExpansionCash: n}
//   실기록 2026-11-03 (TOFU 10602 ★2 Lv10, 숙련도 72/72): -> {Seq, Result 1, CarInfo(MasteryCapacity 72 -> 135, ExpansionLevel 0 -> 1),
//   UserInfo, ItemInfo [{Itemid, Itemtype 61006(차량 부품), Count, StackNum}]}. 비용 n = 차량 부품 개수(캐시가 아님: 캐시 그대로, 61006 53 -> 25).
//   늘어나는 양 = cars.json Expansion (10602 = 63). 비용 n 은 클라이언트가 계산해 보낸 값을 쓴다(서버 쪽 비용표 미확인).
//   추정: 한 번만 가능(ExpansionLevel 1 이면 거절), 부품이 모자라면 Result 2.
//   실기록 2026-11-03 (TOFU++ 10604 ★4, 178/178): 요청 ExpansionCash 28 인데 부품 206 -> 170 (36 소모), MasteryCapacity 178 -> 306 (Expansion 128).
//   즉 실제 비용은 서버가 정한다. 비용 = cars.json ExpCash (★2 10602 28, ★4 10604 36, ★5 11705 53 = 실기록 2026-11-08 부품 199 -> 146).
//   실측 2026-11-08 ★5 11705 (Lv3, 268/268): MasteryCapacity 268 -> 415 (Expansion 147), 캐시 그대로.
//   여러 번 가능 (cars.json ExpCount, 11705 = 6). 비용 = ExpCash + ExpCashDiff x ExpansionLevel.
//   실측 2026-11-11 ★5 11705 두 번째 (Lv10, 415/415, ExpansionLevel 1): 요청 ExpansionCash 64 -> Result 1, 부품 65 -> 1 (64 = 53 + 11 x 1),
//   MasteryCapacity 415 -> 562, ExpansionLevel 2, 캐시 그대로. 클라이언트 비용 함수도 같은 식이며, MasteryCapacity 가 기본값
//   (SoftLimit + Expansion x 단계)보다 크면 비용을 남은 비율만큼 줄인다 (그 경우는 기록 없음, 서버는 반영 안 함).
//   차량 레벨 조건 없음: 11705 는 Lv3 에서 됐다.
register('MsgMasteryExpandReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = (snap?.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(body?.CarInfo?.Carid));
  const def = carDef(car?.Cartype) ?? {};
  const level = Number(car?.ExpansionLevel) || 0;
  const cost = Number(def.ExpCash) > 0 ? Number(def.ExpCash) + (Number(def.ExpCashDiff) || 0) * level : (Number(body?.ExpansionCash) || 0);
  const parts = (snap?.Items?.ItemInfo ?? []).find((x: any) => Number(x.Itemtype) === 61006);
  const add = Number(def.Expansion) || 0;
  const full = car && (Number(car.Mastery) || 0) >= (Number(car.MasteryCapacity) || 0);
  if (!snap || !car || !add || !full || level >= (Number(def.ExpCount) || 1) || cost <= 0 || (Number(parts?.Count) || 0) < cost) {
    console.warn(`[garage] 한계 돌파 거절 ${JSON.stringify(body)}`);
    return [{ name: 'MsgMasteryExpandAns', body: { Seq: 1, Result: R_FAIL, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  }
  parts.Count = Number(parts.Count) - cost;
  car.MasteryCapacity = (Number(car.MasteryCapacity) || 0) + add;
  car.ExpansionLevel = (Number(car.ExpansionLevel) || 0) + 1;
  questEvent(snap, 29, () => true); // 퀘스트: 숙련도 한계 돌파 n회
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgMasteryExpandAns', body: { Seq: 1, Result: R_OK, CarInfo: car, UserInfo: snap.UserInfo,
    ItemInfo: [{ Itemid: parts.Itemid, Itemtype: 61006, Count: parts.Count, StackNum: parts.Count }] } }];
});

// ── 숙련도 올리기 MsgMasteryUpReq {CarInfo:{Carid}, Mtype}
//   실기록 2026-11-03 (4건, Mtype 3): 차량 부품(61006) 50 개로 숙련도 +30 -> {Seq, Result 1, CarInfo(Mastery+30, MasteryAttr 가장 낮은 능력치부터 1씩,
//   DeltaMastery 는 그대로), UserInfo, ItemInfo [{Itemid, Itemtype 61006, Count, StackNum}]}.
//   화면 표기(2대 실측): +30 = 골드캐시 28 / 부품 50, 최대 = 남은 숙련도 x 28/30 골드캐시(67, 159) / x 50/30 부품(120, 283).
//   Mtype 1·2·4 의 의미(+30 골드캐시, 최대 골드캐시, 최대 부품)는 추정. 골드캐시(유료 재화)는 오프라인에서 지원하지 않아 거절.
register('MsgMasteryUpReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  const car = (snap?.Cars?.CarInfo ?? []).find((c: any) => Number(c.Carid) === Number(body?.CarInfo?.Carid));
  const mtype = Number(body?.Mtype) || 0;
  const parts = (snap?.Items?.ItemInfo ?? []).find((x: any) => Number(x.Itemtype) === 61006);
  const left = car ? (Number(car.MasteryCapacity) || 0) - (Number(car.Mastery) || 0) : 0;
  const add = mtype === 3 ? Math.min(30, left) : mtype === 4 ? left : 0;
  const cost = mtype === 3 ? 50 : mtype === 4 ? Math.round((left * 50) / 30) : 0;
  if (!snap || !car || add <= 0 || !cost || (Number(parts?.Count) || 0) < cost) {
    console.warn(`[garage] 숙련도 올리기 거절 ${JSON.stringify(body)}`);
    return [{ name: 'MsgMasteryUpAns', body: { Seq: 1, Result: R_FAIL, ...(snap ? { UserInfo: snap.UserInfo } : {}) } }];
  }
  parts.Count = Number(parts.Count) - cost;
  const delta = car.DeltaMastery;
  addMastery(car, add);
  car.DeltaMastery = delta;
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgMasteryUpAns', body: { Seq: 1, Result: R_OK, CarInfo: car, UserInfo: snap.UserInfo,
    ItemInfo: [{ Itemid: parts.Itemid, Itemtype: 61006, Count: parts.Count, StackNum: parts.Count }] } }];
});
