<div align="center">
  <img src="public/assets/pocketmux-icon-192.png" width="120" height="120" alt="Pocketmux logo">
  <h1>Pocketmux</h1>
  <p><strong>A lightweight, mobile-first remote control surface for tmux.</strong></p>
  <p>Monitor long-running terminal work, interact with terminal-based agents, and manage tmux windows from a phone or desktop browser.</p>
</div>

## Overview

Pocketmux connects a small, self-hosted web interface to the tmux server already running on your computer. It captures recent pane output, sends text and approved control keys through tmux, and keeps the original terminal session as the source of truth.

Pocketmux is agent-agnostic. It works at the tmux pane boundary and requires no agent-specific SDK, plugin, or protocol, so it can control shells, development tools, and any interactive agent that runs inside tmux.

Unlike a general-purpose browser terminal, Pocketmux is designed for quickly checking and continuing existing terminal workflows while away from the keyboard.

## Highlights

- Switch between tmux sessions, windows, and panes from a responsive interface.
- Follow live terminal output automatically, with manual scrollback when needed.
- Continue terminal-based agent sessions with text, images, PDFs, documents, spreadsheets, and other common files.
- Send multiple mixed attachments with one prompt while preserving their original filenames.
- Send PDFs, photos, and videos from Codex on the host directly to the phone's Pocketmux inbox.
- Create named zsh windows in `~`, rename panes, and delete standalone tmux windows.
- Preview and accept zsh autosuggestions only when the selected pane is an interactive zsh shell.
- Use common terminal controls such as `Ctrl-C`, `Esc`, arrow keys, and `Enter`.
- Protect every API request with a bearer token.
- Run with Node.js built-in modules only—there are no runtime package dependencies.

## Requirements

- Node.js 20 or later
- tmux 3.x
- Linux or another environment supported by both Node.js and tmux

Pocketmux must run as the same operating-system user—and with the same `TMUX_TMPDIR`, when configured—as the tmux server it controls.

## Quick Start

```bash
git clone https://github.com/yuxin-kang/pocketmux.git
cd pocketmux
npm start
```

No `npm install` step is required. Pocketmux starts on port `3789`, generates an access token, and prints browser-ready URLs:

```text
pocketmux listening on 0.0.0.0:3789
Access token: <generated-token>
Open on your phone:
  http://<local-address>:3789/?token=<generated-token>
```

Open one of the printed URLs on your phone or desktop. The token is removed from the address bar after the page loads and retained by that browser for later visits.

## Remote Access

For regular remote access, place Pocketmux behind an encrypted private connection such as Tailscale or an SSH tunnel. For temporary testing, you can use a Cloudflare Quick Tunnel without creating a Cloudflare account.

The Android/Windows Pocketmux Native app also has a built-in **SSH tunnel** mode. It creates a local `-L` forward from the app to Pocketmux on the SSH server's `127.0.0.1:3789`, so no public tunnel is required. Enter the SSH account, Pocketmux access token, and accept the host-key fingerprint on first use. If the target host is reachable only through another SSH server, enable the app's **jump host** option: it connects to the jump host first, then opens the target SSH session through that connection. SSH mode is intended for foreground use; it does not keep a tunnel alive after the app exits.

### 1. Install `cloudflared`

On Debian or Ubuntu:

```bash
curl --location --output cloudflared.deb \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"
sudo dpkg -i cloudflared.deb
```

On macOS:

```bash
brew install cloudflared
```

For Windows, RPM-based Linux distributions, and manual binary downloads, follow the official [`cloudflared` installation guide](https://developers.cloudflare.com/tunnel/downloads/).

Confirm the installation:

```bash
cloudflared --version
```

### 2. Run Pocketmux and the tunnel in two terminals

Keep both terminal windows open while using Pocketmux.

In **Terminal 1**, start Pocketmux and copy the printed `Access token`:

```bash
cd pocketmux
HOST=127.0.0.1 PORT=3789 npm start
```

```text
Access token: 0123456789abcdef
```

In **Terminal 2**, start the Quick Tunnel and copy the generated `trycloudflare.com` URL:

```bash
cloudflared tunnel --url http://127.0.0.1:3789
```

```text
https://random-words.trycloudflare.com
```

### 3. Add the Pocketmux token to the public URL

Append `/?token=<pocketmux-token>` to the Cloudflare URL, then open the combined address on your phone:

```text
https://random-words.trycloudflare.com/?token=0123456789abcdef
```

Use the Pocketmux `Access token` printed in Terminal 1—not any Cloudflare credential. Treat both the public URL and token as sensitive. Restarting Pocketmux may generate a new token, and restarting the Quick Tunnel generates a new public URL.

[Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) are intended for testing and development only and do not provide an uptime guarantee.

## Using Pocketmux

### Sessions and panes

Pocketmux discovers live tmux sessions and panes automatically. Select a session and pane to view its recent output. Switching panes moves the view to the latest output; scroll upward whenever you need older terminal history.

### Window management

- Create a named standalone zsh window at the end of the selected tmux session.
- Rename any pane. For single-pane windows, the tmux window name is updated as well.
- Delete any live single-pane window after confirmation. Multi-pane windows are protected from deletion.

New zsh windows start in the current user's home directory. On eligible zsh panes, Pocketmux can preview the shell's visible autosuggestion, accept it with the right-arrow action, and execute it with `Enter`.

### Attachments for terminal agents

Select up to 10 attachments, add an optional prompt, and send them together to the current pane. Pocketmux stores each file temporarily on the host and adds its local path and original filename to the message. File analysis works with any receiving agent or tool that can read local paths on the Pocketmux host.

Supported formats include:

- Images: PNG, JPEG, GIF, and WebP
- Documents: PDF, DOC, DOCX, RTF, PPT, and PPTX
- Spreadsheets: XLS, XLSX, and CSV
- Text and data: TXT, Markdown, JSON, XML, YAML, and log files

| Limit | Value |
| --- | ---: |
| Attachments per message | 10 |
| Maximum image size | 10 MB |
| Maximum non-image file size | 25 MB |
| Maximum combined size per message | 50 MB |
| Temporary file lifetime | 24 hours |

Uploads are also removed when the Pocketmux process stops.

### Send a file from Codex to the phone

When Codex is running on the same computer and system user as Pocketmux, ask it to run:

```bash
npm run send-file -- /absolute/path/to/report.pdf
npm run send-file -- /absolute/path/to/notes.md
npm run send-file -- /absolute/path/to/photo.jpg
npm run send-file -- /absolute/path/to/recording.mp4
```

The command stages the file in Pocketmux's owner-only inbox. The phone app polls the inbox and shows a badge for new files. Markdown opens in the app; Android sends PDFs to the system PDF viewer and saves them in `Downloads/Pocketmux` at the same time, so devices without PDF support do not get a blank WebView. Files remain available across Pocketmux restarts for up to seven days, or until you delete them from the inbox. Browser use keeps the WebView/download fallback.

The inbox accepts common PDF, photo, and video formats up to 50 MB per file. Photos and videos preview in the app when the device WebView supports their codec; use **Download file** to save the original to `Downloads/Pocketmux`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Network interface on which the HTTP server listens |
| `PORT` | `3789` | HTTP server port |
| `REMOTE_TOOL_TOKEN` | Random token at startup | Persistent bearer token used to authorize browser requests |
| `POCKETMUX_OUTBOX_DIR` | `~/.local/share/pocketmux/outbox` | Persistent host directory used by `pocketmux-send-file` |

Example:

```bash
HOST=127.0.0.1 \
PORT=3789 \
REMOTE_TOOL_TOKEN='replace-with-a-long-random-token' \
npm start
```

## Security Model

- Every `/api/*` route requires `Authorization: Bearer <token>`.
- Backend operations are limited to discovered tmux targets and an explicit control-key allowlist.
- Text is transferred through a temporary tmux buffer rather than interpolated into a server-side shell command.
- The server does not expose a general process-spawning or shell-execution HTTP endpoint. Text sent to an interactive shell can still execute with the Pocketmux user's privileges.
- Attachments require authentication, are stored with owner-only permissions, and are never exposed as public static files.
- Host-to-phone files are staged through an owner-only outbox directory; the phone can only list or download them through the authenticated API and never receives an arbitrary host path.
- Terminal output is read from tmux on demand and is not persisted by Pocketmux.

Pocketmux serves plain HTTP by default and is designed for a trusted single-user environment. Do not expose port `3789` directly to the public internet; provide HTTPS or private-network encryption through the surrounding proxy or tunnel.

## How It Works

```text
Codex  →  Pocketmux outbox  →  Pocketmux HTTP API  →  phone inbox
Browser  →  Pocketmux HTTP API  →  tmux  →  shells, tools, and terminal agents
```

The browser refreshes session metadata and captures recent output from the selected pane. Pocketmux deliberately uses polling and tmux's native commands instead of emulating a complete terminal or parsing any agent's internal message format.

## Development

```bash
npm test
npm run dev
```

The test suite uses Node.js's built-in test runner. Product behavior, interaction rules, and visual constraints are documented in [`DESIGN.md`](./DESIGN.md).
