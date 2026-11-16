import { invoke } from "@tauri-apps/api/core";

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

export const dockerClient = {
  info: () => invoke<DockerInfo>("docker_info"),
  images: () => invoke<DockerImage[]>("docker_images"),
  containers: () => invoke<DockerContainer[]>("docker_containers"),
  volumes: () => invoke<DockerVolume[]>("docker_volumes"),
  inspect: (container: string) => invoke<ContainerDetails>("docker_inspect", { container }),
};
