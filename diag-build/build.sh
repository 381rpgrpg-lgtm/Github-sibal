#!/usr/bin/env bash
# Builds the diagnostic APK from the original one:
#   build.sh <original.apk> <out.apk> <keystore> <storepass>
# Needs: java 17+, apktool.jar ($APKTOOL), Android SDK ($ANDROID_HOME with platforms;android-35, build-tools;35.0.0).
set -euo pipefail
IN=$(realpath "$1"); OUT=$(realpath -m "$2"); KS=$(realpath "$3"); PASS="$4"
HERE=$(cd "$(dirname "$0")" && pwd)
BT="$ANDROID_HOME/build-tools/35.0.0"; JAR="$ANDROID_HOME/platforms/android-35/android.jar"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

# 1. Decode the code only (resources stay as they are).
java -jar "$APKTOOL" d -r -f -o "$W/dec" "$IN" >/dev/null

# 2. Hook: MainActivity's boot thread calls DiagExport.run(this) right after the exit reasons are noted.
SMALI="$W/dec/smali/com/driftgirlsreborn/app/MainActivity.smali"
HOOK='invoke-virtual {v0, v1}, Lcom/driftgirlsreborn/app/CrashGuard;->noted(Ljava/util/List;)V'
[ "$(grep -cF "$HOOK" "$SMALI")" = 1 ] || { echo "hook point not found exactly once" >&2; exit 1; }
python3 -I - "$SMALI" "$HOOK" <<'PY'
import sys
p, hook = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read()
s = s.replace(hook, hook + "\n\n    invoke-static {p0}, Lcom/driftgirlsreborn/app/DiagExport;->run(Landroid/content/Context;)V", 1)
open(p, 'w', encoding='utf-8').write(s)
PY

# 3. Rebuild classes.dex (+ untouched resources).
java -jar "$APKTOOL" b -o "$W/base.apk" "$W/dec" >/dev/null

# 4. DiagExport -> classes2.dex (ART loads secondary dex natively on API 21+).
mkdir -p "$W/cls" "$W/dex"
javac -source 8 -target 8 -Xlint:-options -nowarn -bootclasspath "$JAR" -cp "$HERE/stubs" -d "$W/cls" \
  -sourcepath "$HERE/stubs" "$HERE/src/com/driftgirlsreborn/app/DiagExport.java"
rm -f "$W/cls/com/driftgirlsreborn/app/Diag.class"
"$BT/d8" --release --min-api 24 --lib "$JAR" --output "$W/dex" $(find "$W/cls" -name '*.class')
cp "$W/dex/classes.dex" "$W/classes2.dex"
(cd "$W" && zip -q -0 base.apk classes2.dex)

# 5. Align and sign (v2 + v3).
"$BT/zipalign" -f -p 4 "$W/base.apk" "$W/aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$PASS" --out "$OUT" "$W/aligned.apk"
"$BT/apksigner" verify --verbose "$OUT" | head -5
echo "built $OUT"
