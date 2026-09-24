import type { GenomeAssembly } from "./annotations";

// Raw database record from snps table
export interface SNPRecord {
  referenceKey?: string;
  referenceSource?: string;
  sourceUrl?: string;
  annotations?: import("./annotations").AnnotationEvidence[];
  rsid: string;
  content: string;
  scraped_at?: string;
  gene?: string;
  gene_s?: string;
  clin_gene_name?: string;
  clin_sig?: string;
  clin_disease?: string;
  chromosome?: string;
  position?: string;
}

// Raw database record from genotypes table
export interface GenotypeRecord {
  id: string;
  content: string;
  scraped_at?: string;
  snp_id: string; // Links to snps.rsid
  genotype: string;
}

// Raw database record from genosets table
export interface GenosetRecord {
  id: string; // Always starts with "gs"
  content: string;
  scraped_at?: string;
}

// User's genotype from uploaded file
export interface UserGenotype {
  /** rsID/provider ID, or a stable build:chromosome:position:REF:ALT key for ID-less VCF variants. */
  rsid: string;
  chromosome: string;
  position: string;
  genotype: string;
  /** Explicit called sequences for non-SNP VCF calls, preserving allele boundaries and source order. */
  alleles?: string[];
  /** Only set when the uploaded file explicitly identifies a supported build. */
  assembly?: GenomeAssembly;
  /** UCSC hg19 chrM and RSRS are not the rCRS mitochondrial sequence used by the panel. */
  mitochondrialReference?: "rCRS" | "unsupported";
  /** Reference allele, in the same orientation as genotype. */
  ref?: string;
  /** Comma-separated called non-reference alleles; absent for a reference-only call. */
  alt?: string;
  strand?: "plus" | "minus" | "unknown";
  /** Records whether the source GT was phased, without inferring haplotypes. */
  phased?: boolean;
}

// Parsed/enriched SNP data extracted from content fields
export interface ParsedSNPData {
  rsid: string;
  rawContent: string;
  genotypeContent?: string; // Content specific to the user's genotype
  geneSymbol?: string;
  magnitude?: number;
  repute?: string;
  summary?: string;
  // Any other fields we extract from content
  [key: string]: unknown;
}

// User's genotype matched with database info
export interface MatchedSNP extends UserGenotype {
  annotationSummary?: import("./annotations").AnnotationMatchSummary;
  annotations?: import("./annotations").AnnotationEvidence[];
  snpData: SNPRecord;
  genotypeData?: GenotypeRecord;
  parsedData: ParsedSNPData; // Enriched data extracted from content
}

// Genoset matched with user's genotypes
export interface MatchedGenoset {
  genoset: GenosetRecord;
  matchedGenotypes: MatchedSNP[]; // The user's genotypes that contribute to this genoset
  parsedData: {
    id: string;
    rawContent: string;
    magnitude?: number;
    repute?: string;
    summary?: string;
    [key: string]: unknown;
  };
}

export interface ImportedReport {
  format: "pdf" | "promethease";
  title: string;
  pages: Array<{ page: number; text: string }>;
  notes: string[];
}

export interface ParseResult {
  haplogroups?: import("./haplogroups").HaplogroupAnalysis;
  traits?: import("./traits").TraitAnalysis;
  report?: ImportedReport;
  warnings?: string[];
  assembly?: GenomeAssembly;
  genotypes: UserGenotype[];
  totalLines: number;
  skippedLines: number;
  errors: string[];
}
