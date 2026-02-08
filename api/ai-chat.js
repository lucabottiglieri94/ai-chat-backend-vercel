import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// =====================
// ENV
// =====================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// =====================
// Firebase Admin init
// =====================
function initFirebaseAdmin() {
  if (getApps().length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    console.warn("⚠️ Firebase Admin ENV mancanti (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).");
  }

  initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });

  console.log("✅ Firebase Admin inizializzato");
}

initFirebaseAdmin();

const db = getFirestore();
const adminAuth = getAuth();

// =====================
// Express
// =====================
const app = express();

// 🔒 Se vuoi più sicurezza: sostituisci "*" con "https://lucabottiglieri94.github.io"
app.use(
  cors({
    origin: "*",
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "1mb" }));

// =====================
// Helpers
// =====================
function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function clampString(s, max = 40000) {
  if (typeof s !== "string") return "";
  return s.slice(0, max);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =====================
// Groq retry helper
// =====================
async function callGroqWithRetry(payload, maxRetries = 3) {
  let attempt = 0;
  let lastErrText = "";

  while (attempt <= maxRetries) {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) return res;

    lastErrText = await res.text().catch(() => "");

    // 429 → rate limit
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
      const waitMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Math.min(15000, 1000 * Math.pow(2, attempt)); // 1s,2s,4s,8s (max 15s)

      console.warn(`⚠️ Groq 429 (attempt ${attempt + 1}/${maxRetries + 1}) → attendo ${waitMs}ms`);
      await sleep(waitMs);
      attempt++;
      continue;
    }

    // 5xx → retry leggero
    if (res.status >= 500 && attempt < maxRetries) {
      const waitMs = Math.min(6000, 800 * (attempt + 1));
      console.warn(`⚠️ Groq ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}) → attendo ${waitMs}ms`);
      await sleep(waitMs);
      attempt++;
      continue;
    }

    // altri errori → stop
    return new Response(
      JSON.stringify({ error: "Groq API error", status: res.status, detail: lastErrText }),
      { status: res.status, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ error: "Groq API error", status: 429, detail: lastErrText }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );
}

// =====================
// POST /api/ai-chat
// =====================
app.post("/api/ai-chat", async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "Missing GROQ_API_KEY env" });
    }

    // 1) Verifica token Firebase (OBBLIGATORIO)
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Missing Authorization: Bearer <idToken>" });
    }

    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(token);
    } catch (e) {
      console.error("❌ Token non valido:", e?.message || e);
      return res.status(401).json({ error: "Invalid token" });
    }

    const uid = decoded.uid;

    // 2) Input
    const question = (req.body?.question || "").toString().trim();
    const month = (req.body?.month || req.body?.budget?.month || "").toString().trim(); // "2026-02"
    const context_html = clampString(req.body?.context_html, 30000);
    const budgetFromClient = req.body?.budget || {};

    if (!question) return res.status(400).json({ error: 'Missing "question"' });
    if (!month) return res.status(400).json({ error: 'Missing "month" (es. "2026-02")' });

    // 3) Legge Firestore SOLO dell'utente corrente
    // users/{uid}/budgets/{month}
    let datiBudget = null;
    try {
      const ref = db.collection("users").doc(uid).collection("budgets").doc(month);
      const snap = await ref.get();
      datiBudget = snap.exists ? snap.data() : null;
    } catch (e) {
      console.error("❌ Errore lettura Firestore:", e?.message || e);
      // non blocco: posso rispondere usando il DOM
    }

    // 4) Contesto unificato (NO altri utenti)
    const mergedBudget = {
      uid,
      month,
      from_dom: budgetFromClient || {},
      from_firestore: datiBudget || null,
    };

    const mergedBudgetJSON = JSON.stringify(mergedBudget, null, 2);

    // 5) Prompt coach + azioni + warning + coerenza
    const systemPrompt = `
Sei un assistente AI/coach per il budget personale.

REGOLE IMPORTANTI:
- Rispondi SOLO usando i dati forniti in "DATI BUDGET" (JSON) e nel "CONTESTO HTML".
- NON inventare numeri o voci. Se un dato manca, dillo chiaramente.
- Non usare dati di altri utenti: l'utente corrente è uid=${uid} e month=${month}.

STILE:
- Parla come un coach: chiaro, motivante, concreto.
- Se l'utente chiede un confronto ("confronta", "mese scorso", ecc.) usa i dati disponibili e spiega bene.
- Dai WARNING automatici se noti:
  - risparmio negativo
  - spese troppo alte rispetto alle entrate
  - obiettivo non raggiungibile con i numeri attuali
  - spesa alimentare sforata (se presente)

AZIONI:
Quando utile, termina con una sezione "AZIONI:" con 2-5 azioni REALI nella pagina, esempi:
- "Riduci una voce spese"
- "Aggiungi una nuova entrata"
- "Controlla la spesa settimanale"
- "Rinomina una voce per capirla meglio"
Le azioni devono essere coerenti con i dati.

COERENZA:
- Non contraddire i dati già citati.
- Se fai calcoli, mostra 1 riga di calcolo semplice (entrate - spese = risparmio).

DATI BUDGET (JSON):
\`\`\`json
${mergedBudgetJSON}
\`\`\`

CONTESTO HTML (opzionale):
${context_html}
`.trim();

    const userPrompt = `Domanda utente:\n${question}`.trim();

    // 6) Chiamata Groq (con retry 429)
    const groqPayload = {
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    };

    const groqResponse = await callGroqWithRetry(groqPayload, 3);

    // Se ancora non OK
    if (!groqResponse.ok) {
      let errText = "";
      try {
        errText = await groqResponse.text();
      } catch {}

      console.error("Groq API error:", groqResponse.status, errText);

      if (groqResponse.status === 429) {
        return res.status(429).json({
          error: "RATE_LIMIT",
          message: "Sto ricevendo troppe richieste in questo momento. Aspetta 10–20 secondi e riprova.",
          status: 429,
        });
      }

      return res.status(500).json({
        error: "Groq API error",
        status: groqResponse.status,
        detail: (errText || "").slice(0, 400),
      });
    }

    const data = await groqResponse.json();
    const answer = data?.choices?.[0]?.message?.content || "Non sono riuscito a generare una risposta.";

    return res.status(200).json({ answer });
  } catch (err) {
    console.error("Errore /api/ai-chat:", err);
    return res.status(500).json({ error: "Errore interno server AI" });
  }
});

export default app;