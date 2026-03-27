export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { fileBase64, fileName, contentType, tipo } = req.body;
  if (!fileBase64 || !tipo) return res.status(400).json({ error: 'Falta fileBase64 ou tipo' });
 
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
 
  const promptRV = `Extrai os dados deste Relatório de Visita e devolve apenas JSON válido com estes campos:
num (número do RV, string), data (dd/mm/yyyy), duracao (duração da visita), meteo (meteorologia/condições climatéricas),
fiscal (nome do fiscal responsável), fase (fase da obra), trabObra (nº trabalhadores em obra, string),
presencas (lista de presenças separada por vírgulas), temas (temas abordados separados por vírgulas),
estado (exactamente um de: Normal | Alerta | Suspenso), temaPrincipal (tema principal da visita),
obs (observações e pontos de atenção), assuntos (outros assuntos tratados).
Devolve APENAS o JSON, sem texto adicional, sem markdown.`;
 
  const promptAR = `Extrai os dados desta Ata de Reunião e devolve apenas JSON válido com estes campos:
num (número da ata, string), data (dd/mm/yyyy), trabObra (nº trabalhadores em obra, string),
tipos (array de strings, cada elemento é exactamente "Normal" ou "Alerta crítico"),
participantes (lista de participantes separada por vírgulas),
temas (temas abordados separados por vírgulas),
temaPrincipal (tema principal da reunião),
decisoes (observações e decisões tomadas, texto),
pendentes (pontos em aberto ou pendentes, texto).
Devolve APENAS o JSON, sem texto adicional, sem markdown.`;
 
  try {
    const isPDF = (contentType || '').includes('pdf');
    const mediaType = isPDF ? 'application/pdf' : 'text/plain';
 
    const msgContent = isPDF
      ? [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } },
          { type: 'text', text: tipo === 'rv' ? promptRV : promptAR }
        ]
      : [
          { type: 'text', text: (tipo === 'rv' ? promptRV : promptAR) }
        ];
 
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
    const clean = text.replace(/```json|```/g, '').trim();
    const resultado = JSON.parse(clean);
 
    return res.status(200).json({ success: true, data: resultado });
 
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
