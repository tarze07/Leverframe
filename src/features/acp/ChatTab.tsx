import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview-react";
import { requestChatScroll } from "../../store/chats";

/** Tab of a conversation: a click (also on the active tab) shows the end of the conversation. */
export function ChatTab(props: IDockviewPanelHeaderProps<{ chatId?: string }>) {
  return <DockviewDefaultTab {...props} onClick={() => requestChatScroll(props.params?.chatId ?? props.api.id)} />;
}
