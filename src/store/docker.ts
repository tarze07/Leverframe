import { create } from "zustand";
import { isTauri } from "../lib/tauri";
import { useProfilesStore } from "./profiles";
import {
  dockerClient,
  type DockerContainer,
  type DockerImage,
  type DockerInfo,
  type DockerSource,
  type DockerVolume,
  type JobEvent,
} from "../features/docker/dockerClient";

/** Docker in the "Kontenery" view: what it has, actions in progress and long jobs (pull, build). */

export interface DockerJob {
  /** Stable key in the view (known before the backend job starts). */
  key: number;
  /** Backend job id (0 until it started). */
  id: number;
  kind: "pull" | "build";
  title: string;
  lines: string[];
  done: boolean;
  ok: boolean;
  message: string | null;
}

/** Output kept per job (the view shows the end). */
export const MAX_JOB_LINES = 500;

interface DockerStore {
  info: DockerInfo | null;
  images: DockerImage[];
  containers: DockerContainer[];
  volumes: DockerVolume[];
  /** The image with agents of this version (`leverframe-agents:<version>`), once known. */
  agentsImage: string | null;
  /** This machine and the SSH profiles; `source`: the chosen one (null: this machine). */
  sources: DockerSource[];
  source: string | null;
  /** Shows the Docker of an SSH host (or this machine); its containers become profiles. */
  setSource: (id: string | null) => Promise<void>;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** What is being changed (container / image / volume name → true). */
  busy: Record<string, boolean>;
  jobs: DockerJob[];
  refresh: () => Promise<void>;
  /** Runs a change of `key` (shown as busy), then refreshes; a failure goes to `error`. */
  act: (key: string, change: () => Promise<unknown>) => Promise<boolean>;
  pull: (image: string) => Promise<void>;
  build: (dir: string, tag: string) => Promise<void>;
  /** Builds the image with agents (`leverframe-agents:<version>`). */
  buildAgentsImage: () => Promise<void>;
  cancelJob: (key: number) => void;
  dismissJob: (key: number) => void;
  clearError: () => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
let jobCounter = 0;

export const useDockerStore = create<DockerStore>()((set, get) => {
  const updateJob = (key: number, change: (j: DockerJob) => DockerJob) =>
    set((s) => ({ jobs: s.jobs.map((j) => (j.key === key ? change(j) : j)) }));

  const startJob = async (kind: DockerJob["kind"], title: string, run: (onEvent: (e: JobEvent) => void) => Promise<number>) => {
    const key = ++jobCounter;
    set((s) => ({ jobs: [...s.jobs, { key, id: 0, kind, title, lines: [], done: false, ok: false, message: null }] }));
    const onEvent = (e: JobEvent) => {
      if (e.type === "line") updateJob(key, (j) => ({ ...j, lines: [...j.lines, e.text].slice(-MAX_JOB_LINES) }));
      else {
        updateJob(key, (j) => ({ ...j, done: true, ok: e.ok, message: e.message }));
        if (e.ok) void get().refresh();
      }
    };
    try {
      const id = await run(onEvent);
      updateJob(key, (j) => ({ ...j, id }));
    } catch (e) {
      updateJob(key, (j) => ({ ...j, done: true, ok: false, message: message(e) }));
    }
  };

  return {
    info: null,
    images: [],
    containers: [],
    volumes: [],
    agentsImage: null,
    sources: [],
    source: null,
    status: "idle",
    error: null,
    busy: {},
    jobs: [],
    refresh: async () => {
      if (!isTauri()) return;
      set({ status: "loading" });
      try {
        const { sources, current } = await dockerClient.sources();
        set({ sources, source: current });
        const info = await dockerClient.info();
        if (!info.running) {
          set({ info, images: [], containers: [], volumes: [], status: "ready" });
          return;
        }
        const [images, containers, volumes, agentsImage] = await Promise.all([
          dockerClient.images(),
          dockerClient.containers(),
          dockerClient.volumes(),
          get().agentsImage ?? dockerClient.agentsImage().catch(() => null),
        ]);
        set({ info, images, containers, volumes, agentsImage, status: "ready" });
      } catch (e) {
        set({ status: "error", error: message(e) });
      }
    },
    act: async (key, change) => {
      set((s) => ({ busy: { ...s.busy, [key]: true }, error: null }));
      try {
        await change();
        return true;
      } catch (e) {
        set({ error: message(e) });
        return false;
      } finally {
        set((s) => {
          const busy = { ...s.busy };
          delete busy[key];
          return { busy };
        });
        await get().refresh();
      }
    },
    pull: (image) => startJob("pull", `Pobieranie ${image}`, (onEvent) => dockerClient.pull(image, onEvent)),
    build: (dir, tag) => startJob("build", `Budowanie ${tag}`, (onEvent) => dockerClient.build(dir, tag, onEvent)),
    setSource: async (id) => {
      if (id === get().source) return;
      try {
        const { sources, current } = await dockerClient.setSource(id);
        // Another Docker: other images, containers, jobs.
        set({ sources, source: current, info: null, images: [], containers: [], volumes: [], error: null });
      } catch (e) {
        set({ error: message(e) });
        return;
      }
      await get().refresh();
      // Its containers made for Leverframe become profiles.
      void useProfilesStore.getState().refresh();
    },
    buildAgentsImage: () =>
      startJob("build", `Budowanie ${get().agentsImage ?? "obrazu Leverframe"}`, (onEvent) => dockerClient.buildAgentsImage(onEvent)),
    cancelJob: (key) => {
      const job = get().jobs.find((j) => j.key === key);
      if (job?.id && !job.done) void dockerClient.cancel(job.id);
    },
    dismissJob: (key) => set((s) => ({ jobs: s.jobs.filter((j) => j.key !== key) })),
    clearError: () => set({ error: null }),
  };
});
