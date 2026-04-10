import { betterAuth, type Auth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { organization } from "better-auth/plugins";

export type AppEnv = {
  APP_ENCRYPTION_KEY?: string;
  APP_BASE_PATH?: string;
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
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: authBaseUrl,
    trustedOrigins: [authBaseUrl],
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
                    input: false,
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
