import { listLuts, saveGradeAsLut } from "@/lib/server/luts";
import { normalizeGrade } from "@/lib/color";
import type { Grade } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { name, grade } = (await req.json()) as { name: string; grade: Grade };
  if (!name?.trim()) return Response.json({ error: "give the LUT a name" }, { status: 400 });
  try {
    const lut = saveGradeAsLut(name.trim(), normalizeGrade(grade));
    return Response.json({ lut, luts: listLuts() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
