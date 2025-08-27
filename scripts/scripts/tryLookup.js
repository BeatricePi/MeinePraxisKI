// scripts/tryLookup.js
const fs = require("fs");
const path = require("path");
const Fuse = require("fuse.js");

const idx = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "catalogs", "index.json"), "utf8")).items;

function search(query, payer) {
  const pool = payer ? idx.filter(x => x.payer === payer) : idx;
  const fuse = new Fuse(pool, { includeScore: true, threshold: 0.3, keys: ["title"] });
  return fuse.search(query).slice(0, 10).map(r => r.item);
}

// Beispiele:
console.log("ÖGK, 'Blutentnahme aus der Vene' ->");
console.log(search("Blutentnahme aus der Vene", "ÖGK"));