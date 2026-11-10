![Logo](admin/bee.svg)

# ioBroker.bee

Fleet agent for ioBroker. It connects a delivered ioBroker system (in a house, a radio station in the mountains, a vehicle, a machine in the field, …) to a **beekeeper** fleet server: it reports the inventory, receives the desired version profile and converges the system to it, locally and at the right time.

> Prototype. The server (beekeeper) is a separate, closed product. This adapter only reports, reads, executes and verifies; it holds no secrets besides its own device certificate.

## How it works

1. **Enrollment.** The factory image contains the enrollment URL and a one-time token bound to the asset (the managed installation). On first start the agent sends the token and the system UUID and receives its own device certificate. The token is used up.
2. **Control channel.** MQTT over TLS with the device certificate, to the platform's own broker. The broker certificate may come from the platform CA (handed out at enrollment) or from a public CA such as Let's Encrypt; for the latter the agent uses the public root certificates shipped with Node.js. Heartbeat and Last Will report online status, the inventory is sent completely on connect and as a diff afterwards, all payloads gzip-compressed. Keepalive and heartbeat are configurable to keep mobile data low.
3. **Desired state instead of commands.** The server publishes the desired profile as a retained message. A system that was offline for months reads the current profile, not a backlog of orders.
4. **Reconciliation.** The agent compares the profile with the installed versions and plans install, upgrade, downgrade (and removal only when the server asks for it on return to managed mode). It never touches adapters that are not in the profile.
5. **Preflight.** Emergency stop, dependencies of the target versions (`io-package.json` of the target version, `engines.node`), free space, maintenance window and configurable conditions on ioBroker states (installation not in use, battery charged, no roaming, vehicle standing, …). Conditions that change by themselves mean *waiting*, everything that needs a human means *blocked*.
6. **Execution.** A detached runner process performs backup (`iobroker backup`) and the steps (`iobroker add/upgrade/del`) one by one. It survives restarts of the adapter, including the update of the agent itself, which always comes last. A new major line of Node.js comes right after the backup, see below.
7. **Verification.** Versions must match, all enabled daemon instances of the changed adapters must be alive, and no new errors may appear in their log during the observation time. Otherwise the agent rolls back the changed adapters to their previous versions and reports *blocked*. A blocked job is not repeated until the fleet manager releases a new attempt.

### Node.js

The profile names the major line of Node.js (e.g. `22`). If this system runs an older one, the plan starts with a step `node`. Never downwards: a newer Node.js than in the profile stays. Within a major line Node.js is updated with the OS updates.

The update stops ioBroker, so the agent cannot do it itself. It starts `scripts/node-update.sh` as root in a systemd unit of its own (`sudo -n systemd-run`, allowed by the installer of ioBroker), so stopping ioBroker does not end it. The script

1. stops the ioBroker service, points the NodeSource source (`/etc/apt/sources.list.d/nodesource.sources` or `.list`) to the new line and installs the newest `nodejs` of it, with the capabilities the old binary had (ports below 1024, raw sockets),
2. starts ioBroker and waits for the verdict of the agent: under the new Node.js the agent checks that every instance that ran before runs again (at least 10 minutes, or the start timeout if longer) and then writes `node-verdict.json`,
3. without a positive verdict in time it stops ioBroker, puts the source back, installs the old package again and starts ioBroker.

Afterwards the runner continues with the adapters. A failed adapter later rolls back the adapters, Node.js stays. If the old version came back, the job is *blocked* with the reason. Adapters with native modules are rebuilt by js-controller when they start.

Preflight blocks with a reason unless all of this holds: Linux, ioBroker runs as a systemd service, sudo without password for `systemd-run` (not with `--hardened`), Node.js is `/usr/bin/node` of the package `nodejs` from NodeSource, architecture amd64 or arm64, `nodejs` not on hold, an off-device backup target (BackItUp), and no installed package (js-controller, adapters that the job does not change) excludes the new line in `engines.node`.

Limits: a power loss while the script works leaves the system as far as the script got; the agent then reports *blocked* and `node-update.log` tells where it stopped.

### Behaviour without server

- **Unknown means self-stop.** If the server explicitly rejects the device (unknown token, revoked certificate), the agent writes the reason to `bee.0.info.status`, raises a notification and terminates. It does not keep knocking.
- **Network errors are no reason to stop.** Without connection the distance between attempts grows up to a daily rhythm. Jobs that were started continue and report later.

### Managed and self-managed

If the owner installs adapters that are not part of the profile, the agent reports them, stops automatic updates and informs the owner via an ioBroker notification. The fleet manager sees the installation in the deviation list and can bring it back to managed mode (removing the own adapters or tolerating them as exceptions).

### Remote access to admin, vis-2 and the console

A technician of the fleet manager can open admin or vis-2 of the system from the fleet management, without ioBroker.pro and without open ports on the device:

1. The server sends the job `tunnel` over MQTT with a one-time ticket, the kind (admin or vis-2), the technician, the purpose and the end of the session (at most 4 hours).
2. The agent checks that the tunnel URL belongs to its own server (same host as enrollment or broker, `wss://` only) and opens an outgoing WebSocket to it.
3. The server carries the connections of the technician's browser through this WebSocket. The agent connects them to an enabled admin instance (or web instance for vis-2, only with vis-2 installed) on this host and nowhere else. It reports these instances with port, HTTPS and login mode in the inventory; with several, the technician chooses one, and the agent accepts only one from its own list.

The owner can switch off each kind in the tab *Remote access*; the agent then refuses the session and the fleet management shows why. Running sessions are visible in `info.remoteAccess`. After a connection loss the agent reconnects until the session expires, also across restarts of the adapter. The server ends the session early when the technician ends it or the device is revoked.

**Console.** Off until the owner allows it (*Allow the console*), and only on Linux with `script` of util-linux (part of every Debian). Then every terminal the technician opens in the browser is a login shell on this system, as the user ioBroker runs as (usually `iobroker`), started in the ioBroker directory. No native module: `script` gives the shell a pseudo terminal, `stty` sets the size of its window. At most 4 shells per session; when the session or the connection ends, the shells get SIGHUP. `info.remoteAccessBy` shows how many shells are open. Whatever the shell may do beyond the rights of that user belongs in a sudo allow list for single commands, not in a general sudo. Note that the list the ioBroker installer writes (`/etc/sudoers.d/iobroker`) contains `apt`, `apt-get` and `dpkg` without password, which makes the console effectively root on a standard installation. Systems installed with `--hardened` have no sudo; there the OS updates below do not work either.

### Commands from the fleet management

From the asset detail a technician (permission `operate`) can start, stop and restart instances on this host, restart ioBroker, and install updates of operating system packages. The agent answers on the topic `reply`; the fleet management logs who did what.

- Instances: the same way admin does it, through the instance object (`common.enabled`, or rewriting it for a restart). Only instances of this host; `bee` itself can be restarted but not stopped from afar.
- Restart of ioBroker: host command `restartController` of js-controller.
- OS updates: js-controller (6 and newer, Linux) lists upgradeable packages (`apt list --upgradeable`) on every update of the repository, admin triggers that daily, and writes them to `system.host.<host>.osPackageUpdates`. The agent reports this list in the inventory, together with `/var/run/reboot-required`, and on request passes the chosen packages to the host command `upgradeOsPackages`, which runs apt (with sudo if ioBroker does not run as root). Packages that js-controller did not list are refused.
- Nothing of this while a job (update) is running, and one command at a time.
- Log files: the agent lists the files in the directories of the file transports of `iobroker.json` (`iobroker-data/iobroker.json`, found as js-controller finds it; without a file transport `log` below the ioBroker directory; only `*.log` and `*.gz`, no symbolic links like `iobroker.current.log`), and on request uploads one of them to its own server, compressed with gzip (a `.gz` file as it is), with the one-time ticket of the request and at most 50 MB compressed. The upload URL must belong to the server of the enrollment or the broker. This works also during a job, one upload at a time.

## Configuration

| Tab | Setting | Meaning |
| --- | --- | --- |
| Enrollment | Enrollment URL, token | from the factory image or the fleet manager; the URL is preset to `https://bee.iobroker.click`, the token is stored encrypted |
| | comment | free text shown in the fleet management next to the installation, e.g. `Womo Mercedes KA-1525`; sent on enrollment and with the inventory. It helps to recognize the installation but proves nothing: the identity is the device certificate |
| Maintenance window | start, end | daily window for updates, may span midnight (e.g. 22:00–05:00) |
| | conditions | table of `state operator value`, e.g. `victron.0.soc >= 50`, `modem.0.roaming == false`, `presence.0.home == false` |
| | minimum free space | for download, unpacking and backup |
| Advanced | heartbeat, check interval, MQTT keepalive | trade-off between reaction time and mobile data |
| | observation after update, start timeout | verification of a rollout |
| | backup before every update | only disable for tests |
| Remote access | allow admin, allow vis-2 | whether the fleet manager may open the interface remotely (both allowed by default) |
| | allow the console | a shell on this system for the fleet manager (off by default, Linux only) |

## States

| State | Meaning |
| --- | --- |
| `info.connection` | connected to the beekeeper broker |
| `info.status` | readable status, including the reason of a rejection |
| `info.deviceId`, `info.assetId` | identity assigned by the server |
| `info.mode`, `info.profile`, `info.onTarget` | managed/self, desired profile, system matches it |
| `job.state`, `job.detail`, `job.steps` | current or last job |
| `control.halted` | emergency stop of the fleet is active |
| `control.refresh`, `control.check` | buttons: send inventory, check desired state now |
| `info.remoteAccess`, `info.remoteAccessBy` | remote access running now, and by whom with which purpose (`keiner` if none; scripts should use `info.remoteAccess`) |

Files in `iobroker-data/bee.0/`: `device.json` (certificate and key, mode 0600), `desired.json`, `job.json`, `runner.json`, `runner.log` (complete CLI output of all jobs), `tunnels.json` (running remote access sessions, resumed after a restart), and for an update of Node.js `node-update.sh` (copy of the script), `node-status.json`, `node-verdict.json` and `node-update.log` (complete output of the script).

## Not in this version

Updates of js-controller through the fleet (with a watchdog outside ioBroker), vis-2 project distribution, recording of console sessions, signed artifacts. See the concept of the beekeeper project.

## Development

```bash
npm install
npm run build
npm test          # unit tests of planner, preflight and diff
```

`src/lib/protocol.ts` and `src/lib/tunnel.ts` are shared with the server and must stay identical to `beekeeper-server/src/protocol.ts` and `beekeeper-server/src/tunnel.ts`.

## Changelog

### **WORK IN PROGRESS**

- Log files: the list was empty on normal installations, the agent now finds `iobroker.json` in `iobroker-data` as js-controller does

### 0.2.5 (2026-11-10)

- Log files of ioBroker for the fleet management: list them, upload one compressed on request

### 0.2.4 (2026-11-10)

- Settings, tab *Remote access*: "Remote access in progress" instead of "Access right now", and `info.remoteAccessBy` says `keiner` when nobody accesses the system
- Settings, tab *Enrollment*: the connection to the fleet management in green or red, the status (now naming the server) next to it
- Instances without a process (mode `none` or `extension`) refuse start, stop and restart
- Updates Node.js to the major line of the profile, as the first step of a job: a script as root in a systemd unit of its own, back to the old version if the instances do not run again under the new one (see *Node.js*)

### 0.2.3 (2026-11-10)

- Instances that run as a web extension inside a web instance (`common.webExtension` and `native.webInstance`, e.g. mcp) have no process of their own; they count as running when their web instance runs, as in admin. Before, the fleet management showed them as not running, and the check after an update of such an adapter would have rolled it back.
- Instances of adapters that only bring files for web (`common.onlyWWW`, e.g. material) have no process either: no longer reported as not running, not checked after an update, no commands.

### 0.2.2 (2026-11-10)

- Console: a shell on this system for the fleet management, in the browser of the technician; off unless the owner allows it, Linux with `script` (util-linux) only
- Enrollment URL preset to `https://bee.iobroker.click` (new instances)
- Commands from the fleet management: start, stop and restart instances, restart ioBroker, install OS updates listed by js-controller (6 and newer)

### 0.2.0 (2026-11-10)

- Remote access to admin and vis-2 through a tunnel to the fleet server, switchable per kind by the owner
- Versions set per asset by the fleet server, also adapter packages (tgz) loaded from the own server, checked by SHA-256 and installed with `iobroker url`

### 0.1.0 (2026-09-18)

- Initial prototype: enrollment, inventory, desired state via MQTT, adapter rollout with preflight, backup, verification and rollback

## License

Proprietary (UNLICENSED). Copyright (c) 2026 Denis Haev. All rights reserved.
