// 차고: 차량 강화. 형식은 실서버 기록(data/recorded, 2026-11-01)을 따른다.
//
// MsgUpgradeCarReq {TargetCarInfo:{Carid}, SourceCarInfo?:[{Carid}]}
//  - 튜토리얼 강화(재료 없음, Completion 에 ReinforceCar(8192) 비트가 없을 때) — 기록:
//      Result 1, UpgradeSuccess true, ResultCarInfo(UpgradeLevel 1 -> 2, Attributes 각 +2, CarExp 0),
//      NormalDeltaExp 10(= carLevelTable 해당 등급·레벨 CarExp), BonusDeltaExp 0, RemovedCarInfo [], RemovedPartsInfo [],
//      UserInfo(Completion |= 8192, 코인 차감 없음), PropertySet(DQUEST_PARTSUP 1)
//  - 재료 없이 다시 요청 — 기록: {Seq, Result 2, UserInfo}
//  - 재료 차량 강화: 경험치·비용·성공률 공식 기록 없음 → Result 2 로 거절하고 로그를 남긴다(원본과 다른 결과를 만들지 않기 위해).
import { readFileSync, existsSync } from 'node:fs';
import { register, type Msg } from '../rpc.js';
import { bumpProperty } from './battle.js';

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
  if (sources.length) return fail('재료 차량 강화는 실서버 기록이 없어 미구현');
  if (Number(ui.Completion) & TUT_REINFORCE_CAR) return fail('재료 없음 (튜토리얼 강화는 이미 완료)');

  // 튜토리얼 강화
  const deltaExp = levelExp(Number(car.Grade) || 1, Number(car.UpgradeLevel) || 1);
  car.UpgradeLevel = (Number(car.UpgradeLevel) || 1) + 1;
  car.CarExp = 0;
  car.Attributes ??= {};
  for (const k of ATTRS) car.Attributes[k] = (Number(car.Attributes[k]) || 0) + 2;
  ui.Completion = Number(ui.Completion) | TUT_REINFORCE_CAR;
  bumpProperty(snap, 'DQUEST_PARTSUP', 1); // 일일 미션 '차량·부품 강화 1회' (기록 0 -> 1)
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{
    name: 'MsgUpgradeCarAns',
    body: {
      Seq: 1, Result: R_OK, UpgradeSuccess: true, ResultCarInfo: car, UserInfo: ui,
      RemovedCarInfo: [], RemovedPartsInfo: [], NormalDeltaExp: deltaExp, BonusDeltaExp: 0,
      PropertySet: snap.PropertySet,
    },
  }];
});
