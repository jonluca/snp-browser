## Stage 1: Inventory DNA Folder Formats

**Goal**: Identify every raw DNA-like file and distinguish reports from genotype exports.
**Success Criteria**: Each candidate file is classified as processable, unsupported report, or needs parser/upload support.
**Tests**: Local aggregate detection/parsing probes only.
**Status**: Complete

## Stage 2: Add Missing Format Support

**Goal**: Support zipped raw DNA archives, Color discovery genotype CSVs, and generic VCF gzip filenames.
**Success Criteria**: App can accept ZIP archives with supported entries, Color discovery genotype rows parse, and `_vcf_*.gz` files route through VCF streaming.
**Tests**: Unit tests for ZIP extraction routing, Color parser, and filename detection.
**Status**: Complete

## Stage 3: Verify Folder Files

**Goal**: Run aggregate parse/match checks for all processable DNA files in `/Volumes/Backup/Health/DNA`.
**Success Criteria**: All raw genotype files parse without parser errors and match path has no query errors; unsupported report files are explicitly identified.
**Tests**: `bun test`, `bun run typecheck`, `bun run build`, local aggregate file checks.
**Status**: In Progress
