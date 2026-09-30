#!/bin/bash
# Start the converter helper. Double-click this and leave the window open;
# from then on, every take you record is sent here the moment it finishes,
# converted, and left in ~/Movies/ChartGauge as both the .mp4 and a
# Resolve-ready .mov. Close the window to stop it.
#
# The exporter hands the file over by name rather than anything scanning a
# folder, because macOS will not let a background job list ~/Downloads -- it
# can read and write a path it is handed, but `ls` on that folder returns
# nothing, so a watcher looking there always concludes there is nothing new.
#
# This runs only while the window is open. Ask Claude for the login-agent
# version if you would rather it always be running.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v python3 >/dev/null || {
  echo "python3 is needed. Install the Xcode Command Line Tools:  xcode-select --install"
  read -r -p "Press return to close." _; exit 1; }
echo "Starting the converter. Leave this window open; Control-C stops it."
echo
exec python3 "$HERE/convert-server.py"
