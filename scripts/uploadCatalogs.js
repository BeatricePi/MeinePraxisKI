// scripts/uploadCatalogs.js
// Lädt alle PDFs aus ./catalogs in einen OpenAI Vector Store.
// - Falls VECTOR_STORE_ID in der Umgebung steht, werden neue Dateien dort angehängt.
// - Sonst wird ein neuer Vector Store erstellt und die ID in der Konsole ausgegeben.

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

(async () => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("Fehlt: Umgebungsvariable OPENAI_API_KEY");
    }
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const catalogsDir = path.join(__dirname, "..", "catalogs");
    if (!fs.existsSync(catalogsDir)) {
      throw new Error(`Ordner nicht gefunden: ${catalogsDir}`);
    }

    // Alle PDFs einsammeln
    const pdfs = fs
      .readdirSync(catalogsDir)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .map((f) => path.join(catalogsDir, f));

    if (pdfs.length === 0) {
      console.log("Keine PDFs in ./catalogs gefunden – nichts zu tun.");
      process.exit(0);
    }

    console.log("Gefundene PDFs:");
    pdfs.forEach((p) => console.log(" -", path.basename(p)));

    let vectorStoreId = process.env.VECTOR_STORE_ID;

    if (!vectorStoreId) {
      // Neuen Vector Store anlegen
      const name = `abrechnungshelfer-catalogs-${new Date()
        .toISOString()
        .slice(0, 10)}`;
      console.log(`\nErzeuge neuen Vector Store: ${name}`);
      const vs = await openai.beta.vectorStores.create({ name });
      vectorStoreId = vs.id;
      console.log("VECTOR_STORE_ID:", vectorStoreId);
      console.log(
        "→ Bitte diese ID als Umgebungsvariable VECTOR_STORE_ID speichern!"
      );
    } else {
      console.log("Nutze bestehenden Vector Store:", vectorStoreId);
    }

    // Upload + Indexing (mit Polling, bis fertig)
    console.log("\nLade Dateien hoch & indexiere (kann ein paar Minuten dauern) …");
    const fileStreams = pdfs.map((p) => fs.createReadStream(p));
    const batch = await openai.beta.vectorStores.fileBatches.uploadAndPoll(
      vectorStoreId,
      { files: fileStreams }
    );

    console.log("Batch-Status:", batch.status);
    if (batch.status !== "completed") {
      console.log("Details:", batch);
    }

    // Kurzer Überblick
    const filesList = await openai.beta.vectorStores.files.list(vectorStoreId, {
      limit: 100,
    });
    console.log(
      `\nVector Store enthält jetzt ${filesList.data.length} Datei(en).`
    );
    filesList.data.forEach((f) =>
      console.log(` - ${f.id}  (${f.usage_bytes} Bytes)`)
    );

    console.log("\nFertig ✅");
  } catch (err) {
    console.error("\nFehler:", err?.message || err);
    process.exit(1);
  }
})();
