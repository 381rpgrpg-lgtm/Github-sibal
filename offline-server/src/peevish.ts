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
// ── 삐침 조건 14 '레이스 초대' (값 = 횟수; 안내문 peevish_info_title14 "저도 레이스에 초대 좀 해 주세요", desc14 "함께 레이스를 해서 승리하세요") ──
// 실기록 2026-11-11 (20103, 조건 14 값 65 = PeevishCondition2):
//   20103 이 마지막으로 동승한 레이스(11-10 17:06 이전) 뒤 다른 캐릭터를 태운 본편 레이스 66회째(01:21:50) 결과
//   UpdateGirlInfo 에 20103 기분 1·CauseOfPeevish 14·SolutionForPeevish 14, CallScript [Date_Peevish_Condition_B, 20103, FmLevel 4].
//   그 사이 주간 레이스 3회는 셈에 넣지 않았다(넣으면 69회). 66 = 값 + 1 이라 '값을 넘으면' 으로 둔다 (추정: 1건, 12 는 '값에 닿으면').
//   데이트 2회(01:21·03:41, 만족도 5·4)로는 안 풀렸고, 20103 을 동승자로 바꾼 첫 레이스(04:17, 승리) 결과에서 기분 0·원인 0.
//   패배한 동승 레이스로도 풀리는지는 미확인 (안내문대로 승리 때만 푼다).
export const RACE_INVITE = 14;

/** 삐침이 생긴 결과 응답의 CallScript 항목. 대본 이름 끝 A/B/C = 그 원인이 들어 있는 girlTable PeevishCondition1/2/3 칸
 *  (실기록 6건 모두 일치: 20101·20303 원인 11 칸1 A, 20206 원인 13 칸1 A, 20505 원인 12 칸1 A, 20208 원인 9 칸2 B, 20103 원인 14 칸2 B).
 *  FmLevel = 그 캐릭터의 친밀도 단계. 데이트 결과(원인 11·13)와 레이스 결과(원인 9·12·14) 모두 같은 형식. */
export function peevishScript(girlId: number, cause: number, def: any, fmLevel: number, clear = false): { Name: string; Girlid: number; FmLevel: number } | null {
  const n = [1, 2, 3].find((k) => Number(def?.[`PeevishCondition${k}`]) === cause);
  return n ? { Name: `${clear ? 'Date_End_Peevish_Clear_' : 'Date_Peevish_Condition_'}${'ABC'[n - 1]}`, Girlid: girlId, FmLevel: fmLevel } : null;
}
// 삐침이 풀린 결과 응답에는 Date_End_Peevish_Clear_<같은 칸> (실기록 9건: 데이트로 원인 9·11·13, 레이스로 원인 12(20505 11-10 20:56)·14(20103 11-11 04:17)).
//   안 풀린 데이트(원인 12·14 상태의 데이트 5회)에는 CallScript 가 비어 있다.

/** 본편 레이스(동승 가능한 레이스, 기권 제외)가 끝났을 때 원인 12·14 판정.
 *  - 동승자: 원인 12·14 셈을 0 으로. 원인 12 삐침은 풀리고, 원인 14 삐침은 이겼을 때 풀린다.
 *  - 그 밖의 캐릭터: 동승자를 라이벌로 둔 원인 12 셈 +1 (값에 닿으면 삐침), 원인 14 셈 +1 (값을 넘으면 삐침).
 *  returns { girls: 기록이 바뀐 캐릭터(UpdateGirlInfo), scripts: 새로 삐친 캐릭터의 CallScript 항목 } */
export function racePeevish(snap: any, passengerId: number, win: boolean, gdef: (id: number) => any,
  fmLevel: (girlId: number, fam: number) => number, nowSec = Date.now() / 1000): { girls: any[]; scripts: any[] } {
  const cnt: Record<string, Record<string, number>> = (snap.peevishCount ??= {});
  const girls: any[] = [], scripts: any[] = [];
  for (const y of snap.MyGirls?.MyGirlInfo ?? []) {
    const id = Number(y.Girlid);
    if (Number(y.State) !== 7) continue;
    if (id === passengerId) {
      if (cnt[id]) { cnt[id][RIVAL_RIDE] = 0; cnt[id][RACE_INVITE] = 0; }
      const cause = Number(y.CauseOfPeevish);
      if (Number(y.Emotion) === 1 && (cause === RIVAL_RIDE || (cause === RACE_INVITE && win))) {
        const sc = peevishScript(id, cause, gdef(id), fmLevel(id, Number(y.Familiarity) || 0), true); if (sc) scripts.push(sc);
        y.Emotion = 0; y.CauseOfPeevish = 0; y.SolutionForPeevish = 0;
        delete snap.peevishSince?.[id]; delete snap.peevishApplied?.[id];
        girls.push(y);
      }
      continue;
    }
    const def = gdef(id); if (!def) continue;
    for (const n of [1, 2, 3]) {
      const cond = Number(def[`PeevishCondition${n}`]) || 0, val = Number(def[`PeevishValue${n}`]) || 0;
      if (!val || !(cond === RACE_INVITE || (cond === RIVAL_RIDE && passengerId > 0 && Number(def.RivalGirl) === passengerId))) continue;
      const c = (cnt[id] ??= {});
      c[cond] = (c[cond] ?? 0) + 1;
      const due = cond === RIVAL_RIDE ? c[cond] >= val : c[cond] > val;
      if (due && Number(y.Emotion) !== 1) {
        y.Emotion = 1; y.CauseOfPeevish = cond; y.SolutionForPeevish = cond; markPeevish(snap, id, nowSec);
        c[cond] = 0;
        if (!girls.includes(y)) girls.push(y);
        const sc = peevishScript(id, cond, def, fmLevel(id, Number(y.Familiarity) || 0)); if (sc) scripts.push(sc);
      }
    }
  }
  return { girls, scripts };
}

/** 이전 이름 (원인 12 만 보던 판): 동승 레이스 승리로 본다 */
export function ridePeevish(snap: any, passengerId: number, gdef: (id: number) => any, nowSec = Date.now() / 1000): any[] {
  return racePeevish(snap, passengerId, true, gdef, () => -1, nowSec).girls;
}
