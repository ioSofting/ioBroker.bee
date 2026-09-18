![Logo](admin/bee.svg)

# ioBroker.bee

Fleet agent for ioBroker. It connects a delivered ioBroker system (in a house, a radio station in the mountains, a vehicle, a machine in the field, …) to a **beekeeper** fleet server: it reports the inventory, receives the desired version profile and converges the system to it, locally and at the right time.

> Prototype. The server (beekeeper) is a separate, closed product. This adapter only reports, reads, executes and verifies; it holds no secrets besides its own device certificate.

## How it works

1. **Enrollment.** The factory image contains the enrollment URL and a one-time token bound to the asset (the managed installation). On first start the agent sends the token and the system UUID and receives its own device certificate. The token is used up.
2. **Control channel.** MQTT over TLS with the device certificate, to the platform's own broker. Heartbeat and Last Will report online status, the inventory is sent completely on connect and as a diff afterwards, all payloads gzip-compressed. Keepalive and heartbeat are configurable to keep mobile data low.
3. **Desired state instead of commands.** The server publishes the desired profile as a retained message. A system that was offline for months reads the current profile, not a backlog of orders.
4. **Reconciliation.** The agent compares the profile with the installed versions and plans install, upgrade, downgrade (and removal only when the server asks for it on return to managed mode). It never touches adapters that are not in the profile.
5. **Preflight.** Emergency stop, dependencies of the target versions (`io-package.json` of the target version, `engines.node`), free space, maintenance window and configurable conditions on ioBroker states (installation not in use, battery charged, no roaming, vehicle standing, …). Conditions that change by themselves mean *waiting*, everything that needs a human means *blocked*.
6. **Execution.** A detached runner process performs backup (`iobroker backup`) and the steps (`iobroker add/upgrade/del`) one by one. It survives restarts of the adapter, including the update of the agent itself, which always comes last.
7. **Verification.** Versions must match, all enabled daemon instances of the changed adapters must be alive, and no new errors may appear in their log during the observation time. Otherwise the agent rolls back the changed adapters to their previous versions and reports *blocked*. A blocked job is not repeated until the fleet manager releases a new attempt.

### Behaviour without server

- **Unknown means self-stop.** If the server explicitly rejects the device (unknown token, revoked certificate), the agent writes the reason to `bee.0.info.status`, raises a notification and terminates. It does not keep knocking.
- **Network errors are no reason to stop.** Without connection the distance between attempts grows up to a daily rhythm. Jobs that were started continue and report later.

### Managed and self-managed

If the owner installs adapters that are not part of the profile, the agent reports them, stops automatic updates and informs the owner via an ioBroker notification. The fleet manager sees the installation in the deviation list and can bring it back to managed mode (removing the own adapters or tolerating them as exceptions).

## Configuration

| Tab | Setting | Meaning |
| --- | --- | --- |
| Enrollment | Enrollment URL, token | from the factory image or the fleet manager; the token is stored encrypted |
| Maintenance window | start, end | daily window for updates, may span midnight (e.g. 22:00–05:00) |
| | conditions | table of `state operator value`, e.g. `victron.0.soc >= 50`, `modem.0.roaming == false`, `presence.0.home == false` |
| | minimum free space | for download, unpacking and backup |
| Advanced | heartbeat, check interval, MQTT keepalive | trade-off between reaction time and mobile data |
| | observation after update, start timeout | verification of a rollout |
| | backup before every update | only disable for tests |

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

Files in `iobroker-data/bee.0/`: `device.json` (certificate and key, mode 0600), `desired.json`, `job.json`, `runner.json`, `runner.log` (complete CLI output of all jobs).

## Not in this version

Platform updates of js-controller and Node.js (with a systemd watchdog outside ioBroker), vis-2 project distribution, remote console (PTY), signed artifacts. See the concept of the beekeeper project.

## Development

```bash
npm install
npm run build
npm test          # unit tests of planner, preflight and diff
```

`src/lib/protocol.ts` is shared with the server and must stay identical to `beekeeper-server/src/protocol.ts`.

## Changelog

### 0.1.0 (2026-09-18)

- Initial prototype: enrollment, inventory, desired state via MQTT, adapter rollout with preflight, backup, verification and rollback

## License

Not decided yet (see concept: MIT only if intended, otherwise a license that restricts operation against a third-party server).
