"use client";

import { useState } from "react";
import { copyText } from "@/lib/clipboard";

/** The hand-off prompt with its own Copy button (it is also copied automatically when it is made). */
export default function PromptBox({ prompt, rows = 10 }: { prompt: string; rows?: number }) {
  const [state, setState] = useState<"" | "ok" | "no">("");
  const copy = async () => {
    setState((await copyText(prompt)) ? "ok" : "no");
    setTimeout(() => setState(""), 2500);
  };
  return (
    <div className="promptbox">
      <div className="row">
        <button className="primary" onClick={copy}>{state === "ok" ? "Copied ✓" : "Copy prompt"}</button>
        {state === "no" && <span className="warn">The browser blocked copying — select the text below and press ⌘C.</span>}
        {state !== "no" && <span className="hint">Paste it into Claude Code.</span>}
      </div>
      <textarea className="prompt" readOnly rows={rows} value={prompt} onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}
