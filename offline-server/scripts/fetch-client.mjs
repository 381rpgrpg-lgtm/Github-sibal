// 평문 웹 클라이언트(/, /api/client, /static/*)를 data/client/ 에 내려받는다.
// 암호화 팩(/a/.../pack)은 받지 않는다. 앱 User-Agent 가 필요(서버가 브라우저 UA는 거부).
// 사용: node scripts/fetch-client.mjs
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
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
// 매니페스트에는 index.html 같은 static/ 밖 항목도 있다(이미 위에서 저장). static/ 만 받는다.
const statics = list.filter((f) => String(f.path).replace(/^\//, '').startsWith('static/'));
let done = 0, bytes = 0, skip = 0;
const failed = [];
for (const f of statics) {
  const rel = String(f.path).replace(/^\//, '');
  const p = join(OUT, rel);
  if (existsSync(p) && (!f.size || statSync(p).size === f.size)) { skip++; continue; }
  try {
    const buf = await get('/' + rel);
    save(rel, buf);
    done++; bytes += buf.length;
  } catch (e) {
    failed.push(`${rel} (${e.message})`);
  }
  if ((done + failed.length) % 25 === 0) console.log(`  ${done + skip + failed.length}/${statics.length} (${(bytes / 1048576).toFixed(1)}MB)`);
}
console.log(`완료: 신규 ${done}, 기존 ${skip}, 실패 ${failed.length} / static ${statics.length}개, 총 ${(bytes / 1048576).toFixed(1)}MB. (암호화 팩 제외)`);
if (failed.length) {
  console.log('실패 목록 (다시 실행하면 이것만 재시도):');
  for (const x of failed) console.log('  ' + x);
  process.exitCode = 1;
}
