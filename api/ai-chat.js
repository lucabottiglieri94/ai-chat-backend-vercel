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

function clampString(s, max = 30000) {
  if (typeof s !== "string") return "";
  return s.slice(0, max);
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function callGroqWithRetry(payload, maxRetries = 3) {
  let attempt = 0;

  while (attempt <= maxRetries) {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) return res;

    // 429 → backoff
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
      const waitMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Math.min(15000, 1000 * Math.pow(2, attempt)); // 1s 2s 4s 8s... max 15s

      console.warn(`⚠️ Groq 429 (attempt ${attempt+1}/${maxRetries+1}) → attendo ${waitMs}ms`);
      await sleep(waitMs);
      attempt++;
      continue;
    }

    // 5xx → piccolo retry
    if (res.status >= 500 && attempt < maxRetries) {
      const waitMs = Math.min(6000, 800 * (attempt + 1));
      console.warn(`⚠️ Groq ${res.status} (attempt ${attempt+1}) → attendo ${waitMs}ms`);
      await sleep(waitMs);
      attempt++;
      continue;
    }

    return res;
  }

  // fallback
  return new Response(JSON.stringify({ error: "Groq API error" }), { status: 429 });
}

// =====================
// POST /api/ai-chat
// =====================
app.post("/api/ai-chat", async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "Missing GROQ_API_KEY env" });
    }

    // 1) TOKEN OBBLIGATORIO
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

    const uid = decoded.uid; // ✅ SOLO DA TOKEN

    // 2) INPUT
    const question = (req.body?.question || "").toString().trim();
    const month = (req.body?.month || req.body?.budget?.month || "").toString().trim();
    const context_html = clampString(req.body?.context_html, 30000);
    const budgetFromClient = req.body?.budget || {};

    if (!question) return res.status(400).json({ error: 'Missing "question"' });
    if (!month) return res.status(400).json({ error: 'Missing "month" (es. "2026-02")' });

    // 3) LEGGE SOLO I DATI DI QUELL'UTENTE
    let datiBudget = null;
    try {
      const ref = db.collection("users").doc(uid).collection("budgets").doc(month);
      const snap = await ref.get();
      datiBudget = snap.exists ? snap.data() : null;
    } catch (e) {
      console.error("❌ Errore lettura Firestore:", e?.message || e);
    }

    const mergedBudget = {
      uid,
      month,
      from_dom: budgetFromClient || {},
      from_firestore: datiBudget || null,
    };

    const mergedBudgetJSON = JSON.stringify(mergedBudget, null, 2);

    // 4) PROMPT
    const systemPrompt = `
Sei un assistente AI/coach per il budget personale.

REGOLE:
- Rispondi SOLO usando i dati nel JSON "DATI BUDGET".
- Non inventare numeri. Se mancano dati, dillo.
- Non usare dati di altri utenti: l'utente corrente è uid=${uid} e month=${month}.

STILE:
- Coach: chiaro, motivante, concreto.
- Se fai calcoli: mostra una riga semplice.
- Dai warning se risparmio negativo o spese alte.

AZIONI:
Chiudi (quando utile) con "AZIONI:" e 2–5 azioni pratiche nella pagina:
- riduci una voce spese / aggiungi entrata / controlla spesa settimanale / ecc.

DATI BUDGET (JSON):
\`\`\`json
${mergedBudgetJSON}
\`\`\`

CONTESTO HTML (facoltativo):
${context_html}
`.trim();

    const userPrompt = `Domanda utente:\n${question}`.trim();

    // 5) CHIAMATA GROQ
    const groqPayload = {
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    };

    const groqResponse = await callGroqWithRetry(groqPayload, 3);

    if (!groqResponse.ok) {
      const errText = await groqResponse.text().catch(() => "");
      console.error("Groq API error:", groqResponse.status, errText);

      if (groqResponse.status === 429) {
        return res.status(429).json({
          error: "RATE_LIMIT",
          message: "Troppe richieste. Aspetta 10–20 secondi e riprova.",
          status: 429,
        });
      }

      return res.status(500).json({
        error: "Groq API error",
        status: groqResponse.status,
        detail: errText?.slice(0, 400),
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