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
Sei un assistente AI per il budget personale.

⚠️ REGOLA ASSOLUTA:
- Usa SOLO i dati forniti sotto
- NON inventare numeri
- NON fare riferimento ad altri utenti
- Se un dato non esiste, dillo chiaramente

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