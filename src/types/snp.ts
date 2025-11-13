export interface SNPRecord {
  rsid: string;
  content: string;
  scraped_at: string;
  attribution: string;
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
