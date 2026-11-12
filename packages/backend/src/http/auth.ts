import { directory } from "../deployment/directory";
import { CONFIG } from "../shared/config";
import type { Env } from "../env";

export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(candidate), digest(expected)]);
  let different = 0;
  for (let index = 0; index < left.length; index++)
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

export function randomToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function cookieToken(request: Request): string | undefined {
  return request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CONFIG.cookieName}=`))
    ?.slice(CONFIG.cookieName.length + 1);
}

export async function authenticate(request: Request, env: Env) {
  const token = cookieToken(request);
  if (!token) return undefined;
  const tokenHash = await digest(token);
  const session = await directory(env).getLogin(tokenHash);
  return session ? { ...session, tokenHash } : undefined;
}

export function loginCookie(request: Request, token: string, maxAge: number): string {
  const url = new URL(request.url);
  const loopback =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return `${CONFIG.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${loopback ? "" : "; Secure"}`;
}

export function configured(env: Env): boolean {
  return Boolean(env.AMITA_OWNER_PASSWORD?.trim());
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return (
    (!origin || origin === new URL(request.url).origin) &&
    request.headers.get("Sec-Fetch-Site") !== "cross-site"
  );
}
