import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

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

  // ── Prompts ───────────────────────────────────────────────────────────

  const promptRV = `Extrai os dados deste Relatório de Visita e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: num (string), data (dd/mm/yyyy), duracao (string), meteo (string), fiscal (string), fase (string),
trabObra (string), presencas (string), temas (string), estado (Normal|Alerta|Suspenso), temaPrincipal (string), obs (string), assuntos (string).
Se um campo não existir usa "".`;

  const promptAR = `Extrai os dados desta Ata de Reunião e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: num (string), data (dd/mm/yyyy), trabObra (string), tipos (array: "Normal" e/ou "Alerta crítico"),
participantes (string), temas (string), temaPrincipal (string), decisoes (string), pendentes (string).
Se um campo não existir usa "" ou [].`;

  const promptPE = `Extrai os dados deste Pedido de Esclarecimento (PE) e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: referencia (string, ex: "001.0"), assunto (string), descricao (string), elementos (string, elementos pedidos ou em causa),
disciplina (string, ex: Arquitetura/Estruturas/MEP/etc), urgente (boolean), obs (string).
Se um campo não existir usa "" ou false.`;

  const promptPA = `Extrai os dados deste Pedido de Aprovação (PA) e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: referencia (string, ex: "001.0"), assunto (string), descricao (string), elementos (string, elementos submetidos a aprovação),
disciplina (string, ex: Arquitetura/Estruturas/MEP/etc), urgente (boolean), obs (string).
Se um campo não existir usa "" ou false.`;

  const promptResposta = `Extrai os dados desta Resposta a um Pedido de Esclarecimento ou Aprovação e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: decisao (string, ex: Aprovado|Aprovado com condições|Não aprovado|Esclarecido|Esclarecimento insuficiente),
condicoes (string, condições ou observações à decisão), responsavel (string, quem assina a resposta), obs (string).
Se um campo não existir usa "".`;

  // ── Helper: processar ficheiro com Claude ─────────────────────────────
  async function processarFicheiro(buffer, fileName, subTipo) {
    const isDocx = (fileName || '').toLowerCase().match(/\.docx?$/);
    const isPDF = (fileName || '').toLowerCase().endsWith('.pdf');
    let prompt;
    if (subTipo === 'rv') prompt = promptRV;
    else if (subTipo === 'ar') prompt = promptAR;
    else if (subTipo === 'pe') prompt = promptPE;
    else if (subTipo === 'pa') prompt = promptPA;
    else if (subTipo === 'resposta') prompt = promptResposta;
    else prompt = customPrompt || '';

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

  // ── Helper: autenticar NAS ────────────────────────────────────────────
  async function nasLogin() {
    const loginResp = await fetch(
      `${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${encodeURIComponent(NAS_USER)}&passwd=${encodeURIComponent(NAS_PASS)}&session=FileStation&format=sid`
    );
    const loginData = await loginResp.json();
    if (!loginData.success) throw new Error('Falha autenticação NAS');
    return loginData.data.sid;
  }

  async function nasLogout(sid) {
    await fetch(`${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=1&method=logout&session=FileStation&_sid=${sid}`);
  }

  async function nasListar(sid, pasta) {
    const resp = await fetch(
      `${NAS_URL}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${encodeURIComponent(pasta)}&_sid=${sid}`
    );
    const data = await resp.json();
    if (!data.success) return [];
    return data.data?.files || [];
  }

  async function nasDownload(sid, path) {
    const resp = await fetch(
      `${NAS_URL}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&path=${encodeURIComponent(path)}&mode=download&_sid=${sid}`
    );
    if (!resp.ok) throw new Error('Download falhou: ' + path);
    return Buffer.from(await resp.arrayBuffer());
  }

  // ── Helper: parsear Excel de listagem PE/PA ───────────────────────────
  function parsearExcelPEPA(buffer) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const resultado = { pe: [], pa: [] };

    for (const nomeSheet of wb.SheetNames) {
      const nomeLower = nomeSheet.toLowerCase();
      const tipo = nomeLower.includes('pe') ? 'pe' : nomeLower.includes('pa') ? 'pa' : null;
      if (!tipo) continue;

      const ws = wb.Sheets[nomeSheet];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

      for (const row of rows) {
        // Normalizar chaves para lowercase sem acentos
        const r = {};
        for (const [k, v] of Object.entries(row)) {
          r[k.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_')] = v;
        }

        // Tentar mapear colunas comuns independentemente dos nomes exatos
        const ref = String(r.ref || r.referencia || r.numero || r.num || r.n || '').trim();
        if (!ref) continue; // linha vazia

        const formatarData = (v) => {
          if (!v) return '';
          if (v instanceof Date) return v.toLocaleDateString('pt-PT');
          return String(v).trim();
        };

        resultado[tipo].push({
          ref,
          assunto: String(r.assunto || r.designacao || r.descricao || r.titulo || '').trim(),
          dataSubmissao: formatarData(r.data_submissao || r.data || r.submetido || r.data_envio || ''),
          dataResposta: formatarData(r.data_resposta || r.respondido || r.resposta || ''),
          estado: String(r.estado || r.situacao || r.status || '').trim(),
          prazo: formatarData(r.prazo || r.data_limite || ''),
          responsavel: String(r.responsavel || r.para || r.destinatario || '').trim(),
          obs: String(r.obs || r.observacoes || r.notas || '').trim(),
          // guardar linha original para referência
          _raw: r
        });
      }
    }
    return resultado;
  }

  // ════════════════════════════════════════════════════════════════════
  // ACÇÃO: listar (AR/RV — lógica original)
  // ════════════════════════════════════════════════════════════════════
  if (action === 'listar') {
    if (!obraCodigo || !obraNome || !mes || !ano || !tipo) {
      return res.status(400).json({ error: 'Falta parâmetros' });
    }
    try {
      const sid = await nasLogin();
      const mesStr = String(mes).padStart(2, '0');
      const anoStr = String(ano);
      const pastaNum = tipo === 'ar' ? '10 AR' : '20 RV';
      const pasta = `/500 Obras/${obraCodigo} ${obraNome}/300 CO/70 VR/${pastaNum}`;

      const listData = await nasListar(sid, pasta);
      await nasLogout(sid);

      const ficheiros = listData.filter(f => {
        const nome = f.name || '';
        return nome.includes(anoStr + ' ' + mesStr) && !f.isdir;
      });

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
      return res.status(200).json({ success: true, ficheiros: Object.values(mapa).map(x => x.ficheiro) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // ACÇÃO: processar_lote (AR/RV — lógica original)
  // ════════════════════════════════════════════════════════════════════
  if (action === 'processar_lote') {
    if (!obraCodigo || !obraNome || !tipo || !files?.length) {
      return res.status(400).json({ error: 'Falta parâmetros' });
    }
    try {
      const sid = await nasLogin();
      const resultados = [];
      for (const f of files) {
        try {
          const buffer = await nasDownload(sid, f.path);
          const data = await processarFicheiro(buffer, f.name, tipo);
          resultados.push({ success: true, data, fileName: f.name });
        } catch (err) {
          resultados.push({ success: false, error: err.message, fileName: f.name });
        }
      }
      await nasLogout(sid);
      return res.status(200).json({ success: true, results: resultados });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // ACÇÃO: listar_pe_pa  — lê Excel + lista subpastas PE ou PA
  // ════════════════════════════════════════════════════════════════════
  if (action === 'listar_pe_pa') {
    if (!obraCodigo || !obraNome || !tipo || !mes || !ano) {
      return res.status(400).json({ error: 'Falta parâmetros (obraCodigo, obraNome, tipo, mes, ano)' });
    }
    const sigla = tipo.toUpperCase(); // PE ou PA
    const pastaNum = tipo === 'pe' ? '30 PE' : '40 PA';
    const pastaCO = `/500 Obras/${obraCodigo} ${obraNome}/300 CO`;
    const pastaTipo = `${pastaCO}/${pastaNum}`;

    try {
      const sid = await nasLogin();

      // 1. Ler Excel de listagem na raíz da 300 CO
      let dadosExcel = { pe: [], pa: [] };
      const ficheirosCO = await nasListar(sid, pastaCO);
      const excel = ficheirosCO.find(f => !f.isdir && (f.name || '').match(/\.xlsx?$/i));
      if (excel) {
        try {
          const bufExcel = await nasDownload(sid, excel.path);
          dadosExcel = parsearExcelPEPA(bufExcel);
        } catch (e) {
          console.warn('Aviso: não foi possível ler Excel:', e.message);
        }
      }

      // 2. Listar subpastas dentro de 30 PE ou 40 PA
      const subpastas = await nasListar(sid, pastaTipo);
      await nasLogout(sid);

      // Apenas directórios que contenham a sigla PE ou PA no nome
      const pastas = subpastas.filter(f => f.isdir && (f.name || '').toUpperCase().includes(sigla));

      // 3. Para cada subpasta extrair referência e nome
      const itens = pastas.map(p => {
        // Ex: "001.0 PE - Demolição de Paredes"
        const match = p.name.match(/^(\d+\.\d+)\s+(?:PE|PA)\s*[-–]\s*(.+)$/i);
        const ref = match ? match[1] : p.name;
        const nome = match ? match[2].trim() : p.name;

        // Cruzar com dados do Excel (fonte de verdade para metadados)
        const excelRow = dadosExcel[tipo].find(e =>
          e.ref === ref || e.assunto?.toLowerCase() === nome.toLowerCase()
        ) || {};

        return {
          ref,
          nome,
          pastaPath: p.path,
          pastaNome: p.name,
          // Metadados do Excel (fonte de verdade)
          dataSubmissao: excelRow.dataSubmissao || '',
          dataResposta: excelRow.dataResposta || '',
          estado: excelRow.estado || '',
          prazo: excelRow.prazo || '',
          responsavel: excelRow.responsavel || '',
          obs: excelRow.obs || '',
          // Flag se tem resposta (baseado no Excel)
          temResposta: !!(excelRow.dataResposta),
        };
      });

      // 4. Filtrar por mês/ano de submissão (fonte de verdade: Excel)
      // Aceita formatos: dd/mm/yyyy, d/m/yyyy, yyyy-mm-dd, mm/yyyy, etc.
      const mesNum = parseInt(mes);
      const anoNum = parseInt(ano);

      const dataCorresponde = (dataStr) => {
        if (!dataStr) return false;
        // Tentar vários formatos
        // dd/mm/yyyy ou d/m/yyyy
        const m1 = dataStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m1) return parseInt(m1[2]) === mesNum && parseInt(m1[3]) === anoNum;
        // yyyy-mm-dd
        const m2 = dataStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m2) return parseInt(m2[2]) === mesNum && parseInt(m2[1]) === anoNum;
        // mm/yyyy
        const m3 = dataStr.match(/^(\d{1,2})\/(\d{4})/);
        if (m3) return parseInt(m3[1]) === mesNum && parseInt(m3[2]) === anoNum;
        return false;
      };

      const itensFiltrados = itens.filter(item => dataCorresponde(item.dataSubmissao));
      itensFiltrados.sort((a, b) => {
        const [an, ar] = a.ref.split('.').map(Number);
        const [bn, br] = b.ref.split('.').map(Number);
        return an !== bn ? an - bn : ar - br;
      });

      return res.status(200).json({
        success: true,
        itens: itensFiltrados,
        totalExcel: dadosExcel[tipo].length,
        excelEncontrado: !!excel
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // ACÇÃO: processar_pe_pa — extrai conteúdo de uma pasta PE/PA com IA
  // ════════════════════════════════════════════════════════════════════
  if (action === 'processar_pe_pa') {
    // pastaPath: path completo da subpasta, ex: /500 Obras/.../30 PE/001.0 PE - Demolição
    const { pastaPath, pastaNome } = req.body;
    if (!pastaPath || !tipo) {
      return res.status(400).json({ error: 'Falta parâmetros (pastaPath, tipo)' });
    }
    const sigla = tipo.toUpperCase();

    try {
      const sid = await nasLogin();
      const ficheiros = await nasListar(sid, pastaPath);

      // Separar: pedido principal, resposta, anexos
      const nomePasta = pastaNome || '';
      const ficheirosPedido = [];
      const ficheirosResposta = [];
      const ficheirosAnexo = [];

      for (const f of ficheiros) {
        if (f.isdir) continue;
        const nome = f.name || '';
        const nomeLower = nome.toLowerCase();
        // Resposta: contém " r " ou "resposta" no nome (case insensitive)
        if (nomeLower.includes(' resposta') || nomeLower.match(/\s+r\s*\./)) {
          ficheirosResposta.push(f);
        }
        // Pedido principal: mesmo nome da pasta (sem extensão) ou contém a sigla PE/PA
        else if (nomeLower.includes(sigla.toLowerCase()) && !nomeLower.includes('anexo')) {
          ficheirosPedido.push(f);
        }
        // Resto: anexos
        else {
          ficheirosAnexo.push(f);
        }
      }

      // Processar pedido principal (primeiro ficheiro encontrado)
      let dadosPedido = null;
      if (ficheirosPedido.length) {
        try {
          const buf = await nasDownload(sid, ficheirosPedido[0].path);
          dadosPedido = await processarFicheiro(buf, ficheirosPedido[0].name, tipo);
        } catch (e) {
          console.warn('Aviso: erro ao processar pedido:', e.message);
        }
      }

      // Processar resposta (primeiro ficheiro de resposta)
      let dadosResposta = null;
      if (ficheirosResposta.length) {
        try {
          const buf = await nasDownload(sid, ficheirosResposta[0].path);
          dadosResposta = await processarFicheiro(buf, ficheirosResposta[0].name, 'resposta');
        } catch (e) {
          console.warn('Aviso: erro ao processar resposta:', e.message);
        }
      }

      await nasLogout(sid);

      return res.status(200).json({
        success: true,
        pedido: dadosPedido,
        resposta: dadosResposta,
        anexos: ficheirosAnexo.map(f => ({ nome: f.name, path: f.path })),
        ficheiros: {
          pedido: ficheirosPedido.map(f => ({ nome: f.name, path: f.path })),
          resposta: ficheirosResposta.map(f => ({ nome: f.name, path: f.path })),
        }
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // ACÇÃO: processar ficheiros enviados manualmente (lógica original)
  // ════════════════════════════════════════════════════════════════════
  if (!files || !files.length || !tipo) return res.status(400).json({ error: 'Falta files ou tipo' });

  const getPrompt = () => customPrompt || (
    tipo === 'rv' ? promptRV :
    tipo === 'ar' ? promptAR :
    tipo === 'pe' ? promptPE :
    tipo === 'pa' ? promptPA : ''
  );

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
