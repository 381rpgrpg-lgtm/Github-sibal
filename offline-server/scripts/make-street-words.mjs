// 거리 이름 단어 표 만들기: 클라이언트 엔진(webcrack 으로 푼 engine-*.js)의 카탈로그 정의 부분만 잘라 node vm 으로 실행해
// src/data/street-words.json 을 쓴다 (src/streetwords.ts 가 읽는다). 게임 데이터라 저장소에는 넣지 않는다 (.gitignore data/, make-event-races.cjs 와 같은 방침).
// 사용: node scripts/make-street-words.mjs <풀린 engine js 경로>
//   찾는 구간 (2026-11-05 engine-C3PtOFdR 기준 이름, 클라이언트가 바뀌면 이름을 확인해 아래 표식을 고친다):
//   모델 표 `const Qb = Object.freeze({` ~ `});`, 별칭 `const Bne = Object.freeze({` ~ `});`,
//   단어 정의 `const dT = Object.freeze(["common"` ~ `const foe = Object.freeze(gT.map(` 직전 (ii()/Qe() 호출, 캐릭터 목록 pT 포함)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';
const src = process.argv[2];
if (!src) { console.error('사용: node scripts/make-street-words.mjs <풀린 engine js>'); process.exit(1); }
const OUT = new URL('../src/data/street-words.json', import.meta.url).pathname;
const L = readFileSync(src, 'utf8').split('\n');
const at = (pre, from = 0) => { const i = L.findIndex((l, k) => k >= from && l.startsWith(pre)); if (i < 0) throw new Error('표식 없음: ' + pre); return i; };
const block = (pre) => { const a = at(pre); const b = at('});', a); return L.slice(a, b + 1).join('\n'); };
const wa = at('const dT = Object.freeze(["common"'), wb = at('const foe = Object.freeze(gT.map(', wa);
const code = [
  'const f = (fn) => fn; const Ht = {common:{label:"Common"},rare:{label:"Rare"},epic:{label:"Epic"},legendary:{label:"Legendary"},ultra:{label:"Ultra Rare"}}; const Dr = (t,k)=>k;',
  block('const Qb = Object.freeze({'), block('const Bne = Object.freeze({'), L.slice(wa, wb).join('\n'),
  'globalThis.__out = { words: gT, Qb, Bne, pT };',
].join('\n');
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);
const o = ctx.__out;
const words = o.words.map((w) => ({ id: w.id, s: w.s, t: w.t, r: w.r, g: w.g, need: w.need, ...(w.h ? { secret: true } : {}) }));
const models = Object.fromEntries(Object.entries(o.Qb).map(([k, v]) => [k, { name: v.name, body: v.body, ...(v.shown ? { shown: v.shown } : {}), ...(v.flag ? { flag: v.flag } : {}), ...(v.alias ? { alias: v.alias } : {}) }]));
const ids = words.map((w) => w.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
mkdirSync(new URL('../src/data/', import.meta.url).pathname, { recursive: true });
writeFileSync(OUT, JSON.stringify({ source: src.split('/').pop(), words, models, modelAlias: o.Bne, girls: Object.keys(o.pT).map(Number) }));
console.log('words', words.length, 'dups', dup.length, 'models', Object.keys(models).length, 'girls', Object.keys(o.pT).length, '->', OUT);
