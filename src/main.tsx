import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MoyuMini from "./components/MoyuMini";
import { AppProvider } from "./store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import { initPlaybackLog, installPlaybackPageEvents } from "./playbackDiagnostics";

installPlaybackPageEvents();
void initPlaybackLog();

/* 运行期错误统一落到 debug.log，便于自查 */
function report(kind: string, msg: string) {
  invoke("debug_log", { msg: `[${kind}] ${msg}` }).catch(() => {});
}
window.addEventListener("error", (e) => {
  report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  report("reject", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

const isMoyu = getCurrentWindow().label === "moyu" || new URLSearchParams(window.location.search).has("moyu");

ReactDOM.createRoot(document.getElementById("root")!).render(
  isMoyu ? (
    <MoyuMini />
  ) : (
    <React.StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </React.StrictMode>
  ),
);
