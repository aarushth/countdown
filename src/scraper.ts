import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
const { PDFParse } = require("pdf-parse");

interface PDFLink {
  fileName: string;
  resourceUuid: string;
  url: string;
  text: string;
}

class ScheduleScraper {
  private baseUrl = "https://ehs.lwsd.org";
  private pageUrl = "https://ehs.lwsd.org/students-and-families/daily-schedule";
  private downloadDir = path.join(__dirname, "../downloads");

  constructor() {
    // Create downloads directory if it doesn't exist
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  /**
   * Fetch the schedule page and extract PDF links
   */
  async extractPDFLinks(): Promise<PDFLink[]> {
    try {
      console.log(`Fetching page: ${this.pageUrl}`);
      const response = await axios.get(this.pageUrl);
      const $ = cheerio.load(response.data);

      const pdfLinks: PDFLink[] = [];

      // Find all anchor tags with data-file-name attribute ending in .pdf
      $('a[data-file-name$=".pdf"]').each((_, element) => {
        const $el = $(element);
        const fileName = $el.attr("data-file-name");
        const resourceUuid = $el.attr("data-resource-uuid");
        const href = $el.attr("href");
        const text = $el.text().trim();

        if (fileName && resourceUuid && href) {
          pdfLinks.push({
            fileName,
            resourceUuid,
            url: this.baseUrl + href,
            text,
          });
        }
      });

      console.log(`Found ${pdfLinks.length} PDF links`);
      return pdfLinks;
    } catch (error) {
      console.error("Error fetching page:", error);
      throw error;
    }
  }

  /**
   * Sanitize a filename by removing/replacing invalid characters
   */
  private sanitizeFilename(name: string): string {
    // Remove or replace characters that are invalid in filenames
    return name
      .replace(/[<>:"/\\|?*]/g, "-") // Replace invalid chars with dash
      .replace(/\s+/g, " ") // Normalize whitespace
      .trim();
  }

  /**
   * Download a PDF file, using the link text as the filename
   */
  async downloadPDF(link: PDFLink): Promise<string> {
    try {
      // Use the link text as the filename (sanitized)
      const displayName = this.sanitizeFilename(link.text) || link.fileName;
      const filename = displayName.endsWith(".pdf")
        ? displayName
        : `${displayName}.pdf`;

      console.log(`Downloading: ${link.text}`);
      const response = await axios.get(link.url, {
        responseType: "arraybuffer",
      });

      const filePath = path.join(this.downloadDir, filename);
      fs.writeFileSync(filePath, response.data);
      console.log(`Saved to: ${filePath}`);

      return filePath;
    } catch (error) {
      console.error(`Error downloading ${link.text}:`, error);
      throw error;
    }
  }

  /**
   * Download all PDFs from the schedule page
   */
  async downloadAll(): Promise<string[]> {
    try {
      const links = await this.extractPDFLinks();

      if (links.length === 0) {
        console.log("No PDF links found");
        return [];
      }

      console.log(`\n=== Downloading ${links.length} PDFs ===`);
      const downloadedFiles: string[] = [];

      for (const link of links) {
        try {
          const filePath = await this.downloadPDF(link);
          downloadedFiles.push(filePath);
        } catch (error) {
          console.error(`Failed to download: ${link.text}`);
        }
      }

      console.log(
        `\n=== Downloaded ${downloadedFiles.length}/${links.length} PDFs ===`,
      );
      return downloadedFiles;
    } catch (error) {
      console.error("Error in downloadAll:", error);
      throw error;
    }
  }
}

// Main execution
async function main() {
  const scraper = new ScheduleScraper();
  await scraper.downloadAll();
}

// Run the scraper
if (require.main === module) {
  main().catch(console.error);
}

export default ScheduleScraper;
