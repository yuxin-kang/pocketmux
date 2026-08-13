export function retainCurrentLegacyCredentials(currentCredentials, remainingCredentials) {
  return currentCredentials.filter((current) => remainingCredentials.some(
    (remaining) => (
      remaining.serverUrl === current.serverUrl
      && remaining.token === current.token
    ),
  ));
}

export async function migrateLegacyCredentials(
  legacyCredentials,
  {
    buildConnection,
    credentialState,
    validateCredential,
    storeCredential,
    persistMigrationProgress,
  },
) {
  if (legacyCredentials.length === 0) {
    return { complete: true, remaining: [], failures: [] };
  }
  let remaining = [...legacyCredentials];
  const failures = [];
  const recordFailure = (legacyCredential, stage, error) => {
    failures.push({
      serverUrl: legacyCredential.serverUrl,
      stage,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  };

  for (const legacyCredential of legacyCredentials) {
    let connection;
    try {
      connection = buildConnection(
        legacyCredential.serverUrl,
        legacyCredential.token,
      );
    } catch (error) {
      recordFailure(legacyCredential, 'build', error);
      continue;
    }

    let state;
    try {
      state = await credentialState(connection);
    } catch (error) {
      recordFailure(legacyCredential, 'lookup', error);
      continue;
    }

    let resolved = state === 'present';
    if (state === 'missing') {
      let validation;
      try {
        validation = await validateCredential(connection);
      } catch (error) {
        recordFailure(legacyCredential, 'validate', error);
        continue;
      }
      if (validation === 'invalid') resolved = true;
      else if (validation === 'valid') {
        try {
          const stored = await storeCredential(connection);
          if (stored) resolved = true;
          else recordFailure(legacyCredential, 'store', new Error('credential-store-unavailable'));
        } catch (error) {
          recordFailure(legacyCredential, 'store', error);
        }
      } else {
        recordFailure(legacyCredential, 'validate', new Error('credential-validation-inconclusive'));
      }
    } else if (state !== 'present') {
      recordFailure(legacyCredential, 'lookup', new Error('credential-state-unavailable'));
    }

    if (resolved) remaining = remaining.filter((item) => item !== legacyCredential);
  }

  if (remaining.length > 0) return { complete: false, remaining, failures };

  // Keep the original plaintext migration record intact until every credential
  // is either secured or rejected. A process exit after a partial migration can
  // then safely resume: credentials already in the keyring are detected as
  // present, while unresolved credentials are retried.
  try {
    if (!persistMigrationProgress([])) {
      recordFailure(
        legacyCredentials[0],
        'persist',
        new Error('migration-progress-persistence-failed'),
      );
      return { complete: false, remaining: [...legacyCredentials], failures };
    }
  } catch (error) {
    recordFailure(legacyCredentials[0], 'persist', error);
    return { complete: false, remaining: [...legacyCredentials], failures };
  }

  return { complete: true, remaining: [], failures };
}
