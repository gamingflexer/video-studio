import fs from "node:fs";
import { DEFAULT_WORKSPACE, WORKSPACE_FOLDERS, configuredWorkspace, setWorkspace } from "@/lib/server/paths";
import { listLuts } from "@/lib/server/luts";
import { run } from "@/lib/server/media";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ workspace: configuredWorkspace(), suggested: DEFAULT_WORKSPACE, folders: WORKSPACE_FOLDERS });
}

/**
 * First run: pick where the videos live.
 *   { action: "default" }        use ~/Movies/Video Studio
 *   { action: "choose" }         open the macOS folder picker on this Mac
 *   { action: "path", path }     use a typed path
 * The folder gets new-media/, videos/, "newly transferred videos and B-rolls"/ and luts/ if they are missing.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { action: "default" | "choose" | "path"; path?: string };
  let dir = DEFAULT_WORKSPACE;
  try {
    if (body.action === "choose") {
      try {
        const { stdout } = await run("osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose the folder that holds (or will hold) your videos")']);
        dir = stdout.toString().trim();
      } catch {
        return Response.json({ cancelled: true });
      }
    } else if (body.action === "path") {
      if (!body.path?.trim().startsWith("/")) return Response.json({ error: "Type the full path, starting with /" }, { status: 400 });
      dir = body.path.trim();
      if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) return Response.json({ error: "That is a file, not a folder" }, { status: 400 });
    }
    const workspace = setWorkspace(dir);
    listLuts(); // writes the house looks and the bundled free LUTs into <workspace>/luts
    return Response.json({ workspace });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
