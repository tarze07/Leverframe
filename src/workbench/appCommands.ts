import { invoke } from "@tauri-apps/api/core";
import { useAgentsStore } from "../store/agents";
import { useAgentLogsStore } from "../store/agentLogs";
import { useProfilesStore } from "../store/profiles";
import { useSessionsStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { useUiStore, type ViewId } from "../store/ui";
import { THEMES, themeById } from "../theme/themes";
import { currentEditor, saveAllEditors } from "../store/editor";
import { dockRegistry } from "./docks";
import { closeActiveTerminal, openAgent, openAgentChat, openFile, openProfile, openTerminal, toggleTerminalPanel } from "./commands";

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
  "view.maximizePanel": "Ctrl+Shift+M",
};

/** Applies a theme now and stores it in settings.json; also becomes the preferred one of its kind. */
function setTheme(id: string) {
  const ui = useUiStore.getState();
  const settings = useSettingsStore.getState();
  ui.setTheme(id);
  const kind = themeById(id)?.kind;
  const key = kind === "dark" ? "darkTheme" : kind === "light" ? "lightTheme" : null;
  const updatePreferred = key !== null && ui[key] !== id;
  if (key && updatePreferred) ui.setThemePreferences({ [key]: id });
  // One write after the other: both change the same settings file.
  void (async () => {
    await settings.update("theme", id);
    if (key && updatePreferred) await settings.update(key, id);
  })();
}

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
    {
      id: "files.save",
      title: "Zapisz plik",
      category: "Pliki",
      run: () => void currentEditor(dockRegistry.get("main")?.activePanel?.id)?.[1].save(),
    },
    { id: "files.saveAll", title: "Zapisz wszystkie pliki", category: "Pliki", run: () => void saveAllEditors() },
    {
      id: "markdown.preview",
      title: "Markdown: pokaż / ukryj podgląd",
      category: "Pliki",
      run: () => {
        const entry = currentEditor(dockRegistry.get("main")?.activePanel?.id)?.[1];
        entry?.setView?.(entry.view === "preview" ? "edit" : "preview");
      },
    },
    {
      id: "markdown.previewSide",
      title: "Markdown: podgląd obok tekstu",
      category: "Pliki",
      run: () => {
        const entry = currentEditor(dockRegistry.get("main")?.activePanel?.id)?.[1];
        entry?.setView?.(entry.view === "split" ? "edit" : "split");
      },
    },
    { id: "view.togglePanel", title: "Pokaż / ukryj panel terminala", category: "Widok", run: () => ui().toggleBottomPanel() },
    {
      id: "view.maximizePanel",
      title: "Maksymalizuj / przywróć panel terminala (ukryj edytor)",
      category: "Widok",
      run: () => ui().togglePanelMaximized(),
    },
    {
      id: "view.maximizeEditor",
      title: "Maksymalizuj / przywróć edytor (ukryj panel terminala)",
      category: "Widok",
      run: () => ui().toggleEditorMaximized(),
    },
    {
      id: "view.panelPosition",
      title: ui().panelPosition === "bottom" ? "Przenieś panel terminala obok edytora" : "Przenieś panel terminala pod edytor",
      category: "Widok",
      run: () => ui().setPanelPosition(ui().panelPosition === "bottom" ? "right" : "bottom"),
    },
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
        // To the preferred theme of the other kind (darkTheme / lightTheme in settings.json).
        const { resolvedTheme, darkTheme, lightTheme } = ui();
        setTheme(resolvedTheme === "dark" ? lightTheme : darkTheme);
      },
    },
    {
      id: "settings.openJson",
      title: "Otwórz settings.json",
      category: "Ustawienia",
      run: () => void invoke<string>("settings_ensure_file").then((p) => openFile(p)).catch(() => undefined),
    },
  ];
  for (const t of THEMES) {
    cmds.push({
      id: `theme.set.${t.id}`,
      title: `Motyw: ${t.name} (${t.kind === "dark" ? "ciemny" : "jasny"})`,
      category: "Ustawienia",
      run: () => setTheme(t.id),
    });
  }
  for (const p of useProfilesStore.getState().profiles) {
    cmds.push({ id: `terminal.profile.${p.id}`, title: `Nowy terminal: ${p.name}`, category: "Terminal", run: () => void openProfile(p.id) });
  }
  const agents = useAgentsStore.getState();
  for (const a of agents.agents) {
    cmds.push({
      id: `agents.launch.${a.id}`,
      title: `Uruchom ${a.name} w terminalu`,
      category: "Agenci",
      run: () => void openAgent(a.id, { profileId: agents.profileId, cwd: agents.projectDir }),
    });
    if (a.acp) {
      cmds.push({
        id: `agents.chat.${a.id}`,
        title: `Rozmowa z ${a.name}`,
        category: "Agenci",
        run: () => void openAgentChat(a.id, { profileId: agents.profileId, cwd: agents.projectDir }),
      });
      cmds.push({
        id: `agents.chatPanel.${a.id}`,
        title: `Rozmowa z ${a.name} w panelu terminala`,
        category: "Agenci",
        run: () => void openAgentChat(a.id, { profileId: agents.profileId, cwd: agents.projectDir, dock: "panel" }),
      });
    }
  }
  return cmds;
}
