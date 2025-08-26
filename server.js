// server.js — Abrechnungshelfer Medizin (Express + Supabase-Auth + OpenAI gpt-5)

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

// leichte Log-Hilfe
const log = (...a) => console.log("[APP]", ...a);

// Health-Check
app.get("/api/check", (_req, res) => {
  res.json({
    databaseUrl: process.env.DATABASE_URL ? "✅ vorhanden" : "❌ fehlt",
    openAiKey: OPENAI_API_KEY ? "✅ vorhanden" : "❌ fehlt",
    supabaseUrl: SUPABASE_URL ? "✅ vorhanden" : "❌ fehlt",
    supabaseJwtSecret: SUPABASE_JWT_SECRET ? "✅ vorhanden" : "❌ fehlt",
    allowedEmails: ALLOWED_EMAILS.length ? `✅ ${ALLOWED_EMAILS.length}` : "—",
  });
});

// Supabase-Auth (JWT) prüfen
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

// === HIER DEIN BASIS-PROMPT EINFÜGEN ===
// Kopiere die „Instructions“ (Anweisungen) deines Custom-GPT 1:1 hier hinein.
// Du kannst sie jederzeit erweitern (Regeln, Tabellen-Format, Quellenpflicht etc.).
const SYSTEM_PROMPT = `
Du bist ein medizinischer Abrechnungshelfer für Ärzt:innen im DACH-Raum.

ZIEL:
- Aus Eingaben wie „Diagnose, Alter, Geschlecht, Versicherungsträger“ ermittelst du abrechenbare Leistungen.
- Gib stets Katalog-Nummer + Originaltext + ggf. Punktzahl/Tarif an (z. B. EBM/GOÄ/ÖGK – passend zum Kontext).
- Erzeuge am Ende eine **Copy-Paste-Liste** der reinen Positionsnummern in sinnvoller Reihenfolge.

REGELN:
- Nichts erfinden: Wenn Unsicherheit besteht, kurz Rückfragen.
- Prüfe Zusatzpositionen (z. B. Erst-/Folgeordination, Zuschläge, Berichte, Lokalanästhesie, längere EKG-Streifen etc.).
- Vermeide Doppelabrechnung und unzulässige Kombinationen.
- Antworte klar und kompakt, tabellarisch wo sinnvoll.
- Wenn der Katalog/Träger unklar ist (EBM/GOÄ/ÖGK/…): frage kurz nach.

AUSGABE-STRUKTUR:
1) Kurze Begründung/Annahmen (falls nötig)
2) Tabelle: Nummer | Leistungstext | Punkte/Gebühr | Hinweise
3) Copy-Paste-Liste: ;getrennte Positionsnummern
`;

// Abrechnungs-API (mit gpt-5)
app.post("/api/abrechnen", requireAuth, async (req, res) => {
  const userInput = (req.body?.prompt || "").toString().trim();
  if (!userInput) return res.status(400).json({ error: "Fehlendes Feld: prompt" });
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Serverfehler: OPENAI_API_KEY fehlt" });

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5",
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userInput }
        ],
      }),
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text().catch(() => "");
      log("OpenAI-Fehler", openaiRes.status, errBody);
      // 429/insufficient_quota sauber zurückreichen
      return res.status(openaiRes.status === 429 ? 502 : 502).json({
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

app.listen(PORT, () => log(`Server läuft auf Port ${PORT}`));
