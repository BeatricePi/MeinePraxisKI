// scripts/buildSynonyms.js
const fs = require("fs");
const path = require("path");
const idx = require("../catalogs/index.json");

const norm = s => String(s).toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[ä]/g,"ae").replace(/[ö]/g,"oe").replace(/[ü]/g,"ue").replace(/[ß]/g,"ss")
  .replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();

// domänenspezifische Erweiterungen
const DOMAIN = {
  blutentnahme: ["blutabnahme", "abnahme blut", "venenpunktion", "venepunktion", "venenblut"],
  harnstreifentest: ["harnstreifen", "urinstreifen", "urintest", "combi screen"],
  kapillar: ["kapillarblut", "fingerbeere", "ohrlaeppchen"],
  injektion: ["spritze", "injek"]
};

// aus Titeln Tokens sammeln
const map = {};
for (const it of idx.items || []) {
  const ntitle = norm(it.title);
  const tokens = ntitle.split(" ").filter(Boolean);
  for (const tok of tokens) {
    if (!map[tok]) map[tok] = new Set();
    // Varianten
    if (tok.endsWith("en")) map[tok].add(tok.slice(0,-2)); // einfache Stammform
    if (tok.endsWith("e")) map[tok].add(tok.slice(0,-1));
  }
}

// Domain-Boosts einpflegen
for (const [k, list] of Object.entries(DOMAIN)) {
  if (!map[k]) map[k] = new Set();
  for (const v of list) map[k].add(norm(v));
}

// Sets -> Arrays und raus mit Nichtigkeiten
const out = {};
for (const [k, set] of Object.entries(map)) {
  const arr = Array.from(set).filter(v => v && v !== k);
  if (arr.length) out[k] = arr;
}

const target = path.join(__dirname, "..", "catalogs", "synonyms.json");
fs.writeFileSync(target, JSON.stringify(out, null, 2));
console.log("Wrote", target, "with", Object.keys(out).length, "keys");
