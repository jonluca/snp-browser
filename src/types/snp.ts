// Raw database record from snps table
export interface SNPRecord {
  rsid: string;
  content: string;
  scraped_at?: string;
}

// Raw database record from genotypes table
export interface GenotypeRecord {
  id: string;
  content: string;
  scraped_at?: string;
  snp_id: string; // Links to snps.rsid
  genotype: string;
}

// User's genotype from uploaded file
export interface UserGenotype {
  rsid: string;
  chromosome: string;
  position: string;
  genotype: string;
}

// Parsed/enriched SNP data extracted from content fields
export interface ParsedSNPData {
  rsid: string;
  rawContent: string;
  genotypeContent?: string; // Content specific to the user's genotype
  magnitude?: number;
  // Any other fields we extract from content
  [key: string]: unknown;
}

// User's genotype matched with database info
export interface MatchedSNP extends UserGenotype {
  snpData: SNPRecord;
  genotypeData?: GenotypeRecord;
  parsedData: ParsedSNPData; // Enriched data extracted from content
}

export interface ParseResult {
  genotypes: UserGenotype[];
  totalLines: number;
  skippedLines: number;
  errors: string[];
}
