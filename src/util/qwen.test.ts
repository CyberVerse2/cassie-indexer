import { describe, expect, test } from "bun:test";
import { referencesFromOpenRouter } from "./qwen";

describe("referencesFromOpenRouter", () => {
  test("reads url_citation annotations and ignores other urls", () => {
    expect(
      referencesFromOpenRouter({
        choices: [
          {
            message: {
              content: "NVDA rose after a chip report. https://example.com/not-a-citation",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: {
                    url: "https://reuters.com/nvda",
                    title: "Nvidia report",
                  },
                },
                {
                  type: "url_citation",
                  url_citation: { url: "https://reuters.com/nvda", title: "dup" },
                },
              ],
            },
          },
        ],
      }),
    ).toEqual([{ url: "https://reuters.com/nvda", title: "Nvidia report" }]);
  });

  test("returns none when the model did not search", () => {
    expect(
      referencesFromOpenRouter({
        choices: [{ message: { content: "No search." } }],
      }),
    ).toEqual([]);
  });
});
