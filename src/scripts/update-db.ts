// usage: node update_snps_sqljs.js path/to/snpedia.db

import fs from "fs";
import path from "path";
import initSqlJs from "sql.js";

if (process.argv.length < 3) {
  console.error("Usage: node update_snps_sqljs.js path/to/snpedia.db");
  process.exit(1);
}

const dbPath = path.resolve(process.argv[2]);

(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => require.resolve("sql.js/dist/" + file),
  });

  // Load existing DB file
  const fileBuffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(fileBuffer);

  // Helper: column exists?
  function columnExists(table: string, columnName: string) {
    const res = db.exec(`PRAGMA table_info(${table});`);
    if (!res || res.length === 0) return false;

    const info = res[0]; // { columns: [...], values: [...] }
    const nameIdx = info.columns.indexOf("name");
    if (nameIdx === -1) return false;

    return info.values.some((row) => row[nameIdx] === columnName);
  }

  // Helper: add column if missing
  function addColumnIfNotExists(table: string, columnDef: string) {
    const columnName = columnDef.split(/\s+/, 1)[0];

    if (columnExists(table, columnName)) {
      console.log(`Column ${columnName} already exists on ${table}, skipping`);
      return;
    }

    console.log(`Adding column ${columnName} to ${table}`);
    db.run(`ALTER TABLE ${table} ADD COLUMN ${columnDef};`);
  }

  // Rsnum / general
  addColumnIfNotExists("snps", "chromosome TEXT");
  addColumnIfNotExists("snps", "orientation TEXT");
  addColumnIfNotExists("snps", "gene TEXT");
  addColumnIfNotExists("snps", "position INTEGER");
  addColumnIfNotExists("snps", "geno1 TEXT");
  addColumnIfNotExists("snps", "geno2 TEXT");
  addColumnIfNotExists("snps", "geno3 TEXT");
  addColumnIfNotExists("snps", "assembly TEXT");
  addColumnIfNotExists("snps", "gene_s TEXT");
  addColumnIfNotExists("snps", "genome_build TEXT"); // e.g. 38.1 -> TEXT
  addColumnIfNotExists("snps", "dbsnp_build INTEGER");
  addColumnIfNotExists("snps", "stabilized_orientation TEXT");

  // ClinVar core we already had
  addColumnIfNotExists("snps", "clin_chromosome TEXT");
  addColumnIfNotExists("snps", "clin_rsid TEXT");
  addColumnIfNotExists("snps", "clin_sig TEXT");
  addColumnIfNotExists("snps", "clin_disease TEXT");
  addColumnIfNotExists("snps", "clin_dbn TEXT");
  addColumnIfNotExists("snps", "clin_hgvs TEXT");
  addColumnIfNotExists("snps", "clin_origin TEXT");
  addColumnIfNotExists("snps", "clin_accession TEXT");

  // ClinVar extra fields
  addColumnIfNotExists("snps", "clin_reversed INTEGER");
  addColumnIfNotExists("snps", "clin_fwd_ref TEXT");
  addColumnIfNotExists("snps", "clin_fwd_alt TEXT");
  addColumnIfNotExists("snps", "clin_ref TEXT");
  addColumnIfNotExists("snps", "clin_alt TEXT");
  addColumnIfNotExists("snps", "clin_rspos INTEGER");
  addColumnIfNotExists("snps", "clin_dbsnp_build_id INTEGER");
  addColumnIfNotExists("snps", "clin_ssr INTEGER");
  addColumnIfNotExists("snps", "clin_sao INTEGER");
  addColumnIfNotExists("snps", "clin_vp TEXT");
  addColumnIfNotExists("snps", "clin_geneinfo TEXT");
  addColumnIfNotExists("snps", "clin_gene_name TEXT");
  addColumnIfNotExists("snps", "clin_gene_id INTEGER");
  addColumnIfNotExists("snps", "clin_wgt INTEGER");
  addColumnIfNotExists("snps", "clin_vc TEXT");
  addColumnIfNotExists("snps", "clin_clnalle TEXT");
  addColumnIfNotExists("snps", "clin_tags TEXT");
  addColumnIfNotExists("snps", "clin_clndsdb TEXT");
  addColumnIfNotExists("snps", "clin_clndsdbid TEXT");
  addColumnIfNotExists("snps", "clin_clnrevstat TEXT");
  addColumnIfNotExists("snps", "clin_clnsrc TEXT");
  addColumnIfNotExists("snps", "clin_clnsrcid TEXT");

  // PMID block
  addColumnIfNotExists("snps", "pmid INTEGER");
  addColumnIfNotExists("snps", "pmid_title TEXT");

  // ===== Extraction helpers =====

  function extract(content: string, key: string) {
    if (!content) return null;
    const re = new RegExp(`\\|${key}=([^|}\\n]+)`);
    const m = content.match(re);
    if (!m) return null;
    return m[1].trim();
  }

  function extractGeno(content: string, key: string) {
    const val = extract(content, key);
    if (!val) return null;
    if (val.startsWith("(") && val.endsWith(")")) {
      return val.slice(1, -1).trim();
    }
    return val;
  }

  function extractInt(content: string, key: string) {
    const s = extract(content, key);
    if (!s) return null;
    if (!/^-?\d+$/.test(s)) return null;
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? null : n;
  }

  // PMID block: {{PMID Auto |PMID=15832357 |Title=...}}
  function extractPMID(content: string) {
    if (!content) return { pmid: null, title: null };
    const blockMatch = content.match(/\{\{PMID Auto([^}]+)\}\}/);
    if (!blockMatch) return { pmid: null, title: null };
    const block = blockMatch[1];

    const pmidMatch = block.match(/\|PMID=([^|}\n]+)/);
    const titleMatch = block.match(/\|Title=([^|}\n]+)/);

    let pmid = null;
    if (pmidMatch) {
      const s = pmidMatch[1].trim();
      if (/^\d+$/.test(s)) pmid = parseInt(s, 10);
    }

    const title = titleMatch ? titleMatch[1].trim() : null;
    return { pmid, title };
  }

  // ===== Prepare statements =====

  const selectStmt = db.prepare(`
    SELECT rsid, content
    FROM snps
  `);

  const updateStmt = db.prepare(`
    UPDATE snps
    SET
      chromosome            = ?,
      orientation           = ?,
      gene                  = ?,
      position              = ?,
      geno1                 = ?,
      geno2                 = ?,
      geno3                 = ?,
      assembly              = ?,
      gene_s                = ?,
      genome_build          = ?,
      dbsnp_build           = ?,
      stabilized_orientation = ?,

      clin_chromosome       = ?,
      clin_rsid             = ?,
      clin_sig              = ?,
      clin_disease          = ?,
      clin_dbn              = ?,
      clin_hgvs             = ?,
      clin_origin           = ?,
      clin_accession        = ?,

      clin_reversed         = ?,
      clin_fwd_ref          = ?,
      clin_fwd_alt          = ?,
      clin_ref              = ?,
      clin_alt              = ?,
      clin_rspos            = ?,
      clin_dbsnp_build_id   = ?,
      clin_ssr              = ?,
      clin_sao              = ?,
      clin_vp               = ?,
      clin_geneinfo         = ?,
      clin_gene_name        = ?,
      clin_gene_id          = ?,
      clin_wgt              = ?,
      clin_vc               = ?,
      clin_clnalle          = ?,
      clin_tags             = ?,
      clin_clndsdb          = ?,
      clin_clndsdbid        = ?,
      clin_clnrevstat       = ?,
      clin_clnsrc           = ?,
      clin_clnsrcid         = ?,

      pmid                  = ?,
      pmid_title            = ?
    WHERE rsid = ?
  `);

  // ===== Run updates in a transaction =====

  db.run("BEGIN TRANSACTION;");

  let count = 0;

  while (selectStmt.step()) {
    const row = selectStmt.getAsObject(); // { rsid: '...', content: '...' }
    const rsid = row.rsid;
    const content = (row.content || "") as string;

    // Rsnum / general
    const chromosome = extract(content, "Chromosome");
    const orientation = extract(content, "Orientation");
    const gene = extract(content, "Gene");
    const position = extractInt(content, "position");
    const geno1 = extractGeno(content, "geno1");
    const geno2 = extractGeno(content, "geno2");
    const geno3 = extractGeno(content, "geno3");
    const assembly = extract(content, "Assembly");
    const gene_s = extract(content, "Gene_s");
    const genome_build = extract(content, "GenomeBuild");
    const dbsnp_build = extractInt(content, "dbSNPBuild");
    const stabilized_orientation = extract(content, "StabilizedOrientation");

    // ClinVar
    const clin_chromosome = extract(content, "CHROM");
    const clin_rsid = extract(content, "rsid"); // same rsid, but from ClinVar block
    const clin_sig = extract(content, "CLNSIG");
    const clin_disease = extract(content, "Disease");
    const clin_dbn = extract(content, "CLNDBN");
    const clin_hgvs = extract(content, "CLNHGVS");
    const clin_origin = extract(content, "CLNORIGIN");
    const clin_accession = extract(content, "CLNACC");

    const clin_reversed = extractInt(content, "Reversed");
    const clin_fwd_ref = extract(content, "FwdREF");
    const clin_fwd_alt = extract(content, "FwdALT");
    const clin_ref = extract(content, "REF");
    const clin_alt = extract(content, "ALT");
    const clin_rspos = extractInt(content, "RSPOS");
    const clin_dbsnp_build_id = extractInt(content, "dbSNPBuildID");
    const clin_ssr = extractInt(content, "SSR");
    const clin_sao = extractInt(content, "SAO");
    const clin_vp = extract(content, "VP");
    const clin_geneinfo = extract(content, "GENEINFO");
    const clin_gene_name = extract(content, "GENE_NAME");
    const clin_gene_id = extractInt(content, "GENE_ID");
    const clin_wgt = extractInt(content, "WGT");
    const clin_vc = extract(content, "VC");
    const clin_clnalle = extract(content, "CLNALLE");
    const clin_tags = extract(content, "Tags");
    const clin_clndsdb = extract(content, "CLNDSDB");
    const clin_clndsdbid = extract(content, "CLNDSDBID");
    const clin_clnrevstat = extract(content, "CLNREVSTAT");
    const clin_clnsrc = extract(content, "CLNSRC");
    const clin_clnsrcid = extract(content, "CLNSRCID");

    // PMID Auto block
    const { pmid, title: pmid_title } = extractPMID(content);

    updateStmt.run([
      chromosome,
      orientation,
      gene,
      position,
      geno1,
      geno2,
      geno3,
      assembly,
      gene_s,
      genome_build,
      dbsnp_build,
      stabilized_orientation,

      clin_chromosome,
      clin_rsid,
      clin_sig,
      clin_disease,
      clin_dbn,
      clin_hgvs,
      clin_origin,
      clin_accession,

      clin_reversed,
      clin_fwd_ref,
      clin_fwd_alt,
      clin_ref,
      clin_alt,
      clin_rspos,
      clin_dbsnp_build_id,
      clin_ssr,
      clin_sao,
      clin_vp,
      clin_geneinfo,
      clin_gene_name,
      clin_gene_id,
      clin_wgt,
      clin_vc,
      clin_clnalle,
      clin_tags,
      clin_clndsdb,
      clin_clndsdbid,
      clin_clnrevstat,
      clin_clnsrc,
      clin_clnsrcid,

      pmid,
      pmid_title,
      rsid,
    ]);
    updateStmt.reset();

    count++;
    if (count % 10000 === 0) {
      console.log(`Updated ${count} rows...`);
    }
  }

  selectStmt.free();
  updateStmt.free();

  db.run("COMMIT;");

  console.log(`Done. Updated ${count} rows total.`);

  // Write DB back to file
  const data = db.export(); // Uint8Array
  fs.writeFileSync(dbPath, Buffer.from(data));

  db.close();
  console.log("Closed DB and wrote changes.");
})();
