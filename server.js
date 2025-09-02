// server.js — Abrechnungshelfer Medizin (Express + Supabase-Auth + OpenAI chat.completions)

const Fuse = require("fuse.js");
const catalogIndex = require("./catalogs/index.json");
let rules = [];
try {
  rules = require("./scripts/rules/catalog_rules.json"); // optional
} catch { rules = []; }

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
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

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
      if (!ALLOWED_EMAILS.includes(email)) {
        return res.status(403).json({ error: "Nicht freigeschaltet" });
      }
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
  {
    role: "user",
    content: "Männlich, 52 Jahre, Hypertonie, Erstordination"
  },
  {
    role: "assistant",
    content:
`Rückfrage: Wurde ein Ruhe-EKG durchgeführt?

Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo
------- | ------------- | -------- | -----------
1C | Erstordination | 20 P | nur 1× pro Quartal
1D | Koordinationszuschlag | 10 P | bei Erstordination
300 | Blutdruckmessung | 5 P | Routine

Copy-Paste-Liste: 1C; 1D; 300`
  }
];

// === Helper: Payer erkennen + Normalisierung + Kandidaten ===
// robustere Normalisierung für Benutzereingaben (Umlaute, Leerzeichen, etc.)
function normalizeInput(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/[ä]/g, "ae")
    .replace(/[ö]/g, "oe")
    .replace(/[ü]/g, "ue")
    .replace(/[ß]/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

function detectPayer(text = "") {
  const n = normalizeInput(text);

  if (/\boegk\b/.test(n) || /\bgesundheitskasse\b/.test(n) || /\boe gk\b/.test(n)) return "ÖGK";
  if (/\bbvaeb\b/.test(n) || /\bbva\b/.test(n)) return "BVAEB";
  if (/\bsvs\b/.test(n)) return "SVS";
  if (/\bkuf\b/.test(n)) return "KUF";
  if (/\bmedrech\b/.test(n)) return "MEDRECH";

  return null;
}


function norm(s = "") {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Eingaben, die nur eine Dauer ohne Kontext enthalten (z.B. "über 20 Minuten")
function isBareDurationQuery(text = "") {
  const t = norm(text);
  // enthält Minuten/Stunden, aber keine typischen Leistungswörter
  const hasDuration = /(min|minute|stunden?|std)/.test(t);
  const hasKeywords = /(gespraech|angehorig|blut|harn|urin|ekg|labor|injek|sonogr|abstrich|check|vorsorge|ordination)/.test(t);
  return hasDuration && !hasKeywords;
}

// Synonyme für freie Eingaben
const SYNONYMS = {
  angehorigengesprach: ["gespraech mit angehoerigen", "angehoerigen-gespraech", "angehoerigen"],
  demenz: ["alzheimer", "kognitive stoerung", "gedaechtnisstoerung"],
  blutabnahme: ["venenblut", "blutentnahme", "blut aus der vene"],
  injektion: ["spritze"],
  ekg: ["ruhekardiogramm", "elektrokardiogramm"],
  harn: ["urin", "harnstreifen", "urintest"]
};

// optionale Hart-Regeln
function ruleMatches(text, r, payer) {
  if (r.payer && payer && r.payer !== payer) return false;
  const t = norm(text);
  if (r.whenAll && !r.whenAll.every(k => t.includes(norm(k)))) return false;
  if (r.whenAny && !r.whenAny.some(k => t.includes(norm(k)))) return false;
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

// Kandidaten finden (Fuse + Synonyme + Fallback)
function findCandidates(userText, payer, limit = 12) {
  let items = catalogIndex.items.filter(x => !payer || x.payer === payer);

  // Psych-GUARD: Psych-Leistungen nur zeigen, wenn der Usertext das nahelegt
  const nt = norm(userText);
  const looksPsych = /(psycho|depress|angst|krisenintervention|psychothera|psychiatr)/i.test(nt);
  if (!looksPsych) {
    items = items.filter(it => !/(psych|psychiatr|psychothera)/i.test(it.title));
  }

  const preferCodes = preferredByRules(userText, payer) || [];

  const q = norm(userText);
  const tokens = q.split(" ").filter(Boolean);
  const expanded = new Set(tokens);
  for (const tok of tokens) if (SYNONYMS[tok]) SYNONYMS[tok].forEach(v => expanded.add(norm(v)));
  const expandedQuery = Array.from(expanded).join(" ");

  const fuse = new Fuse(items, {
    includeScore: true,
    threshold: 0.6,
    distance: 200,
    ignoreLocation: true,
    keys: ["title"]
  });
  let found = fuse.search(expandedQuery).map(r => r.item);

  if (!found.length) {
    const toks = new Set(expandedQuery.split(" ").filter(t => t.length > 2));
    const scored = items.map(it => {
      const nt2 = norm(it.title);
      let overlap = 0; for (const t of toks) if (nt2.includes(t)) overlap++;
      return { it, overlap };
    }).filter(x => x.overlap > 0)
      .sort((a,b) => b.overlap - a.overlap)
      .map(x => x.it);
    found = scored;
  }

  if (preferCodes.length) {
    const pref = found.filter(x => preferCodes.includes(String(x.pos)));
    const rest = found.filter(x => !preferCodes.includes(String(x.pos)));
    found = [...pref, ...rest];
  }

  return found.slice(0, limit);
}

// --- AddOns: immer mitzudenkende Leistungen katalogsicher finden ---
function findByTitleContains(payer, patterns = []) {
  const pats = patterns.map((p) => norm(p));
  const items = catalogIndex.items.filter((x) => !payer || x.payer === payer);
  for (const it of items) {
    const t = norm(it.title);
    if (pats.some((p) => t.includes(p))) return it;
  }
  return null;
}

function ensureCandidate(candidates, item) {
  if (!item) return candidates;
  const has = candidates.some((c) => String(c.pos) === String(item.pos));
  if (!has) candidates.push(item);
  return candidates;
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
  for (const it of addOns) {
    if (it && !seen.has(String(it.pos))) {
      candidates.push(it);
      seen.add(String(it.pos));
    }
  }
  return candidates;
}

// Früh-Rückfragen-Heuristiken
// Früh-Rückfragen-Heuristiken
function earlyQuestion(userText = "") {
  const n = normalizeInput(userText);

  // Erkennung Blutentnahme
  const mentionsBloodDraw = /\b(blutabnahme|blutentnahme|abnahme .* blut|venenpunktion|venepunktion)\b/.test(n)
    || /\b(blut|venenblut)\b/.test(n);

  // Spezifität vorhanden?
  const hasVenous = /\b(vene|venoes|venenpunktion|venepunktion)\b/.test(n);
  const hasCapillary = /\b(kapillar|kapillarblut|fingerbeere|ohrlaeppchen)\b/.test(n);

  // Träger vorhanden?
  const payer = detectPayer(userText);
  const missingPayer = !payer;

  const questions = [];

  // Nur fragen, was wirklich fehlt:
  if (mentionsBloodDraw && !hasVenous && !hasCapillary) {
    questions.push("War es eine **venöse** oder **kapillare** Blutentnahme?");
  }
  if (mentionsBloodDraw && missingPayer) {
    questions.push("Bitte gib den **Versicherungsträger** an (z. B. ÖGK, BVAEB, SVS).");
  }

  // Weitere Heuristiken (Beispiele aus deinem ursprünglichen Code)
  if (/\b(gespraech|angehoerig)\b/.test(n) && !/\b(min|minute|stunden?|std|ueber 20|bis 20)\b/.test(n)) {
    questions.push("Wie lange hat das Angehörigengespräch gedauert? (**bis 20 Minuten** / **über 20 Minuten**)");
  }
  if (/\b(harn|urin|streifen)\b/.test(n) && !/\b(ord|ordination|labor)\b/.test(n)) {
    questions.push("Meinst du **Harnstreifentest in der Ordination** oder **Laboruntersuchung**?");
    if (missingPayer) questions.push("Bitte zusätzlich den **Versicherungsträger** angeben.");
  }

  return questions.length ? questions.join(" ") : null;
}

// === API ENDPOINT ===
app.post("/api/abrechnen", requireAuth, async (req, res) => {
  // 1) Eingabe & Basics prüfen
  const userInput = (req.body?.prompt || "").toString().trim();
  if (!userInput) return res.status(400).json({ error: "Fehlendes Feld: prompt" });
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Serverfehler: OPENAI_API_KEY fehlt" });

  // 2) Guard: Nur „Dauer“-Angaben ohne Kontext -> Rückfrage (KEIN Modell-Call)
  if (isBareDurationQuery(userInput)) {
    return res.json({
      output:
        "Rückfrage: Worum geht es genau? (z. B. Angehörigengespräch, Blutabnahme, EKG, Injektion …) Bitte kurz präzisieren."
    });
  }

  // 3) Payer erkennen & Kandidaten suchen
  const payer = detectPayer(userInput);
  let candidates = findCandidates(userInput, payer);

  // 4) AddOns vorschlagen (Erstordination, Koordinationszuschlag, Befundbericht, langer EKG-Streifen …)
  try {
    const addOns = deriveAddOns(userInput, payer);
    candidates = mergeCandidates(candidates, addOns);
  } catch { /* optional */ }

  // 5) Frühzeitige Rückfrage erzwingen, wenn unklar / zu wenig Treffer
  let preQ = earlyQuestion(userInput);
  if (!preQ && candidates.length < 3) {
    const v = candidates.slice(0, 6).map(c => `${c.pos} — ${c.title}`).join("\n");
    preQ = v
      ? `Unklar. Meintest du eine der folgenden Leistungen?\n${v}\nWenn keine passt: Bitte genauer eingeben (z. B. Träger, Technik, Dauer, Art).`
      : "Unklar. Bitte die gewünschte Leistung genauer beschreiben (z. B. Träger, Technik, Dauer, Art).";
  }
  if (preQ) return res.json({ output: preQ });

  // 6) Ohne Kandidaten -> freundlicher Fehler
  if (!candidates.length) {
    return res.status(400).json({
      error:
        "Keine passenden Katalogeinträge gefunden. Bitte präziser eingeben (z. B. „ÖGK, Blutentnahme aus der Vene“)."
    });
  }

  // 7) Gating-Regeln für das Modell (nur aus diesen Kandidaten wählen ODER zuerst Rückfragen stellen)
  const gatingRules = `
DU DARFST AUSSCHLIESSLICH AUS DIESEN KANDIDATEN AUSWÄHLEN ODER ZUERST RÜCKFRAGEN STELLEN:
${candidates.map(c => `- ${c.payer} | ${c.pos} | ${c.title} | ${c.points || ""}${c.notes ? " | " + c.notes : ""}`).join("\n")}
Wenn die Eingabe unklar ist, STELLE ZUERST GEZIELTE RÜCKFRAGEN (z. B. Gesprächsdauer, Träger, Technik).
Gib IMMER nur Pos.-Nrn. aus dieser Liste zurück, wenn du vorschlägst.
`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT + "\n" + gatingRules },
    ...FEW_SHOTS,
    { role: "user", content: userInput }
  ];

  // 8) Modell anfragen
  try {
    log("Starte OpenAI-Request", {
      model: OPENAI_MODEL,
      key: OPENAI_API_KEY ? OPENAI_API_KEY.slice(0, 7) + "…" + OPENAI_API_KEY.slice(-4) : "❌ kein Key",
      user: req.user?.email || "unbekannt"
    });

    // Node 20: global fetch vorhanden
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        max_completion_tokens: 1000,
        messages
      })
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

    // 9) Soft-Validierung: nur erlaubte Positionen
    const allowedSet = new Set(candidates.map(c => String(c.pos).toLowerCase()));
    const usedCodes = Array.from(new Set((output.match(/\b\d+[a-z]?\b/gi) || []).map(s => s.toLowerCase())));
    const illegalCodes = usedCodes.filter(x => !allowedSet.has(x));

    if (illegalCodes.length) {
      // Statt 422: Rückfrage + Kandidatenliste als Tabelle (freundlicher Flow)
      const rows = candidates.map(c =>
        `${c.pos} | ${c.title} | ${c.points || ""}${c.notes ? " | " + c.notes : ""}`
      ).join("\n");

      const clarification =
`Rückfrage: Welche Position ist gemeint? (Deine Antwort enthielt: ${illegalCodes.join(", ")})

Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo
------- | ------------- | -------- | -----------
${rows}

Copy-Paste-Liste: ${candidates.map(c => c.pos).join("; ")}`;

      return res.json({ output: clarification, usage: data?.usage || null });
    }

    // 10) Erfolg
    res.json({ output, usage: data?.usage || null });
  } catch (error) {
    log("Unhandled /api/abrechnen error:", error?.message || error);
    res.status(500).json({ error: error?.message || "Unbekannter Serverfehler" });
  }
});

// Start
app.listen(PORT, () => log(`Server läuft auf Port ${PORT}`));
