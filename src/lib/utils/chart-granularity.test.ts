import { describe, it, expect } from "vitest";
import {
    chooseGranularity,
    bucketKey,
    bucketStartDate,
    dateToBucketDate,
    formatXAxisLabel,
    formatTooltipHeader,
    type ChartGranularity,
} from "./chart-granularity.js";

describe("chooseGranularity", () => {
    it("picks day for small span", () => {
        expect(chooseGranularity(30, 30)).toBe("day");
        expect(chooseGranularity(120, 100)).toBe("day");
    });

    it("picks day for sparse long span", () => {
        // 5 years but only 50 unique dates
        expect(chooseGranularity(1825, 50)).toBe("day");
    });

    it("picks week for ~1 year dense data", () => {
        expect(chooseGranularity(365, 300)).toBe("week");
        expect(chooseGranularity(730, 500)).toBe("week");
    });

    it("picks month for ~5 year span", () => {
        expect(chooseGranularity(1825, 1000)).toBe("month");
        expect(chooseGranularity(2555, 2000)).toBe("month");
    });

    it("picks quarter for ~10-20 year span", () => {
        expect(chooseGranularity(3650, 3000)).toBe("quarter");
        expect(chooseGranularity(7300, 5000)).toBe("quarter");
    });

    it("picks year for very long span", () => {
        expect(chooseGranularity(7301, 5000)).toBe("year");
        expect(chooseGranularity(10000, 8000)).toBe("year");
    });
});

describe("bucketKey", () => {
    it("day: returns date as-is", () => {
        expect(bucketKey("2024-03-15", "day")).toBe("2024-03-15");
    });

    it("week: returns Monday of that week", () => {
        // 2024-03-15 is a Friday → Monday is 2024-03-11
        expect(bucketKey("2024-03-15", "week")).toBe("2024-03-11");
    });

    it("week: Monday maps to itself", () => {
        // 2024-03-11 is a Monday
        expect(bucketKey("2024-03-11", "week")).toBe("2024-03-11");
    });

    it("week: Sunday maps to previous Monday", () => {
        // 2024-03-17 is a Sunday → Monday is 2024-03-11
        expect(bucketKey("2024-03-17", "week")).toBe("2024-03-11");
    });

    it("week: Saturday maps to previous Monday", () => {
        // 2024-03-16 is a Saturday → Monday is 2024-03-11
        expect(bucketKey("2024-03-16", "week")).toBe("2024-03-11");
    });

    it("week: handles cross-month boundary", () => {
        // 2024-04-01 is a Monday
        expect(bucketKey("2024-04-01", "week")).toBe("2024-04-01");
        // 2024-04-02 is a Tuesday → Monday is 2024-04-01
        expect(bucketKey("2024-04-02", "week")).toBe("2024-04-01");
    });

    it("week: handles cross-year boundary", () => {
        // 2024-01-01 is a Monday
        expect(bucketKey("2024-01-01", "week")).toBe("2024-01-01");
        // 2023-12-31 is a Sunday → Monday is 2023-12-25
        expect(bucketKey("2023-12-31", "week")).toBe("2023-12-25");
    });

    it("month: returns YYYY-MM", () => {
        expect(bucketKey("2024-03-15", "month")).toBe("2024-03");
        expect(bucketKey("2024-01-01", "month")).toBe("2024-01");
        expect(bucketKey("2024-12-31", "month")).toBe("2024-12");
    });

    it("quarter: returns YYYY-Q#", () => {
        expect(bucketKey("2024-01-15", "quarter")).toBe("2024-Q1");
        expect(bucketKey("2024-03-31", "quarter")).toBe("2024-Q1");
        expect(bucketKey("2024-04-01", "quarter")).toBe("2024-Q2");
        expect(bucketKey("2024-07-15", "quarter")).toBe("2024-Q3");
        expect(bucketKey("2024-10-01", "quarter")).toBe("2024-Q4");
        expect(bucketKey("2024-12-31", "quarter")).toBe("2024-Q4");
    });

    it("year: returns YYYY", () => {
        expect(bucketKey("2024-03-15", "year")).toBe("2024");
        expect(bucketKey("2020-01-01", "year")).toBe("2020");
    });
});

describe("bucketStartDate", () => {
    it("day: parses YYYY-MM-DD", () => {
        const d = bucketStartDate("2024-03-15", "day");
        expect(d.getFullYear()).toBe(2024);
        expect(d.getMonth()).toBe(2); // March
        expect(d.getDate()).toBe(15);
    });

    it("week: parses Monday date", () => {
        const d = bucketStartDate("2024-03-11", "week");
        expect(d.getFullYear()).toBe(2024);
        expect(d.getMonth()).toBe(2);
        expect(d.getDate()).toBe(11);
    });

    it("month: parses YYYY-MM to 1st of month", () => {
        const d = bucketStartDate("2024-03", "month");
        expect(d.getFullYear()).toBe(2024);
        expect(d.getMonth()).toBe(2);
        expect(d.getDate()).toBe(1);
    });

    it("quarter: parses YYYY-Q# to 1st of quarter", () => {
        const q1 = bucketStartDate("2024-Q1", "quarter");
        expect(q1.getMonth()).toBe(0);
        expect(q1.getDate()).toBe(1);

        const q2 = bucketStartDate("2024-Q2", "quarter");
        expect(q2.getMonth()).toBe(3);

        const q3 = bucketStartDate("2024-Q3", "quarter");
        expect(q3.getMonth()).toBe(6);

        const q4 = bucketStartDate("2024-Q4", "quarter");
        expect(q4.getMonth()).toBe(9);
    });

    it("year: parses YYYY to Jan 1", () => {
        const d = bucketStartDate("2024", "year");
        expect(d.getFullYear()).toBe(2024);
        expect(d.getMonth()).toBe(0);
        expect(d.getDate()).toBe(1);
    });

    it("roundtrip: bucketStartDate(bucketKey(date, g), g) gives consistent Date", () => {
        const dateStr = "2024-07-23";
        const granularities: ChartGranularity[] = ["day", "week", "month", "quarter", "year"];
        for (const g of granularities) {
            const key = bucketKey(dateStr, g);
            const d = bucketStartDate(key, g);
            // Re-bucketing the result should yield the same key
            const reKey = bucketKey(
                `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
                g,
            );
            expect(reKey).toBe(key);
        }
    });
});

describe("dateToBucketDate", () => {
    it("returns bucket start Date for each granularity", () => {
        const d = dateToBucketDate("2024-03-15", "month");
        expect(d.getFullYear()).toBe(2024);
        expect(d.getMonth()).toBe(2);
        expect(d.getDate()).toBe(1);
    });
});

describe("formatXAxisLabel", () => {
    it("day: short month + day", () => {
        expect(formatXAxisLabel(new Date(2024, 2, 15), "day")).toBe("Mar 15");
    });

    it("week: short month + day", () => {
        expect(formatXAxisLabel(new Date(2024, 2, 11), "week")).toBe("Mar 11");
    });

    it("month: short month + short year", () => {
        expect(formatXAxisLabel(new Date(2024, 0, 1), "month")).toBe("Jan '24");
    });

    it("quarter: Q# + short year", () => {
        expect(formatXAxisLabel(new Date(2024, 0, 1), "quarter")).toBe("Q1 '24");
        expect(formatXAxisLabel(new Date(2024, 3, 1), "quarter")).toBe("Q2 '24");
        expect(formatXAxisLabel(new Date(2024, 6, 1), "quarter")).toBe("Q3 '24");
        expect(formatXAxisLabel(new Date(2024, 9, 1), "quarter")).toBe("Q4 '24");
    });

    it("year: full year", () => {
        expect(formatXAxisLabel(new Date(2024, 0, 1), "year")).toBe("2024");
    });

    it("handles invalid date", () => {
        expect(formatXAxisLabel(new Date("invalid"), "day")).toBe("");
    });
});

describe("formatTooltipHeader", () => {
    it("day: short month day, year", () => {
        expect(formatTooltipHeader(new Date(2024, 2, 15), "day")).toBe("Mar 15, 2024");
    });

    it("week: Week of ...", () => {
        expect(formatTooltipHeader(new Date(2024, 2, 11), "week")).toBe("Week of Mar 11, 2024");
    });

    it("month: full month year", () => {
        expect(formatTooltipHeader(new Date(2024, 0, 1), "month")).toBe("January 2024");
    });

    it("quarter: Q# year", () => {
        expect(formatTooltipHeader(new Date(2024, 0, 1), "quarter")).toBe("Q1 2024");
        expect(formatTooltipHeader(new Date(2024, 9, 1), "quarter")).toBe("Q4 2024");
    });

    it("year: full year", () => {
        expect(formatTooltipHeader(new Date(2024, 0, 1), "year")).toBe("2024");
    });

    it("handles invalid date", () => {
        expect(formatTooltipHeader(new Date("invalid"), "day")).toBe("");
    });
});
