// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Sicherheit: Zugangscode aus ENV ---
const ACCESS_CODE = process.env.ACCESS_CODE;

// Middleware
app.use(cors());
app.use(express.json());

// Static Frontend (public/ Ordner)
app.use(express.static(path.join(__dirname, "public")));

// Health-Check / Startseite
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Auth-Middleware nur für API
function requireAccessCode(req, res, next) {
  const headerCode = req.headers["x-access-code"];
  if (!ACCESS_CODE) {
    return res.status(500).json({ error: "Serverkonfiguration fehlt: ACCESS_CODE" });
  }
  if (!headerCode || headerCode !== ACCESS_CODE) {
    return res.status(401).json({ error: "Unauthorized: Zugangscode fehlt oder ist falsch." });
  }
  next();
}

// API-Endpoint (geschützt)
app.post("/api/abrechnen", requireAccessCode, async (req, res) => {
  const userInput = req.body.prompt || req.body.input || "";
  if (!userInput) {
    return res.status(400).json({ error: "Fehlendes Feld: prompt" });
  }

  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content:
              "Du bist ein medizinischer Abrechnungshelfer. Regeln: 1) Nur Leistungen aus den bereitgestellten Honorarkatalogen nennen (keine Fantasienummern). 2) Immer Positionsnummer, Originaltext, Punkte/Tarif. 3) Rückfragen stellen bei Unterpunkten/Zeiten/Kombinationen. 4) Zusätzliche Positionen prüfen: Erstordination, Koordinationszuschlag, Befundbericht, Lokalanästhesie, langer EKG-Streifen. 5) Keine Doppelabrechnung. 6) Nichts raten – lieber Rückfrage. 7) Antwort endet mit Tabelle + Copy-Paste-Liste der Positionsnummern. 8) Ton: präzise, freundlich, medizinisch korrekt."
          },
          { role: "user", content: userInput }
        ]
      })
    });

    const data = await openaiResponse.json();
    const output = data?.choices?.[0]?.message?.content || "Keine Antwort erhalten.";
    res.json({ output });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
