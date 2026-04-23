import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Expose the current frontend build id for smoke checks and force a fresh asset hash on deploy.
(window as Window & { __CALDAV_SYNC_SPA_BUILD__?: string }).__CALDAV_SYNC_SPA_BUILD__ =
  "2026-04-12-dashboard-assets-v2";

createRoot(document.getElementById("app")!).render(<App />);
