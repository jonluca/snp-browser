import type { TraitPrediction, TraitRule } from "../types/traits";

export const TRAIT_RULES_VERSION = "2026-09-07.1";
export const TRAIT_RULES_REVIEWED_AT = "2026-09-07";

const prediction = (
  label: string,
  description: string,
  markerEffect: TraitPrediction["markerEffect"],
): TraitPrediction => ({ label, description, markerEffect });

const lactasePresent = prediction(
  "A tendency to retain lactase into adulthood",
  "This marker is associated with continued production of the enzyme that digests lactose.",
  "present",
);
const wetEarwax = prediction(
  "Wet earwax is more likely",
  "This genotype is associated with the wet earwax type.",
  "absent",
);
const frecklesPresent = prediction(
  "A marker associated with freckling",
  "The T allele at this site was associated with a greater tendency to develop freckles in the study populations.",
  "present",
);
const flushingPresent = prediction(
  "A tendency toward alcohol flushing",
  "This allele reduces acetaldehyde breakdown and is associated with flushing after alcohol exposure.",
  "present",
);

/**
 * A small, explicitly curated set of associations, not a polygenic score or a
 * diagnostic model. No rule estimates ancestry, intelligence, or personality.
 * NCBI RefSNP chromosome placements were checked on reviewedAt. Their SPDI
 * positions are zero-based; the positions below are one-based (SPDI + 1).
 * Rare alternate bases exist in dbSNP at several loci: only alleles covered by
 * the cited phenotype evidence are allowed. dbSNP membership is not evidence
 * for extending the interpretation to those alternate bases.
 */
export const TRAIT_RULES: readonly TraitRule[] = [
  {
    id: "lactase-persistence",
    title: "Lactose digestion",
    category: "Metabolism",
    rsid: "rs4988235",
    gene: "MCM6 / LCT",
    chromosome: "2",
    positions: { GRCh37: 136608646, GRCh38: 135851076 },
    ref: "G",
    alleles: ["A", "G"],
    outcomes: {
      AA: lactasePresent,
      AG: lactasePresent,
      GG: prediction(
        "This lactase-persistence marker is absent",
        "No A allele was called at this site. That does not establish lactose intolerance.",
        "absent",
      ),
    },
    evidence: {
      label: "Established functional association",
      summary: "A regulatory variant near LCT is associated with adult lactase persistence.",
      population:
        "First characterized in Finnish families; this marker explains much more variation in European populations than in some other populations.",
      citations: [
        {
          title: "Enattah et al. — Identification of a variant associated with adult-type hypolactasia",
          url: "https://doi.org/10.1038/ng826",
          year: 2002,
        },
        {
          title: "Tishkoff et al. — Convergent adaptation of human lactase persistence in Africa and Europe",
          url: "https://doi.org/10.1038/ng1946",
          year: 2007,
        },
      ],
    },
    limitations: [
      "Other lactase-persistence variants are not assessed by this rule.",
      "Lactase production does not by itself predict digestive symptoms or milk allergy.",
    ],
    mappingUrl: "https://www.ncbi.nlm.nih.gov/snp/rs4988235",
    mappingNote: "The original -13910 C>T notation is on the opposite strand: genomic G>A is the same change.",
  },
  {
    id: "earwax-type",
    title: "Earwax type",
    category: "Appearance",
    rsid: "rs17822931",
    gene: "ABCC11",
    chromosome: "16",
    positions: { GRCh37: 48258198, GRCh38: 48224287 },
    ref: "C",
    alleles: ["C", "T"],
    outcomes: {
      CC: wetEarwax,
      CT: wetEarwax,
      TT: prediction(
        "Dry earwax is more likely",
        "Two T alleles at this site are associated with the dry earwax type.",
        "present",
      ),
    },
    evidence: {
      label: "Established functional association",
      summary: "A functional ABCC11 variant is strongly associated with dry versus wet earwax.",
      population: "Studied in Japanese participants and multiple population samples; rare exceptions were reported.",
      citations: [
        {
          title: "Yoshiura et al. — A SNP in the ABCC11 gene is the determinant of human earwax type",
          url: "https://doi.org/10.1038/ng1733",
          year: 2006,
        },
      ],
    },
    limitations: [
      "Rare ABCC11 variants, including a reported deletion, can produce exceptions to this single-marker association.",
    ],
    mappingUrl: "https://www.ncbi.nlm.nih.gov/snp/rs17822931",
    mappingNote:
      "The paper reports transcript 538G>A; ABCC11 is on the reverse strand, so genomic C>T is the same change.",
  },
  {
    id: "eye-pigmentation",
    title: "Eye color tendency",
    category: "Appearance",
    rsid: "rs12913832",
    gene: "HERC2 / OCA2",
    chromosome: "15",
    positions: { GRCh37: 28365618, GRCh38: 28120472 },
    ref: "A",
    alleles: ["A", "G"],
    outcomes: {
      AA: prediction(
        "A marker favoring brown over blue eyes",
        "This genotype is associated with greater iris pigmentation in the studied populations.",
        "absent",
      ),
      AG: prediction(
        "A mixed eye-pigmentation signal",
        "One G allele is present, but this single marker cannot resolve brown, hazel, green, or blue eye color.",
        "mixed",
      ),
      GG: prediction(
        "A marker favoring blue over brown eyes",
        "Two G alleles are associated with reduced iris pigmentation in the studied populations.",
        "present",
      ),
    },
    evidence: {
      label: "Replicated association with functional evidence",
      summary: "Variation in a HERC2 regulatory region influences OCA2 expression and iris pigmentation.",
      population:
        "The initial association study involved European participants. Performance is not uniform across populations.",
      citations: [
        {
          title: "Sturm et al. — A single SNP in HERC2 and human blue-brown eye color",
          url: "https://doi.org/10.1016/j.ajhg.2007.11.005",
          year: 2008,
        },
      ],
    },
    limitations: [
      "Eye color involves many variants. This is not an IrisPlex model and does not assign an eye-color probability.",
      "Other variants can modify this association; no exact green or hazel prediction is made.",
    ],
    mappingUrl: "https://www.ncbi.nlm.nih.gov/snp/rs12913832",
    mappingNote: "The study's reverse-strand T/C notation corresponds to genomic A/G; the blue-associated C becomes G.",
  },
  {
    id: "ptc-bitterness",
    title: "Bitter taste marker",
    category: "Taste",
    rsid: "rs713598",
    gene: "TAS2R38",
    chromosome: "7",
    positions: { GRCh37: 141673345, GRCh38: 141973545 },
    ref: "C",
    alleles: ["C", "G"],
    outcomes: {
      CC: prediction(
        "A marker linked to weaker PTC bitterness",
        "The alanine-associated form at this site contributes to lower sensitivity to PTC-like bitter compounds.",
        "absent",
      ),
      CG: prediction(
        "A mixed PTC-bitterness marker",
        "Both forms of this receptor marker are present; the full receptor haplotypes and taste sensitivity are not determined here.",
        "mixed",
      ),
      GG: prediction(
        "A marker linked to stronger PTC bitterness",
        "The proline-associated form at this site contributes to higher sensitivity to PTC-like bitter compounds.",
        "present",
      ),
    },
    evidence: {
      label: "Functional marker in a multi-variant receptor",
      summary: "TAS2R38 receptor forms differ in their response to PTC and PROP; this marker encodes residue 49.",
      population:
        "Receptor experiments and human taste studies support the association, but receptor haplotype frequencies and other contributors vary.",
      citations: [
        {
          title: "Bufe et al. — Molecular basis of PTC and PROP bitterness perception",
          url: "https://doi.org/10.1016/j.cub.2005.01.047",
          year: 2005,
        },
        {
          title: "Worldwide study of the taste of bitter medicines and their modifiers",
          url: "https://doi.org/10.1093/chemse/bjaf003",
          year: 2025,
        },
      ],
    },
    limitations: [
      "This single marker does not establish a PAV/AVI haplotype or a supertaster label.",
      "It does not predict all bitter tastes, food preferences, or medication response.",
    ],
    mappingUrl: "https://www.ncbi.nlm.nih.gov/snp/rs713598",
    mappingNote:
      "NCBI maps genomic C>G to reverse-strand transcript NM_176817.5:c.145G>C (Ala49Pro). Genomic G encodes Pro49.",
  },
  {
    id: "freckling",
    title: "Freckling tendency",
    category: "Appearance",
    rsid: "rs12203592",
    gene: "IRF4",
    chromosome: "6",
    positions: { GRCh37: 396321, GRCh38: 396321 },
    ref: "C",
    alleles: ["C", "T"],
    outcomes: {
      CC: prediction(
        "This freckling marker is absent",
        "No T allele was called at this site. Freckles can still occur through other genetic and environmental influences.",
        "absent",
      ),
      CT: frecklesPresent,
      TT: frecklesPresent,
    },
    evidence: {
      label: "Association with functional evidence",
      summary: "A regulatory IRF4 variant affects pigment biology and was associated with the presence of freckles.",
      population:
        "The primary fine-mapping study used Icelandic data; this marker is best studied in European populations.",
      citations: [
        {
          title: "Praetorius et al. — An IRF4 polymorphism affects human pigmentation",
          url: "https://doi.org/10.1016/j.cell.2013.10.022",
          year: 2013,
        },
      ],
    },
    limitations: [
      "Freckling also depends on other genes, age, and sun exposure; this is not a skin-disease risk estimate.",
    ],
    mappingUrl: "https://www.ncbi.nlm.nih.gov/snp/rs12203592",
    mappingNote: "The study's rs12203592-T allele uses the same orientation as forward genomic C>T.",
  },
  {
    id: "alcohol-flushing",
    title: "Alcohol flushing tendency",
    category: "Metabolism",
    rsid: "rs671",
    gene: "ALDH2",
    chromosome: "12",
    positions: { GRCh37: 112241766, GRCh38: 111803962 },
    ref: "G",
    alleles: ["A", "G"],
    outcomes: {
      AA: flushingPresent,
      AG: flushingPresent,
      GG: prediction(
        "This reduced-activity ALDH2 marker is absent",
        "No A allele was called at this site. This does not establish alcohol tolerance or rule out flushing.",
        "absent",
      ),
    },
    evidence: {
      label: "Established functional association",
      summary: "The ALDH2 A allele reduces acetaldehyde metabolism and is strongly associated with alcohol flushing.",
      population:
        "Association evidence is especially extensive in East Asian cohorts, including Chinese and Korean studies.",
      citations: [
        {
          title: "Genetic influences on alcohol flushing in East Asian populations",
          url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC10594868/",
          year: 2023,
        },
        {
          title: "Millwood et al. — Conventional and genetic evidence on alcohol and vascular disease aetiology",
          url: "https://doi.org/10.1016/S0140-6736(18)31772-0",
          year: 2019,
        },
      ],
    },
    limitations: [
      "Other variants and exposure affect flushing. This marker is not a measure of safe alcohol intake or a recommendation to drink.",
    ],
    mappingUrl: "https://www.ncbi.nlm.nih.gov/snp/rs671",
    mappingNote:
      "The reduced-activity allele is forward genomic G>A, corresponding to ALDH2 Glu504Lys (also called Glu487Lys).",
  },
];
