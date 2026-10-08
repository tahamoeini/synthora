// @ts-check

export function readStoredJson(storageSource, key, fallback, onReadFailure = () => {}) {
  try {
    const storage = typeof storageSource === "function" ? storageSource() : storageSource;
    const value = JSON.parse(storage.getItem(key) || "null");
    return value ?? fallback;
  } catch (error) {
    onReadFailure(error);
    return fallback;
  }
}
