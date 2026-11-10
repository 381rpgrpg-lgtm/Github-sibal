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

// ── 삐침 조건 12 '라이벌 동승' (girlTable PeevishCondition 12, 값 = 횟수, RivalGirl) ─────────────
// 실기록 2026-11-10 (20505, 조건 12 값 15, RivalGirl 20504):
//   20504 를 동승자로 둔 본편 레이스 15회째(17:17 동승 변경 ~ 19:46) 결과에서 20505 가 기분 1·CauseOfPeevish 12·SolutionForPeevish 12.
//   그 뒤 20505 와 데이트 3회(Date_Peevish 대본, 만족도 3~4)로는 안 풀렸고(기분 1 유지), 20505 를 동승자로 바꾼 첫 레이스 결과
//   MsgBattleResultAns.UpdateGirlInfo 에 20505 기분 0·원인 0, 친밀도 +10 으로 풀렸다.
//   센 값은 snap.peevishCount[캐릭터][12]. 그 캐릭터가 동승하거나 데이트하면 0 (추정: 기록상 둘 다 17:06~17:17 에 있었다).
export const RIVAL_RIDE = 12;
/** a race finished with `passengerId` riding: resolve that girl's rival-ride sulk, count the rival rides of the others.
 *  returns the girls whose record changed (for UpdateGirlInfo) */
export function ridePeevish(snap: any, passengerId: number, gdef: (id: number) => any, nowSec = Date.now() / 1000): any[] {
  const cnt: Record<string, Record<string, number>> = (snap.peevishCount ??= {});
  const out: any[] = [];
  for (const y of snap.MyGirls?.MyGirlInfo ?? []) {
    const id = Number(y.Girlid);
    if (Number(y.State) !== 7) continue;
    if (id === passengerId) {
      if (cnt[id]) cnt[id][RIVAL_RIDE] = 0;
      if (Number(y.Emotion) === 1 && Number(y.CauseOfPeevish) === RIVAL_RIDE) {
        y.Emotion = 0; y.CauseOfPeevish = 0; y.SolutionForPeevish = 0;
        delete snap.peevishSince?.[id]; delete snap.peevishApplied?.[id];
        out.push(y);
      }
      continue;
    }
    const def = gdef(id); if (!def || Number(def.RivalGirl) !== passengerId) continue;
    for (const n of [1, 2, 3]) {
      if (Number(def[`PeevishCondition${n}`]) !== RIVAL_RIDE) continue;
      const val = Number(def[`PeevishValue${n}`]) || 0; if (!val) continue;
      const c = (cnt[id] ??= {});
      c[RIVAL_RIDE] = (c[RIVAL_RIDE] ?? 0) + 1;
      if (c[RIVAL_RIDE] >= val && Number(y.Emotion) !== 1) {
        y.Emotion = 1; y.CauseOfPeevish = RIVAL_RIDE; y.SolutionForPeevish = RIVAL_RIDE; markPeevish(snap, id, nowSec);
        c[RIVAL_RIDE] = 0; out.push(y);
      }
    }
  }
  return out;
}
