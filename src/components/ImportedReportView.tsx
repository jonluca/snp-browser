import { useId, useState } from "react";
import type { ImportedReport } from "../types/snp";

export function ImportedReportView({ report }: { report: ImportedReport }) {
  const [query, setQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const searchId = useId();
  const needle = query.trim().toLocaleLowerCase();
  const pages = report.pages.filter((page) => !needle || page.text.toLocaleLowerCase().includes(needle));
  const currentIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
  const selectedPage = pages[currentIndex];

  return (
    <section className="surface-panel p-5 sm:p-7" aria-label="Imported source report">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="section-label mb-2">Source report</p>
          <h2 className="break-words text-xl font-semibold tracking-tight text-slate-950">{report.title}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Original report text, read on this device. These are the source provider’s findings.
          </p>
        </div>
        <div className="w-full sm:w-72">
          <label htmlFor={searchId} className="mb-2 block text-xs font-medium text-slate-600">
            Search report text
          </label>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPageIndex(0);
            }}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
            placeholder="Find a word or phrase"
          />
        </div>
      </div>
      {report.notes.length > 0 && (
        <ul className="mt-5 list-disc space-y-1 rounded-lg bg-slate-50 py-3 pl-8 pr-4 text-xs leading-6 text-slate-600">
          {report.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
      <div className="my-5 flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-xs tabular-nums text-slate-500">
          {pages.length.toLocaleString()} of {report.pages.length.toLocaleString()}{" "}
          {report.format === "pdf" ? "pages" : "sections"}
          {selectedPage && ` · Showing ${currentIndex + 1} of ${pages.length}`}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="secondary-button"
            disabled={currentIndex === 0}
            onClick={() => setPageIndex(currentIndex - 1)}
          >
            Previous
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={currentIndex >= pages.length - 1}
            onClick={() => setPageIndex(currentIndex + 1)}
          >
            Next
          </button>
        </div>
      </div>
      <div className="space-y-5">
        {(selectedPage ? [selectedPage] : []).map((page) => (
          <article key={page.page} className="rounded-xl border border-slate-200 p-4 sm:p-6">
            <h3 className="mb-4 text-xs font-semibold text-brand-700">
              {report.format === "pdf" ? "Page" : "Section"} {page.page}
            </h3>
            <div className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-700">{page.text}</div>
          </article>
        ))}
        {pages.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-500">No report text matches your search.</p>
        )}
      </div>
    </section>
  );
}
