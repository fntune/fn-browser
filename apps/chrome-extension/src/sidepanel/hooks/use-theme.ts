import { useEffect, useState } from "react";

export type ThemeSetting = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "fn-browser:theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(setting: ThemeSetting): ResolvedTheme {
  if (setting === "auto") return systemPrefersDark() ? "dark" : "light";
  return setting;
}

function applyClass(theme: ResolvedTheme): void {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function useTheme(): {
  setting: ThemeSetting;
  resolved: ResolvedTheme;
  setSetting: (s: ThemeSetting) => void;
  cycle: () => void;
} {
  const [setting, setSettingState] = useState<ThemeSetting>("auto");
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve("auto"));

  // Initial load from chrome.storage.local.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      const stored = res[STORAGE_KEY] as ThemeSetting | undefined;
      const initial = stored ?? "auto";
      setSettingState(initial);
      const r = resolve(initial);
      setResolved(r);
      applyClass(r);
    });

    const onSystemChange = (): void => {
      setSettingState((current) => {
        if (current === "auto") {
          const r = resolve("auto");
          setResolved(r);
          applyClass(r);
        }
        return current;
      });
    };
    mq.addEventListener("change", onSystemChange);
    return () => mq.removeEventListener("change", onSystemChange);
  }, []);

  const setSetting = (s: ThemeSetting): void => {
    setSettingState(s);
    const r = resolve(s);
    setResolved(r);
    applyClass(r);
    void chrome.storage.local.set({ [STORAGE_KEY]: s });
  };

  const cycle = (): void => {
    const order: ThemeSetting[] = ["auto", "light", "dark"];
    const idx = order.indexOf(setting);
    setSetting(order[(idx + 1) % order.length]!);
  };

  return { setting, resolved, setSetting, cycle };
}
