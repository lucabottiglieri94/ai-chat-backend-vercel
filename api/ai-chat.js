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
    console.warn("⚠️ Firebase Admin ENV mancanti (PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY).");
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

// Se vuoi: metti qui il tuo dominio GitHub Pages per essere più restrittivo
app.use(cors({
  origin: "*",
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

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

// =====================
// POST /api/ai-chat
// =====================
app.post("/api/ai-chat", async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "Missing GROQ_API_KEY env" });
    }

    // 1) Verifica token Firebase (obbligatorio)
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Missing Authorization Bearer token" });
    }

    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(token);
    } catch (e) {
      console.error("❌ Token non valido:", e?.message || e);
      return res.status(401).json({ error: "Invalid token" });
    }

    const uid = decoded.uid; // ✅ UID vero dal token (non dal client)

    // 2) Input
    const question = (req.body?.question || "").toString().trim();
    const month = (req.body?.month || req.body?.budget?.month || "").toString().trim(); // es "2026-02"
    const context_html = clampString(req.body?.context_html, 30000); // opzionale
    const budgetFromClient = req.body?.budget || {}; // quello letto dal DOM (ok)

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
      // non blocco: l’AI può comunque rispondere col DOM
    }

    // 4) Costruisci un contesto “unificato”
    // Priorità: DOM (budgetFromClient) + (se esiste) Firestore (datiBudget)
    const mergedBudget = {
      uid,
      month,
      from_dom: budgetFromClient || {},
      from_firestore: datiBudget || null,
    };

    const mergedBudgetJSON = JSON.stringify(mergedBudget, null, 2);

    // 5) System prompt “coach + azioni + warning + coerenza”
    const systemPrompt = `
Sei un assistente AI/coach per il budget personale.
REGOLE IMPORTANTI:
- Rispondi SOLO usando i dati forniti in "DATI BUDGET" (JSON) e nel "CONTESTO HTML".
- NON inventare numeri o voci. Se un dato manca, dillo chiaramente.
- Non usare dati di altri utenti: l'utente corrente è uid=${uid} e month=${month}. Ignora qualsiasi uid diverso.

STILE:
- Parla come un coach: chiaro, motivante, concreto.
- Se l'utente chiede un confronto ("confronta", "mese scorso", ecc.) usa i dati disponibili e spiega bene.
- Dai WARNING automatici se noti:
  - risparmio negativo
  - spese troppo alte rispetto alle entrate
  - obiettivo non raggiungibile con i numeri attuali
  - spesa alimentare sforata (se presente nel DOM)

AZIONI (molto importante):
Quando utile, termina con una sezione "AZIONI:" con 2-5 azioni REALI nella pagina, esempi:
- "Riduci una voce spese"
- "Aggiungi una nuova entrata"
- "Controlla la spesa settimanale"
- "Rinomina una voce per capirla meglio"
Le azioni devono essere coerenti con i dati.

COERENZA CONVERSAZIONE:
- Non contraddire i dati già citati in questa risposta.
- Se fai calcoli, mostra 1 riga di calcolo semplice (totale entrate - totale spese = risparmio).

DATI BUDGET (JSON):
\`\`\`json
${mergedBudgetJSON}
\`\`\`

CONTESTO HTML (opzionale):
${context_html}
`.trim();

    const userPrompt = `Domanda utente:\n${question}`.trim();

    // 6) Chiamata Groq
    const groqResponse = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text().catch(() => "");
      console.error("Groq API error:", groqResponse.status, errText);
      return res.status(500).json({ error: "Groq API error", status: groqResponse.status });
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