// 경로 설정 (2026-11-09, PC 이관용): 오프라인 서버 폴더를 찾는다.
//   DG_SERVER_DIR 환경 변수 > 저장소 배치(tools/dg-bot 기준 ../../offline-server) > 예전 클라우드 경로.
//   파이썬 실행 파일은 DG_PYTHON (기본: Windows 'python', 그 밖 'python3'). Pillow 필요.
const path = require('path'), fs = require('fs'), { pathToFileURL } = require('url');
const cand = [process.env.DG_SERVER_DIR, path.resolve(__dirname, '../../offline-server'), path.resolve(__dirname, '../offline-server'), '/home/user/Github-sibal/offline-server'].filter(Boolean);
const SERVER = cand.find((d) => fs.existsSync(path.join(d, 'data', 'tables'))) ?? cand[0];
// 표 읽기 + content.json 표 패치 적용 (offline-server src/upserts.ts 와 같은 방식). 클라이언트는 패치한 표를 쓴다.
//   2026-11-14: 패치로만 오는 부품(XP 부스터 38701~38704 분류 8, ★6 부품 376xx~386xx)을 원본 parts.json 만 읽은 봇이 몰라서
//   부품 칸 계산에서 빠졌다 -> 클라이언트는 미장착 22 / 16칸으로 보고 이벤트 시작을 막았는데 봇은 14 / 16칸으로 보았다.
let contentTables = null;
function table(name) {
  const t = JSON.parse(fs.readFileSync(path.join(SERVER, 'data', 'tables', name), 'utf8'));
  if (contentTables === null) { try { contentTables = JSON.parse(fs.readFileSync(path.join(SERVER, 'data', 'content.json'), 'utf8')).tables ?? []; } catch { contentTables = []; } }
  const base = name.replace(/\.json$/, '');
  for (const u of contentTables) {
    if (u?.table !== base || !Array.isArray(u.upsert) || !u.part) continue;
    const keys = Array.isArray(u.key) ? u.key : [u.key];
    const arr = Array.isArray(t[u.part]) ? t[u.part] : (t[u.part] = []);
    for (const r of u.upsert) { const i = arr.findIndex((x) => keys.every((k) => String(x?.[k]) === String(r?.[k]))); if (i >= 0) arr[i] = { ...arr[i], ...r }; else arr.push(r); }
  }
  return t;
}
module.exports = {
  SERVER, table,
  srv: (...p) => path.join(SERVER, ...p),
  url: (...p) => pathToFileURL(path.join(SERVER, ...p)).href,
  PY: process.env.DG_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
};
