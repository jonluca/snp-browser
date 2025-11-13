import { useState, useCallback, type DragEvent, type ChangeEvent } from "react";

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  disabled?: boolean;
}

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
      className={`
        rounded-lg border-2 border-dashed p-10 text-center transition-all duration-200
        ${isDragging ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-gray-50"}
        ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-blue-400"}
      `}
    >
      <input
        type="file"
        id="file-input"
        accept=".txt,.csv"
        onChange={handleFileInput}
        disabled={disabled}
        className="hidden"
      />
      <label htmlFor="file-input" className={`block ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
        <div className="mb-4 text-5xl">📁</div>
        <div className="mb-2 text-lg font-bold text-gray-800">
          {isDragging ? "Drop your file here" : "Drag & drop your 23andMe file"}
        </div>
        <div className="text-sm text-gray-600">or click to browse</div>
        <div className="mt-2 text-xs text-gray-500">Accepts .txt or .csv files from 23andMe</div>
      </label>
    </div>
  );
}
