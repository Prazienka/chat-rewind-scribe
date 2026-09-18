import { describe, expect, it } from "vitest";

import { splitText } from "./pipeline";

describe("long text chunking", () => {
  it("preserves all text and order", () => {
    const blocks = Array.from({ length: 80 }, (_, index) => `Odstavec ${index}. Důležitý obsah.`);
    const input = blocks.join("\n\n");
    const chunks = splitText(input, 240);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n\n").replace(/\s+/g, " ").trim()).toBe(
      input.replace(/\s+/g, " ").trim(),
    );
    expect(chunks[0]).toContain("Odstavec 0");
    expect(chunks.at(-1)).toContain("Odstavec 79");
  });
});