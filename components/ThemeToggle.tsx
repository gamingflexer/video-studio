"use client";

import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("studio-theme", next);
    } catch {
      /* private window: the choice just lasts for this page */
    }
    setTheme(next);
  };
  return <button onClick={flip} title="switch between dark and light">{theme === "dark" ? "Light mode" : "Dark mode"}</button>;
}
