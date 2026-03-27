import mammoth from 'mammoth';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { files, tipo, prompt: customPrompt, action, obraCodigo, obraNome, mes, ano, lote, totalLotes } = req.body;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NAS_URL = process.env.NAS_URL;
  const NAS_USER = process.env.NAS_USER;
  const NAS_PASS = process.env.NAS_PASS;

  const promptRV = `Extrai os dados deste Relatório de Visita e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: num (string), data (dd/mm/yyyy), duracao (string), meteo (string), fiscal (string), fase (string),
trabObra (string), presencas (string), temas (string), estado (Normal|Alerta|Suspenso), temaPrincipal (string), obs (string), assuntos (string).
Se um campo não existir usa "".`;

  const promptAR = `Extrai os dados desta Ata de Reunião e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: num (string), data (dd/mm/yyyy), trabObra (string), tipos (array: "Normal" e/ou "Alerta crítico"),
participantes (string), temas (string), temaPrincipal (string), decisoes (string), pendentes (string).
Se um campo não existir usa "" ou [].`;

  // ── Processar ficheiro com Claude ─────────────────────────────────────
  async function processarFicheiro(buffer, fileName, subTipo) {
    const isDocx = (fileName||'').toLowerCase().match(/\.docx?$/);
    const isPDF = (fileName||'').toLowerCase().endsWith('.pdf');
    const prompt = subTipo === 'rv' ? promptRV : promptAR;
    let msgContent;
    if (isPDF) {
      msgContent = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
        { type: 'text', text: prompt }
      ];
    } else if (isDocx) {
      const result = await mammoth.extractRawText({ buffer });
      msgContent = [{ type: 'text', text: prompt + '\n\nConteúdo:\n\n' + result.value }];
    } else {
      msgContent = [{ type: 'text', text: prompt + '\n\nConteúdo:\n\n' + buffer.toString('utf-8') }];
    }
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages: [{ role: 'user', content: msgContent }] }),
    });
    const claudeData = await claudeResp.json();
    if (claudeData.error) throw new Error(claudeData.error.message);
    const text = claudeData.content?.map(c => c.text || '').join('').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Sem JSON: ' + text.substring(0, 100));
    return JSON.parse(jsonMatch[0]);
  }

  // ── ACÇÃO: listar ficheiros da NAS (sem processar) ────────────────────
  if (action === 'listar') {
    if (!obraCodigo || !obraNome || !mes || !ano || !tipo) {
      return res.status(400).json({ error: 'Falta parâmetros' });
    }
    try {
      const loginResp = await fetch(
        `${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${encodeURIComponent(NAS_USER)}&passwd=${encodeURIComponent(NAS_PASS)}&session=FileStation&format=sid`
      );
      const loginData = await loginResp.json();
      if (!loginData.success) throw new Error('Falha autenticação NAS');
      const sid = loginData.data.sid;

      const mesStr = String(mes).padStart(2, '0');
      const anoStr = String(ano);
      const pastaNum = tipo === 'ar' ? '10 AR' : '20 RV';
      const pasta = `/500 Obras/${obraCodigo} ${obraNome}/300 CO/70 VR/${pastaNum}`;

      const listResp = await fetch(
        `${NAS_URL}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${encodeURIComponent(pasta)}&_sid=${sid}`
      );
      const listData = await listResp.json();
      await fetch(`${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=1&method=logout&session=FileStation&_sid=${sid}`);

      if (!listData.success) return res.status(200).json({ success: true, ficheiros: [] });

      const ficheiros = (listData.data?.files || []).filter(f => {
        const nome = f.name || '';
        return nome.includes(anoStr + ' ' + mesStr) && !f.isdir;
      });

      // Aplicar regra de revisões
      const mapa = {};
      for (const f of ficheiros) {
        const match = f.name.match(/^(\d+)\.(\d+)/);
        if (match) {
          const idBase = match[1];
          const rev = parseInt(match[2]);
          if (!mapa[idBase] || rev > mapa[idBase].rev) mapa[idBase] = { rev, ficheiro: f };
        } else {
          mapa[f.name] = { rev: 0, ficheiro: f };
        }
      }
      const ficheirosFiltrados = Object.values(mapa).map(x => x.ficheiro);
      return res.status(200).json({ success: true, ficheiros: ficheirosFiltrados });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ACÇÃO: processar lote de ficheiros da NAS ─────────────────────────
  if (action === 'processar_lote') {
    if (!obraCodigo || !obraNome || !tipo || !files?.length) {
      return res.status(400).json({ error: 'Falta parâmetros' });
    }
    try {
      const loginResp = await fetch(
        `${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${encodeURIComponent(NAS_USER)}&passwd=${encodeURIComponent(NAS_PASS)}&session=FileStation&format=sid`
      );
      const loginData = await loginResp.json();
      if (!loginData.success) throw new Error('Falha autenticação NAS');
      const sid = loginData.data.sid;

      const resultados = [];
      for (const f of files) {
        try {
          const dlResp = await fetch(
            `${NAS_URL}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&path=${encodeURIComponent(f.path)}&mode=download&_sid=${sid}`
          );
          if (!dlResp.ok) throw new Error('Download falhou');
          const buffer = Buffer.from(await dlResp.arrayBuffer());
          const data = await processarFicheiro(buffer, f.name, tipo);
          resultados.push({ success: true, data, fileName: f.name });
        } catch (err) {
          resultados.push({ success: false, error: err.message, fileName: f.name });
        }
      }
      await fetch(`${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=1&method=logout&session=FileStation&_sid=${sid}`);
      return res.status(200).json({ success: true, results: resultados });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ACÇÃO: processar ficheiros enviados manualmente ───────────────────
  if (!files || !files.length || !tipo) return res.status(400).json({ error: 'Falta files ou tipo' });

  const getPrompt = () => customPrompt || (tipo === 'rv' ? promptRV : tipo === 'ar' ? promptAR : '');
  const results = [];
  for (const f of files) {
    try {
      const { fileBase64, fileName, contentType } = f;
      const buffer = Buffer.from(fileBase64, 'base64');
      const prompt = getPrompt();
      const isPDF = (contentType || '').includes('pdf') || (fileName || '').toLowerCase().endsWith('.pdf');
      const isDocx = (contentType || '').includes('word') || (fileName || '').toLowerCase().match(/\.docx?$/);
      let msgContent;
      if (isPDF) {
        msgContent = [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } },
          { type: 'text', text: prompt }
        ];
      } else if (isDocx) {
        const result = await mammoth.extractRawText({ buffer });
        msgContent = [{ type: 'text', text: prompt + '\n\nConteúdo:\n\n' + result.value }];
      } else {
        msgContent = [{ type: 'text', text: prompt + '\n\nConteúdo:\n\n' + buffer.toString('utf-8') }];
      }
      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, messages: [{ role: 'user', content: msgContent }] }),
      });
      const claudeData = await claudeResp.json();
      if (claudeData.error) throw new Error(claudeData.error.message);
      const text = claudeData.content?.map(c => c.text || '').join('').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Sem JSON: ' + text.substring(0, 150));
      results.push({ success: true, data: JSON.parse(jsonMatch[0]), fileName });
    } catch (err) {
      results.push({ success: false, error: err.message, fileName: f.fileName });
    }
  }
  return res.status(200).json({ results });
}
