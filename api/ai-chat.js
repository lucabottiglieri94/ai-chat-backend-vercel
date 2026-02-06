import express from 'express';
import cors from 'cors';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Groq setup
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Firebase setup
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID || 'budget-luca',
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
};

let db;
try {
  initializeApp({
    credential: cert(serviceAccount)
  });
  db = getFirestore();
  console.log('✅ Firebase connesso');
} catch (error) {
  console.error('❌ Errore Firebase init:', error.message);
}

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/ai-chat', async (req, res) => {
  try {
    const { question, context_html } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Missing "question"' });
    }

    const safeContext = typeof context_html === 'string'
      ? context_html.slice(0, 40000)
      : '';

    // Leggi dati budget da Firestore
    let datiBudget = {};
    if (db) {
      try {
        const docRef = db.collection('budgets').doc('2026-02');
        const docSnap = await docRef.get();
        
        if (docSnap.exists) {
          datiBudget = docSnap.data();
          console.log('✅ Dati budget caricati da Firestore');
        } else {
          console.warn('⚠️ Documento budget non trovato');
        }
      } catch (fbError) {
        console.error('❌ Errore lettura Firestore:', fbError.message);
      }
    }

    const datiBudgetJSON = JSON.stringify(datiBudget, null, 2);

    const systemPrompt = `
Sei un assistente AI per il budget personale dell'utente.

Hai accesso a:
1. **Dati budget reali da Firestore** (JSON sotto).
2. Struttura HTML della dashboard.

I dati budget includono:
- "entrate": array di oggetti con "label" e "amount" (es. Stipendio Luca: 1460).
- "spese": array di oggetti con "label" e "amount" (es. Affitto: 600, Alimenti: 500, Trasporti: 400, ecc.).
- "spesaAlimentare": mappa con week1, week2, week3, week4 (array di importi giornalieri).
- "month": mese di riferimento (es. "2026-02").
- "lastModified": data ultima modifica.

**Compiti:**
- Rispondi a domande come "quanto pago di affitto?" leggendo l'elemento in "spese" con label "Affitto".
- Calcola totali entrate e spese.
- Dai consigli pratici su risparmio, ottimizzazione spese, percentuali (es. affitto/entrate, spesa alimentare su totale).
- Se mancano dati nel JSON, avvisa l'utente.

**Dati budget (JSON Firestore):**
\`\`\`json
${datiBudgetJSON}
\`\`\`

**Contesto HTML:**
${safeContext}
    `.trim();

    const userPrompt = `
Domanda dell'utente:
${question}
    `.trim();

    // Chiamata Groq
    const groqResponse = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3
      })
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text().catch(() => '');
      console.error('Groq API error:', groqResponse.status, errText);
      return res.status(500).json({ error: 'Errore Groq API', status: groqResponse.status });
    }

    const data = await groqResponse.json();
    const answer = data.choices?.[0]?.message?.content || 'Non sono riuscito a generare una risposta.';

    res.status(200).json({ answer });
  } catch (err) {
    console.error('Errore /api/ai-chat:', err);
    res.status(500).json({ error: 'Errore interno server AI' });
  }
});

export default app;
