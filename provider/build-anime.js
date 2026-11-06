// Bundles the anime providers (provider_anime/src/cutcrew.ts) into one CommonJS
// file the backend loads: provider/dist-anime/anime.cjs.
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const entry = path.resolve(__dirname, "../provider_anime/src/cutcrew.ts");
const outfile = path.resolve(__dirname, "dist-anime/anime.cjs");

if (!fs.existsSync(entry)) {
  console.log("Skipping anime build: provider_anime/src/cutcrew.ts not found");
  process.exit(0);
}

esbuild
  .build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    legalComments: "none",
    logLevel: "warning",
  })
  .then(() => {
    const size = (fs.statSync(outfile).size / 1024).toFixed(1);
    console.log(`✓ Built anime providers: dist-anime/anime.cjs (${size}kb)`);
  })
  .catch(() => process.exit(1));
