# Pocketmux

Pocketmux is a lightweight, self-hosted web console for securely monitoring and controlling remote tmux sessions—including Codex workflows—from any modern browser.

## Features

- Browse tmux sessions, windows, and panes from a mobile-friendly interface.
- Create a named zsh window at the end of the selected tmux session.
- Delete live single-pane tmux windows with confirmation.
- Identify Codex panes from their command or pane title.
- View recent pane output and send text or common control keys.
- Show zsh autosuggestions in two steps: preview a partial command, then accept the visible suggestion with `Right`.
- Attach images and common files (PDF, text, Word, and Excel) with a custom prompt for Codex analysis.
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

## Attachment analysis

Use the `附件` button in the composer to select an image or common file, add an optional prompt, and send both to the selected Codex pane. Pocketmux stores the attachment locally on the host, then sends its local path followed by the prompt. Images are limited to 10 MB; other supported attachments are limited to 25 MB. Uploaded attachments are removed when the service stops or after 24 hours.

## Window creation and zsh completion

Use `＋ 新建 zsh` in the workspace section to add a standalone zsh window after the selected session's last window. It does not split the current pane and always starts in the current user's home directory (`~`). You can assign the new window an application-owned name. Select any live single-pane window and use `删除窗口` to remove it after confirmation; this includes existing windows and windows not created by Pocketmux. Windows containing multiple panes are protected from deletion. When the selected pane is an active, non-Codex `zsh` shell, `显示补全` becomes available for single-line partial commands; it types the fragment literally so zsh-autosuggestions can render the candidate in the terminal. After checking the visible candidate, click `接受 →` and then `执行 Enter` to run it. The normal `Enter` shortcut and the main send button also execute an already accepted zsh suggestion. Codex panes do not expose this action.

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
- Normal text is passed to tmux through its buffer rather than shell interpolation. Validated zsh completion fragments use tmux's literal keystroke mode so zsh-autosuggestions can react.
- Attachment uploads require the same bearer token, accept only supported image, document, and text formats, and are never served as public static files.
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
