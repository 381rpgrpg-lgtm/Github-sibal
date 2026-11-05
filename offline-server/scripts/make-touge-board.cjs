// Haunted Pass Board 설정 만들기: data/recorded 의 가장 최근 LocalTougeBoardAns 에서 계정별 값을 뺀 Board 를
// src/data/touge-board.json 으로 쓴다 (handlers/touge.ts 가 읽는다).
// 사용: node scripts/make-touge-board.cjs   (게임 데이터라 저장소에는 넣지 않는다: .gitignore data/)
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), D = path.join(ROOT, 'data/recorded'), OUT = path.join(ROOT, 'src/data/touge-board.json');
const fl = fs.readdirSync(D).filter((f) => /_LocalTougeBoardReq\.json$/.test(f)).sort((a, b) => a.split('_')[1] - b.split('_')[1]);
let board = null;
for (const f of fl.reverse()) {
  const r = JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
  const b = (r.response?.messages ?? []).find((m) => m.name === 'LocalTougeBoardAns')?.body;
  if (b?.Result === 1 && b.Board) { board = b.Board; console.log('source', f); break; }
}
if (!board) { console.error('LocalTougeBoardAns 기록 없음'); process.exit(1); }
// 계정별 값: State, GoldCash, Open(기간으로 계산), 보유 표시(owned/p), RollBonus.given
const { State, GoldCash, Open, ...rest } = board;
rest.Pumpkin = (rest.Pumpkin ?? []).map(({ owned, p, ...x }) => x);
rest.Costumes = (rest.Costumes ?? []).map(({ owned, ...x }) => x);
if (rest.RollBonus) { const { given, ...rb } = rest.RollBonus; rest.RollBonus = rb; }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ _note: 'make-touge-board.cjs 로 생성 (실서버 LocalTougeBoardAns, 계정별 값 제외)', Board: rest }, null, 1));
console.log('wrote', OUT, Object.keys(rest).join(','));
