/**
 * Types an agent's command into a freshly started shell once it is ready: after the output has been
 * quiet for a moment (the prompt is shown). It never types while the terminal is asking for a
 * password / passphrase / host key confirmation – it waits for the user to answer first.
 */

const SECRET_PROMPT = /(password|passphrase|hasło|verification code|one-time|\(yes\/no(\/\[fingerprint\])?\)|PIN)[^\n]*[:?]\s*$/i;

// ESC [ … final byte – colour and cursor sequences around a prompt.
const ANSI_CSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");

/** True when the last line of terminal output is a prompt for a secret or a confirmation. */
export function isAwaitingSecret(tail: string): boolean {
  const lastLine = tail.replace(ANSI_CSI, "").split(/\r?\n/).pop() ?? "";
  return SECRET_PROMPT.test(lastLine);
}

export interface AgentStarter {
  /** Feed decoded terminal output. */
  onOutput(text: string): void;
  dispose(): void;
}

export interface AgentStarterOptions {
  command: string;
  write: (data: string) => void;
  /** Quiet time after the last output before typing. */
  quietMs?: number;
  /** Type even without any output after this long (some shells print nothing). */
  fallbackMs?: number;
  onBlocked?: () => void;
  /** Press Enter after typing (default). `false` leaves the command for the user to review. */
  submit?: boolean;
}

export function createAgentStarter({
  command,
  write,
  quietMs = 400,
  fallbackMs = 4000,
  onBlocked,
  submit = true,
}: AgentStarterOptions): AgentStarter {
  let tail = "";
  let sent = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let blockedNotified = false;

  const attempt = () => {
    if (sent) return;
    if (isAwaitingSecret(tail)) {
      if (!blockedNotified) onBlocked?.();
      blockedNotified = true;
      return; // wait for more output (the user answers the prompt)
    }
    sent = true;
    write(submit ? `${command}\r` : command);
  };

  const schedule = (ms: number) => {
    if (sent) return;
    clearTimeout(timer);
    timer = setTimeout(attempt, ms);
  };

  schedule(fallbackMs);

  return {
    onOutput(text) {
      if (sent) return;
      tail = (tail + text).slice(-500);
      schedule(quietMs);
    },
    dispose() {
      clearTimeout(timer);
      sent = true;
    },
  };
}
