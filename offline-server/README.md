# Drift Girls Reborn — 오프라인 서버 (부트~메인 단계)

클라이언트가 **코드 수정 없이** 접속하는 로컬 권위 서버. Node.js + TypeScript + SQLite. 설계는 `DESIGN.md`.

## 검증 결과 (2026-11-01, 헤드리스 Chromium, 외부 요청 0건)
클라이언트 빌드 `b3ff0b7…` + 사용자 제공 평문 에셋으로 **로그인 → 로딩 → 메인 진입(이벤트·보상 팝업, 3D 차량 렌더)** 까지 확인.
요청 417건 전부 200, `/api/rpc` 9건 미구현 메시지 없음. 실시간 `/api/pvp` 만 미구현(인증 실패 로그).

## 현재 구현 상태
- [x] `/api/login` (느슨 인증: 아무 계정이나 통과, 로컬 토큰·sigKey 발급)
- [x] `/api/content` (게임 규칙 테이블·텍스트 서빙)
- [x] `/api/scripts` (스토리 대사; 기본=영어, `?lang=jp`=일본어)
- [x] `/api/packs` (매니페스트 서빙; 에셋 본체는 별도)
- [x] `/api/session`, `/api/notices/active`, `/api/news`, `/api/news/seen` (오프라인용 빈 응답)
- [x] 응답 서명(`x-dg-s`, `res\n<nonce>\n<sha256(body)>`) — 클라이언트 검증 통과
- [x] `/sw.js` 자체 작성 통과형 서비스워커(원본 미사용), 평문 에셋 모드에서 `/api/packs` 빈 목록
- [x] 평문 에셋 `/a/local/**` → `data/assets/**`, 테이블 `/a/local/data/*.json` → `data/tables/*`
- [x] `/api/rpc` 디스패처 + `MsgLoginReq` → `[MsgLoginAns, MsgUserData]`, `MsgSetOptionReq`, `MsgUpdateCompletionReq`
- [x] 메인 허브 주기 메시지, 우편함 조회·수령, 코스메틱 확인, 일일 초기화·출석보상(태평양 자정 기준)
- [x] 튜토리얼 첫 캐릭터 선택(`MsgFirstSelectReq`), 동승 변경(`MsgSelectPassengerReq`), 캐릭터 메모리(`MsgUpdateGirlMemoryReq`)
- [x] 스토리 레이스 시작·결과(`MsgBattleStartReq`/`MsgBattleResultReq`): 연료, 보상, 레벨, 숙련도, 친밀도, 다음 레이스 해금
- [x] 상점 구매(`MsgBuyProductReq`): 코인·캐시·소셜포인트·토큰 가격, 코인 팩, 일반 아이템, 차량, 구매 한도, 차고 칸, 부족 코드(7/3)
- [ ] 부품 상자 가챠·부품·캐릭터 아이템·현금 결제 상품 — 미지원(Result 8 로 거절, 로그에 사유). 부품 아이템 형식·등급 매핑 기록이 없어 원본과 다르게 동작할 위험
- [ ] 차량 강화(재료 차량 필요)·데이트 등 나머지 메시지 — 진행 중
- [ ] `MsgCheatReq` 전체 토글 — 2단계
- [ ] `/api/pvp` WebSocket (실시간 레이스) — 4단계
- [x] 에셋 서빙 — 사용자 제공 평문(`data/assets/`, `data/tables/`)

검증: 위 부트 경로는 curl 로 end-to-end 확인됨(login→content→rpc MsgLoginReq→scripts 모두 200).

## 준비

### 1) 평문 데이터 내려받기 (본인 계정)
서버는 게임 데이터(테이블·대사)를 `data/` 에서 읽는다. 저장소에는 포함하지 않는다(`data/` gitignore).
```
npm install
node scripts/fetch-data.mjs <본인_로그인> <본인_비밀번호>
```
→ `data/content.json`, `data/scripts.json`, `data/scripts_jp.json`, `data/packs.json`, `data/userdata-seed.json` 생성.
`userdata-seed.json` 은 본인 현재 계정 상태를 오프라인 시작점으로 쓰기 위한 시드(없으면 신규계정으로 시작).

### 2) 에셋 (암호화 팩) — 본 서버 범위 밖
팩 1.18GB 는 서버 발급 키로 암호화돼 있다. **복호화는 사용자가 수행**하고, 결과를 `data/assets/` 에 둔다. 이 저장소 코드는 복호화를 수행하지 않는다.

## 실행
```
npm run build && npm start      # 또는 npm run dev
# http://localhost:8080
```

## 클라이언트를 로컬 서버로 연결
클라이언트 번들은 `https://game.driftgirlsreborn.com` 을 가리킨다. 로컬 서버로 붙이려면 둘 중 하나:
- APK/클라이언트의 서버 URL을 `http://<로컬IP>:8080` 로 변경(2단계에서 다룸), 또는
- 해당 도메인을 로컬 서버로 DNS/hosts 리다이렉트.

메인 화면이 **그려지려면 에셋이 필요**하다(위 2). 에셋 없이도 서버 API 계약은 위 curl 검증대로 동작한다.

## 실서버 기록 대조 (2026-11-02 기준)
`scripts/replay.mjs` 로 녹화 세션을 재생해 응답을 필드 단위로 비교한다(남은 차이는 대부분 무작위 보상과 그에 따른 코인 합계라
실행마다 점수가 흔들린다. 같은 이름 메시지는 키 구성이 같은 것끼리 비교, 재생 중 일일 초기화는 끈다: `--daily` 로 켬).
- 에피소드 2 세션(레이스 7, 보스, 캐릭터 해금, 퀘스트, 강화, 가챠): 56건 중 22~43건 완전 일치
- 에피소드 3 세션(3-11~3-14, 3-25, 퀘스트 10302~10304, 강화, 업적·친밀도 수령): 43건 중 16~22건 완전 일치
- 데이트 세션(경기장·영화관·공원, 드레스 장착): 23건 중 8~15건 완전 일치 (남은 차이: 사건 무작위 선택, 삐침)
- 기록 규칙으로 구현: 레이스 결과·보상(등급 보너스, 부스트 보상, 첫 플레이 보상, 보상 상자, 레이스 칸 보상), 보스·존 해금,
  퀘스트 잠금 레이스(LockQuestId), 캐릭터 연락처 해금 조건(GirlUnlockCrit), 최종 능력치(탑승 보너스 포함), 퀘스트,
  장소·백화점·티켓 데이트(장소 선호, 차량 반응, 선물·힌트 사건, 친밀도 단계 장면, 의상 장착), 일일 미션 완료 상태, 재료 강화, 부품 장착·강화·판매, 슬롯, 차량·부품 상자, 숨김·구역 제한 상품 거절, 우편, 기억 보상,
  업적(MyMemorySet 진행·알림·보상), 친밀도 코인 수령, 일일 초기화(미국 태평양 자정: 일일 미션·출석 보상·일일 보상 레이스),
  레벨업 우편 알림, 튜토리얼 보상
- 미구현: 거리 이름(Street Names, 단어·획득 조건이 서버 전용), 주간 레이스·월드투어·챌린지·이벤트 레이스, 차량 합성,
  일일 보상 레이스의 보상 내용(기록 없음), 시즌 코스메틱 지급
- 실서버와 같은 이유로 막히는 것: 연락처 조건에 주간 레이스 컷오프(조건 9)·월드 투어(6·7)가 있는 캐릭터
  (예: 20104 미나 — 3-26)는 해당 모드가 없어서 오프라인에서 해금되지 않는다

## 권장 실행: 같은 폰의 Chrome (PWA)
2026-11-01 실기기(SM-N981N, Adreno 650)에서 같은 서버·같은 클라이언트로 비교:
- 앱(APK, 시스템 WebView): 메인 10fps, 차고 4fps, 해상도 853x384(호환 모드), 썸네일·강화 연출에서 GPU 드라이버 크래시
- Chrome: 1546x608 해상도에서 60fps, 차량 썸네일·가챠 연출(전용 렌더러) 포함 크래시 없음

Chrome 에서 `http://127.0.0.1:8080` 접속 → 메뉴 ⋮ → **홈 화면에 추가**(또는 앱 설치). 서버가 PWA 매니페스트
(`/manifest.webmanifest`: 전체 화면, 가로, 원본 APK 런처 아이콘 `public/icon-*.png`)를 제공하므로 홈 화면 아이콘으로
주소창 없이 실행된다. 썸네일·연출 우회(`client.pictureMode`/`carEffects`)는 `appOnly` 이면 앱 WebView 에만 적용되고
Chrome 에서는 원본대로 동작한다.

## 기록 모드 (개발용)
로컬에 아직 없는 메시지를 **본인 계정으로 실서버에 보내고** 요청/응답을 `data/recorded/` 에 저장한다. 이 기록을 근거로 로컬 처리를 구현한다.
```
DG_RECORD=1 DG_LOGIN=<id> DG_PASSWORD=<pw> npm start
```
- 자격증명은 환경변수로만 받으며 저장소에 남기지 않는다. 구현된 메시지는 실서버로 보내지 않는다.
- `DG_RECORD_ALWAYS='*'`: 전체 중계. 로그인부터 모든 메시지를 실계정으로 처리·기록한다(로컬 DB 는 그대로). 로컬에서만 진행된 기능을 실계정 흐름으로 녹화할 때 사용.
- 이미 구현된 메시지도 실서버 응답을 기록하려면 `DG_RECORD_ALWAYS=MsgBattleStartReq,MsgBattleResultReq,MsgBuyProductReq` 처럼 지정한다(그 메시지는 실서버가 처리하고 로컬 상태에는 반영되지 않는다).
- 실서버 계정 상태가 실제로 바뀐다(레이스 진행 등).
- 캐시(유료 재화) 소비 요청은 실거래로 분류되어 이 환경에서 차단된다. 상점·가챠는 서버 제공 데이터(itemTable, boxOdds)로 로컬 구현한다.
- 로컬 상태 백업은 서버를 멈춘 뒤 `state.db`, `state.db-wal`, `state.db-shm` 를 함께 복사할 것(WAL 모드).

## 설정 `config.json`
- `strictSignatures`: `false`(오프라인 기본). `true` 로 바꾸면 `x-dg-s` HMAC 검증(원격 분리용).
- `cheat`: 서버측 치트 토글. 라이브 서버가 아닌 **로컬 서버에만** 적용되므로 타 플레이어 영향 없음.
  - `forceWinBattles`: 레이스 시작 응답의 `ForceWin` 을 켜고 결과를 승리로 처리 (검증 완료)
  - `infiniteFuel`: 레이스 시작 시 연료를 차감하지 않음
  - `maxCurrency`: 로그인 시 PropertySet 숫자값 최대화 (나머지 토글은 미구현)
- `showNotices`: 로그인마다 뜨는 이벤트 공지 팝업 표시 여부 (기본 false)
- `upstream`: `scripts/fetch-data.mjs` 전용. 서버 런타임은 upstream 을 호출하지 않는다.

## 클라이언트 연결 (상세)
`tools/repoint-apk.sh` 로 APK를 로컬 서버로 재지정한다. `tools/README.md` 참고.
