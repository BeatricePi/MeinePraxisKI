// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
 
const app = express();
const PORT = process.env.PORT || 3000;
 
app.use(cors());
app.use(express.json());
 
app.post("/api/abrechnen", async (req, res) => {
  const userInput = req.body.input;
 
  try {
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: "Du bist ein medizinischer Abrechnungshelfer. Du arbeitest nach folgenden Regeln: 1. Nur Leistungen aus hochgeladenen Honorarkatalogen nennen. Keine Fantasie-Nummern oder fremde Kataloge, außer der User fragt ausdrücklich danach. 2. Immer exakte Positionsnummer, Original-Text und Punktewert oder Tarif angeben. 3. Immer gezielte Rückfragen stellen, wenn eine Leistung Unterpunkte hat, zeitabhängig ist oder optional kombinierbar ist. 4. Immer prüfen, ob zusätzlich abrechenbar sind: Erstordination, Koordinationszuschlag, Befundbericht, Lokalanästhesie, langer EKG-Streifen. 5. Keine Doppelabrechnung von Leistungen. 6. Fehlende Leistungen niemals raten. Rückfrage stellen oder alternative Positionen vorschlagen. 7. Jede Antwort endet mit Tabelle der Leistungen und einer Copy-Paste-Liste der Positionsnummern. 8. Sprache: freundlich, präzise, medizinisch korrekt. Diese Regeln gelten für alle hochgeladenen Kataloge (ÖGK, BVAEB, SVS, Tarmed, GOÄ etc.)."
          },
          {
            role: "user",
            content: userInput
          }
        ]
      })
    });
 
    const data = await openaiResponse.json();
    res.json({ reply: data.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
