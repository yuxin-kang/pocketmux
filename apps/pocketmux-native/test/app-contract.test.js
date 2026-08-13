import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function readRgbaPngAlphaBounds(buffer) {
  assert.equal(buffer.toString('ascii', 1, 4), 'PNG');
  const idatChunks = [];
  let width;
  let height;

  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.deepEqual([...data.subarray(8, 13)], [8, 6, 0, 0, 0]);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    }
    offset += length + 12;
  }

  assert.ok(width && height && idatChunks.length);
  const bytesPerPixel = 4;
  const rowLength = width * bytesPerPixel;
  const encoded = inflateSync(Buffer.concat(idatChunks));
  let previous = Buffer.alloc(rowLength);
  let cursor = 0;
  const bounds = { left: width, top: height, right: -1, bottom: -1 };

  for (let y = 0; y < height; y += 1) {
    const filter = encoded[cursor];
    cursor += 1;
    const row = Buffer.alloc(rowLength);
    for (let x = 0; x < rowLength; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paethPredictor(left, up, upLeft)][filter];
      assert.notEqual(predictor, undefined);
      row[x] = (encoded[cursor + x] + predictor) & 0xff;
    }
    cursor += rowLength;

    for (let x = 0; x < width; x += 1) {
      if (row[(x * bytesPerPixel) + 3] === 0) continue;
      bounds.left = Math.min(bounds.left, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.right = Math.max(bounds.right, x);
      bounds.bottom = Math.max(bounds.bottom, y);
    }
    previous = row;
  }

  assert.ok(bounds.right >= bounds.left && bounds.bottom >= bounds.top);
  return { width, height, bounds };
}

test('keeps a local native shell around the unmodified remote Pocketmux interface', async () => {
  const [html, main, validatedCredential, browserApp, browserHtml, rust, configText, capabilityText] = await Promise.all([
    readFile(path.join(root, 'src', 'index.html'), 'utf8'),
    readFile(path.join(root, 'src', 'main.js'), 'utf8'),
    readFile(path.join(root, 'src', 'validated-credential.js'), 'utf8'),
    readFile(path.join(root, '..', '..', 'public', 'app.js'), 'utf8'),
    readFile(path.join(root, '..', '..', 'public', 'index.html'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
  ]);
  const config = JSON.parse(configText);
  const capability = JSON.parse(capabilityText);

  assert.match(html, /连接后会直接打开原有网页界面/);
  assert.match(html, /styles\.css\?v=20260813-native-auth-bridge/);
  assert.match(html, /main\.js\?v=20260813-native-auth-bridge/);
  assert.match(html, /id="remote-menu-toggle"[^>]+aria-expanded="false"[\s\S]*?<span aria-hidden="true">›<\/span>/);
  assert.match(html, /id="remote-drawer"[^>]+aria-hidden="true"[^>]+inert/);
  assert.match(html, /id="refresh-remote"/);
  assert.match(html, /id="switch-target-list"[^>]+class="connection-list"[^>]+role="list"/);
  assert.match(html, /id="add-connection"/);
  assert.match(html, /id="exit-app"/);
  assert.match(html, /id="add-connection" class="drawer-action"[\s\S]*?<svg class="drawer-action-icon drawer-add-icon"[\s\S]*?M12 5v14M5 12h14/);
  assert.match(html, /id="refresh-remote" class="drawer-action"[\s\S]*?<svg class="drawer-action-icon drawer-refresh-icon"[\s\S]*?M21 12a9 9 0 1 1-2\.64-6\.36L21 8/);
  assert.match(html, /id="exit-app" class="drawer-action"[\s\S]*?<svg class="drawer-action-icon exit-outline-icon"[\s\S]*?<rect x="5" y="5" width="14" height="14"/);
  assert.match(html, /id="connection-name-dialog"[^>]+class="connection-name-dialog"/);
  assert.match(html, /id="connection-name"[^>]+maxlength="48"/);
  assert.doesNotMatch(html, /id="switch-connection"|Other server|其他服务器/);
  assert.doesNotMatch(html, /id="back-to-connections"/);
  assert.match(html, /id="remote-loading-cover"/);
  assert.doesNotMatch(html, /class="remote-toolbar"/);
  assert.doesNotMatch(html, /drawer-language-row/);
  assert.match(html, /id="remote-frame"[^>]+sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-modals"/);
  assert.match(main, /const nextFrame = elements\.remoteFrame\.cloneNode\(false\)/);
  assert.match(main, /nextFrame\.src = targetUrl/);
  assert.match(main, /connectionOperations\.isCurrent\(operation\)/);
  assert.match(main, /beginRemoteSession\(serverUrl, targetUrl, storageWarning\)/);
  assert.match(main, /elements\.serverUrl\.value = connection\.serverUrl/);
  assert.match(main, /new URL\(connection\.serverUrl\)\.origin === window\.location\.origin/);
  assert.match(main, /REMOTE_LOAD_TIMEOUT_MS = 15000/);
  assert.match(main, /requireAccessToken\(connection\)/);
  assert.match(main, /openRemoteDrawer/);
  assert.match(main, /closeRemoteDrawer/);
  assert.match(main, /keepFocusInRemoteDrawer/);
  assert.match(main, /shouldBeginDrawerSwipe/);
  assert.match(main, /REMOTE_HANDLE_POSITION_KEY/);
  assert.match(main, /resolveRemoteViewportHeight\(\{/);
  assert.match(main, /window\.__POCKETMUX_NATIVE_VIEWPORT__\?\.height/);
  assert.match(main, /window\.addEventListener\(NATIVE_VIEWPORT_EVENT_TYPE, updateNativeViewport\)/);
  assert.match(main, /style\.setProperty\('--remote-viewport-height', `\$\{Math\.floor\(height\)\}px`\)/);
  assert.match(main, /remoteMenuToggle\.addEventListener\('pointerdown', beginRemoteHandleDrag\)/);
  assert.match(main, /remoteMenuToggle\.addEventListener\('pointermove', moveRemoteHandle\)/);
  assert.match(main, /writeStoredValue\(storage, REMOTE_HANDLE_POSITION_KEY/);
  assert.match(main, /if \(!shouldBeginDrawerSwipe\(event\.target\)\) return/);
  assert.match(main, /planConnectionSwitch/);
  assert.match(main, /const savedToken = connectionTokens\.get\(candidate\.serverUrl\) \|\| ''/);
  assert.match(main, /targetUrl\.searchParams\.set\('native', '1'\)/);
  assert.match(main, /setLocalizedError\(error\)/);
  assert.match(main, /const targets = \[[\s\S]*?remoteSession\.serverUrl,[\s\S]*?recentServers\.filter/);
  assert.match(main, /const isUnavailable = isCurrent[\s\S]*?remoteSession\.state === 'failed'[\s\S]*?!authenticatedTargets\.has\(serverUrl\)/);
  assert.match(main, /button\.classList\.toggle\('is-unavailable', isUnavailable\)/);
  assert.match(main, /button\.addEventListener\('click', \(\) => void switchConnection\(serverUrl\)\)/);
  assert.match(main, /await navigateToServer\(plan\.targetUrl, '', \{ pushHistory: false \}\)/);
  assert.doesNotMatch(
    main,
    /async function switchConnection[\s\S]*?elements\.remoteNotice\.textContent = text\('remote\.validatingToken'\)[\s\S]*?function addConnection/,
  );
  assert.match(main, /renameConnectionProfile\([\s\S]*?renamingServerUrl,[\s\S]*?elements\.connectionName\.value/);
  assert.match(main, /elements\.addConnection\.addEventListener\('click', addConnection\)/);
  assert.doesNotMatch(main, /selectedSwitchTarget|NEW_SERVER_TARGET/);
  assert.match(main, /window\.__TAURI__\?\.core\?\.invoke/);
  assert.match(main, /invoke\('exit_app'\)/);
  assert.match(main, /elements\.remoteFrame\.inert = true/);
  assert.match(main, /setRemoteState\('failed', operation\)/);
  assert.doesNotMatch(main, /window\.location\.(?:assign|replace)/);
  assert.match(main, /validateSavedToken/);
  assert.match(main, /invoke\('validate_token'/);
  assert.match(
    main,
    /const operation = showRemote\(connection\.serverUrl, connection\.targetUrl,[\s\S]*?void monitorConnectionValidation\(connection, operation/,
  );
  assert.match(main, /async function monitorConnectionValidation\([\s\S]*?if \(!connectionOperations\.isCurrent\(operation\)\) return validation;/);
  assert.doesNotMatch(main, /const validationPromise = validateSavedToken\(connection\)/);
  assert.match(main, /validation === 'valid'[\s\S]*?persistConnectionAttempt\(attempt\)/);
  assert.match(main, /migrateLegacyCredentials\(legacyConnectionTokens/);
  assert.match(main, /const durableLegacyRecord = \[\.\.\.legacyConnectionTokens\]/);
  assert.match(main, /legacyConnectionTokens = migration\.complete[\s\S]*?durableLegacyRecord\.filter/);
  const rememberMetadataSource = main.slice(
    main.indexOf('function rememberConnectionMetadata('),
    main.indexOf('function nativeInvoke('),
  );
  const storeTokenSource = main.slice(
    main.indexOf('async function storeConnectionToken('),
    main.indexOf('async function storeLegacyConnectionToken('),
  );
  assert.doesNotMatch(rememberMetadataSource, /legacyConnectionTokens = legacyConnectionTokens\.filter/);
  assert.match(storeTokenSource, /await invoke\('set_connection_token'/);
  assert.match(storeTokenSource, /legacyConnectionTokens = legacyConnectionTokens\.filter/);
  assert.match(storeTokenSource, /if \(!persistConnectionProfiles\(\)\)/);
  assert.match(main, /const activeServers = new Set\(connectionProfiles\.map\([\s\S]*?durableLegacyRecord\.filter\([\s\S]*?activeServers\.has\(item\.serverUrl\)/);
  assert.match(main, /async function storeLegacyConnectionToken\(connection\)/);
  assert.match(main, /if \(!profileForServer\(connection\.serverUrl\) \|\| !pendingLegacyToken\) return true/);
  assert.match(main, /if \(connectionTokens\.has\(connection\.serverUrl\)\) return true/);
  assert.match(main, /saveConnectionProfiles\([\s\S]*?CONNECTION_PROFILES_KEY,[\s\S]*?connectionProfiles,[\s\S]*?legacyConnectionTokens/);
  assert.doesNotMatch(main, /profilesWithPendingLegacyTokens/);
  assert.match(main, /invoke\('set_connection_token'/);
  assert.match(main, /invoke\('get_connection_tokens'/);
  assert.match(main, /invoke\('delete_connection_token'/);
  assert.match(main, /invoke\('reject_connection_token'/);
  assert.doesNotMatch(main, /rememberConnectionProfile[\s\S]{0,200}token:/);
  assert.match(main, /async function restoreMostRecentConnection\(\)/);
  assert.match(main, /const token = profile \? connectionTokens\.get\(profile\.serverUrl\) : ''/);
  assert.match(main, /navigateToServer\(profile\.serverUrl, token, \{ pushHistory: false \}\)/);
  assert.match(main, /await initializeShellSession\(\)[\s\S]*?await initializeNativeApp\(\)/);
  assert.match(main, /window\.crypto\.getRandomValues\(bytes\)/);
  assert.match(main, /invoke\('register_shell_session', \{ sessionToken \}\)/);
  assert.match(main, /sessionToken: shellSessionToken/);
  assert.match(main, /event\.source !== elements\.remoteFrame\.contentWindow/);
  assert.match(main, /event\.origin !== new URL\(remoteSession\.serverUrl\)\.origin/);
  assert.match(main, /event\.data\?\.type === REMOTE_LANGUAGE_MESSAGE_TYPE/);
  assert.match(main, /setLanguage\(event\.data\.language\)/);
  assert.match(main, /REMOTE_AUTH_REQUIRED_MESSAGE_TYPE = 'pocketmux:authentication-required'/);
  assert.match(main, /REMOTE_AUTHENTICATION_SUCCEEDED_MESSAGE_TYPE = 'pocketmux:authentication-succeeded'/);
  assert.match(main, /initializeConnections\(\{/);
  assert.match(main, /isCurrent: \(operation\) => connectionOperations\.isCurrent\(operation\)/);
  assert.match(main, /applyCompletedState: async \(\{ hydration, migrated \}\)/);
  assert.match(validatedCredential, /metadataPersisted \? await persistCredential\(\) : false/);
  assert.match(main, /const credentialDeleted = await deleteConnectionToken\(serverUrl\)/);
  assert.doesNotMatch(main, /legacyMigrationPending/);
  assert.match(main, /elements\.accessToken\.addEventListener\('input'/);
  assert.match(browserApp, /NATIVE_AUTH_REQUIRED_MESSAGE_TYPE = 'pocketmux:authentication-required'/);
  assert.match(browserApp, /NATIVE_AUTHENTICATION_SUCCEEDED_MESSAGE_TYPE = 'pocketmux:authentication-succeeded'/);
  assert.match(browserApp, /publishAuthenticationSucceededToNativeShell\(\)/);
  assert.match(browserApp, /requirePocketmuxIdentity: true/);
  assert.match(browserApp, /isPocketmuxHealthPayload\(health\)/);
  assert.match(browserApp, /if \(nativeBootstrap\) document\.documentElement\.dataset\.nativeBootstrap/);
  assert.match(browserHtml, /new URLSearchParams\(window\.location\.search\)\.get\('native'\) === '1'/);
  assert.match(browserHtml, /document\.documentElement\.dataset\.nativeBootstrap = 'true'/);
  assert.match(browserApp, /if \(error\.unauthorized\) publishAuthenticationRequiredToNativeShell\(\)/);
  assert.match(browserApp, /response\.status === 401 && isPocketmuxApiResponse\(response\)/);
  assert.match(rust, /fn exit_app\(/);
  assert.match(rust, /app\.exit\(0\)/);
  assert.match(rust, /fn register_shell_session\(/);
  assert.match(rust, /fn authorize_shell_context\(/);
  assert.match(rust, /webview_label != "main"/);
  assert.match(rust, /expected_session != Some\(provided_session\)/);
  assert.match(rust, /async fn validate_token/);
  assert.match(rust, /StatusCode::UNAUTHORIZED if pocketmux_identity => "invalid"/);
  assert.match(rust, /fn has_pocketmux_identity/);
  assert.match(rust, /x-pocketmux-product/);
  assert.match(rust, /x-pocketmux-protocol-version/);
  assert.doesNotMatch(rust, /StatusCode::UNAUTHORIZED \| StatusCode::FORBIDDEN/);
  assert.match(rust, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
  assert.match(rust, /body\.product == POCKETMUX_PRODUCT/);
  assert.match(rust, /body\.protocol_version == POCKETMUX_PROTOCOL_VERSION/);
  assert.match(rust, /base_url\.join\("api\/health"\)/);
  assert.match(rust, /get_connection_tokens/);
  assert.match(rust, /set_connection_token/);
  assert.match(rust, /delete_connection_token/);
  assert.match(rust, /reject_connection_token/);
  const deleteCommand = rust.slice(
    rust.indexOf('fn delete_connection_token('),
    rust.indexOf('fn reject_connection_token('),
  );
  assert.doesNotMatch(deleteCommand, /expected_token:/);
  assert.match(rust, /tauri_plugin_keyring_store::init\(\)/);
  assert.match(rust, /tauri_plugin_single_instance::init/);
  assert.match(rust, /CredentialMutationLock\(Arc<Mutex<\(\)>>\)/);
  assert.match(rust, /fn with_credential_lock/);
  assert.match(rust, /fn set_connection_token\([\s\S]*?lock: tauri::State<'_, CredentialMutationLock>/);
  assert.match(rust, /fn delete_connection_token\([\s\S]*?lock: tauri::State<'_, CredentialMutationLock>/);
  assert.match(rust, /fn reject_connection_token\([\s\S]*?lock: tauri::State<'_, CredentialMutationLock>/);
  assert.match(rust, /get_webview_window\("main"\)[\s\S]*?window\.unminimize\(\)[\s\S]*?window\.show\(\)[\s\S]*?window\.set_focus\(\)/);
  assert.match(rust, /\.manage\(CredentialMutationLock\(Arc::new\(Mutex::new\(\(\)\)\)\)\)/);
  assert.match(rust, /generate_handler!\[[\s\S]*?register_shell_session,[\s\S]*?exit_app,[\s\S]*?validate_token,[\s\S]*?get_connection_tokens,[\s\S]*?set_connection_token,[\s\S]*?delete_connection_token,[\s\S]*?reject_connection_token/);
  assert.equal(config.app.withGlobalTauri, true);
  assert.equal(config.app.windows[0].generalAutofillEnabled, false);
  assert.equal(config.identifier, 'io.github.yuxinkang.pocketmux');
  assert.equal(config.bundle.android.versionCode, 1017);
  assert.match(config.app.security.csp, /frame-src http: https:/);
  assert.deepEqual(capability.permissions, ['core:default']);
  assert.equal('remote' in capability, false);
});

test('records a connection before asynchronous validation can be superseded', async () => {
  const main = await readFile(path.join(root, 'src', 'main.js'), 'utf8');
  const navigateSource = main.slice(
    main.indexOf('async function navigateToServer('),
    main.indexOf('async function restoreMostRecentConnection('),
  );
  const rememberIndex = navigateSource.indexOf('rememberConnectionMetadata(connection)');
  const showRemoteIndex = navigateSource.indexOf('showRemote(connection.serverUrl, connection.targetUrl');

  assert.ok(rememberIndex >= 0, 'navigation must record token-free connection metadata');
  assert.ok(showRemoteIndex >= 0, 'navigation must open the remote connection');
  assert.ok(
    rememberIndex < showRemoteIndex,
    'connection metadata must be recorded before the remote session can be superseded',
  );
  assert.match(navigateSource, /renderRecentServers\(\)/);
  assert.match(navigateSource, /storageWarning: !metadataPersisted/);
});

test('allows the active connection to be renamed before profile hydration completes', async () => {
  const main = await readFile(path.join(root, 'src', 'main.js'), 'utf8');
  const openDialogSource = main.slice(
    main.indexOf('function openConnectionNameDialog('),
    main.indexOf('function closeConnectionNameDialog('),
  );
  const submitSource = main.slice(
    main.indexOf("elements.connectionNameForm.addEventListener('submit'"),
    main.indexOf("elements.cancelConnectionName.addEventListener('click'"),
  );

  assert.doesNotMatch(openDialogSource, /if \(!profile\) return/);
  assert.match(openDialogSource, /profile\?\.name \|\| ''/);
  assert.match(submitSource, /rememberConnectionProfile\(/);
  assert.match(submitSource, /renameConnectionProfile\(/);
});

test('persists a validated token after the user switches to another server', async () => {
  const [main, validatedCredential] = await Promise.all([
    readFile(path.join(root, 'src', 'main.js'), 'utf8'),
    readFile(path.join(root, 'src', 'validated-credential.js'), 'utf8'),
  ]);
  const validationSource = main.slice(
    main.indexOf('async function monitorConnectionValidation('),
    main.indexOf('async function navigateToServer('),
  );

  assert.match(main, /createConnectionValidationTracker/);
  assert.match(main, /beginConnectionAuthentication/);
  assert.match(main, /recordWebAuthentication/);
  assert.match(main, /recordNativeValidation/);
  assert.match(main, /const validationAttempt = connectionValidations\.begin\(connection\.serverUrl\)/);
  assert.match(validationSource, /persistConnectionAttempt\(attempt\)/);
  assert.match(main, /REMOTE_AUTHENTICATION_SUCCEEDED_MESSAGE_TYPE = 'pocketmux:authentication-succeeded'/);
  assert.match(main, /event\.source !== elements\.remoteFrame\.contentWindow/);
  assert.match(main, /connectionAttemptForMessage/);
  assert.match(validationSource, /if \(!connectionOperations\.isCurrent\(operation\)\) return validation;/);
  assert.match(validatedCredential, /if \(!isCurrent\(\)\) \{[\s\S]*credentialPersisted: false/);
});

test('does not perform a synchronous keyring readback during token writes', async () => {
  const rust = await readFile(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const setTokenSource = rust.slice(
    rust.indexOf('fn set_connection_token('),
    rust.indexOf('fn delete_connection_token('),
  );

  assert.match(setTokenSource, /set_password\(&account, &token\)/);
  assert.doesNotMatch(setTokenSource, /get_password\(/);
});

test('keeps all keyring operations off the synchronous Tauri IPC thread', async () => {
  const rust = await readFile(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(rust, /async fn get_connection_tokens\(/);
  assert.match(rust, /async fn set_connection_token\(/);
  assert.match(rust, /async fn delete_connection_token\(/);
  assert.match(rust, /async fn reject_connection_token\(/);
  assert.equal((rust.match(/tauri::async_runtime::spawn_blocking/g) || []).length, 4);
});

test('only acknowledges native authentication after the remote shell initializes', async () => {
  const browserApp = await readFile(path.join(root, '..', '..', 'public', 'app.js'), 'utf8');
  const unlockSource = browserApp.slice(
    browserApp.indexOf('async function unlock('),
    browserApp.indexOf("elements.tokenForm.addEventListener('submit'"),
  );
  assert.ok(unlockSource.indexOf('showShell();') < unlockSource.indexOf('await refreshSessions();'));
  assert.ok(unlockSource.indexOf('await refreshSessions();') < unlockSource.indexOf('publishAuthenticationSucceededToNativeShell();'));
  assert.match(unlockSource, /if \(state\.token === unlockToken\)/);
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
  assert.match(styles, /\.recent-open, \.recent-rename, \.recent-remove \{ min-height: 44px/);
  assert.match(styles, /\.remote-menu-toggle \{[\s\S]*?top: 42%;[\s\S]*?width: 18px;[\s\S]*?height: 58px;/);
  assert.match(styles, /border-left: 2px solid var\(--accent\)/);
  assert.match(styles, /\.remote-menu-toggle \{[\s\S]*?cursor: grab;[\s\S]*?touch-action: none;/);
  assert.match(styles, /\.remote-menu-toggle\.is-dragging \{[\s\S]*?cursor: grabbing;/);
  assert.match(styles, /\.remote-menu-toggle\[aria-expanded="true"\] \{[^}]*visibility: hidden;[^}]*opacity: 0;[^}]*pointer-events: none;/);
  assert.match(styles, /\.drawer-action \{[\s\S]*?min-height: 44px;[\s\S]*?font-size: 9px;[\s\S]*?font-weight: 400;/);
  assert.match(styles, /\.drawer-action-icon \{[\s\S]*?width: 15px;[\s\S]*?height: 15px;[\s\S]*?stroke-width: 1\.7;/);
  assert.doesNotMatch(styles, /\.drawer-(?:add|refresh)-icon::/);
  assert.doesNotMatch(styles, /\.drawer-action-exit/);
  assert.match(styles, /\.drawer-actions \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.connection-item\.is-current/);
  assert.match(styles, /\.connection-item::after \{[^}]*width: 8px;[^}]*height: 8px;[^}]*background: var\(--success\);[^}]*content: '';/);
  assert.match(styles, /\.connection-item\.is-unavailable::after \{ background: var\(--danger\); \}/);
  assert.doesNotMatch(styles, /\.connection-item::after \{[^}]*content: '›'/);
  assert.match(styles, /\.app-frame\.is-remote \.topbar \{ display: none; \}/);
  assert.match(styles, /\.app-frame\.is-remote \{[^}]*height: var\(--remote-viewport-height, 100dvh\);[^}]*min-height: 0;/);
  assert.match(styles, /\.remote-shell \{[\s\S]*?height: 100%;/);
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
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/);
  assert.doesNotMatch(gradle, /manifestPlaceholders\["usesCleartextTraffic"\] = "true"/);
  assert.match(gradle, /manifestPlaceholders\["usesCleartextTraffic"\] = "false"/);
  assert.match(gradle, /applicationId = "io\.github\.yuxinkang\.pocketmux"/);
  assert.match(gradle, /testInstrumentationRunner = "androidx\.test\.runner\.AndroidJUnitRunner"/);
  assert.match(gradle, /POCKETMUX_RELEASE_KEYSTORE/);
  assert.match(gradle, /signingConfigs\.findByName\("release"\)/);
  assert.match(gradle, /enableV1Signing = true/);
  assert.match(activity, /class MainActivity : TauriActivity\(\)/);
  assert.match(activity, /SystemBarStyle\.dark\(Color\.TRANSPARENT\)/);
  assert.match(activity, /window\.decorView\.setBackgroundColor\(Color\.rgb\(16, 17, 20\)\)/);
  assert.match(activity, /override fun onWebViewCreate\(webView: WebView\)/);
  assert.match(activity, /WindowInsetsCompat\.Type\.systemBars\(\) or WindowInsetsCompat\.Type\.displayCutout\(\)/);
  assert.match(activity, /windowInsets\.getInsets\(WindowInsetsCompat\.Type\.ime\(\)\)\.bottom/);
  assert.match(activity, /view\.layoutParams as\? ViewGroup\.MarginLayoutParams/);
  assert.match(activity, /layoutParams\.setMargins\(safeArea\.left, safeArea\.top, safeArea\.right, safeArea\.bottom\)/);
  assert.match(activity, /WindowInsetsCompat\.Builder\(windowInsets\)[\s\S]*?\.setInsets\(handledTypes, Insets\.NONE\)[\s\S]*?\.build\(\)/);
  assert.match(activity, /window\.__POCKETMUX_NATIVE_VIEWPORT__ = viewport/);
  assert.match(activity, /CustomEvent\('pocketmux:native-viewport', \{ detail: viewport \}\)/);
  assert.match(activity, /activityDestroyed = true/);
  assert.match(activity, /activeWebView !== webView/);
  assert.match(activity, /!webView\.isAttachedToWindow/);
  assert.match(activity, /webView\.url == null/);
  assert.match(activity, /catch \(_:\s*RuntimeException\)/);
  assert.doesNotMatch(activity, /WindowInsetsCompat\.CONSUMED/);
  assert.doesNotMatch(activity, /view\.setPadding\(safeArea/);
  assert.match(activity, /ViewCompat\.requestApplyInsets\(webView\)/);
  assert.match(wrapper, /distributionSha256Sum=bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531/);
  const imeTest = await readFile(
    path.join(androidRoot, 'app', 'src', 'androidTest', 'java', 'io', 'github', 'yuxinkang', 'pocketmux', 'MainActivityImeTest.kt'),
    'utf8',
  );
  assert.match(imeTest, /remoteComposerRemainsInsideTheVisualViewportWhileImeIsVisible/);
  assert.match(imeTest, /frameBottom <= nativeViewportHeight \+ 3/);
  assert.match(imeTest, /composerBottom <= frameBottom \+ 2/);
  assert.match(imeTest, /pressBack\(\)/);
});

test('shows the complete Pocketmux mark in native brand containers', async () => {
  const styles = await readFile(path.join(root, 'src', 'styles.css'), 'utf8');

  assert.match(styles, /\.brand-mark img \{[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: contain;/);
  assert.match(styles, /\.drawer-header \.brand-mark \{ width: 40px; height: 40px;/);
  assert.match(styles, /\.loading-brand img \{[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: contain;/);
  assert.doesNotMatch(styles, /\.brand-mark img \{[^}]*16[05]%/);
});

test('uses a dark, safe-zone Android adaptive icon without a white launcher plate', async () => {
  const iconSourceRoot = path.join(root, 'src-tauri', 'icon-source');
  const androidIconRoot = path.join(root, 'src-tauri', 'icons', 'android');
  const generatedAndroidRoot = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');
  const [iconManifestText, appIcon, foreground, adaptiveIcon, legacyBackground, legacyForeground, backgroundColor] = await Promise.all([
    readFile(path.join(iconSourceRoot, 'icon-manifest.json'), 'utf8'),
    readFile(path.join(iconSourceRoot, 'pocketmux-app-icon.svg'), 'utf8'),
    readFile(path.join(iconSourceRoot, 'pocketmux-android-foreground.svg'), 'utf8'),
    readFile(path.join(androidIconRoot, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'utf8'),
    readFile(path.join(generatedAndroidRoot, 'drawable', 'ic_launcher_background.xml'), 'utf8'),
    readFile(path.join(generatedAndroidRoot, 'drawable-v24', 'ic_launcher_foreground.xml'), 'utf8'),
    readFile(path.join(generatedAndroidRoot, 'values', 'ic_launcher_background.xml'), 'utf8'),
  ]);
  const iconManifest = JSON.parse(iconManifestText);

  assert.equal(iconManifest.bg_color, '#111216');
  assert.equal(iconManifest.default, 'pocketmux-app-icon.svg');
  assert.equal(iconManifest.android_fg_scale, 21);
  assert.equal(iconManifest.android_bg, 'pocketmux-android-background.png');
  assert.equal(iconManifest.android_fg, 'pocketmux-android-foreground-layer.png');
  assert.equal(iconManifest.android_monochrome, 'pocketmux-android-monochrome-layer.png');
  assert.match(appIcon, /fill="#111216"/);
  assert.match(appIcon, /<circle cx="512" cy="512" r="320" fill="#111216"/);
  assert.match(appIcon, /stroke="#ff6f59"/);
  assert.match(appIcon, /transform="translate\(184\.32 184\.32\) scale\(\.64\)"/);
  assert.match(foreground, /stroke="#ff6f59"/);
  assert.doesNotMatch(appIcon, /gradient|#fff(?:fff)?/i);
  assert.match(adaptiveIcon, /@mipmap\/ic_launcher_background/);
  assert.match(adaptiveIcon, /@mipmap\/ic_launcher_foreground/);
  assert.match(adaptiveIcon, /@mipmap\/ic_launcher_monochrome/);
  assert.match(legacyBackground, /#111216/);
  assert.match(legacyForeground, /@mipmap\/ic_launcher_foreground/);
  assert.match(backgroundColor, /#111216/);
  assert.doesNotMatch(`${legacyBackground}\n${legacyForeground}`, /#3DDC84|M65\.3,45\.828/);

  await Promise.all([
    access(path.join(iconSourceRoot, 'pocketmux-app-icon.png')),
    access(path.join(iconSourceRoot, 'pocketmux-android-background.png')),
    access(path.join(iconSourceRoot, 'pocketmux-android-foreground-layer.png')),
    access(path.join(iconSourceRoot, 'pocketmux-android-monochrome-layer.png')),
    access(path.join(androidIconRoot, 'mipmap-xxxhdpi', 'ic_launcher.png')),
    access(path.join(androidIconRoot, 'mipmap-xxxhdpi', 'ic_launcher_background.png')),
    access(path.join(androidIconRoot, 'mipmap-xxxhdpi', 'ic_launcher_foreground.png')),
    access(path.join(androidIconRoot, 'mipmap-xxxhdpi', 'ic_launcher_monochrome.png')),
  ]);

  assert.deepEqual(
    await readFile(path.join(androidIconRoot, 'mipmap-xxxhdpi', 'ic_launcher_round.png')),
    await readFile(path.join(generatedAndroidRoot, 'mipmap-xxxhdpi', 'ic_launcher_round.png')),
  );
  assert.deepEqual(
    await readFile(path.join(androidIconRoot, 'mipmap-xxxhdpi', 'ic_launcher_foreground.png')),
    await readFile(path.join(generatedAndroidRoot, 'mipmap-xxxhdpi', 'ic_launcher_foreground.png')),
  );

  const foregroundPng = readRgbaPngAlphaBounds(
    await readFile(path.join(androidIconRoot, 'mipmap-xxxhdpi', 'ic_launcher_foreground.png')),
  );
  const safeExtent = Math.floor(foregroundPng.width * (66 / 108));
  const foregroundWidth = foregroundPng.bounds.right - foregroundPng.bounds.left + 1;
  const foregroundHeight = foregroundPng.bounds.bottom - foregroundPng.bounds.top + 1;
  assert.ok(foregroundWidth <= safeExtent, `${foregroundWidth}px foreground exceeds ${safeExtent}px safe width`);
  assert.ok(foregroundHeight <= safeExtent, `${foregroundHeight}px foreground exceeds ${safeExtent}px safe height`);
});

test('uses adaptive and round launcher entries so OEM launchers own the final mask', async () => {
  const generatedAndroidRoot = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main');
  const [manifest, iconSync] = await Promise.all([
    readFile(path.join(generatedAndroidRoot, 'AndroidManifest.xml'), 'utf8'),
    readFile(path.join(root, 'scripts', 'sync-android-icons.js'), 'utf8'),
  ]);

  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher"/);
  assert.doesNotMatch(iconSync, /pocketmux_launcher|mkdtemp|legacy-launcher/);

  const adaptiveIcon = await readFile(
    path.join(generatedAndroidRoot, 'res', 'mipmap-anydpi-v26', 'ic_launcher.xml'),
    'utf8',
  );
  assert.match(adaptiveIcon, /<adaptive-icon/);
  assert.match(adaptiveIcon, /@mipmap\/ic_launcher_background/);
  assert.match(adaptiveIcon, /@mipmap\/ic_launcher_foreground/);
});

test('routes Android builds through icon sync and Tauri so generated resources stay current', async () => {
  const [packageText, androidIgnore, appIgnore] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'gen', 'android', '.gitignore'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'gen', 'android', 'app', '.gitignore'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.match(packageJson.scripts['android:icons'], /tauri icon[\s\S]*prepare-android-icon-layers\.js[\s\S]*sync-android-icons\.js/);
  assert.equal(packageJson.scripts['android:build'], 'npm run android:icons && tauri android build');
  assert.match(androidIgnore, /\/tauri\.settings\.gradle/);
  assert.match(appIgnore, /\/tauri\.build\.gradle\.kts/);
});

test('provides Chinese and English native launcher copy with matching keys', async () => {
  const { messages } = await import('../src/i18n.js');
  assert.deepEqual(Object.keys(messages.zh).sort(), Object.keys(messages.en).sort());
});
