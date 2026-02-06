import express from 'express';
import cors from 'cors';

// Groq client via fetch (API stile OpenAI)
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

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

    const systemPrompt = `
Sei un assistente AI che aiuta l'utente a capire e usare il file HTML "comparatori1.html".
Usa solo le informazioni che trovi nel contesto HTML seguente.
L'utente può incollare anche solo pezzi di HTML: tu devi interpretarli rispetto al contesto completo.
Se qualcosa non è nel contesto, dillo chiaramente.

Contesto HTML:
${safeContext}
    `.trim();

    const userPrompt = `
Domanda dell'utente:
${question}
    `.trim();

    // Chiamata a Groq (modello compatibile OpenAI)
    const groqResponse = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant', // modello Groq gratuito e veloce [web:122][web:128]
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
      return res.status(500).json({ error: 'Errore chiamando Groq API', status: groqResponse.status });
    }

    const data = await groqResponse.json();

    const answer =
      data.choices?.[0]?.message?.content ||
      'Non sono riuscito a generare una risposta.';

    res.status(200).json({ answer });
  } catch (err) {
    console.error('Errore /api/ai-chat (Groq):', err);
    res.status(500).json({ error: 'Errore interno server AI (Groq)' });
  }
});

export default app;
