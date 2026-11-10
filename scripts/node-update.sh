#!/bin/bash
# Changes Node.js to another major line for a job of the fleet management (ioBroker.bee).
# The agent starts it as root in a unit of its own (sudo systemd-run), so stopping ioBroker does not end it.
# Expects Node.js from the package nodejs of NodeSource, as the installer of ioBroker sets it up.
#
# Usage: node-update.sh <data directory of the agent> <major> <systemd service of ioBroker> <seconds>
#
# 1. stops ioBroker, points the NodeSource source to the new major and installs nodejs from it,
#    with the capabilities the old binary had
# 2. starts ioBroker and waits up to <seconds> for the verdict of the agent (node-verdict.json), which it
#    writes under the new Node.js once the instances that ran before run again
# 3. without a positive verdict: stops ioBroker, installs the old package again and starts ioBroker
#
# The agent follows node-status.json (state running, waiting, ok, restored or failed).
# The output goes to node-update.log in the data directory.

set -u

DIR=$1
TARGET=$2
SERVICE=$3
WAIT=$4

STATUS="$DIR/node-status.json"
VERDICT="$DIR/node-verdict.json"
LOG="$DIR/node-update.log"
SAVED="$DIR/nodesource.saved"

exec >>"$LOG" 2>&1
export DEBIAN_FRONTEND=noninteractive

say() {
    echo "[$(date '+%F %T')] $*"
}

major() {
    node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

# status <state> <detail>: for the agent
status() {
    local detail
    detail=$(printf '%s' "$2" | tr -d '"\\' | tr '\n\r\t' '   ' | cut -c1-500)
    printf '{"state":"%s","detail":"%s","ts":%s000,"pid":%s,"node":"%s"}\n' \
        "$1" "$detail" "$(date +%s)" "$$" "$(node -v 2>/dev/null)" >"$STATUS.tmp"
    chown --reference="$DIR" "$STATUS.tmp" "$LOG" 2>/dev/null
    mv -f "$STATUS.tmp" "$STATUS"
    say "$1: $2"
}

SOURCE=""
# another directory only for the tests
SOURCES_DIR=${BEE_APT_SOURCES:-/etc/apt/sources.list.d}
for f in "$SOURCES_DIR/nodesource.sources" "$SOURCES_DIR/nodesource.list"; do
    if [ -f "$f" ]; then
        SOURCE=$f
        break
    fi
done
OLD_MAJOR=$(major)
OLD_PACKAGE=$(dpkg-query -W -f='${Version}' nodejs 2>/dev/null)
# getcap prints "<file> cap_a,cap_b=eip", older versions "<file> = cap_a,cap_b+eip"
CAPS=$(getcap "$(readlink -f /usr/bin/node)" 2>/dev/null | sed -E 's/^[^ ]+ (= )?//')

# install_node <major> [<package version>]: nodejs of this major from the source as it is now
install_node() {
    local version=${2:-}
    apt-get -q -o DPkg::Lock::Timeout=600 update || say "apt-get update meldet Fehler"
    if [ -z "$version" ]; then
        version=$(apt-cache madison nodejs | grep nodesource | awk '{print $3}' | grep -E "^$1\." | sort -V | tail -n 1)
    fi
    if [ -z "$version" ]; then
        say "NodeSource bietet kein Node.js $1 an"
        return 1
    fi
    apt-get install -y -q --allow-downgrades -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold \
        "nodejs=$version" || return 1
    if [ "$(major)" != "$1" ]; then
        say "Nach der Installation meldet node -v: $(node -v 2>/dev/null)"
        return 1
    fi
    # the new binary has lost the capabilities (ports below 1024, raw sockets)
    if [ -n "$CAPS" ] && ! setcap "$CAPS" "$(readlink -f /usr/bin/node)"; then
        say "Capabilities $CAPS nicht gesetzt"
    fi
}

# restore <reason>: back to the old package, ioBroker runs again; ends the script
restore() {
    status running "Zurück zu Node.js $OLD_MAJOR: $1"
    systemctl stop "$SERVICE"
    cp -f "$SAVED" "$SOURCE"
    if [ "$(major)" != "$OLD_MAJOR" ] && ! install_node "$OLD_MAJOR" "$OLD_PACKAGE" && ! install_node "$OLD_MAJOR"; then
        systemctl start "$SERVICE"
        status failed "$1; Rückkehr zu Node.js $OLD_MAJOR gescheitert, siehe node-update.log"
        exit 1
    fi
    systemctl start "$SERVICE"
    rm -f "$SAVED"
    status restored "$1"
    exit 1
}

if [ -z "$SOURCE" ] || [ -z "$OLD_MAJOR" ] || [ -z "$OLD_PACKAGE" ]; then
    status failed "Node.js stammt nicht aus dem Paket nodejs von NodeSource, nichts geändert"
    exit 1
fi
rm -f "$VERDICT"
cp -f "$SOURCE" "$SAVED"
say "Node.js $(node -v) (Paket $OLD_PACKAGE) auf $TARGET, Dienst $SERVICE, Capabilities: ${CAPS:-keine}"

status running "ioBroker wird gestoppt"
systemctl stop "$SERVICE"
status running "Node.js $TARGET wird installiert"
sed -i -E "s#node_[0-9]+\.x#node_$TARGET.x#" "$SOURCE"
install_node "$TARGET" || restore "Installation von Node.js $TARGET fehlgeschlagen"

status running "ioBroker startet unter Node.js $(node -v)"
systemctl start "$SERVICE" || restore "ioBroker startet nicht unter Node.js $(node -v)"
status waiting "Warte auf die Rückmeldung des Agenten unter Node.js $(node -v)"

END=$(($(date +%s) + WAIT))
while [ "$(date +%s)" -lt "$END" ]; do
    if [ -f "$VERDICT" ]; then
        if grep -Eq '"ok" *: *true' "$VERDICT"; then
            rm -f "$SAVED"
            status ok "Node.js $(node -v)"
            exit 0
        fi
        restore "$(sed -n -E 's/.*"reason" *: *"([^"]*)".*/\1/p' "$VERDICT")"
    fi
    sleep 5
done
restore "Keine Rückmeldung des Agenten unter Node.js $(node -v) nach $WAIT s"
