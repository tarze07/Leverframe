import { useAgentsStore } from "../../store/agents";
import { useChatsStore } from "../../store/chats";
import { useProfilesStore } from "../../store/profiles";
import { useSettingsStore } from "../../store/settings";
import { refreshTaskCounts, useTasksStore, type LiveRun } from "../../store/tasks";
import { useTerminalStore } from "../../store/terminal";
import { notifyFilesChanged } from "../../lib/fileEvents";
import { openAgent, openAgentChat } from "../../workbench/commands";
import { prepareContainer } from "../docker/containerTerminal";
import { containerPath } from "../docker/paths";
import { isWindows } from "../terminal/keys";
import type { ProfileKind } from "../profiles/profilesClient";
import { tasksClient, type RunMode, type Task, type TaskRun } from "./tasksClient";
import { taskPrompt } from "./taskPrompt";

export { DEFAULT_TASK_PROMPT, taskPrompt } from "./taskPrompt";

const slashes = (p: string) => p.replaceAll("\\", "/");

/** A Windows path as WSL sees it: `C:\x` → `/mnt/c/x`, `\\wsl.localhost\Distro\home` → `/home`. */
export function wslPath(path: string): string {
  const unc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i.exec(path);
  if (unc) return slashes(unc[1] ?? "/");
  const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${slashes(drive[2])}`;
  return slashes(path);
}

/** `path` relative to `dir` when it is inside it (as typed to an agent working in `dir`). */
export function relativeTo(path: string, dir: string | null | undefined, windows = false): string {
  if (!dir) return path;
  const norm = (p: string) => (windows ? slashes(p).toLowerCase() : slashes(p)).replace(/\/+$/, "");
  const base = norm(dir);
  return norm(path).startsWith(`${base}/`) ? slashes(path).slice(base.length + 1) : path;
}

/** `file://…` of a path of the agent's computer (a resource link of ACP). */
export function fileUri(path: string): string {
  const p = slashes(path);
  return `file://${encodeURI(p.startsWith("/") ? p : `/${p}`)}`;
}

/** Where the agent finds the task: its path there, what the message names, the copy made (if any). */
export interface TaskLocation {
  path: string;
  shown: string;
  remote: string | null;
}

/**
 * The task file for an agent of a profile (#107, #108): on this machine (and WSL) the file itself;
 * in a container the mounted file when the container sees it, else a copy; on an SSH host a copy
 * in the server's folder of the profile (`~` by default).
 */
export async function locateTask(task: Task, profileId: string | null, kind: ProfileKind | undefined, cwd: string | null): Promise<TaskLocation> {
  const windows = isWindows();
  if (kind === "ssh" && profileId) {
    const dir = useAgentsStore.getState().remoteDirs[profileId] || "~";
    const path = await tasksClient.copyTo(task.scope, task.file, profileId, dir);
    return { path, shown: path, remote: path };
  }
  if (kind === "container" && profileId) {
    const prepared = await prepareContainer(profileId, cwd);
    const mounted = prepared && !prepared.remote ? containerPath(prepared.mounts, task.path, windows) : null;
    if (mounted) return { path: mounted, shown: relativeTo(mounted, prepared?.workdir), remote: null };
    const path = await tasksClient.copyTo(task.scope, task.file, profileId, prepared?.workdir || "~");
    return { path, shown: relativeTo(path, prepared?.workdir), remote: path };
  }
  if (kind === "wsl") {
    const path = wslPath(task.path);
    return { path, shown: relativeTo(path, cwd ? wslPath(cwd) : null), remote: null };
  }
  return { path: task.path, shown: relativeTo(task.path, cwd, windows), remote: null };
}

export interface StartTaskRun {
  task: Task;
  agentId: string;
  /** `null`: the default profile. */
  profileId: string | null;
  mode: RunMode;
  /** The folder the agent works in (this machine; ignored on SSH hosts). */
  cwd: string | null;
}

/**
 * Starts an agent on a task: the file where the agent sees it, the run noted in the task (which
 * goes to „W toku”), then a conversation sending the first message by itself, or a terminal
 * starting the agent with it. The run is watched: when it ends the task goes to „Do sprawdzenia”.
 */
export async function startTaskRun(o: StartTaskRun): Promise<{ task: Task; run: TaskRun }> {
  const profiles = useProfilesStore.getState();
  const profile = profiles.byId(o.profileId ?? profiles.defaultProfileId);
  const kind = profile?.kind;
  const cwd = kind === "ssh" ? null : o.cwd;
  const where = await locateTask(o.task, profile?.id ?? null, kind, cwd);
  const text = taskPrompt(useSettingsStore.getState().values.tasksPrompt as string | undefined, where.shown, o.task.title);
  const run: TaskRun = {
    at: new Date().toISOString(),
    agent: o.agentId,
    profile: profile?.id ?? "",
    mode: o.mode,
    cwd,
    remote: where.remote,
  };
  const task = await tasksClient.addRun(o.task.scope, o.task.file, run);
  const target =
    o.mode === "chat"
      ? openAgentChat(o.agentId, {
          profileId: profile?.id ?? null,
          cwd,
          initialPrompt: { text, resource: { uri: fileUri(where.path), name: o.task.file } },
        })
      : openAgent(o.agentId, { profileId: profile?.id ?? null, cwd, prompt: text });
  if (target) {
    useTasksStore.getState().addLive({ key: liveKey(task.path, run.at), scope: task.scope, file: task.file, path: task.path, mode: o.mode, target, sawBusy: false, seen: false });
  }
  notifyFilesChanged([task.path]);
  void refreshTaskCounts();
  return { task, run };
}

export const liveKey = (path: string, at: string) => `${path}|${at}`;

/** A run ended: the task goes from „W toku” to „Do sprawdzenia” (never from another status). */
async function finish(live: LiveRun) {
  useTasksStore.getState().removeLive(live.key);
  try {
    const now = (await tasksClient.list(live.scope)).find((t) => t.file === live.file);
    if (now?.status === "doing") await tasksClient.update(live.scope, live.file, { status: "review" });
  } catch {
    /* the task was moved or deleted meanwhile */
  }
  notifyFilesChanged([live.path]);
  void refreshTaskCounts();
}

/** Checks the running runs against their conversations and terminals. */
export function checkLiveRuns() {
  const { live, updateLive } = useTasksStore.getState();
  const chats = useChatsStore.getState().chats;
  const terminals = useTerminalStore.getState().running;
  for (const run of Object.values(live)) {
    if (run.mode === "chat") {
      const chat = chats[run.target];
      const status = chat?.state.status;
      if (!chat || status === "exited" || status === "error") void finish(run);
      else if (status === "busy" && !run.sawBusy) updateLive(run.key, { sawBusy: true });
      // The task's turn ended: the agent waits for the user.
      else if (status === "ready" && run.sawBusy) void finish(run);
    } else {
      // The terminal's tab registers itself once shown.
      const term = terminals.find((t) => t.panelId === run.target);
      if (term && !run.seen) updateLive(run.key, { seen: true });
      if ((run.seen && !term) || term?.exited) void finish(run);
    }
  }
}

/** Watches the conversations and terminals of tasks' runs (once, at start). */
export function watchTaskRuns(): () => void {
  const a = useChatsStore.subscribe(checkLiveRuns);
  const b = useTerminalStore.subscribe(checkLiveRuns);
  return () => {
    a();
    b();
  };
}
