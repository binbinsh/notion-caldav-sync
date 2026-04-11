import { betterAuth, type Auth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { organization } from "better-auth/plugins";

export type AppEnv = {
  APP_ENCRYPTION_KEY?: string;
  APP_BASE_PATH?: string;
  ASSETS?: Fetcher;
  AUTH_CACHE?: KVNamespace;
  AUTH_DB: D1Database;
  BETTER_AUTH_BASE_URL?: string;
  BETTER_AUTH_SECRET: string;
  INTERNAL_SERVICE_TOKEN?: string;
  NOTION_API_VERSION?: string;
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TENANT_SYNC?: DurableObjectNamespace;
};

export function createAuth(env: AppEnv, request: Request, authBaseUrl: string): Auth<any> {
  const requestUrl = new URL(request.url);
  const serviceBasePath = normalizeBasePath(env.APP_BASE_PATH);
  const authHandlerBaseUrl = `${requestUrl.origin}${serviceBasePath}/auth`;
  const providerCallbackBaseUrl = `${requestUrl.origin}${serviceBasePath}/callback`;
  const authErrorUrl = `${serviceBasePath}/sign-in` || "/sign-in";
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: authHandlerBaseUrl,
    basePath: "/auth",
    trustedOrigins: [requestUrl.origin],
    onAPIError: {
      errorURL: authErrorUrl,
    },
    ...withCloudflare(
      {
        autoDetectIpAddress: false,
        geolocationTracking: false,
        d1Native: env.AUTH_DB,
        kv: env.AUTH_CACHE as any,
        cf: request.cf as any,
      },
      {
        session: {
          storeSessionInDatabase: true,
        },
        socialProviders: {
          notion: {
            clientId: env.NOTION_CLIENT_ID,
            clientSecret: env.NOTION_CLIENT_SECRET,
            redirectURI: `${providerCallbackBaseUrl}/notion`,
          },
        },
        plugins: [
          organization({
            allowUserToCreateOrganization: true,
            organizationLimit: 100,
            schema: {
              organization: {
                additionalFields: {
                  tenantId: {
                    type: "string",
                    required: false,
                    input: true,
                  },
                },
              },
            },
          }),
        ],
      },
    ),
  });
}

function normalizeBasePath(value: string | null | undefined): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate || candidate === "/") {
    return "";
  }
  const prefixed = candidate.startsWith("/") ? candidate : `/${candidate}`;
  return prefixed.replace(/\/+$/g, "");
}
