import type { ViewId } from "../store/ui";

export interface ViewDef {
  id: ViewId;
  title: string;
  icon: string; // codicon name
}

/** Order of the activity bar. `settings` is pinned to the bottom. */
export const VIEWS: ViewDef[] = [
  { id: "terminals", title: "Terminale", icon: "terminal" },
  { id: "agents", title: "Agenci", icon: "hubot" },
  { id: "sessions", title: "Sesje", icon: "history" },
  { id: "files", title: "Pliki", icon: "files" },
  { id: "settings", title: "Ustawienia", icon: "settings-gear" },
];

export const viewById = (id: ViewId): ViewDef => VIEWS.find((v) => v.id === id) ?? VIEWS[0];
