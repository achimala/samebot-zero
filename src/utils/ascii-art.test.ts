import { describe, expect, it } from "vitest";
import { normalizeAsciiArt } from "./ascii-art";

describe("normalizeAsciiArt", () => {
  it("preserves leading spaces on the first line", () => {
    const art = "       /\\\n      /  \\\n     |    |";
    expect(normalizeAsciiArt(art)).toBe(art);
  });

  it("removes blank lines from the start and end only", () => {
    const art = "\n\n       /\\\n      /  \\\n\n";
    expect(normalizeAsciiArt(art)).toBe("       /\\\n      /  \\");
  });

  it("strips markdown code fences", () => {
    const art = "```ascii\n       /\\\n      /  \\\n```";
    expect(normalizeAsciiArt(art)).toBe("       /\\\n      /  \\");
  });

  it("strips code fences without a language tag", () => {
    const art = "```\n       /\\\n```";
    expect(normalizeAsciiArt(art)).toBe("       /\\");
  });
});
