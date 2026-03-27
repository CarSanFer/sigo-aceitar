import mammoth from 'mammoth';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { files, tipo } = req.body;
  if (!files || !files.length || !tipo) return res.status(400).json({ error: 'Falta files ou tipo' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const promptRV = `Extrai os dados deste Relatório de Visita e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown, sem explicações.
Campos: num (número do RV, string), data (dd/mm/yyyy), duracao (string), meteo (string),
fiscal (string), fase (string), trabObra (string), presencas (string), temas (string),
estado (exactamente: Normal | Alerta | Suspenso), temaPrincipal (string), obs (string), assuntos (string).
Se um campo não existir usa string vazia "".`;

  const promptAR = `Extrai os dados desta Ata de Reunião e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown, sem explicações.
Campos: num (string), data (dd/mm/yyyy), trabObra (string),
tipos (array, cada elemento exactamente "Normal" ou "Alerta crítico"),
participantes (string), temas (string), temaPrincipal (string), decisoes (string), pendentes (string).
Se um campo não existir usa "" ou [].`;

  const resultados = [];

  for (const f of files) {
    try {
      const { fileBase64, fileName, contentType } = f;
      const isPDF = (contentType || '').includes('pdf') || fileName?.toLowerCase().endsWith('.pdf');
      const isDocx = (contentType || '').includes('word') || fileName?.toLowerCase().endsWith('.docx') || fileName?.toLowerCase().endsWith('.doc');

      let msgContent;

      if (isPDF) {
        msgContent = [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } },
          { type: 'text', text: tipo === 'rv' ? promptRV : promptAR }
        ];
      } else if (isDocx) {
        // Extrair texto do DOCX
        const buffer = Buffer.from(fileBase64, 'base64');
        const result = await mammoth.extractRawText({ buffer });
        const textoDocx = result.value;
        msgContent = [
          { type: 'text', text: (tipo === 'rv' ? promptRV : promptAR) + '\n\nConteúdo do documento:\n\n' + textoDocx }
        ];
      } else {
        // Texto simples
        const texto = Buffer.from(fileBase64, 'base64').toString('utf-8');
        msgContent = [
          { type: 'text', text: (tipo === 'rv' ? promptRV : promptAR) + '\n\nConteúdo:\n\n' + texto }
        ];
      }

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
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Sem JSON na resposta: ' + text.substring(0, 100));
      const resultado = JSON.parse(jsonMatch[0]);

      resultados.push({ success: true, data: resultado, fileName });
    } catch (err) {
      console.error(err);
      resultados.push({ success: false, error: err.message, fileName: f.fileName });
    }
  }

  return res.status(200).json({ results: resultados });
}
