# Running cockpit on more than one machine

By default one cockpit does everything on the machine it runs on. You can also split it across machines: a hub you look at, and one or more nodes that do the work.

A common setup is a laptop as the hub and an always-on Linux box as the node. The hub has the screens, notifications, meetings (it has the microphone) and your settings. The node has the terminals, the Claude sessions, the repo and its worktrees, and the automations. Tasks, autopilot and the overnight queue keep running on the node while the laptop sleeps. When it wakes up, the hub catches up.

## Roles

Each cockpit has a `role` in `config.local.toml`:

| Role | What it does |
| --- | --- |
| `all` | Everything on this machine. This is the default, and it works exactly as cockpit always has. |
| `hub` | The screens, notifications, settings and plugins. Work happens on its nodes. |
| `node` | Terminals, Claude sessions, the repo and the automations, for its hub. It has no screens of its own. |

A node waits for its hub on port 8771. By default it only listens on this machine and on its Tailscale address, so only machines on your tailnet can reach it. You can change this in config:

```toml
[node]
port = 8771
listen = "tailscale"   # or "all", or one address
```

The hub always connects to the node, never the other way round. This means a hub that sleeps or moves between networks just reconnects when it can.

## Setting it up

1. On the node, set `role = "node"` (or run `cockpit node --adopt`), then run `cockpit service install`. It starts now and at every login. On Linux, `loginctl enable-linger` makes it start at boot.
2. On the hub, set `role = "hub"`, then run `cockpit service install`. On a Mac this installs a launchd agent.
3. On the hub, open Settings → Machines and add the node with its address, for example `devbox` or `100.x.y.z:8771`. With the Tailscale plugin on, its Machines screen lists your tailnet and has an "Add as node" button.
4. The hub shows a pairing command. Run it on the node:

   ```sh
   cockpit node pair --hub <hub id> --token <token>
   ```

The machine shows as connected within half a minute, or straight away if you press Try now. `cockpit service status` shows which cockpit service is installed and running on a machine.

## Moving a cockpit you already use

If one machine already runs everything and you want to move the screens to another, run this on the machine you have now:

```sh
cockpit migrate export
```

This writes `cockpit-hub-<date>.tar.gz`, with the part the hub keeps: settings, your plugins and their data, the sprint history, PR reviews and the "while you were away" log. Your Claude sessions, usage, tasks, runs and automations stay out of it, because they belong to this machine, which carries on as the node. The archive holds your plugins' secrets, so copy it over a private channel and delete it afterwards.

On the new hub, from a checkout of cockpit with `pnpm install` done:

```sh
cockpit migrate import cockpit-hub-<date>.tar.gz
cockpit service install
```

Check the paths in its `config.local.toml` (`repo`, `extraRoots`), since they came from the other machine. Then make the old machine the node:

```sh
cockpit node --adopt
cockpit service install
```

`service install` stops the old service on that machine, so only one cockpit runs on it. Then pair the two as in step 3 above.

## Where things run

Settings → Machines lists the kinds of work and where each one runs. Each can be set to Auto, This machine, or one of your nodes.

| Kind of work | Auto picks |
| --- | --- |
| Automations: tasks, the overnight queue, autopilot, checks after a session, stacked work, CI comparisons | The first node added, when this machine is a hub |
| Claude without a terminal: Ask cockpit, sprint notes, other `claude -p` runs | This machine |
| Transcription (Whisper, for meetings) | A machine with an NVIDIA GPU, if this one has none |

Claude and transcription run here instead if the machine they're set to isn't connected. Automations stay on their node, since they keep running there.

Some things always follow the folder they work on. A terminal, a worktree, the code view and `claude -p` started in a folder all run on the machine that has that folder. The Board shows each node's cards, built by that node, with the node's name on them.

To open a node's worktree in your editor, the hub runs `repo.openRemoteCommand`. By default that is `code --remote ssh-remote+{host} {path}`, so VS Code on the hub works on the node over ssh.

## When a machine goes away

- If the hub sleeps or closes, the node carries on. Anything it would have told you (a task finished, checks failed, Claude is waiting) is kept until the hub is back. It then arrives once, never twice, with older items grouped into one "While you were away" notification. The node keeps using the settings it last got from the hub.
- If the node can't be reached, its terminals stay listed as disconnected and typing is blocked, because keys sent later could land in the wrong prompt. They keep running on the node. When the link is back, each terminal picks up where it left off. Screens for the node's work say it isn't connected.
- If the node restarts, its terminals live in tmux, which survives the restart, so they come back too.
- If a request is cut off half way, nothing is done twice. A change sent to the node, like starting a task, carries an id. If the link drops before the answer, the hub asks again with the same id and the node returns what it already did.

## Security

- The hub and its node share a token, shown once in the pairing command. The node only stores a hash of it, in `data/node.json`, readable only by you.
- The token itself is never sent. When the hub connects, the node sends a random challenge and the hub answers with an HMAC of it.
- A node belongs to one hub. To move it to another, pair it again with `--replace`, which locks the old hub out.
- With `listen = "tailscale"`, connections from outside your tailnet are dropped before the handshake.
- Hub and node must run the same link version. If they don't, the node refuses the connection and Settings → Machines says to update the older one.

## Plugins

A plugin can run work on another machine. `k.where(cap)` says which machine a kind of work is set to run on. `k.expose` and `k.remote(machine).call` call the same plugin on that machine, and copy files over first. A plugin with `"nodes": true` in its manifest gets its settings copied to the nodes. Meetings uses all of this to transcribe on a node with a GPU. See [PLUGINS.md](../plugins/PLUGINS.md).

## Testing it

`pnpm remote` starts a hub and a node on one machine, each with its own data folder, and pairs them. It then goes through terminals, sessions, worktrees, the code view, automations, notifications while the hub is away, and placement. Run it after `pnpm build`.
