import type { DNAParser, ValidationResult, ProgressCallback, ParserMetadata } from "../types";
import type { ParseResult, UserGenotype } from "../../types/snp";

const METADATA: ParserMetadata = {
  id: "vcf",
  name: "VCF / gVCF",
  description: "Variant Call Format (VCF/gVCF) files with genotype sample columns",
  version: "1.0.0",
  fileExtensions: [".vcf", ".gvcf", ".g.vcf", ".vcf.gz", ".g.vcf.gz", ".gz"],
  providerUrl: "https://samtools.github.io/hts-specs/VCFv4.5.pdf",
};

const BASE_ORDER: Record<string, number> = {
  a: 0,
  c: 1,
  g: 2,
  t: 3,
};

const BGZF_HEADER_READ_SIZE = 256;
const BGZF_EXTRA_ID1 = 0x42;
const BGZF_EXTRA_ID2 = 0x43;
const GZIP_ID1 = 0x1f;
const GZIP_ID2 = 0x8b;
const GZIP_DEFLATE_METHOD = 0x08;
const GZIP_FLAG_FEXTRA = 0x04;

type VcfGenotypeParseResult =
  | { status: "called"; genotype: string }
  | { status: "invalid" }
  | { status: "unsupported" };

type BgzfBlockHeader = { blockSize: number; payloadOffset: number };
type BgzfHeaderResult = BgzfBlockHeader | "need-more" | null;

interface VcfParseState {
  genotypes: UserGenotype[];
  errors: string[];
  skippedLines: number;
  totalLines: number;
  headerFound: boolean;
}

/**
 * Parser for VCF genotype files.
 *
 * VCF records contain allele indexes in the sample GT field. This parser maps
 * those indexes back to REF/ALT bases and emits rsid-based genotypes that match
 * the normalized shape used by the other raw DNA parsers.
 */
export class ParserVCF implements DNAParser {
  readonly metadata = METADATA;

  validate(content: string): ValidationResult {
    const lines = content.split("\n").slice(0, 500);

    let hasFileFormat = false;
    let hasColumnHeader = false;
    let hasSampleColumns = false;
    let hasRsidData = false;
    let validDataLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.toLowerCase().startsWith("##fileformat=vcf")) {
        hasFileFormat = true;
        continue;
      }

      if (trimmed.startsWith("#CHROM")) {
        const parts = this.splitColumns(trimmed);
        hasColumnHeader =
          parts.length >= 8 &&
          parts[0] === "#CHROM" &&
          parts[1] === "POS" &&
          parts[2] === "ID" &&
          parts[3] === "REF" &&
          parts[4] === "ALT";
        hasSampleColumns = parts.length >= 10 && parts[8] === "FORMAT";
        continue;
      }

      if (trimmed.startsWith("#")) continue;

      const parts = this.splitColumns(trimmed);
      if (parts.length >= 10 && this.extractRsid(parts[2])) {
        hasRsidData = true;

        const genotype = this.parseSampleGenotype(parts[3], parts[4], parts[8], parts[9]);
        if (genotype.status === "called") {
          validDataLines++;
        }
      }
    }

    let confidence = 0;
    if (hasFileFormat) confidence += 0.4;
    if (hasColumnHeader) confidence += 0.3;
    if (hasSampleColumns) confidence += 0.2;
    if (hasRsidData && validDataLines > 0) confidence += 0.1;

    const valid = (hasFileFormat && hasColumnHeader) || (hasColumnHeader && validDataLines > 0);

    return {
      valid,
      confidence: valid ? confidence : 0,
      reason: valid
        ? `Detected VCF format with ${validDataLines} genotype records in the sampled lines`
        : "File doesn't appear to be VCF format",
      detectedFormat: valid ? METADATA.id : undefined,
    };
  }

  async parse(content: string, onProgress: ProgressCallback): Promise<ParseResult> {
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    const state = this.createParseState(totalLines);

    onProgress(0, totalLines);

    const batchSize = 1000;

    for (let i = 0; i < lines.length; i++) {
      this.processLine(lines[i], i + 1, state);

      if (i % batchSize === 0 || i === lines.length - 1) {
        onProgress(i + 1, totalLines);
      }
    }

    return {
      genotypes: state.genotypes,
      totalLines,
      skippedLines: state.skippedLines,
      errors: state.errors,
    };
  }

  async parseBlob(file: Blob & { name?: string }, onProgress: ProgressCallback): Promise<ParseResult> {
    const state = this.createParseState(0);
    const totalBytes = file.size;
    const stream = await this.openTextStream(file);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let bufferedText = "";
    let bytesRead = 0;

    onProgress(0, totalBytes);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;
      const text = decoder.decode(value, { stream: true });
      const lines = (bufferedText + text).split(/\r?\n/);
      bufferedText = lines.pop() ?? "";

      for (const line of lines) {
        state.totalLines++;
        this.processLine(line, state.totalLines, state);
      }

      onProgress(Math.min(bytesRead, totalBytes), totalBytes);
    }

    const finalText = bufferedText + decoder.decode();
    if (finalText) {
      state.totalLines++;
      this.processLine(finalText, state.totalLines, state);
    }

    onProgress(totalBytes, totalBytes);

    return {
      genotypes: state.genotypes,
      totalLines: state.totalLines,
      skippedLines: state.skippedLines,
      errors: state.errors,
    };
  }

  private createParseState(totalLines: number): VcfParseState {
    return {
      genotypes: [],
      errors: [],
      skippedLines: 0,
      totalLines,
      headerFound: false,
    };
  }

  private async openTextStream(file: Blob & { name?: string }): Promise<ReadableStream<Uint8Array>> {
    const stream = file.stream();
    if (!file.name?.toLowerCase().endsWith(".gz")) {
      return stream;
    }

    if (!("DecompressionStream" in globalThis)) {
      throw new Error(
        "Compressed VCF files are not supported in this browser. Please upload an uncompressed VCF/gVCF.",
      );
    }

    if (await this.isBgzf(file)) {
      return this.openBgzfTextStream(file);
    }

    return stream.pipeThrough(new DecompressionStream("gzip"));
  }

  private async isBgzf(file: Blob): Promise<boolean> {
    const headerBytes = new Uint8Array(await file.slice(0, BGZF_HEADER_READ_SIZE).arrayBuffer());
    const header = this.readBgzfBlockHeader(headerBytes);
    return header !== null && header !== "need-more";
  }

  private openBgzfTextStream(file: Blob): ReadableStream<Uint8Array> {
    const blocks = this.streamBgzfBlocks(file.stream());
    const iterator = blocks[Symbol.asyncIterator]();

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await iterator.next();
          if (done) {
            controller.close();
            return;
          }

          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.(undefined);
      },
    });
  }

  private async *streamBgzfBlocks(source: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = source.getReader();
    let pending: Uint8Array = new Uint8Array();

    try {
      while (true) {
        const nextBlock = await this.readNextBgzfBlock(reader, pending);
        pending = nextBlock.pending;

        if (nextBlock.done) {
          if (pending.byteLength > 0) {
            throw new Error("Compressed VCF file ended with an incomplete BGZF block.");
          }
          return;
        }

        if (nextBlock.value.byteLength > 0) {
          yield nextBlock.value;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async readNextBgzfBlock(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    pending: Uint8Array,
  ): Promise<{ done: true; pending: Uint8Array } | { done: false; pending: Uint8Array; value: Uint8Array }> {
    while (true) {
      const blockHeader = this.readBgzfBlockHeader(pending);

      if (blockHeader !== "need-more") {
        if (!blockHeader) {
          throw new Error("Compressed VCF file contains an invalid BGZF block.");
        }

        if (pending.byteLength >= blockHeader.blockSize) {
          const block = pending.subarray(0, blockHeader.blockSize);
          const compressedData = block.subarray(blockHeader.payloadOffset, blockHeader.blockSize - 8);
          const value = await this.inflateRaw(compressedData);

          this.validateBgzfBlockSize(block, value.byteLength);

          return {
            done: false,
            pending: pending.subarray(blockHeader.blockSize),
            value,
          };
        }
      }

      const { done, value } = await reader.read();
      if (done) {
        return { done: true, pending };
      }

      pending = this.appendBytes(pending, value);
    }
  }

  private readBgzfBlockHeader(bytes: Uint8Array): BgzfHeaderResult {
    if (bytes.byteLength < 12) {
      return "need-more";
    }

    if (
      bytes[0] !== GZIP_ID1 ||
      bytes[1] !== GZIP_ID2 ||
      bytes[2] !== GZIP_DEFLATE_METHOD ||
      (bytes[3] & GZIP_FLAG_FEXTRA) === 0
    ) {
      return null;
    }

    const extraLength = this.readUint16LE(bytes, 10);
    const extraStart = 12;
    const extraEnd = extraStart + extraLength;

    if (bytes.byteLength < extraEnd) {
      return "need-more";
    }

    let offset = extraStart;
    let blockSize: number | null = null;

    while (offset + 4 <= extraEnd) {
      const subfieldLength = this.readUint16LE(bytes, offset + 2);
      const subfieldDataStart = offset + 4;
      const subfieldDataEnd = subfieldDataStart + subfieldLength;

      if (subfieldDataEnd > extraEnd) {
        return null;
      }

      if (bytes[offset] === BGZF_EXTRA_ID1 && bytes[offset + 1] === BGZF_EXTRA_ID2 && subfieldLength === 2) {
        blockSize = this.readUint16LE(bytes, subfieldDataStart) + 1;
      }

      offset = subfieldDataEnd;
    }

    if (offset !== extraEnd || blockSize === null || blockSize < extraEnd + 8) {
      return null;
    }

    return { blockSize, payloadOffset: extraEnd };
  }

  private async inflateRaw(compressedData: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([this.bytesToArrayBuffer(compressedData)])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));

    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  private validateBgzfBlockSize(block: Uint8Array, inflatedSize: number): void {
    const expectedSize = this.readUint32LE(block, block.byteLength - 4);
    if (expectedSize !== inflatedSize) {
      throw new Error("Compressed VCF file contains a BGZF block with an invalid uncompressed size.");
    }
  }

  private appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
    if (left.byteLength === 0) {
      return right;
    }

    const joined = new Uint8Array(left.byteLength + right.byteLength);
    joined.set(left);
    joined.set(right, left.byteLength);

    return joined;
  }

  private readUint16LE(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  private readUint32LE(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  private bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  private processLine(rawLine: string, lineNumber: number, state: VcfParseState): void {
    const line = rawLine.trim();

    if (!line) {
      state.skippedLines++;
      return;
    }

    if (line.startsWith("##")) {
      state.skippedLines++;
      return;
    }

    if (line.startsWith("#CHROM")) {
      const parts = this.splitColumns(line);
      state.headerFound = true;
      state.skippedLines++;

      if (parts.length < 10) {
        state.errors.push(`Line ${lineNumber}: VCF header does not include FORMAT and sample columns`);
      }
      return;
    }

    if (line.startsWith("#")) {
      state.skippedLines++;
      return;
    }

    const parts = this.splitColumns(line);
    if (parts.length < 8) {
      state.errors.push(`Line ${lineNumber}: Invalid VCF record - expected at least 8 columns, got ${parts.length}`);
      state.skippedLines++;
      return;
    }

    if (!state.headerFound) {
      state.errors.push(`Line ${lineNumber}: VCF data record appeared before #CHROM header`);
      state.skippedLines++;
      return;
    }

    const [chromosome, position, id, ref, alt] = parts;
    const rsid = this.extractRsid(id);

    if (!rsid) {
      state.skippedLines++;
      return;
    }

    if (parts.length < 10 || parts[8] === undefined || parts[9] === undefined) {
      state.errors.push(`Line ${lineNumber}: VCF record for ${rsid} does not include FORMAT and sample columns`);
      state.skippedLines++;
      return;
    }

    const genotype = this.parseSampleGenotype(ref ?? "", alt ?? "", parts[8], parts[9]);
    if (genotype.status === "unsupported") {
      state.skippedLines++;
      return;
    }

    if (genotype.status === "invalid") {
      state.errors.push(`Line ${lineNumber}: Could not convert GT field to SNP bases for ${rsid}`);
      state.skippedLines++;
      return;
    }

    state.genotypes.push({
      rsid,
      chromosome: this.normalizeChromosome(chromosome ?? ""),
      position: position ?? "",
      genotype: genotype.genotype,
    });
  }

  private splitColumns(line: string): string[] {
    const tabParts = line.split("\t");
    return tabParts.length > 1 ? tabParts : line.split(/\s+/);
  }

  private extractRsid(id: string): string | null {
    const match = id.match(/\b(?:rs|i)\d+\b/i);
    return match ? match[0].toLowerCase() : null;
  }

  private normalizeChromosome(chromosome: string): string {
    const normalized = chromosome.replace(/^chr/i, "");
    return normalized.toUpperCase() === "M" ? "MT" : normalized;
  }

  private parseSampleGenotype(ref: string, alt: string, format: string, sample: string): VcfGenotypeParseResult {
    const formatFields = format.split(":");
    const sampleFields = sample.split(":");
    const genotypeIndex = formatFields.indexOf("GT");
    if (genotypeIndex < 0) return { status: "unsupported" };
    const genotypeField = sampleFields[genotypeIndex];

    if (!genotypeField) return { status: "invalid" };

    const alleleIndexes = genotypeField.split(/[/|]/);
    if (alleleIndexes.length === 0) return { status: "invalid" };

    if (alleleIndexes.some((alleleIndex) => alleleIndex === ".")) {
      return { status: "called", genotype: "--" };
    }

    const alleles = [ref, ...alt.split(",")];
    const genotypeBases: string[] = [];

    for (const alleleIndex of alleleIndexes) {
      if (!/^\d+$/.test(alleleIndex)) return { status: "invalid" };

      const allele = alleles[Number(alleleIndex)]?.toLowerCase();
      if (!allele || !/^[acgt]$/.test(allele)) {
        return { status: "unsupported" };
      }

      genotypeBases.push(allele);
    }

    return { status: "called", genotype: this.normalizeGenotypeOrder(genotypeBases) };
  }

  private normalizeGenotypeOrder(alleles: string[]): string {
    return alleles.sort((a, b) => BASE_ORDER[a] - BASE_ORDER[b]).join("");
  }
}

/**
 * Default export for convenience
 */
export default new ParserVCF();
