import { getJob, startRender, type RenderRequest } from "@/lib/server/render";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    return Response.json(await startRender((await req.json()) as RenderRequest));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function GET(req: Request) {
  const job = getJob(new URL(req.url).searchParams.get("id") ?? "");
  return job ? Response.json(job) : Response.json({ error: "unknown job" }, { status: 404 });
}
