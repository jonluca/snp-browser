import type { HaplogroupMarker, HaplogroupRule } from "../types/haplogroups";

/** Bounded, versioned marker panel; this is not a complete phylogenetic tree. */
export const HAPLOGROUP_PANEL_VERSION = "2026-09-23";

export const HAPLOGROUP_SOURCES = [
  {
    title: "Y markers: AMY-tree, Supplementary Tables S1–S3 (2013)",
    url: "https://doi.org/10.1186/1471-2164-14-101",
  },
  {
    title: "Y coordinates and reference alleles: NCBI dbSNP",
    url: "https://www.ncbi.nlm.nih.gov/snp/",
  },
  {
    title: "Mitochondrial motifs: PhyloTree Build 17 / HaploGrep",
    url: "https://github.com/genepi/phylotree-rcrs-17/tree/4fc8e791790bc9a19ee3f68f7c1444a17822d23f",
  },
  {
    title: "Data attribution and license notices",
    url: "/haplogroups-NOTICE.txt",
  },
] as const;

function y(
  id: string,
  label: string,
  marker: string,
  rsid: string,
  grch37: number,
  grch38: number,
  allele: string,
  reference: string | HaplogroupMarker["refs"],
  parent?: string,
): HaplogroupRule {
  return {
    id,
    label,
    lineage: "Y",
    ...(parent ? { parent } : {}),
    markers: [
      {
        id: marker,
        rsid,
        positions: { GRCh37: grch37, GRCh38: grch38 },
        allele,
        ...(typeof reference === "string" ? { ref: reference } : { refs: reference }),
      },
    ],
  };
}

/** MT coordinates are rCRS (NC_012920.1) in both supported assemblies. */
function mt(
  label: string,
  markers: readonly (readonly [position: number, allele: string, ref: string])[],
  parent?: string,
): HaplogroupRule {
  return {
    id: `MT-${label}`,
    label,
    lineage: "MT",
    ...(parent ? { parent: `MT-${parent}` } : {}),
    markers: markers.map(([position, allele, ref]) => ({
      id: `m.${position}${allele}`,
      positions: { GRCh37: position, GRCh38: position },
      allele,
      ref,
    })),
  };
}

/**
 * Y derived alleles and relationships: AMY-tree S1–S3, CC BY 2.0.
 * Y assembly positions/REF: dbSNP build 157, checked 2026-09-23.
 * MT motifs/reference bases: pinned MIT-licensed HaploGrep tree and rcrs.fasta.
 * See docs/haplogroups.md for provenance, coverage and third-party notices.
 */
export const HAPLOGROUP_RULES: readonly HaplogroupRule[] = [
  y("Y-B", "B-M181", "M181", "rs2032599", 14851554, 12739620, "C", "T"),
  y("Y-C", "C-M130", "M130", "rs35284970", 2734854, 2866813, "T", "C"),
  y("Y-D", "D-M174", "M174", "rs2032602", 14954280, 12842354, "C", "T"),
  y("Y-E", "E-M96", "M96", "rs9306841", 21778998, 19617112, "G", "C"),
  y("Y-E-M2", "E-M2", "M2", "rs9785941", 14096577, 11975871, "G", "A", "Y-E"),
  y("Y-E-M215", "E1b1b (E-M215)", "M215", "rs2032654", 15467824, 13355944, "G", "A", "Y-E"),
  y("Y-G", "G-M201", "M201", "rs2032636", 15027529, 12915617, "T", { GRCh37: "T", GRCh38: "G" }),
  y("Y-H", "H-M69", "M69", "rs2032673", 21894058, 19732172, "C", "T"),
  y("Y-I", "I-M170", "M170", "rs2032597", 14847792, 12735858, "C", "A"),
  y("Y-I1", "I1 (I-M253)", "M253", "rs9341296", 15022707, 12910796, "T", "C", "Y-I"),
  y("Y-I2", "I2 (I-M438)", "M438", "rs17307294", 16638804, 14526924, "G", "A", "Y-I"),
  y("Y-J", "J-P209", "P209", "rs17315835", 19179335, 17067455, "C", "T"),
  y("Y-J1", "J1 (J-M267)", "M267", "rs9341313", 22741818, 20579932, "G", "T", "Y-J"),
  y("Y-J2", "J2 (J-M172)", "M172", "rs2032604", 14969634, 12857709, "G", "T", "Y-J"),
  y("Y-L", "L-M20", "M20", "rs3911", 21733454, 19571568, "G", "A"),
  y("Y-N", "N-M231", "M231", "rs9341278", 15469724, 13357844, "A", "G"),
  y("Y-O-M122", "O-M122", "M122", "rs78149062", 21764674, 19602788, "G", "A"),
  y("Y-Q", "Q-M242", "M242", "rs8179021", 15018582, 12906671, "T", "C"),
  y("Y-R", "R-M207", "M207", "rs2032658", 15581983, 13470103, "G", "G"),
  y("Y-R1", "R1 (R-M173)", "M173", "rs2032624", 15026424, 12914512, "C", { GRCh37: "A", GRCh38: "C" }, "Y-R"),
  y("Y-R1a", "R1a (R-M420)", "M420", "rs17250535", 23473201, 21311315, "A", "T", "Y-R1"),
  y("Y-R-M198", "R-M198", "M198", "rs2020857", 15030752, 12918840, "T", "C", "Y-R1a"),
  y("Y-R1b", "R1b (R-M343)", "M343", "rs9786184", 2887824, 3019783, "A", "A", "Y-R1"),
  y("Y-R-M269", "R-M269", "M269", "rs9786153", 22739367, 20577481, "C", "C", "Y-R1b"),
  y("Y-T", "T-M184", "M184", "rs20320", 14898163, 12786229, "A", "G"),

  // H requires two explicitly observed reference alleles; absent variants are not evidence.
  mt("H", [
    [2706, "A", "A"],
    [7028, "C", "C"],
  ]),
  // V combines its branch marker with two HV0 markers.
  mt("V", [
    [72, "C", "T"],
    [4580, "A", "G"],
    [16298, "C", "T"],
  ]),
  // J includes the JT background; neither recurrent 10398 nor 13708 stands alone.
  mt("J", [
    [4216, "C", "T"],
    [11251, "G", "A"],
    [12612, "G", "A"],
    [13708, "A", "G"],
  ]),
  mt("T", [
    [4917, "G", "A"],
    [10463, "C", "T"],
    [13368, "A", "G"],
  ]),
  mt("U", [
    [11467, "G", "A"],
    [12308, "G", "A"],
    [12372, "A", "G"],
  ]),
  mt(
    "K",
    [
      [10550, "G", "A"],
      [11299, "C", "T"],
      [14798, "C", "T"],
    ],
    "U",
  ),
  mt("A", [
    [663, "G", "A"],
    [1736, "G", "A"],
    [4248, "C", "T"],
  ]),
  // B's defining deletion is not supported; only the multi-SNP B5 motif is included.
  mt("B5", [
    [8584, "A", "G"],
    [9950, "C", "T"],
    [16140, "C", "T"],
  ]),
  mt("M", [
    [10400, "T", "C"],
    [14783, "C", "T"],
    [15043, "A", "G"],
  ]),
  mt(
    "C",
    [
      [3552, "A", "T"],
      [9545, "G", "A"],
      [13263, "G", "A"],
    ],
    "M",
  ),
  mt(
    "D",
    [
      [10400, "T", "C"],
      [5178, "A", "C"],
      [16362, "C", "T"],
    ],
    "M",
  ),
  mt(
    "E",
    [
      [3027, "C", "T"],
      [3705, "A", "G"],
      [7598, "A", "G"],
    ],
    "M",
  ),
  mt("F", [
    [6392, "C", "T"],
    [10310, "A", "G"],
  ]),
  mt(
    "G",
    [
      [4833, "G", "A"],
      [5108, "C", "T"],
      [709, "A", "G"],
    ],
    "M",
  ),
  mt("I", [
    [8251, "A", "G"],
    [10034, "C", "T"],
    [16129, "A", "G"],
  ]),
  mt("W", [
    [1243, "C", "T"],
    [3505, "G", "A"],
    [8251, "A", "G"],
    [11947, "G", "A"],
  ]),
  mt("X", [
    [6221, "C", "T"],
    [6371, "T", "C"],
    [13966, "G", "A"],
    [14470, "C", "T"],
  ]),
  mt("Y", [
    [8392, "A", "G"],
    [14178, "C", "T"],
    [14693, "G", "A"],
  ]),
  mt(
    "Z",
    [
      [6752, "G", "A"],
      [9090, "C", "T"],
      [15784, "C", "T"],
    ],
    "M",
  ),
  mt("L0", [
    [1048, "T", "C"],
    [3516, "A", "C"],
    [5442, "C", "T"],
  ]),
  mt("L1", [
    [3666, "A", "G"],
    [7055, "G", "A"],
    [7389, "C", "T"],
  ]),
  mt("L2", [
    [2416, "C", "T"],
    [8206, "A", "G"],
    [9221, "G", "A"],
    [10115, "C", "T"],
  ]),
  mt("L5", [
    [3423, "C", "T"],
    [7972, "G", "A"],
    [12432, "T", "C"],
  ]),
  mt("L6", [
    [770, "T", "C"],
    [4964, "T", "C"],
    [5267, "C", "T"],
  ]),
];
