import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme/index.css";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib/tauri";

// Start times (LEVERFRAME_TRACE_STARTUP=1, #115): the script has loaded.
if (isTauri()) void invoke("app_ready", { step: "skrypt wczytany" }).catch(() => undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
