import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview-react";
import { message } from "@tauri-apps/plugin-dialog";
import { useEditorStore } from "../../store/editor";

const SAVE = "Zapisz";
const DISCARD = "Nie zapisuj";
const CANCEL = "Anuluj";

/** Asks before closing an editor with unsaved changes. Returns true when the tab may close. */
export async function confirmCloseEditor(panelId: string): Promise<boolean> {
  const entry = useEditorStore.getState().editors[panelId];
  if (!entry?.dirty) return true;
  const choice = await message(`Plik ${entry.path} ma niezapisane zmiany.`, {
    title: "Niezapisane zmiany",
    kind: "warning",
    buttons: { yes: SAVE, no: DISCARD, cancel: CANCEL },
  });
  if (choice === SAVE || choice === "Yes") return entry.save();
  return choice === DISCARD || choice === "No";
}

/** Tab for editor panels: the close button checks for unsaved changes first. */
export function EditorTab(props: IDockviewPanelHeaderProps) {
  return (
    <DockviewDefaultTab
      {...props}
      closeActionOverride={() => {
        void confirmCloseEditor(props.api.id).then((ok) => ok && props.api.close());
      }}
    />
  );
}
