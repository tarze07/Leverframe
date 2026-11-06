/** Live terminal instances by dock panel id, so commands can focus/clear them. */
export interface TerminalInstance {
  focus(): void;
  clear(): void;
}

const instances = new Map<string, TerminalInstance>();

export const terminalRegistry = {
  register(panelId: string, instance: TerminalInstance): () => void {
    instances.set(panelId, instance);
    return () => {
      if (instances.get(panelId) === instance) instances.delete(panelId);
    };
  },
  get: (panelId: string): TerminalInstance | undefined => instances.get(panelId),
};
