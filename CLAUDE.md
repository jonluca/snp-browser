# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SNP Browser is a React + TypeScript application built with Vite. This is currently a fresh Vite boilerplate project using React 19 and the React Compiler.

## Development Commands

```bash
# Start development server with HMR
npm run dev
# or
yarn dev
# or
bun dev

# Type checking
tsc -b

# Linting
npm run lint
# or
yarn lint
# or
bun lint

# Production build (includes type checking + build)
npm run build
# or
yarn build
# or
bun build

# Preview production build
npm run preview
# or
yarn preview
# or
bun preview
```

## Build System

### Vite Configuration

- Uses **Rolldown** (a Rust-based Vite alternative) via `npm:rolldown-vite@7.2.2`
- React plugin configured with Babel for Fast Refresh
- **React Compiler is enabled** via `babel-plugin-react-compiler` in vite.config.ts:5-12

### TypeScript Setup

- Project uses TypeScript project references (tsconfig.json:3-6)
- `tsconfig.app.json` - Application code configuration (src/ directory)
- `tsconfig.node.json` - Build tooling configuration (vite.config.ts)
- Strict mode enabled with additional linting options
- Build artifacts stored in `node_modules/.tmp/`

### ESLint Configuration

- Uses flat config format (eslint.config.js)
- Configured for TypeScript with recommended rules
- React Hooks plugin with recommended rules
- React Refresh plugin for Vite
- Ignores `dist/` directory

## Architecture Notes

### React Compiler Impact

The React Compiler is enabled in this project (vite.config.ts:8-10). This affects:

- Development and build performance
- Automatic optimization of component re-renders
- See https://react.dev/learn/react-compiler for details

### Entry Point

- Application mounts at `src/main.tsx:6-10`
- Root component is `src/App.tsx`
- Uses React 19's StrictMode

### Current State

This is a fresh Vite boilerplate with minimal modifications. The project structure follows standard Vite conventions:

- `src/` - Source code
- `public/` - Static assets
- `dist/` - Build output (gitignored)
