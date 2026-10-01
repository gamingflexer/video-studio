import { browse } from "@/lib/server/projects";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    return Response.json(browse(new URL(req.url).searchParams.get("dir") ?? ""));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
