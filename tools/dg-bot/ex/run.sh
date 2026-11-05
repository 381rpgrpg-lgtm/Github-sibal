#!/bin/bash
# usage: run.sh 'js code'  -> waits for result
D=$(dirname $0); rm -f $D/out.txt; printf '%s' "$1" > $D/cmd.js; for i in $(seq 1 240); do [ -f $D/out.txt ] && break; sleep 1; done; cat $D/out.txt | cut -c1-400
