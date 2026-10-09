import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installStrike } from "./lib/strike";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
installStrike();
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
