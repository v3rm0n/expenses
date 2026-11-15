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
const derive = promisify(scrypt) as (
  password: string,
  salt: string,
  length: number,
  options?: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const secretToken = () => randomBytes(32).toString("base64url");
export function equalSecret(a: string, b: string) {
  return timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
// scrypt work factors are stored with each hash. Older hashes in the form
// salt:hash used Node's defaults (N=16384, r=8, p=1).
const PASSWORD_COST = { N: 2 ** 17, r: 8, p: 1 };
const LEGACY_COST = { N: 2 ** 14, r: 8, p: 1 };
// Each derivation uses 128 MiB. Run them one at a time so concurrent sign-in
// attempts cannot exhaust memory.
let passwordQueue: Promise<unknown> = Promise.resolve();
function derivePassword(
  password: string,
  salt: string,
  cost: { N: number; r: number; p: number },
) {
  const result = passwordQueue.then(() =>
    derive(password, salt, 64, {
      ...cost,
      maxmem: 256 * cost.N * cost.r + 1024 * 1024,
    }),
  );
  passwordQueue = result.catch(() => undefined);
  return result;
}
function parsePasswordHash(stored: string) {
  const modern =
    /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([a-f\d]{32})\$([a-f\d]{128})$/.exec(stored);
  if (modern) {
    const cost = {
      N: Number(modern[1]),
      r: Number(modern[2]),
      p: Number(modern[3]),
    };
    if (cost.N > 2 ** 20 || cost.r > 32 || cost.p > 16) return null;
    return { cost, salt: modern[4], expected: modern[5] };
  }
  const [salt, expected] = stored.split(":");
  if (!salt || !expected || expected.length !== 128) return null;
  return { cost: LEGACY_COST, salt, expected };
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = await derivePassword(password, salt, PASSWORD_COST);
  const { N, r, p } = PASSWORD_COST;
  return `scrypt$${N}$${r}$${p}$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const actual = await derivePassword(password, parsed.salt, parsed.cost);
  return timingSafeEqual(actual, Buffer.from(parsed.expected, "hex"));
}
export function passwordNeedsRehash(stored: string) {
  const parsed = parsePasswordHash(stored);
  return (
    !parsed ||
    parsed.cost.N < PASSWORD_COST.N ||
    parsed.cost.r < PASSWORD_COST.r ||
    parsed.cost.p < PASSWORD_COST.p
  );
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
