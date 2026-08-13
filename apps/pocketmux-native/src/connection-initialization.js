export async function initializeConnections({
  operation,
  isCurrent,
  hydrateCredentials,
  migrateLegacyCredentials,
  applyHydratedState,
  applyCompletedState,
}) {
  const hydration = await hydrateCredentials();
  const supersededAfterHydration = !isCurrent(operation);
  if (supersededAfterHydration) applyHydratedState(hydration);
  const migrated = await migrateLegacyCredentials(hydration.states);
  if (!isCurrent(operation)) {
    if (!supersededAfterHydration) applyHydratedState(hydration);
    return { superseded: true, hydration, migrated };
  }

  await applyCompletedState({ hydration, migrated });
  return { superseded: false, hydration, migrated };
}
