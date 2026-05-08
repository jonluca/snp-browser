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
        "rounded-lg border-2 border-dashed p-10 text-center transition-all duration-200",
        isDragging ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-gray-50",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-blue-400",
      )}
    >
      <input
        type="file"
        id="file-input"
        accept={SUPPORTED_EXTENSIONS}
        onChange={handleFileInput}
        disabled={disabled}
        className="hidden"
      />
      <label htmlFor="file-input" className={twMerge("block", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
        <div className="mb-4 text-5xl">📁</div>
        <div className="mb-2 text-lg font-bold text-gray-800">
          {isDragging ? "Drop your DNA file here" : "Drag & drop your DNA data file"}
        </div>
        <div className="text-sm text-gray-600">or click to browse</div>
        <div className="mt-4 text-xs text-gray-500">
          <div className="mb-2 font-semibold">Supported formats:</div>
          <div className="space-y-1">
            {SUPPORTED_FORMATS.map((parser) => (
              <div key={parser.metadata.id}>
                <span className="font-medium">{parser.metadata.name}</span> ({parser.metadata.fileExtensions.join(", ")}
                )
              </div>
            ))}
          </div>
          <div className="mt-2 text-gray-400">Format will be auto-detected</div>
        </div>
      </label>
    </div>
  );
}
