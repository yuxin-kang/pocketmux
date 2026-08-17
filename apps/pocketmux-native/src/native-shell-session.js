export function createNativeShellSession({ initialize, getInvoke, onInitializationError = () => {} }) {
  let initializationPromise = null;

  const ensure = () => {
    if (!initializationPromise) {
      let initialization;
      try {
        initialization = initialize();
      } catch (error) {
        initialization = Promise.reject(error);
      }
      initializationPromise = Promise.resolve(initialization).then(() => {
        const invoke = getInvoke();
        if (!invoke) throw new Error('native bridge unavailable');
        return invoke;
      }).catch((error) => {
        initializationPromise = null;
        throw error;
      });
    }
    return initializationPromise;
  };

  return Object.freeze({
    ensure,
    async readyInvoke() {
      try {
        return await ensure();
      } catch (error) {
        onInitializationError(error);
        return null;
      }
    },
  });
}
