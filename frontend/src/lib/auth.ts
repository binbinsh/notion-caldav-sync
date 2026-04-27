const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const AUTH_REDIRECT_QUERY_PARAM = "redirect_url";

export class AuthRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRedirectError";
  }
}

export function getAppBasePath(): string {
  return BASE;
}

export function buildAppPath(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (BASE && (normalizedPath === BASE || normalizedPath.startsWith(`${BASE}/`))) {
    return normalizedPath;
  }
  return `${BASE}${normalizedPath}` || "/";
}

export function buildAppUrl(path: string): string {
  return `${window.location.origin}${buildAppPath(path)}`;
}

function buildAuthUrl(path: "/sign-in", returnPath: string): string {
  return `${buildAppUrl(path)}?${AUTH_REDIRECT_QUERY_PARAM}=${encodeURIComponent(
    buildAppUrl(returnPath),
  )}`;
}

export function buildSignInUrl(returnPath = "/dashboard"): string {
  return buildAuthUrl("/sign-in", returnPath);
}

export function redirectToSignIn(returnPath = "/dashboard"): never {
  window.location.href = buildSignInUrl(returnPath);
  throw new AuthRedirectError("Redirecting to product sign-in.");
}

export function buildAuthReturnUrl(returnPath = "/dashboard"): string {
  const url = new URL(buildAppUrl("/auth/return"));
  url.searchParams.set("next", buildAppPath(returnPath));
  return url.toString();
}

export function buildConnectNotionUrl(returnPath = "/dashboard"): string {
  const url = new URL(buildAppUrl("/connect/notion"));
  url.searchParams.set(AUTH_REDIRECT_QUERY_PARAM, buildAppUrl(returnPath));
  return url.toString();
}

export function buildConnectNotionCallbackUrl(returnPath = "/dashboard"): string {
  const url = new URL(buildAppUrl("/connect/notion/callback"));
  url.searchParams.set("next", buildAppPath(returnPath));
  return url.toString();
}

export function isAuthRedirectError(error: unknown): boolean {
  return error instanceof AuthRedirectError;
}
