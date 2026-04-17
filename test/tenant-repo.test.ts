import { describe, expect, it } from "vitest";
import { selectLatestProviderConnectionsByRoutingKey, type ProviderConnectionRow } from "../src/db/tenant-repo";

function connection(input: Partial<ProviderConnectionRow> & Pick<ProviderConnectionRow, "id" | "tenant_id">): ProviderConnectionRow {
  return {
    id: input.id,
    tenant_id: input.tenant_id,
    organization_id: null,
    user_id: input.user_id || input.tenant_id,
    provider_id: "notion",
    provider_account_id: input.provider_account_id || input.id,
    refresh_handle: input.refresh_handle || `${input.id}-refresh`,
    workspace_id: input.workspace_id ?? "ws-1",
    workspace_name: input.workspace_name ?? "Workspace",
    bot_id: input.bot_id ?? "bot-1",
    scopes_json: "[]",
    metadata_json: "{}",
    created_at: input.created_at || "2026-04-01T00:00:00.000Z",
    updated_at: input.updated_at || "2026-04-01T00:00:00.000Z",
  };
}

describe("selectLatestProviderConnectionsByRoutingKey", () => {
  it("keeps only the newest connection for a shared bot and workspace", () => {
    const rows = [
      connection({ id: "old", tenant_id: "tenant-old", updated_at: "2026-04-11T17:19:09.580Z" }),
      connection({ id: "new", tenant_id: "tenant-new", updated_at: "2026-04-13T14:33:02.049Z" }),
    ];

    const selected = selectLatestProviderConnectionsByRoutingKey(rows);

    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe("new");
    expect(selected[0]?.tenant_id).toBe("tenant-new");
  });

  it("keeps distinct routing identities", () => {
    const rows = [
      connection({ id: "a", tenant_id: "tenant-a", bot_id: "bot-a", workspace_id: "ws-a" }),
      connection({ id: "b", tenant_id: "tenant-b", bot_id: "bot-b", workspace_id: "ws-b" }),
    ];

    const selected = selectLatestProviderConnectionsByRoutingKey(rows)
      .map((row) => row.id)
      .sort();

    expect(selected).toEqual(["a", "b"]);
  });
});
