import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import type { ReferenceManifest } from "../src/types/annotations";

// A reference rebuild can leave old releases and temporary shards in public/.
// Ship only the files selected by the catalog, while preserving source licenses.
export function referenceAssets(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "reference-assets",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    async writeBundle() {
      if (!config.publicDir) return;
      const output = path.resolve(config.root, config.build.outDir);
      const copy = async (relative: string) => {
        const source = path.join(config.publicDir, relative);
        const destination = path.join(output, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination, constants.COPYFILE_FICLONE);
      };
      const copyTree = async (relative: string): Promise<void> => {
        const entries = await readdir(path.join(config.publicDir, relative), { withFileTypes: true });
        for (const entry of entries) {
          if (!relative && entry.name === "references") continue;
          const file = path.join(relative, entry.name);
          if (entry.isDirectory()) await copyTree(file);
          else if (entry.isFile()) await copy(file);
        }
      };
      await copyTree("");
      const origin = "https://reference-assets.invalid";
      const base = new URL(config.env.VITE_REFERENCE_MANIFEST_URL || "/references/manifest.json", origin);
      if (base.origin !== origin) return;
      const manifestPath = decodeURIComponent(base.pathname).replace(/^\/+/, "");
      if (!manifestPath.startsWith("references/") || manifestPath.split("/").includes("..")) {
        throw new Error("A local reference catalog must be inside public/references/.");
      }
      // Keep one catalog snapshot throughout the build, even if preparation is active.
      const manifestText = await readFile(path.join(config.publicDir, manifestPath), "utf8");
      const manifest = JSON.parse(manifestText) as ReferenceManifest;
      const directories = new Set<string>();
      for (const pack of manifest.packs) {
        for (const shard of pack.shards) {
          const url = new URL(shard.url, base);
          if (url.origin !== base.origin) continue;
          const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
          if (!relative.startsWith("references/") || relative.split("/").includes("..")) {
            throw new Error(`Reference shard is outside the public reference directory: ${shard.url}`);
          }
          const info = await stat(path.join(config.publicDir, relative)).catch(() => null);
          if (!info?.isFile() || info.size !== shard.bytes) {
            throw new Error(`Missing or incomplete reference asset: ${relative}. See docs/reference-data.md.`);
          }
          await copy(relative);
          directories.add(path.dirname(relative));
        }
      }
      for (const directory of directories) {
        for (const entry of await readdir(path.join(config.publicDir, directory), { withFileTypes: true })) {
          if (
            entry.isFile() &&
            /^(?:LICENSE(?:\..*)?|provenance\.json|selection\.json|build-stats\.json|manifest\.json)$/i.test(entry.name)
          ) {
            await copy(path.join(directory, entry.name));
          }
        }
      }
      await mkdir(path.dirname(path.join(output, manifestPath)), { recursive: true });
      await writeFile(path.join(output, manifestPath), manifestText);
    },
  };
}
