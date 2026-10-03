import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import { config } from "./config";
import { query, transaction } from "./db";
import {
  digest,
  equalSecret,
  hashPassword,
  secretToken,
  verifyPassword,
} from "./crypto";
import { AppError } from "./errors";

export async function sessionOwner() {
  const token = (await cookies()).get("expenses_session")?.value;
  if (!token) return null;
  const rows = await query(
    "SELECT o.name,s.token_hash FROM web_sessions s CROSS JOIN owner o WHERE s.token_hash=$1 AND s.expires_at>now()",
    [digest(token)],
  );
  return rows[0] || null;
}
export async function requireOwner() {
  const owner = await sessionOwner();
  if (!owner) throw new AppError("Please sign in to continue.", 401);
  return owner;
}
export function assertOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const allowed = [
    new URL(config.appUrl).origin,
    new URL(config.accessUrl).origin,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ];
  if (!origin || !allowed.includes(origin))
    throw new AppError("The request origin is not allowed.", 403);
}
export function clientIp(request: NextRequest) {
  return config.trustProxy
    ? request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local"
    : "local";
}
export async function limitLogin(request: NextRequest) {
  const key = digest(`login:${clientIp(request)}`);
  const [attempt] = await query(
    `INSERT INTO auth_attempts(key,expires_at) VALUES($1,now()+interval '15 minutes')
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_attempts.expires_at<now() THEN 1 ELSE auth_attempts.attempts+1 END,
    expires_at=CASE WHEN auth_attempts.expires_at<now() THEN now()+interval '15 minutes' ELSE auth_attempts.expires_at END RETURNING attempts`,
    [key],
  );
  if (attempt.attempts > 10)
    throw new AppError("Too many attempts. Try again in 15 minutes.", 429);
}
export async function createOwner(
  name: string,
  password: string,
  token: string,
) {
  if (!config.setupToken || !equalSecret(token, config.setupToken))
    throw new AppError("Use the setup link printed by npm run setup.", 403);
  if (password.length < 12 || password.length > 256)
    throw new AppError("Use a password between 12 and 256 characters.");
  if (!name.trim() || name.length > 80)
    throw new AppError("Enter your name (up to 80 characters).");
  const hash = await hashPassword(password);
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(4317002)");
    if ((await query("SELECT id FROM owner", [], db)).length)
      throw new AppError("The owner account has already been created.", 409);
    await db.query("INSERT INTO owner(id,name,password_hash) VALUES(1,$1,$2)", [
      name.trim(),
      hash,
    ]);
  });
}
export async function login(password: string) {
  if (!password || password.length > 256)
    throw new AppError("Incorrect password.", 401);
  const [owner] = await query("SELECT password_hash FROM owner WHERE id=1");
  if (!owner || !(await verifyPassword(password, owner.password_hash)))
    throw new AppError("Incorrect password.", 401);
}
export async function addSession(response: NextResponse, request: NextRequest) {
  const token = secretToken();
  await query(
    "INSERT INTO web_sessions(token_hash,expires_at) VALUES($1,now()+interval '30 days')",
    [digest(token)],
  );
  const secure =
    new URL(request.url).protocol === "https:" ||
    (config.trustProxy && request.headers.get("x-forwarded-proto") === "https");
  response.cookies.set("expenses_session", token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}
export async function logout(response: NextResponse) {
  const token = (await cookies()).get("expenses_session")?.value;
  if (token)
    await query("DELETE FROM web_sessions WHERE token_hash=$1", [
      digest(token),
    ]);
  response.cookies.delete("expenses_session");
}
