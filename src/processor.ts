import * as fs from "fs";
import * as path from "path";
import ScheduleDatabase, { ScheduleEntry } from "./database";
const { PDFParse } = require("pdf-parse");

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

  /**
   * Parse the filename to extract the date range
   * Format: "April 6th - 10th.pdf" or "April 27th - May 1st.pdf"
   */
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
  parsePeriodsFromText(text: string, dates: Date[]): ParsedPeriod[] {
    // First, extract which periods meet each day from the header
    const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const dayPeriods: Map<number, Set<number>> = new Map();

    for (let dayIdx = 0; dayIdx < dayNames.length; dayIdx++) {
      const dayName = dayNames[dayIdx];
      const dayPattern = new RegExp(`${dayName}\\s*\\n([\\d,\\-]+)`, "i");
      const match = text.match(dayPattern);
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
            .forEach((p) => periodSet.add(parseInt(p.trim())));
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

    // Build a list of days each period appears on (in order)
    const periodDays: Map<number, number[]> = new Map();
    for (let p = 1; p <= 6; p++) {
      const days: number[] = [];
      for (let d = 0; d < 5; d++) {
        if (dayPeriods.get(d)?.has(p)) {
          days.push(d);
        }
      }
      periodDays.set(p, days);
    }

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
    while ((match = periodPattern.exec(text)) !== null) {
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

    // Track next day index for each period
    const nextDayIndex: Map<number, number> = new Map();
    for (let p = 1; p <= 6; p++) {
      nextDayIndex.set(p, 0);
    }

    // Final results - key: "periodNum-dayIdx"
    const result: Map<string, ParsedPeriod> = new Map();

    for (const entry of allMatches) {
      const periodNum = entry.periodNum;
      const daysForThisPeriod = periodDays.get(periodNum) || [];
      const dayIndexPtr = nextDayIndex.get(periodNum) || 0;

      if (dayIndexPtr >= daysForThisPeriod.length) {
        // This is a duplicate occurrence (A/B lunch), wrap around
        nextDayIndex.set(periodNum, 0);
      }

      const currentDayIndex = nextDayIndex.get(periodNum) || 0;
      if (currentDayIndex >= daysForThisPeriod.length) continue;

      const assignedDay = daysForThisPeriod[currentDayIndex];
      nextDayIndex.set(periodNum, currentDayIndex + 1);

      const key = `${periodNum}-${assignedDay}`;

      // Check for A/B lunch context
      const textBefore = text.substring(0, entry.index);
      const lastALunch = textBefore.lastIndexOf("A Lunch");
      const lastBLunch = textBefore.lastIndexOf("B Lunch");

      const existing = result.get(key);

      // Determine if this occurrence is after a lunch
      const isAfterALunch =
        existing &&
        lastALunch >
          textBefore.lastIndexOf(`Period ${periodNum}\n${existing.startTime}`);
      const isAfterBLunch =
        existing &&
        lastBLunch >
          textBefore.lastIndexOf(`Period ${periodNum}\n${existing.startTime}`);

      if (!existing) {
        result.set(key, {
          name: `Period ${periodNum}`,
          startTime: entry.startTime,
          endTime: entry.endTime,
          columnIndex: assignedDay,
        });
      } else if (periodNum === 3 && isAfterBLunch) {
        // For Period 3, prefer B Lunch timing
        result.set(key, {
          name: `Period ${periodNum}`,
          startTime: entry.startTime,
          endTime: entry.endTime,
          columnIndex: assignedDay,
        });
      } else if (periodNum === 4 && isAfterALunch) {
        // For Period 4, prefer A Lunch timing
        result.set(key, {
          name: `Period ${periodNum}`,
          startTime: entry.startTime,
          endTime: entry.endTime,
          columnIndex: assignedDay,
        });
      }
    }

    // Convert map to array and sort by day then period
    const periods = Array.from(result.values());
    periods.sort((a, b) => {
      if (a.columnIndex !== b.columnIndex) return a.columnIndex - b.columnIndex;
      const aNum = parseInt(a.name.replace("Period ", ""));
      const bNum = parseInt(b.name.replace("Period ", ""));
      return aNum - bNum;
    });

    return periods;
  }

  /**
   * Test processing a single PDF file using text extraction
   */
  async testOnePDF(): Promise<void> {
    const testFile: PDFFile = {
      name: "April 6th - 10th.pdf",
      path: path.join(this.downloadDir, "April 6th - 10th.pdf"),
    };

    console.log(`\n=== Testing PDF: ${testFile.name} ===\n`);

    // Parse dates from filename
    const dates = this.parseDateRange(testFile.name);
    console.log("Parsed dates:");
    dates.forEach((d, i) => console.log(`  Column ${i}: ${d.toDateString()}`));

    if (dates.length === 0) {
      console.error("Failed to parse dates from filename");
      return;
    }

    // Open and parse PDF using text extraction
    const parser = new PDFParse({ url: testFile.path });
    const result = await parser.getText();
    await parser.destroy();

    console.log("\n--- Raw text preview ---");
    console.log(result.text.substring(0, 300));
    console.log("...\n");

    // Parse periods from text
    const periods = this.parsePeriodsFromText(result.text, dates);
    console.log(`\nFound ${periods.length} Period entries:\n`);

    // Create schedule entries and insert into DB
    const entries: Omit<ScheduleEntry, "id">[] = [];

    for (const period of periods) {
      const date = dates[period.columnIndex];
      if (!date) {
        console.log(
          `  Skipping ${period.name} - invalid column ${period.columnIndex}`,
        );
        continue;
      }

      // Parse times and create full DateTime
      // School hours are typically 7am-4pm, so times like 1:00 mean 1:00 PM (13:00)
      let [startHour, startMin] = period.startTime.split(":").map(Number);
      let [endHour, endMin] = period.endTime.split(":").map(Number);

      // Convert to 24-hour format: hours < 7 are PM (add 12)
      if (startHour < 7) startHour += 12;
      if (endHour < 7) endHour += 12;

      const startTime = new Date(date);
      startTime.setHours(startHour, startMin, 0, 0);

      const endTime = new Date(date);
      endTime.setHours(endHour, endMin, 0, 0);

      entries.push({
        name: period.name,
        startTime,
        endTime,
      });

      console.log(
        `  ${period.name} on ${date.toDateString()}: ${period.startTime} - ${period.endTime}`,
      );
    }

    // Clear existing entries and insert new ones
    console.log("\n--- Inserting into database ---");
    this.db.clearAll();
    this.db.insertMany(entries);

    // Verify
    const allEntries = this.db.getAll();
    console.log(`\nInserted ${allEntries.length} entries into database`);
    console.log("\nAll entries by day:");

    // Group and show by day
    const byDay = new Map<string, typeof allEntries>();
    for (const e of allEntries) {
      const dateStr = e.startTime.toDateString();
      if (!byDay.has(dateStr)) byDay.set(dateStr, []);
      byDay.get(dateStr)!.push(e);
    }

    byDay.forEach((entries, day) => {
      console.log(`\n  ${day}:`);
      entries.forEach((e) => {
        const start = e.startTime.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        const end = e.endTime.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        console.log(`    ${e.name}: ${start} - ${end}`);
      });
    });

    this.db.close();
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
  await processor.testOnePDF();
}

// Run the processor
if (require.main === module) {
  main().catch(console.error);
}

export default PDFProcessor;
