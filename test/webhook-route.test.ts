import { describe, expect, it } from "vitest";
import worker from "../src/index";

function testExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

const webhookOnlyEnv = { APP_BASE_PATH: "/caldav-sync" } as Parameters<typeof worker.fetch>[1];

describe("notion webhook route", () => {
  it("acknowledges verification challenges without Clerk or D1 dependencies", async () => {
    const response = await worker.fetch(
      new Request("https://superplanner.ai/caldav-sync/webhook/notion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verification_token: "secret_test_token" }),
      }),
      webhookOnlyEnv,
      testExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-clerk-auth-status")).toBeNull();
    expect(await response.json()).toEqual({ verification_token: "secret_test_token" });
  });

  it("keeps the liveness check independent from Clerk", async () => {
    const response = await worker.fetch(
      new Request("https://superplanner.ai/caldav-sync/webhook/notion"),
      webhookOnlyEnv,
      testExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-clerk-auth-status")).toBeNull();
    expect(await response.json()).toEqual({
      ok: true,
      message: "Notion webhook endpoint is live. Use POST.",
    });
  });
});
