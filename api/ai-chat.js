import express from 'express';
import cors from 'cors';

// Groq
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/ai-chat', async (req, res) => {
  try {
    const { question, budget, context_html } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Missing question' });
    }

    // 🔐 SICUREZZA: SOLO DATI DEL DOM DELL’UTENTE
    const safeBudget = budget && typeof budget === 'object'
      ? JSON.stringify(budget, null, 2).slice(0, 8000)
      : '{}';

    const safeHTML = typeof context_html === 'string'
      ? context_html.slice(0, 30000)
      : '';

    const systemPrompt = `
Sei un assistente AI per la gestione del budget personale.
Parli come un COACH FINANZIARIO: chiaro, diretto, motivante.

══════════════
REGOLE ASSOLUTE
══════════════
- Usa SOLO i dati forniti in "DATI BUDGET".
- NON inventare numeri.
- NON usare dati di altri utenti.
- Se un dato non è presente, dillo chiaramente.
- Mantieni coerenza tra le risposte nella stessa conversazione.
- Non contraddire numeri già citati in precedenza.

══════════════
DATI DISPONIBILI
══════════════
- Entrate
- Spese
- Risparmio
- Obiettivo di risparmio
- Stato spesa settimanale
- Mese corrente

══════════════
ANALISI AUTOMATICA (SEMPRE ATTIVA)
══════════════
- Calcola percentuali sul totale entrate.
- Individua:
  • spesa più alta
  • area più critica
  • livello di risparmio (%)
- Usa queste soglie:
  • Affitto > 35% entrate → ⚠️ rischio
  • Spesa alimentare > 20% → ⚠️ controllo
  • Risparmio < 10% → ⚠️ insufficiente

══════════════
OBIETTIVO DI RISPARMIO
══════════════
- Confronta SEMPRE il risparmio con l’obiettivo.
- Se non raggiunto:
  • indica quanto manca
  • suggerisci come colmare la differenza
- Se raggiunto:
  • rinforza positivamente (tono motivante)

══════════════
WARNING AUTOMATICI
══════════════
Mostra avvisi quando:
- Saldo negativo
- Risparmio sotto obiettivo
- Una singola spesa domina il budget

Usa emoji con moderazione:
⚠️ 🚨 💡 ✅

══════════════
CONFRONTI (SOLO SE RICHIESTI DALL’UTENTE)
══════════════
Se l’utente chiede confronti:
- Confronta mesi (es. Febbraio vs Marzo)
- Evidenzia:
  • miglioramenti
  • peggioramenti
  • variazioni %
Se i dati non sono disponibili, spiega perché.

══════════════
AZIONI NELLA PAGINA (OBBLIGATORIE)
══════════════
Suggerisci SEMPRE almeno 1 azione concreta
che l’utente può fare NELLA PAGINA.

Esempi:
- "Riduci una voce nella sezione Spese"
- "Aggiungi una nuova entrata"
- "Controlla la spesa settimanale"
- "Rivedi l’obiettivo di risparmio"

══════════════
FORMATO RISPOSTA
══════════════
1️⃣ Risposta breve (coach-style)
2️⃣ Numeri chiave (€, %, differenze)
3️⃣ ⚠️ Avvisi (se presenti)
4️⃣ 💡 Consiglio pratico
5️⃣ 👉 Azione concreta nella pagina

Tono:
- umano
- motivante
- zero tecnicismi
- frasi brevi
DATI BUDGET (utente attuale):
${safeBudget}

CONTESTO HTML:
${safeHTML}

Rispondi in modo chiaro, pratico e concreto.
    `.trim();

    const userPrompt = question.trim();

    const groqResponse = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!groqResponse.ok) {
      const txt = await groqResponse.text();
      console.error('Groq error:', txt);
      return res.status(500).json({ error: 'Groq API error' });
    }

    const data = await groqResponse.json();
    const answer = data.choices?.[0]?.message?.content
      || 'Non ho abbastanza dati per rispondere.';

    res.json({ answer });

  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'AI server error' });
  }
});

export default app;