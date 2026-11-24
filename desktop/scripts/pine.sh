#!/bin/sh
# pine, as the Pine app carries it: the app's own pine on the app's own Node. The app links this
# file into a folder of the shell's PATH (Settings > General), so that `pine` works in a terminal on
# a Mac where neither Node nor pine was ever installed. Lies in Pine.app/Contents/Resources/bin.
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in /*) SELF="$LINK" ;; *) SELF="$(dirname "$SELF")/$LINK" ;; esac
done
HERE="$(cd "$(dirname "$SELF")/.." && pwd)"
if [ ! -x "$HERE/node/bin/node" ] || [ ! -f "$HERE/pine/bin/pine.js" ]; then
  echo "This pine belongs to the Pine app, and the app is no longer where it was ($HERE). Open Pine and set the command up again in Settings > General." >&2
  exit 1
fi
exec "$HERE/node/bin/node" "$HERE/pine/bin/pine.js" "$@"
