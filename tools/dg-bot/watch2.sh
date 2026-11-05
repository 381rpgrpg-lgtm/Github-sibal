#!/usr/bin/env bash
# 세션 추적용 감시(컨테이너 유지): 20초마다 중계 서버를 확인하고 죽었으면 다시 띄운다. END(UTC epoch) 또는 2시간 뒤 종료.
S=/tmp/claude-0/-home-user-Github-sibal/26061596-940c-53bf-840b-7cfebd88cbb5/scratchpad
END=${1:-$(date -d '2026-11-05T23:00:00Z' +%s)}; LIM=$(( $(date +%s) + 7100 )); [ $LIM -lt $END ] && END=$LIM
while [ $(date +%s) -lt $END ]; do
  if ! curl -s -m 5 localhost:8080/api/version >/dev/null; then
    cd /home/user/Github-sibal/offline-server
    PW=$(python3 -c "import re;print(re.search(r\"do_login\('damissi', '([^']+)'\)\",open('$S/probe/dg.py').read()).group(1))")
    DG_RECORD=1 DG_RECORD_ALWAYS='*' DG_LOGIN=damissi DG_PASSWORD="$PW" setsid nohup node --no-warnings dist/index.js >> $S/relay.log 2>&1 < /dev/null &
    echo "$(date -u +%T) relay restarted"
  fi
  if [ ! -f $S/bot/run/STOP ] && ! pgrep -f "keepalive.s[h]" >/dev/null; then $S/bot/start-all.sh; echo "$(date -u +%T) start-all"; fi
  sleep 20
done
echo "$(date -u +%T) watch end"
