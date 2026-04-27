const CSRF_TOKEN_VERSION = "v1";
const CSRF_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CSRF_PURPOSE = "notion-caldav-sync:csrf";

export const CSRF_HEADER_NAME = "x-csrf-token";

export async function createCsrfToken(
  secret: string,
  userId: string,
  nowMs = Date.now(),
): Promise<string> {
  const issuedAt = Math.floor(nowMs / 1000).toString();
  const signature = await hmacSha256Hex(secret, csrfMessage(userId, issuedAt));
  return `${CSRF_TOKEN_VERSION}.${issuedAt}.${signature}`;
}

export async function verifyCsrfToken(
  secret: string,
  userId: string,
  token: string | null | undefined,
  nowMs = Date.now(),
): Promise<boolean> {
  const parts = (token || "").split(".");
  if (parts.length !== 3) {
    return false;
  }
  const [version, issuedAt, actualSignature] = parts;
  if (version !== CSRF_TOKEN_VERSION || !issuedAt || !actualSignature) {
    return false;
  }
  const issuedAtMs = Number.parseInt(issuedAt, 10) * 1000;
  if (!Number.isFinite(issuedAtMs)) {
    return false;
  }
  if (issuedAtMs > nowMs + 60_000 || nowMs - issuedAtMs > CSRF_TOKEN_MAX_AGE_MS) {
    return false;
  }
  const expectedSignature = await hmacSha256Hex(secret, csrfMessage(userId, issuedAt));
  return timingSafeEqual(expectedSignature, actualSignature);
}

export function hasHostileBrowserOrigin(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== requestOrigin) {
    return true;
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      if (new URL(referer).origin !== requestOrigin) {
        return true;
      }
    } catch {
      return true;
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === "cross-site";
}

function csrfMessage(userId: string, issuedAt: string): string {
  return `${CSRF_PURPOSE}:${userId}:${issuedAt}`;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return diff === 0;
}
