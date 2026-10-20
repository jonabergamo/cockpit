# Security

Cockpit gives whoever can reach it a terminal on your machine, with your Claude Code login and your git credentials. Treat access to it like SSH access.

## How it's protected

- The server listens on `127.0.0.1` and only answers direct requests from that machine.
- A request from anywhere else, or one coming through a proxy, gets a 401 unless an access plugin lets it in. The bundled Tailscale plugin only trusts the `Tailscale-User-Login` header from a local `tailscale serve`.
- Plugin secrets are stored on the server in a SQLite file that only your user can read. The browser only ever sees the last four characters.
- The editor only opens files inside worktrees and folders you added, and config writes are limited to Claude's folders.
- Plugins run with full access to your machine, like editor extensions. Only install plugins you trust.

## Don't

- Bind it to `0.0.0.0` or put it on the internet without an access plugin in front.
- Share your `data/` folder. It holds the session index, plugin settings and tokens.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private reporting instead: the Security tab of the repository, then "Report a vulnerability". Include what an attacker needs, what they get, and the steps to reproduce it. You'll get an answer within a week.
