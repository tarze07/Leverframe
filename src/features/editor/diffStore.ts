/**
 * Texts of open change views, kept in memory: panel parameters are saved with the window layout,
 * where whole files do not belong. After a restart such a panel says the change is gone.
 */
const diffs = new Map<string, { oldText: string | null; newText: string }>();
let counter = 0;

export const diffStore = {
  put(diff: { oldText: string | null; newText: string }): string {
    const id = `d${Date.now().toString(36)}-${++counter}`;
    diffs.set(id, diff);
    return id;
  },
  get(id: string) {
    return diffs.get(id);
  },
};
