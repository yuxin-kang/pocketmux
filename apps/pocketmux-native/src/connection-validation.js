export function createConnectionValidationTracker() {
  const generations = new Map();

  return Object.freeze({
    begin(serverUrl) {
      const generation = (generations.get(serverUrl) || 0) + 1;
      generations.set(serverUrl, generation);
      return Object.freeze({ serverUrl, generation });
    },
    isCurrent(attempt) {
      return Boolean(attempt)
        && generations.get(attempt.serverUrl) === attempt.generation;
    },
  });
}
