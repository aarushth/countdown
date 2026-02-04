import * as fs from "fs";
import * as path from "path";
import ScheduleDatabase, { ScheduleEntry } from "./database";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

interface PDFFile {
    name: string;
    path: string;
}

interface TextItem {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ParsedPeriod {
    name: string;
    startTime: string;
    endTime: string;
    columnIndex: number;
}

class PDFProcessor {
    private downloadDir = path.join(__dirname, "../downloads");
    private db: ScheduleDatabase;

    constructor() {
        this.db = new ScheduleDatabase();
    }

    parseDateRange(filename: string): Date[] {
        // Remove .pdf extension
        const name = filename.replace(/\.pdf$/i, "");

        // Month name to number mapping
        const months: { [key: string]: number } = {
            january: 0,
            february: 1,
            march: 2,
            april: 3,
            may: 4,
            june: 5,
            july: 6,
            august: 7,
            september: 8,
            october: 9,
            november: 10,
            december: 11,
        };

        // Extract parts - handle formats like "April 6th - 10th" or "April 27th - May 1st"
        const cleanName = name.replace(/[-–]/g, "-").replace(/:/g, "").trim();

        // Try to find month names and day numbers
        const monthPattern =
            /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;
        const dayPattern = /(\d{1,2})(?:st|nd|rd|th)?/g;

        const monthMatches = cleanName.match(monthPattern) || [];
        const dayMatches = cleanName.match(dayPattern) || [];

        if (monthMatches.length === 0 || dayMatches.length < 2) {
            console.warn(`Could not parse date range from: ${filename}`);
            return [];
        }

        const startMonth = months[monthMatches[0]!.toLowerCase()];
        const endMonth =
            monthMatches.length > 1
                ? months[monthMatches[1]!.toLowerCase()]
                : startMonth;

        const startDay = parseInt(dayMatches[0]!);
        const endDay = parseInt(dayMatches[1]!);

        // Assume current school year (2025-2026)
        // If month is Aug-Dec, use 2025; if Jan-June, use 2026
        const getYear = (month: number) => (month >= 7 ? 2025 : 2026);

        const dates: Date[] = [];
        let currentDate = new Date(getYear(startMonth), startMonth, startDay);
        const endDate = new Date(getYear(endMonth), endMonth, endDay);

        // Generate all weekdays in the range (5 days for 5 columns)
        while (currentDate <= endDate && dates.length < 5) {
            const dayOfWeek = currentDate.getDay();
            // Only include weekdays (Mon-Fri)
            if (dayOfWeek >= 1 && dayOfWeek <= 5) {
                dates.push(new Date(currentDate));
            }
            currentDate.setDate(currentDate.getDate() + 1);
        }

        return dates;
    }

    /**
     * Parse PDF text items to extract Period entries with their correct day assignments
     * Uses x-position to determine which column (day) each period belongs to.
     *
     * Handles duplicate periods due to A/B lunch by:
     * - Period 3: uses B Lunch timing (appears after B Lunch)
     * - Period 4: uses A Lunch timing (appears after A Lunch)
     */
    parsePeriodsFromText(textItems: TextItem[], dates: Date[]): any {
        const dayNames = [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
        ];

        // Find column boundaries by looking for day name headers
        const dayHeaders = textItems.filter((item) =>
            dayNames.some((day) => item.text.includes(day)),
        );

        console.log("\nDay headers found:");
        dayHeaders.forEach((h) =>
            console.log(
                `  ${h.text} at x=${h.x.toFixed(1)}, y=${h.y.toFixed(1)}`,
            ),
        );

        // Sort by x position to get column order
        const columnXPositions = dayHeaders
            .map((h) => ({ name: h.text, x: h.x }))
            .sort((a, b) => a.x - b.x);

        console.log("\nColumn positions (left to right):");
        columnXPositions.forEach((col, i) =>
            console.log(`  Column ${i}: ${col.name} at x=${col.x.toFixed(1)}`),
        );

        // Group all text items by their approximate column
        // Use midpoint between columns as boundary
        const getColumnIndex = (x: number): number => {
            if (columnXPositions.length === 0) return -1;

            for (let i = columnXPositions.length - 1; i >= 0; i--) {
                const colX = columnXPositions[i].x;
                const nextColX =
                    i < columnXPositions.length - 1
                        ? columnXPositions[i + 1].x
                        : Infinity;
                const boundary = (colX + nextColX) / 2;

                // Item belongs to column i if it's past the midpoint to the previous column
                const prevBoundary =
                    i > 0 ? (columnXPositions[i - 1].x + colX) / 2 : -Infinity;
                if (x >= prevBoundary) {
                    return i;
                }
            }
            return 0;
        };

        // Find period entries - look for "Period X" text items
        const periodItems = textItems.filter((item) =>
            /^Period\s+\d+$/i.test(item.text.trim()),
        );

        // Combine text items on the same row (similar y-position) to handle split times
        const combineRowItems = (
            items: TextItem[],
            baseY: number,
            minX: number,
            maxX: number,
        ): string => {
            const rowItems = items
                .filter(
                    (t) =>
                        Math.abs(t.y - baseY) < 3 && t.x >= minX && t.x <= maxX,
                )
                .sort((a, b) => a.x - b.x);
            return rowItems.map((t) => t.text).join("");
        };

        console.log(`\nFound ${periodItems.length} period labels`);

        // Associate periods with their times based on proximity (y-position)
        const allMatches: {
            periodNum: number;
            startTime: string;
            endTime: string;
            x: number;
            y: number;
            columnIndex: number;
        }[] = [];

        for (const periodItem of periodItems) {
            const periodMatch = periodItem.text.match(/Period\s+(\d+)/i);
            if (!periodMatch) continue;

            const periodNum = parseInt(periodMatch[1]);
            const columnIndex = getColumnIndex(periodItem.x);

            // Find column boundaries for limiting search
            const colStart = columnXPositions[columnIndex]?.x - 40;
            const colEnd =
                columnIndex < columnXPositions.length - 1
                    ? columnXPositions[columnIndex + 1].x - 10
                    : 600;

            // Look for time on the row just below the period label
            // Combine all text items on that row within the column
            const timeRowY = periodItem.y - 13.4; // typical row spacing
            const combinedText = combineRowItems(
                textItems,
                timeRowY,
                colStart,
                colEnd,
            );

            let startTime = "";
            let endTime = "";

            const timeMatch = combinedText.match(
                /(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/,
            );
            if (timeMatch) {
                startTime = timeMatch[1];
                endTime = timeMatch[2];
            }

            allMatches.push({
                periodNum,
                startTime,
                endTime,
                x: periodItem.x,
                y: periodItem.y,
                columnIndex,
            });
        }

        // Sort by column then by y position (top to bottom)
        allMatches.sort((a, b) => a.columnIndex - b.columnIndex || b.y - a.y);

        console.log(`\nFound ${allMatches.length} total period occurrences:`);
        allMatches.forEach((period) => {
            console.log(
                `  Period ${period.periodNum}: ${period.startTime}-${period.endTime} (column ${period.columnIndex}, x=${period.x.toFixed(1)}, y=${period.y.toFixed(1)})`,
            );
        });

        return allMatches;
    }

    /**
     * Get all PDF files from the downloads folder
     */
    getPDFFiles(): PDFFile[] {
        if (!fs.existsSync(this.downloadDir)) {
            console.log("Downloads directory does not exist");
            return [];
        }

        const files = fs.readdirSync(this.downloadDir);
        const pdfFiles = files
            .filter((file) => file.toLowerCase().endsWith(".pdf"))
            .map((file) => ({
                name: file,
                path: path.join(this.downloadDir, file),
            }));

        console.log(`Found ${pdfFiles.length} PDF files in downloads folder`);
        return pdfFiles;
    }

    /**
     * Open and parse a single PDF file, extracting text with position info
     */
    async openPDF(pdfFile: PDFFile): Promise<TextItem[]> {
        try {
            console.log(`Opening: ${pdfFile.name}`);
            const data = new Uint8Array(fs.readFileSync(pdfFile.path));
            const pdf = await pdfjsLib.getDocument({ data }).promise;

            const textItems: TextItem[] = [];

            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const page = await pdf.getPage(pageNum);
                const textContent = await page.getTextContent();

                for (const item of textContent.items) {
                    if ("str" in item && item.str.trim()) {
                        const transform = item.transform;
                        textItems.push({
                            text: item.str,
                            x: transform[4],
                            y: transform[5],
                            width: item.width,
                            height: item.height,
                        });
                    }
                }
            }

            return textItems;
        } catch (error) {
            console.error(`Error opening ${pdfFile.name}:`, error);
            throw error;
        }
    }

    /**
     * Save parsed periods to the database
     * Handles duplicates: Period 3 uses first occurrence, Period 4 uses second occurrence
     */
    savePeriodsToDatabase(
        allMatches: {
            periodNum: number;
            startTime: string;
            endTime: string;
            x: number;
            y: number;
            columnIndex: number;
        }[],
        dates: Date[],
    ): void {
        const entries: { name: string; startTime: Date; endTime: Date }[] = [];

        // Group by column (day) and period number
        const byDayAndPeriod = new Map<string, typeof allMatches>();
        for (const match of allMatches) {
            const key = `${match.columnIndex}-${match.periodNum}`;
            if (!byDayAndPeriod.has(key)) {
                byDayAndPeriod.set(key, []);
            }
            byDayAndPeriod.get(key)!.push(match);
        }

        // Process each day-period combination
        for (const [key, periods] of byDayAndPeriod) {
            const [colIdx, periodNum] = key.split("-").map(Number);
            const date = dates[colIdx];
            if (!date) continue;

            // Sort by y position (higher y = earlier in document, top of page)
            periods.sort((a, b) => b.y - a.y);

            // Apply duplicate rules: Period 3 -> first, Period 4 -> second
            let selected: (typeof periods)[0];
            if (periodNum === 3) {
                selected = periods[0]; // first occurrence
            } else if (periodNum === 4 && periods.length > 1) {
                selected = periods[1]; // second occurrence
            } else {
                selected = periods[0]; // default to first
            }

            if (!selected.startTime || !selected.endTime) continue;

            // Parse time strings and combine with date
            const parseTime = (timeStr: string, baseDate: Date): Date => {
                const [hours, minutes] = timeStr.split(":").map(Number);
                const result = new Date(baseDate);
                // Assume times before 7:00 are PM (school hours logic)
                const adjustedHours = hours < 7 ? hours + 12 : hours;
                result.setHours(adjustedHours, minutes, 0, 0);
                return result;
            };

            entries.push({
                name: `Period ${periodNum}`,
                startTime: parseTime(selected.startTime, date),
                endTime: parseTime(selected.endTime, date),
            });
        }

        // Sort entries by start time
        entries.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

        console.log(`\nInserting ${entries.length} schedule entries:`);
        entries.forEach((e) => {
            console.log(
                `  ${e.name}: ${e.startTime.toLocaleString()} - ${e.endTime.toLocaleTimeString()}`,
            );
        });

        this.db.insertMany(entries);
    }

    /**
     * Process a single PDF file and save to database
     */
    async processPDF(pdfFile: PDFFile): Promise<void> {
        const textItems = await this.openPDF(pdfFile);
        const dates = this.parseDateRange(pdfFile.name);
        
        if (dates.length === 0) {
            console.log(`Skipping ${pdfFile.name} - could not parse dates`);
            return;
        }

        const periods = this.parsePeriodsFromText(textItems, dates);
        this.savePeriodsToDatabase(periods, dates);
    }

    /**
     * Process all PDFs and save to database
     */
    async processAllPDFs(): Promise<void> {
        const pdfFiles = this.getPDFFiles();

        if (pdfFiles.length === 0) {
            console.log("No PDF files found to process");
            return;
        }

        console.log(`\n=== Processing ${pdfFiles.length} PDFs ===\n`);

        for (const pdfFile of pdfFiles) {
            try {
                await this.processPDF(pdfFile);
                console.log(`Successfully processed: ${pdfFile.name}\n`);
            } catch (error) {
                console.error(`Failed to process: ${pdfFile.name}`, error);
            }
        }

        console.log("=== Done ===");
    }
}

// Main execution
async function main() {
    const processor = new PDFProcessor();
    await processor.processAllPDFs();
}

if (require.main === module) {
    main().catch(console.error);
}

export default PDFProcessor;
