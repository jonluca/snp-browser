import type { GenomeAssembly } from "../types/annotations";
import type { ParseResult, UserGenotype } from "../types/snp";
import { normalizeAssembly } from "../utils/variantIdentity";

export interface FileMetadata {
  assembly?: GenomeAssembly;
  strand?: UserGenotype["strand"];
  mitochondrialReference?: UserGenotype["mitochondrialReference"];
}

/** Reads explicit declarations only; a provider name never supplies a default. */
export function detectFileMetadata(content: string, vcf = false): FileMetadata {
  const assemblies = new Set<GenomeAssembly | "unsupported">();
  const strands = new Set<"plus" | "minus">();
  let hasHg19 = false;
  let hasRcrs = false;
  let hasOtherMitochondrialReference = false;
  let offset = 0;
  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    const line = content.slice(offset, newline < 0 ? undefined : newline).trim();
    offset = newline < 0 ? content.length : newline + 1;
    if (!line) continue;
    if (!line.startsWith("#")) break;

    // VCF ##assembly identifies breakpoint assemblies, not the genome build.
    // Arbitrary INFO descriptions and command lines are not build declarations.
    let declaration = line;
    if (vcf) {
      if (/^##reference=/i.test(line)) declaration = line.slice(line.indexOf("=") + 1);
      else if (/^##contig=/i.test(line)) {
        declaration = /(?:^|[,<])assembly=([^,>]+)/i.exec(line)?.[1] ?? "";
      } else continue;
    }
    hasHg19 ||= /\bhg19\b/i.test(declaration);
    // Inspect the complete trusted declaration to retain mitochondrial contig accessions.
    hasRcrs ||= /\b(?:rCRS|NC_012920(?:\.1)?)\b/i.test(line);
    hasOtherMitochondrialReference ||= /\b(?:RSRS|NC_001807(?:\.4)?)\b/i.test(line);
    const assemblyNames = declaration.matchAll(
      /(?<![a-z0-9])(?:GRCh\s*\d+(?:\.p\d+)?|hg\d+|(?:NCBI\s*)?build\s*[:=]?\s*\d+|NCBI\s*\d+|b3[78])(?=$|[^a-z0-9])/gi,
    );
    for (const match of assemblyNames) assemblies.add(normalizeAssembly(match[0]) ?? "unsupported");

    if (!vcf) {
      if (
        /\b(?:plus|forward|positive)\s*\(?\+?\)?\s*strand\b|\bstrand\s*[:=]\s*(?:plus|forward|positive|\+)(?:\s|$)/i.test(
          line,
        )
      )
        strands.add("plus");
      if (
        /\b(?:minus|reverse|negative)\s*\(?-?\)?\s*strand\b|\bstrand\s*[:=]\s*(?:minus|reverse|negative|-)(?:\s|$)/i.test(
          line,
        )
      )
        strands.add("minus");
    }
  }
  const assembly = assemblies.size === 1 ? [...assemblies][0] : undefined;
  return {
    ...(assembly && assembly !== "unsupported" ? { assembly } : {}),
    ...(strands.size === 1 ? { strand: [...strands][0] } : {}),
    ...(hasOtherMitochondrialReference || (assembly === "GRCh37" && hasHg19 && !hasRcrs)
      ? { mitochondrialReference: "unsupported" as const }
      : hasRcrs
        ? { mitochondrialReference: "rCRS" as const }
        : {}),
  };
}

/** Applies metadata to freshly parsed records without copying a whole genome. */
export function applyFileMetadata(result: ParseResult, metadata: FileMetadata): ParseResult {
  if (!metadata.assembly && !metadata.strand && !metadata.mitochondrialReference) return result;
  if (metadata.assembly) result.assembly = metadata.assembly;
  for (const genotype of result.genotypes) {
    if (metadata.assembly) genotype.assembly = metadata.assembly;
    if (metadata.strand) genotype.strand = metadata.strand;
    if (metadata.mitochondrialReference) genotype.mitochondrialReference = metadata.mitochondrialReference;
  }
  return result;
}
