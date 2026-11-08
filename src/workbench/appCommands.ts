import { invoke } from "@tauri-apps/api/core";
import { useAgentsStore } from "../store/agents";
import { useAgentLogsStore } from "../store/agentLogs";
import { useProfilesStore } from "../store/profiles";
import { useSessionsStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { useUiStore, type ViewId } from "../store/ui";
import { closeActiveTerminal, openAgent, openFile, openProfile, openTerminal, toggleTerminalPanel } from "./commands";

export interface AppCommand {
  id: string;
  title: string;
  category: string;
  run: () => void;
}

/** Default shortcuts; users override them in settings.json → "keybindings". */
export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  "palette.open": "Ctrl+Shift+P",
  "files.quickOpen": "Ctrl+P",
  "view.toggleSidebar": "Ctrl+B",
  "view.togglePanel": "Ctrl+J",
  "terminal.toggle": "Ctrl+`",
  "terminal.new": "Ctrl+Shift+`",
  "view.files": "Ctrl+Shift+E",
};

const showView = (view: ViewId) => {
  const ui = useUiStore.getState();
  if (ui.activeView !== view || !ui.sidebarVisible) ui.selectView(view);
};

/** All commands available now (static ones plus one per profile and per agent). */
export function allCommands(): AppCommand[] {
  const ui = () => useUiStore.getState();
  const cmds: AppCommand[] = [
    { id: "palette.open", title: "Paleta poleceń", category: "Widok", run: () => ui().setPaletteOpen(true) },
    { id: "files.quickOpen", title: "Szybkie otwieranie pliku", category: "Pliki", run: () => ui().setQuickOpen(true) },
    { id: "view.toggleSidebar", title: "Pokaż / ukryj panel boczny", category: "Widok", run: () => ui().toggleSidebar() },
    { id: "view.togglePanel", title: "Pokaż / ukryj panel dolny", category: "Widok", run: () => ui().toggleBottomPanel() },
    { id: "view.terminals", title: "Pokaż terminale", category: "Widok", run: () => showView("terminals") },
    { id: "view.agents", title: "Pokaż agentów", category: "Widok", run: () => showView("agents") },
    { id: "view.sessions", title: "Pokaż sesje", category: "Widok", run: () => showView("sessions") },
    { id: "view.files", title: "Pokaż pliki", category: "Widok", run: () => showView("files") },
    { id: "view.settings", title: "Pokaż ustawienia", category: "Widok", run: () => showView("settings") },
    { id: "terminal.toggle", title: "Pokaż / ukryj terminal", category: "Terminal", run: toggleTerminalPanel },
    { id: "terminal.new", title: "Nowy terminal (profil domyślny)", category: "Terminal", run: () => void openTerminal() },
    { id: "terminal.split", title: "Podziel terminal", category: "Terminal", run: () => void openTerminal({ split: "right" }) },
    { id: "terminal.newInEditor", title: "Nowy terminal w obszarze edytora", category: "Terminal", run: () => void openTerminal({ dock: "main" }) },
    { id: "terminal.close", title: "Zamknij aktywny terminal", category: "Terminal", run: () => closeActiveTerminal() },
    { id: "profiles.refresh", title: "Wykryj profile terminali ponownie", category: "Terminal", run: () => void useProfilesStore.getState().refresh() },
    {
      id: "sessions.toggleRecording",
      title: useSessionsStore.getState().recordingEnabled ? "Wyłącz nagrywanie sesji agentów" : "Włącz nagrywanie sesji agentów",
      category: "Sesje",
      run: () => void useSessionsStore.getState().setRecording(!useSessionsStore.getState().recordingEnabled),
    },
    { id: "sessions.refreshLogs", title: "Odśwież rozmowy agentów", category: "Sesje", run: () => void useAgentLogsStore.getState().refresh() },
    {
      id: "theme.toggle",
      title: "Przełącz motyw jasny / ciemny",
      category: "Ustawienia",
      run: () => {
        const next = ui().resolvedTheme === "dark" ? "light" : "dark";
        ui().setTheme(next);
        void useSettingsStore.getState().update("theme", next);
      },
    },
    {
      id: "settings.openJson",
      title: "Otwórz settings.json",
      category: "Ustawienia",
      run: () => void invoke<string>("settings_ensure_file").then((p) => openFile(p)).catch(() => undefined),
    },
  ];
  for (const p of useProfilesStore.getState().profiles) {
    cmds.push({ id: `terminal.profile.${p.id}`, title: `Nowy terminal: ${p.name}`, category: "Terminal", run: () => void openProfile(p.id) });
  }
  const agents = useAgentsStore.getState();
  for (const a of agents.agents) {
    cmds.push({
      id: `agents.launch.${a.id}`,
      title: `Uruchom ${a.name}`,
      category: "Agenci",
      run: () => void openAgent(a.id, { profileId: agents.profileId, cwd: agents.projectDir }),
    });
  }
  return cmds;
}
