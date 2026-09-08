import type { AnnotationSource } from "../types/annotations";

export const ANNOTATION_SOURCE_NAMES: Record<AnnotationSource, string> = {
  clinvar: "ClinVar",
  dbsnp: "dbSNP",
  gnomad: "gnomAD",
  gwas: "GWAS Catalog",
  ensembl: "Ensembl VEP",
  clinpgx: "ClinPGx / PharmGKB",
  cpic: "CPIC",
  clingen: "ClinGen",
  orphanet: "Orphanet",
  uniprot: "UniProt",
  opentargets: "Open Targets",
  panelapp: "PanelApp",
  hpo: "Human Phenotype Ontology",
};

export const ANNOTATION_SOURCE_ORDER: AnnotationSource[] = [
  "clinvar",
  "dbsnp",
  "gnomad",
  "gwas",
  "ensembl",
  "clinpgx",
  "cpic",
  "clingen",
  "orphanet",
  "uniprot",
  "opentargets",
  "panelapp",
  "hpo",
];

/** Reference metadata is external data. Only explicit web URLs become links. */
export function safeReferenceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function formatReferenceBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Size unavailable";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

const FIELD_LABELS: Record<string, string> = {
  clnsig: "Clinical classification",
  clinicalsignificance: "Clinical classification",
  germlineclassification: "Germline classification",
  clndn: "Associated conditions",
  phenotypelist: "Associated conditions",
  clnrevstat: "Review status",
  reviewstatus: "Review status",
  lastevaluated: "Last evaluated",
  clnsigconf: "Conflicting classifications",
  clnvc: "Variant type",
  clnvi: "Other variant identifiers",
  clndisdb: "Condition identifiers",
  geneinfo: "Gene identifiers",
  af: "Allele frequency",
  ac: "Alternate allele count",
  an: "Total allele count",
  nhomalt: "Alternate homozygote count",
  filter: "Source quality filter",
  pvalue: "P-value",
  pvaluemlog: "−log₁₀ P-value",
  ororbeta: "Reported odds ratio or beta",
  "95citext": "Reported 95% confidence interval",
  strongestsnpriskallele: "Reported SNP and risk allele",
  initialsamplesize: "Initial study sample",
  replicationsamplesize: "Replication study sample",
  riskallelefrequency: "Reported risk allele frequency",
  reportedgenes: "Reported genes",
  mappedgene: "Mapped genes",
  pubmedid: "PubMed ID",
  diseasetrait: "Trait",
  studyaccession: "Study accession",
  hgvsc: "Transcript change",
  hgvsp: "Protein change",
  transcriptid: "Transcript ID",
  consequence: "Predicted consequence",
  consequenceterms: "Predicted consequences",
  aminoacids: "Amino acids",
  proteinstart: "Protein start",
  proteinend: "Protein end",
  levelofevidence: "Evidence level",
  cpiclevel: "CPIC evidence level",
  clinpgxlevel: "ClinPGx evidence level",
  drugname: "Drug",
  usedforrecommendation: "Used in source recommendations",
  provisional: "Provisional source assessment",
  genesymbol: "Gene",
  drugs: "Drugs",
  diplotype: "Source diplotype",
};

export function annotationFieldLabel(key: string): string {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (FIELD_LABELS[normalized]) return FIELD_LABELS[normalized];
  const frequency = /^(AF|AC|AN|nhomalt)_(.+)$/i.exec(key);
  if (frequency) {
    return `${FIELD_LABELS[frequency[1].toLowerCase()]} · ${frequency[2].replace(/_/g, " ")}`;
  }
  return key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (first) => first.toUpperCase());
}
