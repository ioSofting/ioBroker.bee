# Older changes

## 0.5.2 (2026-11-27)

- Settings and notifications in all languages of ioBroker
- Timers of the adapter instead of those of Node.js, so that js-controller clears them when the instance stops
- Requires admin 7.6.20 or newer; no installation from GitHub (the build is not in the repository)

## 0.5.1 (2026-11-26)

- Another enrollment token in the settings now leads to a new enrollment, e.g. to move the installation to an asset of another tenant. Before, the agent kept connecting with the certificate in `iobroker-data/bee.0/device.json`, also after the instance was deleted and added again (js-controller keeps that folder). The desired state, the emergency stop and the remote sessions of the old asset are dropped

## 0.5.0 (2026-11-21)

- js-controller upgrades itself on request of the fleet management, as admin does it (on Linux, js-controller 5 or newer, on this host and the other hosts): only to a newer version; the page with the progress uses the port of admin
- Protocol: the same file as in the server and in bee-linux again
- Monitoring (tab "Überwachung"): rules on any state, e.g. `victron.0.voltage < 11.5`, warning, or "no update for 30 min"; once a condition holds longer than its delay (default 60 s) the fleet management shows a deviation with that severity and notifies by mail or Telegram, and once it is gone as long, the deviation ends. Up to 100 rules
- OS updates of the own host with apt-get instead of js-controller: first `apt-get update` (old package lists made apt ask the mirror for versions it no longer has, 404), then exactly the chosen packages with `install --only-upgrade` (js-controller's `apt upgrade <name>` upgraded all of them), without questions and keeping changed configuration files; afterwards js-controller lists the updates anew. Other hosts of the system: still js-controller, with a clear message when the lists there are out of date
- Own backups before jobs (`iobroker backup`): only the last three are kept, older ones are deleted; their size is reported. Before, they were never cleaned up and reported with size 0
- The fleet management now refuses a js-controller upgrade without a recent backup outside the device too (same rule as for Node.js); an admin can override it with a reason
- Devices in the network: the fleet management can reach a LOGO!, an S7 or another controller in this network through bee-knx, each connection on its own port; off until the owner allows it, only private addresses in the allowed networks and on the allowed ports
- KNX for ETS: further KNX gateways from the list of the fleet management, within the allowed networks

## 0.4.0 (2026-11-12)

- KNX for ETS: the fleet management can program the KNX installation with ETS from afar, through the program bee-knx on the technician's PC; off until the owner allows it, only to the gateway set in the tab (or the one of knx/openknx), over TCP or UDP
- Enrollment URL preset to `https://beekeeper.one` (new instances; existing ones keep theirs, see the README of the server, "Umzug auf eine neue Domain")

## 0.3.2 (2026-11-12)

- Reports the projects of vis-2 (folders with a `vis-views.json`), also live on request of the fleet management: it opens a project directly in the runtime or the editor

## 0.3.1 (2026-11-12)

- The fleet management can load the adapter repositories of the system again (command `repoUpdate`), as admin does with "update adapter list"

## 0.3.0 (2026-11-12)

- Multihost: one instance of bee maintains every host of the system. It reports the other hosts (online, js-controller, Node.js, adapters with their package there, instances, OS updates) and carries out commands there through their js-controller: install, update and remove adapters, add and delete instances, start and stop instances, restart ioBroker, OS updates and log files. Node.js, profiles, the console and remote access stay with the host of bee
- Only adapters whose package is on the host of bee count as its own: the adapters of another host were reported as installed here, and their update failed with "is not installed"
- BackItUp is found on any host of the system
- Answers of js-controller to the agent arrive (`messagebox`): the OS update waited for 30 minutes without one

## 0.2.11 (2026-11-11)

- Reports the backup of ioBroker by BackItUp: instance, automatic backup on, interval, targets outside the device, the last run with its error, the last good backup and the last one outside the device. The fleet management warns when there is no automatic backup, when it failed or when it is overdue
- The update of Node.js needs a recent backup outside the device, not only a target switched on

## 0.2.10 (2026-11-11)

- Adapters that are not in the repositories of the system (bee itself, own adapters only on npm) are installed and updated from npm with `iobroker url`, as admin does; `iobroker upgrade` refused them

## 0.2.9 (2026-11-11)

- Node.js 22 or newer is required
- AI access: requests of an AI of the fleet management to the MCP server of ioBroker (command `mcp`), only if the owner allows it, with the rights set in the instance, and only during a session opened in the fleet management

## 0.2.8 (2026-11-11)

- Inventory: the repositories set in admin and the versions of the installed adapters there, so the fleet management shows the updates as admin does

## 0.2.7 (2026-11-11)

- Protocol: the desired state can carry the mode `free` (without profile), shown in `info.mode`
- Command `software`: remove an adapter, add or delete an instance right away, with the runner of the command `adapter`

## 0.2.6 (2026-11-11)

- Log files: the list was empty on normal installations, the agent now finds `iobroker.json` in `iobroker-data` as js-controller does
- Command `adapter`: install a version of an adapter right away on an asset without desired profile

## 0.2.5 (2026-11-10)

- Log files of ioBroker for the fleet management: list them, upload one compressed on request

## 0.2.4 (2026-11-10)

- Settings, tab *Remote access*: "Remote access in progress" instead of "Access right now", and `info.remoteAccessBy` says `keiner` when nobody accesses the system
- Settings, tab *Enrollment*: the connection to the fleet management in green or red, the status (now naming the server) next to it
- Instances without a process (mode `none` or `extension`) refuse start, stop and restart
- Updates Node.js to the major line of the profile, as the first step of a job: a script as root in a systemd unit of its own, back to the old version if the instances do not run again under the new one (see *Node.js*)

## 0.2.3 (2026-11-10)

- Instances that run as a web extension inside a web instance (`common.webExtension` and `native.webInstance`, e.g. mcp) have no process of their own; they count as running when their web instance runs, as in admin. Before, the fleet management showed them as not running, and the check after an update of such an adapter would have rolled it back.
- Instances of adapters that only bring files for web (`common.onlyWWW`, e.g. material) have no process either: no longer reported as not running, not checked after an update, no commands.

## 0.2.2 (2026-11-10)

- Console: a shell on this system for the fleet management, in the browser of the technician; off unless the owner allows it, Linux with `script` (util-linux) only
- Enrollment URL preset to `https://bee.iobroker.click` (new instances)
- Commands from the fleet management: start, stop and restart instances, restart ioBroker, install OS updates listed by js-controller (6 and newer)

## 0.2.0 (2026-11-10)

- Remote access to admin and vis-2 through a tunnel to the fleet server, switchable per kind by the owner
- Versions set per asset by the fleet server, also adapter packages (tgz) loaded from the own server, checked by SHA-256 and installed with `iobroker url`

## 0.1.0 (2026-09-18)

- Initial prototype: enrollment, inventory, desired state via MQTT, adapter rollout with preflight, backup, verification and rollback
