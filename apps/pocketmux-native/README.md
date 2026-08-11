# Pocketmux Native

Pocketmux Native is a lightweight Tauri 2 client for Windows and Android. It connects to a self-hosted Pocketmux server and displays the complete existing web interface inside a persistent native shell, with visible connection switching and refresh controls.

The native app is additive: it does not replace or modify the browser version of Pocketmux.

## Security boundary

- Only normalized server addresses are remembered. Access tokens are never stored by the native launcher.
- Android requires HTTPS. Windows accepts cleartext HTTP only for localhost, private LAN, mDNS (`.local`), and Tailscale addresses.
- Remote content runs in a sandboxed cross-origin frame and does not receive the global Tauri API.
- The reserved Tauri application host and any URL matching the launcher origin are rejected before loading.
- The app enables no shell, process, file-system, or custom native command permission.
- If local storage is unavailable, the connection still opens and only connection history is skipped.

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

Always use the `npm run android:*` commands instead of invoking `gradlew` directly. Tauri generates machine-specific `tauri.settings.gradle`, `tauri.build.gradle.kts`, native libraries, and properties immediately before each Android build; those generated files are intentionally ignored.

## Validate

```bash
npm run check
npm test
cargo check --manifest-path src-tauri/Cargo.toml
```

The root Pocketmux web test suite should also stay green because native-app work must not change that application.
