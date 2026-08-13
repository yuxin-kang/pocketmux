export function planConnectionSwitch(selectedServer, authenticatedTargets) {
  if (!selectedServer) return { type: 'none' };
  const targetUrl = authenticatedTargets.get(selectedServer);
  if (targetUrl) return { type: 'connect', serverUrl: selectedServer, targetUrl };
  return { type: 'authenticate', serverUrl: selectedServer };
}
