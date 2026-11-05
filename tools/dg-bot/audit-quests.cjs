// 퀘스트 목표 형식 전수 점검: nquests.json 의 목표 Type 별 파라미터 형태(빈 칸 위치)를 모두 뽑고,
// 봇(bot.cjs 'Number(o.Type) === N')과 오프라인 서버(quests.ts stateValue 'case N:', questEvent(snap, N ...))가 그 Type 을 다루는지 대조한다.
// 형태가 2가지 이상인 Type 은 '형식 주의'로 표시 (2026-11-05: Type 2 [횟수, 구역, 레이스, '', 캐릭터] 와 [횟수, 구역, '', 등급, 캐릭터],
//   Type 7 [1, 캐릭터, 등급] / [1, 캐릭터, '', 단계] / [1, 캐릭터, 1, 1, 단계] 를 한 가지로 처리해 생긴 문제).
// node audit-quests.cjs [--all]   결과: run/quest-audit.txt (진행 중·대기 퀘스트에 나오는 Type 은 '*' 표시)
const fs = require('fs');
const D = '/home/user/Github-sibal/offline-server/';
const Q = JSON.parse(fs.readFileSync(D + 'data/tables/nquests.json', 'utf8')).Quest;
const K = (() => { const t = JSON.parse(fs.readFileSync(D + 'data/tables/text_kr.json', 'utf8')); return t.Text ?? t; })();
const bot = fs.readFileSync(__dirname + '/bot.cjs', 'utf8');
const srv = fs.readdirSync(D + 'src', { recursive: true }).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(D + 'src/' + f, 'utf8')).join('\n');
const qsrc = fs.readFileSync(D + 'src/quests.ts', 'utf8');
const botTypes = new Set([...bot.matchAll(/Number\(o\.Type\) === (\d+)/g)].map((m) => +m[1]));
const stateTypes = new Set([...qsrc.matchAll(/case (\d+):/g)].map((m) => +m[1]));
const eventTypes = new Set([...srv.matchAll(/questEvent\(\s*\w+,\s*(\d+)/g)].map((m) => +m[1]));
let ud = null; try { ud = JSON.parse(fs.readFileSync(__dirname + '/run/ud.json', 'utf8')); } catch {}
const active = new Set((ud?.NquestInfos?.NquestInfo ?? []).filter((q) => q.State >= 2 && q.State < 7).map((q) => q.QuestId));
const types = new Map();
for (const q of Q) for (const o of q.Objective ?? []) {
  const p = o.Param ?? [];
  const shape = `${p.length}:` + p.map((v) => (v === '' || v === undefined ? '_' : 'x')).join('');
  const t = types.get(+o.Type) ?? { shapes: new Map(), active: false };
  const e = t.shapes.get(shape) ?? { n: 0, ex: [] };
  e.n++; if (e.ex.length < 2) e.ex.push(`${q.Id} ${JSON.stringify(p)} ${(K[o.Desc] ?? '').replace(/\[[0-9A-Fa-f-]*\]/g, '').slice(0, 40)}`);
  t.shapes.set(shape, e); if (active.has(q.Id)) t.active = true;
  types.set(+o.Type, t);
}
const lines = [];
const all = process.argv.includes('--all');
for (const [ty, t] of [...types].sort((a, b) => a[0] - b[0])) {
  const multi = t.shapes.size > 1;
  const cov = `bot ${botTypes.has(ty) ? 'O' : '-'} / server ${stateTypes.has(ty) ? 'state' : eventTypes.has(ty) ? 'event' : '-'}`;
  if (!all && !t.active && !multi) continue;
  lines.push(`${t.active ? '*' : ' '} Type ${ty}: ${cov}${multi ? '   [형식 주의: ' + t.shapes.size + '가지]' : ''}`);
  for (const [sh, e] of t.shapes) lines.push(`      ${sh.padEnd(10)} x${String(e.n).padEnd(4)} ${e.ex.join(' | ')}`);
}
const out = `퀘스트 목표 형식 점검 (${new Date().toISOString().slice(0, 16)}), Type ${types.size}종, 진행·대기 퀘스트 ${active.size}개\n` +
  `범례: shape = 파라미터 수:각 칸(x 값 있음, _ 빈 칸). * = 진행·대기 중 퀘스트에 나옴. 기본은 형식이 여럿이거나 진행 중인 Type 만 (--all 전부)\n\n` + lines.join('\n') + '\n';
fs.writeFileSync(__dirname + '/run/quest-audit.txt', out);
console.log(out);
