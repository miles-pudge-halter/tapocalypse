/** localStorage that never throws: browsers that block site data raise on access, which must not blank the app. */
export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `null` removes the key. Best effort: a blocked or full store just means the preference is not remembered. */
export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}
