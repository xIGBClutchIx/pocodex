export function debugLog(scope: string, message: string, details?: unknown): void {
  if (!process.env.POCODEX_DEBUG) {
    return;
  }

  const prefix = `[pocodex:${scope}] ${message}`;
  if (details === undefined) {
    console.log(prefix);
    return;
  }

  try {
    console.log(prefix, JSON.stringify(details));
  } catch {
    console.log(prefix, String(details));
  }
}
