// server.js  — Abrechnungshelfer Medizin (Express + Supabase-Auth + OpenAI)
// CommonJS-Variante (kein "type":"module" nötig)

const express = require("express");
const path = require("path");
const jwt = require("jsonwebtoken");
const cors = require("cors");

// --- Config / ENV ---
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// --- App ---
const app = express();
app.set("trust proxy", 1); // wichtig für Secure-Cookies, Proxies etc. (Render)
app.use(cors());           // für Same-Origin genügt das; bei getrennten Domains ggf. einschränken
app.use(express.json({ limit: "1mb" }));

// --- Static Frontend ausliefern ---
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// --- Logging-Helfer ---
function log(...args) {
  // einfache zentrale Log-Funktion
  console.log("[APP]", ...args);
}

// --- Health/Check-Routen ---
app.get("/", (_req, res) => {
  // Hinweis: Wird meist von index.html (static) überdeckt. Als Fallback ok.
  res.type("text").send("Abrechnungshelfer Medizin Backend läuft.");
});

app.get("/api/check", (_req, res) => {
  res.json({
    databaseUrl: process.env.DATABASE_URL ? "✅ vorhanden" : "❌ fehlt",
    openAiKey: OPENAI_API_KEY ? "✅ vorhanden" : "❌ fehlt",
    supabaseUrl: SUPABASE_URL ? "✅ vorhanden" : "❌ fehlt",
    supabaseJwtSecret: SUPABASE_JWT_SECRET ? "✅ vorhanden" : "❌ fehlt",
    allowedEmails: ALLOWED_EMAILS.length ? `✅ ${ALLOWED_EMAILS.length}` : "—",
  });
});

// --- Auth-Middleware (Supabase-JWT prüfen) ---
function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Kein Token (Authorization: Bearer <token> fehlt)" });
    }
    if (!SUPABASE_JWT_SECRET) {
      return res.status(500).json({ error: "Serverfehler: SUPABASE_JWT_SECRET fehlt" });
    }

    const payload = jwt.verify(token, SUPABASE_JWT_SECRET);
    // Übliche Felder: sub (user id), email, role
    req.user = { id: payload.sub, email: payload.email, role: payload.role };

    // Optional: Allowlist – nur freigeschaltete E-Mails dürfen rein
    if (ALLOWED_EMAILS.length) {
      const email = (req.user.email || "").toLowerCase();
      if (!ALLOWED_EMAILS.includes(email)) {
        return res.status(403).json({ error: "Nicht freigeschaltet" });
      }
    }

    return next();
  } catch (err) {
    return res.status(401).json({ error: "Ungültiges oder abgelaufenes Token" });
  }
}

// --- Abrechnungs-API (geschützt) ---
app.post("/api/abrechnen", requireAuth, async (req, res) => {
  const userInput = (req.body?.prompt || "").toString().trim();
  if (!userInput) return res.status(400).json({ error: "Fehlendes Feld: prompt" });

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "Serverfehler: OPENAI_API_KEY fehlt" });
  }

  try {
    // OpenAI Chat Completions API (gpt-4o-mini)
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Du bist ein medizinischer Abrechnungshelfer für Ärztinnen und Ärzte im DACH-Raum. " +
              "Eingabe: Diagnose, Geschlecht, Alter, Versicherungsträger. " +
              "Ausgabe: Abrechenbare Leistungen inkl. Honorarkatalog-Nummern (z. B. EBM/GOÄ/ÖGK je nach Kontext) " +
              "und eine klare Copy-Paste-Liste. Antworte strukturiert, knapp, ohne Patientendaten zu speichern. " +
              "Wenn Informationen fehlen, formuliere kurze Nachfragen.",
          },
          { role: "user", content: userInput },
        ],
        temperature: 0.2,
      }),
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text().catch(() => "");
      log("OpenAI-Fehler", openaiRes.status, errBody);
      return res.status(502).json({
        error: `OpenAI-Fehler ${openaiRes.status}: ${errBody || "keine Details"}`,
      });
    }

    const data = await openaiRes.json();
    const output = data?.choices?.[0]?.message?.content?.trim();

    if (!output) {
      log("Leere Modellantwort", data);
      return res.status(502).json({ error: "Leere Antwort vom Modell." });
    }

    // Optional: Usage-Infos zurückgeben, wenn vorhanden
    const usage = data?.usage || null;

    return res.json({ output, usage });
  } catch (error) {
    log("Unhandled /api/abrechnen error:", error?.message || error);
    return res.status(500).json({ error: error?.message || "Unbekannter Serverfehler" });
  }
});

// --- Fehler-Handler (Fallback) ---
app.use((err, _req, res, _next) => {
  log("Global Error:", err?.message || err);
  res.status(500).json({ error: "Interner Serverfehler" });
});

// --- Start ---
app.listen(PORT, () => {
  log(`Server läuft auf Port ${PORT}`);
});
