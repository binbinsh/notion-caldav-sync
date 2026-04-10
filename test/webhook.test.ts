import { describe, expect, it } from "vitest";
import {
  collectPageIds,
  extractEventTypes,
  needsFullSync,
} from "../src/notion/webhook";

describe("notion webhook helpers", () => {
  it("collectPageIds finds page objects and payload ids", () => {
    const notionPageId = "9c01f93a-6862-420f-941f-7609fa1f8911";
    const payload = {
      event: {
        type: "page.updated",
        payload: {
          page_id: notionPageId,
        },
      },
      events: [
        {
          value: {
            object: "page",
            id: notionPageId,
          },
        },
      ],
    };

    expect(collectPageIds(payload)).toEqual([notionPageId]);
  });

  it("extractEventTypes reads nested event collections", () => {
    const payload = {
      events: [
        { type: "database.schema.updated" },
        { event: { type: "data_source.moved" } },
        { payload: { type: "page.updated" } },
      ],
    };

    expect(extractEventTypes(payload)).toEqual([
      "database.schema.updated",
      "data_source.moved",
      "page.updated",
    ]);
  });

  it("needsFullSync only returns true for database or data source events", () => {
    expect(needsFullSync(["page.updated"])).toBe(false);
    expect(needsFullSync(["database.schema.updated"])).toBe(true);
    expect(needsFullSync(["data_source.moved"])).toBe(true);
  });

  it("collectPageIds ignores invalid values", () => {
    const payload = {
      page: { id: "not-a-uuid" },
      events: [{ page_id: 123 }, { value: { object: "page", id: "" } }],
    };

    expect(collectPageIds(payload)).toEqual([]);
  });
});
