# SNP Browser

A high-performance web application for browsing and analyzing Single Nucleotide Polymorphism (SNP) data. Built with modern web technologies to handle large genomic datasets efficiently in the browser.

Full privacy preserving - no data is sent to any server; all processing is done on your machine.

**Live at: [snpbrowser.com](https://snpbrowser.com)**

## Data

The original data is originally based on a scrape from [https://github.com/jaykobdetar/SNPedia-Scraper](https://github.com/jaykobdetar/SNPedia-Scraper). The database schema was slightly modified to make querying it easier.

The SNP database is hosted at https://static.snpbrowser.com/snp-2025113.db

## Features

- **Client-side SQLite**: Process genomic data entirely in the browser using sql.js
- **Virtualized Rendering**: Efficiently display large datasets with react-virtuoso
- **Web Worker Processing**: Offload heavy computations using Comlink for a smooth UI experience
- **Modern React**: Built with React 19 and the React Compiler for optimal performance

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

### Prerequisites

- Node.js 18+ (or Bun)
- npm, yarn, or bun

### Getting Started

```bash
bun install

bun dev
```

## Project Structure

```
snp-browser/
├── src/              # Application source code
├── public/           # Static assets
├── dist/             # Production build output
└── vite.config.ts    # Vite configuration
```

## Building for Production

```bash
npm run build
```

The build process includes:

1. TypeScript type checking (`tsc -b`)
2. Vite production build with Rolldown
3. Output to `dist/` directory
