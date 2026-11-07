// 삐침(Emotion 1) 방치 시 호감도 하락. 클라이언트 안내문(text_kr peevish_girl_popup_notice): '삐친 상태가 지속되면 호감도가 점점 하락합니다.'
// 표에는 수치가 없다 (서버 규칙). 실기록 1건 (2026-11-05~06, 차민 20101 방치 실험):
//   삐침 시작 11-05 23:40:54~23:48:35 사이 로그인 -> 11-06 23:41:37~23:50:34 사이 로그인에서 Familiarity 897 -> 747 (-150), Emotion 1 유지.
//   그 사이 24시간 동안은 하락 없음, 친밀도 코인은 거절(handlers/girls.ts). 24시간마다 반복되는지·하한이 있는지는 미확인(추정: 24시간마다 -150, 0 미만 없음).
export const PEEVISH_DECAY_SEC = 24 * 3600, PEEVISH_DECAY = 150;

/** a girl just became peevish: remember when (snap.peevishSince, not sent to the client as a girl field) */
export function markPeevish(snap: any, girlid: number, nowSec = Date.now() / 1000): void {
  const since = (snap.peevishSince ??= {});
  since[girlid] = Math.floor(nowSec); (snap.peevishApplied ??= {})[girlid] = 0;
}

/** apply the decay for every full day a girl has stayed peevish; returns the girls that changed */
export function peevishDecay(snap: any, nowSec = Date.now() / 1000): any[] {
  const since = (snap.peevishSince ??= {}), applied = (snap.peevishApplied ??= {}), out: any[] = [];
  for (const g of snap.MyGirls?.MyGirlInfo ?? []) {
    const id = Number(g.Girlid);
    if (Number(g.State) !== 7 || Number(g.Emotion) !== 1) { delete since[id]; delete applied[id]; continue; }
    if (!since[id]) { since[id] = Math.floor(nowSec); applied[id] = 0; continue; } // peevish seen first now (start time unknown)
    const due = Math.floor((nowSec - since[id]) / PEEVISH_DECAY_SEC);
    if (due > (applied[id] || 0)) {
      g.Familiarity = Math.max(0, (Number(g.Familiarity) || 0) - PEEVISH_DECAY * (due - (applied[id] || 0)));
      applied[id] = due; out.push(g);
    }
  }
  return out;
}
