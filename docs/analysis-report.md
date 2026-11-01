# Drift Girls Reborn APK 분석 및 재구성 보고서

- 대상: `DriftGirlsReborn.apk` (1,092,509 bytes, sha256 `d413274c…6859`. 서버 `/android/version.json`의 값과 일치)
- 도구: apktool 2.12.1, jadx 1.5.3, curl (앱 User-Agent 사용)
- 한계: 이 환경에는 KVM이 없어 Android 에뮬레이터를 실행하지 못했습니다. 따라서 **실제 크래시는 재현하지 못했습니다.** 아래 내용은 정적 분석과 서버 응답 확인에 근거합니다.

## 1. 확인된 사실

| 항목 | 값 |
|---|---|
| 패키지 / 버전 | `com.driftgirlsreborn.app` 1.0.4 (versionCode 5), classes.dex 빌드 일시 2026-10-20 |
| SDK | minSdk 24, targetSdk 35, compileSdk 35 |
| 네이티브 라이브러리 | 없음 (`lib/` 없음). 32/64비트 문제와 16KB 페이지 문제는 해당 없음 |
| 권한 | INTERNET, ACCESS_NETWORK_STATE, REQUEST_INSTALL_PACKAGES. 저장소 권한 없음 |
| 네트워크 | HTTPS 전용 (`usesCleartextTraffic=false`) |
| 저장 위치 | `filesDir/client`(게임 클라이언트 캐시), `filesDir/packs`(추가 데이터 `.dgp`). 앱 전용 저장소 |
| 화면 구성 | Activity 1개에 WebView 2개. 게임 WebView는 `https://game.driftgirlsreborn.com/`를 로드하고, 오버레이 WebView는 `appassets.androidplatform.net/shell/`에서 로딩·팝업 UI를 그림 |
| 게임 | Vite 번들(난독화), three.js r170, WebGL2 |
| 서버 상태 (2026-10-31) | `/` 200, `/api/client` 200 (build `be2b9e4…`, 파일 253개, 52.7MB. 과거 빌드 포함), `/android/version.json` 200. 앱 UA가 아니면 `launcher_only`로 거부 |
| 추가 데이터 | JS가 `DGAndroid.syncPacks(manifest)`를 호출 → `PackStore`가 `/a/<…>/pack/<id>.dgp`를 이어받기와 SHA-256 검증을 하며 받음 → `shouldInterceptRequest`로 Range 응답 제공. 매니페스트가 세션(로그인)에 묶여 있어 용량은 확인하지 못함 |

**결론:** 이 APK는 "옛 targetSdk 앱이 최신 Android에서 깨지는" 경우가 아닙니다. targetSdk 35, scoped storage, HTTPS, 64비트 등 최신 기준을 이미 충족합니다. 그러므로 원인은 **WebView 위에서 WebGL을 실행하는 구조 자체**에 있을 가능성이 높습니다.

## 2. 크래시 원인 분석

### 2-1. 앱 스스로 이미 인지하고 있는 원인 (코드로 확인)
- `CrashGuard`와 호환 모드 팝업 문구: *"The game closed by itself several times on this phone (its graphics driver)"*
- `Diag.noteExitReasons()`는 `ApplicationExitInfo`의 `crash_native` 톰스톤(signal, faultAddr, frames)을 수집해 `/android/diag`로 전송합니다.
- 서버의 1.0.4 릴리스 노트: *"a Compatibility mode for phones whose graphics driver crashes"*

즉 관찰된 증상은 **앱 프로세스 전체가 네이티브 크래시로 종료되는 것**이고, 주된 의심 대상은 GPU 드라이버입니다. `onRenderProcessGone`(렌더러만 죽는 경우)은 이미 복구 처리가 되어 있습니다.

### 2-2. 원인 가설 (추론이며 검증 필요)
1. **WebView의 GPU 작업은 앱 프로세스 안에서 실행됨.** Chrome은 GPU 프로세스가 따로 있어서 드라이버가 죽어도 `webglcontextlost`로 끝납니다. WebView는 같은 크래시가 앱 전체를 종료시킬 수 있습니다. 동일 콘텐츠가 Chrome에서는 되고 WebView에서만 실패하는 2026년 7월 보고(Pixel 8, Android 16, WebView 150/152)도 있습니다. 다만 이 보고에서 근본 원인은 밝혀지지 않았습니다.
2. **GPU 부하 요인 (엔진 코드로 확인됨)**
   - WebGL 컨텍스트가 2개 존재: 메인 렌더러(`powerPreference:'high-performance'`)와 보조 렌더러(`alpha:true`, `preserveDrawingBuffer:true`). `preserveDrawingBuffer:true`는 모바일 타일 GPU에서 메모리와 대역폭을 크게 늘립니다.
   - 오버레이 WebView까지 합치면 GPU를 쓰는 표면이 3개입니다.
3. **추가 다운로드가 Activity의 일반 Thread(`dg-packs`)에서 실행됨.** 앱이 백그라운드로 가면 Android 14 이상의 cached-app freezer나 LMK에 의해 중단될 수 있습니다. `Diag.exitReason`에 `freezer`(14)가 등록되어 있는 것도 이를 뒷받침합니다. `.part` 파일로 이어받기는 되지만 최초 다운로드 체감 품질이 떨어집니다.
4. 부수적인 문제
   - `ClientCache.STATIC` 정규식이 하위 폴더(`static/reborn-ui/*.png`)를 허용하지 않아 이 파일들은 오프라인 캐시에서 빠집니다.
   - 오버레이 렌더러가 죽으면 게임 WebView까지 함께 재시작됩니다.

※ `PackStore`의 Range 응답이 스트림을 0에서 시작하는 것은 버그가 아닙니다. WebView가 요청 시작 오프셋만큼 `skip()`을 호출하기 때문입니다.

## 3. 재구성 방안

### 0단계: 실측 (가장 먼저 할 일)
- 서버의 `/android/diag` 수집 로그에서 `reason`, `signal`, `frames`의 최상위 라이브러리(`libGLES_mali`, `vulkan.*`, `libwebviewchromium` 등), 그리고 기기·Android·WebView 버전 분포를 집계합니다.
- 또는 문제가 생기는 기기에서 `adb logcat -b crash`와 `adb bugreport`를 수집합니다.
- 이 결과에 따라 아래 1단계의 A, B, C 중 무엇을 할지 정해집니다.

### 1단계: 원인별 대응
| 원인 | 대응 | 비용 |
|---|---|---|
| A. GPU 드라이버 네이티브 크래시 | (1) 게임 Activity를 `android:process=":game"`으로 분리해서, 셸 프로세스가 살아남아 재시작·호환 모드를 안내하게 함 (2) 보조 렌더러의 `preserveDrawingBuffer` 제거 또는 필요할 때만 생성, 동시 WebGL 컨텍스트를 1개로 축소, 모바일 DPR 상한 설정 (3) 그래도 해결되지 않으면 런타임 교체(아래 대안) | 낮음~중간 |
| B. 렌더러 OOM (`crash=false`, `low_memory`) | 텍스처 KTX2/Basis 압축(엔진에 로더 존재), 해상도 단계 조정, 씬 전환 시 해제 | 중간 |
| C. 다운로드 중 중단 (`freezer`, 백그라운드 종료) | `PackStore`를 WorkManager로 이전하고 장시간 작업 시 foreground service(`dataSync`)로 실행. Android 13 이상은 `POST_NOTIFICATIONS` 요청, 14 이상은 `foregroundServiceType` 선언 필요 | 중간 |

### 런타임 교체 대안 (A가 해결되지 않을 때)
- **TWA (Chrome)**: GPU 프로세스가 분리되어 있습니다. 하지만 `DGAndroid` 브리지와 `shouldInterceptRequest`를 쓸 수 없으므로 팩과 캐시를 Service Worker와 OPFS/Cache Storage로 옮겨야 하고, 서버의 UA 차단도 조정해야 합니다. Chrome 설치가 전제입니다.
- **GeckoView**: Android에서 GPU 프로세스를 지원합니다(Firefox 100 이후 릴리스에 탑재). APK가 수십 MB 늘어나며, 브리지는 WebExtension 메시징으로 재작성해야 합니다.

### 배포
- 지금은 사이드로드 배포를 유지하면 됩니다. 셸이 이미 Play 기술 기준(targetSdk 35, HTTPS, 앱 전용 저장소)에 거의 맞습니다.
- 나중에 Play로 갈 경우의 차이:
  - 자체 업데이터(`ShellUpdater` + `REQUEST_INSTALL_PACKAGES`)는 Play 정책상 제거해야 합니다.
  - AAB로 빌드해야 하고, 그 시점의 targetSdk 요구치(매년 8월 상향)를 맞춰야 합니다.
  - 서명 키는 지금 키를 계속 유지하세요. 키가 바뀌면 기존 사용자는 업데이트가 아니라 재설치를 해야 합니다.

## 4. 진행 상황 (2026-10-31)
- 사용자 답변: 앱을 수정하지 않으면 로그를 얻을 수 없음 (`Android/data` 폴더 접근 불가). 크래시는 **게임 화면 진입 또는 플레이 중**에 발생.
- 그래서 0단계용으로 진단 APK를 만들었습니다 (`diag-build/`). 원본 dex 대비 변경은 명령어 1개이며 서명 검증(v2/v3)을 통과했습니다.
- **실기기 실행은 아직 검증하지 않았습니다.** 이 환경에는 에뮬레이터가 없습니다.
- 다음 단계: 수집된 JSON에서 톰스톤을 해석해 원인을 A(GPU 드라이버), B(메모리 부족), C(백그라운드 중단) 중 하나로 확정하고, 3장의 해당 대응을 적용합니다.


## 5. 크래시 원인 확정 (2026-11-01, 실기기 진단 기록)
- 기기: Samsung SM-N981N (Galaxy Note20 5G), Android 13, WebView 156.0.8078.47, GPU **Adreno 650**
- 종료: `crash_native` SIGSEGV / SEGV_MAPERR, 프레임 #00 `libGLESv2_adreno.so`, 스레드 `Chrome_InProcGpuThread`
- 직전 위치: `MYGARAGE>carpic:shared-draw`, 메모리 PSS 155MB (메모리 부족 아님)
- 해석: WebView 의 GPU 작업은 앱 프로세스 안(InProcGpuThread)에서 돈다 → 드라이버 크래시가 앱 전체 종료로 이어짐 (가설 A 확정)
- 코드 원인: 클라이언트 `pictureMode()` 가 Android 앱에서 `안전모드 단계>=1 || isOldAdreno(/Adreno [56]xx/)` 이면
  차량 썸네일을 메인 렌더러로 그려 읽어오는 `shared` 방식을 선택. 이 기기에서는 그 방식이 Adreno 드라이버를 죽인다.
  크래시 후 앱이 켜는 안전모드도 `shared` 조건이라 재실행해도 같은 지점에서 다시 크래시.
- 조치: 오프라인 서버가 클라이언트를 서빙할 때 `pictureMode()` 앞에 스위치를 넣는다(`offline-server/src/clientpatch.ts`,
  `config.json client.pictureMode`). 실기기 검증 대기.
- 1차 시도 `own`(전용 렌더러): 두 번째 로딩에서 튕김. 진단 기록은 '화면 표시 15초 후' 전송이라 미수신, 정황상
  로딩 중 `warmUp` 이 전용 WebGL 렌더러를 만들 때 크래시(외주사가 Adreno 5xx/6xx 에 shared 를 강제한 이유로 추정).
- 2차 조치 `off`: 차량 썸네일 렌더링을 생략(호출부는 null 을 무시하므로 썸네일만 빈다). 기본값.
- 진단 보조: 클라이언트 위치 표식(DGAndroid.note where/gpu)을 서버 `/__offline/where` 로도 보내 `data/diag/where.log` 에 기록.

### 5-1. 3차 실기기 결과 (2026-11-01, `off` 적용 후)
- 진단 zip: 크래시 5건이 **모두 같은 드라이버 지점** `libGLESv2_adreno.so+0x198bc4`, 스레드 `Chrome_InProcGp`
  - `MYGARAGE>carpic:shared-draw` 2건(원본 방식), `EMPTY>carpic:copy`·`EMPTY>carpic:draw` 각 1건(1차 `own` → 로딩 중 확정)
  - `MYGARAGE` 진입 69초 뒤 1건(`off`): 차고 진입은 성공, **튜토리얼 강화 버튼** 직후
- 강화 흐름(클라이언트 코드 확인): 버튼 → `MsgUpgradeCarReq {TargetCarInfo:{Carid}}`(튜토리얼은 재료 차량 없음)
  → 로컬 서버 미구현이라 기록 모드에서 원본 서버로 전달 → 성공 응답 → `CarUpgradeResult` 가
  `ReinforceEffectStart` → `playReinforceEffect`(메인 렌더러에 ModelHigh 차량 2대 + 파티클 연출) → 크래시
- 결과 화면은 `effect.playing` 이 꺼지면(최대 5초) 바로 결과를 보여 주고, 합성 연출도 Promise 종료 후 결과 팝업을 띄운다
  → 연출을 건너뛰어도 흐름은 그대로.
- 4차 조치: `config.json client.carEffects: "off"` → 강화·합성 3D 연출 생략(결과 화면은 표시).
- 추적 도구: `client.glTrace: "first"` (`offline-server/src/gltrace.ts`)
  - (컨텍스트, GL 연산, 셰이더 프로그램, 그리기 대상) 조합이 처음 나올 때 동기 XHR 로 서버에 기록하고 `gl.finish()`
    → 크래시가 나면 `data/diag/gltrace.log` 의 마지막 `first` 줄이 원인 조합. 앱 쪽 `lastWhere` 에도 `gl …` 로 남김.
  - 5초마다 `perf`(FPS, p50/p95/최대 프레임 시간, 프레임당 draw, 긴 작업, 캔버스 해상도) → 렉 정량화.
  - 헤드리스 확인: 메인 진입 정상, 첫 사용 조합 87건 기록, 안정 후 60fps / draw 22회(SwiftShader).
- 미해결: 같은 드라이버 크래시의 공통 원인(특정 셰이더 조합으로 추정, 미확인). 레벨업·보스 클리어·가챠 연출도
  차량을 별도 장면에 그리므로 같은 위험이 있다 → gltrace 로 확인 후 공통 대응.
