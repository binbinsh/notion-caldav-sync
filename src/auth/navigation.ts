export const AUTH_REDIRECT_QUERY_PARAM = "redirect_url";

const CANONICAL_AUTH_PATHS = new Set(["/dashboard", "/sign-in", "/sign-out"]);

export function buildServicePath(serviceBasePath: string, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${serviceBasePath}${suffix}` || "/";
}

export function buildClerkHostedAuthUrl(
  accountsUrl: string,
  requestUrl: string,
  route: "sign-in" | "sign-out",
  returnPath: string,
): string {
  const redirectUrl = new URL(returnPath, new URL(requestUrl).origin);
  const url = new URL(`${accountsUrl.replace(/\/$/, "")}/${route}`);
  url.searchParams.set(AUTH_REDIRECT_QUERY_PARAM, redirectUrl.toString());
  return url.toString();
}

export function resolveRequestedRedirectUrl(
  requestUrl: string,
  serviceBasePath: string,
  fallbackPath: string,
  requestedRedirectUrl: string | null,
): string {
  const currentUrl = new URL(requestUrl);
  const fallbackUrl = new URL(fallbackPath, currentUrl.origin).toString();
  if (!requestedRedirectUrl) {
    return fallbackUrl;
  }
  try {
    const requestedUrl = new URL(requestedRedirectUrl, currentUrl.origin);
    const allowedRoot = serviceBasePath || "/";
    const allowedPrefix = buildServicePath(serviceBasePath, "/");
    if (
      requestedUrl.origin === currentUrl.origin &&
      (requestedUrl.pathname === allowedRoot || requestedUrl.pathname.startsWith(allowedPrefix))
    ) {
      return requestedUrl.toString();
    }
  } catch {
    // ignore invalid redirect_url values
  }
  return fallbackUrl;
}

export function canonicalizeAuthPath(pathname: string): string | null {
  if (pathname === "/") {
    return null;
  }
  const trimmed = pathname.replace(/\/+$/g, "");
  if (!trimmed || trimmed === pathname) {
    return null;
  }
  if (!CANONICAL_AUTH_PATHS.has(trimmed)) {
    return null;
  }
  return trimmed;
}
