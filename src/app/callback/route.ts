import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/server/auth";
import { completeBankAuthorization } from "@/server/banking";
import { migrate } from "@/server/db";
import { config } from "@/server/config";
import { publicError } from "@/server/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const target = new URL("/connections", config.appUrl);
  try {
    await migrate();
    const owner = await requireOwner(),
      params = request.nextUrl.searchParams;
    await completeBankAuthorization(
      params.get("state") || "",
      params.get("code") || "",
      owner.token_hash,
      params.get("error") || undefined,
    );
    target.searchParams.set("connected", "true");
  } catch (error) {
    target.searchParams.set("error", publicError(error));
  }
  return NextResponse.redirect(target, {
    status: 303,
    headers: { "Cache-Control": "private, no-store" },
  });
}
