import type { ParseResult } from "../types/snp";
import type { ImportProgress } from "../types/progress";
import { parserRegistry, parserVCF } from "../parsers";

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_STORED_METHOD = 0;
const ZIP_DEFLATE_METHOD = 8;

interface ZipEntry {
  filename: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function parsingProgress(
  unit: ImportProgress["unit"],
  onProgress: (current: number, total: number) => void,
  onStatus?: (progress: ImportProgress) => void,
): (current: number, total: number) => void {
  onStatus?.({ stage: "parsing", unit });
  return (current, total) => {
    // PDF.js has not opened the document when the PDF parser reports (0, 1).
    // Keep that legacy callback intact, but do not present 1 as a known page count.
    onStatus?.(
      unit === "pages" && current === 0 ? { stage: "parsing", unit } : { stage: "parsing", current, total, unit },
    );
    onProgress(current, total);
  };
}

/**
 * Parse file using appropriate parser based on format detection or specified parser ID
 */
export async function parseFileWithDetection(
  fileContent: string,
  onProgress: (current: number, total: number) => void,
  parserId?: string,
  onStatus?: (progress: ImportProgress) => void,
): Promise<ParseResult & { detectedFormat?: string }> {
  let parser;
  onStatus?.({ stage: "detecting" });

  // If parser ID is specified, use that parser
  if (parserId) {
    parser = parserRegistry.get(parserId);
    if (!parser) {
      throw new Error(
        `Parser "${parserId}" not found. Available parsers: ${parserRegistry
          .getAll()
          .map((p) => p.metadata.id)
          .join(", ")}`,
      );
    }
  } else {
    // Auto-detect format
    const detection = parserRegistry.detectFormat(fileContent);

    if (!detection.parser) {
      const availableParsers = parserRegistry
        .getAll()
        .map((p) => p.metadata.name)
        .join(", ");
      throw new Error(
        `Could not detect file format. Supported formats: ${availableParsers}. ` +
          "Please ensure your file is from a supported DNA testing provider.",
      );
    }

    parser = detection.parser;

    // Warn if detection confidence is low
    if (!detection.confident && detection.candidates.length > 1) {
      console.warn(
        `Format detection confidence is low. Detected as ${parser.metadata.name} with ${Math.round(detection.candidates[0].validation.confidence * 100)}% confidence. ` +
          `Other candidates: ${detection.candidates
            .slice(1)
            .map((c) => `${c.parser.metadata.name} (${Math.round(c.validation.confidence * 100)}%)`)
            .join(", ")}`,
      );
    }
  }

  // Parse using detected or specified parser
  const unit = parser.metadata.id === "promethease" ? "characters" : "lines";
  const result = await parser.parse(fileContent, parsingProgress(unit, onProgress, onStatus));
  // Omitted metadata is unknown for an imported file. The low-level matcher
  // still accepts older callers without metadata, so make this explicit here
  // before any app import can reach genotype-specific interpretation.
  for (const call of result.genotypes) {
    if (call.strand === undefined) call.strand = "unknown";
  }
  // Some raw parsers skip their final callback when the last line is blank.
  // Only fill in that terminal count after parsing and normalization finish.
  const total = unit === "characters" ? fileContent.length : result.totalLines;
  onStatus?.({ stage: "parsing", current: total, total, unit });

  return {
    ...result,
    detectedFormat: parser.metadata.id,
  };
}

function isVcfLikeFilename(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  return (
    lowerFilename.endsWith(".vcf") ||
    lowerFilename.endsWith(".gvcf") ||
    lowerFilename.endsWith(".g.vcf") ||
    lowerFilename.endsWith(".vcf.gz") ||
    lowerFilename.endsWith(".g.vcf.gz") ||
    (lowerFilename.endsWith(".gz") && lowerFilename.includes("vcf"))
  );
}

function isZipFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".zip");
}

function isSupportedArchiveEntry(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  if (lowerFilename.endsWith(".zip")) return false;
  if (isVcfLikeFilename(lowerFilename) || lowerFilename.endsWith(".pdf")) return true;

  return parserRegistry.getSupportedExtensions().some((extension) => lowerFilename.endsWith(extension));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readZipEntries(buffer: ArrayBuffer): ZipEntry[] {
  const data = new DataView(buffer);
  const maxCommentLength = 0xffff;
  const minEndRecordSize = 22;
  const searchStart = Math.max(0, data.byteLength - minEndRecordSize - maxCommentLength);
  let endRecordOffset = -1;

  for (let offset = data.byteLength - minEndRecordSize; offset >= searchStart; offset--) {
    if (data.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      endRecordOffset = offset;
      break;
    }
  }

  if (endRecordOffset < 0) {
    throw new Error("Could not read ZIP archive directory.");
  }

  const entryCount = data.getUint16(endRecordOffset + 10, true);
  let centralDirectoryOffset = data.getUint32(endRecordOffset + 16, true);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index++) {
    if (data.getUint32(centralDirectoryOffset, true) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("ZIP archive directory is invalid.");
    }

    const compressionMethod = data.getUint16(centralDirectoryOffset + 10, true);
    const compressedSize = data.getUint32(centralDirectoryOffset + 20, true);
    const filenameLength = data.getUint16(centralDirectoryOffset + 28, true);
    const extraLength = data.getUint16(centralDirectoryOffset + 30, true);
    const commentLength = data.getUint16(centralDirectoryOffset + 32, true);
    const localHeaderOffset = data.getUint32(centralDirectoryOffset + 42, true);
    const filenameStart = centralDirectoryOffset + 46;
    const filenameBytes = new Uint8Array(buffer, filenameStart, filenameLength);
    const filename = new TextDecoder().decode(filenameBytes);

    if (!filename.endsWith("/")) {
      entries.push({
        filename,
        compressionMethod,
        compressedSize,
        localHeaderOffset,
      });
    }

    centralDirectoryOffset = filenameStart + filenameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflateRaw(compressedData: Uint8Array): Promise<Uint8Array> {
  if (!("DecompressionStream" in globalThis)) {
    throw new Error("Compressed ZIP entries are not supported in this browser.");
  }

  const stream = new Blob([bytesToArrayBuffer(compressedData)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(buffer: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const data = new DataView(buffer);
  if (data.getUint32(entry.localHeaderOffset, true) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`ZIP entry "${entry.filename}" has an invalid local header.`);
  }

  const filenameLength = data.getUint16(entry.localHeaderOffset + 26, true);
  const extraLength = data.getUint16(entry.localHeaderOffset + 28, true);
  const dataStart = entry.localHeaderOffset + 30 + filenameLength + extraLength;
  const compressedData = new Uint8Array(buffer, dataStart, entry.compressedSize);

  if (entry.compressionMethod === ZIP_STORED_METHOD) {
    return compressedData;
  }

  if (entry.compressionMethod === ZIP_DEFLATE_METHOD) {
    return inflateRaw(compressedData);
  }

  throw new Error(`ZIP entry "${entry.filename}" uses unsupported compression method ${entry.compressionMethod}.`);
}

async function archiveDetectionContent(file: File): Promise<string> {
  if (file.name.toLowerCase().endsWith(".gz")) {
    return parserVCF.readDetectionPrefix(file);
  }
  // Promethease stores its data after the presentation scripts, which can be
  // much longer than the header of a raw genotype export.
  if (/\.html?$/i.test(file.name)) return file.text();
  return file.slice(0, 256 * 1024).text();
}

async function extractSupportedFileFromZip(
  file: File,
  parserId?: string,
  onStatus?: (progress: ImportProgress) => void,
): Promise<File> {
  onStatus?.({ stage: "reading" });
  const buffer = await file.arrayBuffer();
  onStatus?.({ stage: "extracting" });
  const entries = readZipEntries(buffer).filter(
    (candidate) =>
      isSupportedArchiveEntry(candidate.filename) &&
      !candidate.filename.split("/").some((part) => part.startsWith(".") || part === "__MACOSX"),
  );
  let selected: File | undefined;
  const selectedParser = parserId ? parserRegistry.get(parserId) : undefined;
  const fallback: File[] = [];
  for (const entry of entries) {
    onStatus?.({ stage: "extracting" });
    const entryBytes = await readZipEntry(buffer, entry);
    const candidate = new File([bytesToArrayBuffer(entryBytes)], entry.filename);
    onStatus?.({ stage: "detecting" });
    const content = await archiveDetectionContent(candidate);
    const isPdf = content.startsWith("%PDF-");
    const isVcf =
      (isVcfLikeFilename(candidate.name) || candidate.name.toLowerCase().endsWith(".gz")) &&
      /^##fileformat=VCFv[34]\./i.test(content);
    const recognized = parserId
      ? parserId === "pdf"
        ? isPdf
        : (parserId === parserVCF.metadata.id && isVcf) || selectedParser?.validate(content).valid
      : isPdf || isVcf || Boolean(parserRegistry.detectFormat(content).parser);
    if (recognized) {
      if (selected) {
        throw new Error(
          "The ZIP archive contains multiple supported DNA files or reports. Extract it and select the file you want to analyze.",
        );
      }
      selected = candidate;
    } else if (
      selectedParser?.metadata.fileExtensions.some((extension) => entry.filename.toLowerCase().endsWith(extension))
    ) {
      // Manual provider selection intentionally supports headerless raw files,
      // but README files must not win simply by appearing first in an archive.
      const rawRows = content
        .split("\n")
        .slice(0, 100)
        .some((line) => /^\s*["']?(?:rs|i)\d+["']?[,\t ]+.+[,\t ]+["']?\d+["']?[,\t ]+["']?[ACGTID-]/i.test(line));
      if (rawRows) fallback.push(candidate);
    }
  }
  if (selected) return selected;
  if (fallback.length === 1) return fallback[0];
  if (fallback.length > 1)
    throw new Error("The ZIP archive contains multiple possible DNA data files. Extract it and select one file.");
  throw new Error("No supported DNA data file or report was found inside the ZIP archive.");
}

export async function parseFileBlobWithDetection(
  file: File,
  onProgress: (current: number, total: number) => void,
  parserId?: string,
  onStatus?: (progress: ImportProgress) => void,
): Promise<ParseResult & { detectedFormat?: string }> {
  if (isZipFilename(file.name)) {
    return parseFileBlobWithDetection(
      await extractSupportedFileFromZip(file, parserId, onStatus),
      onProgress,
      parserId,
      onStatus,
    );
  }

  onStatus?.({ stage: "reading" });
  if (
    parserId === "pdf" ||
    (!parserId && (file.name.toLowerCase().endsWith(".pdf") || (await file.slice(0, 5).text()) === "%PDF-"))
  ) {
    const { parsePdfReport } = await import("../parsers/pdf");
    return {
      ...(await parsePdfReport(file, parsingProgress("pages", onProgress, onStatus))),
      detectedFormat: "pdf",
    };
  }

  onStatus?.({ stage: "detecting" });
  const genericGzipVcf =
    !parserId &&
    !isVcfLikeFilename(file.name) &&
    file.name.toLowerCase().endsWith(".gz") &&
    /^##fileformat=VCFv[34]\./i.test(await parserVCF.readDetectionPrefix(file));
  if (parserId === parserVCF.metadata.id || (!parserId && (isVcfLikeFilename(file.name) || genericGzipVcf))) {
    const result = await parserVCF.parseBlob(file, parsingProgress("bytes", onProgress, onStatus));
    return {
      ...result,
      detectedFormat: parserVCF.metadata.id,
    };
  }

  onStatus?.({ stage: "reading" });
  return parseFileWithDetection(await file.text(), onProgress, parserId, onStatus);
}
