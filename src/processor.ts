import * as fs from "fs";
import * as path from "path";
import ScheduleDatabase, { ScheduleEntry } from "./database";
import { PDFParse } from "pdf-parse";

interface PDFFile {
    name: string;
    path: string;
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
     * Parse PDF text to extract Period entries with their correct day assignments
     * The PDF text is extracted row-by-row across 5 columns (Mon-Fri).
     * For each period number, occurrences appear in day order (Mon->Fri), so we
     * track which day we're on for each period and advance through the week.
     *
     * Handles duplicate periods due to A/B lunch by:
     * - Period 3: uses B Lunch timing (appears after B Lunch)
     * - Period 4: uses A Lunch timing (appears after A Lunch)
     */
    parsePeriodsFromText(text: any, dates: Date[]): any {
        // Extract text string from PDF result object
        const textStr = typeof text === "string" ? text : text.text || "";

        // First, extract which periods meet each day from the header
        const dayNames = [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
        ];
        const dayPeriods: Map<number, Set<number>> = new Map();

        for (let dayIdx = 0; dayIdx < dayNames.length; dayIdx++) {
            const dayName = dayNames[dayIdx];
            const dayPattern = new RegExp(`${dayName}\\s*\\n([\\d,\\-]+)`, "i");
            const match = textStr.match(dayPattern);
            if (match) {
                const periodsStr = match[1];
                const periodSet = new Set<number>();
                if (periodsStr.includes("-") && !periodsStr.includes(",")) {
                    const [start, end] = periodsStr.split("-").map(Number);
                    for (let p = start; p <= end; p++) {
                        periodSet.add(p);
                    }
                } else {
                    periodsStr
                        .split(",")
                        .forEach((p: string) =>
                            periodSet.add(parseInt(p.trim())),
                        );
                }
                dayPeriods.set(dayIdx, periodSet);
            }
        }

        console.log("\nPeriods per day from header:");
        dayPeriods.forEach((periods, day) => {
            console.log(
                `  ${dayNames[day]}: ${[...periods].sort((a, b) => a - b).join(", ")}`,
            );
        });

        // Pattern to match Period entries with time
        const periodPattern =
            /Period\s+(\d+)\s*[\n\s]*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*\(\d+\)/g;

        // Find all period matches with their positions
        const allMatches: {
            periodNum: number;
            startTime: string;
            endTime: string;
            index: number;
        }[] = [];
        let match;
        while ((match = periodPattern.exec(textStr)) !== null) {
            allMatches.push({
                periodNum: parseInt(match[1]),
                startTime: match[2],
                endTime: match[3],
                index: match.index,
            });
        }

        console.log(
            `\nFound ${allMatches.length} total period occurrences in text`,
        );
        allMatches.forEach((period) => {
            console.log(period);
        });
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
     * Open and parse a single PDF file
     */
    async openPDF(pdfFile: PDFFile): Promise<any> {
        try {
            console.log(`Opening: ${pdfFile.name}`);
            const parser = new PDFParse({ url: pdfFile.path });
            const result = await parser.getText();
            await parser.destroy();
            return result;
        } catch (error) {
            console.error(`Error opening ${pdfFile.name}:`, error);
            throw error;
        }
    }

    /**
     * Open all PDFs in the downloads folder
     */
    async openAllPDFs(): Promise<void> {
        const pdfFiles = this.getPDFFiles();

        if (pdfFiles.length === 0) {
            console.log("No PDF files found to process");
            return;
        }

        console.log(`\n=== Opening ${pdfFiles.length} PDFs ===\n`);

        for (const pdfFile of pdfFiles) {
            try {
                const result = await this.openPDF(pdfFile);
                console.log(`Successfully opened: ${pdfFile.name}`);
                console.log(`  - Pages: ${result.pages?.length || "unknown"}`);
                console.log("");
            } catch (error) {
                console.error(`Failed to open: ${pdfFile.name}\n`);
            }
        }

        console.log("=== Done ===");
    }
}

// Main execution
async function main() {
    const processor = new PDFProcessor();
    const file: PDFFile = processor.getPDFFiles()[0];
    console.log(file.name);
    const text = await processor.openPDF(file);
    await processor.parsePeriodsFromText(
        text,
        processor.parseDateRange(file.name),
    );
}

if (require.main === module) {
    main().catch(console.error);
}

export default PDFProcessor;
