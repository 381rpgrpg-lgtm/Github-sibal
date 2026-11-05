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

## 운영 원칙 (사용자 지시)
- Gold Cash 사용 금지, 캐시는 최소 사용. 코인은 쌓아 두지 않고 적정선에서 (차량 상자는 15만 초과분, 하루 8개)
- ★3 이상 차량 보호 (육성 대상 ★3 2대가 정해진 뒤의 남는 ★3 Lv1 만 재료). ★2 이하는 재료로 사용
- 다른 플레이어 데이터(순위표 기록 `*LocalRebornBoard*`·`*MsgGetWRaceInfo*`)는 저장하지 않는다
- 차량을 없애는 작업은 명시 목록으로만, 수동 작업은 `--dry-run` 으로 먼저 확인
