import { loadProject, saveReview } from "@/lib/server/projects";
import type { Review } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await loadProject((await params).id);
  return p ? Response.json(p) : Response.json({ error: "unknown project" }, { status: 404 });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    saveReview((await params).id, (await req.json()) as Review);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
