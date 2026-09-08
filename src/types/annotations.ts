export type AnnotationSource =
  | "clinvar"
  | "dbsnp"
  | "gnomad"
  | "gwas"
  | "ensembl"
  | "clinpgx"
  | "cpic"
  | "clingen"
  | "orphanet"
  | "uniprot"
  | "opentargets"
  | "panelapp"
  | "hpo";
export type GenomeAssembly = "GRCh37" | "GRCh38";

export interface VariantAnnotation {
  id: string;
  source: AnnotationSource;
  rsid?: string;
  aliases?: string[];
  assembly?: GenomeAssembly;
  chromosome?: string;
  position?: number;
  ref?: string;
  alt?: string;
  gene?: string;
  scope: "allele" | "variant" | "gene";
  title: string;
  summary?: string;
  url: string;
  fields: Record<string, string | number | null>;
  citations?: Array<{ label: string; url: string }>;
  reviewStatus?: string;
  lastEvaluated?: string;
}

export interface AnnotationEvidence extends VariantAnnotation {
  matchType: "allele" | "locus" | "gene" | "unresolved";
  matchReason?: string;
}

export interface AnnotationMatchSummary {
  ambiguous?: boolean;
  sources: AnnotationSource[];
  count: number;
  alleleCount: number;
  unresolvedCount: number;
  genes: string[];
}

export interface ReferenceShard {
  url: string;
  /** Stored/downloaded asset size and digest, compressed when compression is present. */
  bytes: number;
  sha256: string;
  records: number;
  compression?: {
    format: "gzip";
    uncompressedBytes: number;
    uncompressedSha256: string;
  };
  /** Optional conservative lookup index; older packs remain searchable without it. */
  routing?: {
    algorithm: "fnv1a-double-v1";
    bitCount: number;
    hashes: 7;
    bits: string;
  };
}

export interface ReferencePack {
  id: string;
  source: AnnotationSource;
  name: string;
  description: string;
  version: string;
  /** Upstream release or dated source snapshot, distinct from the pack build. */
  sourceRelease?: string;
  builtAt: string;
  homepage: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  recordCount: number;
  coverage: string;
  shards: ReferenceShard[];
}

export interface ReferenceManifest {
  schemaVersion: 1;
  createdAt: string;
  packs: ReferencePack[];
}

export interface ReferencePackState {
  pack: ReferencePack;
  status: "available" | "downloading" | "ready" | "error";
  downloadedBytes: number;
  totalBytes: number;
  enabled: boolean;
  error?: string;
}

export interface ReferenceDownloadProgress {
  packId: string;
  downloadedBytes: number;
  totalBytes: number;
}
