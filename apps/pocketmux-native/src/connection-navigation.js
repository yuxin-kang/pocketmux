export async function persistBeforeRemoteNavigation({
  metadataPersisted,
  credentialAlreadyPersisted,
  persistCredential,
  isCurrent,
}) {
  const credentialPersisted = credentialAlreadyPersisted || (
    metadataPersisted ? await persistCredential() : false
  );
  return {
    cancelled: !isCurrent(),
    metadataPersisted,
    credentialPersisted,
  };
}
