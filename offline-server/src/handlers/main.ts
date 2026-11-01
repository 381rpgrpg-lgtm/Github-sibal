// 메인 허브에서 주기적으로 호출되는 메시지. 오프라인에서는 특별 메시지·결제 연출·거리 이름 이벤트가 없다.
// 응답 형식은 클라이언트 구독부에서 확인: 각 Ans 의 배열 필드가 없거나 비면 아무것도 표시하지 않는다.
import { register, type Msg } from '../rpc.js';
import { table } from '../gamecalc.js';
import { grantItem } from '../inventory.js';

// 특별 메시지(운영 공지성 팝업) 목록 — 없음.
register('MsgSpecialMessageListReq', (): Msg[] => [
  { name: 'MsgSpecialMessageListAns', body: { Result: 1, SpecialMessages: [] } },
]);
register('MsgSpecialMessageSeenReq', (): Msg[] => [{ name: 'MsgSpecialMessageSeenAns', body: { Result: 1 } }]);

// 결제 보상 연출 — 오프라인에는 결제가 없다.
register('MsgPurchaseRevealReq', (): Msg[] => [
  { name: 'MsgPurchaseRevealAns', body: { Result: 1, PurchaseReveal: [] } },
]);
register('MsgPurchaseRevealSeenReq', (): Msg[] => [{ name: 'MsgPurchaseRevealSeenAns', body: { Result: 1 } }]);

// 거리 이름 이벤트 — Open=false 이면 클라이언트가 아무 것도 하지 않는다.
register('MsgStreetNamesReq', (): Msg[] => [{ name: 'MsgStreetNamesAns', body: { Result: 1, Open: false } }]);

// 거리 이름 '확인함' (실기록: {Seq, Result 1})
register('MsgStreetNameSeenReq', (): Msg[] => [{ name: 'MsgStreetNameSeenAns', body: { Result: 1 } }]);

// Reborn 가챠 진열 (실기록 고정값: 79610 상자, 대표 차량 3종)
register('MsgRebornGachaShowcaseReq', (): Msg[] => [{ name: 'MsgRebornGachaShowcaseAns', body: {
  Result: 1, Open: true, BoxId: 79610, Cars: [14005, 12004, 11105], Source: 'default' } }]);

// 기억(앨범) 보상 수령: 요청한 기억들의 girlMemoryTable Rewarditem x Rewardvalue 지급, RewardState 2(수령 가능) -> 1(수령 완료).
//   실기록: 20105 기억 10개 -> 코인 2250 (표 합계와 일치), 응답 {GirlMemorySet, UserInfo, ItemInfo[{Itemtype, Count, DeltaNum}]}
register('MsgGetGirlMemoryRewardReq', (body, ctx): Msg[] => {
  const snap = ctx.store.getUser(ctx.session.accountId);
  if (!snap) return [{ name: 'MsgGetGirlMemoryRewardAns', body: { Result: 2 } }];
  const defs: any[] = table('girlMemoryTable.json')?.GirlMemory ?? [];
  const sums = new Map<number, number>();
  for (const req of body?.GirlMemorySet?.GirlMemory ?? []) {
    const mine = (snap.GirlMemorySet?.GirlMemory ?? []).find((x: any) => Number(x.Girlid) === Number(req.Girlid));
    for (const r of req.Memory ?? []) {
      const m = mine?.Memory?.find((x: any) => Number(x.Id) === Number(r.Id));
      if (!m || Number(m.RewardState) !== 2) continue;
      const d = defs.find((x: any) => Number(x.GirlId) === Number(req.Girlid) && Number(x.Id) === Number(r.Id));
      m.RewardState = 1;
      if (d?.Rewarditem && d?.Rewardvalue) sums.set(Number(d.Rewarditem), (sums.get(Number(d.Rewarditem)) ?? 0) + Number(d.Rewardvalue));
    }
  }
  const items: any[] = [];
  for (const [t, n] of sums) if (grantItem(snap, t, n)) items.push({ Itemtype: t, Count: n, DeltaNum: n });
  ctx.store.putUser(ctx.session.accountId, snap);
  return [{ name: 'MsgGetGirlMemoryRewardAns', body: { GirlMemorySet: snap.GirlMemorySet, UserInfo: snap.UserInfo, ItemInfo: items } }];
});
