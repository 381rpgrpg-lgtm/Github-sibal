// 거리 이름 단어 표: src/data/street-words.json 을 읽는다 (scripts/make-street-words.mjs 가 클라이언트 엔진의 ii()/Qe() 정의,
//   모델 표·별칭, 캐릭터 목록을 node vm 으로 실행해 만든다. 게임 데이터라 저장소에는 넣지 않는다 — make-event-races.cjs 와 같은 방침).
//   단어 {id, s 칸 P/C/E, t 표시어, r 등급 0 일반 ~ 4 울트라, g 묶음, need [[fact, n], ...], secret = 힌트 문구가 있는 단어}
//   파일이 없으면 빈 표: 단어는 주지 않고 기록(실서버 스냅샷)에서 이어받은 것만 남는다.
import { readFileSync, existsSync } from 'node:fs';
export interface StreetWordDef { id: string; s: "P" | "C" | "E"; t: string; r: number; g: string; need: [string, number][]; secret?: boolean }
export interface StreetModelDef { name: string; body: string; shown?: number; flag?: number; alias?: number }
const PATH = new URL('../src/data/street-words.json', import.meta.url).pathname;
const cat: any = (() => {
  try { if (existsSync(PATH)) return JSON.parse(readFileSync(PATH, 'utf8')); } catch (e) { console.warn(`[street] 단어 표 읽기 실패: ${(e as Error).message}`); }
  console.warn('[street] src/data/street-words.json 없음 (node scripts/make-street-words.mjs <풀린 engine js>): 거리 단어를 계산하지 않는다');
  return null;
})();
export const STREET_WORDS: StreetWordDef[] = cat?.words ?? [];
export const STREET_MODELS: Record<string, StreetModelDef> = cat?.models ?? {};
export const STREET_MODEL_ALIAS: Record<string, number> = cat?.modelAlias ?? {};
export const STREET_GIRLS: number[] = cat?.girls ?? [];
