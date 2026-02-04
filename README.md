# Countdown - Web Scraper

A TypeScript-based web scraper for extracting and reading PDF files from the EHS schedule page.

## Features

- Scrapes PDF links from https://ehs.lwsd.org/students-and-families/daily-schedule
- Downloads PDF files automatically
- Extracts and reads text content from PDFs
- Built with Node.js and TypeScript

## Installation

```bash
npm install
```

## Usage

Run the scraper:

```bash
npm start
```

Or for development:

```bash
npm run dev
```

Build the project:

```bash
npm run build
```

## How It Works

The scraper:
1. Fetches the daily schedule page
2. Extracts all PDF links with the format `<a data-file-name="*.pdf" ...>`
3. Downloads each PDF to the `downloads/` directory
4. Reads and extracts text content from each PDF
5. Displays the content in the console

## Dependencies

- **axios** - HTTP client for fetching pages and downloading files
- **cheerio** - HTML parsing and DOM manipulation
- **pdf-parse** - PDF text extraction
- **TypeScript** - Type-safe development