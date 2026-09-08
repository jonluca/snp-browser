import type { AnnotationSource } from "../types/annotations";

export type ReferenceCategory = "clinical" | "associations" | "genes" | "function" | "medication";

export const REFERENCE_CATEGORIES: Record<ReferenceCategory, string> = {
  clinical: "Clinical evidence",
  associations: "Traits & associations",
  genes: "Genes & diseases",
  function: "Variant context",
  medication: "Medication evidence",
};

export const REFERENCE_SOURCE_INFO: Record<AnnotationSource, { category: ReferenceCategory; use: string }> = {
  hpo: { category: "genes", use: "Explore documented clinical features linked to genes and diseases, retaining source evidence and exceptions." },
  clinvar: {
    category: "clinical",
    use: "Compare called alleles with submitted clinical classifications and review status.",
  },
  clingen: { category: "genes", use: "See expert assessments of how strongly a gene is linked to a disease." },
  orphanet: {
    category: "genes",
    use: "Explore curated rare-disease associations for genes represented in your matches.",
  },
  panelapp: { category: "genes", use: "Explore expert-reviewed gene panels and their evidence ratings." },
  uniprot: { category: "function", use: "Read literature-curated protein variant and disease context." },
  opentargets: {
    category: "associations",
    use: "Explore fine-mapped study associations with their source evidence and uncertainty.",
  },
  gwas: {
    category: "associations",
    use: "Find published trait and disease associations, with study population and reported effects.",
  },
  dbsnp: { category: "function", use: "Resolve public variant identifiers, aliases, and assembly-specific alleles." },
  gnomad: { category: "function", use: "See how often a called allele was observed in reference populations." },
  ensembl: { category: "function", use: "Explore precomputed gene, transcript, and protein consequences." },
  clinpgx: { category: "medication", use: "Explore curated gene and variant evidence relating to drug response." },
  cpic: { category: "medication", use: "Find gene–drug guidelines without assuming a drug-response phenotype." },
};
