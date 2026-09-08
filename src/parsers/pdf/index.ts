import type { PDFDocumentLoadingTask, PDFWorker } from "pdfjs-dist";
import type { ParseResult } from "../../types/snp";
import type { ProgressCallback } from "../types";

// Text extraction never needs document links, JavaScript actions, images, or
// remotely fetched fonts/CMaps. Refuse auxiliary resources rather than sending
// anything derived from a report to a resource host.
class LocalPdfResources {
  async fetch(): Promise<never> {
    throw new Error("This PDF requires an additional font or character map for text extraction.");
  }
}

function reportError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  const name = error && typeof error === "object" && "name" in error ? error.name : "";
  if (name === "PasswordException") {
    return new Error("This PDF is password-protected. Unlock it locally and upload an unencrypted copy.");
  }
  if (name === "InvalidPDFException") {
    return new Error("This file is not a readable PDF. Export the original report as a PDF and try again.");
  }
  return new Error("Unable to extract this PDF's text. Try a fresh PDF export or a text-searchable copy.");
}

/** Imports report text only. Mentions of variants in a report are not raw calls. */
export async function parsePdfReport(
  file: Blob & { name?: string },
  onProgress: ProgressCallback,
): Promise<ParseResult> {
  if (!file.size) throw new Error("This PDF is empty. Choose a PDF containing your report.");
  onProgress(0, 1);
  let task: PDFDocumentLoadingTask | undefined;
  let pdfWorker: PDFWorker | undefined;
  let nativeWorker: Worker | undefined;
  let failedWorker: Promise<never> | undefined;
  try {
    const pdfjs = await import("pdfjs-dist");
    const data = new Uint8Array(await file.arrayBuffer());
    if (typeof Worker !== "undefined") {
      const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      nativeWorker = new Worker(workerUrl, { type: "module", name: "local-pdf-report" });
      failedWorker = new Promise<never>((_, reject) => {
        nativeWorker!.addEventListener("error", () => reject(new Error("The local PDF parser could not start.")), {
          once: true,
        });
      });
      // Attach a handler during setup as well as each document operation.
      void failedWorker.catch(() => undefined);
      // Explicit ports avoid PDF.js's window.location-based worker bootstrap
      // when this parser itself runs inside the application's dedicated worker.
      pdfWorker = pdfjs.PDFWorker.create({ port: nativeWorker, verbosity: 0 });
    }
    task = pdfjs.getDocument({
      data,
      worker: pdfWorker,
      useWorkerFetch: false,
      BinaryDataFactory: LocalPdfResources,
      useSystemFonts: true,
      disableFontFace: true,
      enableXfa: false,
      useWasm: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      stopAtErrors: true,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      verbosity: 0,
    });
    const guarded = <T>(operation: Promise<T>): Promise<T> =>
      failedWorker ? Promise.race([operation, failedWorker]) : operation;
    const document = await guarded(task.promise);
    const pages: { page: number; text: string }[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await guarded(document.getPage(pageNumber));
      try {
        const content = await guarded(page.getTextContent({ disableNormalization: true }));
        let text = "";
        for (const item of content.items) {
          if (!("str" in item)) continue;
          text += item.str;
          text += item.hasEOL ? "\n" : " ";
        }
        pages.push({ page: pageNumber, text: text.trim() });
      } finally {
        page.cleanup();
      }
      onProgress(pageNumber, document.numPages);
    }
    const emptyPages = pages.filter((page) => !page.text).length;
    if (emptyPages === pages.length) {
      return {
        genotypes: [],
        totalLines: 0,
        skippedLines: 0,
        errors: [
          "This PDF has no extractable text. It may be scanned or image-only. Run OCR locally and upload a text-searchable copy.",
        ],
      };
    }
    return {
      genotypes: [],
      totalLines: pages.reduce((sum, page) => sum + (page.text ? page.text.split("\n").length : 0), 0),
      skippedLines: 0,
      errors: [],
      report: {
        format: "pdf",
        title: file.name?.replace(/\.pdf$/i, "") || "PDF report",
        pages,
        notes: [
          "This view preserves extracted report text; it does not create raw genotype calls or reinterpret the findings.",
          "PDF text order and spacing can differ from the original layout. Images, charts, and handwritten content are not transcribed.",
          ...(emptyPages
            ? [
                `${emptyPages} ${emptyPages === 1 ? "page has" : "pages have"} no extractable text and may contain only images.`,
              ]
            : []),
        ],
      },
    };
  } catch (error) {
    throw reportError(error);
  } finally {
    const cleanup = task?.destroy().catch(() => undefined);
    // A crashed worker cannot acknowledge teardown. Do not leave the import
    // hung forever waiting for a dead port to finish its setup/cleanup request.
    if (failedWorker) await Promise.race([cleanup, failedWorker.catch(() => undefined)]);
    else await cleanup;
    pdfWorker?.destroy();
    nativeWorker?.terminate();
  }
}
