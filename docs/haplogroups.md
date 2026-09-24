# Haplogroup summary

The report includes separate Y-DNA and mitochondrial (mtDNA) haplogroup estimates,
computed locally from the uploaded genotype calls. No genotypes are sent to a
haplogroup service. Results describe one paternal or maternal lineage, not a
person's overall ancestry, ethnicity, or health.

## Coverage and interpretation

Panel version `2026-09-23` has 25 Y-DNA rules and 24 mitochondrial rules. It is a
small, original marker-matching implementation, not yHaplo, HaploGrep, AMY-tree,
or a complete phylogenetic classifier. Its results are estimates within this
panel, not a validated replacement for a dedicated haplogroup test.

The Y panel includes B-M181, C-M130, D-M174, E-M96, E-M2, E-M215, G-M201,
H-M69, I-M170, I-M253, I-M438, J-P209, J-M267, J-M172, L-M20, N-M231,
O-M122, Q-M242, R-M207, R-M173, R-M420, R-M198, R-M343, R-M269 and T-M184.
These are selected branches: for example O-M122 does not cover every O lineage,
and H-M69 does not cover every branch now named H. SNP-based labels avoid
claiming that historical longhand subclade names are current.

The mitochondrial panel includes H, V, J, T, U, K, A, B5, M, C, D, E, F, G,
I, W, X, Y, Z, L0, L1, L2, L5 and L6. K is nested within U; C, D, E, G and Z
are nested within M. Missing groups and subclades are not inferred. In particular,
the general B branch requires a deletion that this panel does not analyze;
only the multi-SNP B5 motif is included. N and R are not fallback labels.

- Every marker in a rule must be explicitly observed with the diagnostic allele.
  Missing, no-call, mixed, or heterozygous bases never imply a reference allele.
- Y rules use published branch-defining SNPs. Each mitochondrial rule requires
  two or more sites; recurrent sites such as m.10398 never identify a group alone.
  J, V, D and I include supporting sites from their ancestral background.
- H requires explicit A at m.2706 and C at m.7028. An empty mitochondrial VCF,
  or the absence of alternate variants at these positions, does not imply H.
- A supported child supersedes its supported ancestor. An observed contradictory
  ancestor blocks the child. Incompatible supported branches produce a conflict,
  rather than choosing whichever rule appears first.
- Missing Y/MT data, inadequate panel coverage and contradictory evidence have
  distinct output states. No Y result does not determine a person's sex.

Rare back mutations, recurrent mutations, raw-data errors, heteroplasmy and
unrepresented branches can prevent or mislead a limited-panel estimate. Requiring
all motif sites deliberately loses some true matches when array coverage is
sparse or a descendant has a back mutation. The display does not report a
probability or calibrated confidence score. Complete mitochondrial sequencing
and larger Y-SNP panels can resolve much finer subclades.

## Coordinates and alleles

All coordinates are one-based and all diagnostic/reference bases use the forward
strand. The implementation requires a supported assembly, chromosome, matching
position and usable strand metadata. An rsID alone is not enough to disregard a
coordinate mismatch. Single-base haploid calls and concordant duplicated bases
are usable; ambiguous multi-base calls are not.

Mitochondrial coordinates and reference bases refer to the revised Cambridge
Reference Sequence, **rCRS / NC_012920.1**, for both GRCh37 and GRCh38. The old
UCSC hg19 `chrM` sequence, **NC_001807**, is different. UCSC now names rCRS
`chrMT` on hg19 and `chrM` on hg38; see the
[UCSC mitochondrial-reference explanation](https://genome.ucsc.edu/FAQ/FAQgenes.html).
Explicitly unsupported mitochondrial references are excluded. The
[23andMe reference-sequence library](https://github.com/23andMe/seqseek)
documents rCRS for both build 37 and build 38, matching its raw-data coordinates.

Y reference alleles were checked separately from ancestral/derived alleles:
the reference genome can contain a derived allele. M201 has reference T on
GRCh37 and G on GRCh38; M173 has reference A on GRCh37 and C on GRCh38.
The data preserves these build-specific references.

## Data provenance

### Y-DNA

Derived alleles, GRCh37 positions and branch relationships were curated from:

Van Geystelen A, Decorte R, Larmuseau MHD. **AMY-tree: an algorithm to use whole
genome SNP calling for Y chromosomal phylogenetic applications.** BMC Genomics
14, 101 (2013). [DOI: 10.1186/1471-2164-14-101](https://doi.org/10.1186/1471-2164-14-101).

- [Supplementary workbook, Tables S1–S3](https://media.springernature.com/original/springer-static/esm/art%3A10.1186%2F1471-2164-14-101/MediaObjects/12864_2012_4771_MOESM1_ESM.xlsx).
- Table S1 is the May 2012 SNP conversion list; Tables S2 and S3 provide
  historical branch assignments and parent relationships. M181 is in Table S2.
- The publication is licensed under
  [Creative Commons Attribution 2.0](https://creativecommons.org/licenses/by/2.0/).
  This panel selects factual marker records, adds assembly/reference information,
  and changes presentation to stable SNP-based names. It does not copy AMY-tree's
  implementation or scoring algorithm.

For every selected Y SNP, forward placements and reference alleles were checked
against **NCBI dbSNP build 157**, retrieved September 23, 2026, using
`https://api.ncbi.nlm.nih.gov/variation/v0/refsnp/{rsid}`. Positions are from
`NC_000024.9` (GRCh37) and `NC_000024.10` (GRCh38). dbSNP SPDI coordinates are
zero-based and were converted to one-based positions. Each curated derived allele
was checked to be present at the same locus in both placements. M122's rsID
(`rs78149062`) was resolved from its GRCh37 locus and verified in dbSNP; it is not
present in the historical workbook. The complete marker table and rsIDs are in
[`src/data/haplogroupMarkers.ts`](../src/data/haplogroupMarkers.ts).

### Mitochondrial DNA

Multi-site motifs were curated from the Institute of Genetic Epidemiology's
HaploGrep distribution of **PhyloTree Build 17 (February 18, 2016)**:

- [Pinned rCRS tree and reference](https://github.com/genepi/phylotree-rcrs-17/tree/4fc8e791790bc9a19ee3f68f7c1444a17822d23f/src):
  commit `4fc8e791790bc9a19ee3f68f7c1444a17822d23f`, `tree.xml` and `rcrs.fasta`.
- [Pinned RSRS-rooted topology](https://github.com/genepi/phylotree-rsrs-17/tree/0e79ddf1b78f7a1b81fb5d607bc31a6ddea7b18b/src):
  commit `0e79ddf1b78f7a1b81fb5d607bc31a6ddea7b18b`, used to check biological
  ancestry and interpret the rCRS tree's reverse path from H2a2a1.
- The rCRS XML is re-rooted at the reference haplogroup H2a2a1. Its apparent
  H-to-HV direction must not be interpreted as biological descent. H's diagnostic
  m.2706A/m.7028C alleles are the reference-side states before the HV changes.
- Motifs were compared with reconstructed states along the full pinned tree,
  including back-mutation notation, to check for matches in unrelated broad
  clades. This is a reference-data consistency check, not validation on an
  independent cohort of genotyped people.
- Each reference base was read from the pinned `rcrs.fasta`. No population
  frequencies, geography labels or clinical annotations were imported.

Relevant primary publications are
[van Oven, PhyloTree Build 17 (2015)](https://doi.org/10.1016/j.fsigss.2015.09.155)
and [Schönherr et al., Haplogrep 3 (2023)](https://doi.org/10.1093/nar/gkad284).
The small selected motifs are distributed under the source repository's MIT
license, reproduced below. The application does not run the HaploGrep algorithm.

## Third-party MIT notice

Copyright (c) 2022 Institute of Genetic Epidemiology

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
