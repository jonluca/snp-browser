import { useState, useCallback, useRef, useId, type DragEvent, type ChangeEvent } from "react";
import { twMerge } from "tailwind-merge";
import { getSupportedExtensions, getAllParsers } from "../parsers";

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  disabled?: boolean;
}

const SUPPORTED_EXTENSIONS = Array.from(new Set([...getSupportedExtensions(), ".zip", ".pdf"])).join(",");
const SUPPORTED_FORMATS = getAllParsers();

export function FileUpload({ onFileSelect, disabled = false }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const dragDepthRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const selectFiles = useCallback(
    (files: File[]) => {
      if (disabled || files.length === 0) return;
      if (files.length > 1) {
        setSelectionError("Choose one DNA file at a time. A ZIP archive can be selected as a single file.");
        return;
      }
      if (files[0].size === 0) {
        setSelectionError("This file is empty. Choose a DNA export that contains genotype data.");
        return;
      }
      setSelectionError(null);
      onFileSelect(files[0]);
    },
    [disabled, onFileSelect],
  );

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (disabled || !event.dataTransfer.types.includes("Files")) return;
      dragDepthRef.current += 1;
      setIsDragging(true);
    },
    [disabled],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    },
    [disabled],
  );

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      setIsDragging(false);
      selectFiles(Array.from(event.dataTransfer.files));
    },
    [selectFiles],
  );

  const handleFileInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      // Reset the native input so the same file can be selected after a failed attempt.
      event.currentTarget.value = "";
      selectFiles(files);
    },
    [selectFiles],
  );

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={twMerge(
        "surface-panel overflow-hidden transition-colors duration-150",
        isDragging && !disabled ? "border-brand-500 bg-brand-50 ring-4 ring-brand-100" : "border-slate-200 bg-white",
      )}
    >
      <div className="flex min-h-[310px] flex-col items-center justify-center px-6 py-9 text-center sm:min-h-[330px] sm:p-10">
        <input
          ref={inputRef}
          type="file"
          id={inputId}
          accept={SUPPORTED_EXTENSIONS}
          onChange={handleFileInput}
          disabled={disabled}
          aria-label="Select a DNA data file"
          className="hidden"
        />
        <div
          className={twMerge(
            "mb-6 flex size-14 items-center justify-center rounded-xl border text-brand-700 transition-colors",
            isDragging ? "border-brand-500 bg-white" : "border-brand-100 bg-brand-50",
          )}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-7 fill-none stroke-current" strokeWidth="1.5">
            <path
              d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-950">
          {isDragging && !disabled ? "Release to start your analysis" : "Start with your DNA file"}
        </h2>
        <p id={`${inputId}-description`} className="mt-2 max-w-xs text-sm leading-6 text-slate-500">
          Drag and drop a DNA export or report here, or choose a file from your device.
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          aria-describedby={`${inputId}-description`}
          className="primary-button mt-6 inline-flex min-w-36 items-center justify-center gap-2"
        >
          {disabled ? "Getting ready…" : "Choose a file"}
          {!disabled && <span aria-hidden="true">↑</span>}
        </button>
        <p className="mt-3 text-[11px] text-slate-400">Automatic format detection · One file at a time</p>
        {selectionError && (
          <p role="alert" className="mt-4 max-w-sm rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
            {selectionError}
          </p>
        )}
      </div>
      <div className="border-t border-slate-100 bg-slate-50/60 px-5 py-5 sm:px-7">
        <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          Compatible with your provider
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {SUPPORTED_FORMATS.map((parser) => (
            <span key={parser.metadata.id} className="text-xs font-medium text-slate-600">
              {parser.metadata.name}
            </span>
          ))}
        </div>
        <p className="mt-3 border-t border-slate-200/70 pt-3 text-[11px] leading-5 text-slate-400">
          TXT, CSV, VCF, gVCF, GZIP, ZIP, Promethease HTML & PDF reports
        </p>
      </div>
    </div>
  );
}
