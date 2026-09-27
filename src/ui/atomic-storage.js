/** Persist a group of JSON records together, restoring prior values if a write fails. */
export function writeJsonBatch(storage, entries) {
  let writes;
  let previous;
  try {
    writes = entries.map(([key, value]) => [key, JSON.stringify(value)]);
    previous = writes.map(([key]) => [key, storage.getItem(key)]);
  } catch {
    return false;
  }
  let attempted = 0;
  try {
    for (const [key, value] of writes) {
      attempted += 1;
      storage.setItem(key, value);
    }
    return true;
  } catch {
    for (let index = attempted - 1; index >= 0; index -= 1) {
      const [key, value] = previous[index];
      try {
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
      } catch {
        // Continue best-effort rollback if storage is partially unavailable.
      }
    }
    return false;
  }
}
