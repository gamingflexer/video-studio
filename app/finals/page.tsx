import { redirect } from "next/navigation";
import Finals from "@/components/Finals";
import { listFinals } from "@/lib/server/finals";
import { configuredWorkspace } from "@/lib/server/paths";

export const dynamic = "force-dynamic";

export default function FinalsPage() {
  if (!configuredWorkspace()) redirect("/");
  return <Finals initial={listFinals()} />;
}
