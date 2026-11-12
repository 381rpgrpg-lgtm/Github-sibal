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
import { GL_TRACE } from './gltrace.js';

// DGAndroid 브리지를 감싸 note('where'|'gpu') 를 서버에도 보낸다. 다른 메서드는 원본 그대로 위임.
const WHERE_BEACON = `(function(){try{var A=window.DGAndroid;if(!A||typeof Proxy!=='function')return;var last='';
var send=function(k,v){try{if(k==='where'){window.__dgWhere=String(v);if(v===last)return;last=v;}navigator.sendBeacon('/__offline/where',JSON.stringify({k:k,v:String(v),t:Date.now()}));}catch(e){}};
window.__dgRawNote=function(k,v){try{A.note(k,v);}catch(e){}};
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
// 브라우저(PWA) 뒤로가기: 원본 APK(MainActivity.onBackPressed)는 페이지에 Escape keydown/keyup 을 보내 게임의 '뒤로'를 실행한다.
// 브라우저에서는 뒤로가기가 바로 앱을 닫으므로, history 항목 하나를 깔아 두고 popstate 때 같은 Escape 이벤트를 보낸 뒤 다시 깐다.
const BACK_SHIM = `(function(){try{if(window.DGAndroid||window.driftGirlsAndroid||!history.pushState)return;
var arm=function(){try{history.pushState({dgBack:1},'');}catch(e){}};
var esc=function(){var t=document.activeElement||document.body||document.documentElement;var o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};
t.dispatchEvent(new KeyboardEvent('keydown',o));t.dispatchEvent(new KeyboardEvent('keyup',o));};
window.addEventListener('popstate',function(){esc();arm();});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',arm);else arm();}catch(e){}})();`;

// 강화·합성 3D 연출 (index-*.js). 'off' 이면 연출 없이 바로 결과 화면으로 간다.
//   강화 결과 화면(CarUpgradeResult.IShowResult)은 effect.playing 이 꺼지면(최대 5초 대기) 결과를 표시하고,
//   합성(CombinationEffectStart)은 연출 Promise 가 끝나면 결과 팝업을 띄우므로 바로 반환해도 흐름이 그대로다.
//   2026-11-01 실기기: 튜토리얼 강화 직후 이 연출(메인 렌더러에 ModelHigh 차량 + 파티클)에서 같은 Adreno 크래시.
//   메서드 이름은 빌드마다 'playReinforceEffect' 그대로이거나 난독화 호출 [a9p(0x3de0)] 이다 (2026-11-12 빌드 ba9d47e4: 둘 다 난독화).
//   인자 구조분해 {carTop,makeCar,effect} / {carLeft,carRight,makeCar} 로 찾는다 (지금까지 7개 index-*.js 모두 각 1건).
const FX_NAME = (lit: string) => String.raw`async(?:\['${lit}'\]|\[[\w$]+\(0x[0-9a-f]+\)\])`;
const REINFORCE_FX_RE = new RegExp(FX_NAME('playReinforceEffect') + String.raw`\(\{carTop:[\w$]+,makeCar:[\w$]+,effect:[\w$]+\}\)\{`);
const COMBINE_FX_RE = new RegExp(FX_NAME('playCombinationEffect') + String.raw`\(\{carLeft:[\w$]+,carRight:[\w$]+,makeCar:[\w$]+\}\)\{`);
const PICTURE_MODE_RE = /(function\s+[\w$]+\(\{env:[\w$]+=globalThis,gpu:[\w$]+=[\w$]+\(\(\)=>'','gpu'\)\}=\{\}\)\{)(return\s+[\w$]+\([\w$]+\)&&\()/;

export interface PatchOptions { pictureMode: string; carEffects?: string; glTrace?: string; appOnly?: boolean }

export function buildPatchedClient(clientDir: string, opts: PatchOptions): PatchedClient {
  const out: PatchedClient = { build: null, files: new Map(), manifest: null, applied: [] };
  const mfPath = join(clientDir, 'api-client.json');
  if (!existsSync(mfPath)) return out;
  const manifest = JSON.parse(readFileSync(mfPath, 'utf8'));
  const mode = ['own', 'shared', 'off'].includes(opts.pictureMode) ? opts.pictureMode : 'auto';
  const carFx = opts.carEffects === 'off' ? 'off' : 'on';
  const glTrace = ['first', 'perf'].includes(String(opts.glTrace)) ? String(opts.glTrace) : 'off';

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

  // 1b) 강화·합성 3D 연출 스위치 (index-*.js)
  if (existsSync(staticDir)) {
    for (const name of readdirSync(staticDir)) {
      if (!/^index-.*\.js$/.test(name)) continue;
      const src = readFileSync(join(staticDir, name), 'utf8');
      if (!REINFORCE_FX_RE.test(src)) continue;
      const guard = `if(globalThis.__dgCarFx==='off')return;`;
      let patched = src.replace(REINFORCE_FX_RE, `$&${guard}`);
      patched = patched.replace(COMBINE_FX_RE, `$&${guard}`);
      out.files.set(`static/${name}`, Buffer.from(patched, 'utf8'));
      out.applied.push(`carEffects switch -> static/${name}`);
    }
  }

  // 2) index.html 에 설정값 주입
  const indexPath = join(clientDir, 'index.html');
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, 'utf8');
    // appOnly(기본): 썸네일·연출 우회는 앱(WebView, DGAndroid 있음)에서만. Chrome 등 브라우저는 원본 동작(auto/on).
    const app = opts.appOnly === false ? 'true' : '!!(window.DGAndroid||window.driftGirlsAndroid)';
    const inject = `<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#000000">`
      + `<meta name="mobile-web-app-capable" content="yes">`
      + `<script>(function(){var A=${app};window.__dgPictureMode=A?${JSON.stringify(mode)}:'auto';`
      + `window.__dgCarFx=A?${JSON.stringify(carFx)}:'on';})();`
      + `window.__dgGlTrace=${JSON.stringify(glTrace)};${WHERE_BEACON}${GL_TRACE}${BACK_SHIM}</script>`;
    out.files.set('index.html', Buffer.from(html.replace('<head>', '<head>' + inject), 'utf8'));
    out.applied.push(`index.html: __dgPictureMode=${mode}, __dgCarFx=${carFx} (${opts.appOnly === false ? 'all' : 'app only'}), __dgGlTrace=${glTrace}, where-beacon, manifest, back-key`);
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
