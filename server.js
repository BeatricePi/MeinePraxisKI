// server.js — Abrechnungshelfer Medizin (Express + Supabase-Auth + OpenAI chat.completions)

const Fuse = require("fuse.js");
const catalogIndex = require("./catalogs/index.json");
const rules = require("./scripts/rules/catalog_rules.json"); // Pfad beachten

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
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

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

// === SYSTEM PROMPT ===
const SYSTEM_PROMPT = `
Du bist der „Abrechnungshelfer Medizin“ für Ärzt:innen in Österreich.

ZWECK
- Unterstütze Allgemeinmediziner:innen (Innomed), Leistungen korrekt/ vollständig abzurechnen.
- Nutze ausschließlich die hinterlegten Honorarkataloge (ÖGK, SVS, BVAEB, Medrech, KUF etc.).

REGELN
- Vorschläge NUR aus den hinterlegten Katalogen.
- IMMER nennen: exakte Positionsnummer, Original-Leistungstext, Punkte/€.
- Stelle gezielte Rückfragen (z. B. EKG ja/nein, Gesprächsdauer, Labor, Träger).
- Achte auf Kombinierbarkeit / Limitierungen (z. B. 1×/Quartal).
- Keine Fantasie-Nummern, nichts „erraten“.
- Keine Patientendaten speichern.

DATENKONTEXT
- ÖGK Gesamtvertrag & Honorarkatalog, BVAEB Honorarordnung (ab 05/2024),
  SVS (Landw./Gewerbe), Sonderkataloge (Medrech, SVA-vertragslos, Tiroler KUF).

FEHLERBEHANDLUNG
- Unklare Diagnose/Träger: zuerst nachfragen.
- Rechtlich unklar: „Bitte mit der Kasse abklären.“

AUSGABEFORMAT
1) Kompakte Tabelle:
   Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo
2) Danach Copy-Paste-Liste der Positionsnummern (z. B. 1C; 1D; 300).
`;

// === FEW-SHOT BEISPIELE ===
const FEW_SHOTS = [
  {
    role: "user",
    content: "Männlich, 52 Jahre, Hypertonie, Erstordination",
  },
  {
    role: "assistant",
    content: `Rückfrage: Wurde ein Ruhe-EKG gemacht?

Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo
------- | ------------- | -------- | -----------
1C | Erstordination | 20 P | nur 1× pro Quartal
1D | Koordinationszuschlag | 10 P | bei Erstordination
300 | Blutdruckmessung | 5 P | Routine

Copy-Paste-Liste: 1C; 1D; 300`,
  },
  {
    role: "user",
    content: "weibl. Patientin, 28 J., Juckreiz im Vaginalbereich, Verdacht auf Soor",
  },
  {
    role: "assistant",
    content: `Rückfrage: Wurde ein Abstrich gemacht?

Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo
------- | ------------- | -------- | -----------
200 | Mikroskopische Untersuchung | 5 P | Abstrich erforderlich
201 | Pilznachweis | 8 P | bei Verdacht Soor

Copy-Paste-Liste: 200; 201`,
  },
];

// === Helper: Payer erkennen + Normalisierung + Kandidaten ===
function detectPayer(text) {
  const t = (text || "").toLowerCase();
  if (/(ö\s*g\s*k|ögk|oegk|gesundheitskasse)/i.test(t)) return "ÖGK";
  if (/bvaeb/i.test(t)) return "BVAEB";
  if (/svs/i.test(t)) return "SVS";
  if (/kuf/i.test(t)) return "KUF";
  return null;
}

function norm(s = "") {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SYNONYMS = {
  angehorigengesprach: ["gespraech mit angehoerigen", "angehoerigen-gespraech", "angehoerigen"],
  demenz: ["alzheimer", "kognitive stoerung", "gedaechtnisstoerung"],
  blutabnahme: ["venenblut", "blutentnahme"],
  injektion: ["spritze"],
};

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

function findCandidates(userText, payer, limit = 12) {
  const items = catalogIndex.items.filter((x) => !payer || x.payer === payer);

  // Regel-getriebene Favoriten
  const preferCodes = preferredByRules(userText, payer);

  // Query + Synonyme
  const q = norm(userText);
  const tokens = q.split(" ").filter(Boolean);
  const expandedTokens = new Set(tokens);
  for (const tok of tokens) {
    if (SYNONYMS[tok]) SYNONYMS[tok].forEach((s) => expandedTokens.add(norm(s)));
  }
  const expandedQuery = Array.from(expandedTokens).join(" ");

  // Fuzzy
  const fuse = new Fuse(items, {
    includeScore: true,
    threshold: 0.6,
    distance: 200,
    ignoreLocation: true,
    keys: ["title"],
  });
  let found = fuse.search(expandedQuery).map((r) => r.item);

  // Fallback: Token-Overlap
  if (!found.length) {
    const toks = new Set(expandedQuery.split(" ").filter((t) => t.length > 2));
    const scored = items
      .map((it) => {
        const nt = norm(it.title);
        let overlap = 0;
        for (const t of toks) if (nt.includes(t)) overlap++;
        return { it, overlap };
      })
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .map((x) => x.it);
    found = scored;
  }

  // Favoriten nach vorne
  if (preferCodes.length) {
    const pref = found.filter((x) => preferCodes.includes(String(x.pos)));
    const rest = found.filter((x) => !preferCodes.includes(String(x.pos)));
    found = [...pref, ...rest];
  }

  return found.slice(0, limit);
}

// === API ENDPOINT ===
app.post("/api/abrechnen", requireAuth, async (req, res) => {
  const userInput = (req.body?.prompt || "").toString().trim();
  if (!userInput) return res.status(400).json({ error: "Fehlendes Feld: prompt" });
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Serverfehler: OPENAI_API_KEY fehlt" });

  const payer = detectPayer(userInput);
  let candidates = findCandidates(userInput, payer);
  // --- Frühzeitige Rückfragen erzwingen, wenn Eingabe unklar ---
// Wir erkennen häufige Fälle heuristisch und fragen direkt nach,
// statt sofort das Modell aufzurufen.
const nt = norm(userInput);
let preQuestion = null;

// Beispiel-Heuristiken (erweiterbar):
if (/(gespraech|gespräch|angehorig|angehörig)/i.test(nt)) {
  preQuestion = "Rückfrage: Wie lange hat das Angehörigengespräch gedauert? (bis 20 Minuten / über 20 Minuten)";
}
if (/(blut|blutabnahme|venenblut)/i.test(nt)) {
  preQuestion = "Rückfrage: War es eine Blutentnahme aus der Vene (ÖGK Pos 54) oder etwas anderes (z. B. Aderlass Pos 55)?";
}

// Wenn wir wenig/unsichere Kandidaten haben, lieber fragen
if (!preQuestion && candidates.length < 3) {
  const vorschlaege = candidates.slice(0, 6).map(c => `${c.pos} – ${c.title}`).join("\n");
  preQuestion = vorschlaege
    ? `Unklar. Meintest du eine der folgenden Leistungen?\n${vorschlaege}\nWenn keine passt: Bitte genauer beschreiben.`
    : "Unklar. Bitte die gewünschte Leistung genauer beschreiben (z. B. Träger, Technik, Dauer, Art).";
}

if (preQuestion) {
  // UI versteht 'output' – also liefern wir die Rückfrage hier schon als Antwort.
  return res.json({ output: preQuestion });

  // Fallback-Kandidaten, wenn gar nichts gefunden wurde
  if (!candidates.length) {
    const pool = catalogIndex.items.filter((x) => !payer || x.payer === payer);
    const common = ["gespraech", "beratung", "ordination", "demenz", "labor", "ekg", "injektion", "blut"];
    const poolScored = pool
      .map((it) => {
        const nt = norm(it.title);
        let score = 0;
        common.forEach((c) => {
          if (nt.includes(c)) score++;
        });
        return { it, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.it);
    candidates = poolScored.slice(0, 8);
  }

  // Ohne Kandidaten -> Fehlermeldung mit Hinweis
  if (!candidates.length) {
    return res.status(400).json({
      error:
        "Keine passenden Katalogeinträge gefunden. Bitte präziser eingeben (z. B. 'ÖGK, Blutentnahme aus der Vene').",
    });
  }

  const gatingRules = `
DU DARFST AUSSCHLIESSLICH AUS DIESEN KANDIDATEN AUSWÄHLEN ODER ZUERST RÜCKFRAGEN STELLEN:
${candidates
  .map((c) => `- ${c.payer} | ${c.pos} | ${c.title} | ${c.points}${c.notes ? " | " + c.notes : ""}`)
  .join("\n")}
Wenn die Eingabe unklar ist, STELLE ZUERST GEZIELTE RÜCKFRAGEN (z. B. Gesprächsdauer, Träger, Technik).
Gib IMMER nur Pos.-Nrn. aus dieser Liste zurück, wenn du vorschlägst.
`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT + "\n" + gatingRules },
    ...FEW_SHOTS,
    { role: "user", content: userInput },
  ];

  try {
    log("Starte OpenAI-Request", {
      model: OPENAI_MODEL,
      key: OPENAI_API_KEY ? OPENAI_API_KEY.slice(0, 7) + "…" + OPENAI_API_KEY.slice(-4) : "❌ kein Key",
      user: req.user?.email || "unbekannt",
    });

    // Node 18+ hat global fetch
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        max_completion_tokens: 1000, // neuer Param-Name
        messages,
      }),
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

    // Validierung: nur erlaubte Nummern
    const allowed = new Set(candidates.map((c) => String(c.pos).toLowerCase()));
    const used = Array.from(new Set((output.match(/\b\d+[a-z]?\b/gi) || []).map((s) => s.toLowerCase())));
    const illegal = used.filter((x) => !allowed.has(x));
   // Validierung: nur erlaubte Nummern – aber statt 422 geben wir eine Auswahl-/Rückfrage zurück
const allowed = new Set(candidates.map(c => String(c.pos).toLowerCase()));
const used = Array.from(new Set((output.match(/\b\d+[a-z]?\b/gi) || []).map(s => s.toLowerCase())));
const illegal = used.filter(x => !allowed.has(x));

if (illegal.length) {
  const options = candidates.slice(0, 6).map(c => `${c.pos} – ${c.title}`).join("\n");
  const frage = options
    ? `Unklar – nur folgende Positionen sind zugelassen:\n${options}\nWelche trifft zu?`
    : "Unklar – bitte Eingabe präzisieren (Träger, Technik, Dauer, Art).";
  return res.json({ output: frage });
}
    }

    res.json({ output, usage: data?.usage || null });
  } catch (error) {
    log("Unhandled /api/abrechnen error:", error?.message || error);
    res.status(500).json({ error: error?.message || "Unbekannter Serverfehler" });
  }
});

// Start
app.listen(PORT, () => log(`Server läuft auf Port ${PORT}`));
