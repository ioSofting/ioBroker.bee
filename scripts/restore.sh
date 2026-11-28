#!/bin/bash
# Plays a fleet backup back onto this device for the fleet management (ioBroker.bee, command restore).
# The agent starts it as root in a unit of its own (sudo systemd-run), so stopping ioBroker does not end it.
#
# Usage: restore.sh <data directory of the agent> <directory of ioBroker> <archive> <archive of the state before>
#                   <systemd service of ioBroker> <seconds> <force 0|1> <user of ioBroker> <node>
#
# 1. stops ioBroker and puts node_modules aside (hard links: seconds, no space), with package.json,
#    package-lock.json and iobroker.json: `iobroker restore` uninstalls all adapters, the agent too
# 2. `iobroker restore <archive>` as the user of ioBroker, with --force for another js-controller than in the backup
# 3. puts node_modules back (the installed versions stay; js-controller installs the adapters of the backup that
#    are missing when it starts), starts ioBroker and waits up to <seconds> for the verdict of the agent
#    (restore-verdict.json), which it writes once it runs with its settings and reaches the fleet management
# 4. without a positive verdict: the same with the archive of the state before
#
# The agent follows restore-status.json (state running, waiting, ok, restored or failed).
# The output goes to restore.log in the data directory.

set -u

DIR=$1
IOB=$2
ARCHIVE=$3
ROLLBACK=$4
SERVICE=$5
WAIT=$6
FORCE=$7
RUNAS=$8
NODE=$9

STATUS="$DIR/restore-status.json"
VERDICT="$DIR/restore-verdict.json"
LOG="$DIR/restore.log"
KEEP="$IOB/node_modules.bee-restore"
SAVED="$DIR/restore-saved"
CONFIG="$IOB/iobroker-data/iobroker.json"

exec >>"$LOG" 2>&1

say() {
    echo "[$(date '+%F %T')] $*"
}

# status <state> <detail>: for the agent
status() {
    local detail
    detail=$(printf '%s' "$2" | tr -d '"\\' | tr '\n\r\t' '   ' | cut -c1-500)
    printf '{"state":"%s","detail":"%s","ts":%s000,"pid":%s}\n' "$1" "$detail" "$(date +%s)" "$$" >"$STATUS.tmp"
    chown --reference="$DIR" "$STATUS.tmp" "$LOG" 2>/dev/null
    mv -f "$STATUS.tmp" "$STATUS"
    say "$1: $2"
}

# put_aside: node_modules as hard links, the package files and iobroker.json
put_aside() {
    rm -rf "$KEEP" "$SAVED"
    mkdir -p "$SAVED" || return 1
    if ! cp -al "$IOB/node_modules" "$KEEP" 2>/dev/null; then
        rm -rf "$KEEP"
        say "Hardlinks gehen hier nicht, node_modules wird kopiert"
        cp -a "$IOB/node_modules" "$KEEP" || return 1
    fi
    local f
    for f in package.json package-lock.json; do
        [ ! -f "$IOB/$f" ] || cp -p "$IOB/$f" "$SAVED/$f" || return 1
    done
    [ ! -f "$CONFIG" ] || cp -p "$CONFIG" "$SAVED/iobroker.json"
}

# put_back: node_modules and the package files as they were before
put_back() {
    [ -d "$KEEP" ] || return 0
    rm -rf "$IOB/node_modules" && mv "$KEEP" "$IOB/node_modules" || return 1
    local f
    for f in package.json package-lock.json; do
        [ ! -f "$SAVED/$f" ] || cp -p "$SAVED/$f" "$IOB/$f"
    done
}

# config_back: iobroker.json as it was before (databases and hostname of this device)
config_back() {
    [ ! -f "$SAVED/iobroker.json" ] || cp -p "$SAVED/iobroker.json" "$CONFIG"
}

# cli <args>: the CLI of js-controller as the user of ioBroker
cli() {
    local path home
    path="$(dirname "$NODE"):$PATH"
    if [ "$(id -un)" = "$RUNAS" ]; then
        (cd "$IOB" && PATH="$path" "$NODE" "$IOB/node_modules/iobroker.js-controller/iobroker.js" "$@")
    else
        home=$(getent passwd "$RUNAS" | cut -d: -f6)
        (cd "$IOB" && runuser -u "$RUNAS" -- env HOME="${home:-$IOB}" PATH="$path" \
            "$NODE" "$IOB/node_modules/iobroker.js-controller/iobroker.js" "$@")
    fi
}

# back <reason>: the state before (archive of the agent from right before), ioBroker runs again; ends the script
back() {
    status running "Zurück zum Stand von vorher: $1"
    systemctl stop "$SERVICE"
    put_back || say "node_modules nicht zurückgelegt"
    config_back
    if ! put_aside; then
        systemctl start "$SERVICE"
        status failed "$1; Zurück zum Stand von vorher gescheitert (node_modules), siehe restore.log"
        exit 1
    fi
    cli restore "$ROLLBACK"
    local code=$?
    put_back || say "node_modules nicht zurückgelegt"
    if [ "$code" != 0 ]; then
        config_back
        systemctl start "$SERVICE"
        status failed "$1; der Stand von vorher ließ sich nicht einspielen (Exit-Code $code), siehe restore.log"
        exit 1
    fi
    systemctl start "$SERVICE"
    rm -rf "$SAVED"
    status restored "$1"
    exit 1
}

if [ ! -f "$ARCHIVE" ] || [ ! -f "$ROLLBACK" ] || [ ! -d "$IOB/node_modules/iobroker.js-controller" ]; then
    status failed "Sicherung, Stand von vorher oder js-controller fehlt, nichts geändert"
    exit 1
fi
rm -f "$VERDICT"
say "Sicherung $ARCHIVE, Stand von vorher $ROLLBACK, Dienst $SERVICE, Nutzer $RUNAS, --force: $FORCE"

status running "ioBroker wird gestoppt"
systemctl stop "$SERVICE"
status running "Die installierte Software wird beiseitegelegt"
if ! put_aside; then
    rm -rf "$KEEP" "$SAVED"
    systemctl start "$SERVICE"
    status failed "node_modules ließ sich nicht beiseitelegen (Platz?), nichts geändert"
    exit 1
fi

status running "Die Sicherung wird eingespielt"
if [ "$FORCE" = 1 ]; then
    cli restore "$ARCHIVE" --force
else
    cli restore "$ARCHIVE"
fi
CODE=$?
[ "$CODE" = 0 ] || back "iobroker restore ist fehlgeschlagen (Exit-Code $CODE)"
put_back || back "node_modules ließ sich nicht zurücklegen"

status running "ioBroker startet mit der Sicherung"
systemctl start "$SERVICE" || back "ioBroker startet nicht"
status waiting "Warte auf die Rückmeldung des Agenten"

END=$(($(date +%s) + WAIT))
while [ "$(date +%s)" -lt "$END" ]; do
    if [ -f "$VERDICT" ]; then
        if grep -Eq '"ok" *: *true' "$VERDICT"; then
            rm -rf "$SAVED"
            status ok "Sicherung eingespielt"
            exit 0
        fi
        back "$(sed -n -E 's/.*"reason" *: *"([^"]*)".*/\1/p' "$VERDICT")"
    fi
    sleep 5
done
back "Keine Rückmeldung des Agenten nach $WAIT s"
