# Pocketmux Native

Pocketmux Native is a lightweight Tauri 2 client for Windows and Android. It connects to a self-hosted Pocketmux server and displays the complete existing web interface inside a persistent native shell, with visible connection switching and refresh controls.

The native app is additive: it does not replace or modify the browser version of Pocketmux.

## Security boundary

- Only validated access tokens are retained, using Windows Credential Manager or Android Keystore-backed credential storage. Local WebView storage contains only normalized server metadata and display names.
- Android requires HTTPS for direct web addresses. The SSH mode uses a loopback-only local endpoint and forwards to Pocketmux on the SSH server's `127.0.0.1` without exposing that port publicly.
- Remote content runs in a sandboxed cross-origin frame and does not receive the global Tauri API.
- The reserved Tauri application host and any URL matching the launcher origin are rejected before loading.
- The app enables no shell, process, file-system, or custom native command permission.
- If metadata or credential storage is unavailable, the current connection can still open, but the app reports that it cannot be restored automatically later.

## Requirements

Common requirements:

- Node.js 20 or newer
- Rust stable
- Tauri 2 platform prerequisites: <https://v2.tauri.app/start/prerequisites/>

Install JavaScript dependencies once:

```bash
cd apps/pocketmux-native
npm install
```

### Windows

Install the Microsoft C++ Build Tools and WebView2 requirements described in the Tauri prerequisites. Build Windows installers on Windows; the Linux development environment cannot produce the supported MSI/NSIS release artifacts.

### Android

Install JDK 17 and the Android SDK/NDK through Android Studio or the official command-line tools. This repository already contains the generated Android project, so `npm run android:init` is not required during normal development.

The generated project currently targets:

- Android SDK Platform 36
- Android Build Tools 36
- Android NDK `29.0.13846066`
- Minimum Android API 24

Set `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME`, accept the Android SDK licenses yourself, and install the required Rust targets:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

## Development

Desktop:

```bash
npm run dev
```

Android, with a device or emulator available:

```bash
npm run android:dev
```

### SSH connection mode

When Pocketmux is listening only on the server (the default `127.0.0.1:3789`), choose **SSH tunnel** in the app instead of exposing it through Cloudflare. Enter the SSH host, port, username, password or OpenSSH private key, the Pocketmux token, and the server-side Pocketmux port. The first connection shows the SSH host-key fingerprint for explicit trust; a changed fingerprint is rejected. SSH credentials and the Pocketmux token are stored in the platform secure store, while the profile metadata never contains secrets.

The built-in mode provides local forwarding (`-L`) for foreground use. If the Pocketmux host is reachable only through another SSH server, enable **通过跳板机连接** and enter the jump host separately; the app authenticates the jump host first, then opens the target SSH connection through it. Both host-key fingerprints must be explicitly trusted. Reverse forwarding, SSH agent, keyboard-interactive MFA, and a background service when the app is stopped are not included.

## Build

Windows, from a Windows machine:

```bash
npm run windows:build
```

Android:

```bash
npm run android:build
```

Android release signing remains an operator-owned release step; private keys and signing properties are intentionally excluded from the repository.

Always use the `npm run android:*` commands instead of invoking `gradlew` directly. The build command regenerates and synchronizes adaptive icon resources before Tauri generates machine-specific Gradle files, native libraries, and properties.

## Validate

```bash
npm run check
npm test
cargo check --manifest-path src-tauri/Cargo.toml
```

The root Pocketmux web test suite should also stay green because native-app work must not change that application.
