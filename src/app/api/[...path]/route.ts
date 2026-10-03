import type { NextRequest } from "next/server";
import { handleApi } from "@/server/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: NextRequest, context: Context) {
  return handleApi(request, (await context.params).path);
}
export { handle as GET, handle as POST, handle as DELETE };
