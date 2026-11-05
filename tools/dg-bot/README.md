# dg-bot — 실계정 무인 진행 봇 (백업)

중계 서버(`offline-server`, 기록 모드 `DG_RECORD=1 DG_RECORD_ALWAYS='*'`, localhost:8080)를 거쳐 실계정을 진행한다.
관리 작업은 RPC 로 직접, 레이스는 헤드리스 Chromium 의 실제 클라이언트로 플레이한다. 비밀번호는 저장소에 없다
(`start-all.sh` 가 실행 시 스크래치패드의 `probe/dg.py` 에서 읽는다. 코드의 `password: 'x'` 는 로컬 중계 서버용 자리값).

## 복원
스크립트는 작업 폴더를 절대 경로로 쓴다 (`start-all.sh`·`keepalive.sh` 의 `S=...`, 각 파일의 `/home/user/Github-sibal/...`).
새 환경에서는 이 폴더를 스크래치패드의 `bot/` 로 복사하고 `S=` 경로를 맞춘 뒤 `start-all.sh` 로 띄운다.
필요 데이터(저장소 밖, gitignore): `offline-server/data/tables`·`data/client`, `offline-server/src/data/date-answers.json`,
레이스 후킹 엔진 `engine-race.js` (스크래치패드).

## 구성
- `bot.cjs` 본체 (관리 작업 + 레이스 루프), `driver4.js` 레이스 입력, `dates.cjs` 데이트 1회(백화점 포함), `findnew.py` 이벤트 지도 NEW 표식
- `safety.cjs` 안전 관문 — 모든 요청이 지난다: 보호 목록(`run/protect.json`, 번호+종류로 대조, 매 로그인마다 갱신, 수동 항목 지원),
  Gold Cash·실결제 상품 차단, 캐시 최소 사용(1회 10·하루 30), 정상 응답 확인, 퀘스트 진척 감시 → 이상은 `run/ALERT`
- 운영: `start-all.sh` (중계 서버 + `run.sh` 봇 루프 + `keepalive.sh` 감시), 제어 파일 `run/STOP`·`PAUSE`·`RELOAD`
- 도구: `dump-ud.cjs` 계정 상태 저장, `inv.cjs` 보관함 정리, `use-item.cjs`, `carwork.cjs` 차량 육성·조합(`--dry-run` 지원),
  `q.cjs` 단일 RPC, `audit-quests.cjs` 퀘스트 목표 형식 점검, `explore.cjs`·`ex/` 화면 탐색, `live.cjs`·`do.sh` 수동 조작, `timing.cjs`
- 시험: `test-safety.cjs` (관문 26건), `test-tidy.cjs` (아이템 정리 모의 실행) — 둘 다 네트워크 없이 `run/ud.json` 기준
- 2026-11-05 추가: `perf.mjs` 차량 x 동승자 총 성능(오프라인 서버 finalAttr), `touge.cjs` Haunted Pass Board 무료 주사위만 굴리기,
  `rpc-nologin.cjs` 로그인 없는 조회 RPC(경주 중 안전), `peek-girl.cjs` 히로인 기분·삐침 확인, `coat-once.cjs` 코인 코팅 1회,
  `f-trial.cjs` F 기능 시험, `watch2.sh` 세션 감시(중계 재시작), 제어 파일 `run/NORACE` (브라우저 경주 없이 RPC 일만)
- 봇 동작 (2026-11-05): World Tour(LeftTry·티켓>3), 허브 진입 시 색으로 확인한 버튼만 누름(공지 팝업 X·대사 화살표·퀘스트 창 X),
  어려운 경주는 최강 차+동승자, 삐친 캐릭터 우선 데이트, 데이트 답을 반응으로 학습(`run/date-learned.json`), 보상 연료 아이템 사용,
  ★5 대상은 등급 차 3 이하 재료만(남는 낮은 등급은 ★3·★4 보조 강화), 기분 변화 기록 `run/samples-mood.jsonl`

## 운영 원칙 (사용자 지시)
- Gold Cash 사용 금지, 캐시는 최소 사용. 코인은 쌓아 두지 않고 적정선에서 (차량 상자는 15만 초과분, 하루 8개)
- ★3 이상 차량 보호 (육성 대상 ★3 2대가 정해진 뒤의 남는 ★3 Lv1 만 재료). ★2 이하는 재료로 사용
- 다른 플레이어 데이터는 일부러 수집하지 않지만, 순위표·대전 기록이 남는 것 때문에 진행을 막지 않는다 (2026-11-05 사용자 확인: 금지 조항 없음)
- 차량을 없애는 작업은 명시 목록으로만, 수동 작업은 `--dry-run` 으로 먼저 확인
