#!/usr/bin/env bash
D=$(dirname "$0")/live; id=$1; shift
echo "{\"id\":$id,\"actions\":$1}" > $D/cmd.json
for i in $(seq 1 900); do grep -q "\"id\":$id}" $D/done.json 2>/dev/null && break; sleep 1; done
tail -n ${N:-8} $D/live.log
