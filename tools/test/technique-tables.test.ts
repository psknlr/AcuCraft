import { describe, expect, it } from "vitest";
import { missingFromDocument, techniqueTables } from "../technique-tables.js";

describe("docs/TECHNIQUES.md", () => {
  it("has the tables the operative catalogue writes: a row for each of the 36 techniques, as the code has them", () => {
    expect(techniqueTables().filter((line) => line.startsWith("| **"))).toHaveLength(36);
    expect(missingFromDocument()).toEqual([]);
  });
});
