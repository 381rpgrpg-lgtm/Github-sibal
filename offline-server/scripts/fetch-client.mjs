// 평문 웹 클라이언트(/, /api/client, /static/*)를 data/client/ 에 내려받는다.
// 암호화 팩(/a/.../pack)은 받지 않는다. 앱 User-Agent 가 필요(서버가 브라우저 UA는 거부).
// 사용: node scripts/fetch-client.mjs
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const BASE = cfg.upstream;
const UA = 'DriftGirlsReborn/1.0.4 (Android 14)';
const OUT = new URL('../data/client/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

async function get(path) {
  const r = await fetch(BASE + path, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
function save(rel, buf) {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
}

const index = await get('/');
save('index.html', index);
const manifest = await get('/api/client');
save('api-client.json', manifest);
const list = JSON.parse(manifest.toString('utf8')).files || [];
console.log(`index.html + 매니페스트 OK. static 파일 ${list.length}개 다운로드...`);
let done = 0, bytes = 0, skip = 0;
for (const f of list) {
  const rel = f.path.startsWith('static/') ? f.path : 'static/' + f.path.replace(/^\//, '');
  const p = join(OUT, rel);
  if (existsSync(p)) { skip++; continue; }
  const buf = await get('/static/' + rel.replace(/^static\//, ''));
  save(rel, buf);
  done++; bytes += buf.length;
  if (done % 25 === 0) console.log(`  ${done}/${list.length} (${(bytes / 1048576).toFixed(1)}MB)`);
}
console.log(`완료: 신규 ${done}, 기존 ${skip}, 총 ${(bytes / 1048576).toFixed(1)}MB. (암호화 팩 제외)`);
