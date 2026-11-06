/**
 * localStorage wrapper that never throws (private mode, blocked storage, tests).
 * Used only for per-user UI conveniences such as layout and sidebar state.
 */
export const safeStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  removeItem(key: string) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
