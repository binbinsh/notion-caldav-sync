import { describe, expect, it } from "vitest";
import { buildSyncProfile } from "../src/sync/constants";

describe("buildSyncProfile", () => {
  it("keeps status icon mapping tenant-wide while applying per-data-source overrides", () => {
    const profile = buildSyncProfile(
      {
        statusEmojiStyle: "custom",
        statusEmojis: {
          Todo: "T",
          "In progress": "P",
          Completed: "D",
          Overdue: "L",
          Cancelled: "C",
        },
      },
      {
        titleProperty: "Task name",
        statusVariants: {
          Todo: ["Queued"],
          "In progress": ["Doing"],
          Completed: ["Done"],
          Overdue: ["Late"],
          Cancelled: ["Dropped"],
        },
        statusEmojiStyle: "symbol",
        statusEmojis: {
          Todo: "X",
          "In progress": "Y",
          Completed: "Z",
        },
      },
    );

    expect(profile.titleProperty).toBe("Task name");
    expect(profile.statusVariants.Todo).toEqual(["Queued"]);
    expect(profile.statusEmojiStyle).toBe("custom");
    expect(profile.statusEmojis).toMatchObject({
      Todo: "T",
      "In progress": "P",
      Completed: "D",
      Overdue: "L",
      Cancelled: "C",
    });
  });
});
