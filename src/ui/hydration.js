// @ts-check

export async function runHydration(initialize, { documentRef, loadingElement, onError = () => {} }) {
  try {
    await initialize();
    return { ok: true };
  } catch (error) {
    try {
      onError(error);
    } catch {
      // The loading state still needs to end if the error message cannot render.
    }
    return { ok: false, error };
  } finally {
    if (documentRef?.documentElement) documentRef.documentElement.dataset.hydrating = "false";
    if (loadingElement) loadingElement.hidden = true;
  }
}
