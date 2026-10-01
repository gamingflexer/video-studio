import { redirect } from "next/navigation";
import Studio from "@/components/Studio";
import { configuredWorkspace } from "@/lib/server/paths";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  if (!configuredWorkspace()) redirect("/"); // first run: choose the video folder first
  return <Studio id={(await params).id} />;
}
