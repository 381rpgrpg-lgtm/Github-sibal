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
//   그 사이 주간 레이스 3회는 셈에 넣지 않았다(넣으면 69회). 66회 중 1회는 10-26(RaceType 7 캐릭터 레이스, 동승 없음)이라 빼면 65회.
//   다시 잰 2건도 65회: 11-11 08:34 동승 변경 ~ 14:44 (본편 65, 주간 0), 11-11 15:34 동승 승리 ~ 11-12 01:31 (본편 65, 주간 2).
//   -> 동승 가능한 본편 레이스(캐릭터 레이스·주간 제외)가 값에 닿으면 삐친다 (원인 12 와 같음, 실기록 3건 일치).
//   데이트 2회(01:21·03:41, 만족도 5·4)로는 안 풀렸고, 20103 을 동승자로 바꾼 첫 레이스(04:17, 승리) 결과에서 기분 0·원인 0.
//   패배한 동승 레이스로는 안 풀린다: 11-12 01:36~03:27 20103 동승 패배 12회 동안 기분 1 유지, 03:37 동승 승리(5-12) 직후 기분 0.
export const RACE_INVITE = 14;
// ── 삐침 조건 9 '레이스만 보는 건 지겨워요' (값 = 횟수; 안내문 peevish_info_desc9 "레이스만 하지 말고 데이트도 해 보세요") ──
// 실기록 2026-11-12 (20201, PeevishCondition3 = 9, 값 10): 그 캐릭터의 데이트 뒤 그 캐릭터를 태운 본편 레이스 10회째 결과에서
//   MsgBattleResultAns.UpdateGirlInfo 20201 기분 1·원인 9, CallScript [Date_Peevish_Condition_C, 20201, FmLevel 4]. 5구간 모두 10회
//   (11:36·13:17·17:17·18:43·19:40 데이트 뒤). 진 레이스도 센다 (15:06 10회째 = 14-21 패배). 다른 캐릭터를 태운 레이스는 세지 않는다
//   (13:17~15:06 구간: 20103 동승 1회 + 20201 동승 10회 -> 20201 10회째에서 삐침). 데이트 한 번으로 풀리고 셈도 0 (date.ts rivalPeevish).
export const RACE_ONLY = 9;
// ── 삐침 조건 1 '당신과의 데이트는 재미가 없어요' (값 = 횟수) ──
// 실기록 2026-11-12 (20201, PeevishCondition1 = 1, 값 2): 만족도 3 이하 데이트가 연달아 값만큼이면 그 데이트 결과에서 기분 1·원인 1.
//   07:22 (4·3·2 의 셋째, 보통 데이트) -> CallScript [Date_Peevish_Condition_A]. 15:06 (원인 9 삐침 풀기 데이트 3 -> 3) -> 원인 9 대신 원인 1,
//   CallScript [] (풀림 대본도 조건 대본도 없음). 18:43 2 -> 19:40 4 -> 20:35 2 는 안 삐침 -> 만족도 4 이상이면 셈 0.
//   2026-11-05 싫어한 답 데이트 5회(다른 캐릭터, 조건 1 값 5)는 화남(2)만 됐다 -> 화남이 되는 결과에서는 삐치지 않는다 [추정].
export const DULL_DATE = 1;
/** 데이트 결과에서 원인 1 판정. sat = 이번 만족도. returns true = 이번 결과로 원인 1 삐침 (호출자가 CallScript 를 정한다) */
export function dullDatePeevish(snap: any, g: any, sat: number, def: any, nowSec = Date.now() / 1000): boolean {
  const id = Number(g.Girlid), streak: Record<string, number> = (snap.dullDates ??= {});
  streak[id] = sat >= 1 && sat <= 3 ? (streak[id] ?? 0) + 1 : 0;
  const n = [1, 2, 3].find((k) => Number(def?.[`PeevishCondition${k}`]) === DULL_DATE);
  const val = n ? Number(def[`PeevishValue${n}`]) || 0 : 0;
  if (!val || streak[id] < val || Number(g.Emotion) === 2) return false;
  if (Number(g.Emotion) === 1 && Number(g.CauseOfPeevish) !== 0) return false; // 아직 안 풀린 삐침(원인 12·14)은 그대로
  g.Emotion = 1; g.CauseOfPeevish = DULL_DATE; g.SolutionForPeevish = DULL_DATE; markPeevish(snap, id, nowSec);
  streak[id] = 0;
  return true;
}
/** 삐친 캐릭터와의 데이트(Date_Peevish 대본, 문항 없음) 만족도: 장소마다 다르다. 실기록 28건 (2026-11-05~12, 20103·20201·20206·20208·20301·20303·20505):
 *  레스토랑 4 x6, 바 4 x2, 수족관 4 x2, 공원 4 x1, 노래방 4 x6·3 x2, 테마파크 5 x2·3 x1, 호텔 뷔페 3, 동물원 2, 핫스폿 2. 캐릭터와는 무관해 보인다 [추정].
 *  기록 없는 장소는 3 (예전 가정). 표본에서 고르게 뽑는다. 싫어하는 장소 -2 는 호출자 (20101 대학 1) */
export const PEEVISH_PLACE_SAT: Record<number, number[]> = {
  44222: [4, 4, 4, 4, 4, 4], 42104: [4, 4], 42093: [4, 4], 41011: [4], 43174: [4, 4, 4, 4, 4, 4, 3, 3], 44211: [5, 5, 3], 42082: [3], 43141: [2], 41044: [2],
};
export function peevishDateSat(place: number, rnd = Math.random): number {
  const a = PEEVISH_PLACE_SAT[place]; return a?.length ? a[Math.floor(rnd() * a.length)] : 3;
}

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
 *  - 그 밖의 캐릭터: 동승자를 라이벌로 둔 원인 12 셈 +1, 원인 14 셈 +1 (둘 다 값에 닿으면 삐침).
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
      // 원인 9 '레이스만': 태운 레이스(승패 무관)를 세다가 값에 닿으면 삐침 (위 RACE_ONLY 실기록). 이미 삐친 동안은 세지 않는다 [추정]
      const d9 = gdef(id), k9 = [1, 2, 3].find((k) => Number(d9?.[`PeevishCondition${k}`]) === RACE_ONLY), v9 = k9 ? Number(d9[`PeevishValue${k9}`]) || 0 : 0;
      if (v9 && Number(y.Emotion) !== 1) {
        const c = (cnt[id] ??= {}); c[RACE_ONLY] = (c[RACE_ONLY] ?? 0) + 1;
        if (c[RACE_ONLY] >= v9) {
          y.Emotion = 1; y.CauseOfPeevish = RACE_ONLY; y.SolutionForPeevish = RACE_ONLY; markPeevish(snap, id, nowSec); c[RACE_ONLY] = 0;
          if (!girls.includes(y)) girls.push(y);
          const sc = peevishScript(id, RACE_ONLY, d9, fmLevel(id, Number(y.Familiarity) || 0)); if (sc) scripts.push(sc);
        }
      }
      continue;
    }
    const def = gdef(id); if (!def) continue;
    for (const n of [1, 2, 3]) {
      const cond = Number(def[`PeevishCondition${n}`]) || 0, val = Number(def[`PeevishValue${n}`]) || 0;
      if (!val || !(cond === RACE_INVITE || (cond === RIVAL_RIDE && passengerId > 0 && Number(def.RivalGirl) === passengerId))) continue;
      const c = (cnt[id] ??= {});
      c[cond] = (c[cond] ?? 0) + 1;
      const due = c[cond] >= val; // 12·14 모두 '값에 닿으면' (위 실기록)
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
