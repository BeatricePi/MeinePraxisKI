// scripts/buildCatalogIndex.js
// Liest PDFs aus ./catalogs, extrahiert Zeilen wie "54 Blutentnahme aus der Vene 4/I"
// und schreibt ./catalogs/index.json (pro Eintrag: payer, pos, title, points, notes, source).

const fs = require("fs");
const path = require("path");
const pdf = require("pdf-parse");

const CATALOG_DIR = path.join(__dirname, "..", "catalogs");
const OUT_FILE = path.join(CATALOG_DIR, "index.json");

// Dateiname -> Kostenträger
function guessPayer(filename) {
  const fn = filename.toLowerCase();
  if (fn.includes("oegk") || fn.includes("ökg") || fn.includes("ö g k")) return "ÖGK";
  if (fn.includes("bvaeb")) return "BVAEB";
  if (fn.includes("svs")) return "SVS";
  if (fn.includes("kuf")) return "KUF";
  return "UNBEKANNT";
}

// Regex-Kandidaten (versch. Layouts in den PDFs)
const lineRegexes = [
  // z.B. "54 Blutentnahme aus der Vene 4/I"
  /^\s*(\d{1,4}[a-z]?)\s+([A-Za-zÄÖÜäöüß().,%\-–/ ]{3,}?)\s+(\d+\s*\/\s*[IVX]+|\d+[.,]?\d*)\s*$/,
  // z.B. "56 Intramuskuläre Injektion 2/I" (mit zusätzlichen Worten rechts)
  /^\s*(\d{1,4}[a-z]?)\s+([A-Za-zÄÖÜäöüß().,%\-–/ ]{3,}?)\s+(\d+\s*\/\s*[IVX]+|\d+[.,]?\d*)\b.*$/,
  // BVAEB kann Buchstaben nach der Hauptnummer haben: "11a Subcutane Injektion 2"
  /^\s*(\d{1,3}[a-z])\s+([A-Za-zÄÖÜäöüß().,%\-–/ ]{3,}?)\s+(\d+[.,]?\d*)\s*$/
];

async function parsePdf(filePath) {
  const data = await pdf(fs.readFileSync(filePath));
  const payer = guessPayer(path.basename(filePath));

  const entries = [];
  const lines = data.text.split(/\r?\n/).map(s => s.replace(/\u00AD/g, "").trim()).filter(Boolean);

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " "); // normalisieren
    for (const rx of lineRegexes) {
      const m = line.match(rx);
      if (m) {
        const pos = (m[1] || "").trim();
        const title = (m[2] || "").trim();
        const pointsRaw = (m[3] || "").trim();
        // einfache Filter: keine reinen Kapitelüberschriften, Titel nicht zu kurz
        if (pos && title.length > 3) {
          entries.push({
            payer,
            pos,
            title,
            points: pointsRaw,
            notes: "",
            source: path.basename(filePath)
          });
          break;
        }
      }
    }

    // Zusatz: „nicht verrechenbar …“ und ähnliche Hinweise als notes anhängen
    if (/nicht verrechenbar|zusätzlich|nur einmal|limitiert|Hinweis/i.test(line)) {
      const last = entries[entries.length - 1];
      if (last && last.payer === payer) {
        last.notes = (last.notes ? last.notes + " " : "") + line;
      }
    }
  }

  return entries;
}

(async () => {
  const pdfs = fs.readdirSync(CATALOG_DIR).filter(f => f.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) {
    console.error("Keine PDFs im Ordner catalogs/ gefunden.");
    process.exit(1);
  }

  const all = [];
  for (const f of pdfs) {
    const filePath = path.join(CATALOG_DIR, f);
    console.log("→ Lese", f);
    try {
      const entries = await parsePdf(filePath);
      all.push(...entries);
    } catch (e) {
      console.warn("Fehler beim Lesen:", f, e.message);
    }
  }

  // nach payer+pos deduplizieren – letzten Eintrag siegt (meist mit notes)
  const dedup = {};
  for (const e of all) {
    dedup[`${e.payer}::${e.pos}`] = e;
  }
  const out = Object.values(dedup).sort((a, b) => (a.payer + a.pos).localeCompare(b.payer + b.pos));

  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), items: out }, null, 2), "utf8");
  console.log(`✓ ${out.length} Positionen nach ./catalogs/index.json geschrieben`);
})();