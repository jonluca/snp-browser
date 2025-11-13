export interface SNPRecord {
  // Core identifiers
  rsid: string;
  content: string;

  // Genomic location
  chromosome: string | null;
  position: number | null;
  gene: string | null;
  gene_s: string | null;

  // Orientation and assembly info
  orientation: string | null;
  assembly: string | null;
  genome_build: string | null;
  dbsnp_build: number | null;
  stabilized_orientation: string | null;

  // Genotype information
  geno1: string | null;
  geno2: string | null;
  geno3: string | null;

  // ClinVar data
  clin_chromosome: string | null;
  clin_rsid: string | null;
  clin_sig: string | null;
  clin_disease: string | null;
  clin_dbn: string | null;
  clin_hgvs: string | null;
  clin_origin: string | null;
  clin_accession: string | null;
  clin_reversed: number | null;
  clin_fwd_ref: string | null;
  clin_fwd_alt: string | null;
  clin_ref: string | null;
  clin_alt: string | null;
  clin_rspos: number | null;
  clin_dbsnp_build_id: number | null;
  clin_ssr: number | null;
  clin_sao: number | null;
  clin_vp: string | null;
  clin_geneinfo: string | null;
  clin_gene_name: string | null;
  clin_gene_id: number | null;
  clin_wgt: number | null;
  clin_vc: string | null;
  clin_clnalle: string | null;
  clin_tags: string | null;
  clin_clndsdb: string | null;
  clin_clndsdbid: string | null;
  clin_clnrevstat: string | null;
  clin_clnsrc: string | null;
  clin_clnsrcid: string | null;

  // Publication reference
  pmid: number | null;
  pmid_title: string | null;
}

export interface UserGenotype {
  rsid: string;
  chromosome: string;
  position: string;
  genotype: string;
}

export interface MatchedSNP extends UserGenotype {
  snpData: SNPRecord;
}

export interface ParseResult {
  genotypes: UserGenotype[];
  totalLines: number;
  skippedLines: number;
  errors: string[];
}
