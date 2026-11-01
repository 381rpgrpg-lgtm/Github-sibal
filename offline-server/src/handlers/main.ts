// 메인 허브에서 주기적으로 호출되는 메시지. 오프라인에서는 특별 메시지·결제 연출·거리 이름 이벤트가 없다.
// 응답 형식은 클라이언트 구독부에서 확인: 각 Ans 의 배열 필드가 없거나 비면 아무것도 표시하지 않는다.
import { register, type Msg } from '../rpc.js';

// 특별 메시지(운영 공지성 팝업) 목록 — 없음.
register('MsgSpecialMessageListReq', (): Msg[] => [
  { name: 'MsgSpecialMessageListAns', body: { Result: 0, SpecialMessages: [] } },
]);
register('MsgSpecialMessageSeenReq', (): Msg[] => [{ name: 'MsgSpecialMessageSeenAns', body: { Result: 0 } }]);

// 결제 보상 연출 — 오프라인에는 결제가 없다.
register('MsgPurchaseRevealReq', (): Msg[] => [
  { name: 'MsgPurchaseRevealAns', body: { Result: 0, PurchaseReveal: [] } },
]);
register('MsgPurchaseRevealSeenReq', (): Msg[] => [{ name: 'MsgPurchaseRevealSeenAns', body: { Result: 0 } }]);

// 거리 이름 이벤트 — Open=false 이면 클라이언트가 아무 것도 하지 않는다.
register('MsgStreetNamesReq', (): Msg[] => [{ name: 'MsgStreetNamesAns', body: { Result: 0, Open: false } }]);
