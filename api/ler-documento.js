export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { caminho, tipo } = req.body; // tipo: 'rv' ou 'ar'
  if (!caminho || !tipo) return res.status(400).json({ error: 'Falta caminho ou tipo' });
 
  const NAS_URL = process.env.NAS_URL;       // ex: https://aceitar.synology.me:5000
  const NAS_USER = process.env.NAS_USER;
  const NAS_PASS = process.env.NAS_PASS;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
 
  try {
    // 1. Autenticar na NAS
    const loginResp = await fetch(
      `${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${encodeURIComponent(NAS_USER)}&passwd=${encodeURIComponent(NAS_PASS)}&session=FileStation&format=sid`
    );
    const loginData = await loginResp.json();
    if (!loginData.success) throw new Error('Falha na autenticação NAS');
    const sid = loginData.data.sid;
 
    // 2. Download do ficheiro
    const downloadResp = await fetch(
      `${NAS_URL}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&path=${encodeURIComponent(caminho)}&mode=download&_sid=${sid}`
    );
    if (!downloadResp.ok) throw new Error('Ficheiro não encontrado na NAS');
    const fileBuffer = await downloadResp.arrayBuffer();
    const base64 = Buffer.from(fileBuffer).toString('base64');
    const contentType = downloadResp.headers.get('content-type') || 'application/pdf';
 
    // 3. Logout NAS
    await fetch(`${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=1&method=logout&session=FileStation&_sid=${sid}`);
 
    // 4. Prompt conforme tipo
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
 
    // 5. Chamar Claude
    const isPDF = contentType.includes('pdf');
    const mediaType = isPDF ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
 
    const msgContent = isPDF
      ? [{ type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } },
         { type: 'text', text: tipo === 'rv' ? promptRV : promptAR }]
      : [{ type: 'text', text: (tipo === 'rv' ? promptRV : promptAR) + '\n\nConteúdo do ficheiro (base64 DOCX — extrai o texto): ' + base64 }];
 
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
    const text = claudeData.content?.map(c => c.text || '').join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const resultado = JSON.parse(clean);
 
    return res.status(200).json({ success: true, data: resultado });
 
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
 
