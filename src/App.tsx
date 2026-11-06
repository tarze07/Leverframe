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

type VisibilityKey = "sidebarVisible" | "bottomPanelVisible";

/**
 * Keeps a collapsible panel in sync with a visibility flag in the store, in both directions:
 * store change -> collapse/expand, user drag past the collapse threshold -> store update.
 * Returns the `onResize` handler for the panel.
 */
function useCollapsibleSync(ref: React.RefObject<PanelImperativeHandle | null>, key: VisibilityKey) {
  const visible = useUiStore((s) => s[key]);

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
    if (nowVisible !== useUiStore.getState()[key]) useUiStore.setState({ [key]: nowVisible });
  };
}

export default function App() {
  useAppearance();
  useKeybindings();
  useEffect(() => {
    void useProfilesStore.getState().load();
  }, []);

  const sidebarRef = usePanelRef();
  const bottomRef = usePanelRef();
  const onSidebarResize = useCollapsibleSync(sidebarRef, "sidebarVisible");
  const onBottomResize = useCollapsibleSync(bottomRef, "bottomPanelVisible");

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
            <Group orientation="vertical" {...centerLayout}>
              <Panel id="workbench" minSize={120}>
                <Workbench />
              </Panel>
              <Separator className="lf-separator lf-separator-row" />
              <Panel
                id="bottom"
                panelRef={bottomRef}
                defaultSize={220}
                minSize={100}
                maxSize="80%"
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
    </div>
  );
}
