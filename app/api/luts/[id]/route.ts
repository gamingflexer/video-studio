import { deleteLut, listLuts, loadLut } from "@/lib/server/luts";

export const dynamic = "force-dynamic";

/** raw float32 rgb triples (red fastest); the cube size is in X-Lut-Size */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const lut = loadLut((await params).id);
    if (!lut) return new Response("unknown LUT", { status: 404 });
    return new Response(new Uint8Array(lut.data.buffer, lut.data.byteOffset, lut.data.byteLength) as BodyInit, {
      headers: { "Content-Type": "application/octet-stream", "X-Lut-Size": String(lut.size), "Cache-Control": "no-cache" },
    });
  } catch (e) {
    return new Response((e as Error).message, { status: 500 });
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const ok = deleteLut((await params).id);
  return Response.json({ ok, luts: listLuts() }, { status: ok ? 200 : 400 });
}
