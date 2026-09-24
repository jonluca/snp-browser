import type { UserGenotype } from "../types/snp";
import { normalizeAssembly, normalizeChromosome, normalizePosition, normalizeRsid } from "./variantIdentity";

/** Compare calls without flattening explicit sequence-allele boundaries. */
export function callSignature(user: UserGenotype): string {
  const complements: Record<string, string> = { A: "T", T: "A", C: "G", G: "C" };
  const orient = (value: string) =>
    value
      .toUpperCase()
      .split("")
      .map((base) => (user.strand === "minus" ? (complements[base] ?? base) : base))
      .join("");
  return JSON.stringify([
    normalizeAssembly(user.assembly),
    normalizeChromosome(user.chromosome),
    normalizePosition(user.position),
    user.alleles
      ? user.alleles.map((allele) => orient(allele)).sort()
      : /[/|]/.test(user.genotype)
        ? user.genotype.split(/[/|]/).map(orient).sort()
        : orient(user.genotype).split("").sort().join(""),
    user.ref ? orient(user.ref) : undefined,
    user.alleles && user.strand === "minus"
      ? "minus"
      : user.strand === "plus" || user.strand === "minus"
        ? "plus"
        : "unknown",
  ]);
}

export type IndexedUsers = UserGenotype | UserGenotype[];

export function indexUser(index: Map<string, IndexedUsers>, key: string, user: UserGenotype): void {
  const existing = index.get(key);
  if (!existing) index.set(key, user);
  else if (Array.isArray(existing)) existing.push(user);
  else index.set(key, [existing, user]);
}

export function ambiguousUsers(...indexes: Map<string, IndexedUsers>[]): Set<string> {
  const ambiguous = new Set<string>();
  for (const index of indexes) {
    for (const users of index.values()) {
      if (!Array.isArray(users)) continue;
      const signature = callSignature(users[0]);
      for (let position = 1; position < users.length; position++) {
        if (callSignature(users[position]) === signature) continue;
        for (const user of users) ambiguous.add(user.rsid.toLowerCase());
        break;
      }
    }
  }
  return ambiguous;
}

/** Conflict detection is an upload property, independent of reference coverage. */
export function ambiguousCallIds(calls: UserGenotype[]): Set<string> {
  const byId = new Map<string, IndexedUsers>();
  const byLocus = new Map<string, IndexedUsers>();
  for (const call of calls) {
    indexUser(byId, normalizeRsid(call.rsid) ?? call.rsid.trim().toLowerCase(), call);
    const assembly = normalizeAssembly(call.assembly);
    const chromosome = normalizeChromosome(call.chromosome);
    const position = normalizePosition(call.position);
    if (assembly && chromosome && position) indexUser(byLocus, `${assembly}:${chromosome}:${position}`, call);
  }
  return ambiguousUsers(byId, byLocus);
}
