#!/usr/bin/env bash
# 중계 서버 + 봇 감시 루프 시작 (이미 떠 있으면 건너뜀)
S=/tmp/claude-0/-home-user-Github-sibal/26061596-940c-53bf-840b-7cfebd88cbb5/scratchpad
cd /home/user/Github-sibal/offline-server
grep -q __dgRace data/client/static/engine-C3PtOFdR.js || cp $S/engine-race.js data/client/static/engine-C3PtOFdR.js
if ! curl -s localhost:8080/api/version >/dev/null; then
  PW=$(python3 -c "import re;print(re.search(r\"do_login\('damissi', '([^']+)'\)\",open('$S/probe/dg.py').read()).group(1))")
  DG_RECORD=1 DG_RECORD_ALWAYS='*' DG_LOGIN=damissi DG_PASSWORD="$PW" nohup node --no-warnings dist/index.js >> $S/relay.log 2>&1 &
  sleep 3
fi
pgrep -f "run.s[h]" >/dev/null || setsid nohup $S/bot/run.sh >/dev/null 2>&1 < /dev/null &
pgrep -f "keepalive.s[h]" >/dev/null || setsid nohup $S/bot/keepalive.sh >/dev/null 2>&1 < /dev/null &
