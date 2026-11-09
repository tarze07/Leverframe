import { useEffect } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef, type PanelImperativeHandle } from "react-resizable-panels";
import { ActivityBar } from "./components/ActivityBar";
import { BottomPanel } from "./components/BottomPanel";
import { SideBar } from "./components/SideBar";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { Workbench } from "./components/Workbench";
import { safeStorage } from "./lib/storage";
import { useAppearance } from "./lib/useAppearance";
import { useKeybindings } from "./lib/useKeybindings";
import { useUiStore } from "./store/ui";
import { useProfilesStore } from "./store/profiles";
import { useSettingsStore } from "./store/settings";
import { QuickOpen } from "./features/editor/QuickOpen";
import { CommandPalette } from "./workbench/CommandPalette";

/**
 * Keeps a collapsible panel in sync with a visibility flag, in both directions:
 * flag change -> collapse/expand, user drag past the collapse threshold -> `onUserChange`.
 * Returns the `onResize` handler for the panel.
 */
function useCollapsibleSync(
  ref: React.RefObject<PanelImperativeHandle | null>,
  visible: boolean,
  onUserChange: (visible: boolean) => void,
) {
  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    if (visible && panel.isCollapsed()) panel.expand();
    else if (!visible && !panel.isCollapsed()) panel.collapse();
  }, [ref, visible]);

  return () => {
    const panel = ref.current;
    if (!panel) return;
    const nowVisible = !panel.isCollapsed();
    if (nowVisible !== visible) onUserChange(nowVisible);
  };
}

export default function App() {
  useAppearance();
  useKeybindings();
  useEffect(() => {
    void useProfilesStore.getState().load();
    void useSettingsStore.getState().load();
  }, []);

  const sidebarRef = usePanelRef();
  const workbenchRef = usePanelRef();
  const bottomRef = usePanelRef();
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const bottomPanelVisible = useUiStore((s) => s.bottomPanelVisible);
  const maximized = useUiStore((s) => s.maximized);
  const panelPosition = useUiStore((s) => s.panelPosition);
  const onSidebarResize = useCollapsibleSync(sidebarRef, sidebarVisible, (v) => useUiStore.getState().setSidebarVisible(v));
  const onBottomResize = useCollapsibleSync(bottomRef, bottomPanelVisible, (v) => useUiStore.getState().setBottomPanelVisible(v));
  // Dragging the separator all the way over the editor maximizes the terminal panel, and back.
  const onWorkbenchResize = useCollapsibleSync(workbenchRef, maximized !== "panel", (v) =>
    useUiStore.getState().setMaximized(v ? null : "panel"),
  );
  const side = panelPosition === "right";

  const mainLayout = useDefaultLayout({ id: "leverframe.layout.main", storage: safeStorage });
  const centerLayout = useDefaultLayout({ id: "leverframe.layout.center", storage: safeStorage });

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <Group orientation="horizontal" className="min-w-0 flex-1" {...mainLayout}>
          <Panel
            id="sidebar"
            panelRef={sidebarRef}
            defaultSize={260}
            minSize={170}
            maxSize="50%"
            collapsible
            groupResizeBehavior="preserve-pixel-size"
            onResize={onSidebarResize}
          >
            <SideBar />
          </Panel>
          <Separator className="lf-separator lf-separator-col" />
          <Panel id="center" minSize={300}>
            {/* Same children for both positions, so the terminals keep running when the panel moves. */}
            <Group orientation={side ? "horizontal" : "vertical"} {...centerLayout}>
              <Panel
                id="workbench"
                panelRef={workbenchRef}
                minSize={side ? 200 : 120}
                collapsible
                onResize={onWorkbenchResize}
              >
                <Workbench />
              </Panel>
              <Separator className={`lf-separator ${side ? "lf-separator-col" : "lf-separator-row"}`} />
              <Panel
                id="bottom"
                panelRef={bottomRef}
                defaultSize={side ? "40%" : 220}
                minSize={side ? 200 : 100}
                collapsible
                groupResizeBehavior="preserve-pixel-size"
                onResize={onBottomResize}
              >
                <BottomPanel />
              </Panel>
            </Group>
          </Panel>
        </Group>
      </div>
      <StatusBar />
      <QuickOpen />
      <CommandPalette />
    </div>
  );
}
