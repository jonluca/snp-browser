import { applyFileMetadata, detectFileMetadata, type FileMetadata } from "../metadata";
import type { DNAParser, ValidationResult, ProgressCallback, ParserMetadata } from "../types";
import type { ParseResult, UserGenotype } from "../../types/snp";
import { normalizeChromosome, normalizePosition } from "../../utils/variantIdentity";

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
// VCF 4.5 section 1.4.7 uses SAM reference-name syntax, including alternate
// contigs such as names containing '*'. Encode delimiters in coordinate IDs.
const VCF_CONTIG = /^[0-9A-Za-z!#$%&+./:;?@^_|~-][0-9A-Za-z!#$%&*+./:;=?@^_|~-]*$/;

type VcfGenotypeParseResult =
  | { status: "called"; genotype: string; alt?: string; phased?: boolean; alleles?: string[] }
  | { status: "invalid" }
  | { status: "unsupported"; reason: string };

type BgzfBlockHeader = { blockSize: number; payloadOffset: number };
type BgzfHeaderResult = BgzfBlockHeader | "need-more" | null;

interface VcfParseState {
  genotypes: UserGenotype[];
  errors: string[];
  skippedLines: number;
  totalLines: number;
  headerFound: boolean;
  metadataLines: string[];
  fileMetadata: FileMetadata;
  skippedRecords: Map<string, number>;
}

/**
 * Parser for VCF genotype files.
 *
 * VCF records contain allele indexes in the sample GT field. This parser maps
 * those indexes back to complete REF/ALT sequences. Records without an ID are retained only
 * when an explicit supported assembly gives their coordinates a stable identity.
 */
export class ParserVCF implements DNAParser {
  readonly metadata = METADATA;

  validate(content: string): ValidationResult {
    const lines = content.split("\n").slice(0, 500);

    let hasFileFormat = false;
    let hasColumnHeader = false;
    let hasSampleColumns = false;
    let validDataLines = 0;
    const assembly = detectFileMetadata(content, true).assembly;

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
      if (parts.length >= 10 && this.variantId(parts[2], parts[0], parts[1], parts[3], parts[4], assembly)) {
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
    if (validDataLines > 0) confidence += 0.1;

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

    return this.finishParse(state);
  }

  /** Sniff compressed archives through the same gzip/BGZF decoder used for import. */
  async readDetectionPrefix(file: Blob & { name?: string }, maximumBytes = 256 * 1024): Promise<string> {
    const stream = await this.openTextStream(file, () => {});
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let bytesRead = 0;
    try {
      while (bytesRead < maximumBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        const prefix = value.subarray(0, maximumBytes - bytesRead);
        bytesRead += prefix.byteLength;
        content += decoder.decode(prefix, { stream: true });
      }
      return content + decoder.decode();
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }

  async parseBlob(file: Blob & { name?: string }, onProgress: ProgressCallback): Promise<ParseResult> {
    const state = this.createParseState(0);
    const totalBytes = file.size;
    let bytesRead = 0;
    onProgress(0, totalBytes);
    const stream = await this.openTextStream(file, (chunkBytes) => {
      bytesRead += chunkBytes;
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let bufferedText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

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

      return this.finishParse(state);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private createParseState(totalLines: number): VcfParseState {
    return {
      genotypes: [],
      errors: [],
      skippedLines: 0,
      totalLines,
      headerFound: false,
      metadataLines: [],
      fileMetadata: {},
      skippedRecords: new Map(),
    };
  }

  private finishParse(state: VcfParseState): ParseResult {
    return applyFileMetadata(
      {
        genotypes: state.genotypes,
        totalLines: state.totalLines,
        skippedLines: state.skippedLines,
        errors: state.errors,
        ...(state.skippedRecords.size
          ? { warnings: [...state.skippedRecords].map(([reason, count]) => `${count.toLocaleString()} ${reason}`) }
          : {}),
      },
      state.fileMetadata,
    );
  }

  private async openTextStream(
    file: Blob & { name?: string },
    onInputChunk: (bytes: number) => void,
  ): Promise<ReadableStream<Uint8Array>> {
    // File.size measures compressed bytes; count input before either decoder expands it.
    const stream = file.stream().pipeThrough(
      new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform(chunk, controller) {
          onInputChunk(chunk.byteLength);
          controller.enqueue(chunk);
        },
      }),
    );
    if (!file.name?.toLowerCase().endsWith(".gz")) {
      return stream;
    }

    if (!("DecompressionStream" in globalThis)) {
      throw new Error(
        "Compressed VCF files are not supported in this browser. Please upload an uncompressed VCF/gVCF.",
      );
    }

    if (await this.isBgzf(file)) {
      return this.openBgzfTextStream(stream);
    }

    return stream.pipeThrough(new DecompressionStream("gzip"));
  }

  private async isBgzf(file: Blob): Promise<boolean> {
    const headerBytes = new Uint8Array(await file.slice(0, BGZF_HEADER_READ_SIZE).arrayBuffer());
    const header = this.readBgzfBlockHeader(headerBytes);
    return header !== null && header !== "need-more";
  }

  private openBgzfTextStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const blocks = this.streamBgzfBlocks(source);
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
      await reader.cancel().catch(() => undefined);
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
      if (
        !state.headerFound &&
        (/^##reference=/i.test(line) || (/^##contig=/i.test(line) && /[,<]assembly=/i.test(line)))
      ) {
        state.metadataLines.push(line);
      }
      state.skippedLines++;
      return;
    }

    if (line.startsWith("#CHROM")) {
      const parts = this.splitColumns(line);
      this.rejectAdditionalSamples(parts, lineNumber);
      if (state.headerFound) {
        throw new Error(
          `Line ${lineNumber}: This VCF contains more than one #CHROM header. Upload a single-sample VCF with one header.`,
        );
      }
      state.fileMetadata = detectFileMetadata(state.metadataLines.join("\n"), true);
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
    this.rejectAdditionalSamples(parts, lineNumber);
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

    const sampleFilterIndex = parts[8]?.split(":").indexOf("FT") ?? -1;
    const sampleFilter = sampleFilterIndex >= 0 ? parts[9]?.split(":")[sampleFilterIndex] : undefined;
    if (this.hasFailedQualityFilter(parts[6]) || this.hasFailedQualityFilter(sampleFilter)) {
      this.skipRecord(
        state,
        "calls failed a VCF site (FILTER) or sample (FT) quality filter and were excluded from analysis.",
      );
      return;
    }

    const [chromosome, position, id, ref, alt] = parts;
    // Reference blocks describe an interval, not one variant. Do not manufacture
    // a call at their first base, even when a producer assigns the block an ID.
    const hasConcreteAlt = alt.split(",").some((allele) => /^[ACGT]+$/i.test(allele));
    const referenceBlock = !hasConcreteAlt && /^(?:<NON_REF>|<\*>|\.)(?:,(?:<NON_REF>|<\*>))*$/i.test(alt);
    const blockLengthIndex = referenceBlock ? parts[8]?.split(":").indexOf("LEN") : -1;
    const blockLength =
      blockLengthIndex !== undefined && blockLengthIndex >= 0 ? Number(parts[9]?.split(":")[blockLengthIndex]) : 0;
    if (
      referenceBlock &&
      (id === "." || blockLength > 1 || Number(/(?:^|;)END=(\d+)(?:;|$)/.exec(parts[7])?.[1]) > Number(position))
    ) {
      this.skipRecord(state, "reference blocks were skipped; they do not identify a concrete alternate allele.");
      return;
    }
    if (!hasConcreteAlt && !referenceBlock) {
      this.skipRecord(
        state,
        "calls used symbolic, breakend, spanning-deletion, or ambiguous alleles without an exact sequence.",
      );
      return;
    }
    const rsid = this.variantId(id, chromosome, position, ref, alt, state.fileMetadata.assembly);

    if (!rsid) {
      this.skipRecord(
        state,
        "records lacked a supported identifier or explicit genome build and concrete sequence coordinates.",
      );
      return;
    }

    if (parts.length < 10 || parts[8] === undefined || parts[9] === undefined) {
      state.errors.push(`Line ${lineNumber}: VCF record for ${rsid} does not include FORMAT and sample columns`);
      state.skippedLines++;
      return;
    }

    const genotype = this.parseSampleGenotype(ref ?? "", alt ?? "", parts[8], parts[9]);
    if (genotype.status === "unsupported") {
      this.skipRecord(state, genotype.reason);
      return;
    }

    if (genotype.status === "invalid") {
      state.errors.push(`Line ${lineNumber}: Could not convert GT field to allele sequences`);
      state.skippedLines++;
      return;
    }

    state.genotypes.push({
      rsid,
      chromosome: this.normalizeChromosome(chromosome ?? ""),
      position: position ?? "",
      genotype: genotype.genotype,
      ref: ref.toUpperCase(),
      ...(genotype.alt ? { alt: genotype.alt } : {}),
      strand: "plus",
      ...(genotype.phased !== undefined ? { phased: genotype.phased } : {}),
      ...(genotype.alleles ? { alleles: genotype.alleles } : {}),
    });
  }

  private skipRecord(state: VcfParseState, reason: string): void {
    state.skippedLines++;
    state.skippedRecords.set(reason, (state.skippedRecords.get(reason) ?? 0) + 1);
  }

  private splitColumns(line: string): string[] {
    const tabParts = line.split("\t");
    return tabParts.length > 1 ? tabParts : line.split(/\s+/);
  }

  private rejectAdditionalSamples(parts: string[], lineNumber: number): void {
    if (parts.length > 10) {
      throw new Error(
        `Line ${lineNumber}: This VCF contains multiple samples. Extract a single-sample VCF for the person you want to analyze and upload it again.`,
      );
    }
  }

  private hasFailedQualityFilter(filter: string | undefined): boolean {
    // Missing/unapplied filters do not establish failure. Numeric QUAL/GQ
    // thresholds are caller-specific and are not inferred by this importer.
    return (
      filter?.split(";").some((value) => {
        const flag = value.trim();
        return flag !== "" && flag !== "." && flag !== "PASS";
      }) ?? false
    );
  }

  private extractRsid(id: string): string | null {
    const match = id.match(/\b(?:rs|i)\d+\b/i);
    return match ? match[0].toLowerCase() : null;
  }

  private variantId(
    id: string,
    chromosome: string,
    position: string,
    ref: string,
    alt: string,
    assembly?: FileMetadata["assembly"],
  ): string | null {
    const rsid = this.extractRsid(id);
    if (rsid) return rsid;
    if (!assembly || !/^[ACGT]+$/i.test(ref)) return null;
    const normalizedChromosome =
      normalizeChromosome(chromosome) ?? (VCF_CONTIG.test(chromosome) ? encodeURIComponent(chromosome) : undefined);
    const normalizedPosition = normalizePosition(position);
    // Preserve VCF padding and full allele sequences. Equivalent representations
    // at a different position are not silently normalized without a reference genome.
    const alternates = [
      ...new Set(
        alt
          .toUpperCase()
          .split(",")
          .filter((allele) => /^[ACGT]+$/.test(allele)),
      ),
    ].sort();
    if (!normalizedChromosome || !normalizedPosition || !alternates.length) return null;
    return `${assembly}:${normalizedChromosome}:${normalizedPosition}:${ref.toUpperCase()}:${alternates.join(",")}`;
  }

  private normalizeChromosome(chromosome: string): string {
    // Preserve noncanonical contig names exactly. The annotation matcher only
    // accepts canonical chromosomes, while the raw import still retains calls.
    return normalizeChromosome(chromosome) ?? chromosome;
  }

  private parseSampleGenotype(ref: string, alt: string, format: string, sample: string): VcfGenotypeParseResult {
    if (!/^[ACGT]+$/i.test(ref))
      return { status: "unsupported", reason: "records had an ambiguous or unsupported reference sequence." };
    const formatFields = format.split(":");
    const sampleFields = sample.split(":");
    const genotypeIndex = formatFields.indexOf("GT");
    if (genotypeIndex < 0) return { status: "unsupported", reason: "records did not contain a GT sample genotype." };
    const genotypeField = sampleFields[genotypeIndex];

    if (!genotypeField || !/^[|/]?(?:\d+|\.)(?:[|/](?:\d+|\.))*$/.test(genotypeField)) return { status: "invalid" };

    const alleleIndexes = genotypeField.replace(/^[|/]/, "").split(/[/|]/);

    if (alleleIndexes.some((alleleIndex) => alleleIndex === ".")) {
      return { status: "called", genotype: "--" };
    }

    const alleles = [ref, ...alt.split(",")];
    const genotypeBases: string[] = [];

    for (const alleleIndex of alleleIndexes) {
      const allele = alleles[Number(alleleIndex)]?.toLowerCase();
      if (!allele) return { status: "invalid" };
      if (!/^[acgt]+$/.test(allele)) {
        return {
          status: "unsupported",
          reason: "calls used symbolic, breakend, spanning-deletion, or ambiguous alleles without an exact sequence.",
        };
      }

      genotypeBases.push(allele);
    }

    const calledAlternates = [
      ...new Set(
        alleleIndexes.filter((index) => Number(index) > 0).map((index) => alleles[Number(index)].toUpperCase()),
      ),
    ];
    const explicitAlleles =
      ref.length > 1 || genotypeBases.some((allele) => allele.length > 1) || genotypeBases.length > 2;
    return {
      status: "called",
      genotype: explicitAlleles
        ? genotypeField.replace(/\d+/g, (index) => alleles[Number(index)].toLowerCase())
        : this.normalizeGenotypeOrder(genotypeBases),
      ...(explicitAlleles ? { alleles: genotypeBases.map((allele) => allele.toUpperCase()) } : {}),
      ...(calledAlternates.length ? { alt: calledAlternates.sort().join(",") } : {}),
      ...(alleleIndexes.length > 1 ? { phased: genotypeField.includes("|") && !genotypeField.includes("/") } : {}),
    };
  }

  private normalizeGenotypeOrder(alleles: string[]): string {
    return alleles.sort((a, b) => BASE_ORDER[a] - BASE_ORDER[b]).join("");
  }
}

/**
 * Default export for convenience
 */
export default new ParserVCF();
