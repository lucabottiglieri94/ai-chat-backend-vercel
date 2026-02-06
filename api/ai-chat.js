import OpenAI from 'openai';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

    const completion = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3
    });

    const answer =
      completion.choices?.[0]?.message?.content ||
      'Non sono riuscito a generare una risposta.';

    res.status(200).json({ answer });
  } catch (err) {
    console.error('Errore /api/ai-chat:', err);
    res.status(500).json({ error: 'Errore interno server AI' });
  }
});

export default app;
