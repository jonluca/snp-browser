import type { ParseResult } from "../types/snp";
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

/**
 * Parse file using appropriate parser based on format detection or specified parser ID
 */
export async function parseFileWithDetection(
  fileContent: string,
  onProgress: (current: number, total: number) => void,
  parserId?: string,
): Promise<ParseResult & { detectedFormat?: string }> {
  let parser;

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
  const result = await parser.parse(fileContent, onProgress);

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
  if (isVcfLikeFilename(lowerFilename)) return true;

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

async function extractSupportedFileFromZip(file: File): Promise<File> {
  const buffer = await file.arrayBuffer();
  const entries = readZipEntries(buffer);
  const entry = entries.find((candidate) => isSupportedArchiveEntry(candidate.filename));

  if (!entry) {
    throw new Error("No supported DNA data file was found inside the ZIP archive.");
  }

  const entryBytes = await readZipEntry(buffer, entry);
  return new File([bytesToArrayBuffer(entryBytes)], entry.filename);
}

export async function parseFileBlobWithDetection(
  file: File,
  onProgress: (current: number, total: number) => void,
  parserId?: string,
): Promise<ParseResult & { detectedFormat?: string }> {
  if (isZipFilename(file.name)) {
    return parseFileBlobWithDetection(await extractSupportedFileFromZip(file), onProgress, parserId);
  }

  if (parserId === parserVCF.metadata.id || (!parserId && isVcfLikeFilename(file.name))) {
    const result = await parserVCF.parseBlob(file, onProgress);
    return {
      ...result,
      detectedFormat: parserVCF.metadata.id,
    };
  }

  return parseFileWithDetection(await file.text(), onProgress, parserId);
}
