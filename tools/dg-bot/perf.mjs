// 차량 x 동승 캐릭터 조합별 총 성능 (오프라인 서버 gamecalc.finalAttr: 실기록과 일치 검증된 계산). node perf.mjs <ud.json> [위 몇 개]
import { readFileSync } from 'node:fs';
const { finalAttr } = await import('/home/user/Github-sibal/offline-server/dist/gamecalc.js');
const ud = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const top = Number(process.argv[3]) || 5;
const sum = (a) => Object.values(a).reduce((x, y) => x + (Number(y) || 0), 0);
const girls = [-1, ...(ud.MyGirls?.MyGirlInfo ?? []).filter((g) => g.State === 7).map((g) => g.Girlid)];
const rows = [];
for (const car of ud.Cars?.CarInfo ?? []) for (const gid of girls) {
  const snap = { ...ud, UserInfo: { ...ud.UserInfo, PassengerGirl: gid } };
  rows.push({ car: car.Carid, grade: car.Grade, lv: car.UpgradeLevel, girl: gid, perf: sum(finalAttr(snap, car)) });
}
rows.sort((a, b) => b.perf - a.perf);
const cur = rows.find((r) => r.car === ud.UserInfo.Currentcar && r.girl === Number(ud.UserInfo.PassengerGirl));
console.log(JSON.stringify({ best: rows.slice(0, top), current: cur }));
