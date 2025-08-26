// server.js — Abrechnungshelfer Medizin (Express + Supabase-Auth + OpenAI gpt-5 + Debug)

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
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Static Frontend
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// kleine Log-Hilfe
const log = (...a) => console.log("[APP]", ...a);

// Health-Check
app.get("/api/check", (_req, res) => {
  // Nur Key-Präfix/Suffix für Debug (nie ganzen Key zurückgeben!)
  const keyPreview = OPENAI_API_KEY
    ? OPENAI_API_KEY.slice(0, 7) + "…" + OPENAI_API_KEY.slice(-4)
    : "❌ kein Key";
  res.json({
    databaseUrl: process.env.DATABASE_URL ? "✅ vorhanden" : "❌ fehlt",
    openAiKey: OPENAI_API_KEY ? `✅ ${keyPreview}` : "❌ fehlt",
    supabaseUrl: SUPABASE_URL ? "✅ vorhanden" : "❌ fehlt",
    supabaseJwtSecret: SUPABASE_JWT_SECRET ? "✅ vorhanden" : "❌ fehlt",
    allowedEmails: ALLOWED_EMAILS.length ? `✅ ${ALLOWED_EMAILS.length}` : "—",
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
  } catch (err) {
    return res.status(401).json({ error: "Ungültiges/abgelaufenes Token" });
  }
}

// === SYSTEM PROMPT ===
const SYSTEM_PROMPT = `
Du bist der „Abrechnungshelfer Medizin“ für Ärzt:innen in Österreich.

ZWECK
- Unterstütze Allgemeinmediziner:innen, die mit Innomed arbeiten, dabei, medizinische Leistungen für verschiedene Sozialversicherungsträger korrekt und vollständig abzurechnen.
- Nutze ausschließlich die hinterlegten Honorarkataloge (ÖGK, SVS, BVAEB, Medrech, KUF etc.).

REGELN
- Vorschlagen darfst du nur Leistungen aus den hinterlegten Honorarkatalogen.
- Nenne IMMER: exakte Positionsnummer, Original-Leistungstext, Punktewert/Tarif.
- Stelle gezielte Rückfragen, wenn zeit-, diagnose- oder technikabhängige Leistungen möglich sind (z. B. EKG, Labor, Gesprächsdauer).
- Achte auf Kombinierbarkeit (z. B. Erstordination, Koordinationszuschlag, Befundbericht).
- Vermeide Doppelabrechnung und halte dich an Limitierungen (z. B. 1×/Quartal).
- Keine Fantasie-Nummern, keine fremden Kataloge, nichts „erraten“.
- Speichere keine Patientendaten.
- Ton: freundlich, präzise, medizinisch korrekt, ohne Small Talk.

DATENKONTEXT
- ÖGK: Gesamtvertrag & Honorarkatalog
- BVAEB: Honorarordnung (ab Mai 2024)
- SVS: Landwirtschaft, Gewerbe etc.
- Sonderkataloge: Medrech, SVA-vertragslos, Tiroler KUF
- Nutze den passenden Katalog je nach Versicherungsträger.

FEHLERBEHANDLUNG
- Wenn Diagnose unklar/zu wenig Info: Frage „Welche Diagnose wurde gestellt?“
- Wenn Träger unklar: Frage „Für welchen Versicherungsträger gilt der Fall?“
- Wenn rechtlich unklar: Hinweis „Bitte mit der Kasse abklären.“

AUSGABEFORMAT
1. Eine kompakte Tabelle mit den Spalten:
   Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo
2. Danach eine Copy-Paste-Liste nur mit den Positionsnummern, getrennt durch Semikolon (z. B. 1C; 1D; 300).

ANTWORT-REGEL
- Immer zuerst Rückfrage(n), falls nötig.
- Dann die Tabelle.
- Immer am Ende die Copy-Paste-Liste.
`;

// === FEW-SHOT BEISPIELE ===
const FEW_SHOTS = [
  {
    role: "user",
    content: "Männlich, 52 Jahre, Hypertonie, Erstordination"
  },
  {
    role: "assistant",
    content:
`Rückfrage: Wurde ein Ruhe-EKG gemacht?

Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo
------- | ------------- | -------- | -----------
1C | Erstordination | 20 P | nur 1× pro Quartal
1D | Koordinationszuschlag | 10 P | bei Erstordination
300 | Blutdruckmessung | 5 P | Routine

Copy-Paste-Liste: 1C; 1D; 300`
  },
  {
    role: "user",
    content: "weibl. Patientin, 28 J., Juckreiz im Vaginalbereich, Verdacht auf Soor"
  },
  {
    role: "assistant",
    content:
`Rückfrage: Wurde ein Abstrich gemacht?

Pos.-Nr | Leistungstext | Punkte/€ | Zusatzinfo
------- | ------------- | -------- | -----------
200 | Mikroskopische Untersuchung | 5 P | Abstrich erforderlich
201 | Pilznachweis | 8 P | bei Verdacht Soor

Copy-Paste-Liste: 200; 201`
  }
];

// === API ENDPOINT ===
app.post("/api/abrechnen", requireAuth, async (req, res) => {
  const userInput = (req.body?.prompt || "").toString().trim();
  if (!userInput) return res.status(400).json({ error: "Fehlendes Feld: prompt" });
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Serverfehler: OPENAI_API_KEY fehlt" });

  try {
    // Debug-Log (Modell + Key-Präfix)
    log("Starte OpenAI-Request", {
      model: "gpt-5",
      key: OPENAI_API_KEY ? OPENAI_API_KEY.slice(0, 7) + "…" + OPENAI_API_KEY.slice(-4) : "❌ kein Key",
      user: req.user?.email || "unbekannt"
    });

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5",
        temperature: 0.2,
        max_tokens: 1000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...FEW_SHOTS,
          { role: "user", content: userInput }
        ]
      }),
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text().catch(() => "");
      log("OpenAI-Fehler", openaiRes.status, errBody);
      // Freundlichere Meldung bei Quota-Fehlern
      if (openaiRes.status === 429 && /insufficient_quota/i.test(errBody)) {
        return res.status(502).json({
          error: "OpenAI-Kontingent erschöpft (Teams-Key/Billing prüfen)."
        });
      }
      return res.status(502).json({
        error: `OpenAI-Fehler ${openaiRes.status}: ${errBody || "keine Details"}`
      });
    }

    const data = await openaiRes.json();
    const output = data?.choices?.[0]?.message?.content?.trim();
    if (!output) return res.status(502).json({ error: "Leere Antwort vom Modell." });

    res.json({ output, usage: data?.usage || null });
  } catch (error) {
    log("Unhandled /api/abrechnen error:", error?.message || error);
    res.status(500).json({ error: error?.message || "Unbekannter Serverfehler" });
  }
});

// Start
app.listen(PORT, () => log(`Server läuft auf Port ${PORT}`));
