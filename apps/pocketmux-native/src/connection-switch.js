export const NEW_SERVER_TARGET = '__pocketmux_new_server__';

export function planConnectionSwitch(selectedServer, authenticatedTargets) {
  if (!selectedServer) return { type: 'none' };
  if (selectedServer === NEW_SERVER_TARGET) {
    return { type: 'authenticate', serverUrl: '' };
  }
  const targetUrl = authenticatedTargets.get(selectedServer);
  if (targetUrl) return { type: 'connect', serverUrl: selectedServer, targetUrl };
  return { type: 'authenticate', serverUrl: selectedServer };
}
