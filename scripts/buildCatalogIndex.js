// scripts/buildCatalogIndex.js
// Baut einen kombinierten JSON-Index aus allen PDFs in ./catalogs
// Ausgabe: ./catalogs/index.json  (items: [{ payer,pos,title,points,notes,source }])

const fs = require("fs");
const path = require("path");
const pdf = require("pdf-parse");

const CATALOG_DIR = path.join(__dirname, "..", "catalogs");
const OUT_FILE = path.join(CATALOG_DIR, "index.json");

// --- Utils ---
function guessPayer(filename) {
  const fn = filename.toLowerCase();
  // ÖGK (auch Landes-Varianten)
  if (/(oegk|ögk|oe-gk|ö\s*g\s*k|gesundheitskasse|gesamtvertrag|honorarkatalog)/i.test(fn)) return "ÖGK";
  // BVAEB
  if (/bvaeb/i.test(fn)) return "BVAEB";
  // SVS
  if (/\bsvs\b|sozialversicherungsanstalt/i.test(fn)) return "SVS";
  // KUF Tirol/Kärnten usw.
  if (/\bkuf\b|kaernten|kärnten|tirol/i.test(fn)) return "KUF";
  return "UNBEKANNT";
}

const SOFT_HYPHEN = /\u00AD/g;
const WHITE = /\s+/g;

// Punkte-/€-Muster (z. B. "5/II", "2/I", "20 P", "12,5", "12.5", "€ 14,30")
const POINTS_OR_EUR = /\d+\s*\/\s*[IVX]+|\d+\s*P|€\s*\d+[.,]?\d*|\d+[.,]?\d*/i;

// erlaubte Nummernformen: 12, 54, 300, 11a, 12c, 178v
const CODE_START = /^\s*(\d{1,4}[a-z]?)(?=\s)/i;

// Regex-Kandidaten (mit optionaler Spalte wie "AL" vor den Punkten)
const lineRegexes = [
  // z.B. "12c Demenzpatienten – Angehörigengespräch AL 5/II"
  /^\s*(\d{1,4}[a-z]?)\s+(.+?)\s+(?:[A-ZÄÖÜ]{1,3}\s+)?(\d+\s*\/\s*[IVX]+|\d+\s*P|€\s*\d+[.,]?\d*|\d+[.,]?\d*)\s*$/,
  // z.B. "56 Intramuskuläre Injektion 2/I ..." (ohne Zusatzspalte)
  /^\s*(\d{1,4}[a-z]?)\s+(.+?)\s+(\d+\s*\/\s*[IVX]+|\d+\s*P|€\s*\d+[.,]?\d*|\d+[.,]?\d*)\b.*$/,
  // z.B. "11a Subcutane Injektion 2"
  /^\s*(\d{1,3}[a-z])\s+(.+?)\s+(\d+[.,]?\d*)\s*$/
];

// --- PDF -> Einträge ---
async function parsePdf(filePath) {
  const buf = fs.readFileSync(filePath);
  const data = await pdf(buf);
  const payer = guessPayer(path.basename(filePath));

  const entries = [];
  const rawLines = (data.text || "")
    .split(/\r?\n/)
    .map(s => s.replace(SOFT_HYPHEN, "").trim())
    .filter(Boolean);

  // über die Zeilen laufen; nur Zeilen, die mit Code beginnen, starten einen Eintrag
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i].replace(WHITE, " ");

    if (!CODE_START.test(line)) continue;

    // Umbrüche „Ange- / hörigengespräch“ etc. zusammenkleben (max. 2 Folgezeilen)
    let glued = line.replace(/[-–]\s*$/, ""); // Zeilenend-Bindestrich entfernen
    let j = i + 1;

    // solange keine Punkte/€ erkennbar, Folgelinien anhängen
    while (j < rawLines.length && (j <= i + 2) && !POINTS_OR_EUR.test(glued)) {
      const next = rawLines[j].replace(WHITE, " ").replace(/[-–]\s*$/, "");
      // wenn nächste Zeile bereits mit neuem Code beginnt → nicht anhängen
      if (CODE_START.test(next)) break;
      glued = (glued + " " + next).replace(WHITE, " ").trim();
      j++;
    }

    // gegen alle Linien-Regex matchen
    let matched = false;
    for (const rx of lineRegexes) {
      const m = glued.match(rx);
      if (!m) continue;

      const pos = (m[1] || "").trim();
      const title = (m[2] || "").trim();
      const points = (m[3] || "").trim();

      if (pos && title && title.length > 3) {
        entries.push({
          payer,
          pos,
          title,
          points,
          notes: "",
          source: path.basename(filePath)
        });
        matched = true;
      }
      break;
    }

    // nachfolgende Hinweiszeile mit einsammeln
    if (matched && j < rawLines.length) {
      const hint = rawLines[j].replace(WHITE, " ");
      if (/nicht verrechenbar|nur einmal|höchstens|limitiert|dokumentier|Hinweis/i.test(hint)) {
        entries[entries.length - 1].notes = hint;
        i = j; // Hinweiszeile als „verbraucht“ markieren
      } else {
        i = j - 1; // bis zur letzten verklebten Zeile vorspulen
      }
    } else if (matched) {
      i = j - 1;
    }
  }

  return entries;
}

// --- Main ---
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
      const items = await parsePdf(filePath);
      all.push(...items);
    } catch (e) {
      console.warn("Fehler beim Lesen:", f, e.message);
    }
  }

  // Deduplizieren nach payer+pos (letzter gewinnt, i.d.R. mit Notes)
  const map = new Map();
  for (const e of all) map.set(`${e.payer}::${e.pos}`, e);
  const out = Array.from(map.values()).sort((a, b) =>
    (a.payer + String(a.pos)).localeCompare(b.payer + String(b.pos))
  );

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    items: out
  }, null, 2), "utf8");

  console.log(`✓ ${out.length} Positionen nach ${path.relative(process.cwd(), OUT_FILE)} geschrieben`);
})();