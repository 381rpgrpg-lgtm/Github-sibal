// content.json 의 표 패치(tables[]: {table, part, key, upsert[]})를 data/tables 원본 표에 적용한다.
// 클라이언트는 이 패치를 적용한 표를 쓴다(예: 이벤트 구역 BattleArea 53103·53311·53301, EventRaceReward, 새 차량·아이템).
// 서버도 같은 표를 봐야 이벤트 레이스·보상을 맞출 수 있다.
// 병합 방식: key(단일 또는 복합 키)가 같은 행이 있으면 필드 단위로 덮어쓰고(부분 패치: 예 53000 은 {Id, TryCount, BattleType} 만 옴),
//   없으면 새 행으로 추가한다.
import { readFileSync, existsSync } from 'node:fs';

const CONTENT = new URL('../data/content.json', import.meta.url).pathname;
let patches: any[] | null = null;
function list(): any[] {
  if (!patches) {
    try { patches = existsSync(CONTENT) ? JSON.parse(readFileSync(CONTENT, 'utf8')).tables ?? [] : []; } catch { patches = []; }
  }
  return patches!;
}

export function applyUpserts(name: string, t: any): any {
  if (!t || typeof t !== 'object') return t;
  const base = name.replace(/\.json$/, '');
  for (const u of list()) {
    if (u?.table !== base || !Array.isArray(u.upsert) || !u.part) continue;
    const keys: string[] = Array.isArray(u.key) ? u.key : [u.key];
    const arr: any[] = Array.isArray(t[u.part]) ? t[u.part] : (t[u.part] = []);
    for (const r of u.upsert) {
      const i = arr.findIndex((x) => keys.every((k) => String(x?.[k]) === String(r?.[k])));
      if (i >= 0) arr[i] = { ...arr[i], ...r };
      else arr.push(r);
    }
  }
  return t;
}

/** data/tables/<name> 을 읽고 content.json 패치를 적용해 돌려준다 (없으면 null) */
export function readTable(path: string, name: string): any {
  return existsSync(path) ? applyUpserts(name, JSON.parse(readFileSync(path, 'utf8'))) : null;
}
