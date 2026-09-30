#!/bin/bash
# Keep the converter running always, with no window open.
#
#   double-click this file                    turn it on
#   bash tools/auto-convert.command --off     turn it off
#   bash tools/auto-convert.command --status  say whether it is on
#
# This installs a LaunchAgent: a small background job macOS starts at login
# and restarts if it ever stops. It runs convert-server.py, which listens on
# 127.0.0.1 and does nothing until the exporter hands it a finished take.
#
# It is handed each file by name rather than watching a folder because macOS
# will not let a background job enumerate ~/Downloads -- it can read and write
# a path it is given, but `ls` on that folder returns nothing, so a watcher
# there always concludes there is nothing new. ~/Movies is unrestricted, which
# is where both files are written.
#
# Nothing runs as root, the server is bound to loopback, and nothing is
# installed outside your own home folder. --off removes it completely.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.chartgauge.convert"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/chartgauge-convert.log"
TARGET="gui/$(id -u)"
PORT=47823

hold() { if [ -t 1 ]; then echo; read -r -p "Press return to close." _ || true; fi; }
unload() { launchctl bootout "$TARGET/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null; return 0; }
answering() { curl -s -m 3 "http://127.0.0.1:$PORT/ping" >/dev/null 2>&1; }

case "${1:-}" in
  --off)
    unload; rm -f "$PLIST"
    # the earlier Downloads-watching agent, if any of it is still around
    launchctl bootout "$TARGET/com.chartgauge.for-resolve" 2>/dev/null
    rm -f "$HOME/Library/LaunchAgents/com.chartgauge.for-resolve.plist"
    echo "Automatic conversion is off. Nothing starts at login any more."
    echo "Takes will download as usual; convert them with for-resolve.command."
    hold; exit 0 ;;
  --status)
    if launchctl print "$TARGET/$LABEL" >/dev/null 2>&1; then
      echo "Automatic conversion is ON."
      echo "  agent  : $PLIST"
      echo "  log    : $LOG"
      echo "  folder : $HOME/Movies/ChartGauge"
      answering && echo "  server : answering on 127.0.0.1:$PORT" \
                || echo "  server : NOT answering -- check the log"
    else
      echo "Automatic conversion is off. Double-click this file to turn it on."
    fi
    hold; exit 0 ;;
esac

for need in convert-server.py for-resolve.command; do
  [ -f "$HERE/$need" ] || { echo "Cannot find $need next to this script."; hold; exit 1; }
done
PY3="$(command -v python3 || true)"
[ -n "$PY3" ] || { echo "python3 is needed. Install the Xcode Command Line Tools:  xcode-select --install"; hold; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HOME/Movies/ChartGauge"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY3</string>
    <string>$HERE/convert-server.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Standard, not Background: Background lets macOS throttle the job's I/O,
       and a throttled write of a gigabyte of ProRes stalls long enough that
       the converter gives up on a clip that converts fine in the foreground. -->
  <key>ProcessType</key><string>Standard</string>
  <key>LowPriorityIO</key><false/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF

unload
if ! launchctl bootstrap "$TARGET" "$PLIST" 2>/dev/null && ! launchctl load -w "$PLIST" 2>/dev/null; then
  echo "Could not start the background job. You can still run start-converter.command."
  hold; exit 1
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do answering && break; sleep 1; done
if answering; then
  echo "Automatic conversion is ON, and will be after every restart."
  echo
  echo "Record from the exporter. When a take finishes it is converted on the"
  echo "spot and both files land in:"
  echo "  $HOME/Movies/ChartGauge"
  echo
  echo "  log        : $LOG"
  echo "  turn it off: bash \"$HERE/auto-convert.command\" --off"
else
  echo "Installed, but the server is not answering yet. Check the log:"
  echo "  $LOG"
fi
hold
