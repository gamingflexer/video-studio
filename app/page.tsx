import Home from "@/components/Home";
import Setup from "@/components/Setup";
import { listProjects } from "@/lib/server/projects";
import { DEFAULT_WORKSPACE, WORKSPACE_FOLDERS, configuredWorkspace } from "@/lib/server/paths";

export const dynamic = "force-dynamic";

export default function Page() {
  const workspace = configuredWorkspace();
  if (!workspace) return <Setup suggested={DEFAULT_WORKSPACE} folders={WORKSPACE_FOLDERS} />;
  return <Home projects={listProjects()} workspace={workspace} />;
}
