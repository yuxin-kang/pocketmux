import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('keeps a local native shell around the unmodified remote Pocketmux interface', async () => {
  const [html, main, rust, configText, capabilityText] = await Promise.all([
    readFile(path.join(root, 'src', 'index.html'), 'utf8'),
    readFile(path.join(root, 'src', 'main.js'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
  ]);
  const config = JSON.parse(configText);
  const capability = JSON.parse(capabilityText);

  assert.match(html, /连接后会直接打开原有网页界面/);
  assert.match(html, /id="remote-menu-toggle"[^>]+aria-expanded="false"/);
  assert.match(html, /id="remote-drawer"[^>]+aria-hidden="true"[^>]+inert/);
  assert.match(html, /id="refresh-remote"/);
  assert.match(html, /id="switch-target-list"/);
  assert.match(html, /id="switch-connection"/);
  assert.match(html, /id="exit-app"/);
  assert.doesNotMatch(html, /id="back-to-connections"/);
  assert.match(html, /id="remote-loading-cover"/);
  assert.doesNotMatch(html, /class="remote-toolbar"/);
  assert.doesNotMatch(html, /drawer-language-row/);
  assert.match(html, /id="remote-frame"[^>]+sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-modals"/);
  assert.match(main, /elements\.remoteFrame\.src = targetUrl/);
  assert.match(main, /beginRemoteSession\(serverUrl, targetUrl, storageWarning\)/);
  assert.match(main, /elements\.remoteFrame\.src = remoteSession\.targetUrl/);
  assert.match(main, /elements\.serverUrl\.value = connection\.serverUrl/);
  assert.match(main, /new URL\(connection\.serverUrl\)\.origin === window\.location\.origin/);
  assert.match(main, /REMOTE_LOAD_TIMEOUT_MS = 15000/);
  assert.match(main, /REMOTE_REVEAL_DELAY_MS = 1600/);
  assert.match(main, /requireAccessToken\(connection\)/);
  assert.match(main, /openRemoteDrawer/);
  assert.match(main, /closeRemoteDrawer/);
  assert.match(main, /keepFocusInRemoteDrawer/);
  assert.match(main, /shouldBeginDrawerSwipe/);
  assert.match(main, /if \(!shouldBeginDrawerSwipe\(event\.target\)\) return/);
  assert.match(main, /planConnectionSwitch/);
  assert.match(main, /window\.__TAURI__\?\.core\?\.invoke/);
  assert.match(main, /invoke\('exit_app'\)/);
  assert.match(main, /elements\.remoteFrame\.inert = true/);
  assert.match(main, /setRemoteState\('failed'\)/);
  assert.doesNotMatch(main, /window\.location\.(?:assign|replace)/);
  assert.match(main, /validateSavedToken/);
  assert.match(main, /invoke\('validate_token'/);
  assert.match(
    main,
    /const validationPromise = validateSavedToken\(connection\);[\s\S]*?showRemote\(connection\.serverUrl, connection\.targetUrl\);[\s\S]*?const validation = await validationPromise;/,
  );
  assert.match(main, /validation === 'invalid'[\s\S]*?if \(!isCurrentConnection\) return false;/);
  assert.match(main, /validation === 'valid' && isCurrentConnection[\s\S]*?rememberConnection\(connection\)/);
  assert.match(rust, /fn exit_app\(app: tauri::AppHandle\)/);
  assert.match(rust, /app\.exit\(0\)/);
  assert.match(rust, /async fn validate_token/);
  assert.match(rust, /StatusCode::UNAUTHORIZED \| StatusCode::FORBIDDEN/);
  assert.match(rust, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
  assert.match(rust, /generate_handler!\[exit_app, validate_token\]/);
  assert.equal(config.app.withGlobalTauri, true);
  assert.equal(config.app.windows[0].generalAutofillEnabled, false);
  assert.equal(config.identifier, 'io.github.yuxinkang.pocketmux');
  assert.equal(config.bundle.android.versionCode, 1001);
  assert.match(config.app.security.csp, /frame-src http: https:/);
  assert.deepEqual(capability.permissions, ['core:default']);
  assert.equal('remote' in capability, false);
});

test('disables native autofill and exposes accessible connection controls', async () => {
  const [html, styles] = await Promise.all([
    readFile(path.join(root, 'src', 'index.html'), 'utf8'),
    readFile(path.join(root, 'src', 'styles.css'), 'utf8'),
  ]);

  assert.match(html, /id="server-url"[^>]+autocomplete="off"/);
  assert.match(html, /id="access-token"[^>]+autocomplete="off"/);
  assert.match(html, /<ul id="recent-list"/);
  assert.match(html, /role="alert"/);
  assert.match(styles, /\.recent-open, \.recent-remove \{ min-height: 44px/);
  assert.match(styles, /\.remote-menu-toggle \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(styles, /\.drawer-action \{[\s\S]*?min-height: 48px;/);
  assert.match(styles, /\.app-frame\.is-remote \.topbar \{ display: none; \}/);
  assert.match(styles, /\.remote-drawer \{[\s\S]*?transform: translateX\(-105%\);/);
  assert.match(styles, /padding: env\(safe-area-inset-top\) max\(18px, env\(safe-area-inset-right\)\) 0 max\(18px, env\(safe-area-inset-left\)\)/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /prefers-reduced-motion/);
});

test('includes a generated Android project with Pocketmux identity and an HTTPS-only release policy', async () => {
  const androidRoot = path.join(root, 'src-tauri', 'gen', 'android');
  const [manifest, gradle, activity, wrapper] = await Promise.all([
    readFile(path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8'),
    readFile(path.join(androidRoot, 'app', 'build.gradle.kts'), 'utf8'),
    readFile(path.join(androidRoot, 'app', 'src', 'main', 'java', 'io', 'github', 'yuxinkang', 'pocketmux', 'MainActivity.kt'), 'utf8'),
    readFile(path.join(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8'),
  ]);

  await access(path.join(androidRoot, 'gradlew'));
  assert.match(manifest, /android:usesCleartextTraffic="\$\{usesCleartextTraffic\}"/);
  assert.doesNotMatch(gradle, /manifestPlaceholders\["usesCleartextTraffic"\] = "true"/);
  assert.match(gradle, /manifestPlaceholders\["usesCleartextTraffic"\] = "false"/);
  assert.match(gradle, /applicationId = "io\.github\.yuxinkang\.pocketmux"/);
  assert.match(gradle, /POCKETMUX_RELEASE_KEYSTORE/);
  assert.match(gradle, /signingConfigs\.findByName\("release"\)/);
  assert.match(gradle, /enableV1Signing = true/);
  assert.match(activity, /class MainActivity : TauriActivity\(\)/);
  assert.match(wrapper, /distributionSha256Sum=bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531/);
});

test('uses a dark, safe-zone Android adaptive icon without a white launcher plate', async () => {
  const iconSourceRoot = path.join(root, 'src-tauri', 'icon-source');
  const androidIconRoot = path.join(root, 'src-tauri', 'icons', 'android');
  const [iconManifestText, appIcon, foreground, adaptiveIcon] = await Promise.all([
    readFile(path.join(iconSourceRoot, 'icon-manifest.json'), 'utf8'),
    readFile(path.join(iconSourceRoot, 'pocketmux-app-icon.svg'), 'utf8'),
    readFile(path.join(iconSourceRoot, 'pocketmux-android-foreground.svg'), 'utf8'),
    readFile(path.join(androidIconRoot, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'utf8'),
  ]);
  const iconManifest = JSON.parse(iconManifestText);

  assert.equal(iconManifest.bg_color, '#111216');
  assert.equal(iconManifest.android_fg_scale, 76);
  assert.equal(iconManifest.android_bg, 'pocketmux-android-background.svg');
  assert.equal(iconManifest.android_monochrome, 'pocketmux-android-monochrome.svg');
  assert.match(appIcon, /fill="#111216"/);
  assert.match(appIcon, /stroke="#f08269"/);
  assert.match(foreground, /stroke="#ff987d"/);
  assert.doesNotMatch(appIcon, /gradient|#fff(?:fff)?/i);
  assert.match(adaptiveIcon, /@mipmap\/ic_launcher_background/);
  assert.match(adaptiveIcon, /@mipmap\/ic_launcher_foreground/);
  assert.match(adaptiveIcon, /@mipmap\/ic_launcher_monochrome/);

  await Promise.all([
    access(path.join(androidIconRoot, 'mipmap-xxxhdpi', 'ic_launcher.png')),
    access(path.join(androidIconRoot, 'mipmap-xxxhdpi', 'ic_launcher_background.png')),
    access(path.join(androidIconRoot, 'mipmap-xxxhdpi', 'ic_launcher_foreground.png')),
    access(path.join(androidIconRoot, 'mipmap-xxxhdpi', 'ic_launcher_monochrome.png')),
  ]);
});

test('routes Android builds through Tauri so ignored machine-specific Gradle glue is regenerated', async () => {
  const [packageText, androidIgnore, appIgnore] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'gen', 'android', '.gitignore'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'gen', 'android', 'app', '.gitignore'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(packageJson.scripts['android:build'], 'tauri android build');
  assert.match(androidIgnore, /\/tauri\.settings\.gradle/);
  assert.match(appIgnore, /\/tauri\.build\.gradle\.kts/);
});

test('provides Chinese and English native launcher copy with matching keys', async () => {
  const { messages } = await import('../src/i18n.js');
  assert.deepEqual(Object.keys(messages.zh).sort(), Object.keys(messages.en).sort());
});
