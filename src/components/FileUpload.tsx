import { useState, useCallback, type DragEvent, type ChangeEvent } from "react";
import { twMerge } from "tailwind-merge";
import { getSupportedExtensions, getAllParsers } from "../parsers";

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  disabled?: boolean;
}

// Get supported file extensions and formats
const SUPPORTED_EXTENSIONS = Array.from(new Set([...getSupportedExtensions(), ".zip"])).join(",");
const SUPPORTED_FORMATS = getAllParsers();

export function FileUpload({ onFileSelect, disabled = false }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) {
        setIsDragging(true);
      }
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      if (disabled) return;

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        onFileSelect(files[0]);
      }
    },
    [disabled, onFileSelect],
  );

  const handleFileInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        onFileSelect(files[0]);
      }
    },
    [onFileSelect],
  );

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={twMerge(
        "surface-panel flex min-h-[29rem] flex-col justify-center border-2 border-dashed p-6 text-center transition-all duration-200 sm:p-10",
        isDragging
          ? "border-brand-500 bg-brand-50 shadow-[0_18px_48px_-24px_rgba(8,124,98,0.38)]"
          : "border-slate-200 bg-white/85",
        disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:border-brand-500 hover:bg-brand-50/40",
      )}
    >
      <input
        type="file"
        id="file-input"
        accept={SUPPORTED_EXTENSIONS}
        onChange={handleFileInput}
        disabled={disabled}
        aria-label="Select a DNA data file"
        className="hidden"
      />
      <label
        htmlFor="file-input"
        className={twMerge(
          "flex h-full flex-col items-center justify-center",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <div className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 ring-1 ring-brand-100">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-8 fill-none stroke-current" strokeWidth="1.7">
            <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-2" strokeLinecap="round" />
          </svg>
        </div>
        <div className="mb-2 text-xl font-semibold tracking-tight text-slate-900">
          {isDragging ? "Release to analyze your file" : "Drop in your DNA data file"}
        </div>
        <div className="max-w-sm text-sm leading-6 text-slate-500">
          Your file is read locally on this device and matched against the SNPedia reference database.
        </div>
        <span
          className={twMerge(
            "mt-6 rounded-xl px-5 py-2.5 text-sm font-semibold",
            disabled ? "bg-slate-100 text-slate-400" : "bg-brand-600 text-white shadow-sm",
          )}
        >
          {disabled ? "Getting ready..." : "Choose a file"}
        </span>
        <div className="mt-7 w-full max-w-lg border-t border-slate-100 pt-5 text-xs text-slate-500">
          <div className="mb-3 font-semibold uppercase tracking-[0.14em] text-slate-400">Supported formats</div>
          <div className="flex flex-wrap justify-center gap-2">
            {SUPPORTED_FORMATS.map((parser) => (
              <span
                key={parser.metadata.id}
                className="rounded-full bg-slate-100 px-3 py-1.5 font-medium text-slate-600"
              >
                {parser.metadata.name}
              </span>
            ))}
            <span className="rounded-full bg-slate-100 px-3 py-1.5 font-medium text-slate-600">ZIP archives</span>
          </div>
          <div className="mt-4 text-slate-400">TXT, CSV, VCF, gVCF and compressed exports auto-detected</div>
        </div>
      </label>
    </div>
  );
}
