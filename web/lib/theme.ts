import { useSyncExternalStore } from "react";
import { readStorage, writeStorage } from "./storage";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "tapocalypse-theme";
const listeners = new Set<() => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");

function readTheme(): Theme {
  const stored = readStorage(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

let current: Theme = readTheme();

function apply(): void {
  const dark = current === "dark" || (current === "system" && media.matches);
  document.documentElement.classList.toggle("dark", dark);
}

apply();
media.addEventListener("change", apply);

export function setTheme(theme: Theme): void {
  current = theme;
  writeStorage(STORAGE_KEY, theme === "system" ? null : theme);
  apply();
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, () => current);
  return { theme, setTheme };
}
