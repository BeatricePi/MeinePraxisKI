// server.js — Abrechnungshelfer Medizin (Express + Supabase-Auth + OpenAI chat.completions)

const Fuse = require("fuse.js");
const catalogIndex = require("./catalogs/index.json");

// optionale Regeln
let rules = [];
try { rules = require("./scripts/rules/catalog_rules.json"); } catch { rules = []; }

// Synonyme extern laden (fallback leer)
let SYNONYMS = {};
try { SYNONYMS = require("./catalogs/synonyms.json"); } catch { SYNONYMS = {}; }

const express = require("express");
const path = require("path");
const jwt = require("jsonwebtoken");
const cors = require("cors");

// === ENV ===
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Modell per ENV überschreibbar
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Static Frontend
app.use(express.static(path.join(__dirname, "public")));

// kleine Log-Hilfe
const log = (...a) => console.log("[APP]", ...a);
const DEBUG_INTENT = process.env.DEBUG_INTENT === "1";
const dbg = (...a) => { if (DEBUG_INTENT) console.log("[INTENT]", ...a); };

// Health-Checks
app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.get("/api/check", (_req, res) => {
  const keyPreview = OPENAI_API_KEY ? OPENAI_API_KEY.slice(0, 7) + "…" + OPENAI_API_KEY.slice(-4) : "❌ kein Key";
  res.json({
    databaseUrl: process.env.DATABASE_URL ? "✅ vorhanden" : "❌ fehlt",
    openAiKey: OPENAI_API_KEY ? `✅ ${keyPreview}` : "❌ fehlt",
    supabaseUrl: SUPABASE_URL ? "✅ vorhanden" : "❌ fehlt",
    supabaseJwtSecret: SUPABASE_JWT_SECRET ? "✅ vorhanden" : "❌ fehlt",
    allowedEmails: ALLOWED_EMAILS.length ? `✅ ${ALLOWED_EMAILS.length}` : "—",
    model: OPENAI_MODEL,
  });
});

// Supabase-Auth Middleware
function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Kein Token" });
    if (!SUPABASE_JWT_SECRET) return res.status(500).json({ error: "Serverfehler: SUPABASE_JWT_SECRET fehlt" });

    const payload = jwt.verify(token, SUPABASE_JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };

    if (ALLOWED_EMAILS.length) {
      const email = (req.user.email || "").toLowerCase();
      if (!ALLOWED_EMAILS.includes(email)) return res.status(403).json({ error: "Nicht freigeschaltet" });
    }
    next();
  } catch {
    return res.status(401).json({ error: "Ungültiges/abgelaufenes Token" });
  }
}

// === SYSTEM PROMPT (Hintergrund + Regeln) ===
const SYSTEM_PROMPT = `
Du bist der „Abrechnungshelfer Medizin“ für Ärzt:innen, die mit Innomed arbeiten.
Deine Aufgabe:
- Vorschläge ausschließlich aus den hochgeladenen Honorarkatalogen (ÖGK, BVAEB, SVS, Tarmed, GOÄ, Medrech, KUF usw.).
- Keine Fantasie-Nummern oder fremde Kataloge.
- IMMER angeben: exakte Positionsnummer, Original-Leistungstext, Punkte/€.
- Ton: freundlich, präzise, medizinisch korrekt. Keine Patientendaten speichern.
- Stelle gezielte Rückfragen bei Unsicherheit (z. B. EKG ja/nein, Gesprächsdauer, Labor vs. PoC, Technik).

Immer beachten (sofern in Katalog vorhanden & kombinierbar):
- Erstordination
- Koordinationszuschlag
- Befundbericht
- Lokalanästhesie
- Langer EKG-Streifen
- Keine Doppelabrechnung. Fehlende Infos niemals raten, sondern nachfragen.

WICHTIG bei unpräziser Anfrage („Harn“, „Streifen“, „Urin“, „Kontrolle“, „Check“):
- ZUERST Rückfragen: z. B. Art der Untersuchung, Ort (Ordination vs. Labor), Dauer, Versicherungsträger.
- NIE eine Position nennen, die nicht eindeutig im gültigen Katalog steht.

Ausgabeformat:
1) Tabelle „Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo“
2) Danach „Copy-Paste-Liste: <PosNr; PosNr; …>“
`;

// === FEW SHOTS (kurz) ===
const FEW_SHOTS = [
  { role: "user", content: "Männlich, 52 Jahre, Hypertonie, Erstordination" },
  { role: "assistant", content: `Rückfrage: Wurde ein Ruhe-EKG durchgeführt?

Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo
------- | ------------- | -------- | -----------
1C | Erstordination | 20 P | nur 1× pro Quartal
1D | Koordinationszuschlag | 10 P | bei Erstordination
300 | Blutdruckmessung | 5 P | Routine

Copy-Paste-Liste: 1C; 1D; 300`},
];

// === Helper: Normalisierung, Payer, Synonyme ===
function mapToCanonicalPayer(raw = "") {
  // eigene, lokale Normalisierung (keine Abhängigkeit von norm())
  const t = String(raw)
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/\boegk\b|\bgesundheitskasse\b|\boe gk\b|\boesterreichische gesundheitskasse\b/.test(t)) return "ÖGK";
  if (/\bbvaeb\b|\bbva\b|\bbeamten\b|\beisenbahn\b|\bbergbau\b/.test(t)) return "BVAEB";
  if (/\bsvs\b|\bselbststaendigen\b|\bbauern\b|\bgewerbe\b/.test(t)) return "SVS";
  // korrigiert: "krankenfuersorge" (ohne Tippfehler/CharClass)
  if (/\bkfa\b|\bkrankenfuersorge\b|\bwiener kfa\b/.test(t)) return "KFA";
  if (/\bkuf\b/.test(t)) return "KUF";
  if (/\bmedrech\b/.test(t)) return "MEDRECH";
  return raw || null;
}

function samePayer(a, b) {
  if (!a || !b) return false;
  return mapToCanonicalPayer(a) === mapToCanonicalPayer(b);
}

const stripDiacritics = (s = "") => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
function norm(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/[ä]/g, "ae").replace(/[ö]/g, "oe").replace(/[ü]/g, "ue").replace(/[ß]/g, "ss")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// **Robuste Payer-Erkennung (inkl. Synonyme)**
const PAYER_SYNONYMS = {
  "ÖGK": ["oegk", "ogk", "oe gk", "gesundheitskasse", "oesterreichische gesundheitskasse", "krankenkasse"],
  "BVAEB": ["bvaeb", "bva", "beamten", "eisenbahn", "bergbau"],
  "SVS": ["svs", "selbststaendigen", "bauern", "gewerbe"],
  "KFA": ["kfa", "krankenfuerorge", "krankenfuerorgeanstalt", "wiener kfa", "krankenfürsorge", "krankenfürsorgeanstalt"],
  "KUF": ["kuf"],
  "MEDRECH": ["medrech"]
};
function extractPayerFromText(text = "") {
  const n = ` ${norm(text)} `;
  for (const [canon, syns] of Object.entries(PAYER_SYNONYMS)) {
    for (const raw of [canon, ...syns]) {
      const token = ` ${norm(raw)} `;
      if (n.includes(token)) return canon;
    }
  }
  return null;
}

function extractCanonicalPayer(text = "") {
  const p = extractPayerFromText(text);
  return p ? mapToCanonicalPayer(p) : null;
}

function extractCanonicalPayer(text = "") {
  const p = extractPayerFromText(text);
  return p ? mapToCanonicalPayer(p) : null;
}

// Eingaben, die nur eine Dauer ohne Kontext enthalten (z.B. "über 20 Minuten")
function isBareDurationQuery(text = "") {
  const t = norm(text);
  const hasDuration = /\b(min|minute|stunden?|std)\b/.test(t);
  const hasKeywords = /\b(gespraech|angehorig|blut|harn|urin|ekg|labor|injek|sonogr|abstrich|check|vorsorge|ordination)\b/.test(t);
  return hasDuration && !hasKeywords;
}

// „Nur Payer“-Eingaben (z. B. nur „ÖGK“ / „oegk“)
function isPayerOnlyQuery(text = "") {
  const t = norm(text);
  // alles außer payer-wörtern raus
  const withoutPayerWords = Object.values(PAYER_SYNONYMS).flat()
    .concat(Object.keys(PAYER_SYNONYMS))
    .map(norm)
    .reduce((acc, w) => acc.replace(new RegExp(`\\b${w}\\b`, "g"), " "), ` ${t} `)
    .replace(/\s+/g, " ")
    .trim();
  // wenn danach nichts Sinnvolles übrig bleibt → Payer-only
  return withoutPayerWords.length === 0;
}

function getSynonymsFor(token = "") {
  const key = norm(token);
  const arr = SYNONYMS[key];
  return Array.isArray(arr) ? arr : [];
}
function expandQueryWithSynonyms(q = "") {
  const toks = norm(q).split(" ").filter(Boolean);
  const expanded = new Set(toks);
  for (const tok of toks) for (const s of getSynonymsFor(tok)) expanded.add(norm(s));
  return Array.from(expanded).join(" ");
}

// optionale Hart-Regeln
function ruleMatches(text, r, payer) {
  if (r.payer && payer && r.payer !== payer) return false;
  const t = norm(text);
  if (r.whenAll && !r.whenAll.every((k) => t.includes(norm(k)))) return false;
  if (r.whenAny && !r.whenAny.some((k) => t.includes(norm(k)))) return false;
  return true;
}
function preferredByRules(userText, payer) {
  try {
    if (Array.isArray(rules)) {
      for (const r of rules) if (ruleMatches(userText, r, payer)) return (r.prefer || []).map(String);
    }
  } catch {}
  return [];
}

// --- Blutabnahme-Intent & Flags (arbeiten auf norm()-Text) ---
function bloodIntent(n) {
  // erkennt Singular + Plural + Varianten
  return (
    /\b(blutabnahme(n)?|blutentnahme(n)?)\b/.test(n) ||
    /\b(venose|venoese|venos|vene|venenpunktion|venepunktion)\b/.test(n) ||
    /\b(kapillar|kapillarblut|fingerbeere|ohrlaeppchen)\b/.test(n)
  );
}
function hasVenousFlag(n) {
  return /\b(venose|venoese|venos|vene|venenpunktion|venepunktion)\b/.test(n);
}
function hasCapillaryFlag(n) {
  return /\b(kapillar|kapillarblut|fingerbeere|ohrlaeppchen)\b/.test(n);
}

function ntIncludes(it, needle) { return norm(it.title).includes(norm(needle)); }

// **Enges Blutabnahme-Filterset**, damit keine fachfremden Treffer auftauchen
function restrictToBloodDraw(items) {
  const BLOOD_PATTERNS = [
    "blutabnahme","blutabnahmen","blutentnahme","blutentnahmen",
    "entnahme von blut","vene","venoes","venose","venoese",
    "kapillar","kapillarblut","fingerbeere","ohrlaeppchen"
  ].map(norm);
  return items.filter((it) => {
    const t = norm(it.title);
    return BLOOD_PATTERNS.some((p) => t.includes(p));
  });
}

// --- Kandidaten finden (Fuse + Synonyme + Fallback) ---
function findCandidates(userText, payer, limit = 12) {
let items = catalogIndex.items.filter((x) => !payer || samePayer(x.payer, payer));
// Setting-Filter (Ordination vs. Labor)
const { inOrd, inLab } = detectSetting(norm(userText));
if (inOrd && !inLab) {
  items = items.filter((it) => !/\blabor\b/i.test(it.title));
} else if (inLab && !inOrd) {
  items = items.filter((it) => /\blabor\b/i.test(it.title));
}
  // Psych-GUARD
  const nt = norm(userText);
  const looksPsych = /(psycho|depress|angst|krisenintervention|psychothera|psychiatr)/i.test(nt);
  if (!looksPsych) items = items.filter((it) => !/(psych|psychiatr|psychothera)/i.test(it.title));

  const preferCodes = preferredByRules(userText, payer) || [];

  // Intent Blutabnahme: liste eng einschränken (kein Imaging, keine EKGs etc.)
  const intentIsBlood = bloodIntent(nt);
  const vFlag = hasVenousFlag(nt);
  const kFlag = hasCapillaryFlag(nt);
  const mentionsInjection = /\binjek|spritze\b/.test(nt);

  if (intentIsBlood) {
    items = restrictToBloodDraw(items);
    // falls dennoch nichts passendes im Titel „Kapillar“/„Vene“ steht, fuzzy bleibt aber auf Blut-Themen
  }
  if (intentIsBlood && !mentionsInjection) {
    items = items.filter((it) => !/injektion/i.test(it.title));
  }

  // Deterministische „exact-first“
  if (intentIsBlood && vFlag) {
    const exactVene = items.find((it) => ntIncludes(it, "blutentnahme aus der vene"));
    if (exactVene) return [exactVene].slice(0, limit);
  }
  if (intentIsBlood && kFlag) {
    const exactKap = items.find((it) => ntIncludes(it, "kapillar"));
    if (exactKap) return [exactKap].slice(0, limit);
  }

  // Synonym-Expansion für fuzzy Suche
  const expandedQuery = expandQueryWithSynonyms(userText);
  const fuse = new Fuse(items, {
    includeScore: true,
    threshold: 0.5,           // etwas strenger
    distance: 120,
    ignoreLocation: true,
    keys: ["title"],
  });
  let found = fuse.search(expandedQuery).map((r) => r.item);

  // Notfall: einfacher Overlap
  if (!found.length) {
    const toks = new Set(expandedQuery.split(" ").filter((t) => t.length > 2));
    const scored = items
      .map((it) => {
        const nt2 = norm(it.title);
        let overlap = 0;
        for (const t of toks) if (nt2.includes(t)) overlap++;
        return { it, overlap };
      })
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .map((x) => x.it);
    found = scored;
  }

  if (preferCodes.length) {
    const pref = found.filter((x) => preferCodes.includes(String(x.pos)));
    const rest = found.filter((x) => !preferCodes.includes(String(x.pos)));
    found = [...pref, ...rest];
  }

  // **Letzter Schutz**: Wenn Blut-Intent erkannt wurde, entferne fachfremde Resttreffer.
  if (intentIsBlood) {
    found = restrictToBloodDraw(found);
  }

  return found.slice(0, limit);
}

// --- AddOns: immer mitzudenkende Leistungen katalogsicher finden ---
function findByTitleContains(payer, patterns = []) {
  const pats = patterns.map((p) => norm(p));
const items = catalogIndex.items.filter((x) => !payer || samePayer(x.payer, payer));
  for (const it of items) {
    const t = norm(it.title);
    if (pats.some((p) => t.includes(p))) return it;
  }
  return null;
}

function deriveAddOns(userText, payer) {
  const add = [];
  const t = norm(userText);

  if (/(erst|erstord|erstvorstellung|neu\b|neu-patient)/.test(t)) {
    const eo = findByTitleContains(payer, ["erstordination"]);
    const kz = findByTitleContains(payer, ["koordinationszuschlag", "koordination"]);
    if (eo) add.push(eo);
    if (kz) add.push(kz);
  }

  if (/(befund|bericht|arztbrief)/.test(t)) {
    const bb = findByTitleContains(payer, ["befundbericht", "befund-bericht", "bericht"]);
    if (bb) add.push(bb);
  }

  if (/(ekg)/.test(t) && /(lang|streifen|verl|minute|min|24|holter)/.test(t)) {
    const ls = findByTitleContains(payer, ["langer ekg", "ekg lang", "langstreifen", "verlangerter ekg"]);
    if (ls) add.push(ls);
  }

  return add;
}

function mergeCandidates(candidates, addOns) {
  const seen = new Set(candidates.map((c) => String(c.pos)));
  for (const it of addOns) if (it && !seen.has(String(it.pos))) { candidates.push(it); seen.add(String(it.pos)); }
  return candidates;
}

// Früh-Rückfragen (nur wenn Infos fehlen)
function earlyQuestion(userText = "", payerDetected = null) {
  const n = norm(userText);
  const intent = bloodIntent(n);
  const vFlag = hasVenousFlag(n);
  const kFlag = hasCapillaryFlag(n);
  const missingPayer = !payerDetected;

  const questions = [];
  if (intent && !vFlag && !kFlag) questions.push("War es eine **venöse** oder **kapillare** Blutentnahme?");
  if (intent && missingPayer) questions.push("Bitte gib den **Versicherungsträger** an (z. B. ÖGK, BVAEB, SVS).");

  if (/\b(gespraech|angehoerig)\b/.test(n) && !/\b(min|minute|stunden?|std|ueber 20|bis 20)\b/.test(n)) {
    questions.push("Wie lange hat das Angehörigengespräch gedauert? (**bis 20 Minuten** / **über 20 Minuten**)");
  }
  if (/\b(harn|urin|streifen)\b/.test(n) && !/\b(ord|ordination|labor)\b/.test(n)) {
    questions.push("Meinst du **Harnstreifentest in der Ordination** oder **Laboruntersuchung**?");
    if (missingPayer) questions.push("Bitte zusätzlich den **Versicherungsträger** angeben.");
  }
  return questions.length ? questions.join(" ") : null;
}

// ------------------ Follow-up Kontext (5 Minuten) ------------------
const FOLLOWUP_TTL_MS = 5 * 60 * 1000;
const sessionStore = new Map(); // key -> { prompt, ts }
function sessionKey(req) { return req?.user?.id || req?.user?.email || req.ip; }
function getPendingPrompt(req) {
  const k = sessionKey(req); const s = sessionStore.get(k);
  if (s && Date.now() - s.ts < FOLLOWUP_TTL_MS) return s.prompt;
  sessionStore.delete(k); return null;
}
function setPendingPrompt(req, prompt) { sessionStore.set(sessionKey(req), { prompt, ts: Date.now() }); }
function clearPendingPrompt(req) { sessionStore.delete(sessionKey(req)); }
// -------------------------------------------------------------------

// === API ENDPOINT ===
app.post("/api/abrechnen", requireAuth, async (req, res) => {
  // 1) Eingabe & Basics prüfen
  let userInput = (req.body?.prompt || "").toString().trim();
  if (!userInput) return res.status(400).json({ error: "Fehlendes Feld: prompt" });
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Serverfehler: OPENAI_API_KEY fehlt" });

  // Follow-up: vorherige offene Frage + neue Kurzantwort mergen
  const pending = getPendingPrompt(req);
  if (pending) { userInput = `${pending} ${userInput}`.trim(); clearPendingPrompt(req); }

  // 2) Guard: Nur „Dauer“-Angaben ohne Kontext -> Rückfrage (KEIN Modell-Call)
  if (isBareDurationQuery(userInput)) {
    setPendingPrompt(req, userInput);
    return res.json({ output: "Rückfrage: Worum geht es genau? (z. B. Angehörigengespräch, Blutabnahme, EKG, Injektion …) Bitte kurz präzisieren." });
  }

  // 3) Payer aus Text herausziehen, falls nicht explizit angegeben
let payer = req.body?.payer || null;
if (!payer) payer = extractCanonicalPayer(userInput);
else payer = mapToCanonicalPayer(payer);
dbg("payer=", payer, "indexPayers=", Array.from(new Set(
  catalogIndex.items.map(i => mapToCanonicalPayer(i.payer))
)));
  // 3a) **Payer-only**: wenn Eingabe praktisch nur den Träger enthält → kurze Präzisierung, KEINE breite Kandidatenliste
  if (payer && isPayerOnlyQuery(userInput)) {
    setPendingPrompt(req, `(${payer})`); // Kontext merken
    return res.json({ output: `Rückfrage: Welche **Leistung** ist gemeint? (z. B. „Blutabnahme venös“ oder „Blutabnahme kapillar“) — Träger erkannt: **${payer}**.` });
  }

  // 3b) Deterministisch: Blutabnahme (venös/kapillar) VOR jeder breiten Suche
  {
  const nt = norm(userInput);
  const intent = bloodIntent(nt);
  const vFlag = hasVenousFlag(nt);
  const kFlag = hasCapillaryFlag(nt);
  const { inOrd, inLab } = detectSetting(nt);

  if (intent && payer) {
    let items = catalogIndex.items.filter((x) => !payer || samePayer(x.payer, payer));

    // Ordination vs. Labor strikt trennen
    if (inOrd && !inLab) {
      items = items.filter((it) => !/\blabor\b/i.test(it.title));
    } else if (inLab && !inOrd) {
      items = items.filter((it) => /\blabor\b/i.test(it.title));
    }

    // Exakt „Blutentnahme aus der Vene“ bzw. Kapillar bevorzugen
    const matchVene = (t) => /(^|\b)blutentnahme aus der vene(\b|$)/i.test(t);
    const matchKap  = (t) => /\b(kapillar|kapillarblut)\b/i.test(t);

    const exactVene = vFlag ? items.find((it) => matchVene(it.title)) : null;
    const exactKap  = kFlag ? items.find((it) => matchKap(it.title))  : null;

    // Fallback: Ordination + Blut → Vene bevorzugen
    let exact = exactVene || exactKap;
    if (!exact && intent && inOrd && !inLab) {
      exact = items.find((it) => matchVene(it.title));
    }

    if (exact) {
      const rows = `${exact.pos} | ${exact.title} | ${exact.points || ""}${exact.notes ? " | " + exact.notes : ""}`;
      const out = `Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo
------- | ------------- | -------- | -----------
${rows}

Copy-Paste-Liste: ${exact.pos}`;
      return res.json({ output: out });
    }
  }
}


  // 3c) Kandidaten für LLM/Validierung (stark eingegrenzt bei Blut-Intent)
  let candidates = findCandidates(userInput, payer);

  // 4) AddOns vorschlagen (nur wenn bereits thematisch passend)
  try {
    const addOns = deriveAddOns(userInput, payer);
    // Blut-Intent: keine add-ons mischen, außer sie sind wirklich orthogonal
    const nt = norm(userInput);
    if (!bloodIntent(nt)) candidates = mergeCandidates(candidates, addOns);
  } catch {}

  // 5) Rückfragen NUR wenn earlyQuestion etwas vermisst ODER gar keine Kandidaten
  let preQ = earlyQuestion(userInput, payer);
  if (!preQ && candidates.length === 0) {
    preQ = "Unklar. Bitte die gewünschte Leistung genauer beschreiben (z. B. Träger, Technik, Dauer, Art).";
  }
  if (preQ) {
    setPendingPrompt(req, userInput);
    return res.json({ output: preQ });
  }

  // 6) Ohne Kandidaten -> freundlicher Fehler
 if (!candidates.length) {
  setPendingPrompt(req, userInput);
  return res.status(400).json({
    error:
      "Keine passenden Katalogeinträge gefunden. Bitte präziser eingeben (z. B. „ÖGK, Blutentnahme aus der Vene“).",
  });
}

  // 7) Gating-Regeln für das Modell
  const gatingRules = `
DU DARFST AUSSCHLIESSLICH AUS DIESEN KANDIDATEN AUSWÄHLEN ODER ZUERST RÜCKFRAGEN STELLEN:
${candidates.map((c) => `- ${c.payer} | ${c.pos} | ${c.title} | ${c.points || ""}${c.notes ? " | " + c.notes : ""}`).join("\n")}
Wenn die Eingabe unklar ist, STELLE ZUERST GEZIELTE RÜCKFRAGEN (z. B. Gesprächsdauer, Träger, Technik).
Gib IMMER nur Pos.-Nrn. aus dieser Liste zurück, wenn du vorschlägst.
`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT + "\n" + gatingRules },
    ...FEW_SHOTS,
    { role: "user", content: userInput },
  ];

  // 8) Modell anfragen
  try {
    log("Starte OpenAI-Request", {
      model: OPENAI_MODEL,
      key: OPENAI_API_KEY ? OPENAI_API_KEY.slice(0, 7) + "…" + OPENAI_API_KEY.slice(-4) : "❌ kein Key",
      user: req.user?.email || "unbekannt",
    });

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.2, max_completion_tokens: 1000, messages }),
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text().catch(() => "");
      log("OpenAI-Fehler", openaiRes.status, errBody);
      if (openaiRes.status === 429 && /insufficient_quota/i.test(errBody)) {
        return res.status(502).json({ error: "OpenAI-Kontingent erschöpft (API-Billing prüfen)." });
      }
      return res.status(502).json({ error: `OpenAI-Fehler ${openaiRes.status}: ${errBody || "keine Details"}` });
    }

    const data = await openaiRes.json();
    const output = data?.choices?.[0]?.message?.content?.trim() || "";
    if (!output) return res.status(502).json({ error: "Leere Antwort vom Modell." });

    // 9) Soft-Validierung
    const allowedSet = new Set(candidates.map((c) => String(c.pos).toLowerCase()));
    const usedCodes = Array.from(new Set((output.match(/\b\d+[a-z]?\b/gi) || []).map((s) => s.toLowerCase())));
    const illegalCodes = usedCodes.filter((x) => !allowedSet.has(x));

    if (illegalCodes.length) {
      const rows = candidates.map((c) => `${c.pos} | ${c.title} | ${c.points || ""}${c.notes ? " | " + c.notes : ""}`).join("\n");
      const clarification = `Rückfrage: Welche Position ist gemeint? (Deine Antwort enthielt: ${illegalCodes.join(", ")})

Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo
------- | ------------- | -------- | -----------
${rows}

Copy-Paste-Liste: ${candidates.map((c) => c.pos).join("; ")}`;
      setPendingPrompt(req, userInput);
      return res.json({ output: clarification, usage: data?.usage || null });
    }

    // 10) Erfolg
    clearPendingPrompt(req);
    res.json({ output, usage: data?.usage || null });
  } catch (error) {
    log("Unhandled /api/abrechnen error:", error?.message || error);
    setPendingPrompt(req, userInput);
    res.status(500).json({ error: error?.message || "Unbekannter Serverfehler" });
  }
});

// Start
app.listen(PORT, () => log(`Server läuft auf Port ${PORT}`));
