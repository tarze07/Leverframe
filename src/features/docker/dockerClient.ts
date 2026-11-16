import { Channel, invoke } from "@tauri-apps/api/core";

/** Docker as the backend reads it through the `docker` CLI (src-tauri/src/docker). */

export interface DockerInfo {
  installed: boolean;
  running: boolean;
  clientVersion: string | null;
  serverVersion: string | null;
  serverOs: string | null;
  /** Why Docker cannot be used (when not running). */
  message: string | null;
}

export interface DockerImage {
  id: string;
  /** `null` for untagged images. */
  repository: string | null;
  tag: string | null;
  size: string;
  createdAt: string;
  createdSince: string;
  /** An image with agents for Leverframe (label `io.leverframe.agents=1`). */
  leverframe: boolean;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  /** `running`, `exited`, `created`, `paused`, … */
  state: string;
  status: string;
  createdAt: string;
  ports: string;
  labels: Record<string, string>;
  leverframe: boolean;
}

export interface DockerVolume {
  name: string;
  driver: string;
  labels: Record<string, string>;
  leverframe: boolean;
}

export interface ContainerMount {
  kind: string;
  /** On this machine. */
  source: string;
  /** In the container. */
  destination: string;
  name: string | null;
  readWrite: boolean;
}

export interface ContainerDetails {
  id: string;
  name: string;
  image: string;
  state: string;
  running: boolean;
  user: string | null;
  workingDir: string | null;
  labels: Record<string, string>;
  mounts: ContainerMount[];
  leverframe: boolean;
}

/** A new container for agents, as the "Nowy kontener" form describes it. */
export interface ContainerSpec {
  image: string;
  name: string;
  /** Folder on this machine mounted as `/workspace`. */
  projectDir: string | null;
  /** A named volume for the home directory (the agents' logins survive the container). */
  homeVolume: boolean;
  homeDir: string;
  env: { name: string; value: string }[];
  ports: string[];
  network: string | null;
  user: string | null;
}

/** What creating the container will do (shown before it runs). */
export interface CreatePlan {
  args: string[];
  command: string;
  volume: string | null;
  warnings: string[];
}

/** Output of a long command (pull, build, logs) and its end. */
export type JobEvent = { type: "line"; text: string } | { type: "done"; ok: boolean; message: string | null };

export type ContainerAction = "start" | "stop" | "restart";

const job = (command: string, args: Record<string, unknown>, onEvent: (e: JobEvent) => void) =>
  invoke<number>(command, { ...args, onEvent: new Channel<JobEvent>(onEvent) });

export const dockerClient = {
  info: () => invoke<DockerInfo>("docker_info"),
  images: () => invoke<DockerImage[]>("docker_images"),
  containers: () => invoke<DockerContainer[]>("docker_containers"),
  volumes: () => invoke<DockerVolume[]>("docker_volumes"),
  inspect: (container: string) => invoke<ContainerDetails>("docker_inspect", { container }),
  createPlan: (spec: ContainerSpec) => invoke<CreatePlan>("docker_create_plan", { spec }),
  /** The new container's id. */
  create: (spec: ContainerSpec) => invoke<string>("docker_create", { spec }),
  containerAction: (container: string, action: ContainerAction) => invoke<void>("docker_container_action", { container, action }),
  removeContainer: (container: string, force: boolean) => invoke<void>("docker_remove_container", { container, force }),
  removeImage: (image: string) => invoke<void>("docker_remove_image", { image }),
  removeVolume: (volume: string) => invoke<void>("docker_remove_volume", { volume }),
  /** What Docker freed, e.g. "Total reclaimed space: 1.2GB". */
  pruneImages: () => invoke<string>("docker_prune_images"),
  /** Long commands: they return a job id for `cancel`; output and end arrive through `onEvent`. */
  pull: (image: string, onEvent: (e: JobEvent) => void) => job("docker_pull", { image }, onEvent),
  build: (dir: string, tag: string, onEvent: (e: JobEvent) => void, dockerfile?: string | null) =>
    job("docker_build", { dir, tag, dockerfile: dockerfile ?? null }, onEvent),
  logs: (container: string, onEvent: (e: JobEvent) => void) => job("docker_logs", { container }, onEvent),
  cancel: (jobId: number) => invoke<void>("docker_cancel", { job: jobId }),
};

/** How an image is named in lists: `repository:tag`, or its id when untagged. */
export const imageName = (i: DockerImage) => (i.repository ? `${i.repository}:${i.tag ?? "latest"}` : i.id.replace(/^sha256:/, "").slice(0, 12));
