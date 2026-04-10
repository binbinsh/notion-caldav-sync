import { describe, expect, it } from "vitest";
import { DAVClient } from "tsdav";
import { createNotionClient, listDatabases } from "../src/notion/client";
import { loadLocalEnv, requiredEnv } from "./helpers/env";

loadLocalEnv();

const notionEnv = requiredEnv(["NOTION_TOKEN"]);
const caldavEnv = requiredEnv(["APPLE_ID", "APPLE_APP_PASSWORD"]);

const maybeItNotion = notionEnv.ok ? it : it.skip;
const maybeItCaldav = caldavEnv.ok ? it : it.skip;

describe("live integrations", () => {
  maybeItNotion("lists at least one Notion data source with the live token", async () => {
    const client = createNotionClient(process.env.NOTION_TOKEN!, process.env.NOTION_API_VERSION || "2025-09-03");
    const databases = await listDatabases(client);

    expect(databases.length).toBeGreaterThan(0);
    expect(databases[0]?.id).toBeTruthy();
  });

  maybeItCaldav("logs into iCloud CalDAV and fetches calendars via tsdav", async () => {
    const client = new DAVClient({
      serverUrl: "https://caldav.icloud.com/",
      credentials: {
        username: process.env.APPLE_ID!,
        password: process.env.APPLE_APP_PASSWORD!,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
      fetch,
    });

    await client.login();
    const calendars = await client.fetchCalendars();

    expect(calendars.length).toBeGreaterThan(0);
    expect(calendars[0]?.url).toBeTruthy();
  }, 30000);
});
