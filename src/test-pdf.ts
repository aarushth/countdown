import * as path from "path";
const { PDFParse } = require("pdf-parse");

async function main() {
  const filePath = path.join(__dirname, "../downloads/April 6th - 10th.pdf");
  
  const parser = new PDFParse({ url: filePath });
  const result = await parser.getText();
  await parser.destroy();
  
  // Split into lines and show numbered
  const lines = result.text.split("\n");
  lines.forEach((line: string, i: number) => {
    if (line.includes("Period")) {
      console.log(`Line ${i}: "${line}"`);
    }
  });
}

main().catch(console.error);
