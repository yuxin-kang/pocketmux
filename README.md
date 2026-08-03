# Pocketmux

Pocketmux is a lightweight, self-hosted web console for securely monitoring and controlling remote tmux sessions—including Codex workflows—from any modern browser.

## Features

- Browse tmux sessions, windows, and panes from a mobile-friendly interface.
- Identify Codex panes from their command or pane title.
- View recent pane output and send text or common control keys.
- Refresh pane output and session metadata automatically.
- Protect API access with a bearer token.
- Restrict backend operations to discovered tmux panes and a fixed control-key allowlist.

## Requirements

- Node.js 20 or later
- tmux 3.x
- A Linux user that owns the tmux server

Pocketmux uses Node.js built-in modules and has no runtime dependencies. `npm install` is not required.

## Quick start

Start Pocketmux as the same system user and with the same `TMUX_TMPDIR` as the tmux server:

```bash
npm start
```

The service prints an access token and a local URL. Open the URL in a browser, or use:

```text
http://<host>:3789/?token=<access-token>
```

To configure the bind address, port, or token explicitly:

```bash
HOST=0.0.0.0 \
PORT=3789 \
REMOTE_TOOL_TOKEN='replace-with-a-long-random-token' \
npm start
```

## Remote access

For access outside the local network, use Tailscale or an SSH tunnel. Keep Pocketmux on a trusted network and do not expose port `3789` directly to the public internet. The service currently uses HTTP rather than HTTPS, so encrypted transport must be provided by the surrounding network or proxy.

For temporary testing only, a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) can forward a localhost-bound instance. Treat the generated public URL and access token as sensitive.

## Security model

- Every `/api/*` route requires `Authorization: Bearer <token>`.
- The browser cannot submit arbitrary shell commands.
- The backend accepts only discovered tmux pane IDs and fixed control keys.
- Text is passed to tmux through its buffer rather than shell interpolation.
- Captured output is kept in memory and is not persisted by Pocketmux.

The access token is a bearer credential. Do not share URLs that contain `?token=...`.

## Troubleshooting

If no sessions are shown, verify that Pocketmux runs as the same Linux user as tmux and that both use the same `TMUX_TMPDIR`:

```bash
tmux list-sessions
```

Pocketmux preserves tmux window names and pane titles. It does not parse Codex's internal message format, which keeps it compatible with different Codex versions.

## Development

```bash
npm test
npm run dev
```

Product and interaction constraints are documented in [`DESIGN.md`](./DESIGN.md).
