// 실기기 진단용 WebGL 추적 / 프레임 측정 스크립트 (index.html 에 주입, config client.glTrace).
//
// 왜 필요한가 (2026-11-01, SM-N981N / Adreno 650 / WebView 156):
//   차고 썸네일·강화 연출 등 여러 장면에서 같은 드라이버 지점(libGLESv2_adreno.so+0x198bc4)에서 SIGSEGV.
//   크래시는 GPU 스레드에서 비동기로 나므로 JS 쪽 '마지막 위치'만으로는 어느 GL 호출인지 알 수 없다.
//
// 'first' 모드: (컨텍스트, 연산, 셰이더 프로그램, 그리기 대상) 조합이 '처음' 나올 때만
//   1) 동기 XHR 로 서버(/__offline/gltrace)에 기록 → 크래시 전에 반드시 도착
//   2) 원래 호출 실행 후 gl.finish() 로 GPU 가 즉시 실행하게 함 → 크래시가 나면 바로 그 조합에서 난다
//   그래서 data/diag/gltrace.log 의 마지막 'first' 줄이 크래시를 일으킨 조합이다.
//   조합마다 한 번만 하므로 비용은 초반 수 초의 끊김 정도이고, 그 뒤에는 카운터 증가뿐이다.
// 'perf'  모드: 위 추적 없이 5초마다 FPS·프레임 시간·draw call 수만 보낸다(렉 측정).
// 두 모드 모두 perf 보고를 한다. 'off' 이면 아무것도 하지 않는다.
export const GL_TRACE = String.raw`(function(){try{
var MODE=window.__dgGlTrace;if(!MODE||MODE==='off')return;var TRACE=MODE==='first';
var URL_='/__offline/gltrace';
function post(o,sync){try{var s=JSON.stringify(o);if(sync){var x=new XMLHttpRequest();x.open('POST',URL_,false);x.setRequestHeader('content-type','text/plain');x.send(s);}else if(!navigator.sendBeacon(URL_,s)){fetch(URL_,{method:'POST',body:s,keepalive:true}).catch(function(){});}}catch(e){}}
function where(){return window.__dgWhere||'';}
var seen={},nSeen=0,ctxN=0,progN=0,fbN=0,draws=0,lastKey='';
var progs=new WeakMap(),fbs=new WeakMap();
var CTX=[];
function first(g,key,info){if(seen[key])return false;seen[key]=1;nSeen++;lastKey=key;
  var v=where()+' '+key;post({k:'first',v:v,n:nSeen,i:info||null,t:Date.now()},true);
  try{if(window.__dgRawNote)window.__dgRawNote('where',('gl '+key).slice(0,120));}catch(e){}
  return true;}
function wrap(g,canvas,type,attrs){if(g.__dgId)return;var id='c'+(++ctxN);g.__dgId=id;try{canvas.__dgCtx=id;}catch(e){}
  var st={prog:'-',fb:'scr'};CTX.push({id:id,canvas:canvas,g:g});
  post({k:'ctx',v:id+' '+type+' '+(canvas.width|0)+'x'+(canvas.height|0)+' '+JSON.stringify(attrs||{}),t:Date.now()},false);
  var P=Object.getPrototypeOf(g);function orig(n){return P[n];}
  var link=orig('linkProgram');g.linkProgram=function(p){var r=link.call(this,p);try{
      var sh=this.getAttachedShaders(p)||[],name='raw',defs=[],fs=0,vs=0;
      for(var i=0;i<sh.length;i++){var src=this.getShaderSource(sh[i])||'';var t=this.getShaderParameter(sh[i],this.SHADER_TYPE);
        if(t===this.FRAGMENT_SHADER)fs=src.length;else vs=src.length;
        var m=/#define SHADER_NAME (\S+)/.exec(src);if(m)name=m[1];
        if(t===this.FRAGMENT_SHADER){var re=/^#define ([A-Z_][A-Z0-9_]*)(?: (\S+))?$/gm,mm;while((mm=re.exec(src))&&defs.length<80){if(mm[1]!=='SHADER_NAME')defs.push(mm[2]?mm[1]+'='+mm[2]:mm[1]);}}}
      var lbl='p'+(++progN)+':'+name;progs.set(p,lbl);
      if(TRACE)post({k:'prog',v:id+' '+lbl,i:{fs:fs,vs:vs,defs:defs},t:Date.now()},false);}catch(e){}return r;};
  var use=orig('useProgram');g.useProgram=function(p){st.prog=p?(progs.get(p)||'p?'):'-';return use.call(this,p);};
  var bfb=orig('bindFramebuffer');g.bindFramebuffer=function(t,fb){if(t!==this.READ_FRAMEBUFFER){if(fb){var n=fbs.get(fb);if(!n){n='fb'+(++fbN);fbs.set(fb,n);}st.fb=n;}else st.fb='scr';}return bfb.call(this,t,fb);};
  function hook(name,keyf){var f=orig(name);if(typeof f!=='function')return;g[name]=function(){
      draws++;if(!TRACE)return f.apply(this,arguments);
      var k=id+'|'+name+'|'+(keyf?keyf.apply(this,arguments):st.prog+'|'+st.fb);
      if(!first(this,k))return f.apply(this,arguments);
      var r=f.apply(this,arguments);try{this.finish();}catch(e){}return r;};}
  ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced','drawRangeElements'].forEach(function(n){hook(n);});
  ['blitFramebuffer','readPixels','copyTexSubImage2D','copyTexImage2D','copyTexSubImage3D','generateMipmap','invalidateFramebuffer','renderbufferStorageMultisample','clear'].forEach(function(n){hook(n,function(){return st.fb;});});
  ['texImage2D','texSubImage2D'].forEach(function(n){hook(n,function(){var s=arguments[arguments.length-1];var tn=s&&s.constructor&&s.constructor.name||typeof s;if(s&&s.__dgCtx)tn+='<-'+s.__dgCtx;return st.fb+'|'+tn;});});
}
function wrapGet(proto){if(!proto||!proto.getContext)return;var gc=proto.getContext;proto.getContext=function(t,a){var g=gc.apply(this,arguments);
  try{if(g&&(t==='webgl2'||t==='webgl'||t==='experimental-webgl'))wrap(g,this,t,a);}catch(e){}return g;};}
wrapGet(window.HTMLCanvasElement&&HTMLCanvasElement.prototype);
wrapGet(window.OffscreenCanvas&&OffscreenCanvas.prototype);
if(TRACE&&window.CanvasRenderingContext2D){var di=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(s){
  if(s&&s.__dgCtx){var k='2d|drawImage<-'+s.__dgCtx;if(first(null,k)){var r=di.apply(this,arguments);try{this.getImageData(0,0,1,1);}catch(e){}return r;}}
  return di.apply(this,arguments);};}
// 프레임 측정: 5초마다 FPS, 최대/95% 프레임 시간, 프레임당 draw call, 긴 작업(>50ms) 합계
var frames=[],last=0,longMs=0,longN=0,t0=performance.now();
try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){longMs+=e.duration;longN++;});}).observe({entryTypes:['longtask']});}catch(e){}
function tick(now){if(last)frames.push(now-last);last=now;
  if(now-t0>=5000){var a=frames.slice().sort(function(x,y){return x-y;});var n=a.length;
    var big=null;for(var i=0;i<CTX.length;i++){var c=CTX[i].canvas;var px=(c.width|0)*(c.height|0);if(!big||px>big.px)big={id:CTX[i].id,w:c.width|0,h:c.height|0,px:px};}
    post({k:'perf',v:where(),i:{fps:Math.round(n*1000/(now-t0)),p50:n?+a[n>>1].toFixed(1):0,p95:n?+a[Math.floor(n*0.95)].toFixed(1):0,max:n?+a[n-1].toFixed(1):0,
      drawsPerFrame:n?Math.round(draws/n):0,longN:longN,longMs:Math.round(longMs),dpr:window.devicePixelRatio,css:innerWidth+'x'+innerHeight,canvas:big&&(big.id+' '+big.w+'x'+big.h),ctxs:CTX.length,glFirst:nSeen},t:Date.now()},false);
    frames=[];draws=0;longMs=0;longN=0;t0=now;}
  requestAnimationFrame(tick);}
requestAnimationFrame(tick);
}catch(e){}})();`;
