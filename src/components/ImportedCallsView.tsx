import { useDeferredValue, useId, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import type { UserGenotype } from "../types/snp";
import { variantLabel } from "../utils/matchIdentity";

export function ImportedCallsView({ calls }: { calls: UserGenotype[] }) {
  const [query, setQuery] = useState("");
  const [sequenceOnly, setSequenceOnly] = useState(false);
  const searchId = useId();
  const search = useDeferredValue(query.trim().toLowerCase());
  const filtered = useMemo(() => {
    if (!search && !sequenceOnly) return calls;
    return calls.filter((call) => {
      if (sequenceOnly && !call.alleles) return false;
      return (
        !search ||
        call.rsid.toLowerCase().includes(search) ||
        call.genotype.toLowerCase().includes(search) ||
        `${call.chromosome}:${call.position}`.toLowerCase().includes(search)
      );
    });
  }, [calls, search, sequenceOnly]);

  return (
    <section className="surface-panel overflow-hidden" aria-label="Imported genotype calls">
      <div className="border-b border-slate-200 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-950">Imported calls</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Every retained call, including variants without a reference match.
            </p>
          </div>
          <div className="w-full sm:w-80">
            <label htmlFor={searchId} className="mb-2 block text-xs font-medium text-slate-600">
              Search imported calls
            </label>
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Variant ID, chromosome:position, or genotype"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
          <p role="status" className="tabular-nums">
            {filtered.length.toLocaleString()} of {calls.length.toLocaleString()} calls
          </p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={sequenceOnly} onChange={(event) => setSequenceOnly(event.target.checked)} />
            Insertions, deletions, and multi-base calls
          </label>
        </div>
      </div>
      {filtered.length ? (
        <Virtuoso
          style={{ height: 560 }}
          data={filtered}
          itemContent={(_, call) => (
            <article className="grid gap-3 border-b border-slate-100 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:px-6">
              <div className="min-w-0">
                <h3 title={call.rsid} className="break-all font-mono text-xs font-semibold text-slate-900">
                  {variantLabel(call)}
                </h3>
                <p className="mt-2 text-xs text-slate-500">
                  {call.chromosome && call.position
                    ? `Chromosome ${call.chromosome} · Position ${call.position}`
                    : "Coordinates not supplied"}
                  {" · "}
                  {call.assembly ?? "Genome build not declared"}
                </p>
              </div>
              <div className="min-w-0">
                <p className="break-all font-mono text-sm text-brand-800">
                  <span className="font-sans text-xs text-slate-500">Genotype </span>
                  {call.genotype.toUpperCase()}
                </p>
                {call.ref && (
                  <p className="mt-2 break-all font-mono text-xs text-slate-500">
                    REF {call.ref}
                    {call.alt ? ` · Called ALT ${call.alt}` : " · Reference call"}
                  </p>
                )}
              </div>
            </article>
          )}
        />
      ) : (
        <p className="px-5 py-14 text-center text-sm text-slate-500">No imported calls match these filters.</p>
      )}
    </section>
  );
}
