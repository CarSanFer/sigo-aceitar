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
Campos do pedido: autor (string), enviado (dd/mm/yyyy), idArtigos (string), desenhos (string), assunto (string),
anexos (string, lista de anexos se existirem), pedido (string, texto do pedido de esclarecimento).
Campos da resposta (pode haver mais do que uma, devolver array "respostas"): cada elemento tem
data (dd/mm/yyyy), autor (string), anexos (string), esclarecimento (string), observacoes (string).
Se um campo não existir usa "" ou [].
Formato: { "autor":"", "enviado":"", "idArtigos":"", "desenhos":"", "assunto":"", "anexos":"", "pedido":"", "respostas":[] }`;

  const promptPA = `Extrai os dados deste Pedido de Aprovação (PA) e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: referencia (string, ex: "001.0"), assunto (string), descricao (string), elementos (string, elementos submetidos a aprovação),
disciplina (string, ex: Arquitetura/Estruturas/MEP/etc), urgente (boolean), obs (string).
Se um campo não existir usa "" ou false.`;

  const promptResposta = `Extrai os dados desta Resposta a um Pedido de Esclarecimento ou Aprovação e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: decisao (string, ex: Aprovado|Aprovado com condições|Não aprovado|Esclarecido|Esclarecimento insuficiente),
condicoes (string, condições ou observações à decisão), responsavel (string, quem assina a resposta), obs (string).
Se um campo não existir usa "".`;

  const promptRespostaPE = `Extrai os dados desta Resposta a um Pedido de Esclarecimento e devolve APENAS um objecto JSON com array "respostas".
Cada resposta tem: data (dd/mm/yyyy), autor (string), anexos (string), esclarecimento (string, texto da resposta/esclarecimento), observacoes (string).
Pode haver mais do que uma resposta no documento — extrai todas.
Devolve APENAS: { "respostas": [ { "data":"", "autor":"", "anexos":"", "esclarecimento":"", "observacoes":"" } ] }
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
    else if (subTipo === 'resposta_pe') prompt = promptRespostaPE;
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

    const fmtData = (v) => {
      if (!v) return '';
      if (v instanceof Date) {
        const d = String(v.getDate()).padStart(2,'0');
        const m = String(v.getMonth()+1).padStart(2,'0');
        const a = v.getFullYear();
        return `${d}/${m}/${a}`;
      }
      return String(v).trim();
    };

    // ── Folha PE ──────────────────────────────────────────────────────
    // Linha 4: cabeçalho | Linha 5+: dados
    // Cols (0-based): 1=Id, 2=Esp, 3=Descrição, 4=Ent Exec, 5=Fiscaliz(env),
    //                 6=Projetista, 7=Fiscaliz(resp), 8=Fecho, 9=Observações
    if (wb.SheetNames.includes('PE')) {
      const ws = wb.Sheets['PE'];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      for (let i = 4; i < rows.length; i++) { // dados a partir da linha 5 (index 4)
        const row = rows[i];
        const id = row[1];
        if (!id || String(id).trim() === '') continue;
        resultado.pe.push({
          ref: String(id).trim(),
          assunto: String(row[3] || '').trim(),
          esp: String(row[2] || '').trim(),
          dataSubmissao: fmtData(row[4]),  // Ent Exec
          dataEnvioFisc: fmtData(row[5]),  // Fiscaliz (envio)
          dataProjetista: fmtData(row[6]), // Projetista
          dataRespFisc: fmtData(row[7]),   // Fiscaliz (resp)
          dataFecho: fmtData(row[8]),      // Fecho
          estado: row[8] ? 'Fechado' : (row[7] ? 'Respondido' : 'Pendente'),
          obs: String(row[9] || '').trim(),
        });
      }
    }

    // ── Folha PA ──────────────────────────────────────────────────────
    // Linha 4: cabeçalho | Linha 5+: dados
    // Cols (0-based): 1=Id, 2=Esp, 3=M|E, 4=P|N, 5=Descrição, 6=Ent Exec,
    //                 7=Fiscaliz(env), 8=Proj, 9=Fiscaliz(resp), 10=Estado, 11=Obs
    if (wb.SheetNames.includes('PA')) {
      const ws = wb.Sheets['PA'];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      for (let i = 4; i < rows.length; i++) {
        const row = rows[i];
        const id = row[1];
        if (!id || String(id).trim() === '') continue;
        resultado.pa.push({
          ref: String(id).trim(),
          assunto: String(row[5] || '').trim(),
          esp: String(row[2] || '').trim(),
          tipoME: String(row[3] || '').trim(),  // Mat/Equip
          tipoPN: String(row[4] || '').trim(),  // Prev/Nov
          dataSubmissao: fmtData(row[6]),        // Ent Exec
          dataEnvioFisc: fmtData(row[7]),        // Fiscaliz (envio)
          dataProjetista: fmtData(row[8]),       // Proj
          dataRespFisc: fmtData(row[9]),         // Fiscaliz (resp)
          estado: String(row[10] || '').trim(),  // Aprov / Não Aprov / etc
          obs: String(row[11] || '').trim(),
          dataResposta: fmtData(row[9]),         // para compatibilidade com filtro
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
      const excel = ficheirosCO.find(f => !f.isdir && (f.name || '').match(/\.xlsx?$/i) && !(f.name || '').startsWith('~$'));
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

      // Mapa de pastas NAS por referência — aceita com ou sem traço
      const mapaPasstas = {};
      for (const p of subpastas) {
        if (!p.isdir) continue;
        const match = p.name.match(/^(\d+\.\d+)\s+(?:PE|PA)/i);
        if (match) mapaPasstas[match[1]] = p;
      }

      // 3. Partir do Excel — filtrar por mês/ano em qualquer coluna de data
      const mesNum = parseInt(mes);
      const anoNum = parseInt(ano);

      const dataCorresponde = (dataStr) => {
        if (!dataStr) return false;
        const m1 = dataStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m1) return parseInt(m1[2]) === mesNum && parseInt(m1[3]) === anoNum;
        const m2 = dataStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m2) return parseInt(m2[2]) === mesNum && parseInt(m2[1]) === anoNum;
        return false;
      };

      const itensExcel = dadosExcel[tipo].filter(e =>
        dataCorresponde(e.dataSubmissao)  ||
        dataCorresponde(e.dataEnvioFisc)  ||
        dataCorresponde(e.dataProjetista) ||
        dataCorresponde(e.dataRespFisc)   ||
        dataCorresponde(e.dataFecho)
      );

      // 4. Construir itens cruzando Excel (fonte de verdade) com pasta NAS (se existir)
      const itens = itensExcel.map(e => {
        const pasta = mapaPasstas[e.ref] || null;
        return {
          ref:            e.ref,
          nome:           e.assunto,
          pastaPath:      pasta ? pasta.path : null,
          pastaNome:      pasta ? pasta.name : null,
          temPasta:       !!pasta,
          esp:            e.esp            || '',
          dataSubmissao:  e.dataSubmissao  || '',
          dataEnvioFisc:  e.dataEnvioFisc  || '',
          dataProjetista: e.dataProjetista || '',
          dataRespFisc:   e.dataRespFisc   || '',
          dataFecho:      e.dataFecho      || '',
          dataResposta:   e.dataRespFisc   || '',
          estado:         e.estado         || '',
          obs:            e.obs            || '',
          temResposta:    !!e.dataRespFisc,
        };
      });

      itens.sort((a, b) => {
        const [an, ar] = a.ref.split('.').map(Number);
        const [bn, br] = b.ref.split('.').map(Number);
        return an !== bn ? an - bn : ar - br;
      });

      return res.status(200).json({
        success: true,
        itens,
        totalExcel: dadosExcel[tipo].length,
        excelEncontrado: !!excel,
        _debug: { pastaTipo, totalSubpastas: subpastas.length, totalExcel: dadosExcel[tipo].length, itensMes: itens.length, excelNome: excel?.name || null, ficheirosCONomes: ficheirosCO.filter(f=>!f.isdir).map(f=>f.name) }
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // ACÇÃO: processar_pe_pa — lê Excel da pasta PE/PA directamente
  // ════════════════════════════════════════════════════════════════════
  if (action === 'processar_pe_pa') {
    const { pastaPath, pastaNome } = req.body;
    console.log('processar_pe_pa tipo=', tipo, 'pasta=', pastaPath);
    if (!pastaPath || !tipo) {
      return res.status(400).json({ error: 'Falta parâmetros (pastaPath, tipo)' });
    }
    const sigla = tipo.toUpperCase();

    try {
      const sid = await nasLogin();
      const ficheiros = await nasListar(sid, pastaPath);

      // Encontrar o Excel na pasta (ou em subpasta directa)
      const isTemp = n => (n||'').startsWith('~$');
      const fExcels = ficheiros.filter(f => !f.isdir && (f.name||'').match(/\.xlsx?$/i) && !isTemp(f.name));
      let fResposta = fExcels.find(f => f.name.toLowerCase().includes('resposta'));
      let fPedido   = fExcels.find(f => !f.name.toLowerCase().includes('resposta'));

      // Se não encontrou Excel directamente, procurar em subpastas
      if (!fResposta && !fPedido) {
        const subpastas = ficheiros.filter(f => f.isdir);
        for (const sub of subpastas) {
          const subFichs = await nasListar(sid, sub.path);
          const subExcels = subFichs.filter(f => !f.isdir && (f.name||'').match(/\.xlsx?$/i) && !isTemp(f.name));
          if (!fResposta) fResposta = subExcels.find(f => f.name.toLowerCase().includes('resposta'));
          if (!fPedido)   fPedido   = subExcels.find(f => !f.name.toLowerCase().includes('resposta'));
          if (fResposta || fPedido) break;
        }
      }

      const ficheirosAnexo = ficheiros.filter(f => !f.isdir && !(f.name||'').match(/\.xlsx?$/i) && !isTemp(f.name));

      // Helper: ler Excel PE da NAS e extrair campos por posição fixa
      const lerExcelPE = async (f) => {
        const buf = await nasDownload(sid, f.path);
        const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

        const fmtData = (v) => {
          if (!v) return '';
          if (v instanceof Date) {
            return `${String(v.getDate()).padStart(2,'0')}/${String(v.getMonth()+1).padStart(2,'0')}/${v.getFullYear()}`;
          }
          return String(v).trim();
        };
        const cel = (linha, col) => {
          const r = rows[linha - 1];
          return r ? (r[col] != null ? String(r[col]).trim() : '') : '';
        };

        const pedido = {
          id:       cel(7, 1),
          autor:    cel(7, 4),
          enviado:  fmtData(rows[6]?.[7]),
          idArtigos: cel(7, 10),
          desenhos: cel(7, 13),
          assunto:  cel(10, 1),
          anexos:   cel(10, 13),
          pedido:   cel(13, 1),
          respostas: []
        };

        const dataProj = rows[26]?.[1];
        if (dataProj || cel(30, 1)) {
          pedido.respostas.push({
            tipo:           'Projetista',
            data:           fmtData(dataProj),
            autor:          cel(27, 4),
            anexos:         cel(27, 13),
            esclarecimento: cel(30, 1),
            observacoes:    ''
          });
        }

        const dataFisc = rows[38]?.[1];
        if (dataFisc || cel(41, 1)) {
          pedido.respostas.push({
            tipo:           'Fiscalização',
            data:           fmtData(dataFisc),
            autor:          cel(39, 4),
            anexos:         cel(39, 13),
            esclarecimento: '',
            observacoes:    cel(41, 1)
          });
        }

        return pedido;
      };

      // Helper: ler Excel PA da NAS e extrair campos por posição fixa
      const lerExcelPA = async (f) => {
        const buf = await nasDownload(sid, f.path);
        const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

        const fmtData = (v) => {
          if (!v) return '';
          if (v instanceof Date) {
            return `${String(v.getDate()).padStart(2,'0')}/${String(v.getMonth()+1).padStart(2,'0')}/${v.getFullYear()}`;
          }
          return String(v).trim();
        };
        const cel = (linha, col) => {
          const r = rows[linha - 1];
          return r ? (r[col] != null ? String(r[col]).trim() : '') : '';
        };

        // Pedido — L7, L10, L13, L16
        const pedido = {
          id:           cel(7, 1),
          autor:        cel(7, 4),
          enviado:      cel(7, 7),
          especialidade: cel(7, 10),
          matEquip:     cel(7, 13),
          capitulo:     cel(10, 1),
          artigo:       cel(10, 4),
          referencia:   cel(10, 7),
          localizacao:  cel(10, 10),
          previsto:     cel(10, 13),
          amostras:     cel(13, 1),
          fichas:       cel(13, 4),
          docsConform:  cel(13, 7),
          outros:       cel(13, 10),
          proposto:     cel(13, 13),
          observacoes:  cel(16, 1),
          respostas: []
        };

        // Resposta Projetista — L25, L27
        const dataProjRow = rows[24]; // L25 (0-based)
        const dataProjVal = dataProjRow?.[1];
        const obsProj = cel(27, 1);
        if (dataProjVal || obsProj) {
          pedido.respostas.push({
            tipo:        'Projetista',
            data:        fmtData(dataProjVal),
            autor:       cel(25, 4),
            parecer:     cel(25, 7),
            anexos:      cel(25, 13),
            observacoes: obsProj
          });
        }

        // Resposta Fiscalização — L37, L39
        const dataFiscVal = rows[36]?.[1]; // L37
        const obsFisc = cel(39, 1);
        if (dataFiscVal || obsFisc) {
          pedido.respostas.push({
            tipo:        'Fiscalização',
            data:        fmtData(dataFiscVal),
            autor:       cel(37, 4),
            parecer:     cel(37, 7),
            anexos:      cel(37, 13),
            observacoes: obsFisc
          });
        }

        return pedido;
      };

      // Processar ficheiro principal (preferir Resposta se existir — tem tudo)
      let dadosPedido = null;
      let erroPedido = null;
      const fParaLer = fResposta || fPedido;
      if (fParaLer) {
        try {
          dadosPedido = tipo === 'pa' ? await lerExcelPA(fParaLer) : await lerExcelPE(fParaLer);
        } catch (e) {
          erroPedido = e.message;
          console.warn('Erro ao ler Excel:', e.message);
        }
      }

      await nasLogout(sid);

      return res.status(200).json({
        success: true,
        pedido: dadosPedido,
        resposta: null, // já incluído dentro de pedido.respostas
        anexos: ficheirosAnexo.map(f => ({ nome: f.name, path: f.path })),
        ficheiros: {
          pedido:   fPedido   ? [{ nome: fPedido.name,   path: fPedido.path   }] : [],
          resposta: fResposta ? [{ nome: fResposta.name, path: fResposta.path }] : [],
        },
        _debug: {
          tipo,
          totalFicheiros: ficheiros.length,
          nomesFicheiros: ficheiros.map(f => f.name),
          ficheiroLido: fParaLer?.name || null,
          erroPedido
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
