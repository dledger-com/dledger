/**
 * Adaptive chart granularity — picks day/week/month/quarter/year
 * based on data span and density to keep bars readable.
 */

export type ChartGranularity = "day" | "week" | "month" | "quarter" | "year";

/**
 * Choose the finest granularity that keeps bar count manageable.
 * If data is sparse (≤80 unique dates) we always use daily even for long spans.
 */
export function chooseGranularity(
    dateSpanDays: number,
    uniqueDateCount: number,
): ChartGranularity {
    if (uniqueDateCount <= 80) return "day";
    if (dateSpanDays <= 120) return "day";
    if (dateSpanDays <= 730) return "week";
    if (dateSpanDays <= 2555) return "month";
    if (dateSpanDays <= 7300) return "quarter";
    return "year";
}

/**
 * Map a "YYYY-MM-DD" date string to a sortable bucket key.
 */
export function bucketKey(dateStr: string, granularity: ChartGranularity): string {
    if (granularity === "day") return dateStr;

    const [yearStr, monthStr, dayStr] = dateStr.split("-");
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10); // 1-based
    const day = parseInt(dayStr, 10);

    if (granularity === "week") {
        // Monday of the ISO week containing this date
        const d = new Date(year, month - 1, day);
        const dow = d.getDay(); // 0=Sun
        const mondayOffset = dow === 0 ? -6 : 1 - dow;
        const monday = new Date(year, month - 1, day + mondayOffset);
        return formatYMD(monday);
    }

    if (granularity === "month") {
        return `${yearStr}-${monthStr}`;
    }

    if (granularity === "quarter") {
        const q = Math.ceil(month / 3);
        return `${yearStr}-Q${q}`;
    }

    // year
    return yearStr;
}

/**
 * Convert a bucket key back to a Date (start of that bucket period).
 */
export function bucketStartDate(key: string, granularity: ChartGranularity): Date {
    if (granularity === "day") {
        return new Date(key + "T00:00:00");
    }

    if (granularity === "week") {
        // key is "YYYY-MM-DD" (the Monday)
        return new Date(key + "T00:00:00");
    }

    if (granularity === "month") {
        // key is "YYYY-MM"
        return new Date(key + "-01T00:00:00");
    }

    if (granularity === "quarter") {
        // key is "YYYY-Q1" .. "YYYY-Q4"
        const [yearStr, qStr] = key.split("-Q");
        const q = parseInt(qStr, 10);
        const month = (q - 1) * 3 + 1;
        return new Date(parseInt(yearStr, 10), month - 1, 1);
    }

    // year — key is "YYYY"
    return new Date(parseInt(key, 10), 0, 1);
}

/**
 * Shorthand: map a "YYYY-MM-DD" to the Date representing its bucket start.
 */
export function dateToBucketDate(dateStr: string, granularity: ChartGranularity): Date {
    return bucketStartDate(bucketKey(dateStr, granularity), granularity);
}

const SHORT_MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const FULL_MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

/**
 * Format a Date for X-axis tick labels.
 */
export function formatXAxisLabel(date: Date, granularity: ChartGranularity): string {
    if (!(date instanceof Date) || isNaN(date.getTime())) return "";
    const m = date.getMonth(); // 0-based
    const d = date.getDate();
    const y = date.getFullYear();
    const yShort = `'${String(y).slice(-2)}`;

    switch (granularity) {
        case "day":
            return `${SHORT_MONTHS[m]} ${d}`;
        case "week":
            return `${SHORT_MONTHS[m]} ${d}`;
        case "month":
            return `${SHORT_MONTHS[m]} ${yShort}`;
        case "quarter": {
            const q = Math.floor(m / 3) + 1;
            return `Q${q} ${yShort}`;
        }
        case "year":
            return String(y);
    }
}

/**
 * Format a Date for the tooltip header.
 */
export function formatTooltipHeader(date: Date, granularity: ChartGranularity): string {
    if (!(date instanceof Date) || isNaN(date.getTime())) return "";
    const m = date.getMonth();
    const d = date.getDate();
    const y = date.getFullYear();

    switch (granularity) {
        case "day":
            return `${SHORT_MONTHS[m]} ${d}, ${y}`;
        case "week":
            return `Week of ${SHORT_MONTHS[m]} ${d}, ${y}`;
        case "month":
            return `${FULL_MONTHS[m]} ${y}`;
        case "quarter": {
            const q = Math.floor(m / 3) + 1;
            return `Q${q} ${y}`;
        }
        case "year":
            return String(y);
    }
}

function formatYMD(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
