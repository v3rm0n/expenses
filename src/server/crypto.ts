import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config";
const derive = promisify(scrypt);
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const secretToken = () => randomBytes(32).toString("base64url");
export function equalSecret(a: string, b: string) {
  return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected || expected.length !== 128) return false;
  const actual = (await derive(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
export function encrypt(value: unknown): string {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(config.encryptionKey, "hex"),
      iv,
    );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
}
export function decrypt<T>(value: string): T {
  const data = Buffer.from(value, "base64"),
    cipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(config.encryptionKey, "hex"),
      data.subarray(0, 12),
    );
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(
      "utf8",
    ),
  );
}
