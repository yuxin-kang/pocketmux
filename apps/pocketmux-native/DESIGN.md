# Pocketmux Native Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-11
- Product surfaces: Windows and Android native clients
- Evidence: root Pocketmux design, current browser UI, shared Pocketmux icon assets, and the existing token URL authentication flow
- Hard boundary: native work must not modify the existing root web application

## Brand

Pocketmux Native uses the existing Pocketmux identity: dark terminal surfaces, coral actions, restrained borders, compact monospace metadata, and the Pocketmux icon. The native shell should feel like an entry point to Pocketmux, not a separate product.

## Product goals

- Preserve every feature of the existing browser interface.
- Make connecting from Windows or Android quick and recoverable.
- Keep a recoverable but normally hidden native route back to saved connections after opening a server.
- Reuse saved connection credentials until the server explicitly rejects them, without exposing native privileges to remote content.

## Personas and jobs

- A developer on a phone wants to reconnect to a Pocketmux server and control remote tmux sessions.
- A desktop user wants an app window without losing the browser version.
- A self-hosting user wants private-LAN and tunnel connections with clear transport expectations.

## Information architecture

1. Launcher header: product identity and Chinese/English selector.
2. Connection launcher: server URL, optional token, transport feedback, and primary connect action.
3. Recent connections: up to five normalized server profiles, with validated tokens held separately in the operating-system credential store, plus open and remove actions.
4. Remote shell: edge menu handle, normally hidden connection drawer, full-screen remote Pocketmux page, and a branded loading cover.
5. Connection switcher: saved connections switch directly when selected; separate Add, Refresh, and App Exit actions remain fixed at the bottom of the drawer.

## Design principles

- Add a thin shell; do not recreate the terminal interface.
- Keep recovery reachable without consuming permanent viewport space: users can always open the edge drawer and return to server selection.
- Authenticate once: save a working token with its server profile and request a replacement only after the server explicitly returns an authentication failure.
- Degrade locally: storage failures must not prevent a valid remote connection.
- Prefer a single clear action per state.
- Keep security boundaries understandable in the UI copy.

## Visual language

- Background: near-black `#101114`; surfaces: `#17191e` to `#23262d`.
- Primary accent: Pocketmux coral `#f08269`; success: muted green `#78c9a5`.
- Sans-serif for product copy; monospace for hosts, URLs, status, and metadata.
- One subtle brand glow is allowed; bright platform-default surfaces and decorative effects are not.
- App icons use a near-black adaptive background and a flat coral twin-terminal mark. The mark stays inside Android's circular safe zone, avoids white plates, gradients, thin outlines, and details that disappear below 48px.

## Components

- Brand lockup and compact segmented language selector on the launcher only.
- Labeled URL and token inputs with explicit token visibility control.
- Full-width primary connection button.
- Semantic recent-server list with independent open/remove controls.
- A 44px remote edge handle, modal side drawer, loading cover, and sandboxed remote frame.
- Drawer actions for refresh, switching the selected connection, and exiting the Native App; drawer copy follows the language selected on the launcher.
- A dark, theme-native connection choice list rather than a platform-default select menu.
- Inline warning, error, loading, connected, and storage-degraded status messages.

## Accessibility

- Inputs use visible labels; errors and statuses use live-region semantics.
- Keyboard focus is visible on buttons, inputs, and the remote frame.
- Primary controls are at least 44px; form controls are 48px.
- The language selector remains deliberately compact but provides clear selected state and accessible labels.
- Reduced-motion preferences disable nonessential motion.

## Responsive behavior

- The launcher supports 360px Android widths and resizable Windows windows.
- Cards collapse from two columns to one below 760px.
- The remote shell occupies the complete dynamic viewport; launcher chrome is removed while connected.
- The drawer overlays rather than resizes the remote page and is closed by its close button, backdrop, Escape, or a swipe begun outside interactive controls.
- Drawer gestures must never capture taps that begin on buttons or other interactive descendants.
- Safe-area insets protect Android display cutouts and system gesture areas.

## Interaction states

- Empty: explain where a server URL or token-bearing URL belongs.
- Invalid: retain user input and show a localized inline error.
- Public HTTP: reject the connection and require HTTPS.
- Private HTTP on Windows: allow it with a clear trusted-network warning.
- HTTP on Android: reject it and direct the user to an HTTPS tunnel.
- Connecting: cover the embedded page while its token bootstrap settles so the web login screen does not flash as an intermediate step.
- Connected: reveal only the full-screen remote page; keep host, refresh, connection choices, Switch, and Exit controls in the hidden drawer. Reuse the launcher language choice without duplicating the selector.
- Switching: saved connections validate their token through the Native layer and switch directly. Only an authenticated Pocketmux HTTP 401 response clears the rejected token and returns to the launcher with the server URL prefilled; proxy/tunnel failures, HTTP 403, and other server errors retain the token.
- Exiting: the dedicated Exit action closes the Native App and never doubles as navigation or switching.
- Storage unavailable: continue opening the server and show a non-blocking warning.
- Returning after rejected credentials: close and clear the remote frame, clear the rejected saved token, prefill the server URL, and focus the token field.

## Content and voice

- Chinese and English carry identical information and actions.
- Copy is direct, short, and operational.
- State accurately that connection tokens are saved on the device; never imply that the App runs tmux locally.
- Use “server computer” for the machine running Pocketmux and “App” for the native client.

## Implementation constraints

- Tauri 2 and vanilla HTML/CSS/JavaScript. Native token validation uses a narrowly scoped Rust HTTP client and does not modify the existing Pocketmux web application.
- The local launcher remains the top-level document; the remote site loads in a sandboxed cross-origin frame.
- The top-level local launcher may expose Tauri Core only to invoke the registered app lifecycle, validation, and credential commands; the capability set stays at `core:default` and the cross-origin sandboxed remote frame cannot access the parent API.
- Persisted connection metadata lives in the Native launcher's local storage without tokens. Validated tokens use Windows Credential Manager or Android Keystore-backed credential storage; removing a connection deletes the matching credential.
- Token validation sends a Bearer token only to the selected server's same-origin, base-path-preserving `/api/health` endpoint, does not follow redirects, and accepts success only when the response carries the Pocketmux product/protocol marker. Only HTTP 401 is a confirmed credential rejection.
- Parent CSP permits HTTP(S) frames but no arbitrary network requests, remote scripts, objects, or native command bridge.
- The reserved `tauri.localhost` host and any target equal to the launcher origin are rejected before framing, preserving the cross-origin sandbox boundary.
- Android disables cleartext transport at both the launcher policy and manifest layers. Windows retains private/local HTTP support for trusted development networks.
- Windows browser-level general autofill is disabled; both connection fields also opt out of HTML autofill.
- Validation includes pure URL/storage tests, UI/security contract tests, JavaScript syntax checks, Rust checks, Tauri configuration validation, and confirmation that root web files are unchanged.

## Open questions

- Whether a later release should add QR scanning.
- Whether a later release should add optional biometric gating before reading saved credentials.
