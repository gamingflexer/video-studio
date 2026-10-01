import { deleteLook, listLooks, saveLook } from "@/lib/server/luts";
import { normalizeGrade } from "@/lib/color";
import type { Grade } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { name, grade } = (await req.json()) as { name: string; grade: Grade };
  if (!name?.trim()) return Response.json({ error: "give the look a name" }, { status: 400 });
  saveLook(name.trim(), normalizeGrade(grade));
  return Response.json({ looks: listLooks() });
}

export async function DELETE(req: Request) {
  deleteLook(new URL(req.url).searchParams.get("id") ?? "");
  return Response.json({ looks: listLooks() });
}
