import { describe, it, expect } from "vitest";
import { parseDate, detectDateFormat, DATE_FORMATS } from "./parse-date.js";

describe("parseDate", () => {
  it("parses YYYY-MM-DD", () => {
    expect(parseDate("2024-01-15", "YYYY-MM-DD")).toBe("2024-01-15");
    expect(parseDate("2024-1-5", "YYYY-MM-DD")).toBe("2024-01-05");
  });

  it("parses MM/DD/YYYY", () => {
    expect(parseDate("01/15/2024", "MM/DD/YYYY")).toBe("2024-01-15");
    expect(parseDate("12/31/2023", "MM/DD/YYYY")).toBe("2023-12-31");
  });

  it("parses DD/MM/YYYY", () => {
    expect(parseDate("15/01/2024", "DD/MM/YYYY")).toBe("2024-01-15");
    expect(parseDate("31/12/2023", "DD/MM/YYYY")).toBe("2023-12-31");
  });

  it("parses DD.MM.YYYY", () => {
    expect(parseDate("15.01.2024", "DD.MM.YYYY")).toBe("2024-01-15");
    expect(parseDate("1.3.2024", "DD.MM.YYYY")).toBe("2024-03-01");
  });

  it("parses YYYY/MM/DD", () => {
    expect(parseDate("2024/01/15", "YYYY/MM/DD")).toBe("2024-01-15");
  });

  it("parses YYYYMMDD", () => {
    expect(parseDate("20240115", "YYYYMMDD")).toBe("2024-01-15");
  });

  it("parses ISO8601 with time", () => {
    expect(parseDate("2024-01-15T10:30:00Z", "ISO8601")).toBe("2024-01-15");
    expect(parseDate("2024-01-15T10:30:00+02:00", "ISO8601")).toBe("2024-01-15");
    expect(parseDate("2024-01-15 10:30:00", "ISO8601")).toBe("2024-01-15");
  });

  it("parses UNIX_SECONDS", () => {
    // 2024-01-15 approx
    const result = parseDate("1705276800", "UNIX_SECONDS");
    expect(result).toMatch(/^2024-01-1/);
  });

  it("parses UNIX_MILLIS", () => {
    const result = parseDate("1705276800000", "UNIX_MILLIS");
    expect(result).toMatch(/^2024-01-1/);
  });

  it("returns null for invalid dates", () => {
    expect(parseDate("not-a-date", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("2024-13-01", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("2024-02-30", "YYYY-MM-DD")).toBeNull();
  });

  it("returns null for invalid format id", () => {
    expect(parseDate("2024-01-15", "UNKNOWN" as any)).toBeNull();
  });

  it("handles whitespace in values", () => {
    expect(parseDate("  2024-01-15  ", "YYYY-MM-DD")).toBe("2024-01-15");
  });
});

describe("detectDateFormat", () => {
  it("detects YYYY-MM-DD", () => {
    expect(detectDateFormat(["2024-01-15", "2024-02-20", "2024-03-10"])).toBe("YYYY-MM-DD");
  });

  it("detects ISO8601 with time", () => {
    expect(detectDateFormat(["2024-01-15T10:30:00Z", "2024-02-20T14:00:00Z"])).toBe("ISO8601");
  });

  it("detects DD.MM.YYYY", () => {
    expect(detectDateFormat(["15.01.2024", "20.02.2024", "10.03.2024"])).toBe("DD.MM.YYYY");
  });

  it("disambiguates DD/MM/YYYY when day > 12", () => {
    expect(detectDateFormat(["15/01/2024", "20/02/2024", "25/03/2024"])).toBe("DD/MM/YYYY");
  });

  it("disambiguates MM/DD/YYYY when second > 12", () => {
    expect(detectDateFormat(["01/15/2024", "02/20/2024", "03/25/2024"])).toBe("MM/DD/YYYY");
  });

  it("returns null for empty input", () => {
    expect(detectDateFormat([])).toBeNull();
  });

  it("returns null when no format matches 80%", () => {
    expect(detectDateFormat(["abc", "def", "ghi"])).toBeNull();
  });

  it("handles YYYYMMDD", () => {
    expect(detectDateFormat(["20240115", "20240220", "20240310"])).toBe("YYYYMMDD");
  });

  it("detects UNIX_SECONDS", () => {
    expect(detectDateFormat(["1705276800", "1705363200", "1705449600"])).toBe("UNIX_SECONDS");
  });
});

describe("DATE_FORMATS", () => {
  it("has 9 formats", () => {
    expect(DATE_FORMATS).toHaveLength(9);
  });

  it("each format has id, label, example, parse", () => {
    for (const fmt of DATE_FORMATS) {
      expect(fmt.id).toBeTruthy();
      expect(fmt.label).toBeTruthy();
      expect(fmt.example).toBeTruthy();
      expect(typeof fmt.parse).toBe("function");
    }
  });
});
