#!/usr/bin/env node
// Report how far a variation is, so the Studio's "Final edits" tab can show it.
//   node studio/scripts/progress.mjs <finals.json> <branch-id> <percent 0-100> "<what you are doing now>" [status]
// status (optional): idea | building | draft | final | dropped   (100 % with no status = draft, ready to review)
import fs from "node:fs";
const [file, id, pct, step, status] = process.argv.slice(2);
if (!file || !id || pct === undefined) { console.error("usage: progress.mjs <finals.json> <branch-id> <0-100> \"<step>\" [status]"); process.exit(1); }
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const b = doc.branches.find((x) => x.id === id);
if (!b) { console.error(`no branch "${id}" in ${file}: ${doc.branches.map((x) => x.id).join(", ")}`); process.exit(1); }
const n = Math.max(0, Math.min(100, Math.round(Number(pct))));
b.progress = { pct: n, step: step ?? "", at: new Date().toISOString() };
if (status) b.status = status;
else if (b.status === "idea") b.status = "building";
else if (n >= 100 && b.status === "building") b.status = "draft";
doc.updatedAt = b.progress.at;
fs.writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
console.log(`${doc.title} · ${b.label}: ${n}% ${step ?? ""} (${b.status})`);
