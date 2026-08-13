export async function persistValidatedCredential({
  initialization,
  isCurrent,
  persistMetadata,
  persistCredential,
}) {
  await initialization;
  if (!isCurrent()) {
    return { cancelled: true, metadataPersisted: false, credentialPersisted: false };
  }

  const metadataPersisted = persistMetadata();
  if (!isCurrent()) {
    return { cancelled: true, metadataPersisted, credentialPersisted: false };
  }
  const credentialPersisted = metadataPersisted ? await persistCredential() : false;
  return { cancelled: !isCurrent(), metadataPersisted, credentialPersisted };
}
