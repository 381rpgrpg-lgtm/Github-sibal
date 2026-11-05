#!/usr/bin/env bash
# 상주 감시: 중계 서버·봇(run.sh)이 죽으면 start-all.sh 로 다시 띄운다.
# Claude 세션 작업과 무관하게 돈다 (setsid). run/STOP 이 있으면 끝. 컨테이너 재시작 후에는 start-all.sh 를 한 번 실행하면 다시 뜬다.
S=/tmp/claude-0/-home-user-Github-sibal/26061596-940c-53bf-840b-7cfebd88cbb5/scratchpad
R=/home/user/Github-sibal/offline-server/data/recorded
n=0
while true; do
  [ -f $S/bot/run/STOP ] && { echo "$(date -u +%m-%dT%H:%M) keepalive stop" >> $S/bot/run/keepalive.log; exit 0; }
  if ! curl -s -m 5 localhost:8080/api/version >/dev/null || ! pgrep -f "run.s[h]" >/dev/null; then
    $S/bot/start-all.sh; echo "$(date -u +%m-%dT%H:%M) restarted" >> $S/bot/run/keepalive.log
  fi
  sleep 30
done
