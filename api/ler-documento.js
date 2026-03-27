export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { files, tipo } = req.body;
  // files: array de {fileBase64, fileName, contentType}
  if (!files || !files.length || !tipo) return res.status(400).json({ error: 'Falta files ou tipo' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const promptRV = `Extrai os dados deste Relatório de Visita e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown, sem explicações.
Campos obrigatórios: num (número do RV, string), data (dd/mm/yyyy), duracao (duração da visita, string), meteo (meteorologia, string),
fiscal (nome do fiscal, string), fase (fase da obra, string), trabObra (nº trabalhadores, string),
presencas (presenças separadas por vírgula, string), temas (temas separados por vírgula, string),
estado (exactamente um de: Normal | Alerta | Suspenso), temaPrincipal (string), obs (string), assuntos (string).
Se um campo não existir no documento, usa string vazia "".`;

  const promptAR = `Extrai os dados desta Ata de Reunião e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown, sem explicações.
Campos obrigatórios: num (número da ata, string), data (dd/mm/yyyy), trabObra (string),
tipos (array de strings, cada um exactamente "Normal" ou "Alerta crítico"),
participantes (string), temas (string), temaPrincipal (string), decisoes (string), pendentes (string).
Se um campo não existir no documento, usa string vazia "" ou array vazio [].`;

  const resultados = [];

  for (const f of files) {
    try {
      const { fileBase64, contentType } = f;
      const isPDF = (contentType || '').includes('pdf');

      const msgContent = isPDF
        ? [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } },
            { type: 'text', text: tipo === 'rv' ? promptRV : promptAR }
          ]
        : [{ type: 'text', text: tipo === 'rv' ? promptRV : promptAR }];

      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{ role: 'user', content: msgContent }],
        }),
      });

      const claudeData = await claudeResp.json();
      if (claudeData.error) throw new Error(claudeData.error.message);

      const text = claudeData.content?.map(c => c.text || '').join('').trim();
      // Extrair JSON mesmo que venha com texto à volta
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Resposta não contém JSON válido: ' + text.substring(0, 100));
      const resultado = JSON.parse(jsonMatch[0]);
      resultados.push({ success: true, data: resultado, fileName: f.fileName });
    } catch (err) {
      resultados.push({ success: false, error: err.message, fileName: f.fileName });
    }
  }

  return res.status(200).json({ results: resultados });
}
