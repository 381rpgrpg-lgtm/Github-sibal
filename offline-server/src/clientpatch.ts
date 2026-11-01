// 웹 클라이언트 호환성 패치 (서빙 시점 적용, 원본 파일은 그대로 둔다).
//
// 배경 (2026-11-01, 실기기 진단 기록 data/diag):
//   SM-N981N / Android 13 / Adreno 650 / WebView 156 에서 차고 진입 시
//   SIGSEGV in libGLESv2_adreno.so, 스레드 Chrome_InProcGpuThread, 직전 위치 "MYGARAGE>carpic:shared-draw".
//   클라이언트 pictureMode()는 Android 앱에서 (안전모드 단계 >= 1 || isOldAdreno(/Adreno [56]xx/)) 이면
//   차량 썸네일을 메인 렌더러로 그리는 'shared' 방식을 고르는데, 이 기기에서는 그 방식이 드라이버를 죽인다.
//
// 패치: pictureMode() 앞에 설정 스위치를 넣는다. globalThis.__dgPictureMode 가 'own'|'shared' 이면 그 값을 쓴다.
//   값은 index.html 에 주입한다 (config.json client.pictureMode: auto|own|shared).
//
// 앱(APK) ClientCache 는 /api/client 의 sha256 으로 파일을 검증하고 build 가 바뀔 때만 다시 받으므로,
// 패치된 내용 기준으로 매니페스트 해시를 다시 계산하고 build 에 패치 표식을 붙인다.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface PatchedClient {
  build: string | null;               // 패치 표식이 붙은 build (앱/매니페스트용)
  files: Map<string, Buffer>;          // 상대경로(index.html, static/xxx.js) -> 패치된 내용
  manifest: any | null;                // 패치 반영된 /api/client
  applied: string[];                   // 적용된 패치 설명
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// pictureMode 함수 머리: function <name>({env:<a>=globalThis,gpu:<b>=<f>(()=>'','gpu')}={}){return
const PICTURE_MODE_RE = /(function\s+[\w$]+\(\{env:[\w$]+=globalThis,gpu:[\w$]+=[\w$]+\(\(\)=>'','gpu'\)\}=\{\}\)\{)(return\s+[\w$]+\([\w$]+\)&&\()/;

export function buildPatchedClient(clientDir: string, opts: { pictureMode: string }): PatchedClient {
  const out: PatchedClient = { build: null, files: new Map(), manifest: null, applied: [] };
  const mfPath = join(clientDir, 'api-client.json');
  if (!existsSync(mfPath)) return out;
  const manifest = JSON.parse(readFileSync(mfPath, 'utf8'));
  const mode = ['own', 'shared'].includes(opts.pictureMode) ? opts.pictureMode : 'auto';

  // 1) pictureMode 스위치 (engine-*.js)
  const staticDir = join(clientDir, 'static');
  if (existsSync(staticDir)) {
    for (const name of readdirSync(staticDir)) {
      if (!/^engine-.*\.js$/.test(name)) continue;
      const src = readFileSync(join(staticDir, name), 'utf8');
      if (!PICTURE_MODE_RE.test(src)) continue;
      const patched = src.replace(PICTURE_MODE_RE,
        `$1{const __m=globalThis.__dgPictureMode;if(__m==='own'||__m==='shared')return __m;}$2`);
      out.files.set(`static/${name}`, Buffer.from(patched, 'utf8'));
      out.applied.push(`pictureMode switch -> static/${name}`);
    }
  }

  // 2) index.html 에 설정값 주입
  const indexPath = join(clientDir, 'index.html');
  if (existsSync(indexPath) && mode !== 'auto') {
    const html = readFileSync(indexPath, 'utf8');
    const inject = `<script>window.__dgPictureMode=${JSON.stringify(mode)};</script>`;
    out.files.set('index.html', Buffer.from(html.replace('<head>', '<head>' + inject), 'utf8'));
    out.applied.push(`index.html: __dgPictureMode=${mode}`);
  }

  // 3) 매니페스트 해시·build 갱신
  if (out.files.size) {
    const tag = sha(Buffer.from(out.applied.join('|'))).slice(0, 8);
    manifest.build = `${manifest.build}-p${tag}`;
    for (const f of manifest.files ?? []) {
      const b = out.files.get(String(f.path).replace(/^\//, ''));
      if (b) { f.sha256 = sha(b); f.size = b.length; }
    }
  }
  out.build = manifest.build ?? null;
  out.manifest = manifest;
  return out;
}
