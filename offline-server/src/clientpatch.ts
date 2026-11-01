// 웹 클라이언트 호환성 패치 (서빙 시점 적용, 원본 파일은 그대로 둔다).
//
// 배경 (2026-11-01, 실기기 진단 기록 data/diag):
//   SM-N981N / Android 13 / Adreno 650 / WebView 156 에서 차고 진입 시
//   SIGSEGV in libGLESv2_adreno.so, 스레드 Chrome_InProcGpuThread, 직전 위치 "MYGARAGE>carpic:shared-draw".
//   클라이언트 pictureMode()는 Android 앱에서 (안전모드 단계 >= 1 || isOldAdreno(/Adreno [56]xx/)) 이면
//   차량 썸네일을 메인 렌더러로 그리는 'shared' 방식을 고르는데, 이 기기에서는 그 방식이 드라이버를 죽인다.
//
// 패치: pictureMode() 앞에 설정 스위치를 넣는다. globalThis.__dgPictureMode 가 'own'|'shared' 이면 그 값을 쓴다.
//   'off' 이면 CarImageManager.warmUp/render 가 아무것도 그리지 않고 null 을 돌려준다(호출부는 모두 null 을 무시).
//   값은 index.html 에 주입한다 (config.json client.pictureMode: auto|own|shared|off).
//   2026-11-01 실기기: shared → 차고에서 드라이버 크래시, own → 두 번째 로딩(warmUp 전용 렌더러 생성)에서 크래시(정황).
//
// 진단 보조: 앱 브리지 DGAndroid.note('where'|'gpu', …) 호출을 서버 /__offline/where 로도 보낸다(sendBeacon).
//   앱은 크래시 기록을 '화면 표시 15초 후'에만 보내므로, 그 전에 반복해서 죽으면 기록이 오지 않는다.
//
// 앱(APK) ClientCache 는 /api/client 의 sha256 으로 파일을 검증하고 build 가 바뀔 때만 다시 받으므로,
// 패치된 내용 기준으로 매니페스트 해시를 다시 계산하고 build 에 패치 표식을 붙인다.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// DGAndroid 브리지를 감싸 note('where'|'gpu') 를 서버에도 보낸다. 다른 메서드는 원본 그대로 위임.
const WHERE_BEACON = `(function(){try{var A=window.DGAndroid;if(!A||typeof Proxy!=='function')return;var last='';
var send=function(k,v){try{if(k==='where'&&v===last)return;if(k==='where')last=v;navigator.sendBeacon('/__offline/where',JSON.stringify({k:k,v:String(v),t:Date.now()}));}catch(e){}};
window.DGAndroid=new Proxy(A,{get:function(o,p){var f=o[p];if(p==='note')return function(k,v){send(k,v);return f.call(o,k,v);};return typeof f==='function'?f.bind(o):f;}});
send('boot','page');}catch(e){}})();`;

export interface PatchedClient {
  build: string | null;               // 패치 표식이 붙은 build (앱/매니페스트용)
  files: Map<string, Buffer>;          // 상대경로(index.html, static/xxx.js) -> 패치된 내용
  manifest: any | null;                // 패치 반영된 /api/client
  applied: string[];                   // 적용된 패치 설명
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// pictureMode 함수 머리: function <name>({env:<a>=globalThis,gpu:<b>=<f>(()=>'','gpu')}={}){return
const WARMUP_RE = /async\['warmUp'\]\([\w$]+\)\{/;
const RENDER_RE = /\['render'\]\([\w$]+,[\w$]+,[\w$]+,[\w$]+=0x0,[\w$]+=0x0,\{yaw:[^}]*\}=\{\}\)\{/;
const PICTURE_MODE_RE = /(function\s+[\w$]+\(\{env:[\w$]+=globalThis,gpu:[\w$]+=[\w$]+\(\(\)=>'','gpu'\)\}=\{\}\)\{)(return\s+[\w$]+\([\w$]+\)&&\()/;

export function buildPatchedClient(clientDir: string, opts: { pictureMode: string }): PatchedClient {
  const out: PatchedClient = { build: null, files: new Map(), manifest: null, applied: [] };
  const mfPath = join(clientDir, 'api-client.json');
  if (!existsSync(mfPath)) return out;
  const manifest = JSON.parse(readFileSync(mfPath, 'utf8'));
  const mode = ['own', 'shared', 'off'].includes(opts.pictureMode) ? opts.pictureMode : 'auto';

  // 1) pictureMode 스위치 (engine-*.js)
  const staticDir = join(clientDir, 'static');
  if (existsSync(staticDir)) {
    for (const name of readdirSync(staticDir)) {
      if (!/^engine-.*\.js$/.test(name)) continue;
      const src = readFileSync(join(staticDir, name), 'utf8');
      if (!PICTURE_MODE_RE.test(src)) continue;
      let patched = src.replace(PICTURE_MODE_RE,
        `$1{const __m=globalThis.__dgPictureMode;if(__m==='own'||__m==='shared')return __m;}$2`);
      // 'off': 차량 썸네일 렌더링 생략
      patched = patched.replace(WARMUP_RE, `$&if(globalThis.__dgPictureMode==='off')return;`);
      patched = patched.replace(RENDER_RE, `$&if(globalThis.__dgPictureMode==='off')return Promise.resolve(null);`);
      out.files.set(`static/${name}`, Buffer.from(patched, 'utf8'));
      out.applied.push(`pictureMode switch -> static/${name}`);
    }
  }

  // 2) index.html 에 설정값 주입
  const indexPath = join(clientDir, 'index.html');
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, 'utf8');
    const inject = `<script>window.__dgPictureMode=${JSON.stringify(mode)};${WHERE_BEACON}</script>`;
    out.files.set('index.html', Buffer.from(html.replace('<head>', '<head>' + inject), 'utf8'));
    out.applied.push(`index.html: __dgPictureMode=${mode}, where-beacon`);
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
