export function createConnectionOperationTracker() {
  let generation = 0;

  return Object.freeze({
    begin() {
      generation += 1;
      return generation;
    },
    current() {
      return generation;
    },
    isCurrent(operation) {
      return operation === generation;
    },
  });
}
