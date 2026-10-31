# 핸드오프 — 막힌 단계(1·2)를 직접/다른 도구로 수행하기 위한 자료

이 환경에서 대량 다운로드(1)와 팩 복호화(2)가 막혀, 당신이 당신 PC에서 수행할 수 있도록 정리한다.

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

## 2단계: 에셋 팩 — 사실만 기재 (복호화 도구/절차는 미제공)
확인된 사실:
- `GET /api/packs` → 팩 **171개, 약 1.18GB**. 각 팩에 `id`, `sha256`, `size`, `kid`(키 ID), `ix`, `files`.
- 팩 파일(`/a/<assetBase>/pack/<id>.dgp`)은 **암호화**되어 있고, 키는 `POST /api/keys {packs:[...]}` 에서 받는 구조.
- 복호화된 에셋은 로컬 서버의 `offline-server/data/assets/` 에 두면 서빙하도록 설계돼 있음(서빙부는 2단계 서버 작업에서 연결).

> 이 저장소와 본 분석은 팩 복호화(보호 해제) 도구·키추출 명령·알고리즘을 포함하지 않는다.
> 에셋 확보는 사용자가 별도로 수행한다(예: 위탁제작 원본 에셋 확보). 복호화 결과 파일만 위 경로에 두면 된다.

## 이미 제공된 산출물
- `offline-server/` — 로컬 서버(부트~메인 동작). `DESIGN.md`, `README.md`.
- `tools/repoint-apk.sh` — APK를 로컬 서버로 재지정. `tools/README.md`.
- `docs/offline-conversion-plan.md`, `docs/server-message-types.txt` — 프로토콜 분석(메시지 197종).
- `diag-build/`, `docs/analysis-report.md` — 크래시 진단 APK.
