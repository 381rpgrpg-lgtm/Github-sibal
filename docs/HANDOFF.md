# 핸드오프 — 단계별 수행 자료 (에셋 확보 완료, 복호화는 범위 밖)

갱신(2026-11-01): **에셋 팩 대량 다운로드는 완료되었다.** `scripts/fetch-packs.mjs` 로
암호화 팩 190개(약 1.3GB)를 받아 전부 sha256 검증했고, 이 저장소 환경에서도 재현 확인됐다.
팩 복호화(2)는 여전히 이 저장소/분석 범위 밖이며 사용자가 별도 수행한다.

## 공통: 서버·인증 사실
- 서버: `https://game.driftgirlsreborn.com`
- 로그인: `POST /api/login {login,password}`, 헤더 `x-dg-build:<현재 빌드해시>` 필요.
  현재 빌드해시는 잘못된 build 로 login 하면 에러 바디의 `build` 필드로 돌아온다(`sign.py` 가 자동 처리).
- 로그인 응답: `token`, `sigKey`, `assetBase`, `packs`(버전), `content`(버전), `account`, `expires`
- 인증 서명(평문 엔드포인트에도 필요):
  ```
  message = METHOD + "\n" + path+search + "\n" + nonce + "\n" + sha256_hex(body)
  x-dg-s  = base64url(HMAC_SHA256(sigKey_bytes, message))   # sigKey 는 base64url 디코드
  x-dg-c  = nonce (= 증가하는 마이크로초 정수 문자열)
  x-dg-build = <빌드해시>,  authorization = "Bearer "+token
  ```
- 헬퍼: `offline-server/scripts/sign.py` (Python, 의존성 없음).
  ```
  python3 offline-server/scripts/sign.py login <id> <pw>
  python3 offline-server/scripts/sign.py get /api/content
  python3 offline-server/scripts/sign.py rpc MsgLoginReq
  ```

## 1단계: 웹 클라이언트(평문) 다운로드 — 바로 실행 가능
`/`, `/api/client`, `/static/*` (약 52.7MB, 암호화 아님)를 `offline-server/data/client/` 로 받는다.
```
cd offline-server
npm install
node scripts/fetch-client.mjs          # config.json 의 upstream 사용, 앱 UA로 요청
```
- 산출물: `data/client/index.html`, `data/client/api-client.json`, `data/client/static/*`
- 게임 데이터(테이블·대사)도 함께:
  ```
  node scripts/fetch-data.mjs <id> <pw>   # content.json, scripts.json, scripts_jp.json, packs.json, userdata-seed.json
  ```
- 이후 `npm run build && npm start` → 로컬 서버가 이 파일들을 서빙.

## 2단계: 에셋 팩 — 암호화 상태로 확보 완료 (복호화는 범위 밖)
확인된 사실:
- `GET /api/packs` → 팩 **190개, 약 1.3GB (1,358,438,588 B)**. 각 팩에 `id`, `sha256`, `size`, `kid`(키 ID), `ix`, `files`. (이전 기재 171개·1.18GB 에서 에셋 갱신됨; 매니페스트 version `d2f61d6da75cf109`.)
- 팩 파일(`/a/<assetBase>/pack/<id>.dgp`)은 **암호화**되어 있고(헤더 매직 `DGP1+`), 키는 `POST /api/keys {packs:[...]}` 에서 받는 구조.
- 복호화된 에셋은 로컬 서버의 `offline-server/data/assets/` 에 두면 서빙하도록 설계돼 있음(서빙부는 2단계 서버 작업에서 연결).

### 암호화 팩 내려받기 (복호화 아님)
```
cd offline-server
node scripts/fetch-packs.mjs <본인_로그인> <본인_비밀번호> [--concurrency 8]
```
- `/api/packs` 매니페스트를 `data/packs.json` 에 저장하고, 각 팩 본체를 `data/packs/<id>.dgp` 로 받는다.
- 받은 파일은 **암호화 상태 그대로**다. 스크립트는 `api/keys`(복호화 키)를 호출하지 않는다.
- 재개 가능(크기+sha256 일치 시 건너뜀), 매 팩 sha256 검증. `data/` 는 gitignore(바이너리 비커밋).

> 이 저장소와 본 분석은 팩 복호화(보호 해제) 도구·키추출 명령·알고리즘을 포함하지 않는다.
> 복호화는 사용자가 별도로 수행한다(예: 위탁제작 원본 에셋 확보). 복호화 결과 파일만 `data/assets/` 에 두면 된다.

## 이미 제공된 산출물
- `offline-server/` — 로컬 서버(부트~메인 동작). `DESIGN.md`, `README.md`.
- `tools/repoint-apk.sh` — APK를 로컬 서버로 재지정. `tools/README.md`.
- `docs/offline-conversion-plan.md`, `docs/server-message-types.txt` — 프로토콜 분석(메시지 197종).
- `diag-build/`, `docs/analysis-report.md` — 크래시 진단 APK.
