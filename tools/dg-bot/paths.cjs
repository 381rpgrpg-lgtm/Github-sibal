// 경로 설정 (2026-11-09, PC 이관용): 오프라인 서버 폴더를 찾는다.
//   DG_SERVER_DIR 환경 변수 > 저장소 배치(tools/dg-bot 기준 ../../offline-server) > 예전 클라우드 경로.
//   파이썬 실행 파일은 DG_PYTHON (기본: Windows 'python', 그 밖 'python3'). Pillow 필요.
const path = require('path'), fs = require('fs'), { pathToFileURL } = require('url');
const cand = [process.env.DG_SERVER_DIR, path.resolve(__dirname, '../../offline-server'), path.resolve(__dirname, '../offline-server'), '/home/user/Github-sibal/offline-server'].filter(Boolean);
const SERVER = cand.find((d) => fs.existsSync(path.join(d, 'data', 'tables'))) ?? cand[0];
module.exports = {
  SERVER,
  srv: (...p) => path.join(SERVER, ...p),
  url: (...p) => pathToFileURL(path.join(SERVER, ...p)).href,
  PY: process.env.DG_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
};
