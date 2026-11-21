import { listFinals, updateBranch } from "@/lib/server/finals";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(listFinals());
}

export async function POST(req: Request) {
  const { id, branch, status, note } = (await req.json()) as { id: string; branch: string; status?: string; note?: string };
  const allowed = ["idea", "building", "draft", "final", "chosen", "dropped"];
  if (status && !allowed.includes(status)) return Response.json({ error: "bad status" }, { status: 400 });
  const doc = updateBranch(id, branch, { status: status as never, note });
  return doc ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
}
