import mammoth from 'mammoth';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { files, tipo, prompt: customPrompt, action, obraCodigo, obraNome, mes, ano } = req.body;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NAS_URL = process.env.NAS_URL;
  const NAS_USER = process.env.NAS_USER;
  const NAS_PASS = process.env.NAS_PASS;

  // ── ACÇÃO: listar e sincronizar da NAS ──────────────────────────────
  if (action === 'sincronizar') {
    if (!obraCodigo || !obraNome || !mes || !ano) {
      return res.status(400).json({ error: 'Falta obraCodigo, obraNome, mes ou ano' });
    }
    try {
      // 1. Autenticar
      const loginResp = await fetch(
        `${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${encodeURIComponent(NAS_USER)}&passwd=${encodeURIComponent(NAS_PASS)}&session=FileStation&format=sid`
      );
      const loginData = await loginResp.json();
      if (!loginData.success) throw new Error('Falha autenticação NAS: ' + JSON.stringify(loginData));
      const sid = loginData.data.sid;

      const mesStr = String(mes).padStart(2, '0');
      const anoStr = String(ano);
      const pastaBase = `/500 Obras/${obraCodigo} ${obraNome}/300 CO/70 VR`;

      const resultados = { ar: [], rv: [] };

      for (const subTipo of ['ar', 'rv']) {
        const pastaNum = subTipo === 'ar' ? '10 AR' : '20 RV';
        const pasta = `${pastaBase}/${pastaNum}`;

        // 2. Listar ficheiros
        const listResp = await fetch(
          `${NAS_URL}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${encodeURIComponent(pasta)}&_sid=${sid}`
        );
        const listData = await listResp.json();
        if (!listData.success) { resultados[subTipo] = []; continue; }

        const ficheiros = (listData.data?.files || []).filter(f => {
          const nome = f.name || '';
          // Filtrar pelo mês e ano: ex "2026 03"
          return nome.includes(anoStr + ' ' + mesStr) && !f.isdir;
        });

        // 3. Aplicar regra de revisões — para cada id base, só a revisão mais alta
        const mapa = {};
        for (const f of ficheiros) {
          const match = f.name.match(/^(\d+)\.(\d+)/);
          if (match) {
            const idBase = match[1];
            const rev = parseInt(match[2]);
            if (!mapa[idBase] || rev > mapa[idBase].rev) {
              mapa[idBase] = { rev, ficheiro: f };
            }
          } else {
            // sem padrão id.rev — incluir sempre
            mapa[f.name] = { rev: 0, ficheiro: f };
          }
        }
        const ficheirosFiltrados = Object.values(mapa).map(x => x.ficheiro);

        // 4. Para cada ficheiro, fazer download e processar com Claude
        const promptRV = `Extrai os dados deste Relatório de Visita e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: num (string), data (dd/mm/yyyy), duracao (string), meteo (string), fiscal (string), fase (string),
trabObra (string), presencas (string), temas (string), estado (Normal|Alerta|Suspenso), temaPrincipal (string), obs (string), assuntos (string).
Se um campo não existir usa "".`;

        const promptAR = `Extrai os dados desta Ata de Reunião e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: num (string), data (dd/mm/yyyy), trabObra (string), tipos (array: "Normal" e/ou "Alerta crítico"),
participantes (string), temas (string), temaPrincipal (string), decisoes (string), pendentes (string).
Se um campo não existir usa "" ou [].`;

        for (const f of ficheirosFiltrados) {
          try {
            const dlResp = await fetch(
              `${NAS_URL}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&path=${encodeURIComponent(f.path)}&mode=download&_sid=${sid}`
            );
            if (!dlResp.ok) throw new Error('Download falhou: ' + f.name);
            const buffer = Buffer.from(await dlResp.arrayBuffer());
            const isDocx = f.name.toLowerCase().endsWith('.docx') || f.name.toLowerCase().endsWith('.doc');
            const isPDF = f.name.toLowerCase().endsWith('.pdf');
            let msgContent;
            if (isPDF) {
              msgContent = [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
                { type: 'text', text: subTipo === 'rv' ? promptRV : promptAR }
              ];
            } else if (isDocx) {
              const result = await mammoth.extractRawText({ buffer });
              msgContent = [{ type: 'text', text: (subTipo === 'rv' ? promptRV : promptAR) + '\n\nConteúdo:\n\n' + result.value }];
            } else continue;

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
            resultados[subTipo].push({ success: true, data: JSON.parse(jsonMatch[0]), fileName: f.name });
          } catch (err) {
            resultados[subTipo].push({ success: false, error: err.message, fileName: f.name });
          }
        }
      }

      // Logout
      await fetch(`${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=1&method=logout&session=FileStation&_sid=${sid}`);
      return res.status(200).json({ success: true, resultados });

    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ACÇÃO: processar ficheiros enviados manualmente ──────────────────
  if (!files || !files.length || !tipo) return res.status(400).json({ error: 'Falta files ou tipo' });

  const promptRV = `Extrai os dados deste Relatório de Visita e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: num (string), data (dd/mm/yyyy), duracao (string), meteo (string), fiscal (string), fase (string),
trabObra (string), presencas (string), temas (string), estado (Normal|Alerta|Suspenso), temaPrincipal (string), obs (string), assuntos (string).
Se um campo não existir usa "".`;

  const promptAR = `Extrai os dados desta Ata de Reunião e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: num (string), data (dd/mm/yyyy), trabObra (string), tipos (array: "Normal" e/ou "Alerta crítico"),
participantes (string), temas (string), temaPrincipal (string), decisoes (string), pendentes (string).
Se um campo não existir usa "" ou [].`;

  const getPrompt = () => customPrompt || (tipo === 'rv' ? promptRV : tipo === 'ar' ? promptAR : '');

  const results = [];
  for (const f of files) {
    try {
      const { fileBase64, fileName, contentType } = f;
      const isPDF = (contentType || '').includes('pdf') || (fileName || '').toLowerCase().endsWith('.pdf');
      const isDocx = (contentType || '').includes('word') || (fileName || '').toLowerCase().endsWith('.docx') || (fileName || '').toLowerCase().endsWith('.doc');
      const prompt = getPrompt();
      let msgContent;
      if (isPDF) {
        msgContent = [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } },
          { type: 'text', text: prompt }
        ];
      } else if (isDocx) {
        const buffer = Buffer.from(fileBase64, 'base64');
        const result = await mammoth.extractRawText({ buffer });
        msgContent = [{ type: 'text', text: prompt + '\n\nConteúdo:\n\n' + result.value }];
      } else {
        const texto = Buffer.from(fileBase64, 'base64').toString('utf-8');
        msgContent = [{ type: 'text', text: prompt + '\n\nConteúdo:\n\n' + texto }];
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
      console.error(err);
      results.push({ success: false, error: err.message, fileName: f.fileName });
    }
  }
  return res.status(200).json({ results });
}
