# SNP Browser

A high-performance web application for browsing and analyzing Single Nucleotide Polymorphism (SNP) data from multiple DNA testing providers. Built with modern web technologies to handle large genomic datasets efficiently in the browser.

**Privacy-first**: No data is sent to any server; all processing is done locally on your machine.

**Multi-format support**: Works with DNA data from 23andMe, AncestryDNA, MyHeritage, FamilyTreeDNA, and more.

**Live at: [snpbrowser.com](https://snpbrowser.com)**

![](http://static.snpbrowser.com/snp-browser.png)

## Data

The original data is originally based on a scrape from [https://github.com/jaykobdetar/SNPedia-Scraper](https://github.com/jaykobdetar/SNPedia-Scraper). The database schema was slightly modified to make querying it easier.

The SNP database is hosted at https://static.snpbrowser.com/snp-2025113.db

## Features

- **Multi-Format Support**: Automatically detects and parses DNA data from multiple providers
  - 23andMe (TXT, CSV)
  - AncestryDNA (TXT, CSV)
  - MyHeritage (CSV)
  - FamilyTreeDNA (CSV)
- **Automatic Format Detection**: Smart detection system identifies file format with confidence scoring
- **Client-side SQLite**: Process genomic data entirely in the browser using sql.js
- **Virtualized Rendering**: Efficiently display large datasets with react-virtuoso
- **Web Worker Processing**: Offload heavy computations using Comlink for a smooth UI experience
- **Modern React**: Built with React 19 and the React Compiler for optimal performance
- **Extensible Architecture**: Easy to add support for new DNA file formats

## Tech Stack

- **React 19** with React Compiler for automatic optimizations
- **TypeScript** for type safety
- **Vite** (via Rolldown) for fast builds and HMR
- **TanStack Query** for data fetching and caching
- **Tailwind CSS** for styling
- **sql.js** for in-browser SQLite databases
- **Comlink** for web worker communication
- **React Virtuoso** for virtualized list rendering

## Development

### Getting Started

Development used [bun](https://bun.sh/), so all commands are run with `bun`.

```bash
bun install
bun dev
```

## Supported DNA File Formats

### 23andMe

- **Format**: Tab or space-separated text files
- **Extensions**: `.txt`, `.csv`
- **Structure**: `rsid chromosome position genotype`
- **Example**: `rs4477212    1    82154    AA`

### AncestryDNA

- **Format**: Tab-separated text files
- **Extensions**: `.txt`, `.csv`
- **Structure**: `rsid chromosome position allele1 allele2`
- **Example**: `rs4477212    1    82154    A    A`

### MyHeritage

- **Format**: CSV (comma-separated values)
- **Extensions**: `.csv`
- **Structure**: `RSID,CHROMOSOME,POSITION,RESULT`
- **Example**: `rs4477212,1,82154,AA`

### FamilyTreeDNA (FTDNA)

- **Format**: CSV with quoted values
- **Extensions**: `.csv`
- **Structure**: `RSID,"CHROMOSOME","POSITION","RESULT"`
- **Example**: `rs4477212,"1","82154","AA"`

The application automatically detects the file format when you upload your DNA data.

## Architecture

### Parser System

The application uses a modular parser architecture that makes it easy to add support for new DNA file formats:

```
src/
├── parsers/
│   ├── types.ts           # Core parser interfaces
│   ├── registry.ts        # Parser registry and detection
│   ├── index.ts           # Exports and auto-registration
│   ├── 23andme/
│   │   └── index.ts       # 23andMe parser
│   ├── ancestry/
│   │   └── index.ts       # AncestryDNA parser
│   ├── myheritage/
│   │   └── index.ts       # MyHeritage parser
│   └── ftdna/
│       └── index.ts       # FamilyTreeDNA parser
```

#### Adding a New Parser

1. Create a new directory under `src/parsers/` (e.g., `myformat/`)
2. Implement the `DNAParser` interface in `index.ts`:

   ```typescript
   import type { DNAParser } from "../types";

   export class MyFormatParser implements DNAParser {
     readonly metadata = {
       id: "myformat",
       name: "My Format",
       description: "My DNA testing format",
       version: "1.0.0",
       fileExtensions: [".txt"],
     };

     validate(content: string): ValidationResult {
       // Return validation result with confidence score (0-1)
     }

     async parse(content: string, onProgress: ProgressCallback): Promise<ParseResult> {
       // Parse the file and return genotype data
     }
   }

   export default new MyFormatParser();
   ```

3. Register your parser in `src/parsers/index.ts`:
   ```typescript
   import parserMyFormat from "./myformat";
   parserRegistry.register(parserMyFormat);
   ```

That's it! Your new format will be automatically detected and supported.

## Project Structure

```
snp-browser/
├── src/
│   ├── parsers/         # DNA file format parsers
│   ├── components/      # React components
│   ├── workers/         # Web Workers
│   ├── hooks/           # React hooks
│   ├── types/           # TypeScript types
│   └── utils/           # Utility functions
├── public/              # Static assets
├── dist/                # Production build output
└── vite.config.ts       # Vite configuration
```

## Building for Production

```bash
npm run build
```

The build process includes:

1. TypeScript type checking (`tsc -b`)
2. Vite production build with Rolldown
3. Output to `dist/` directory
