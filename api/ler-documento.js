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
trabObra (string), presencas (string), temas (string), estado (Normal|Alerta|Suspenso), temaPrincipal (string), obs (string), assuntos (string),
criticidade (string, exatamente um de: "Crítico" | "Atenção" | "Normal"; avalia pelo IMPACTO: "Crítico" se houver bloqueio, questão de segurança, ou ameaça a um marco/prazo; "Atenção" se houver risco relevante sem bloqueio; "Normal" se for rotina),
analise (string, UMA frase curta com no máximo 15 palavras que justifica a criticidade atribuída).
Se um campo não existir usa "".`;

  const promptAR = `Extrai os dados desta Ata de Reunião e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: num (string), data (dd/mm/yyyy), trabObra (string), tipos (array: "Normal" e/ou "Alerta crítico"),
participantes (string), temas (string), temaPrincipal (string), decisoes (string), pendentes (string),
criticidade (string, exatamente um de: "Crítico" | "Atenção" | "Normal"; avalia pelo IMPACTO e NÃO pela quantidade de pontos: "Crítico" se houver bloqueio de execução, questão de segurança, ou algo que ameace um marco/prazo contratual; "Atenção" se houver risco relevante sem bloqueio; "Normal" se forem apenas pontos de rotina ou nenhum pendente),
analise (string, UMA frase curta com no máximo 15 palavras que justifica a criticidade atribuída, ex: "Obra parada à espera de parecer da fiscalização sobre a impermeabilização").
Se um campo não existir usa "" ou [].`;

  const promptPE = `Extrai os dados deste Pedido de Esclarecimento (PE) e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos do pedido: id (string, número do PE ex: "009.0"), autor (string), enviado (dd/mm/yyyy), especialidade (string, ex: EST/ARQ/ELE/HID/etc), idArtigos (string), desenhos (string), assunto (string),
anexos (string), pedido (string, texto do pedido de esclarecimento).
Campos da resposta (pode haver mais do que uma, devolver array "respostas"): cada elemento tem
tipo (string: "Projetista" ou "Fiscalização"), data (dd/mm/yyyy), autor (string), anexos (string), esclarecimento (string), observacoes (string).
Se um campo não existir usa "" ou [].
Formato: { "id":"", "autor":"", "enviado":"", "especialidade":"", "idArtigos":"", "desenhos":"", "assunto":"", "anexos":"", "pedido":"", "respostas":[] }`;

  const promptPA = `Extrai os dados deste Pedido de Aprovação (PA) e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos do pedido:
- id (string, número do PA ex: "039.0")
- data (string, data de envio do pedido dd/mm/yyyy)
- especialidade (string, ex: ARQ/EST/ELE/HID/AVAC/etc)
- matEquip (string: "Material" ou "Equipamento" ou ambos)
- motivo (string, descrição/motivo do pedido de aprovação)
- previsto (string, marca ou solução prevista em projecto)
- proposto (string, marca ou solução proposta)
- observacoes (string, observações do pedido)
- respostas (array, pode estar vazio): cada elemento tem:
  - tipo (string: "Projetista" ou "Fiscalização")
  - data (string, dd/mm/yyyy)
  - parecer (string: "Aprovado" | "Aprovado com condições" | "Não aprovado" | "")
  - observacoes (string)
Se um campo não existir usa "" ou [].
Formato: { "id":"", "data":"", "especialidade":"", "matEquip":"", "motivo":"", "previsto":"", "proposto":"", "observacoes":"", "respostas":[] }`;

  const promptPB = `Extrai os dados deste Pedido de Betonagem (PB) e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown, sem formatação.
Campos:
- id (string, número ex: "012.0")
- data (string, data do pedido dd/mm/yyyy)
- elemento (string, elemento estrutural a betonar ex: "Laje Piso 3", "Pilar P1")
- localizacao (string, localização na obra)
- pecaBetonar (string, descrição detalhada da peça a betonar)
- volume (string, volume de betão em m3)
- classeBetao (string, ex: "C25/30")
- consistencia (string, ex: "S3", "S4")
- provetes (string, número de provetes a realizar)
- dataBetonagem (string, data prevista dd/mm/yyyy)
- horaBetonagem (string, hora prevista)
- descofragem (string, prazo ou data de descofragem)
- escoramento (string, prazo ou condições de escoramento)
- observacoes (string)
- observacoes (string)
Se um campo não existir usa "".
Formato exacto: { "id":"", "data":"", "elemento":"", "localizacao":"", "pecaBetonar":"", "volume":"", "classeBetao":"", "consistencia":"", "provetes":"", "dataBetonagem":"", "horaBetonagem":"", "descofragem":"", "escoramento":"", "observacoes":"" }`;

  const promptPTQ = `Extrai os dados deste Plano Quinzenal de Trabalhos (PQ/PTQ) e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: id (string, número ex: "047.0"), semanas (string, ex: "S19 e S20"), dataInicio (string, dd/mm/yyyy), dataFim (string, dd/mm/yyyy),
trabalhosPrevistos (array de strings, secção "Actividades / Trabalhos a Executar" — lista de atividades previstas),
maoObra (array de strings, secção "Carga de Mão de Obra / Trabalhadores em Obra" — cada entrada com a especialidade e o subempreiteiro entre parênteses se indicado, ex: "Pladur (Romildo Bruno Putti)", "Eletricista (Peixotos)"),
equipamentos (array de strings, secção "Carga de Equipamentos / Equipamentos em Obra", ex: "Andaime", "AVAC"),
trabalhosExecutados (array de strings, trabalhos já executados se indicados),
observacoes (string, apenas notas gerais que não caibam nos campos acima).
Se um campo não existir usa "" ou [].
Formato: { "id":"", "semanas":"", "dataInicio":"", "dataFim":"", "trabalhosPrevistos":[], "maoObra":[], "equipamentos":[], "trabalhosExecutados":[], "observacoes":"" }`;

  const promptNC = `Extrai os dados desta Não Conformidade (NC) e devolve APENAS um objecto JSON válido, sem texto antes ou depois, sem markdown.
Campos: id (string, número da NC), data (string, dd/mm/yyyy), descricao (string, descrição da não conformidade),
causa (string), acao (string, acção correctiva), responsavel (string), prazo (string, dd/mm/yyyy), estado (string: Aberto|Fechado),
observacoes (string).
Se um campo não existir usa "".
Formato: { "id":"", "data":"", "descricao":"", "causa":"", "acao":"", "responsavel":"", "prazo":"", "estado":"", "observacoes":"" }`;

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
    else if (subTipo === 'pb') prompt = promptPB;
    else if (subTipo === 'ptq' || subTipo === 'pq') prompt = promptPTQ;
    else if (subTipo === 'nc') prompt = promptNC;
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
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: msgContent }] }),
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
        _debug: { pastaTipo, totalSubpastas: subpastas.length, totalExcel: dadosExcel[tipo].length, itensMes: itens.length, excelNome: excel?.name || null, ficheirosCONomes: ficheirosCO.filter(f=>!f.isdir).map(f=>f.name), nomesPasstas: Object.keys(mapaPasstas), itensTemPasta: itens.filter(x=>x.temPasta).map(x=>x.ref) }
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
          if (!r) return '';
          const v = r[col];
          if (v === null || v === undefined) return '';
          if (v instanceof Date) return fmtData(v);
          return String(v).trim();
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

        // Resposta Projetista — cabeçalho L24, dados L25, obs L27
        const dataProjVal = rows[24]?.[1]; // L25
        const obsProj = cel(27, 1);
        if (dataProjVal || cel(25, 4) || obsProj) {
          pedido.respostas.push({
            tipo:        'Projetista',
            data:        fmtData(dataProjVal),
            autor:       cel(25, 4),
            parecer:     cel(25, 7),
            anexos:      cel(25, 13),
            observacoes: obsProj
          });
        }

        // Resposta Fiscalização — cabeçalho L36, dados L37, obs L39
        const dataFiscVal = rows[36]?.[1]; // L37
        const obsFisc = cel(39, 1);
        if (dataFiscVal || cel(37, 4) || obsFisc) {
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
    tipo === 'pa' ? promptPA :
    tipo === 'pb' ? promptPB :
    tipo === 'ptq' || tipo === 'pq' ? promptPTQ :
    tipo === 'nc' ? promptNC : ''
  );

  const results = [];
  for (const f of files) {
    try {
      const { fileBase64, fileName, contentType } = f;
      const buffer = Buffer.from(fileBase64, 'base64');
      const prompt = getPrompt();
      const isPDF = (contentType || '').includes('pdf') || (fileName || '').toLowerCase().endsWith('.pdf');
      const isDocx = (contentType || '').includes('word') || (fileName || '').toLowerCase().match(/\.docx?$/);
      const isXlsx = (fileName || '').toLowerCase().match(/\.xlsx?$/);
      let msgContent;
      if (isPDF) {
        msgContent = [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } },
          { type: 'text', text: prompt }
        ];
      } else if (isDocx) {
        // Para RV: extrair texto E imagens
        const images = [];
        // Extrair imagens do DOCX com títulos — ler estrutura de tabelas via ZIP/XML
        try {
          const JSZip = (await import('jszip')).default;
          const zip = await JSZip.loadAsync(buffer);

          // Carregar relações de imagens (word/_rels/document.xml.rels)
          const relsXml = await zip.file('word/_rels/document.xml.rels').async('text');
          const relMatches = [...relsXml.matchAll(/Id="(rId\d+)"[^>]+Target="([^"]+)"/g)];
          const relMap = {}; // rId → path
          for (const m of relMatches) {
            if (m[2].includes('media/')) relMap[m[1]] = 'word/' + m[2].replace('../', '');
          }

          // Ler document.xml para extrair tabelas com título+imagem
          const docXml = await zip.file('word/document.xml').async('text');

          // Extrair células de tabela: <w:tc>...</w:tc>
          const cells = [...docXml.matchAll(/<w:tc[ >]([\s\S]*?)<\/w:tc>/g)].map(m => {
            const xml = m[1];
            const txt = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const rids = [...xml.matchAll(/r:embed="(rId\d+)"/g)].map(x => x[1]);
            return { txt, rids };
          });

          // Associar título (célula anterior sem imagem) a célula com imagem
          const used = new Set();
          for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            if (cell.rids.length === 0) continue;
            // Procurar título: célula anterior sem imagem com texto real (até 10 posições atrás)
            let titulo = '';
            for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
              const c = cells[j];
              if (c.rids.length === 0 && c.txt.length > 3 && !/^[-–—\s]+$/.test(c.txt)) {
                titulo = c.txt.slice(0, 120);
                break;
              }
            }
            for (const rId of cell.rids) {
              if (!relMap[rId] || used.has(rId)) continue;
              used.add(rId);
              const imgFile = zip.file(relMap[rId]);
              if (!imgFile) continue;
              const base64 = await imgFile.async('base64');
              const ext = relMap[rId].split('.').pop().toLowerCase();
              const ctMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };
              images.push({ base64, contentType: ctMap[ext] || 'image/jpeg', legenda: titulo });
            }
          }

          // Fallback: imagens sem título (logótipos, etc.) — ignorar se < 10kb
          for (const [path, file] of Object.entries(zip.files)) {
            if (!path.startsWith('word/media/') || file.dir) continue;
            const rId = Object.entries(relMap).find(([k,v]) => v === path)?.[0];
            if (rId && !used.has(rId)) {
              const base64 = await file.async('base64');
              if (base64.length > 13000) { // >~10kb — provavelmente foto real
                const ext = path.split('.').pop().toLowerCase();
                const ctMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };
                images.push({ base64, contentType: ctMap[ext] || 'image/jpeg', legenda: '' });
              }
            }
          }

        } catch(zipErr) {
          console.error('ZIP extraction error:', zipErr.message);
        }

        const result = await mammoth.extractRawText({ buffer });
        const text = result.value.replace(/\s+/g, ' ').trim();
        msgContent = [{ type: 'text', text: prompt + '\n\nConteúdo:\n\n' + text }];
        req._rvImages = images;
        console.log(`RV images extracted: ${images.length}`, images.map(i => i.legenda || '(sem título)'));
      } else if (isXlsx) {
        // Converter Excel para texto usando SheetJS
        const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
        let textoExcel = '';
        for (const sheetName of wb.SheetNames) {
          const ws = wb.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          textoExcel += `\n[Folha: ${sheetName}]\n`;
          for (const row of rows) {
            const linha = row.map(c => {
              if (c instanceof Date) return `${String(c.getDate()).padStart(2,'0')}/${String(c.getMonth()+1).padStart(2,'0')}/${c.getFullYear()}`;
              return String(c).trim();
            }).filter(c => c !== '').join(' | ');
            if (linha) textoExcel += linha + '\n';
          }
        }
        msgContent = [{ type: 'text', text: prompt + '\n\nConteúdo do Excel:\n\n' + textoExcel }];
      } else {
        msgContent = [{ type: 'text', text: prompt + '\n\nConteúdo:\n\n' + buffer.toString('utf-8') }];
      }
      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: msgContent }] }),
      });
      const claudeData = await claudeResp.json();
      if (claudeData.error) throw new Error(claudeData.error.message);
      const text = claudeData.content?.map(c => c.text || '').join('').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Sem JSON: ' + text.substring(0, 150));
      const pedidoData = JSON.parse(jsonMatch[0]);
      console.log('PA pedidoData:', JSON.stringify(pedidoData).substring(0, 500));
      // Extrair ref e flag "R" do nome do ficheiro
      // Formatos: "039.0 PA - Nome.xlsx" ou "R 039.0 PA - Nome.xlsx"
      const temRespostaNoNome = /^R\s/i.test(fileName || '');
      const refMatch = (fileName || '').match(/(\d+\.?\d+)\s+(?:PE|PA|PQ|PTQ|NC|PB)/i);
      const ref = refMatch ? refMatch[1] : ((fileName || '').match(/^(\d+\.?\d*)/) || [])[1] || '';
      const nomeMatch = (fileName || '').match(/\d+\.?\d+\s+(?:PE|PA|PQ|PTQ|NC|PB)\s*[-–]?\s*(.+?)(?:\.\w+)?$/i);
      const nomeDoFicheiro = nomeMatch ? nomeMatch[1].trim() : '';

      // Construir estrutura completa compatível com o SIGO
      let dataCompleta;
      if (tipo === 'pe') {
        const nome = pedidoData.assunto || nomeDoFicheiro || '';
        dataCompleta = {
          ref,
          nome,
          esp: pedidoData.especialidade || '',
          dataSubmissao: pedidoData.enviado || pedidoData.data || '',
          dataEnvioFisc: '',
          dataProjetista: (pedidoData.respostas||[]).find(r=>r.tipo==='Projetista')?.data || '',
          dataRespFisc: (pedidoData.respostas||[]).find(r=>r.tipo==='Fiscalização')?.data || '',
          dataFecho: '',
          obs: pedidoData.obs || '',
          temResposta: (pedidoData.respostas||[]).length > 0,
          pedido: pedidoData,
          resposta: null,
          anexos: [],
          ficheiros: {}
        };
      } else if (tipo === 'pa') {
        const nome = pedidoData.motivo || nomeDoFicheiro || '';
        const respostas = pedidoData.respostas || [];
        const respProj = respostas.find(r => r.tipo === 'Projetista') || {};
        const respFisc = respostas.find(r => r.tipo === 'Fiscalização') || {};
        dataCompleta = {
          ref,
          nome,
          esp: pedidoData.especialidade || '',
          dataSubmissao: pedidoData.data || '',
          dataEnvioFisc: '',
          dataProjetista: respProj.data || '',
          dataRespFisc: respFisc.data || '',
          dataFecho: '',
          obs: pedidoData.observacoes || '',
          temResposta: temRespostaNoNome || respostas.length > 0,
          pedido: pedidoData,
          resposta: null,
          anexos: [],
          ficheiros: {}
        };
      } else if (tipo === 'ptq' || tipo === 'pq') {
        dataCompleta = {
          ref: ref || pedidoData.id || '',
          nome: pedidoData.semanas ? `Semanas ${pedidoData.semanas}` : nomeDoFicheiro || '',
          dataInicio: pedidoData.dataInicio || '',
          dataFim: pedidoData.dataFim || '',
          data: pedidoData.dataInicio || '',
          semanas: pedidoData.semanas || '',
          trabalhosPrevistos: pedidoData.trabalhosPrevistos || [],
          maoObra: pedidoData.maoObra || [],
          equipamentos: pedidoData.equipamentos || [],
          trabalhosExecutados: pedidoData.trabalhosExecutados || [],
          observacoes: pedidoData.observacoes || '',
          pedido: pedidoData,
          ficheiros: {}
        };
      } else if (tipo === 'nc') {
        dataCompleta = {
          ref: ref || pedidoData.id || '',
          nome: pedidoData.descricao || nomeDoFicheiro || '',
          data: pedidoData.data || '',
          causa: pedidoData.causa || '',
          acao: pedidoData.acao || '',
          responsavel: pedidoData.responsavel || '',
          prazo: pedidoData.prazo || '',
          estado: pedidoData.estado || 'Aberto',
          observacoes: pedidoData.observacoes || '',
          pedido: pedidoData,
          ficheiros: {}
        };
      } else if (tipo === 'pb') {
        // Data do pedido vem do nome do ficheiro ex: "012.0 PB - 2026-04-21"
        const dataFicheiroMatch = (fileName || '').match(/(\d{4}[-./]\d{2}[-./]\d{2}|\d{2}[-./]\d{2}[-./]\d{4})/);
        let dataPedido = '';
        if (dataFicheiroMatch) {
          const raw = dataFicheiroMatch[1];
          if (/^\d{4}/.test(raw)) {
            const [y,m,d] = raw.split(/[-./]/);
            dataPedido = `${d}/${m}/${y}`;
          } else {
            dataPedido = raw.replace(/[-./]/g, '/');
          }
        }
        dataCompleta = {
          ref: ref || pedidoData.id || '',
          nome: pedidoData.elemento || nomeDoFicheiro || '',
          dataSubmissao: dataPedido,
          pedido: { ...pedidoData, data: dataPedido },
          ficheiros: {}
        };
      } else {
        // AR, RV e outros — manter estrutura original
        dataCompleta = pedidoData;
      }

      results.push({ success: true, data: dataCompleta, fileName, images: tipo === 'rv' ? (req._rvImages || []) : [] });
    } catch (err) {
      results.push({ success: false, error: err.message, fileName: f.fileName });
    }
  }
  return res.status(200).json({ results });
}
