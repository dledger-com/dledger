import { describe, it, expect } from "vitest";
import { groupByY } from "./extract-text.js";
import type { PdfTextItem } from "./types.js";

function makeItem(str: string, x: number, y: number): PdfTextItem {
  return { str, x, y, width: str.length * 6, height: 10, fontName: "Arial" };
}

describe("groupByY", () => {
  it("groups items on the same Y coordinate into one line", () => {
    const items: PdfTextItem[] = [
      makeItem("Hello", 10, 100),
      makeItem("World", 80, 100),
    ];

    const lines = groupByY(items);
    expect(lines).toHaveLength(1);
    expect(lines[0].y).toBe(100);
    expect(lines[0].items).toHaveLength(2);
    expect(lines[0].items[0].str).toBe("Hello");
    expect(lines[0].items[1].str).toBe("World");
  });

  it("groups items within Y tolerance (2px) on the same line", () => {
    const items: PdfTextItem[] = [
      makeItem("A", 10, 100),
      makeItem("B", 50, 101.5), // Within 2px tolerance
      makeItem("C", 90, 98.5), // Within 2px tolerance
    ];

    const lines = groupByY(items);
    expect(lines).toHaveLength(1);
    expect(lines[0].items).toHaveLength(3);
  });

  it("separates items beyond Y tolerance into different lines", () => {
    const items: PdfTextItem[] = [
      makeItem("Line1", 10, 200),
      makeItem("Line2", 10, 180),
    ];

    const lines = groupByY(items);
    expect(lines).toHaveLength(2);
    // Top-to-bottom order: higher Y first
    expect(lines[0].y).toBe(200);
    expect(lines[0].items[0].str).toBe("Line1");
    expect(lines[1].y).toBe(180);
    expect(lines[1].items[0].str).toBe("Line2");
  });

  it("sorts items left-to-right within a line", () => {
    const items: PdfTextItem[] = [
      makeItem("Right", 200, 100),
      makeItem("Left", 10, 100),
      makeItem("Middle", 100, 100),
    ];

    const lines = groupByY(items);
    expect(lines).toHaveLength(1);
    expect(lines[0].items.map((i) => i.str)).toEqual(["Left", "Middle", "Right"]);
  });

  it("sorts lines top-to-bottom (descending Y)", () => {
    const items: PdfTextItem[] = [
      makeItem("Bottom", 10, 50),
      makeItem("Top", 10, 300),
      makeItem("Middle", 10, 150),
    ];

    const lines = groupByY(items);
    expect(lines).toHaveLength(3);
    expect(lines[0].items[0].str).toBe("Top");
    expect(lines[1].items[0].str).toBe("Middle");
    expect(lines[2].items[0].str).toBe("Bottom");
  });

  it("returns empty array for empty input", () => {
    expect(groupByY([])).toEqual([]);
  });

  it("handles single item", () => {
    const items = [makeItem("Solo", 10, 100)];
    const lines = groupByY(items);
    expect(lines).toHaveLength(1);
    expect(lines[0].items[0].str).toBe("Solo");
  });
});
