import type { Database } from "sql.js";
import type { UserGenotype, MatchedSNP, ParsedSNPData } from "../types/snp";
import { extractSnpediaFields, type SnpediaSourceFields } from "../utils/snpediaFields";
import { userCallIdentity } from "../utils/matchIdentity";

type OptionalSnpColumn = "gene" | "gene_s" | "clin_gene_name" | "clin_sig" | "clin_disease";

function selectOptionalJoinedSnpColumn(
  column: OptionalSnpColumn,
  alias: string,
  snpsTableColumns: Set<string>,
): string {
  return snpsTableColumns.has(column) ? `s.${column} as ${alias}` : `NULL as ${alias}`;
}

function getGenotypeJoinColumns(snpsTableColumns: Set<string>): string {
  return [
    "g.id as genotype_id",
    "g.content as genotype_content",
    "g.scraped_at as genotype_scraped_at",
    "g.snp_id",
    "g.genotype",
    "s.rsid",
    "s.content as snp_content",
    "s.scraped_at as snp_scraped_at",
    selectOptionalJoinedSnpColumn("gene", "snp_gene", snpsTableColumns),
    selectOptionalJoinedSnpColumn("gene_s", "snp_gene_s", snpsTableColumns),
    selectOptionalJoinedSnpColumn("clin_gene_name", "snp_clin_gene_name", snpsTableColumns),
    selectOptionalJoinedSnpColumn("clin_sig", "snp_clin_sig", snpsTableColumns),
    selectOptionalJoinedSnpColumn("clin_disease", "snp_clin_disease", snpsTableColumns),
  ].join(",\n  ");
}

type Orientation = "plus" | "minus" | "unknown";

function parseOrientationFromContent(content: string): {
  orientation: Orientation;
  stabilizedOrientation: Orientation;
} {
  const orientationRegex = /\|\s*Orientation\s*=\s*([^|\n}]+)/i;
  const stabilizedOrientationRegex = /\|\s*StabilizedOrientation\s*=\s*([^|\n}]+)/i;

  const orientationMatch = content.match(orientationRegex);
  const stabilizedMatch = content.match(stabilizedOrientationRegex);

  const normalize = (val: string | undefined | null): Orientation => {
    if (!val) return "unknown";
    const v = val.trim().toLowerCase();
    if (v.startsWith("plus") || v === "+") return "plus";
    if (v.startsWith("minus") || v === "-") return "minus";
    return "unknown";
  };

  return {
    orientation: normalize(orientationMatch?.[1]),
    stabilizedOrientation: normalize(stabilizedMatch?.[1]),
  };
}

/**
 * Complement a genotype string (A<->T, C<->G), leaving other characters as-is.
 * Input is assumed lowercased.
 */
function complementGenotype(genotype: string): string {
  const map: Record<string, string> = {
    a: "t",
    t: "a",
    c: "g",
    g: "c",
  };

  return genotype
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("");
}

function normalizeGenotype(genotype: string): string {
  const normalized = genotype.replace(/[^a-z0-9-]/gi, "").toLowerCase();
  // A SNP's two unphased alleles have no meaningful order. Longer allele
  // sequences must retain their internal order.
  return normalized.length === 2 ? normalized.split("").sort().join("") : normalized;
}
/**
 * Parse content fields to extract structured data
 */
function parseContentData(
  rsid: string,
  snpContent: string,
  genotypeContent?: string,
  snpFields: SnpediaSourceFields = {},
): ParsedSNPData {
  const snpSnpediaFields = extractSnpediaFields(snpContent, snpFields);
  const genotypeSnpediaFields = genotypeContent ? extractSnpediaFields(genotypeContent) : {};
  const { orientation, stabilizedOrientation } = parseOrientationFromContent(snpContent);

  return {
    rsid,
    rawContent: snpContent,
    genotypeContent,
    geneSymbol: snpSnpediaFields.geneSymbol ?? genotypeSnpediaFields.geneSymbol,
    magnitude: genotypeSnpediaFields.magnitude ?? snpSnpediaFields.magnitude,
    repute: genotypeSnpediaFields.repute ?? snpSnpediaFields.repute,
    summary: genotypeSnpediaFields.summary ?? snpSnpediaFields.summary,
    orientation,
    stabilizedOrientation,
  };
}

/**
 * Matches SNPs in batches to avoid SQLite parameter limits
 */
export async function matchSNPsInBatches(
  database: Database,
  snpsTableColumns: Set<string>,
  genotypes: UserGenotype[],
  onProgress: (current: number, total: number) => void,
): Promise<MatchedSNP[]> {
  const matches: MatchedSNP[] = [];
  // Retain references to emitted matches instead of serializing large source
  // articles into deduplication keys. Different evidence is never collapsed.
  const emitted = new Map<string, MatchedSNP[]>();
  const batchSize = 500; // Stay well under SQLite's 999 parameter limit

  // create index on lowercase snp_id for faster lookups
  database.run(`CREATE INDEX IF NOT EXISTS idx_genotypes_snp_id_lower ON genotypes(lower(snp_id));`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_snps_rsid_nocase ON snps(rsid COLLATE NOCASE);`);

  for (let i = 0; i < genotypes.length; i += batchSize) {
    const batch = genotypes.slice(i, Math.min(i + batchSize, genotypes.length));
    const genotypesByRsid = new Map<string, UserGenotype[]>();
    const contextUsers = new Set(
      batch.filter(
        (user) =>
          user.strand === "unknown" || user.alleles || (user.ref?.length ?? 0) > 1 || /[/|]/.test(user.genotype),
      ),
    );
    for (const genotype of batch) {
      const rsid = genotype.rsid.toLowerCase();
      const candidates = genotypesByRsid.get(rsid) ?? [];
      candidates.push(genotype);
      genotypesByRsid.set(rsid, candidates);
    }
    const rsids = [...genotypesByRsid.keys()];

    // Create parameterized query - join genotypes with snps on snp_id
    const placeholders = rsids.map(() => "?").join(",");
    const query = `
      SELECT ${getGenotypeJoinColumns(snpsTableColumns)}
      FROM genotypes g
      INNER JOIN snps s ON g.snp_id = s.rsid COLLATE NOCASE
      WHERE lower(g.snp_id) IN (${placeholders})
    `;

    const stmt = database.prepare(query);
    try {
      stmt.bind(rsids);

      while (stmt.step()) {
        const row = stmt.getAsObject();
        const snp_id = row.snp_id as string;

        const rowGenotypeRaw = (row.genotype as string | null) ?? "";
        // SNPedia genotype, normalized for comparison
        const snpediaGenotype = normalizeGenotype(rowGenotypeRaw);
        if (!snpediaGenotype || snpediaGenotype === "--") continue;

        const snpContent = (row.snp_content as string) || "";
        const genotypeContent = (row.genotype_content as string) || "";

        // Determine orientation for this SNP
        const { orientation, stabilizedOrientation } = parseOrientationFromContent(snpContent);
        // Per SNPedia docs, StabilizedOrientation is what the genotype definitions use;
        // fall back to Orientation if needed.
        const effectiveOrientation: Orientation =
          stabilizedOrientation !== "unknown" ? stabilizedOrientation : orientation;

        // Preserve distinct calls even when they occur in the same batch.
        for (const userGenotype of genotypesByRsid.get(snp_id.toLowerCase()) ?? []) {
          // SNPedia's compact genotype labels do not establish VCF sequence
          // allele boundaries or REF/ALT equivalence. These calls use the exact
          // coordinate-aware reference matcher instead of flattened strings.
          if (contextUsers.has(userGenotype)) continue;
          if (userGenotype.strand === "minus" && effectiveOrientation === "unknown") {
            contextUsers.add(userGenotype);
            continue;
          }
          // Legacy calls without strand metadata retain the plus-strand default.
          // Explicitly unknown strand never receives genotype-specific evidence.
          let normalizedUserGenotype = normalizeGenotype(userGenotype.genotype || "");
          if (!normalizedUserGenotype || normalizedUserGenotype === "--") continue;
          if (
            (effectiveOrientation === "minus" && userGenotype.strand !== "minus") ||
            (effectiveOrientation === "plus" && userGenotype.strand === "minus")
          ) {
            normalizedUserGenotype = normalizeGenotype(complementGenotype(normalizedUserGenotype));
          }

          if (normalizedUserGenotype !== snpediaGenotype) continue;
          const rsid = row.rsid as string;
          const key = JSON.stringify([userCallIdentity(userGenotype), row.genotype_id]);
          const previous = emitted.get(key);
          if (
            previous?.some(
              (match) =>
                match.snpData.rsid === rsid &&
                match.snpData.content === snpContent &&
                match.snpData.scraped_at === row.snp_scraped_at &&
                match.snpData.gene === row.snp_gene &&
                match.snpData.gene_s === row.snp_gene_s &&
                match.snpData.clin_gene_name === row.snp_clin_gene_name &&
                match.snpData.clin_sig === row.snp_clin_sig &&
                match.snpData.clin_disease === row.snp_clin_disease &&
                match.genotypeData?.snp_id === snp_id &&
                match.genotypeData.genotype === snpediaGenotype &&
                match.genotypeData.content === genotypeContent &&
                match.genotypeData.scraped_at === row.genotype_scraped_at,
            )
          )
            continue;

          // Parse content (this will also re-parse orientation and make it available downstream)
          const snpFields = {
            gene: row.snp_gene,
            gene_s: row.snp_gene_s,
            clin_gene_name: row.snp_clin_gene_name,
            clin_sig: row.snp_clin_sig,
            clin_disease: row.snp_clin_disease,
          };
          const parsedData = parseContentData(rsid, snpContent, genotypeContent, snpFields);

          const match: MatchedSNP = {
            ...userGenotype,
            snpData: {
              rsid,
              content: snpContent,
              scraped_at: row.snp_scraped_at as string | undefined,
              gene: row.snp_gene as string | undefined,
              gene_s: row.snp_gene_s as string | undefined,
              clin_gene_name: row.snp_clin_gene_name as string | undefined,
              clin_sig: row.snp_clin_sig as string | undefined,
              clin_disease: row.snp_clin_disease as string | undefined,
            },
            genotypeData: {
              id: row.genotype_id as string,
              content: genotypeContent,
              scraped_at: row.genotype_scraped_at as string | undefined,
              snp_id: snp_id,
              // keep this as the SNPedia genotype (its own orientation)
              genotype: snpediaGenotype,
            },
            parsedData,
          };
          matches.push(match);
          if (previous) previous.push(match);
          else emitted.set(key, [match]);
        }
      }
    } finally {
      stmt.free();
    }

    // Keep the source's general variant article when strand or sequence identity
    // prevents a genotype interpretation. Query snps directly so an article does
    // not need a corresponding genotype row to remain available.
    const contextIds = [...new Set([...contextUsers].map((user) => user.rsid.toLowerCase()))].filter((id) =>
      /^(?:rs|i)\d+$/.test(id),
    );
    if (contextIds.length) {
      const contextStatement = database.prepare(
        `SELECT * FROM snps WHERE rsid COLLATE NOCASE IN (${contextIds.map(() => "?").join(",")})`,
      );
      try {
        contextStatement.bind(contextIds);
        while (contextStatement.step()) {
          const row = contextStatement.getAsObject();
          const rsid = row.rsid as string;
          const content = (row.content as string) || "";
          for (const user of genotypesByRsid.get(rsid.toLowerCase()) ?? []) {
            if (!contextUsers.has(user)) continue;
            const key = JSON.stringify([userCallIdentity(user), null]);
            const previous = emitted.get(key);
            if (
              previous?.some(
                (match) =>
                  match.snpData.rsid === rsid &&
                  match.snpData.content === content &&
                  match.snpData.scraped_at === row.scraped_at &&
                  match.snpData.gene === row.gene &&
                  match.snpData.gene_s === row.gene_s &&
                  match.snpData.clin_gene_name === row.clin_gene_name &&
                  match.snpData.clin_sig === row.clin_sig &&
                  match.snpData.clin_disease === row.clin_disease,
              )
            )
              continue;
            const match: MatchedSNP = {
              ...user,
              snpData: {
                rsid,
                content,
                scraped_at: row.scraped_at as string | undefined,
                gene: row.gene as string | undefined,
                gene_s: row.gene_s as string | undefined,
                clin_gene_name: row.clin_gene_name as string | undefined,
                clin_sig: row.clin_sig as string | undefined,
                clin_disease: row.clin_disease as string | undefined,
              },
              parsedData: parseContentData(rsid, content, undefined, row),
            };
            matches.push(match);
            if (previous) previous.push(match);
            else emitted.set(key, [match]);
          }
        }
      } finally {
        contextStatement.free();
      }
    }

    if (i % 1000 === 0 || i + batchSize >= genotypes.length) {
      onProgress(Math.min(i + batchSize, genotypes.length), genotypes.length);
    }
  }

  return matches;
}
