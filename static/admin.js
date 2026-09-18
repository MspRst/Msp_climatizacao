// Callback do modal de confirmação de exclusão (compartilhado entre confirmDelete e confirmDeleteOcorrencia)
let _deleteFn = null;



// ── RELATÓRIO ─────────────────────────────────────────────

function toggleAllSensors(val) {
  document.querySelectorAll('.rep-check').forEach(cb => {
    if (cb.checked !== val) { cb.checked = val; updateThreshRow(cb); }
  });
  updateReportProgressIndicator();
}

function updateThreshRow(checkbox) {
  const sensor = checkbox.value;
  const tbody = document.getElementById('repThreshTbody');
  const table = document.getElementById('repThreshTable');
  const hint  = document.getElementById('repThreshHint');
  if (!tbody) return;

  if (checkbox.checked) {
    const exists = [...tbody.querySelectorAll('tr')].some(tr => tr.dataset.sensor === sensor);
    if (!exists) {
      const d = guessThresholds(sensor);
      const tr = document.createElement('tr');
      tr.dataset.sensor = sensor;
      tr.innerHTML = `
        <td><strong style="font-size:.8rem">${sensor}</strong></td>
        <td><input type="number" class="rep-ur-min" value="${d.urMin}" min="0" max="100"></td>
        <td><input type="number" class="rep-ur-max" value="${d.urMax}" min="0" max="100"></td>
        <td><input type="number" class="rep-t-min"  value="${d.tMin}"  step="0.5"></td>
        <td><input type="number" class="rep-t-max"  value="${d.tMax}"  step="0.5"></td>
        <td><input type="text"   class="rep-equip"  placeholder="CA-1, CA-2R..."></td>
        <td><textarea class="rep-notas" rows="2" placeholder="Ex: pico em 15/03 devido à abertura de porta durante montagem..." style="width:240px;padding:4px 6px;border:1px solid var(--border);font-family:var(--sans);font-size:.78rem;resize:vertical;border-radius:2px"></textarea></td>`;
      tbody.appendChild(tr);
    }
  } else {
    [...tbody.querySelectorAll('tr')].find(tr => tr.dataset.sensor === sensor)?.remove();
  }

  const hasRows = tbody.querySelectorAll('tr').length > 0;
  table.style.display = hasRows ? 'table' : 'none';
  hint.style.display  = hasRows ? 'none'  : 'block';
}

// Padrões por norma — ibram/masp/bizot vêm de getPadraoConformidade() (api.js, que lê
// window._padroes/padroes_conformidade). Em, o parse deste script ainda não tem
// window._padroes preenchido, então isso pega o fallback local do api.js (mesmos
// números do banco); aplicarPadroesConformidade() reaplica com os valores reais assim
// que o boot responde (chamada por populateFilters() em ui.js).
let PADROES_NORMA = {
  ibram:   { ...getPadraoConformidade('ibram') },
  masp:    { ...getPadraoConformidade('masp') },
  bizot:   { ...getPadraoConformidade('bizot') },
  hibrido: { label: 'Híbrido (MASP + Bizot)', desc: 'MASP ou Bizot por sensor — configurável em Gerenciar → Sensores' },
  custom:  { label: 'Personalizado', desc: 'Faixas por ponto' },
};

function aplicarPadroesConformidade() {
  ['ibram', 'masp', 'bizot'].forEach(k => Object.assign(PADROES_NORMA[k], getPadraoConformidade(k)));
}

function selectReportPadrao(card) {
  document.querySelectorAll('.rep-padrao-card').forEach(c => c.classList.remove('rep-padrao-card--active'));
  card.classList.add('rep-padrao-card--active');
  card.querySelector('input[type=radio]').checked = true;
  const padrao = card.dataset.padrao;
  const customStep = document.getElementById('repCustomStep');
  if (customStep) customStep.style.display = padrao === 'custom' ? 'flex' : 'none';
  if (padrao !== 'custom') applyPadraoToTable();
  updateReportProgressIndicator();
}

// ═══════════════════════════════════════════════════
// CARREGAMENTO E EXIBIÇÃO DE DESVIOS (PASSO 3)
// ═══════════════════════════════════════════════════

// Calcula magnitude de um desvio em pontos percentuais
function calcularMagnitudeDesvio(desvio) {
  let magnitude = 0;
  if (desvio.temp_acima) magnitude += (desvio.temperatura - desvio.temp_max) * 3;
  else if (desvio.temp_abaixo) magnitude += (desvio.temp_min - desvio.temperatura) * 3;
  if (desvio.umid_acima) magnitude += (desvio.umidade - desvio.umid_max) * 2;
  else if (desvio.umid_abaixo) magnitude += (desvio.umid_min - desvio.umidade) * 2;
  return Math.round(magnitude * 100) / 100;
}

function classificarSeveridade(magnitude) {
  if (magnitude >= 15) return 'critico';
  if (magnitude >= 8) return 'atencao';
  return 'leve';
}

async function vincularDesviosComOcorrencias(desvios, dataIni, dataFim) {
  try {
    const ocorrencias = await API.get('ocorrencias', { data_ini: dataIni, data_fim: dataFim });
    // Prédio de cada sensor — sem isso, uma ocorrência com afeta_predio_todo=1 de um
    // prédio vazaria como justificativa de desvio para sensores do outro prédio.
    let predioPorSensor = {};
    try {
      const meta = await API.get('meta');
      predioPorSensor = Object.fromEntries((meta.pontos || []).map(p => [p.nome, p.predio]));
    } catch (_) {}
    desvios.forEach(d => {
      d.ocorrencia_vinculada = null;
      d.justificativa_auto = null;
      const sensorPredio = predioPorSensor[d.sensor] || 'Lina';
      for (const o of ocorrencias) {
        if (o.predio !== sensorPredio && o.predio !== 'Ambos') continue;
        const oIni = (o.data_inicio || '').substring(0, 16);
        const oFim = (o.data_fim || '').substring(0, 16);
        const dHora = (d.data_hora || '').substring(0, 16);
        if (dHora >= oIni && dHora <= oFim) {
          const afetaSensor = o.afeta_predio_todo || (o.sensores && o.sensores.some(s => s.nome === d.sensor));
          if (afetaSensor) {
            d.ocorrencia_vinculada = o;
            const labels = { manutencao:'Manutenção', falha_equipamento:'Falha de equipamento', obra:'Obra/Intervenção', sensor_deslocado:'Sensor deslocado', pico_automatico:'Pico detectado' };
            d.justificativa_auto = labels[o.tipo] || o.tipo;
            break;
          }
        }
      }
    });
  } catch (e) { console.warn('Erro ao vincular ocorrências:', e); }
}

function toggleAllDesviosTable() {
  const topCard = document.getElementById('desviosTopCard');
  const fullWrap = document.getElementById('desviosTableWrap');
  if (topCard.style.display !== 'none') {
    topCard.style.display = 'none';
    fullWrap.style.display = 'block';
  } else {
    topCard.style.display = 'block';
    fullWrap.style.display = 'none';
  }
}

async function loadDesviosPreview() {
  const sensors = [...document.querySelectorAll('.rep-check:checked')].map(cb => cb.value);
  const dataIni = document.getElementById('fDataIni').value;
  const dataFim = document.getElementById('fDataFim').value;
  const padraoStr = getActivePadraoRel();
  const padrao_map = { bizot: 3, masp: 2, ibram: 1, custom: 2 };
  const padrao = padrao_map[padraoStr] || 2;
  
  if (!sensors.length) { alert('Selecione ao menos um ponto de medição.'); return; }
  if (!dataIni || !dataFim) { alert('Defina o ${tx.period} nos filtros acima.'); return; }
  
  const loading = document.getElementById('desviosLoading');
  const empty = document.getElementById('desviosEmpty');
  const topCard = document.getElementById('desviosTopCard');
  const tableWrap = document.getElementById('desviosTableWrap');
  
  loading.style.display = 'block';
  empty.style.display = 'none';
  topCard.style.display = 'none';
  tableWrap.style.display = 'none';
  
  try {
    const params = new URLSearchParams({
      sensores: sensors.join(','),
      data_ini: dataIni,
      data_fim: dataFim,
      padrao: padrao,
    });
    
    const response = await fetch(`/api/desvios-preview?${params}`);
    const desvios = await response.json();
    
    if (!desvios || desvios.length === 0) {
      empty.style.display = 'block';
      loading.style.display = 'none';
      return;
    }
    
    // Vincular com ocorrências
    await vincularDesviosComOcorrencias(desvios, dataIni, dataFim);
    
    // Calcular magnitude e severidade
    desvios.forEach(d => {
      d.magnitude = calcularMagnitudeDesvio(d);
      d.severidade = classificarSeveridade(d.magnitude);
    });
    desvios.sort((a, b) => b.magnitude - a.magnitude);
    
    // TOP 10 CARD
    const top10 = desvios.slice(0, 10);
    const stats = {
      total: desvios.length,
      criticos: desvios.filter(d => d.severidade === 'critico').length,
      atencao: desvios.filter(d => d.severidade === 'atencao').length,
      leves: desvios.filter(d => d.severidade === 'leve').length,
    };
    
    document.getElementById('desvios-total').textContent = stats.total;
    document.getElementById('desvios-criticos').textContent = stats.criticos;
    document.getElementById('desvios-atencao').textContent = stats.atencao;
    document.getElementById('desvios-leves').textContent = stats.leves;
    
    const topTbody = document.getElementById('topDesviosTbody');
    topTbody.innerHTML = '';
    top10.forEach((desvio, idx) => {
      const tr = document.createElement('tr');
      const tipos = desvio.desvio_tipos.map(t => t === 'temp_acima' ? 'T ↑' : t === 'temp_abaixo' ? 'T ↓' : t === 'umid_acima' ? 'UR ↑' : 'UR ↓').join(' / ');
      const [datePart, timePart] = (desvio.data_hora || '').split('T');
      const timeFormatted = timePart ? timePart.substring(0, 5) : '';
      const st = desvio.ocorrencia_vinculada ? '🔗 Justificado' : '⚠️ Pendente';
      tr.innerHTML = `<td class="desvio-rank">${idx+1}</td><td class="desvio-sensor">${escapeHtml(desvio.sensor)}</td><td><code style="font-size:.75rem">${datePart} ${timeFormatted}</code></td><td><strong>${tipos}</strong></td><td class="desvio-magnitude">${desvio.magnitude >= 15 ? '🔴' : desvio.magnitude >= 8 ? '🟡' : '🟢'} ${desvio.magnitude.toFixed(1)}</td><td class="desvio-status">${st}</td>`;
      topTbody.appendChild(tr);
    });
    topCard.style.display = 'block';
    
    // TABELA COMPLETA
    const tRows = desvios.map((d, idx) => {
      const tipos = d.desvio_tipos.map(t => {
        let l = '', c = '';
        if (t === 'temp_acima') { l = 'T ↑'; c = 'temp-acima'; }
        else if (t === 'temp_abaixo') { l = 'T ↓'; c = 'temp-abaixo'; }
        else if (t === 'umid_acima') { l = 'UR ↑'; c = 'umid-acima'; }
        else if (t === 'umid_abaixo') { l = 'UR ↓'; c = 'umid-abaixo'; }
        return `<span class="desvio-tipo ${c}">${l}</span>`;
      }).join('');
      const [dp, tp] = (d.data_hora || '').split('T');
      const tf = tp ? tp.substring(0, 5) : '';
      let just = d.ocorrencia_vinculada ? `<div style="margin-bottom:6px;padding:6px 8px;background:rgba(22,163,74,.08);border-left:2px solid var(--green);border-radius:2px;font-size:.75rem;color:var(--green);font-weight:600">🔗 ${escapeHtml(d.justificativa_auto)}</div><textarea placeholder="Complementar..." class="desvio-justificativa">${d.justificativa || ''}</textarea>` : `<textarea placeholder="Adicione justificativa..." class="desvio-justificativa">${d.justificativa || ''}</textarea>`;
      const bgc = d.severidade === 'critico' ? 'background:rgba(227,6,19,.03)' : d.severidade === 'atencao' ? 'background:rgba(217,119,6,.03)' : '';
      return `<tr style="${bgc}"><td><strong>${escapeHtml(d.sensor)}</strong></td><td><code>${dp}</code><br/><code style="font-size:.7rem;color:var(--gray-300)">${tf}</code></td><td title="Faixa: ${d.temp_min}–${d.temp_max}°C"><strong>${d.temperatura.toFixed(1)}</strong></td><td title="Faixa: ${d.umid_min}–${d.umid_max}%"><strong>${d.umidade.toFixed(1)}</strong></td><td>${tipos}</td><td>${just}</td></tr>`;
    }).join('');
    tableWrap.innerHTML = `<table class="desvios-table"><thead><tr><th>Sensor</th><th>Data Hora</th><th>T (°C)</th><th>UR (%)</th><th>Tipo de Desvio</th><th>Justificativa / Observação</th></tr></thead><tbody>${tRows}</tbody></table>`;
    tableWrap.style.display = 'none';
    
    loading.style.display = 'none';
    showToast(`✓ ${desvios.length} desvio(s) • ${stats.criticos} críticos, ${stats.atencao} atenção`, 'ok', 4000);
  } catch (e) {
    console.error('Erro ao carregar desvios:', e);
    alert('Erro ao carregar desvios: ' + e.message);
    loading.style.display = 'none';
  }
}

function getActivePadraoRel() {
  const checked = document.querySelector('input[name="repPadrao"]:checked');
  return checked ? checked.value : 'bizot';
}

function getActivePadraoRelAsNumber() {
  const padrao_map = { bizot: 3, masp: 2, ibram: 1, custom: 2 };
  return padrao_map[getActivePadraoRel()] || 2;
}


// Aplica o padrão ativo a todas as linhas já existentes na tabela
function applyPadraoToTable() {
  const padrao = getActivePadraoRel();
  if (padrao === 'custom') return;
  const norma = PADROES_NORMA[padrao];
  if (!norma) return;
  document.querySelectorAll('#repThreshTbody tr').forEach(tr => {
    tr.querySelector('.rep-ur-min').value = norma.urMin;
    tr.querySelector('.rep-ur-max').value = norma.urMax;
    tr.querySelector('.rep-t-min').value  = norma.tMin;
    tr.querySelector('.rep-t-max').value  = norma.tMax;
  });
}

function guessThresholds(sensor) {
  const padrao = getActivePadraoRel();
  if (padrao !== 'custom' && PADROES_NORMA[padrao]) return { ...PADROES_NORMA[padrao] };
  return { urMin: 40, urMax: 60, tMin: 18, tMax: 22 };
}

function getReportThresholds(sensor) {
  const tr = [...document.querySelectorAll('#repThreshTbody tr')].find(r => r.dataset.sensor === sensor);
  if (tr) return {
    urMin: parseFloat(tr.querySelector('.rep-ur-min').value) || 40,
    urMax: parseFloat(tr.querySelector('.rep-ur-max').value) || 60,
    tMin:  parseFloat(tr.querySelector('.rep-t-min').value)  || 19,
    tMax:  parseFloat(tr.querySelector('.rep-t-max').value)  || 23,
    equipment: tr.querySelector('.rep-equip').value.trim(),
    notas: tr.querySelector('.rep-notas').value.trim(),
  };
  return { urMin:40, urMax:60, tMin:19, tMax:23, equipment:'', notas:'' };
}

// ── Personalização de Conteúdo do Relatório ─────────────────

function selectAllReportContent(val) {
  document.querySelectorAll('.rep-content-check').forEach(cb => cb.checked = val);
}

// Adiciona uma linha de evento manual
window.addCustomMarkerRow = function() {
  const wrap = document.getElementById('repCustomMarkersWrap');
  const div = document.createElement('div');
  div.className = 'custom-marker-row';
  div.style.display = 'grid'; 
  div.style.gridTemplateColumns = 'auto 1fr auto'; 
  div.style.gap = '8px';
  div.style.alignItems = 'center';
  div.innerHTML = `
    <input type="datetime-local" class="cm-date" style="padding:6px;border:1px solid var(--border);border-radius:3px;font-family:var(--sans);font-size:.8rem;width:100%">
    <input type="text" class="cm-label" placeholder="Descrição do evento... (Ex: Abertura da porta)" style="padding:6px;border:1px solid var(--border);border-radius:3px;font-family:var(--sans);font-size:.8rem;width:100%">
    <button type="button" onclick="this.parentElement.remove()" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:1rem;padding:0 6px">✕</button>
  `;
  wrap.appendChild(div);
};


function getReportContentSettings() {
  const customMarkers = [...document.querySelectorAll('.custom-marker-row')].map(row => ({
    date: row.querySelector('.cm-date').value,
    label: row.querySelector('.cm-label').value
  })).filter(m => m.date && m.label);

  return {
    lang: document.querySelector('#repLang .seg-btn.active')?.dataset.lang || 'pt',
    visibilidade: document.querySelector('#repVisibilidade .seg-btn.active')?.dataset.visibilidade || 'interno',
    includeCover: document.getElementById('repIncludeCover')?.checked ?? true,
    includeInstructions: document.getElementById('repIncludeInstructions')?.checked ?? true,
    includeIndex: document.getElementById('repIncludeIndex')?.checked ?? true,
    includeSummary: document.getElementById('repIncludeSummary')?.checked ?? true,
    includeSensors: document.getElementById('repIncludeSensors')?.checked ?? true,
    includeCharts: document.getElementById('repIncludeCharts')?.checked ?? true,
    includeTerreo: document.getElementById('repIncludeTerreo')?.checked ?? true,
    splitChartsByMonth: document.getElementById('repMonthlyCharts')?.checked ?? false,
    includeOccurrences: document.getElementById('repIncludeOccurrences')?.checked ?? true,
    includeMonthly: document.getElementById('repIncludeMonthly')?.checked ?? true,
    includeGlobalTrend: document.getElementById('repIncludeGlobalTrend')?.checked ?? true,
    includeDeviations: document.getElementById('repIncludeDeviations')?.checked ?? true,
    chartYMinT: document.getElementById('repChartYMinT')?.value || null,
    chartYMaxT: document.getElementById('repChartYMaxT')?.value || null,
    chartYMinR: document.getElementById('repChartYMinR')?.value || null,
    chartYMaxR: document.getElementById('repChartYMaxR')?.value || null,
    customMarkers: customMarkers
  };
}
// ── Indicador de Progresso e Validação para Geração de Relatório ──────────

function updateReportProgressIndicator() {
  const steps = document.querySelectorAll('.rep-step');
  
  // Passo 1: Padrão selecionado
  const padrao = getActivePadraoRel();
  const step1 = steps[0];
  if (padrao) {
    step1.classList.add('rep-step--complete');
    step1.querySelector('.rep-step-num').style.background = '#16a34a';
    step1.querySelector('.rep-step-num').textContent = '✓';
  } else {
    step1.classList.remove('rep-step--complete');
    step1.querySelector('.rep-step-num').style.background = '';
    step1.querySelector('.rep-step-num').textContent = '1';
  }
  
  // Passo 2: Sensores selecionados
  const sensores = [...document.querySelectorAll('.rep-check:checked')].length;
  const step2 = steps[1];
  if (sensores > 0) {
    step2.classList.add('rep-step--complete');
    step2.querySelector('.rep-step-num').style.background = '#16a34a';
    step2.querySelector('.rep-step-num').innerHTML = `✓<span style="font-size:0.5em">+${sensores}</span>`;
  } else {
    step2.classList.remove('rep-step--complete');
    step2.querySelector('.rep-step-num').style.background = '';
    step2.querySelector('.rep-step-num').textContent = '2';
  }
  
  // Passo 3: Desvios carregados (verifica se há dados no card)
  const desviosCard = document.getElementById('desviosTopCard');
  const step3Elem = [...steps].find(s => s.textContent.includes('Mapear'));
  if (step3Elem && desviosCard && desviosCard.style.display !== 'none') {
    step3Elem.classList.add('rep-step--complete');
    step3Elem.querySelector('.rep-step-num').style.background = '#16a34a';
    step3Elem.querySelector('.rep-step-num').textContent = '✓';
  } else if (step3Elem) {
    step3Elem.classList.remove('rep-step--complete');
    step3Elem.querySelector('.rep-step-num').style.background = '';
    step3Elem.querySelector('.rep-step-num').textContent = '3';
  }
}

function validateReportCompletion() {
  const errors = [];
  
  // Validar Passo 1
  const padrao = getActivePadraoRel();
  if (!padrao) {
    errors.push('❌ Passo 1: Selecione um padrão normativo');
  }
  
  // Validar Passo 2
  const sensores = [...document.querySelectorAll('.rep-check:checked')].map(cb => cb.value);
  if (!sensores.length) {
    errors.push('❌ Passo 2: Selecione ao menos um ponto de medição');
  }
  
  // Validar ${tx.period}
  const dataIni = document.getElementById('fDataIni').value;
  const dataFim = document.getElementById('fDataFim').value;
  if (!dataIni || !dataFim) {
    errors.push('❌ ${tx.period}: Defina Data Inicial e Data Final nos filtros acima');
  }
  
  if (errors.length > 0) {
    showToast(errors.join('\n'), 'err', 8000);
    return false;
  }
  
  return true;
}

async function generateReport() {
  if (!validateReportCompletion()) return;
  
  const sensors = [...document.querySelectorAll('.rep-check:checked')].map(cb => cb.value);

  const dataIni = document.getElementById('fDataIni').value;
  const dataFim = document.getElementById('fDataFim').value;

  const padrao = getActivePadraoRel();
  const btn = document.getElementById('btnGerar');
  btn.textContent = '⏳ CARREGANDO DADOS...';
  btn.disabled = true;

  try {
    const allData = [];
    let anyTruncated = false;
    
    // A SOLUÇÃO: Um código que muda a cada milissegundo para forçar o navegador a não usar dados velhos!
    const cacheBuster = Date.now(); 

    let ocorrencias = [];
    try { ocorrencias = await API.get('ocorrencias', { data_ini: dataIni, data_fim: dataFim }); } catch (_) {}

    // Prédio de cada sensor selecionado — necessário porque uma ocorrência com
    // afeta_predio_todo=1 só deve valer para sensores do MESMO prédio (ou de uma
    // ocorrência registrada com predio='Ambos'). Sem isso, uma ocorrência do Lina
    // marcada "afeta prédio todo" vazava para relatórios do Pietro, e vice-versa.
    let predioPorSensor = {};
    let padraoHibridoPorSensor = {};
    try {
      const meta = await API.get('meta');
      predioPorSensor = Object.fromEntries((meta.pontos || []).map(p => [p.nome, p.predio]));
      // Fonte única da regra do padrão Híbrido (sensores.padrao_hibrido) — evita
      // reimplementar "quais sensores usam MASP" por regex de nome aqui.
      padraoHibridoPorSensor = Object.fromEntries((meta.pontos || []).map(p => [p.nome, p.padrao_hibrido || 'bizot']));
    } catch (_) {}

    let terreoDados = [];
    try {
      const res = await fetch(`/api/serie?ponto=Térreo&data_ini=${dataIni}&data_fim=${dataFim}&_=${cacheBuster}`);
      if (res.ok) terreoDados = await res.json();
    } catch (_) {}

    for (const sensor of sensors) {
      const [serieRes, pontosRes, mensalRes] = await Promise.all([
        // O cacheBuster é injetado aqui nas chamadas dos gráficos
        fetch(`/api/serie?ponto=${encodeURIComponent(sensor)}&data_ini=${dataIni}&data_fim=${dataFim}&_=${cacheBuster}`),
        API.get('pontos',  { ponto: sensor, data_ini: dataIni, data_fim: dataFim }),
        API.get('mensal',  { ponto: sensor, data_ini: dataIni, data_fim: dataFim }),
      ]);
      if (serieRes.headers.get('X-Truncated') === 'true') anyTruncated = true;
      const serie = await serieRes.json();
      
      const sensorPredio = predioPorSensor[sensor] || 'Lina';
      const sensorOcorrs = ocorrencias.filter(o =>
        (o.predio === sensorPredio || o.predio === 'Ambos') &&
        (o.afeta_predio_todo || o.sensores?.some(s => s.nome === sensor))
      );
      allData.push({ sensor, serie, stats: pontosRes[0] || {}, thresh: getReportThresholds(sensor), ocorrencias: sensorOcorrs, mensalAPI: mensalRes, padraoHibrido: padraoHibridoPorSensor[sensor] || 'bizot' });
    }

    if (anyTruncated) showToast('⚠ ${tx.period} muito longo: gráficos mostram apenas os primeiros 50.000 pontos.', 'warn', 10000);
    const contentSettings = getReportContentSettings();
    openReportWindow(allData, dataIni, dataFim, terreoDados, padrao, contentSettings);
    showToast('✓ Relatório gerado com sucesso! Verifique a nova aba.', 'ok', 6000);
  } catch (e) {
    showToast('✗ Erro ao gerar relatório: ' + e.message, 'err', 8000);
  } finally {
    btn.textContent = '⇒ GERAR RELATÓRIO';
    btn.disabled = false;
  }
}

function openReportWindow(allData, dateIni, dateFim, terreoDados, padrao, contentSettings = {}) {
  const lang = contentSettings.lang || 'pt';
  const tx = I18N[lang]; // <--- Esta linha é o segredo!
  const dateLocale = lang === 'pt' ? 'pt-BR' : 'en-US';
  const period = `${dateIni} — ${dateFim}`;
  const norma    = PADROES_NORMA[padrao] || PADROES_NORMA.bizot;
  const MAX_PTS  = 800;
  const isCustom = padrao === 'custom';

  // Padrões padrão — incluir tudo se não especificado
  const content = {
    includeCover: contentSettings.includeCover !== false,
    includeInstructions: contentSettings.includeInstructions !== false,
    includeExecutive: contentSettings.includeExecutive !== false,
    includeIndex: contentSettings.includeIndex !== false,
    includeSummary: contentSettings.includeSummary !== false,
    includeSensors: contentSettings.includeSensors !== false,
    includeCharts: contentSettings.includeCharts !== false,
    includeTerreo: contentSettings.includeTerreo !== false,
    includeOccurrences: contentSettings.includeOccurrences !== false,
    includeMonthly: contentSettings.includeMonthly !== false,
    includeGlobalTrend: contentSettings.includeGlobalTrend !== false,
    includeDeviations: contentSettings.includeDeviations !== false,
    // Gráficos de sensor mês a mês em vez de um único gráfico comprimindo o período inteiro —
    // desligado por padrão (contentSettings.splitChartsByMonth só vem true se o checkbox marcar).
    splitChartsByMonth: contentSettings.splitChartsByMonth === true,
    // 'externo' oculta a descrição em texto livre das ocorrências (onde entram detalhes
    // operacionais, nomes de fornecedores etc.) — mantém tipo, datas, sensores e responsável.
    externo: contentSettings.visibilidade === 'externo',
  };

  function subsample(arr, max) {
    if (!arr?.length) return [];
    const step = Math.max(1, Math.floor(arr.length / max));
    return arr.filter((_, i) => i % step === 0);
  }

  function alignTerreo(sensorSerie, terreoSerie) {
    if (!terreoSerie.length) return [];
    const tMap = {};
    terreoSerie.forEach(r => { const k = (r.data_hora||'').substring(0,13); if (k && !tMap[k]) tMap[k] = r; });
    return sensorSerie.map(r => tMap[(r.data_hora||'').substring(0,13)] || null);
  }

  // Compartilhados entre o gráfico de período único e os gráficos mês a mês (splitChartsByMonth)
  function buildPeriodoExpo(rows) {
    return rows.map(r => {
      if (!r) return 0;
      const val = r.periodo_expositivo;
      if (val === 1 || val === "1" || val === true) return 1;
      return 0;
    });
  }
  function buildPeriodoExpoNomes(rows) {
    return rows.map(r => {
      if (!r || (r.periodo_expositivo !== 1 && r.periodo_expositivo !== "1")) return null;
      return r.periodo_expositivo_nome || null;
    });
  }

  function confPadrao(serie, thresh) {
    const n = serie.length; if (!n) return null;
    /* Usa sempre o thresh efetivo, que já resolveu se é MASP, Bizot ou Híbrido */
    return +(serie.filter(d => d.temperatura>=thresh.tMin && d.temperatura<=thresh.tMax && d.umidade>=thresh.urMin && d.umidade<=thresh.urMax).length/n*100).toFixed(1);
  }

  function confT(serie, thresh)  { const n=serie.length; if(!n) return null; return +(serie.filter(d=>d.temperatura>=thresh.tMin&&d.temperatura<=thresh.tMax).length/n*100).toFixed(1); }
  function confUR(serie, thresh) { const n=serie.length; if(!n) return null; return +(serie.filter(d=>d.umidade>=thresh.urMin&&d.umidade<=thresh.urMax).length/n*100).toFixed(1); }

  function calcMonthly(serie, thresh) {
    const byM = {};
    serie.forEach(r => { const m=(r.data_hora||'').substring(0,7); if(m){if(!byM[m])byM[m]=[];byM[m].push(r);} });
    return Object.entries(byM).sort(([a],[b])=>a.localeCompare(b)).map(([mes,rows])=>({
      mes, n:rows.length, conf:confPadrao(rows,thresh), ct:confT(rows,thresh), cur:confUR(rows,thresh)
    }));
  }

  function fmtMonth(str) {
    if (!str) return lang === 'pt' ? 'Desconhecido' : 'Unknown'; // Escudo: ignora se vier vazio do banco
    const MN_PT=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const MN_EN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const MN = lang === 'pt' ? MN_PT : MN_EN;
    const p=str.split('-'); return p.length>=2?`${MN[parseInt(p[1])-1]} ${p[0]}`:str;
  }

  function cls(v)         { if(v==null)return'nd'; return v>=90?'ok':v>=70?'warn':'bad'; }
  function statusLabel(c) { 
    const labels = {
      pt: {ok:'Excelente',warn:'Atenção',bad:'Crítico',nd:'–'},
      en: {ok:'Excellent',warn:'Attention',bad:'Critical',nd:'–'}
    };
    return labels[lang][c]||'–'; 
  }
  function pct(v)         { return v!=null?`${v}%`:'–'; }

  const PAGE_LABELS = lang === 'pt' ? {
    cover: '01. Capa',
    guide: '02. Guia de Interpretação',
    summary: '03. Sumário Geral',
    comparative: '04. Visão Comparativa e Tabela de Conformidade',
    monitoring_report: 'Relatório de Monitoramento',
    page_num: 'pág.',
    analyses: 'Análises por Ponto de Medição'
  } : {
    cover: '01. Cover',
    guide: '02. Interpretation Guide',
    summary: '03. General Summary',
    comparative: '04. Comparative View and Compliance Table',
    monitoring_report: 'Monitoring Report',
    page_num: 'p.',
    analyses: 'Analyses by Measurement Point'
  };

  const temTerreo = terreoDados.length > 0 && content.includeTerreo;

  const sensorsData = allData.map(({ sensor, serie, stats, thresh, ocorrencias, mensalAPI, padraoHibrido }) => {

    // LÓGICA DO PADRÃO HÍBRIDO — qual sensor usa MASP vs. Bizot vem de sensores.padrao_hibrido
    // (editável em Gerenciar → Sensores), não mais de um regex sobre o nome do sensor.
    let p = isCustom ? thresh : norma;
    if (padrao === 'hibrido') {
      p = padraoHibrido === 'masp' ? PADROES_NORMA.masp : PADROES_NORMA.bizot;
    }
    const effectiveThresh = { ...p, equipment: thresh.equipment, notas: thresh.notas };

    // Recalcula a conformidade 
    let conf, ct, cur;
    if (padrao === 'hibrido' || isCustom || !stats || !Object.keys(stats).length) {
      conf = confPadrao(serie, effectiveThresh);
      ct   = confT(serie, effectiveThresh);
      cur  = confUR(serie, effectiveThresh);
    } else {
      conf = padrao === 'ibram' ? stats.conf_total_ibram : padrao === 'masp' ? stats.conf_total_masp : stats.conf_total_bizot;
      ct   = padrao === 'ibram' ? stats.conf_temp_ibram : padrao === 'masp' ? stats.conf_temp_masp : stats.conf_temp_bizot;
      cur  = padrao === 'ibram' ? stats.conf_ur_ibram : padrao === 'masp' ? stats.conf_ur_masp : stats.conf_ur_bizot;
      
      // Fallback seguro: se o banco de dados não enviou a métrica separada, calcula agora!
      if (ct == null) ct = confT(serie, effectiveThresh);
      if (cur == null) cur = confUR(serie, effectiveThresh);
    }

    // Calcula as tabelas mensais
    let monthly;
    if (mensalAPI?.length && padrao !== 'hibrido' && !isCustom) {
      monthly = mensalAPI.map(r => ({
        mes:  r.mes,
        n:    r.medicoes,
        conf: (padrao === 'ibram' ? r.conf_total_ibram : padrao === 'masp'  ? r.conf_masp : r.conf_bizot) ?? null,
        ct:   (padrao === 'ibram' ? r.conf_temp_ibram : padrao === 'masp'  ? r.conf_temp_masp : r.conf_temp_bizot) ?? null,
        cur:  (padrao === 'ibram' ? r.conf_ur_ibram : padrao === 'masp'  ? r.conf_ur_masp : r.conf_ur_bizot) ?? null,
      }));
    } else {
      monthly = calcMonthly(serie, effectiveThresh);
    }

    const safeId='c_'+sensor.replace(/[^a-zA-Z0-9]/g,'_');
    const serieSub=subsample(serie,MAX_PTS);
    // Usa terreoDados completo (não o subamostrado terreoPts) como fonte de busca —
    // subamostrar os dois lados independentemente fazia quase nenhuma hora bater,
    // deixando a linha do térreo com poucos pontos soltos e ilegível.
    const terreoAlgn = temTerreo ? alignTerreo(serieSub,terreoDados) : [];

    // Gráficos mês a mês: subamostra cada mês separadamente (não o período inteiro já
    // subamostrado em serieSub) — dá resolução própria por mês em vez de espremer o ano
    // inteiro em MAX_PTS pontos.
    let monthlySeries = [];
    if (content.splitChartsByMonth) {
      const monthGroups = {};
      serie.forEach(r => {
        const m = (r.data_hora || '').substring(0, 7);
        if (!m) return;
        (monthGroups[m] || (monthGroups[m] = [])).push(r);
      });
      monthlySeries = Object.keys(monthGroups).sort().map(mes => {
        const mSerieSub = subsample(monthGroups[mes], MAX_PTS);
        return { mes, serieSub: mSerieSub, terreoAlgn: temTerreo ? alignTerreo(mSerieSub, terreoDados) : [] };
      });
    }

    return { sensor, serie, serieSub, terreoAlgn, monthlySeries, stats, thresh:effectiveThresh, conf, ct, cur, monthly, ocorrencias, safeId };
  });

  const normaLabel = isCustom?'Personalizado':norma.label;
  const normaDesc  = isCustom?'Faixas por ponto':norma.desc;
  const confs      = sensorsData.map(d=>d.conf).filter(v=>v!=null);
  const avgConf    = confs.length?(confs.reduce((a,b)=>a+b,0)/confs.length).toFixed(1):null;

  // ═══ CAPA DO RELATÓRIO ═══
  const coverPage = `
  <div class="page page-cover">
    <div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100%;text-align:center;gap:36px">
      <div style="border-bottom:4px solid #E30613;padding-bottom:32px;width:100%">
        <div style="font-family:monospace;font-size:56px;font-weight:900;letter-spacing:10px;color:#0d0d0d;margin-bottom:18px">MASP</div>
        <div style="font-family:monospace;font-size:14px;letter-spacing:2.5px;color:#6b6057;text-transform:uppercase;font-weight:700">${tx.title}</div>
        <div style="font-family:monospace;font-size:12px;letter-spacing:1.5px;color:#a8a29e;margin-top:14px">${tx.subtitle}</div>
      </div>
      
      <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:28px;width:100%">
        <div style="padding:14px 0">
          <div style="font-family:monospace;font-size:11px;letter-spacing:2px;color:#8c8278;text-transform:uppercase;margin-bottom:10px;font-weight:600">${tx.period}</div>
          <div style="font-family:monospace;font-size:18px;font-weight:900;color:#0d0d0d;letter-spacing:-0.5px">${period}</div>
        </div>
        
        <div style="padding:14px 0">
          <div style="font-family:monospace;font-size:11px;letter-spacing:2px;color:#8c8278;text-transform:uppercase;margin-bottom:10px;font-weight:600">${tx.standard}</div>
          <div style="font-family:monospace;font-size:16px;font-weight:900;color:#0d0d0d;margin-bottom:6px">${normaLabel}</div>
          <div style="font-family:monospace;font-size:12px;color:#6b6057;letter-spacing:0.5px">${normaDesc}</div>
        </div>
        
        <div style="padding:14px 0">
          <div style="font-family:monospace;font-size:11px;letter-spacing:2px;color:#8c8278;text-transform:uppercase;margin-bottom:10px;font-weight:600">${tx.points}</div>
          <div style="font-family:monospace;font-size:18px;font-weight:900;color:#0d0d0d">${sensorsData.length} <span style="font-size:12px;font-weight:600;letter-spacing:1px">${lang === 'pt' ? 'SENSORES' : 'SENSORS'}</span></div>
        </div>
        
        <div style="padding:14px 0">
          <div style="font-family:monospace;font-size:11px;letter-spacing:2px;color:#8c8278;text-transform:uppercase;margin-bottom:10px;font-weight:600">${tx.total_med}</div>
          <div style="font-family:monospace;font-size:18px;font-weight:900;color:#0d0d0d">${sensorsData.reduce((sum,d)=>sum+d.serie.length,0).toLocaleString(dateLocale)}</div>
        </div>
      </div>
      
      <div style="border-top:2.5px solid #b5a9a1;padding-top:28px;width:100%;text-align:center">
        <div style="font-family:monospace;font-size:10px;color:#8c8278;letter-spacing:2px;font-weight:600">
          ${tx.generated} ${new Date().toLocaleDateString(dateLocale,{day:'2-digit',month:'long',year:'numeric'}).toUpperCase()}
        </div>
        <div style="font-family:monospace;font-size:9px;color:#a8a29e;letter-spacing:1px;margin-top:6px">
          ${new Date().toLocaleTimeString(dateLocale)}
        </div>
      </div>
    </div>
  </div>`;

  // ═══ PÁGINA DE INSTRUÇÕES ═══
 const instructionsPage = `
  <div class="page">
    <div style="padding-bottom:20px;margin-bottom:28px;border-bottom:3px solid #0d0d0d">
      <div style="font-family:monospace;font-size:8px;letter-spacing:3px;color:#8c8278;text-transform:uppercase;margin-bottom:8px">${tx.how_to_read}</div>
      <div style="font-size:24px;font-weight:700;color:#0d0d0d">${tx.guide_title}</div>
    </div>
    
    <div style="column-count:2;column-gap:28px;column-rule:1px solid #e8e4de">
      <div style="margin-bottom:28px;break-inside:avoid;page-break-inside:avoid">
        <div style="font-family:monospace;font-size:9px;letter-spacing:1px;color:#E30613;text-transform:uppercase;font-weight:700;margin-bottom:8px">${tx.exec_summary}</div>
        <p style="font-size:12px;color:#3d3630;line-height:1.8">
          ${tx.exec_summary_text}
        </p>
        <ul style="margin:10px 0 0 20px;font-size:12px;color:#3d3630;line-height:1.8">
          <li><strong>${tx.avg_compliance}:</strong> ${tx.avg_compliance_detail}</li>
          <li><strong>${tx.sensors_attention}:</strong> 70–80%</li>
          <li><strong>${tx.sensors_critical}:</strong> < 70%</li>
          <li><strong>${tx.comparative_table}:</strong> ${tx.comparative_table_detail}</li>
        </ul>
      </div>

      <div style="margin-bottom:28px;break-inside:avoid;page-break-inside:avoid">
        <div style="font-family:monospace;font-size:9px;letter-spacing:1px;color:#E30613;text-transform:uppercase;font-weight:700;margin-bottom:8px">${tx.individual_pages}</div>
        <p style="font-size:12px;color:#3d3630;line-height:1.8">
          ${tx.individual_pages_text}
        </p>
        <ul style="margin:10px 0 0 20px;font-size:12px;color:#3d3630;line-height:1.8">
          <li><strong>${tx.time_series_charts}:</strong> ${tx.time_series_detail}</li>
          <li><strong>${tx.compliance_zone}:</strong> ${tx.compliance_zone_detail}</li>
          <li><strong>${tx.exhibition_marks}:</strong> ${tx.exhibition_marks_detail}</li>
          <li><strong>${tx.occurrences_label}:</strong> ${tx.occurrences_detail}</li>
        </ul>
      </div>

      <div style="margin-bottom:28px;break-inside:avoid;page-break-inside:avoid">
        <div style="font-family:monospace;font-size:9px;letter-spacing:1px;color:#E30613;text-transform:uppercase;font-weight:700;margin-bottom:8px">${tx.colors_symbols}</div>
        <div style="margin-top:12px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <div style="width:12px;height:12px;border-radius:50%;background:#16a34a"></div>
            <span style="font-size:12px;color:#3d3630"><strong>${tx.excellent} (≥90%):</strong> ${tx.excellent_compliance}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <div style="width:12px;height:12px;border-radius:50%;background:#d97706"></div>
            <span style="font-size:12px;color:#3d3630"><strong>${tx.attention} (70–80%):</strong> ${tx.attention_review}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:12px;height:12px;border-radius:50%;background:#E30613"></div>
            <span style="font-size:12px;color:#3d3630"><strong>${tx.critical} (&lt;70%):</strong> ${tx.critical_action}</span>
          </div>
        </div>
      </div>

      <div style="margin-bottom:28px;break-inside:avoid;page-break-inside:avoid">
        <div style="font-family:monospace;font-size:9px;letter-spacing:1px;color:#E30613;text-transform:uppercase;font-weight:700;margin-bottom:8px">${tx.understanding_deviations}</div>
        <p style="font-size:12px;color:#3d3630;line-height:1.8">
          ${tx.deviations_text}
        </p>
        <ul style="margin:10px 0 0 20px;font-size:12px;color:#3d3630;line-height:1.8">
          <li><strong>${tx.above}:</strong> ${tx.too_hot_humid}</li>
          <li><strong>${tx.below}:</strong> ${tx.too_cold_dry}</li>
        </ul>
      </div>

      <div style="break-inside:avoid;page-break-inside:avoid">
        <div style="font-family:monospace;font-size:9px;letter-spacing:1px;color:#E30613;text-transform:uppercase;font-weight:700;margin-bottom:8px">${tx.ref_standards}</div>
        <p style="font-size:12px;color:#3d3630;line-height:1.8">
          ${lang === 'pt' ? 'A tabela abaixo apresenta os padrões de conformidade climática utilizados neste relatório, baseados em normas internacionais e recomendações de conservação preventiva.' : 'The table below presents the climate compliance standards used in this report, based on international standards and preventive conservation recommendations.'}
        </p>
      </div>

      <div style="break-inside:avoid;page-break-inside:avoid">
        <div style="font-family:monospace;font-size:9px;letter-spacing:1px;color:#E30613;text-transform:uppercase;font-weight:700;margin-bottom:8px">${tx.intl_lenders}</div>
        <p style="font-size:12px;color:#3d3630;line-height:1.8">
          ${tx.intl_lenders_text}
        </p>
        <p style="font-size:12px;color:#3d3630;line-height:1.8;margin-top:10px">
          ${lang === 'pt' ? 'Desvios ocasionais são normais e ocorrem durante manutenção, intervenções estruturais ou exposições. As justificativas para cada' : 'Occasional deviations are normal and occur during maintenance, structural interventions, or exhibitions. The justifications for each'} ${tx.period} ${lang === 'pt' ? 'crítico estão documentadas nas seções de ocorrências.' : 'critical period are documented in the occurrences sections.'}
        </p>
      </div>
    </div>
  </div>`;

  // Ordena sensores por criticidade (críticos primeiro)
  const sensorsDataSorted = [...sensorsData].sort((a, b) => {
    const aStatus = cls(a.conf);
    const bStatus = cls(b.conf);
    const statusOrder = { 'bad': 0, 'warn': 1, 'ok': 2, 'nd': 3 };
    return statusOrder[aStatus] - statusOrder[bStatus];
  });
  
  const critCount  = sensorsDataSorted.filter(d=>cls(d.conf)==='bad').length;
  const warnCount  = sensorsDataSorted.filter(d=>cls(d.conf)==='warn').length;

  const indexPage = `
  <div class="page">
    <div style="padding-bottom:20px;margin-bottom:28px;border-bottom:3px solid #0d0d0d">
      <div style="font-family:monospace;font-size:8px;letter-spacing:3px;color:#8c8278;text-transform:uppercase;margin-bottom:8px">${PAGE_LABELS.monitoring_report}</div>
      <div style="font-size:28px;font-weight:700;color:#0d0d0d">${tx.toc}</div>
    </div>
    
    <div style="display:flex; flex-direction:column; gap:12px;">
      <div style="display:flex; justify-content:space-between; border-bottom:1px solid #eee; padding-bottom:8px;">
        <span style="font-size:14px; color:#3d3630;">${PAGE_LABELS.cover}</span>
        <span style="font-family:monospace; color:#8c8278;">${PAGE_LABELS.page_num} 1</span>
      </div>
      <div style="display:flex; justify-content:space-between; border-bottom:1px solid #eee; padding-bottom:8px;">
        <span style="font-size:14px; color:#3d3630;">${PAGE_LABELS.guide}</span>
        <span style="font-family:monospace; color:#8c8278;">${PAGE_LABELS.page_num} 2</span>
      </div>
      <div style="display:flex; justify-content:space-between; border-bottom:1px solid #eee; padding-bottom:8px;">
        <span style="font-size:14px; color:#3d3630;">${PAGE_LABELS.summary}</span>
        <span style="font-family:monospace; color:#8c8278;">${PAGE_LABELS.page_num} 3</span>
      </div>
      <div style="display:flex; justify-content:space-between; border-bottom:1px solid #eee; padding-bottom:8px; margin-bottom:20px;">
        <span style="font-size:14px; color:#3d3630;">${PAGE_LABELS.comparative}</span>
        <span style="font-family:monospace; color:#8c8278;">${PAGE_LABELS.page_num} 4</span>
      </div>
    </div>

    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#8c8278;text-transform:uppercase;font-weight:700;margin-top:20px;margin-bottom:14px;padding-bottom:12px;border-bottom:1.5px solid #d0ccc5">${PAGE_LABELS.analyses}</div>
    <table class="index-table">
      <tbody>
        ${sensorsDataSorted.map((s,i) => {
          const status = cls(s.conf);
          const icon = status === 'bad' ? '🔴' : status === 'warn' ? '🟡' : '✓';
          return `<tr><td><span style="margin-right:6px">${icon}</span><strong>${escapeHtml(s.sensor)}</strong></td><td><strong>${pct(s.conf)}</strong></td><td>${PAGE_LABELS.page_num} ${5+i}</td></tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;

  const terreoStats = temTerreo ? (() => {
    const ts=subsample(terreoDados,5000);
    const avg=arr=>arr.length?(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1):'–';
    return { t_media:avg(ts.map(r=>r.temperatura).filter(v=>v!=null)), ur_media:avg(ts.map(r=>r.umidade).filter(v=>v!=null)), n:terreoDados.length };
  })() : null;

  const OCORR_COLORS = { manutencao:'#ca8a04', falha_equipamento:'#E30613', obra:'#7c3aed', sensor_deslocado:'#0284c7', pico_automatico:'#dc2626' };
  const OCORR_LABELS = lang === 'pt' ? {
    manutencao:'Manutenção',
    falha_equipamento:'Falha de equipamento',
    obra:'Obra / Intervenção',
    sensor_deslocado:'Sensor deslocado',
    pico_automatico:'Pico detectado automaticamente'
  } : {
    manutencao:'Maintenance',
    falha_equipamento:'Equipment Failure',
    obra:'Work / Intervention',
    sensor_deslocado:'Displaced Sensor',
    pico_automatico:'Automatically Detected Peak'
  };

  const summaryPage = `
  <div class="page">
    <div class="rep-header">
      <div>
        <div class="rep-logo">MASP<span class="accent">_</span></div>
        <div class="rep-sub">${tx.title} · ${tx.subtitle}</div>
      </div>
      <div class="rep-header-right">
        <div class="rep-period">${period}</div>
        <div class="rep-padrao-pill">${normaLabel} <span class="rep-padrao-desc-pill">${normaDesc}</span></div>
      </div>
    </div>

    <div class="kpi-row">
      <div class="kpi-card">
        <div class="kpi-lbl">${tx.avg_compliance}<br><small>${normaLabel}</small></div>
        <div class="kpi-val ${cls(parseFloat(avgConf))}">${avgConf!=null?avgConf+'%':'–'}</div>
        <div style="font-size:10px; color:#6b6057; margin-top:-4px">${tx.avg_compliance_desc}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-lbl">${tx.sensors_attention}</div>
        <div class="kpi-val ${warnCount>0?'warn':'ok'}">${warnCount}</div>
        <div style="font-size:10px; color:#6b6057; margin-top:-4px">${warnCount === 1 ? (lang === 'pt' ? 'sensor' : 'sensor') : (lang === 'pt' ? 'sensores' : 'sensors')} ${tx.sensors_attention_desc}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-lbl">${tx.sensors_critical}</div>
        <div class="kpi-val ${critCount>0?'bad':'ok'}">${critCount}</div>
        <div style="font-size:10px; color:#6b6057; margin-top:-4px">${critCount === 1 ? (lang === 'pt' ? 'sensor' : 'sensor') : (lang === 'pt' ? 'sensores' : 'sensors')} ${tx.sensors_critical_desc}</div>
      </div>
    </div>

    <div class="sec-title">${tx.comparative_view}</div>
    <table class="sum-table">
      <thead><tr>
        <th class="th-sensor">${tx.point_col}</th>
        <th style="text-align:center">${tx.measurements}</th>
        <th style="text-align:center">${tx.temp_avg}</th>
        <th style="text-align:center">${tx.ur_avg}</th>
        <th class="th-padrao" style="text-align:center">${tx.gen_conf}</th>
        <th style="text-align:center">${tx.status}</th>
      </tr></thead>
      <tbody>
        ${sensorsDataSorted.map(d=>`
        <tr>
          <td class="td-sensor">${escapeHtml(d.sensor)}</td>
          <td class="td-num">${d.serie.length.toLocaleString(dateLocale)}</td>
          <td class="td-num">${d.stats.temp_media!=null?d.stats.temp_media+'°C':'–'}</td>
          <td class="td-num">${d.stats.ur_media!=null?d.stats.ur_media+'%':'–'}</td>
          <td class="td-conf td-padrao ${cls(d.conf)}">${pct(d.conf)}</td>
          <td style="text-align:center"><span class="badge-status badge-${cls(d.conf)}">${statusLabel(cls(d.conf))}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>

    <div style="margin-top:24px; padding:15px; background:#f8f7f5; border-radius:4px; border:1px solid #e8e4de; display:flex; justify-content: space-between; align-items: center;">
      <div style="display:flex; gap:20px;">
        <span style="font-size:11px; color:#3d3630;"><span style="display:inline-block; width:8px; height:8px; background:#16a34a; border-radius:50%; margin-right:5px;"></span><strong>${tx.excellent}:</strong> ≥ 90%</span>
        <span style="font-size:11px; color:#3d3630;"><span style="display:inline-block; width:8px; height:8px; background:#d97706; border-radius:50%; margin-right:5px;"></span><strong>${tx.attention}:</strong> 70–80%</span>
        <span style="font-size:11px; color:#3d3630;"><span style="display:inline-block; width:8px; height:8px; background:#E30613; border-radius:50%; margin-right:5px;"></span><strong>${tx.critical}:</strong> < 70%</span>
      </div>
      <div style="font-family:monospace; font-size:9px; color:#a8a29e; text-transform:uppercase; letter-spacing:1px;">${lang === 'pt' ? 'Padrão' : 'Standard'}: ${normaLabel}</div>
    </div>
  </div>`;

  // ═══ PÁGINA DE EVOLUÇÃO MENSAL GLOBAL ═══
  const monthlyTrendsPage = content.includeGlobalTrend ? `
  <div class="page">
    <div class="rep-header">
      <div>
        <div class="rep-logo">MASP<span class="accent">_</span></div>
        <div class="rep-sub">${tx.monthly_evolution}</div>
      </div>
      <div class="rep-header-right">
        <div class="rep-period">${period}</div>
        <div class="rep-padrao-pill">${normaLabel}</div>
      </div>
    </div>
    
    <div class="sec-title">${tx.comparative_trend}</div>
    <p style="font-size:11px; color:#6b6057; margin-bottom:20px; line-height:1.6">
      ${tx.trend_text}
    </p>
    
    <div class="chart-wrap" style="height:500px; margin-bottom:30px">
      <canvas id="canvas_global_monthly"></canvas>
    </div>

    <div class="sec-title" style="margin-top:40px; border-bottom: none">${tx.legend_analysis}</div>
    <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:15px">
       <div class="stat-card" style="text-align:left; border-left: 3px solid #16a34a; background: #f0fdf4">
         <strong style="font-size:9px; display:block; margin-bottom:5px; color:#15803d; letter-spacing:1px">${tx.high_stability}</strong>
         <span style="font-size:11px; color:#3d3630">${tx.high_stability_text}</span>
       </div>
       <div class="stat-card" style="text-align:left; border-left: 3px solid #d97706; background: #fffbeb">
         <strong style="font-size:9px; display:block; margin-bottom:5px; color:#92400e; letter-spacing:1px">${tx.variation_alert}</strong>
         <span style="font-size:11px; color:#3d3630">${tx.variation_alert_text}</span>
       </div>
       <div class="stat-card" style="text-align:left; border-left: 3px solid #E30613; background: #fef2f2">
         <strong style="font-size:9px; display:block; margin-bottom:5px; color:#991b1b; letter-spacing:1px">${tx.critical_deviation}</strong>
         <span style="font-size:11px; color:#3d3630">${tx.critical_deviation_text}</span>
       </div>
    </div>
  </div>` : '';

  const sensorsDataForPages = content.includeSensors ? sensorsDataSorted : [];
  const sensorPages = sensorsDataForPages.map(({ sensor, serie, serieSub, terreoAlgn, monthlySeries, stats, thresh, conf, ct, cur, monthly, ocorrencias, safeId }) => {
    const monthlyHtml = monthly.length>1 && content.includeMonthly?`
    <div class="side-block">
      <div class="block-title">${tx.monthly_evolution_label} — ${thresh.label}</div>
      <table class="monthly-table">
        <thead><tr><th>${tx.month}</th><th>N</th><th class="th-padrao">${thresh.label}</th><th>T</th><th>UR</th></tr></thead>
        <tbody>${monthly.map(m=>`
          <tr>
            <td>${fmtMonth(m.mes)}</td>
            <td class="td-num">${m.n.toLocaleString(dateLocale)}</td>
            <td class="td-conf ${cls(m.conf)}">${pct(m.conf)}</td>
            <td class="td-conf ${cls(m.ct)}">${pct(m.ct)}</td>
            <td class="td-conf ${cls(m.cur)}">${pct(m.cur)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`:'';

    const ocorrHtml = content.includeOccurrences && ocorrencias?.length ? `
    <div class="ocorr-section">
      <div class="block-title">${tx.occurrences_registered} ${tx.period}</div>
      ${ocorrencias.map(o => {
        const ini  = (o.data_inicio || '').substring(0, 16).replace('T', ' ');
        const fim  = o.data_fim ? o.data_fim.substring(0, 16).replace('T', ' ') : null;
        const auto = o.tipo === 'pico_automatico';
        const sensNomes = (o.sensores || []).map(s => escapeHtml(s.nome)).join(', ');
        const respHtml = o.responsavel ? `<span class="ocorr-resp">${escapeHtml(o.responsavel)}</span>` : '';
        const sensHtml = sensNomes ? `<div style="font-family:monospace;font-size:9px;color:#8c8278;margin-bottom:4px">${lang === 'pt' ? 'Sensores:' : 'Sensors:'} ${sensNomes}</div>` : '';
        // No relatório 'externo', a descrição em texto livre fica de fora — é onde
        // costumam entrar detalhes operacionais internos, nomes de fornecedores/empresas
        // e procedimentos técnicos que não cabem mostrar pra emprestadores/seguradoras.
        const descHtml = content.externo ? '' : '<p class="ocorr-desc">' + escapeHtml(o.descricao) + '</p>';
        return '<div class="ocorr-item ocorr-' + o.tipo + '">'
          + '<div class="ocorr-row1">'
          + '<span class="ocorr-badge">' + (OCORR_LABELS[o.tipo] || o.tipo) + '</span>'
          + (auto ? '<span class="ocorr-auto-tag">⚡ ' + (lang === 'pt' ? 'automático' : 'automatic') + '</span>' : '')
          + '<span class="ocorr-datas">' + ini + (fim && fim !== ini ? ' → ' + fim : '') + '</span>'
          + respHtml
          + '</div>'
          + sensHtml
          + descHtml
          + '</div>';
      }).join('')}
    </div>` : '';

    const terreoLegend = temTerreo && content.includeCharts?`
      <span class="leg-item">
        <svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5,3"/></svg>
        ${lang === 'pt' ? 'Térreo — externo' : 'Ground Floor — external'}
      </span>`:'';

    const ocorrLegend = content.includeOccurrences && ocorrencias?.length ? `
      <div style="margin-top:8px;padding:8px 0;border-top:1px solid #e8e4de;font-size:9px">
        <div style="font-family:monospace;font-size:7.5px;letter-spacing:1px;color:#8c8278;text-transform:uppercase;margin-bottom:6px">${tx.occurrences_period}</div>
        <div style="display:flex;flex-wrap:wrap;gap:12px">
          ${(() => {
            const ocorrTypes = {};
            ocorrencias.forEach(o => {
              if (!ocorrTypes[o.tipo]) ocorrTypes[o.tipo] = OCORR_LABELS[o.tipo] || o.tipo;
            });
            return Object.entries(ocorrTypes).map(([tipo, label]) => {
              const color = OCORR_COLORS[tipo] || '#888';
              return `<span class="leg-item" style="flex-shrink:0"><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="${color}" stroke-width="1.5" stroke-dasharray="3,3"></line><circle cx="6" cy="5" r="3.5" fill="${color}"/></svg>${escapeHtml(label)}</span>`;
            }).join('');
          })()}
        </div>
      </div>
    ` : '';

    return `
    <div class="page">
      <div class="sensor-hdr">
        <div>
          <div class="sensor-name">${escapeHtml(sensor.toUpperCase())}</div>
          <div class="sensor-period">${period} &nbsp;·&nbsp; ${serie.length.toLocaleString(dateLocale)} ${tx.measurements.toLowerCase()}</div>
          ${thresh.equipment?`<div class="equip-label">${escapeHtml(thresh.equipment)}</div>`:''}
        </div>
        <div style="text-align:right">
          <span class="badge-status badge-${cls(conf)} badge-lg">${statusLabel(cls(conf))}</span>
          <div style="font-family:monospace;font-size:9px;color:#8c8278;margin-top:6px;letter-spacing:1px">${normaLabel}</div>
        </div>
      </div>
<div class="stats-strip">
 <div class="stat-card">
        <span class="stat-lbl">T média</span>
        <span class="stat-val">${stats.temp_media!=null?stats.temp_media+'°C':'–'}</span>
    </div>
    <div class="stat-card">
        <span class="stat-lbl">UR média</span>
        <span class="stat-val">${stats.ur_media != null ? stats.ur_media + '%' : '–'}</span>
    </div>
    <div class="stat-card stat-padrao">
        <span class="stat-lbl">${normaLabel}</span>
        <span class="stat-val ${cls(conf)}">${pct(conf)}</span>
        <span style="font-size: 10px; color: #8c8278; display: block; margin-top: 5px; line-height: 1.2; text-transform: uppercase; letter-spacing: 0.5px;">${tx.inside_range}</span>
    </div>
    <div class="stat-card">
        <span class="stat-lbl">T ${thresh.tMin}–${thresh.tMax}°C</span>
        <span class="stat-val ${cls(ct)}">${pct(ct)}</span>
        <span style="font-size: 10px; color: #8c8278; display: block; margin-top: 5px; line-height: 1.2; text-transform: uppercase; letter-spacing: 0.5px;">${tx.inside_range}</span>
    </div>
    <div class="stat-card">
        <span class="stat-lbl">UR ${thresh.urMin}–${thresh.urMax}%</span>
        <span class="stat-val ${cls(cur)}">${pct(cur)}</span>
        <span style="font-size: 10px; color: #8c8278; display: block; margin-top: 5px; line-height: 1.2; text-transform: uppercase; letter-spacing: 0.5px;">${tx.inside_range}</span>
    </div>
</div>
${content.includeCharts ? `
      <div class="chart-block">
        <div class="chart-lbl-row">
          <span class="chart-lbl">Temperatura (°C)</span>
          <span class="chart-legend">
            <span class="leg-item"><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="#c0392b" stroke-width="2"/></svg>${escapeHtml(sensor)}</span>
            ${terreoLegend}
            <span class="leg-item"><span class="leg-zone-swatch"></span>${tx.zone} ${thresh.tMin}–${thresh.tMax}°C</span>
            <span class="leg-item"><span class="leg-dot-swatch"></span>${tx.outside_zone}</span>
            ${(serieSub.some(r => Number(r.periodo_expositivo) === 1) ? '<span class="leg-item"><span class="leg-expo-swatch"></span>' + tx.in_exhibition + '</span>' : '')}
          </span>
        </div>
        ${ocorrLegend}
        ${content.splitChartsByMonth && monthlySeries.length ? monthlySeries.map(mc => `
        <div class="month-chart-wrap">
          <div class="month-chart-lbl">${escapeHtml(fmtMonth(mc.mes))}</div>
          <div class="chart-wrap"><canvas id="${safeId}_T_${mc.mes.replace('-','_')}"></canvas></div>
        </div>`).join('') : `<div class="chart-wrap" style="margin-top:12px"><canvas id="${safeId}_T"></canvas></div>`}
      </div>
      <div class="chart-block">
        <div class="chart-lbl-row">
          <span class="chart-lbl">Umidade Relativa (%)</span>
          <span class="chart-legend">
            <span class="leg-item"><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="#1d4ed8" stroke-width="2"/></svg>${escapeHtml(sensor)}</span>
            ${terreoLegend}
            <span class="leg-item"><span class="leg-zone-swatch"></span>${tx.zone} ${thresh.urMin}–${thresh.urMax}%</span>
            <span class="leg-item"><span class="leg-dot-swatch"></span>${tx.outside_zone}</span>
            ${(serieSub.some(r => Number(r.periodo_expositivo) === 1) ? '<span class="leg-item"><span class="leg-expo-swatch"></span>' + tx.in_exhibition + '</span>' : '')}
          </span>
        </div>
        ${content.splitChartsByMonth && monthlySeries.length ? monthlySeries.map(mc => `
        <div class="month-chart-wrap">
          <div class="month-chart-lbl">${escapeHtml(fmtMonth(mc.mes))}</div>
          <div class="chart-wrap"><canvas id="${safeId}_R_${mc.mes.replace('-','_')}"></canvas></div>
        </div>`).join('') : `<div class="chart-wrap" style="margin-top:12px"><canvas id="${safeId}_R"></canvas></div>`}
      </div>` : ''}<div class="bottom-row" style="display: flex; gap: 16px; margin-top: 20px;">
        ${monthlyHtml}
        
        ${thresh.notas ? `
        <div class="side-block" style="flex: 1;">
          <div class="block-title">${tx.tech_notes}</div>
          <div class="stat-card" style="text-align: left; padding: 15px; background: #fdfdfb; border-color: #e8e4de;">
            <p style="font-size: 11px; color: #6b6057; line-height: 1.7; white-space: pre-wrap; margin: 0;">${escapeHtml(thresh.notas)}</p>
          </div>
        </div>` : ''}
      </div>      
      ${(() => {
        if (!content.includeDeviations) return '';
        // ESSAS 7 LINHAS SÃO OBRIGATÓRIAS PARA CALCULAR OS VALORES!
        const tot = serie.length || 1;
        const tDentro = serie.filter(d => d.temperatura >= thresh.tMin && d.temperatura <= thresh.tMax).length;
        const tAcima  = serie.filter(d => d.temperatura > thresh.tMax).length;
        const tAbaixo = serie.filter(d => d.temperatura < thresh.tMin).length;
        const uDentro = serie.filter(d => d.umidade >= thresh.urMin && d.umidade <= thresh.urMax).length;
        const uAcima  = serie.filter(d => d.umidade > thresh.urMax).length;
        const uAbaixo = serie.filter(d => d.umidade < thresh.urMin).length;
        
        return `
        <div class="desvios-section">
          <div class="sec-title" style="margin-bottom:14px;border-bottom:none">${tx.dev_analysis_t}</div>
          <div class="desvios-grid" style="margin-bottom:24px">
            <div class="desvio-card ok">
              <div class="desvio-titulo"><span style="color:#15803d">✓</span> ${tx.within_range_label}</div>
              <div class="desvio-kpi" style="color:#15803d">${(tDentro/tot*100).toFixed(1)}%</div>
              <div class="desvio-sub">${tDentro.toLocaleString(dateLocale)} ${tx.normal_meds}</div>
            </div>
            <div class="desvio-card warn">
              <div class="desvio-titulo"><span style="color:#92400e">↑</span> ${tx.above_limit}</div>
              <div class="desvio-kpi" style="color:#92400e">${(tAcima/tot*100).toFixed(1)}%</div>
              <div class="desvio-sub">${tAcima.toLocaleString(dateLocale)} ${tx.measurements.toLowerCase()} (${tx.too_hot_label})</div>
            </div>
            <div class="desvio-card" style="background:rgba(37,99,235,0.04);border-color:#bfdbfe">
              <div class="desvio-titulo"><span style="color:#1d4ed8">↓</span> ${tx.below_limit}</div>
              <div class="desvio-kpi" style="color:#1d4ed8">${(tAbaixo/tot*100).toFixed(1)}%</div>
              <div class="desvio-sub">${tAbaixo.toLocaleString(dateLocale)} ${tx.measurements.toLowerCase()} (${tx.too_cold_label})</div>
            </div>
          </div>

          <div class="sec-title" style="margin-bottom:14px;border-bottom:none">${tx.dev_analysis_ur}</div>
          <div class="desvios-grid">
            <div class="desvio-card ok">
              <div class="desvio-titulo"><span style="color:#15803d">✓</span> ${tx.within_range_label}</div>
              <div class="desvio-kpi" style="color:#15803d">${(uDentro/tot*100).toFixed(1)}%</div>
              <div class="desvio-sub">${uDentro.toLocaleString(dateLocale)} ${tx.normal_meds}</div>
            </div>
            <div class="desvio-card" style="background:rgba(217,119,6,0.04);border-color:#fde68a">
              <div class="desvio-titulo"><span style="color:#b45309">↑</span> ${tx.above_limit}</div>
              <div class="desvio-kpi" style="color:#b45309">${(uAcima/tot*100).toFixed(1)}%</div>
              <div class="desvio-sub">${uAcima.toLocaleString(dateLocale)} ${tx.measurements.toLowerCase()} (${tx.too_humid_label})</div>
            </div>
            <div class="desvio-card bad">
              <div class="desvio-titulo"><span style="color:#991b1b">↓</span> ${tx.below_limit}</div>
              <div class="desvio-kpi" style="color:#991b1b">${(uAbaixo/tot*100).toFixed(1)}%</div>
              <div class="desvio-sub">${uAbaixo.toLocaleString(dateLocale)} ${tx.measurements.toLowerCase()} (${tx.too_dry_label})</div>
            </div>
          </div>
        </div>
        `;
      })()}

      ${ocorrHtml}
    </div>`;
  });

  const chartPayload = sensorsDataSorted.map(({ sensor, safeId, serieSub, terreoAlgn, monthlySeries, thresh, ocorrencias, monthly }) => ({
    sensor, safeId, thresh, serie: serieSub, terreo: terreoAlgn,
    // sensor/monthly alimentam o gráfico global de "Tendência de Conformidade Comparativa"
    // (canvas_global_monthly) — sem eles no payload embutido, datasetsGlobal ficava sempre
    // vazio e a página inteira aparecia em branco.
    monthly,
    // Processa período expositivo com validações robustas
    periodoExpo: buildPeriodoExpo(serieSub),
    /* Captura o nome da exposição de cada ponto da série */
    periodoExpoNomes: buildPeriodoExpoNomes(serieSub),
    ocorrs: (ocorrencias||[]).map(o=>({ dataStr:o.data_inicio||'', color:OCORR_COLORS[o.tipo]||'#888', label:OCORR_LABELS[o.tipo]||o.tipo })),
    customMarkers: contentSettings.customMarkers || [],
    // Gráficos mês a mês (splitChartsByMonth) — ocorrências/marcadores filtrados por mês para
    // não vazar um evento de março pro gráfico de janeiro (o plugin desenha a marcação no
    // último ponto do gráfico quando não acha a data exata dentro do período mostrado).
    monthlyCharts: (monthlySeries || []).map(mc => ({
      mesKey: mc.mes.replace('-', '_'),
      serie: mc.serieSub,
      terreo: mc.terreoAlgn,
      periodoExpo: buildPeriodoExpo(mc.serieSub),
      periodoExpoNomes: buildPeriodoExpoNomes(mc.serieSub),
      ocorrs: (ocorrencias || [])
        .filter(o => (o.data_inicio || '').substring(0, 7) === mc.mes)
        .map(o => ({ dataStr: o.data_inicio || '', color: OCORR_COLORS[o.tipo] || '#888', label: OCORR_LABELS[o.tipo] || o.tipo })),
      customMarkers: (contentSettings.customMarkers || []).filter(m => (m.date || '').substring(0, 7) === mc.mes)
    }))
  }));
  const dataJSON = JSON.stringify(chartPayload).replace(/<\/script>/gi,'<\\/script>');

  const html = `<!DOCTYPE html>
<html lang="${lang === 'pt' ? 'pt-BR' : 'en-US'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>MASP — Climatização ${period} — ${normaLabel}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#edeae5;color:#1a1614;font-size:13px;-webkit-font-smoothing:antialiased}
.toolbar{position:sticky;top:0;z-index:100;background:#0d0d0d;border-bottom:2.5px solid #E30613;display:flex;align-items:center;justify-content:space-between;padding:0 36px;height:50px;gap:20px}
.toolbar-title{font-family:monospace;font-size:10px;letter-spacing:3px;color:#a8a29e;text-transform:uppercase;flex:1}
.toolbar-btns{display:flex;gap:8px}
.tbtn{background:#E30613;color:#fff;border:none;padding:7px 20px;font-family:monospace;font-size:10px;letter-spacing:1.5px;cursor:pointer;border-radius:2px;transition:opacity .2s;text-transform:uppercase}
.tbtn:hover{opacity:.8}
.tbtn.close-btn{background:#3d3630}
.page{background:#fff;max-width:980px;margin:28px auto;border-radius:6px;box-shadow:0 2px 20px rgba(0,0,0,.09);padding:44px 52px;page-break-after:always;break-after:page}
.rep-header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;margin-bottom:32px;border-bottom:3px solid #0d0d0d}
.rep-logo{font-family:monospace;font-size:24px;font-weight:900;letter-spacing:8px}
.accent{color:#E30613}
.rep-sub{font-family:monospace;font-size:9px;letter-spacing:2px;color:#8c8278;margin-top:5px;text-transform:uppercase}
.rep-header-right{text-align:right}
.rep-period{font-family:monospace;font-size:13px;font-weight:600;color:#1a1614}
.rep-padrao-pill{display:inline-block;margin-top:7px;padding:4px 12px;border-radius:20px;background:#f0fdf4;border:1px solid #bbf7d0;font-family:monospace;font-size:9px;font-weight:700;letter-spacing:1.5px;color:#15803d;text-transform:uppercase}
.rep-padrao-desc-pill{font-weight:400;opacity:.75;letter-spacing:.5px}
.rep-meta{font-family:monospace;font-size:9px;color:#a8a29e;margin-top:6px}
.kpi-row{display:flex;gap:14px;margin-bottom:42px;flex-wrap:wrap}
.kpi-card{flex:1;min-width:180px;background:#f8f7f5;border:2px solid #d0ccc5;border-radius:6px;padding:19px 22px}
.kpi-card:hover{background:#f0ebe5;border-color:#a8a29e;transition:all .3s ease}
.kpi-card-sm{flex:.8}
.kpi-lbl{font-family:monospace;font-size:8px;letter-spacing:2px;color:#6b6057;text-transform:uppercase;margin-bottom:12px;line-height:1.8;font-weight:600}
.kpi-lbl small{font-size:7px;opacity:.75;letter-spacing:1px}
.kpi-val{font-family:monospace;font-size:32px;font-weight:900;letter-spacing:-1.5px;line-height:1.1;margin-bottom:6px}
.kpi-sensor-name{font-family:monospace;font-size:13px;font-weight:700;line-height:1.4;margin-bottom:3px}
.kpi-sensor-val{font-family:monospace;font-size:24px;font-weight:900;letter-spacing:-0.5px}
.ok{color:#15803d}.warn{color:#92400e}.bad{color:#991b1b}
.sum-table{width:100%;border-collapse:collapse;font-size:11px;line-height:1.6}
.sum-table th{padding:11px;background:#f0ebe5;border-bottom:2px solid #d0ccc5;font-family:monospace;font-size:8px;letter-spacing:1px;color:#5a5350;text-transform:uppercase;text-align:left;font-weight:700}
.sum-table td{padding:10px 11px;border-bottom:1px solid #eae8e4;vertical-align:middle;color:#3d3630}
.sum-table tr:last-child td{border-bottom:none}
.th-sensor{font-weight:700;width:32%}
.th-padrao{font-weight:700;background:rgba(22,163,74,.08);color:#15803d}
.td-sensor{font-family:monospace;font-weight:700;color:#0d0d0d;font-size:12px}
.tr-terreo{font-size:10px;color:#8c8278;background:#fafaf9}
.tr-terreo td{padding:8px 11px}
.td-num{text-align:center;font-family:monospace;font-size:11px;color:#3d3630}
.td-conf{font-family:monospace;font-weight:700;text-align:center;font-size:12px}
.td-conf.ok{color:#15803d}
.td-conf.warn{color:#92400e}
.td-conf.bad{color:#991b1b}
.td-conf.nd{color:#a8a29e}
.td-padrao{background:rgba(22,163,74,.06)}
.tr-divider td{height:6px;background:transparent;border:none;padding:0}
.monthly-table{width:100%;border-collapse:collapse;font-size:11px}
.monthly-table th{padding:10px;background:#f0ebe5;border-bottom:2px solid #d0ccc5;font-family:monospace;font-size:8px;letter-spacing:1px;color:#5a5350;text-transform:uppercase;font-weight:700}
.monthly-table th.th-padrao{background:rgba(22,163,74,.08);color:#15803d}
.monthly-table td{padding:9px 10px;border-bottom:1px solid #eae8e4;color:#3d3630}
.monthly-table tr:last-child td{border-bottom:none}
.monthly-table .td-conf{font-family:monospace;font-weight:700;text-align:center;font-size:12px}
.monthly-table .td-conf.ok{color:#15803d}.monthly-table .td-conf.warn{color:#92400e}.monthly-table .td-conf.bad{color:#991b1b}
.notas-block p{font-size:11px;color:#3d3630;line-height:1.7;white-space:pre-wrap;margin-top:6px}
.ocorr-section{margin-top:28px;padding-top:18px;border-top:2.5px solid #E30613}
.ocorr-item{margin-bottom:12px;padding:13px 16px;background:#fafaf9;border-left:4px solid #d5d1cb;border-radius:0 4px 4px 0}
.ocorr-manutencao{border-left-color:#ca8a04}.ocorr-falha_equipamento{border-left-color:#E30613}.ocorr-obra{border-left-color:#7c3aed}.ocorr-sensor_deslocado{border-left-color:#0284c7}.ocorr-pico_automatico{border-left-color:#dc2626;background:#fff8f8}
.ocorr-row1{display:flex;align-items:center;gap:11px;margin-bottom:8px;flex-wrap:wrap}
.ocorr-badge{font-family:monospace;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;padding:3px 10px;border-radius:2px}
.ocorr-manutencao .ocorr-badge{background:#fef9c3;color:#854d0e}.ocorr-falha_equipamento .ocorr-badge{background:#fee2e2;color:#991b1b}.ocorr-obra .ocorr-badge{background:#ede9fe;color:#4c1d95}.ocorr-sensor_deslocado .ocorr-badge{background:#e0f2fe;color:#075985}.ocorr-pico_automatico .ocorr-badge{background:#fee2e2;color:#991b1b}
.ocorr-auto-tag{font-family:monospace;font-size:8px;color:#dc2626;background:#fee2e2;padding:2px 7px;border-radius:2px;margin-left:4px;font-weight:600}
.ocorr-datas{font-family:monospace;font-size:11px;color:#5a5350;font-weight:500}
.ocorr-resp{font-family:monospace;font-size:10px;color:#9c8f84;margin-left:auto;font-style:italic}
.ocorr-desc{font-size:12.5px;color:#2d2620;line-height:1.5;margin-top:6px}
.desvios-section{margin-top:32px;padding-top:24px;border-top:2.5px solid #0d0d0d}
.sec-title{padding-bottom:16px;margin-bottom:16px;font-family:monospace;font-size:10px;letter-spacing:2px;color:#E30613;text-transform:uppercase;font-weight:700;border-bottom:2px solid #0d0d0d}
.desvios-summary-table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px}
.desvios-summary-table th{padding:11px;background:#f0ebe5;border-bottom:2px solid #d0ccc5;font-family:monospace;font-size:8px;letter-spacing:1px;color:#5a5350;text-transform:uppercase;text-align:left;font-weight:700}
.desvios-summary-table td{padding:12px 11px;border-bottom:1px solid #eae8e4;font-size:13px;vertical-align:middle;color:#3d3630}
.desvios-summary-table tr:last-child td{border-bottom:none}
.desvios-summary-table .td-num{font-family:monospace;font-weight:700;text-align:center;font-size:13px}
.desvios-summary-table tr.ok{background:rgba(22,163,74,.05)}.desvios-summary-table tr.ok .td-num{color:#15803d}
.desvios-summary-table tr.warn{background:rgba(217,119,6,.05)}.desvios-summary-table tr.warn .td-num{color:#92400e}
.desvios-summary-table tr.bad{background:rgba(225,6,19,.05)}.desvios-summary-table tr.bad .td-num{color:#991b1b}
.page-cover{background:linear-gradient(135deg,#f8f7f5 0%,#edeae5 100%);display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100vh;padding:80px 52px}
.index-table{width:100%;border-collapse:collapse;font-size:11px}
.index-table tr{border-bottom:1px solid #d0ccc5}
.index-table td{padding:11px 14px;color:#3d3630}
.index-table td:first-child{font-weight:600;color:#0d0d0d}
.index-table td:last-child{text-align:right;font-family:monospace;color:#8c8278;font-size:10px;font-weight:500}
.index-table tr:hover{background:#f8f7f5}
.stats-strip { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 24px; }
.stat-card { background: #f8f7f5; border: 1px solid #d0ccc5; border-radius: 6px; padding: 16px 10px; text-align: center; }
.stat-lbl { display: block; font-family: monospace; font-size: 9px; letter-spacing: 1px; color: #6b6057; text-transform: uppercase; margin-bottom: 8px; }
.stat-val { display: block; font-family: monospace; font-size: 20px; font-weight: 700; color: #0d0d0d; }
.stat-padrao { background: rgba(22,163,74,.05); border-color: #bbf7d0; }

.desvios-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 16px; }
.desvio-card { padding: 18px; border-radius: 6px; border: 1px solid #e8e4de; text-align: center; }
.desvio-card.ok { background: rgba(22,163,74,.04); border-color: #bbf7d0; }
.desvio-card.warn { background: rgba(217,119,6,.04); border-color: #fde68a; }
.desvio-card.bad { background: rgba(227,6,19,.04); border-color: #fecaca; }
.desvio-titulo { font-family: monospace; font-size: 10px; font-weight: 700; text-transform: uppercase; margin-bottom: 12px; letter-spacing: 1px; }
.desvio-kpi { font-size: 26px; font-weight: 700; font-family: monospace; line-height: 1; margin-bottom: 6px; }
.desvio-sub { font-size: 11px; color: #6b6057; }
.chart-block { margin-bottom: 24px; }
.month-chart-wrap { margin-top: 20px; padding-top: 14px; border-top: 1px dashed #d0ccc5; }
.month-chart-wrap:first-of-type { margin-top: 12px; }
.month-chart-lbl { font-family: monospace; font-size: 10px; font-weight: 700; letter-spacing: 1.5px; color: #5a5350; text-transform: uppercase; margin-bottom: 8px; }
.chart-lbl-row { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 6px; }
.chart-lbl { font-family: monospace; font-size: 11px; font-weight: 700; color: #0d0d0d; text-transform: uppercase; letter-spacing: 1px; }
.chart-legend { display: flex; flex-wrap: wrap; gap: 12px; justify-content: flex-end; align-items: center; max-width: 75%; }
.leg-item { display: flex; align-items: center; gap: 5px; font-family: monospace; font-size: 9px; color: #6b6057; }
.leg-zone-swatch { width: 12px; height: 12px; background: rgba(22,163,74,.09); border: 1px dashed rgba(22,163,74,.5); border-radius: 2px; }
.leg-dot-swatch { width: 8px; height: 8px; background: #e30613; border-radius: 50%; }
.leg-expo-swatch { width: 12px; height: 12px; background: rgba(227,6,19,.065); border-bottom: 3px solid rgba(227,6,19,.32); border-radius: 2px; }
@media print{body{background:#fff}.toolbar{display:none!important}.page{margin:0;box-shadow:none;border-radius:0;padding:32px 40px}}
</style>
</head>
<body>
<div class="toolbar">
  <span class="toolbar-title">MASP — Climatização ${period} &nbsp;·&nbsp; ${normaLabel}</span>
  <div class="toolbar-btns">
    <button class="tbtn" onclick="window.print()">⎙ &nbsp;${tx.save_pdf}</button>
    <button class="tbtn close-btn" onclick="window.close()">✕ &nbsp;${tx.close}</button>
  </div>
</div>

${content.includeCover ? coverPage : ''}
${content.includeInstructions ? instructionsPage : ''}
${content.includeIndex ? indexPage : ''}
${content.includeSummary ? summaryPage : ''}
${monthlyTrendsPage}
${content.includeSensors ? sensorPages.join('\n') : ''}
<script type="application/json" id="report-data">
${dataJSON}
</script>
<script>
(function(){
var DATA = JSON.parse(document.getElementById('report-data').textContent);

// Rótulos traduzidos no momento da geração do relatório (idioma fixo, definido em ${JSON.stringify(lang)})
var L_MAX = ${JSON.stringify(lang === 'pt' ? 'Máx: ' : 'Max: ')};
var L_MIN = ${JSON.stringify(lang === 'pt' ? 'Mín: ' : 'Min: ')};
var L_DATETIME = ${JSON.stringify(lang === 'pt' ? 'Data/Hora: ' : 'Date/Time: ')};
var L_SENSOR = ${JSON.stringify(lang === 'pt' ? 'Sensor: ' : 'Sensor: ')};
var L_CONFORME = ${JSON.stringify(lang === 'pt' ? ' ✓ Conforme' : ' ✓ Compliant')};
var L_FORA = ${JSON.stringify(lang === 'pt' ? ' ✗ Fora' : ' ✗ Out of range')};
var L_EM_EXPO_TOOLTIP = ${JSON.stringify(lang === 'pt' ? ' | Em exposição' : ' | On exhibition')};
var L_TERREO_REF = ${JSON.stringify(lang === 'pt' ? 'Térreo (ref): ' : 'Ground Floor (ref): ')};
var L_TERREO_LABEL = ${JSON.stringify(lang === 'pt' ? 'Térreo' : 'Ground Floor')};
var L_EM_EXPOSICAO = ${JSON.stringify(lang === 'pt' ? 'EM EXPOSIÇÃO' : 'ON EXHIBITION')};
var L_SEM_EXPOSICAO = ${JSON.stringify(lang === 'pt' ? 'SEM EXPOSIÇÃO' : 'NOT ON EXHIBITION')};

var zonaPlugin={id:'zonaPlugin',afterDraw:function(chart){
  var ds0=chart.data.datasets[0];if(!ds0||!ds0._zm)return;
  var zm=ds0._zm,ctx=chart.ctx,xs=chart.scales.x,ys=chart.scales.y;
  var pY1=ys.getPixelForValue(zm.zMax),pY2=ys.getPixelForValue(zm.zMin);
  var aL=chart.chartArea.left,aR=chart.chartArea.right,aT=chart.chartArea.top,aB=chart.chartArea.bottom;
  ctx.save();
  ctx.fillStyle='rgba(22,163,74,0.09)';ctx.fillRect(aL,pY1,aR-aL,pY2-pY1);
  ctx.strokeStyle='rgba(22,163,74,0.5)';ctx.lineWidth=1.2;ctx.setLineDash([5,4]);
  [pY1,pY2].forEach(function(py){if(py>aT && py<aB){ctx.beginPath();ctx.moveTo(aL,py);ctx.lineTo(aR,py);ctx.stroke();}});
  ctx.setLineDash([]);
  ctx.fillStyle='rgba(22,163,74,0.75)';ctx.font='bold 10px monospace';
  if(pY1>aT) ctx.fillText(L_MAX+zm.zMax+zm.unit,aL+8,pY1-7);
  if(pY2<aB) ctx.fillText(L_MIN+zm.zMin+zm.unit,aL+8,pY2+16);
  if(zm.ocorrs&&zm.rawLabels){zm.ocorrs.forEach(function(o){
    var oTs=(o.dataStr||'').substring(0,16);
    var idx=zm.rawLabels.findIndex(function(l){return l.substring(0,16)>=oTs;});
    if(idx<0)idx=zm.rawLabels.length-1;
    var px=xs.getPixelForValue(idx);
    ctx.save();ctx.strokeStyle=o.color;ctx.lineWidth=2;ctx.setLineDash([3,3]);
    ctx.beginPath();ctx.moveTo(px,aT);ctx.lineTo(px,aB);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle=o.color;ctx.beginPath();ctx.arc(px,aT+8,5,0,Math.PI*2);ctx.fill();ctx.restore();
  });}
  ctx.restore();
}};
Chart.register(zonaPlugin);

function fmtL(str){if(!str)return'';var s=str.replace('T',' ');var p=s.substring(0,10).split('-');var t=s.substring(11,16);return p.length===3?p[2]+'/'+p[1]+' '+t:str;}

function mkChart(id,color,sensorData,rawLabels,unit,zMin,zMax,terreoData,ocorrs,periodoExpo,periodoExpoNomes,customMarkers){
  var el=document.getElementById(id); if(!el)return;
  
  var customMin = unit === '°C' ? ${JSON.stringify(contentSettings.chartYMinT)} : ${JSON.stringify(contentSettings.chartYMinR)};
  var customMax = unit === '°C' ? ${JSON.stringify(contentSettings.chartYMaxT)} : ${JSON.stringify(contentSettings.chartYMaxR)};
  
  // Força os limites rígidos do gráfico se o usuário os definiu
  var yMin = (customMin !== null && customMin !== "") ? parseFloat(customMin) : (unit==='°C' ? 15 : 30);
  var yMax = (customMax !== null && customMax !== "") ? parseFloat(customMax) : (unit==='°C' ? 35 : 100);

  var datasets = [{
    label:'Sensor', data:sensorData, borderColor:color, borderWidth:1.5, 
    pointRadius: 0, pointHoverRadius: 5, tension:0.75, fill:false,
    _zm:{zMin:zMin,zMax:zMax,unit:unit,rawLabels:rawLabels,ocorrs:ocorrs||[], customMarkers: customMarkers||[]}
  }];
  
  if(terreoData && terreoData.length) datasets.push({label:L_TERREO_LABEL, data:terreoData, borderColor:'#94a3b8', borderWidth: 1, borderDash:[6, 4], pointRadius:0, fill:false, tension: 0.4, spanGaps: true});

  var expoShadingPlugin={id:'expoShading',afterDraw:function(chart){
    if(!periodoExpo||!periodoExpo.length)return;
    var ctx=chart.ctx,xs=chart.scales.x,ca=chart.chartArea;
    if(!xs||!ca)return;
    
    // Validação: se periodoExpo não tem o mesmo comprimento dos dados, não desenha
    var ds=chart.data.datasets[0];
    if(!ds||!ds.data||ds.data.length!==periodoExpo.length)return;
    
    ctx.save();
    var STRIP_H=6;
    var i=0;
    // Percorre trechos contínuos tanto de "em exposição" (1) quanto de "sem exposição" (0) —
    // cada trecho ganha seu rótulo escrito no próprio gráfico, não só uma legenda à parte.
    while(i<periodoExpo.length){
      var emExpo=periodoExpo[i]===1;
      var s=i;
      var nomeExpo=(emExpo && typeof periodoExpoNomes!=='undefined') ? periodoExpoNomes[i] : null;
      // Avança enquanto o trecho continuar do mesmo tipo (todo 1 ou todo 0)
      while(i<periodoExpo.length && (periodoExpo[i]===1)===emExpo) i++;
      // Garante que i-1 está dentro dos limites válidos
      var endIdx=Math.min(i-1,periodoExpo.length-1);
      if(endIdx<s) endIdx=s; // Se s é o último índice

      var x1=xs.getPixelForValue(s);
      var x2=xs.getPixelForValue(endIdx);

      // Certifica que x1 <= x2 (em caso de erro de renderização)
      if(x1>x2){ var temp=x1; x1=x2; x2=temp; }
      var w=Math.max(x2-x1,1);

      if(emExpo){
        // Desenha o fundo sombreado
        ctx.fillStyle='rgba(227,6,19,0.05)';
        ctx.fillRect(x1,ca.top,w,ca.height-STRIP_H);
        // Desenha a barrinha vermelha na base
        ctx.fillStyle='rgba(227,6,19,0.32)';
        ctx.fillRect(x1,ca.bottom-STRIP_H,w,STRIP_H);
      }

      // Rótulo escrito no próprio gráfico: "EM EXPOSIÇÃO" (+ nome, se couber) ou "SEM EXPOSIÇÃO".
      // Fica colado na base do gráfico (entre as curvas de dados e a legenda logo abaixo do
      // canvas) em vez de no topo — lá em cima ele ficava por cima das linhas de temperatura/
      // umidade e virava poluição visual em gráficos com muita informação.
      if(w>30){
        var base=emExpo?L_EM_EXPOSICAO:L_SEM_EXPOSICAO;
        var label=base;
        ctx.font='600 9px "IBM Plex Mono", monospace';
        ctx.textAlign='left';
        if(nomeExpo){
          var comNome=base+' — '+nomeExpo.toUpperCase();
          if(ctx.measureText(comNome).width<=w-8){
            label=comNome;
          }else{
            var comNomeCurto=base+' — '+nomeExpo.toUpperCase().substring(0,10)+'...';
            if(ctx.measureText(comNomeCurto).width<=w-8) label=comNomeCurto;
          }
        }
        var textW=ctx.measureText(label).width;
        if(textW<=w-8){
          var labelY=ca.bottom-STRIP_H-5;
          // Fundo clarinho atrás do texto — mantém o rótulo legível mesmo quando uma curva
          // passa exatamente por trás dele
          ctx.fillStyle=emExpo?'rgba(255,241,242,0.88)':'rgba(250,250,249,0.88)';
          ctx.fillRect(x1+2,labelY-8,textW+4,11);
          ctx.fillStyle=emExpo?'rgba(227,6,19,0.75)':'rgba(120,110,100,0.75)';
          ctx.fillText(label,x1+4,labelY);
        }
      }
    }
    ctx.restore();
  }};
  
  var customEventPlugin={id:'customEvents',afterDraw:function(chart){
    var ds0=chart.data.datasets[0]; if(!ds0||!ds0._zm||!ds0._zm.customMarkers)return;
    var ctx=chart.ctx,xs=chart.scales.x,ca=chart.chartArea;
    ctx.save();
    ds0._zm.customMarkers.forEach(function(m, idx) {
      var ts=m.date.replace('T',' ').substring(0,16);
      var xIdx=rawLabels.findIndex(function(l){return l.substring(0,16)>=ts;});
      if(xIdx===-1) xIdx=rawLabels.length-1;
      if(xIdx===0 && rawLabels[0].substring(0,16)>ts) return; 
      var px=xs.getPixelForValue(xIdx);
      
      ctx.strokeStyle='#8b5cf6'; ctx.lineWidth=2; ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.moveTo(px,ca.top); ctx.lineTo(px,ca.bottom); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle='#8b5cf6'; ctx.font='bold 10px monospace';
      var txtW=ctx.measureText(m.label).width;
      var tX = (px+txtW+10 > ca.right) ? px - txtW - 5 : px + 5;
      var tY = ca.top + 15 + (idx*12 % 36); 
      ctx.fillText(m.label, tX, tY);
    });
    ctx.restore();
  }};

  new Chart(el, {
    type:'line',
    data:{labels:rawLabels.map(fmtL), datasets:datasets},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false,
      interaction:{mode:'index',intersect:false},
      scales:{
        x:{ ticks:{ maxTicksLimit:24, maxRotation:0 } },
        y:{ min:yMin, max:yMax, ticks:{ callback:function(v){return v+unit;} } }
      },
      plugins:{
        legend:{display:false},
        tooltip:{backgroundColor:'#1a1614',titleColor:'#fafafa',bodyColor:'#c0ae9f',borderColor:'#5a5350',borderWidth:1.2,cornerRadius:3,padding:{x:14,y:11},titleFont:{family:'monospace',size:11,weight:'bold'},bodyFont:{family:'monospace',size:11},callbacks:{title:function(items){return L_DATETIME+(rawLabels[items[0].dataIndex]||'');},label:function(ctx){var v=ctx.parsed.y;if(v==null)return null;if(ctx.datasetIndex===0){var expo=periodoExpo&&periodoExpo.length>ctx.dataIndex&&periodoExpo[ctx.dataIndex]===1;var status=(v>=zMin&&v<=zMax)?L_CONFORME:L_FORA;return L_SENSOR+v.toFixed(2)+unit+status+(expo?L_EM_EXPO_TOOLTIP:'');}if(ctx.datasetIndex===1&&terreoData&&terreoData.length)return L_TERREO_REF+v.toFixed(2)+unit;return null;}}}
      }
    },
    plugins: [expoShadingPlugin, customEventPlugin]
  });
}

// Prepara os dados para o gráfico global mensal
var globalLabels = [];
var datasetsGlobal = [];
var colors = ['#E30613', '#2563eb', '#d97706', '#7c3aed', '#059669', '#db2777', '#4b5563'];

DATA.forEach(function(d, idx){
  // 1. Gráficos individuais — mês a mês (splitChartsByMonth) ou período único
  if (d.monthlyCharts && d.monthlyCharts.length) {
    d.monthlyCharts.forEach(function(mc){
      var mTemps = mc.serie.map(function(r){return r?r.temperatura:null;});
      var mHums = mc.serie.map(function(r){return r?r.umidade:null;});
      var mRawLabels = mc.serie.map(function(r){return r?r.data_hora:null;});
      var mTT = mc.terreo?mc.terreo.map(function(r){return r?r.temperatura:null;}):[];
      var mUrT = mc.terreo?mc.terreo.map(function(r){return r?r.umidade:null;}):[];
      mkChart(d.safeId+'_T_'+mc.mesKey,'#c0392b',mTemps,mRawLabels,'°C',d.thresh.tMin,d.thresh.tMax,mTT,mc.ocorrs,mc.periodoExpo,mc.periodoExpoNomes,mc.customMarkers);
      mkChart(d.safeId+'_R_'+mc.mesKey,'#1d4ed8',mHums,mRawLabels,'%',d.thresh.urMin,d.thresh.urMax,mUrT,mc.ocorrs,mc.periodoExpo,mc.periodoExpoNomes,mc.customMarkers);
    });
  } else {
    var temps = d.serie.map(function(r){return r?r.temperatura:null;});
    var hums = d.serie.map(function(r){return r?r.umidade:null;});
    var rawLabels = d.serie.map(function(r){return r?r.data_hora:null;});
    var tT = d.terreo?d.terreo.map(function(r){return r?r.temperatura:null;}):[];
    var urT = d.terreo?d.terreo.map(function(r){return r?r.umidade:null;}):[];
    var pExpo = d.periodoExpo||[];
    var pExpoNomes = d.periodoExpoNomes||[];
    var cMarkers = d.customMarkers||[];

    mkChart(d.safeId+'_T','#c0392b',temps,rawLabels,'°C',d.thresh.tMin,d.thresh.tMax,tT,d.ocorrs,pExpo,pExpoNomes,cMarkers);
    mkChart(d.safeId+'_R','#1d4ed8',hums,rawLabels,'%',d.thresh.urMin,d.thresh.urMax,urT,d.ocorrs,pExpo,pExpoNomes,cMarkers);
  }

  // 2. Acumula dados para o gráfico global mensal
  if (d.monthly && d.monthly.length > 0) {
    var dataPts = d.monthly.map(function(m){ return m.conf; });
    var labels = d.monthly.map(function(m){ return fmtMonth(m.mes); });
    
    if (globalLabels.length === 0) globalLabels = labels;
    
    datasetsGlobal.push({
      label: d.sensor,
      data: dataPts,
      borderColor: colors[idx % colors.length],
      backgroundColor: colors[idx % colors.length],
      borderWidth: 2,
      tension: 0.3,
      pointRadius: 4
    });
  }
});

// Desenha o gráfico global se a página existir
var canvasGlobal = document.getElementById('canvas_global_monthly');
if (canvasGlobal && datasetsGlobal.length > 0) {
  new Chart(canvasGlobal, {
    type: 'line',
    data: { labels: globalLabels, datasets: datasetsGlobal },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { 
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } }
      },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: function(v){ return v+'%'; } } }
      }
    }
  });
}

function fmtMonth(str) {
  if (!str) return '';
  var MN = ${JSON.stringify(lang === 'pt'
    ? ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']
    : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])};
  var p=str.split('-'); return p.length>=2 ? MN[parseInt(p[1])-1] + ' ' + p[0] : str;
}

})();
<\/script>
</body>
</html>`;

  var blob=new Blob([html],{type:'text/html;charset=utf-8'});
  var url=URL.createObjectURL(blob);
  var win=window.open(url,'_blank');
  if(!win){
    var a=document.createElement('a');
    a.href=url;
    a.download=('MASP_Climatizacao_'+dateIni+'_'+dateFim+'_'+normaLabel+'.html').replace(/[^a-z0-9_\-\.]/gi,'_');
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    showToast('Pop-ups bloqueados — relatório baixado como HTML.','warn',8000);
  }
  setTimeout(function(){URL.revokeObjectURL(url);},60000);
}

// ── UPLOAD ────────────────────────────────────────────────
let _csvFile = null;

// Detecta se o CSV é formato testo multi-sensor (colunas pareadas T / %HR por sensor)
function isTestoMultiSensor(lines, delim) {
  // linha 0 começa com "Localidade" e tem muitas colunas
  const firstCols = lines[0].split(delim);
  return firstCols.length >= 4 && /localidade/i.test(firstCols[0].replace(/["\uFEFF]/g, ''));
}

// Parseia CSV testo multi-sensor → array de {data_hora, temperatura, umidade, ponto}
async function parseTestoCSV(text, delim) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const split = l => l.split(delim).map(c => c.trim().replace(/^["']+|["']+$/g, ''));

  // Linha 0: cabeçalho com nomes dos sensores
  // As colunas vêm em pares: [nome °C] [nome %HR]
  const headerCols = split(lines[0]);

  // Extrai nomes dos sensores a partir da linha de cabeçalho
  // Cols 0 e 1 são "Localidade" e vazio (data/hora), depois pares T/%HR
  const sensors = [];
  for (let c = 2; c < headerCols.length - 1; c += 2) {
    const name = headerCols[c]
      .replace(/\s*\[.*?\]/g, '')   // remove [°C] etc
      .trim();
    if (name) sensors.push({ name, colT: c, colHR: c + 1 });
  }

  // Pula as linhas de metadados (linhas 1-7 não são dados)
  const DATA_START = 8; // a partir daqui são linhas dd-mm-yyyy;hh:mm:ss;...
  const rows = [];
  for (let i = DATA_START; i < lines.length; i++) {
    const cols = split(lines[i]);
    if (cols.length < 4) continue;
    const dateStr = parseDateBR(cols[0] + ' ' + cols[1]);
    if (!dateStr) continue;
    for (const s of sensors) {
      const temp = parseFloat((cols[s.colT] || '').replace(',', '.'));
      const hum  = parseFloat((cols[s.colHR] || '').replace(',', '.'));
      if (isNaN(temp) || isNaN(hum)) continue;
      rows.push({ data_hora: dateStr, temperatura: temp, umidade: hum, ponto: s.name });
    }
  }
  return { rows, sensors: sensors.map(s => s.name) };
}

// Detecta o novo formato de exportação Lina (colunas "Nome: Temperatura (°C)" /
// "Nome: Umidade relativa (%)", uma coluna de data/hora ISO única, sem linhas de metadados)
function isLinaSensorFormat(lines, delim) {
  const first = lines[0].replace(/^﻿/, '');
  const cols  = first.split(delim).map(c => c.trim().replace(/^["']+|["']+$/g, ''));
  if (cols.length < 2) return false;
  if (!/america\/sao_paulo|utc\s*-?\d/i.test(cols[0])) return false;
  return cols.slice(1).some(c => /:\s*(temperatura|umidade relativa)\s*\(/i.test(c));
}

// Parseia CSV do novo formato Lina → array de {data_hora, temperatura, umidade, ponto}
// Colunas extras (ponto de orvalho, umidade absoluta, iluminação, UV) são ignoradas —
// só são usados pares "Nome: Temperatura (°C)" / "Nome: Umidade relativa (%)".
async function parseLinaCSV(text, delim) {
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter(l => l.trim());
  const split = l => l.split(delim).map(c => c.trim().replace(/^["']+|["']+$/g, ''));
  const headerCols = split(lines[0]);

  const sensorMap = {};
  headerCols.forEach((h, i) => {
    if (i === 0) return;
    let m = h.match(/^(.+?):\s*Temperatura\s*\(°C\)$/i);
    if (m) {
      const name = m[1].trim();
      if (!sensorMap[name]) sensorMap[name] = {};
      sensorMap[name].colT = i;
      return;
    }
    m = h.match(/^(.+?):\s*Umidade relativa\s*\(%\)$/i);
    if (m) {
      const name = m[1].trim();
      if (!sensorMap[name]) sensorMap[name] = {};
      sensorMap[name].colHR = i;
    }
  });

  const sensors = Object.entries(sensorMap)
    .filter(([, v]) => v.colT !== undefined && v.colHR !== undefined)
    .map(([name, v]) => ({ name, colT: v.colT, colHR: v.colHR }));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = split(lines[i]);
    if (cols.length < 2) continue;
    const dataHora = cols[0]; // já vem como "YYYY-MM-DD HH:MM:SS"
    if (!/^\d{4}-\d{2}-\d{2}/.test(dataHora)) continue;
    for (const s of sensors) {
      const tRaw = cols[s.colT], hRaw = cols[s.colHR];
      if (!tRaw || !hRaw) continue;
      const temp = parseFloat(tRaw.replace(',', '.'));
      const hum  = parseFloat(hRaw.replace(',', '.'));
      if (isNaN(temp) || isNaN(hum)) continue;
      rows.push({ data_hora: dataHora, temperatura: temp, umidade: hum, ponto: s.name });
    }
  }
  return { rows, sensors: sensors.map(s => s.name) };
}

async function handleFilesAPI(files) {
  const csvFiles  = files.filter(f => /\.csv$/i.test(f.name));
  const xlsxFiles = files.filter(f => /\.xlsx$/i.test(f.name));
  const jsonFiles = files.filter(f => /\.json$/i.test(f.name));

  if (csvFiles.length) {
    await processCSVFiles(csvFiles);
    return;
  }

  if (xlsxFiles.length) {
    await processXLSXFiles(xlsxFiles);
    return;
  }

  // JSON normal
  const wrap = document.getElementById('progWrap');
  const fill = document.getElementById('progFill');
  const list = document.getElementById('fileList');
  wrap.classList.remove('hidden');
  list.innerHTML = '';

  let totalImport = 0, totalDup = 0;
  for (let i = 0; i < jsonFiles.length; i++) {
    const f = jsonFiles[i];
    const row = document.createElement('div');
    row.className = 'file-row';
    row.textContent = '⏳ ' + f.name;
    list.appendChild(row);
    try {
      const form = new FormData(); form.append('file', f);
      const res  = await fetch('/api/upload', { method:'POST', body:form });
      const data = await res.json();
      if (data.status === 'ok') {
        row.className   = 'file-row ok';
        row.textContent = `✓ ${f.name} — ${data.importadas.toLocaleString()} importados, ${data.duplicadas} duplicados`;
        totalImport += data.importadas;
        totalDup += data.duplicadas;
        if (data.sensores_novos_lista?.length) openReviewModal(data.sensores_novos_lista);
        if (data.picos_sugeridos?.length) setTimeout(() => openPicosModal(data.picos_sugeridos), 500);
      } else throw new Error(data.erro);
    } catch (e) {
      row.className   = 'file-row err';
      row.textContent = `✗ ${f.name} — ${e.message}`;
    }
    fill.style.width = ((i + 1) / jsonFiles.length * 100) + '%';
  }
  if (totalImport > 0) {
    showToast(`✓ Importação concluída!\n${totalImport.toLocaleString('pt-BR')} medições salvas no banco · ${totalDup} duplicadas ignoradas.`);
  }
  if (typeof _resetTabFlags === 'function') _resetTabFlags();
  await loadAll(getFilters());
}

// ── ANÁLISE DE NÃO-CONFORMIDADES ─────────────────────────
// Deriva de getPadraoConformidade() (api.js) em vez de manter uma 2ª cópia dos mesmos
// números com nomes de campo diferentes (uMin/uMax em vez de urMin/urMax).
function padroesParaAnalise() {
  const out = {};
  ['ibram', 'masp', 'bizot'].forEach(k => {
    const p = getPadraoConformidade(k);
    out[k] = { label: p.label, tMin: p.tMin, tMax: p.tMax, uMin: p.urMin, uMax: p.urMax };
  });
  return out;
}

function analisarNaoConformidades(rows) {
  // Agrupa por sensor
  const porSensor = {};
  for (const r of rows) {
    if (!porSensor[r.ponto]) {
      porSensor[r.ponto] = {
        nome: r.ponto,
        leituras: [],
        tMin: Infinity, tMax: -Infinity,
        uMin: Infinity, uMax: -Infinity,
        dataInicio: r.data_hora,
        dataFim: r.data_hora,
      };
    }
    const s = porSensor[r.ponto];
    s.leituras.push(r);
    if (r.temperatura < s.tMin) s.tMin = r.temperatura;
    if (r.temperatura > s.tMax) s.tMax = r.temperatura;
    if (r.umidade < s.uMin) s.uMin = r.umidade;
    if (r.umidade > s.uMax) s.uMax = r.umidade;
    if (r.data_hora < s.dataInicio) s.dataInicio = r.data_hora;
    if (r.data_hora > s.dataFim)    s.dataFim    = r.data_hora;
  }

  // Para cada sensor, calcula não-conformidades por padrão
  const resultado = [];
  for (const [nome, s] of Object.entries(porSensor)) {
    const total = s.leituras.length;
    const naoConf = {};
    let temProblema = false;

    for (const [key, p] of Object.entries(padroesParaAnalise())) {
      const ncT = s.leituras.filter(r => r.temperatura < p.tMin || r.temperatura > p.tMax).length;
      const ncU = s.leituras.filter(r => r.umidade    < p.uMin || r.umidade    > p.uMax).length;
      const ncTotal = s.leituras.filter(r =>
        (r.temperatura < p.tMin || r.temperatura > p.tMax) ||
        (r.umidade     < p.uMin || r.umidade     > p.uMax)
      ).length;
      const pct = Math.round(ncTotal / total * 100);
      naoConf[key] = { ncT, ncU, ncTotal, pct };
      if (ncTotal > 0) temProblema = true;
    }

    if (temProblema) {
      resultado.push({
        nome,
        total,
        tMin: s.tMin, tMax: s.tMax,
        uMin: s.uMin, uMax: s.uMax,
        dataInicio: s.dataInicio,
        dataFim:    s.dataFim,
        naoConf,
      });
    }
  }

  // Ordena por % não-conforme IBRAM decrescente
  resultado.sort((a, b) => b.naoConf.ibram.pct - a.naoConf.ibram.pct);
  return resultado;
}

// Estado do modal de não-conformidades
let _ncSensores = [];   // lista de sensores do modal
let _ncSensoresDB = []; // lista de sensores do banco (para vincular)

async function openNaoConformidadesModal(analise) {
  _ncSensores = analise;
  // Carrega sensores do banco para preencher prédio automaticamente
  try { _ncSensoresDB = await API.get('admin/sensores'); } catch(_) { _ncSensoresDB = []; }

  const list = document.getElementById('ncList');
  list.innerHTML = analise.map((s, i) => {
    // Tenta encontrar o prédio do sensor no banco
    const sDB = _ncSensoresDB.find(x => x.nome === s.nome || (x.aliases||[]).some(a => a.alias === s.nome));
    const predio = sDB?.predio || 'Lina';

    const rows = Object.entries(padroesParaAnalise()).map(([key, p]) => {
      const nc = s.naoConf[key];
      const cor = nc.pct === 0 ? 'var(--green)' : nc.pct < 20 ? 'var(--amber)' : 'var(--red)';
      return `<td style="text-align:center;font-family:var(--mono);font-size:.75rem;color:${cor};font-weight:600">
        ${nc.pct}%<span style="color:var(--gray-300);font-weight:400"> (${nc.ncTotal})</span>
      </td>`;
    }).join('');

    const dataIni = s.dataInicio.substring(0,16).replace('T',' ');
    const dataFim = s.dataFim.substring(0,16).replace('T',' ');

    return `
    <div class="nc-item" id="ncItem${i}" style="border:1px solid var(--border);border-radius:var(--radius-md);padding:16px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <input type="checkbox" id="ncCheck${i}" checked
          style="width:16px;height:16px;accent-color:var(--red);cursor:pointer"
          onchange="toggleNcItem(${i})">
        <strong style="font-size:.9rem">${escapeHtml(s.nome)}</strong>
        <span class="badge badge-gray" style="font-size:.65rem">${predio}</span>
        <span style="font-family:var(--mono);font-size:.7rem;color:var(--gray-400);margin-left:auto">
          ${dataIni} → ${dataFim}
        </span>
      </div>

      <div style="overflow-x:auto;margin-bottom:12px">
        <table style="width:100%;font-size:.8rem;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:1px solid var(--border)">
              <th style="text-align:left;padding:4px 8px;font-family:var(--mono);font-size:.6rem;color:var(--gray-400)">Padrão</th>
              <th style="text-align:center;padding:4px 8px;font-family:var(--mono);font-size:.6rem;color:var(--gray-400)">% fora</th>
              <th style="text-align:center;padding:4px 8px;font-family:var(--mono);font-size:.6rem;color:var(--gray-400)">T min/máx</th>
              <th style="text-align:center;padding:4px 8px;font-family:var(--mono);font-size:.6rem;color:var(--gray-400)">UR min/máx</th>
            </tr>
          </thead>
          <tbody>
            ${Object.entries(padroesParaAnalise()).map(([key, p]) => {
              const nc = s.naoConf[key];
              const cor = nc.pct === 0 ? 'var(--green)' : nc.pct < 20 ? 'var(--amber)' : 'var(--red)';
              const tCor = (s.tMin < p.tMin || s.tMax > p.tMax) ? 'color:var(--red)' : '';
              const uCor = (s.uMin < p.uMin || s.uMax > p.uMax) ? 'color:var(--red)' : '';
              return `<tr style="border-bottom:1px solid var(--gray-100)">
                <td style="padding:5px 8px;font-family:var(--mono);font-size:.72rem">${p.label} (T:${p.tMin}–${p.tMax}°C / UR:${p.uMin}–${p.uMax}%)</td>
                <td style="text-align:center;padding:5px 8px;font-family:var(--mono);font-weight:600;color:${cor}">${nc.pct}% (${nc.ncTotal}/${s.total})</td>
                <td style="text-align:center;padding:5px 8px;font-family:var(--mono);font-size:.72rem;${tCor}">${s.tMin.toFixed(1)} / ${s.tMax.toFixed(1)}°C</td>
                <td style="text-align:center;padding:5px 8px;font-family:var(--mono);font-size:.72rem;${uCor}">${s.uMin.toFixed(1)} / ${s.uMax.toFixed(1)}%</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div id="ncForm${i}" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="fld">
          <label>Tipo</label>
          <select id="ncTipo${i}">
            <option value="manutencao">Manutenção / Troca de pilha</option>
            <option value="falha_equipamento">Falha de equipamento</option>
            <option value="obra">Obra ou intervenção</option>
            <option value="sensor_deslocado">Sensor deslocado</option>
          </select>
        </div>
        <div class="fld">
          <label>Fonte</label>
          <select id="ncFonte${i}">
            <option value="sistema">Notificação do sistema</option>
            <option value="verbal">Verbal</option>
            <option value="grupo_climatizacao">Grupo de climatização</option>
            <option value="email">E-mail</option>
          </select>
        </div>
        <div class="fld">
          <label>Responsável</label>
          <input type="text" id="ncResp${i}" placeholder="Nome de quem registra">
        </div>
        <div class="fld" style="grid-column:1/-1">
          <label>Descrição *</label>
          <textarea id="ncDesc${i}" rows="2"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius);font-family:var(--sans);font-size:.83rem;resize:vertical"
            placeholder="Explique o motivo dos valores fora do padrão..."></textarea>
        </div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('ncModal').classList.remove('hidden');
}

function toggleNcItem(i) {
  const checked = document.getElementById(`ncCheck${i}`).checked;
  document.getElementById(`ncForm${i}`).style.opacity = checked ? '1' : '0.3';
  document.getElementById(`ncForm${i}`).style.pointerEvents = checked ? '' : 'none';
}

function closeNaoConformidadesModal() {
  document.getElementById('ncModal').classList.add('hidden');
}

async function salvarOcorrenciasNaoConformidade() {
  const btn = document.getElementById('ncSalvarBtn');
  btn.disabled = true;
  btn.textContent = 'Salvando...';

  let salvos = 0, erros = 0;

  for (let i = 0; i < _ncSensores.length; i++) {
    const checked = document.getElementById(`ncCheck${i}`).checked;
    if (!checked) continue;

    const descricao = document.getElementById(`ncDesc${i}`).value.trim();
    if (!descricao) {
      showToast(`⚠ Preencha a descrição para "${_ncSensores[i].nome}".`, 'err');
      btn.disabled = false;
      btn.textContent = 'Salvar Ocorrências';
      return;
    }

    const s    = _ncSensores[i];
    const sDB  = _ncSensoresDB.find(x => x.nome === s.nome || (x.aliases||[]).some(a => a.alias === s.nome));
    const predio = sDB?.predio || 'Lina';

    const body = {
      data_inicio:       s.dataInicio,
      data_fim:          s.dataFim,
      predio,
      tipo:              document.getElementById(`ncTipo${i}`).value,
      fonte:             document.getElementById(`ncFonte${i}`).value,
      descricao,
      responsavel:       document.getElementById(`ncResp${i}`).value.trim() || null,
      afeta_predio_todo: false,
      sensor_ids:        sDB ? [sDB.id] : [],
    };

    try {
      const res = await fetch('/api/admin/ocorrencias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro);
      salvos++;
    } catch (e) {
      erros++;
      console.error(`Erro ao salvar ocorrência para ${s.nome}:`, e);
    }
  }

  btn.disabled = false;
  btn.textContent = 'Salvar Ocorrências';
  closeNaoConformidadesModal();

  if (salvos > 0) {
    showToast(`✓ ${salvos} ocorrência(s) registrada(s) com sucesso.${erros ? ` (${erros} erro(s))` : ''}`, salvos && !erros ? 'ok' : 'err', 6000);
  }
}

// Processa um ou mais arquivos CSV soltos na zona de importação, detectando
// automaticamente o formato de cada um (Lina novo ou testo antigo). Um arquivo
// em formato não reconhecido: se for o único do lote, abre o modal de
// mapeamento manual; se vier junto de outros, é reportado como erro nesse item
// e o restante do lote continua normalmente.
async function processCSVFiles(csvFiles) {
  const wrap = document.getElementById('progWrap');
  const fill = document.getElementById('progFill');
  const list = document.getElementById('fileList');
  wrap.classList.remove('hidden');
  list.innerHTML = '';

  let totalImport = 0, totalDup = 0;
  const allRows = [];
  const allSensoresNovos = [];
  const allPicos = [];

  for (let i = 0; i < csvFiles.length; i++) {
    const file = csvFiles[i];
    const row = document.createElement('div');
    row.className = 'file-row';
    row.textContent = `⏳ ${file.name}`;
    list.appendChild(row);

    try {
      const text  = await file.text();
      const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
      const counts = { ';': 0, ',': 0, '\t': 0 };
      lines[0].split('').forEach(c => { if (counts[c] !== undefined) counts[c]++; });
      const delim = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0];

      let parsed = null, formatLabel = '';
      if (isLinaSensorFormat(lines, delim)) {
        row.textContent = `⏳ ${file.name} — detectado formato Lina, parseando...`;
        parsed = await parseLinaCSV(text, delim);
        formatLabel = 'Lina';
      } else if (isTestoMultiSensor(lines, delim)) {
        row.textContent = `⏳ ${file.name} — detectado formato testo (multi-sensor), parseando...`;
        parsed = await parseTestoCSV(text, delim);
        formatLabel = 'testo';
      } else if (csvFiles.length === 1) {
        list.removeChild(row);
        wrap.classList.add('hidden');
        await openCSVModal(file);
        return;
      } else {
        throw new Error('formato não reconhecido — importe este arquivo individualmente');
      }

      if (!parsed.rows.length) throw new Error('Nenhum dado válido encontrado.');

      row.textContent = `⏳ ${file.name} — ${parsed.rows.length.toLocaleString()} leituras de ${parsed.sensors.length} sensor(es), enviando...`;

      const blob = new Blob([JSON.stringify(parsed.rows)], { type: 'application/json' });
      const formData = new FormData();
      formData.append('file', new File([blob], file.name.replace(/\.csv$/i, '.json')));

      const res  = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.status !== 'ok') throw new Error(data.erro || 'Erro desconhecido');

      row.className   = 'file-row ok';
      row.textContent = `✓ ${file.name} — ${data.importadas.toLocaleString()} medições salvas (${formatLabel}) · ${data.duplicadas} duplicadas ignoradas`;
      totalImport += data.importadas;
      totalDup += data.duplicadas;
      allRows.push(...parsed.rows);
      if (data.sensores_novos_lista?.length) allSensoresNovos.push(...data.sensores_novos_lista);
      if (data.picos_sugeridos?.length) allPicos.push(...data.picos_sugeridos);
    } catch (e) {
      row.className   = 'file-row err';
      row.textContent = `✗ ${file.name} — ${e.message}`;
    }
    fill.style.width = ((i + 1) / csvFiles.length * 100) + '%';
  }

  if (totalImport > 0) {
    showToast(`✓ Importação concluída!\n${totalImport.toLocaleString('pt-BR')} medições salvas no banco · ${totalDup} duplicadas ignoradas.`);
  }
  if (allSensoresNovos.length) openReviewModal(allSensoresNovos);
  if (allPicos.length) setTimeout(() => openPicosModal(allPicos), 500);

  // Analisa não-conformidades no conjunto agregado e abre modal de revisão se houver problemas
  if (allRows.length) {
    const analise = analisarNaoConformidades(allRows);
    if (analise.length > 0) {
      setTimeout(() => openNaoConformidadesModal(analise), 800);
    }
  }

  if (typeof _resetTabFlags === 'function') _resetTabFlags();
  await loadAll(getFilters());
}

// ── XLSX (dataloggers do Pietro) ───────────────────────────
// Formato: "Time stamp" (DD/MM/AAAA HH:MM:SS), "Temperatura Ambiente", "Umidade Ambiente" —
// sem coluna de sensor (cada arquivo cobre um único ponto), então perguntamos qual sensor
// é antes de enviar. O parsing em si (planilha binária) é feito no servidor com openpyxl.

function _slugAndar(s) {
  return (s || '').toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .replace(/[º°]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Tenta casar o nome do arquivo (sem extensão) com um sensor já cadastrado —
// ex.: "2andar.xlsx" -> "2º Andar". Compara contra o nome atual e os aliases (nomes
// antigos) de cada sensor, porque um arquivo pode ter sido nomeado antes de uma renomeação
// (ex.: sensores do Pietro renomeados para incluir o prédio no nome — ver contexto.md §4).
// Sem match de alta confiança, não arrisca: deixa em branco.
function guessSensorFromFilename(filename, pontos) {
  const base = _slugAndar(filename.replace(/\.[^.]+$/, ''));
  if (!base) return null;
  let exato = null, parcial = null;
  for (const p of pontos) {
    const candidatos = [p.nome, ...(p.aliases || [])];
    for (const nome of candidatos) {
      const slug = _slugAndar(nome);
      if (!slug) continue;
      if (slug === base) { exato = p.nome; break; }
      if (!parcial && (base.includes(slug) || slug.includes(base))) parcial = p.nome;
    }
    if (exato) break;
  }
  return exato || parcial;
}

let _xlsxModalResolve = null;

function openXLSXSensorModal(file, sensorNames, guess) {
  document.getElementById('xlsxSensorSub').textContent =
    `Arquivo "${file.name}" — selecione a qual ponto de medição estes dados pertencem.`;
  const sel = document.getElementById('xlsxSensorSelect');
  sel.innerHTML = '<option value="">— selecione —</option>' +
    sensorNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  sel.value = guess || '';
  document.getElementById('xlsxSensorModal').classList.remove('hidden');
  return new Promise(resolve => { _xlsxModalResolve = resolve; });
}

function resolveXLSXSensorModal(sensorNome) {
  document.getElementById('xlsxSensorModal').classList.add('hidden');
  if (_xlsxModalResolve) { _xlsxModalResolve(sensorNome || null); _xlsxModalResolve = null; }
}

async function processXLSXFiles(xlsxFiles) {
  const wrap = document.getElementById('progWrap');
  const fill = document.getElementById('progFill');
  const list = document.getElementById('fileList');
  wrap.classList.remove('hidden');
  list.innerHTML = '';

  let meta;
  try { meta = await API.get('meta'); } catch (e) { meta = { pontos: [] }; }
  const sensorNames = (meta.pontos || []).filter(p => p?.nome).map(p => p.nome);

  let totalImport = 0, totalDup = 0;
  const allSensoresNovos = [];
  const allPicos = [];

  for (let i = 0; i < xlsxFiles.length; i++) {
    const file = xlsxFiles[i];
    const row = document.createElement('div');
    row.className = 'file-row';
    row.textContent = `⏳ ${file.name} — selecione o sensor...`;
    list.appendChild(row);

    try {
      const guess = guessSensorFromFilename(file.name, meta.pontos || []);
      const sensor = await openXLSXSensorModal(file, sensorNames, guess);
      if (!sensor) {
        row.className = 'file-row';
        row.textContent = `– ${file.name} — pulado`;
        fill.style.width = ((i + 1) / xlsxFiles.length * 100) + '%';
        continue;
      }

      row.textContent = `⏳ ${file.name} — enviando dados de "${sensor}"...`;
      const formData = new FormData();
      formData.append('file', file);
      formData.append('sensor', sensor);

      const res  = await fetch('/api/upload_xlsx', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.status !== 'ok') throw new Error(data.erro || 'Erro desconhecido');

      row.className   = 'file-row ok';
      row.textContent = `✓ ${file.name} — ${data.importadas.toLocaleString()} medições salvas em "${sensor}" · ${data.duplicadas} duplicadas ignoradas`;
      totalImport += data.importadas;
      totalDup += data.duplicadas;
      if (data.sensores_novos_lista?.length) allSensoresNovos.push(...data.sensores_novos_lista);
      if (data.picos_sugeridos?.length) allPicos.push(...data.picos_sugeridos);
    } catch (e) {
      row.className   = 'file-row err';
      row.textContent = `✗ ${file.name} — ${e.message}`;
    }
    fill.style.width = ((i + 1) / xlsxFiles.length * 100) + '%';
  }

  if (totalImport > 0) {
    showToast(`✓ Importação concluída!\n${totalImport.toLocaleString('pt-BR')} medições salvas no banco · ${totalDup} duplicadas ignoradas.`);
  }
  if (allSensoresNovos.length) openReviewModal(allSensoresNovos);
  if (allPicos.length) setTimeout(() => openPicosModal(allPicos), 500);

  if (typeof _resetTabFlags === 'function') _resetTabFlags();
  await loadAll(getFilters());
}

// ── CSV MODAL ─────────────────────────────────────────────
async function openCSVModal(file) {
  _csvFile = file;
  const text  = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 5);

  // Detecta delimitador
  const counts = { ';': 0, ',': 0, '\t': 0 };
  lines[0].split('').forEach(c => { if (counts[c] !== undefined) counts[c]++; });
  const delim = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0];
  document.getElementById('csvDelim').value = delim;

  document.getElementById('csvPreview').textContent = lines.slice(0,3).join('\n');
  _fillCSVSelects(lines[0].split(delim).map(h => h.trim().replace(/^["']+|["']+$/g,'')));
  document.getElementById('csvModal').classList.remove('hidden');
}

function _fillCSVSelects(headers) {
  const selects = ['csvColDate','csvColTemp','csvColHum','csvColPonto'];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    sel.innerHTML = '<option value="">— Não usar —</option>';
    headers.forEach((h, i) => {
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = `[${i}] ${h}`;
      const hl = h.toLowerCase();
      if (id==='csvColDate' && (hl.includes('data')||hl.includes('date')||hl.includes('time')||hl.includes('hora'))) opt.selected=true;
      if (id==='csvColTemp' && (hl.includes('temp')||hl.includes('°c')||hl.includes('ch1')))  opt.selected=true;
      if (id==='csvColHum'  && (hl.includes('umid')||hl.includes('humid')||hl.match(/\brh\b/)||hl.includes('rf')||hl.includes('ch2'))) opt.selected=true;
      if (id==='csvColPonto'&& (hl.includes('ponto')||hl.includes('sensor')||hl.includes('local'))) opt.selected=true;
      sel.appendChild(opt);
    });
  });
}

function reloadCSVHeaders() {
  if (_csvFile) openCSVModal(_csvFile);
}

function closeCSVModal() {
  document.getElementById('csvModal').classList.add('hidden');
  _csvFile = null;
}

// Converte data br dd/mm/yyyy hh:mm:ss → ISO
function parseDateBR(str) {
  if (!str) return null;
  const br = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})[T\s]?(\d{2}:\d{2}(?::\d{2})?)?/);
  if (br) return `${br[3]}-${br[2].padStart(2,'0')}-${br[1].padStart(2,'0')}${br[4]?' '+br[4]:''}`;
  return str; // já ISO
}

async function processCSV() {
  if (!_csvFile) return;
  const colDate  = document.getElementById('csvColDate').value;
  const colTemp  = document.getElementById('csvColTemp').value;
  const colHum   = document.getElementById('csvColHum').value;
  const colPonto = document.getElementById('csvColPonto').value;
  const sensorName = document.getElementById('csvSensorName').value.trim();

  if (colDate===''||colTemp===''||colHum==='') {
    alert('Selecione ao menos as colunas de data/hora, temperatura e umidade.'); return;
  }

  const delim = document.getElementById('csvDelim').value;
  const text  = await _csvFile.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const rows  = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim).map(c => c.trim().replace(/^["']+|["']+$/g,''));
    const temp = parseFloat(cols[+colTemp]?.replace(',','.'));
    const hum  = parseFloat(cols[+colHum]?.replace(',','.'));
    if (isNaN(temp) || isNaN(hum)) continue;
    rows.push({
      data_hora:  parseDateBR(cols[+colDate]) || null,
      temperatura: temp,
      umidade:     hum,
      ponto: sensorName || (colPonto!=='' ? cols[+colPonto] : null) || 'Importado',
    });
  }

  if (!rows.length) { alert('Nenhum dado válido. Verifique o mapeamento das colunas.'); return; }
  closeCSVModal();

  const blob = new Blob([JSON.stringify(rows)], { type:'application/json' });
  const formData = new FormData();
  formData.append('file', new File([blob], _csvFile.name.replace(/\.\w+$/,'.json')));

  const wrap = document.getElementById('progWrap');
  const list = document.getElementById('fileList');
  wrap.classList.remove('hidden');
  const row = document.createElement('div');
  row.className = 'file-row';
  row.textContent = `⏳ ${_csvFile.name} — ${rows.length.toLocaleString()} linhas...`;
  list.appendChild(row);

  try {
    const res  = await fetch('/api/upload', { method:'POST', body:formData });
    const data = await res.json();
    if (data.status === 'ok') {
      row.className   = 'file-row ok';
      row.textContent = `✓ ${_csvFile.name} — ${data.importadas.toLocaleString()} importados, ${data.duplicadas} duplicados`;
      showToast(`✓ Importação concluída!\n${data.importadas.toLocaleString('pt-BR')} medições salvas no banco.\n${data.duplicadas} duplicadas ignoradas.`);
      if (data.sensores_novos_lista?.length) openReviewModal(data.sensores_novos_lista);
      if (data.picos_sugeridos?.length) setTimeout(() => openPicosModal(data.picos_sugeridos), 500);
    } else throw new Error(data.erro);
  } catch (e) {
    row.className   = 'file-row err';
    row.textContent = `✗ ${_csvFile.name} — ${e.message}`;
    showToast(`✗ Erro: ${e.message}`, 'err');
  }

  if (typeof _resetTabFlags === 'function') _resetTabFlags();
  await loadAll(getFilters());
}

// Event listener do input de arquivo
document.getElementById('fileIn')?.addEventListener('change', e => {
  if (e.target.files.length) handleFilesAPI([...e.target.files]);
  e.target.value = ''; // permite re-selecionar o mesmo arquivo
});

// ── ABA OCORRÊNCIAS ───────────────────────────────────────

let _ocorrenciasTodas = [];  // cache completo para filtro local

async function loadOcorrenciasTab(filters = {}) {
  try {
    const f = Object.keys(filters).length ? filters : (window._lastFilters || {});
    _ocorrenciasTodas = await API.get('ocorrencias', {
      data_ini: f.data_ini || '',
      data_fim: f.data_fim || '',
    });
    renderOcorrenciasTab();
  } catch(e) { console.warn('loadOcorrenciasTab:', e); }
}

function filtrarOcorrencias() {
  renderOcorrenciasTab();
}

function renderOcorrenciasTab() {
  const wrap = document.getElementById('ocorrListaWrap');
  const info = document.getElementById('ocorrContagemInfo');
  if (!wrap) return;

  const tipoAtivo   = document.querySelector('#segOcorrTipo .seg-btn.active')?.dataset.tipo   || '';
  const predioAtivo = document.querySelector('#segOcorrPredi .seg-btn.active')?.dataset.predio || '';

  const filtradas = _ocorrenciasTodas.filter(o => {
    if (tipoAtivo   && o.tipo   !== tipoAtivo)   return false;
    if (predioAtivo && o.predio !== predioAtivo && o.predio !== 'Ambos') return false;
    return true;
  });

  if (info) {
    const total  = _ocorrenciasTodas.length;
    const autos  = _ocorrenciasTodas.filter(o => o.tipo === 'pico_automatico').length;
    info.textContent = `${filtradas.length} ocorrência${filtradas.length !== 1 ? 's' : ''}` +
      (filtradas.length < total ? ` de ${total}` : '') +
      (autos ? ` · ${autos} detectada${autos !== 1 ? 's' : ''} automaticamente` : '');
  }

  if (!filtradas.length) {
    wrap.innerHTML = `<div style="font-family:var(--mono);font-size:.75rem;color:var(--gray-400);
      padding:32px;text-align:center;letter-spacing:1px">
      NENHUMA OCORRÊNCIA ENCONTRADA PARA OS FILTROS SELECIONADOS</div>`;
    return;
  }

  const TIPO_LABEL = {
    manutencao:        'Manutenção / Calibração',
    falha_equipamento: 'Falha de equipamento',
    obra:              'Obra / Intervenção',
    sensor_deslocado:  'Sensor deslocado',
    pico_automatico:   'Pico detectado automaticamente',
  };
  const TIPO_COR = {
    manutencao:        '#d97706',
    falha_equipamento: '#E30613',
    obra:              '#7c3aed',
    sensor_deslocado:  '#0284c7',
    pico_automatico:   '#dc2626',
  };
  const TIPO_BG = {
    manutencao:        'rgba(217,119,6,.08)',
    falha_equipamento: 'rgba(220,38,38,.06)',
    obra:              'rgba(124,58,237,.06)',
    sensor_deslocado:  'rgba(2,132,199,.06)',
    pico_automatico:   'rgba(220,38,38,.06)',
  };

  wrap.innerHTML = filtradas.map(o => {
    const cor      = TIPO_COR[o.tipo]   || '#8c8278';
    const bg       = TIPO_BG[o.tipo]    || 'rgba(0,0,0,.03)';
    const label    = TIPO_LABEL[o.tipo] || o.tipo;
    const auto     = o.tipo === 'pico_automatico';
    const dataIni  = (o.data_inicio || '').substring(0, 16).replace('T', ' ');
    const dataFim  = o.data_fim ? (o.data_fim).substring(0, 16).replace('T', ' ') : null;
    const sensores = (o.sensores || []).map(s => escapeHtml(s.nome)).join(' · ');

    return `<div style="border-left:3px solid ${cor};background:${bg};
        border-radius:0 var(--radius) var(--radius) 0;
        padding:14px 16px;margin-bottom:8px">
      <div style="display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:5px">
            <span style="font-family:var(--mono);font-size:.7rem;font-weight:700;
              color:${cor};letter-spacing:.5px;text-transform:uppercase">${label}</span>
            ${auto ? `<span style="font-family:var(--mono);font-size:.65rem;
              background:rgba(220,38,38,.12);color:#dc2626;padding:1px 6px;
              border-radius:var(--radius)">⚡ automático</span>` : ''}
            <span style="font-family:var(--mono);font-size:.7rem;color:var(--gray-400)">
              ${escapeHtml(o.predio || '')}
            </span>
            <span style="font-family:var(--mono);font-size:.72rem;color:var(--gray-600)">
              📅 ${dataIni}${dataFim && dataFim !== dataIni ? ' → ' + dataFim : ''}
            </span>
            ${o.responsavel ? `<span style="font-family:var(--mono);font-size:.68rem;
              color:var(--gray-400);margin-left:auto">👤 ${escapeHtml(o.responsavel)}</span>` : ''}
          </div>
          <div style="font-size:.84rem;color:var(--black);line-height:1.55;margin-bottom:5px">
            ${escapeHtml(o.descricao || '')}
          </div>
          ${sensores ? `<div style="font-family:var(--mono);font-size:.68rem;
            color:var(--gray-400);margin-top:4px">
            📍 ${sensores}
          </div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;align-self:flex-start">
          <button class="action-btn" onclick='openOcorrenciaModal(${JSON.stringify(o)})'>Editar</button>
          <button class="action-btn del" onclick="confirmDeleteOcorrenciaTab(${o.id})">Excluir</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function confirmDeleteOcorrenciaTab(id) {
  document.getElementById('deleteModalMsg').innerHTML =
    `Excluir ocorrência <strong>#${id}</strong>? Esta ação é irreversível.`;
  _deleteFn = async () => {
    try {
      const res  = await fetch(`/api/admin/ocorrencias/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro || res.statusText);
      closeDeleteModal();
      showToast('✓ Ocorrência excluída.');
      // Recarrega ambas as views
      window._tabLoaded.ocorrencias = false;
      await loadOcorrenciasTab();
      window._tabLoaded.ocorrencias = true;
    } catch(e) { showToast('✗ Erro: ' + e.message, 'err'); }
  };
  document.getElementById('deleteConfirmBtn').onclick = _deleteFn;
  document.getElementById('deleteModal').classList.remove('hidden');
}

let _gerenciarLoaded = false;
async function loadGerenciar(force = false) {
  if (_gerenciarLoaded && !force) return;
  _gerenciarLoaded = true;
  try {
    await Promise.all([loadSensoresAdmin(), loadExposAdmin(), loadImportAdmin()]);
  } catch(e) {
    console.warn('loadGerenciar:', e);
    showToast('⚠ Erro ao carregar dados de gerenciamento: ' + e.message, 'err');
    _gerenciarLoaded = false;
  }
}

// ── SENSORES CRUD ─────────────────────────────────────────
async function loadSensoresAdmin() {
  const rows = await API.get('admin/sensores');
  const tb = document.getElementById('tSensoresAdmin');
  if (!tb) return;
  tb.innerHTML = rows.map(s => {
    const aliasChips = (s.aliases || []).length
      ? (s.aliases || []).map(a => `<span class="alias-chip">${escapeHtml(a.alias)}</span>`).join('')
      : '<span style="color:var(--gray-400);font-size:.75rem">–</span>';
    const aliasData = encodeURIComponent(JSON.stringify(s.aliases || []));
    return `
    <tr>
      <td><span style="font-family:var(--mono);color:var(--gray-300)">${s.id}</span></td>
      <td><strong>${escapeHtml(s.nome)}</strong></td>
      <td><span style="font-size:.8rem">${escapeHtml(s.predio) || 'Lina'}</span></td>
      <td>${s.andar || '–'}</td>
      <td><span class="badge ${s.ativo ? 'badge-green' : 'badge-gray'}">${s.ativo ? 'Ativo' : 'Inativo'}</span></td>
      <td><span class="badge ${(s.espaco_expositivo ?? 1) ? 'badge-green' : 'badge-gray'}">${(s.espaco_expositivo ?? 1) ? 'Sim' : 'Não'}</span></td>
      <td><span class="badge ${(s.padrao_hibrido || 'bizot') === 'masp' ? 'badge-green' : 'badge-gray'}">${(s.padrao_hibrido || 'bizot') === 'masp' ? 'MASP' : 'Bizot'}</span></td>
      <td>${aliasChips}</td>
      <td style="white-space:nowrap">
        <button class="action-btn" onclick='openSensorModal(${JSON.stringify(s)})'>Editar</button>
        <button class="action-btn" onclick='openAliasModal(${s.id}, ${JSON.stringify(escapeHtml(s.nome))}, decodeURIComponent("${aliasData}"))'>Aliases</button>
        <button class="action-btn del" onclick="confirmDelete('sensor',${s.id},'Excluir sensor <strong>${escapeHtml(s.nome)}</strong>? Esta ação é irreversível e não apaga as medições associadas.')">Excluir</button>
      </td>
    </tr>`;
  }).join('');
}

function openSensorModal(sensor) {
  const editing = sensor && sensor.id;
  document.getElementById('sensorModalTitle').textContent = editing ? 'EDITAR SENSOR' : 'NOVO SENSOR';
  document.getElementById('sensorId').value        = editing ? sensor.id : '';
  document.getElementById('sNome').value           = editing ? sensor.nome : '';
  document.getElementById('sLocalizacao').value    = editing ? (sensor.localizacao || '') : '';
  document.getElementById('sAndar').value          = editing ? (sensor.andar || '') : '';
  document.getElementById('sPredi').value          = editing ? (sensor.predio || 'Lina') : 'Lina';
  document.getElementById('sInstalacao').value     = editing ? (sensor.data_instalacao || '') : '';
  document.getElementById('sDescricao').value      = editing ? (sensor.descricao || '') : '';
  document.getElementById('sAtivo').value          = editing ? String(sensor.ativo) : '1';
  document.getElementById('sEspacoExpositivo').value = editing ? String(sensor.espaco_expositivo ?? 1) : '1';
  document.getElementById('sPadraoHibrido').value  = editing ? (sensor.padrao_hibrido || 'bizot') : 'bizot';
  document.getElementById('sensorModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('sNome').focus(), 50);
}

function closeSensorModal() {
  document.getElementById('sensorModal').classList.add('hidden');
}

async function saveSensor() {
  const id   = document.getElementById('sensorId').value;
  const nome = document.getElementById('sNome').value.trim();
  if (!nome) { showToast('O nome do sensor é obrigatório.', 'err'); return; }

  const body = {
    nome,
    localizacao:      document.getElementById('sLocalizacao').value.trim() || null,
    andar:            document.getElementById('sAndar').value.trim() || null,
    predio:           document.getElementById('sPredi').value || 'Lina',
    data_instalacao:  document.getElementById('sInstalacao').value || null,
    descricao:        document.getElementById('sDescricao').value.trim() || null,
    ativo:            parseInt(document.getElementById('sAtivo').value),
    espaco_expositivo: parseInt(document.getElementById('sEspacoExpositivo').value),
    padrao_hibrido:    document.getElementById('sPadraoHibrido').value,
  };

  try {
    const url    = id ? `/api/admin/sensores/${id}` : '/api/admin/sensores';
    const method = id ? 'PUT' : 'POST';
    const res    = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data   = await res.json();
    if (!res.ok) throw new Error(data.erro || res.statusText);
    closeSensorModal();
    showToast(id ? '✓ Sensor atualizado com sucesso.' : `✓ Sensor "${nome}" cadastrado.`);
    _gerenciarLoaded = false;
    try { await Promise.all([loadSensoresAdmin(), populateFilters()]); }
    finally { _gerenciarLoaded = true; }
  } catch (e) {
    showToast('✗ Erro: ' + e.message, 'err');
  }
}


// ── ALIASES CRUD ──────────────────────────────────────────
let _aliasCurrentSensorId   = null;

async function openAliasModal(sid, nome, aliasesJson) {
  _aliasCurrentSensorId = sid;
  document.getElementById('aliasModalSub').textContent =
    `Nomes alternativos reconhecidos no upload para: ${nome}`;
  document.getElementById('aliasNewInput').value = '';

  // aliasesJson pode vir como string URL-encoded ou array
  let aliases = [];
  try {
    aliases = typeof aliasesJson === 'string' ? JSON.parse(aliasesJson) : aliasesJson;
  } catch (_) {}

  renderAliasList(aliases);
  document.getElementById('aliasModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('aliasNewInput').focus(), 50);
}

function renderAliasList(aliases) {
  const el = document.getElementById('aliasCurrentList');
  if (!aliases.length) {
    el.innerHTML = '<span style="font-size:.8rem;color:var(--gray-400)">Nenhum alias cadastrado.</span>';
    return;
  }
  el.innerHTML = aliases.map(a => `
    <div class="alias-row" id="alias-row-${a.id}">
      <span>${escapeHtml(a.alias)}</span>
      <button class="alias-del" title="Remover alias" onclick="deleteAlias(${a.id})">✕</button>
    </div>`).join('');
}

async function addAlias() {
  const input = document.getElementById('aliasNewInput');
  const alias = input.value.trim();
  if (!alias) return;
  if (!_aliasCurrentSensorId) return;

  try {
    const res  = await fetch(`/api/admin/sensores/${_aliasCurrentSensorId}/aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erro || res.statusText);

    input.value = '';
    showToast(`✓ Alias "${alias}" adicionado.`);

    // Recarrega lista fresca do servidor
    const aliases = await API.get(`admin/sensores/${_aliasCurrentSensorId}/aliases`);
    renderAliasList(aliases);
    loadSensoresAdmin(); // atualiza chips na tabela em background
  } catch (e) {
    showToast('✗ Erro: ' + e.message, 'err');
  }
}

async function deleteAlias(aid) {
  try {
    const res  = await fetch(`/api/admin/aliases/${aid}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erro || res.statusText);

    document.getElementById(`alias-row-${aid}`)?.remove();
    const remaining = document.querySelectorAll('#aliasCurrentList .alias-row').length;
    if (!remaining) renderAliasList([]);
    loadSensoresAdmin();
  } catch (e) {
    showToast('✗ Erro ao remover alias: ' + e.message, 'err');
  }
}

function closeAliasModal() {
  document.getElementById('aliasModal').classList.add('hidden');
  _aliasCurrentSensorId = null;
}

// ── EXPOSIÇÕES CRUD ───────────────────────────────────────
async function loadExposAdmin() {
  const rows = await API.get('admin/exposicoes');
  const tb = document.getElementById('tExposAdmin');
  if (!tb) return;
  tb.innerHTML = rows.map(e => `
    <tr>
      <td><span style="font-family:var(--mono);color:var(--gray-300)">${e.id}</span></td>
      <td style="font-family:var(--mono)">${e.ano}</td>
      <td><span class="badge ${e.predio === 'Pietro' ? 'badge-blue' : 'badge-gray'}">${escapeHtml(e.predio || 'Lina')}</span></td>
      <td><strong>${escapeHtml(e.nome)}</strong></td>
      <td style="font-family:var(--mono);font-size:.76rem">${e.inicio_preparacao || '–'}</td>
      <td style="font-family:var(--mono);font-size:.76rem">${e.inicio}</td>
      <td style="font-family:var(--mono);font-size:.76rem">${e.termino}</td>
      <td style="font-family:var(--mono);font-size:.76rem">${e.termino_desmontagem || '–'}</td>
      <td style="font-size:.78rem;max-width:160px;white-space:normal">${escapeHtml(e.espacos) || '–'}</td>
      <td style="white-space:nowrap">
        <button class="action-btn" onclick='openExpoModal(${JSON.stringify(e)})'>Editar</button>
        <button class="action-btn del" onclick="confirmDelete('exposicao',${e.id},'Excluir exposição &lt;strong&gt;${e.nome}&lt;/strong&gt; (${e.ano})? Esta ação é irreversível.')">Excluir</button>
      </td>
    </tr>`).join('');
}

function openExpoModal(expo) {
  const editing = expo && expo.id;
  document.getElementById('expoModalTitle').textContent = editing ? 'EDITAR EXPOSIÇÃO' : 'NOVA EXPOSIÇÃO';
  document.getElementById('expoId').value      = editing ? expo.id : '';
  document.getElementById('eNome').value       = editing ? expo.nome : '';
  document.getElementById('eAno').value        = editing ? expo.ano : new Date().getFullYear();
  document.getElementById('ePredio').value     = editing ? (expo.predio || 'Lina') : 'Lina';
  document.getElementById('eEspacos').value    = editing ? (expo.espacos || '') : '';
  document.getElementById('eIniPrep').value    = editing ? (expo.inicio_preparacao || '') : '';
  document.getElementById('eInicio').value     = editing ? expo.inicio : '';
  document.getElementById('eTermino').value    = editing ? expo.termino : '';
  document.getElementById('eDesmontagem').value= editing ? (expo.termino_desmontagem || '') : '';
  document.getElementById('expoModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('eNome').focus(), 50);
}

function closeExpoModal() {
  document.getElementById('expoModal').classList.add('hidden');
}

async function saveExpo() {
  const id     = document.getElementById('expoId').value;
  const nome   = document.getElementById('eNome').value.trim();
  const ano    = document.getElementById('eAno').value;
  const inicio = document.getElementById('eInicio').value;
  const termino= document.getElementById('eTermino').value;
  if (!nome || !ano || !inicio || !termino) {
    showToast('Nome, ano, abertura e fechamento são obrigatórios.', 'err'); return;
  }
  const body = {
    nome,
    ano: parseInt(ano),
    predio:              document.getElementById('ePredio').value || 'Lina',
    inicio_preparacao:   document.getElementById('eIniPrep').value || null,
    inicio,
    termino,
    termino_desmontagem: document.getElementById('eDesmontagem').value || null,
    espacos:             document.getElementById('eEspacos').value.trim() || null,
  };
  try {
    const url    = id ? `/api/admin/exposicoes/${id}` : '/api/admin/exposicoes';
    const method = id ? 'PUT' : 'POST';
    const res    = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data   = await res.json();
    if (!res.ok) throw new Error(data.erro || res.statusText);
    closeExpoModal();
    showToast(id ? '✓ Exposição atualizada.' : `✓ Exposição "${nome}" cadastrada.`);
    _gerenciarLoaded = false;
    try { await Promise.all([loadExposAdmin(), loadExposicoes()]); }
    finally { _gerenciarLoaded = true; }
  } catch (e) {
    showToast('✗ Erro: ' + e.message, 'err');
  }
}

// ── IMPORTAÇÕES (somente leitura) ─────────────────────────
async function recalcularPeriodoExpositivo() {
  if (!confirm('Recalcular o ${tx.period} expositivo de TODAS as medições?\n\nIsso cruza cada medição com as exposições cadastradas e atualiza o campo.\nPode demorar alguns segundos em bancos grandes.')) return;

  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ Recalculando...';

  try {
    const res  = await fetch('/api/admin/recalcular_periodo', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erro || res.statusText);

    showToast(
      `✓ Recálculo concluído!\n${data.marcadas_expositivo.toLocaleString('pt-BR')} medições expositivas\n${data.fora_expositivo.toLocaleString('pt-BR')} fora de exposição\n(${data.exposicoes_usadas} exposições · ${data.sensores_processados} sensores)`,
      'ok', 8000
    );
    // Invalida cache e recarrega aba ativa
    if (typeof _resetTabFlags === 'function') _resetTabFlags();
    await loadAll(getFilters());
  } catch(e) {
    showToast('✗ Erro: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '↺ Recalcular ${tx.period} Expositivo';
  }
}

async function loadImportAdmin() {
  const rows = await API.get('admin/importacoes');
  const tb = document.getElementById('tImportAdmin');
  if (!tb) return;
  tb.innerHTML = rows.map(r => `
    <tr>
      <td><span style="font-family:var(--mono);color:var(--gray-300)">${r.id}</span></td>
      <td style="font-family:var(--mono);font-size:.76rem;max-width:200px;white-space:normal;word-break:break-all">${escapeHtml(r.arquivo_nome)}</td>
      <td style="font-family:var(--mono);font-size:.76rem;white-space:nowrap">${(r.data_importacao||'').substring(0,16)}</td>
      <td style="text-align:right">${(r.total_medicoes||0).toLocaleString('pt-BR')}</td>
      <td style="text-align:right;color:var(--green);font-weight:600">${(r.medicoes_importadas||0).toLocaleString('pt-BR')}</td>
      <td style="text-align:right;color:var(--gray-500)">${(r.medicoes_duplicadas||0).toLocaleString('pt-BR')}</td>
      <td style="font-family:var(--mono);font-size:.72rem">${r.periodo_inicio ? r.periodo_inicio.substring(0,10) : '–'} → ${r.periodo_fim ? r.periodo_fim.substring(0,10) : '–'}</td>
      <td><span class="badge ${r.status === 'SUCESSO' ? 'badge-green' : 'badge-red'}">${r.status || '–'}</span></td>
      <td style="font-size:.76rem;max-width:200px;white-space:normal;color:var(--gray-500)">${escapeHtml(r.observacoes) || '–'}</td>
    </tr>`).join('');
}

// ── OCORRÊNCIAS ADMIN ────────────────────────────────────

// Constantes de tipo compartilhadas entre a aba Ocorrências e o painel Admin
const OCORR_TIPO_LABELS = {
  manutencao:        'Manutenção / Calibração',
  falha_equipamento: 'Falha de equipamento',
  obra:              'Obra / Intervenção',
  sensor_deslocado:  'Sensor deslocado',
  pico_automatico:   'Pico detectado automaticamente',
};
const OCORR_TIPO_BADGE = {
  manutencao:        'badge-manutencao',
  falha_equipamento: 'badge-falha',
  obra:              'badge-obra',
  sensor_deslocado:  'badge-deslocado',
  pico_automatico:   'badge-red',
};

const OCORR_FONTE_LABELS = {
  verbal:              'Verbal',
  sistema:             'Sistema',
  grupo_climatizacao:  'Grupo de climatização',
  email:               'E-mail',
};


function openOcorrenciaModal(ocorrencia) {
  const editing = ocorrencia && ocorrencia.id;
  document.getElementById('ocorrenciaModalTitle').textContent =
    editing ? 'EDITAR OCORRÊNCIA' : 'NOVA OCORRÊNCIA';
  document.getElementById('ocorrenciaId').value     = editing ? ocorrencia.id : '';
  document.getElementById('oDataInicio').value      = editing ? (ocorrencia.data_inicio || '').substring(0, 16) : '';
  document.getElementById('oDataFim').value         = editing ? (ocorrencia.data_fim    || '').substring(0, 16) : '';
  document.getElementById('oPredi').value           = editing ? (ocorrencia.predio || 'Lina') : 'Lina';
  document.getElementById('oTipo').value            = editing ? (ocorrencia.tipo || 'manutencao') : 'manutencao';
  document.getElementById('oFonte').value           = editing ? (ocorrencia.fonte || 'verbal') : 'verbal';
  document.getElementById('oResponsavel').value     = editing ? (ocorrencia.responsavel || '') : '';
  document.getElementById('oDescricao').value       = editing ? (ocorrencia.descricao || '') : '';
  document.getElementById('oAfetaTodo').checked     = editing ? !!ocorrencia.afeta_predio_todo : false;

  // Guarda sensor_ids pré-selecionados para usar após renderizar os chips
  window._ocorrSensoresPreSel = editing ? (ocorrencia.sensores || []).map(s => s.id) : [];

  toggleSensoresOcorrencia();
  updateOcorrenciaSensores();

  document.getElementById('ocorrenciaModal').classList.remove('hidden');
}

function closeOcorrenciaModal() {
  document.getElementById('ocorrenciaModal').classList.add('hidden');
}

function toggleSensoresOcorrencia() {
  const afeta = document.getElementById('oAfetaTodo').checked;
  const wrap  = document.getElementById('oSensoresWrap');
  if (wrap) wrap.style.display = afeta ? 'none' : '';
}

let _adminSensoresCache = [];

async function updateOcorrenciaSensores() {
  const predio = document.getElementById('oPredi').value;
  const chips  = document.getElementById('oSensoresChips');
  if (!chips) return;

  chips.innerHTML = `<span style="font-family:var(--mono);font-size:.72rem;color:var(--gray-300)">Carregando sensores...</span>`;

  if (!_adminSensoresCache.length) {
    try { _adminSensoresCache = await API.get('admin/sensores'); } catch (e) {}
  }

  const sensores = _adminSensoresCache.filter(p => !predio || predio === 'Ambos' || p.predio === predio || !p.predio);

  if (!sensores.length) {
    chips.innerHTML = `<span style="font-family:var(--mono);font-size:.72rem;color:var(--gray-300)">Nenhum sensor encontrado para este prédio.</span>`;
    return;
  }

  const preSel = window._ocorrSensoresPreSel || [];

  // Chip visual: o input fica escondido. Quando clicado, pinta o botão de vermelho!
  const checkboxesHTML = sensores.map(p => {
    const sid     = p.id;
    const nome    = p.nome || '';
    const isChecked = preSel.includes(sid);
    const checkedAttr = isChecked ? 'checked' : '';
    const activeClass = isChecked ? 'active' : '';

    return `
      <label class="ocorr-chip ${activeClass}">
        <input type="checkbox" value="${sid}" ${checkedAttr} style="display:none" onchange="this.parentElement.classList.toggle('active', this.checked)">
        ${escapeHtml(nome)}
      </label>
    `;
  }).join('');

  // Removemos os botões "Marcar Todos" redundantes e injetamos apenas os chips
  chips.innerHTML = `<div style="display:flex; flex-wrap:wrap; gap:8px; padding-top:4px;">${checkboxesHTML}</div>`;
}

async function saveOcorrencia() {
  const id         = document.getElementById('ocorrenciaId').value;
  const afetaTodo  = document.getElementById('oAfetaTodo').checked;

  // Coleta sensor_ids marcados
  const sensorIds = afetaTodo ? [] :
    [...document.querySelectorAll('#oSensoresChips input[type=checkbox]:checked')]
      .map(cb => parseInt(cb.value));

  const payload = {
    data_inicio:      document.getElementById('oDataInicio').value,
    data_fim:         document.getElementById('oDataFim').value   || null,
    predio:           document.getElementById('oPredi').value,
    tipo:             document.getElementById('oTipo').value,
    fonte:            document.getElementById('oFonte').value,
    responsavel:      document.getElementById('oResponsavel').value || null,
    descricao:        document.getElementById('oDescricao').value,
    justificativa:    document.getElementById('oJustificativa').value || null,
    afeta_predio_todo: afetaTodo,
    sensores:         sensorIds,
  };

  // Validação básica
  if (!payload.data_inicio) { showToast('Data de início é obrigatória.', 'err'); return; }
  if (!payload.descricao)   { showToast('Descrição é obrigatória.', 'err'); return; }

  try {
    const url    = id ? `/api/admin/ocorrencias/${id}` : '/api/admin/ocorrencias';
    const method = id ? 'PUT' : 'POST';
    const res    = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erro || res.statusText);

    closeOcorrenciaModal();
    showToast(`✓ Ocorrência ${id ? 'atualizada' : 'registrada'} com sucesso.`);
    // Atualiza ambas as views — tab pública e admin em Gerenciar
    window._tabLoaded.ocorrencias = false;
   await Promise.all([
   loadOcorrenciasTab()
 ]);
    window._tabLoaded.ocorrencias = true;
  } catch(e) {
    showToast('✗ Erro ao salvar: ' + e.message, 'err');
  }
}


function confirmDelete(tipo, id, msg) {
  document.getElementById('deleteModalMsg').innerHTML = msg;
  _deleteFn = async () => {
    try {
      const res  = await fetch(`/api/admin/${tipo === 'sensor' ? 'sensores' : 'exposicoes'}/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro || res.statusText);
      closeDeleteModal();
      showToast(`✓ ${tipo === 'sensor' ? 'Sensor' : 'Exposição'} excluído(a) com sucesso.`);
      _gerenciarLoaded = false;
      try {
        if (tipo === 'sensor') { await Promise.all([loadSensoresAdmin(), populateFilters()]); }
        else                   { await Promise.all([loadExposAdmin(), loadExposicoes()]); }
      } finally { _gerenciarLoaded = true; }
    } catch (e) {
      showToast('✗ Erro: ' + e.message, 'err');
    }
  };
  document.getElementById('deleteConfirmBtn').onclick = _deleteFn;
  document.getElementById('deleteModal').classList.remove('hidden');
}

function closeDeleteModal() {
  document.getElementById('deleteModal').classList.add('hidden');
  _deleteFn = null;
}

// Fecha modais com Esc
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeSensorModal();
    closeExpoModal();
    closeDeleteModal();
    closeOcorrenciaModal?.();
    closePicosModal?.();
    closeNaoConformidadesModal?.();
  }
});

// Fecha modais clicando no overlay
['sensorModal','expoModal','deleteModal','aliasModal','reviewModal',
 'ocorrenciaModal','picosModal','ncModal'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', function(e) {
    if (e.target === this) {
      closeSensorModal(); closeExpoModal(); closeDeleteModal();
      closeAliasModal(); closeReviewModal();
      closeOcorrenciaModal?.(); closePicosModal?.(); closeNaoConformidadesModal?.();
    }
  });
});

// ── REVISÃO DE SENSORES NOVOS ─────────────────────────────

let _reviewSensores = [];    // lista de {id, nome, predio} do upload
let _allSensores    = [];    // lista completa do banco para o select de merge

async function openReviewModal(novos) {
  _reviewSensores = novos;

  // Carrega lista de todos os sensores para o select de fusão
  _allSensores = await API.get('admin/sensores');

  const list = document.getElementById('reviewList');
  list.innerHTML = novos.map((s, i) => {
    const opts = _allSensores
      .filter(x => x.id !== s.id)
      .map(x => `<option value="${x.id}">${escapeHtml(x.nome)} (${x.predio || 'Lina'})</option>`)
      .join('');
    return `
    <div class="review-item" id="review-item-${i}">
      <div class="review-item-header">
        <span class="review-badge-new">Novo</span>
        <span class="review-nome">${escapeHtml(s.nome)}</span>
        <span class="review-predio-tag">${s.predio}</span>
      </div>
      <div class="review-opts">
        <label class="review-opt">
          <input type="radio" name="review-${i}" value="keep" checked onchange="toggleMergeSelect(${i})">
          ✓ Manter como novo sensor
        </label>
        <label class="review-opt">
          <input type="radio" name="review-${i}" value="merge" onchange="toggleMergeSelect(${i})">
          ⇄ Vincular a sensor existente
        </label>
      </div>
      <div class="review-merge-select" id="review-merge-${i}">
        <select id="review-dest-${i}">
          <option value="">— selecione o sensor existente —</option>
          ${opts}
        </select>
      </div>
    </div>`;
  }).join('');

  document.getElementById('reviewModal').classList.remove('hidden');
}

function toggleMergeSelect(i) {
  const val = document.querySelector(`input[name="review-${i}"]:checked`)?.value;
  const sel = document.getElementById(`review-merge-${i}`);
  if (sel) sel.classList.toggle('show', val === 'merge');
}

function closeReviewModal() {
  document.getElementById('reviewModal').classList.add('hidden');
  _reviewSensores = [];
}

async function submitReview() {
  const btn = document.getElementById('reviewSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Processando…';

  const merges = [];
  const erros  = [];

  for (let i = 0; i < _reviewSensores.length; i++) {
    const val = document.querySelector(`input[name="review-${i}"]:checked`)?.value;
    if (val === 'merge') {
      const destId = parseInt(document.getElementById(`review-dest-${i}`)?.value);
      if (!destId) {
        erros.push(`Linha ${i + 1}: selecione o sensor de destino.`);
        continue;
      }
      merges.push({ origem_id: _reviewSensores[i].id, destino_id: destId });
    }
    // 'keep' → não faz nada, sensor já foi criado no upload
  }

  if (erros.length) {
    showToast('✗ ' + erros.join('\n'), 'err', 6000);
    btn.disabled = false;
    btn.textContent = 'Confirmar';
    return;
  }

  let ok = 0, fail = 0;
  for (const m of merges) {
    try {
      const res  = await fetch('/api/admin/sensores/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.erro || res.statusText);
      ok++;
    } catch (e) {
      fail++;
      console.error('Merge falhou:', e);
    }
  }

  closeReviewModal();

  const kept  = _reviewSensores.length - merges.length;
  const parts = [];
  if (kept)  parts.push(`${kept} novo(s) mantido(s)`);
  if (ok)    parts.push(`${ok} fusão(ões) realizada(s)`);
  if (fail)  parts.push(`${fail} falha(s)`);
  showToast(`✓ Revisão concluída: ${parts.join(' · ')}`, fail ? 'err' : 'ok', 6000);

  // Atualiza filtros e lista admin se estiver aberta
  try {
    await Promise.all([populateFilters(), loadSensoresAdmin()]);
  } catch (_) {}
}

// ── MODAL DE PICOS DETECTADOS NO UPLOAD ──────────────────

let _picosData = [];

function openPicosModal(picos) {
  _picosData = picos;
  document.getElementById('picosCount').textContent = picos.length;

  const lista = document.getElementById('picosLista');
  lista.innerHTML = picos.map((p, i) => {
    const cor      = p.categoria === 'variacao_ur' ? '#d97706' : '#E30613';
    const icone    = p.categoria === 'variacao_ur' ? '💧' : '🌡';
    const dataIni  = (p.data_inicio || '').substring(0, 16).replace('T', ' ');
    const dataFim  = p.data_fim ? (p.data_fim).substring(0, 16).replace('T', ' ') : '';

    return `<div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;
                border-bottom:1px solid var(--border);background:var(--white)">
      <input type="checkbox" id="pico-${i}" checked
        style="margin-top:3px;width:auto;flex-shrink:0;accent-color:var(--red)">
      <label for="pico-${i}" style="flex:1;cursor:pointer">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
          <span style="font-family:var(--mono);font-size:.72rem;font-weight:700;color:${cor}">
            ${icone} ${escapeHtml(p.sensor_nome)}
          </span>
          <span style="font-family:var(--mono);font-size:.68rem;color:var(--gray-400)">
            ${escapeHtml(p.predio)}
          </span>
          <span style="font-family:var(--mono);font-size:.68rem;color:var(--gray-500)">
            ${dataIni}${dataFim && dataFim !== dataIni ? ' → ' + dataFim : ''}
          </span>
        </div>
        <div style="font-size:.8rem;color:var(--gray-700);margin-bottom:6px">
          ${escapeHtml(p.descricao)}
        </div>
        <!-- Campo de descrição editável -->
        <textarea data-pico="${i}" rows="2"
          style="width:100%;padding:6px 8px;border:1px solid var(--border);
                 border-radius:var(--radius);font-size:.78rem;font-family:var(--sans);
                 resize:vertical;color:var(--black);background:#fafaf9"
          placeholder="Adicione observações (opcional)...">${escapeHtml(p.descricao)}</textarea>
      </label>
    </div>`;
  }).join('');

  document.getElementById('picosModal').classList.remove('hidden');
}

function closePicosModal() {
  document.getElementById('picosModal').classList.add('hidden');
  _picosData = [];
}

function toggleTodosPicos(check) {
  document.querySelectorAll('#picosLista input[type=checkbox]')
    .forEach(cb => cb.checked = check);
}

async function salvarPicosSelecionados() {
  const indiceSelecionados = [..._picosData.keys()].filter(i =>
    document.getElementById(`pico-${i}`)?.checked
  );

  if (!indiceSelecionados.length) { closePicosModal(); return; }

  let salvos = 0;
  let erros  = 0;

  for (const i of indiceSelecionados) {
    const p = _picosData[i];
    const descEditada = document.querySelector(`textarea[data-pico="${i}"]`)?.value?.trim()
      || p.descricao;

    const payload = {
      data_inicio:       p.data_inicio,
      data_fim:          p.data_fim || null,
      predio:            p.predio || 'Lina',
      tipo:              'pico_automatico',
      fonte:             'sistema',
      descricao:         descEditada,
      responsavel:       'Sistema (upload automático)',
      afeta_predio_todo: false,
      sensor_ids:        p.sensor_id ? [p.sensor_id] : [],
    };

    try {
      const res = await fetch('/api/admin/ocorrencias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) salvos++;
      else erros++;
    } catch { erros++; }
  }

  closePicosModal();
  showToast(
    `✓ ${salvos} ocorrência(s) registrada(s) automaticamente.${erros ? ` (${erros} erro(s))` : ''}`,
    salvos && !erros ? 'ok' : 'err',
    5000
  );

  // Atualiza aba de ocorrências — independente de qual aba está ativa
  if (salvos > 0) {
    window._tabLoaded.ocorrencias = false;
    loadOcorrenciasTab().catch(() => {});
  }
}

// ── EXPORTAR TABELA DE ALERTAS PARA PDF ───────────────────
function exportAlertasPDF() {
  const lang = document.querySelector('#repLang .seg-btn.active')?.dataset.lang || 'pt';
  const tx = I18N[lang];
  const alertas = window._currentAlertas || [];
  if (!alertas.length) {
    showToast('Nenhum alerta para exportar.', 'warn');
    return;
  }

  // 1. Captura o ${tx.period} e os sensores ativos no painel
  const f = window._lastFilters || {};
  const dataIni = f.data_ini || document.getElementById('fDataIni')?.value || '';
  const dataFim = f.data_fim || document.getElementById('fDataFim')?.value || '';
  const periodoStr = (dataIni && dataFim) ? `${dataIni} a ${dataFim}` : '${tx.period} completo';

  const pontos = getSelectedPontos();
  let pontosStr = 'Todos os sensores';
  if (pontos.length > 0) {
    // Se houver muitos sensores, mostra os primeiros e resume o resto para não quebrar o layout
    pontosStr = pontos.length <= 8 ? pontos.join(' · ') : `${pontos.slice(0, 8).join(' · ')} (+${pontos.length - 8} outros)`;
  }

  function fmtDt(dt) {
    if (!dt) return { data: null, hora: null };
    const s = String(dt);
    const data = s.substring(0, 10);
    const hora = s.substring(11, 16) || null;
    const [ano, mes, dia] = data.split('-');
    return { data: `${dia}/${mes}/${ano}`, hora };
  }

  const rowsHtml = alertas.map(a => {
    const dtIniRaw = a.data_inicio || a.dia || null;
    const dtFimRaw = a.data_fim    || null;
    const ini = fmtDt(dtIniRaw);
    const fim = fmtDt(dtFimRaw);

    let quando = ini.data || '–';
    if (ini.hora && fim.hora && ini.hora !== fim.hora) {
      quando += ` <span style="color:#888;font-size:10px">entre ${ini.hora} e ${fim.hora}</span>`;
    } else if (ini.hora) {
      quando += ` <span style="color:#888;font-size:10px">às ${ini.hora}</span>`;
    }

    const andar  = a.andar  ? escapeHtml(a.andar)  : '';
    const predio = a.predio ? escapeHtml(a.predio)  : '';
    const local  = [andar, predio].filter(Boolean).join(' · ');

    const urI     = a.ur_inicial ?? a.ur_min ?? '–';
    const urF     = a.ur_final   ?? a.ur_max ?? '–';
    const variacao = typeof a.variacao === 'number'
      ? a.variacao.toFixed(1)
      : (typeof urI === 'number' && typeof urF === 'number'
          ? Math.abs(urF - urI).toFixed(1)
          : '–');
    const subindo  = typeof urF === 'number' && typeof urI === 'number' ? urF > urI : null;
    const dir      = subindo === true ? '↑' : subindo === false ? '↓' : '↕';
    const dirCor   = subindo === true ? '#1d4ed8' : '#E30613';

    const expositivo = a.periodo_expositivo ? '🎨 Sim' : 'Não';
    const expCor = a.periodo_expositivo ? '#E30613' : '#8c8278';

    return `
      <tr>
        <td><strong>${escapeHtml(a.ponto)}</strong><br><span style="font-size:10px;color:#8c8278">${local}</span></td>
        <td style="font-family:monospace">${quando}</td>
        <td style="color:${dirCor};font-weight:bold;font-family:monospace">${dir} ${variacao} p.p.</td>
        <td style="font-family:monospace">${urI}% &rarr; ${urF}%</td>
        <td style="color:${expCor};font-weight:500;font-size:11px">${expositivo}</td>
      </tr>
    `;
  }).join('');

  const html = `<!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="UTF-8">
    <title>MASP - Alertas de Umidade</title>
    <style>
      body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1614; font-size: 12px; margin: 40px; background: #fff; }
      .header { border-bottom: 3px solid #0d0d0d; padding-bottom: 20px; margin-bottom: 30px; display: flex; justify-content: space-between; align-items: flex-end; }
      .logo { font-family: monospace; font-size: 28px; font-weight: 900; letter-spacing: 6px; }
      .logo span { color: #E30613; }
      .title { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: #d97706; margin-top: 5px; }
      .context-box { margin-top: 14px; background: #fdfaf4; border: 1px solid #fde68a; padding: 10px 14px; border-radius: 4px; font-family: monospace; font-size: 11px; color: #6b6057; line-height: 1.6; }
      .meta { font-family: monospace; font-size: 10px; color: #8c8278; text-align: right; line-height: 1.5; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
      th { background: #f0ebe5; padding: 12px 10px; text-align: left; font-family: monospace; font-size: 10px; text-transform: uppercase; color: #5a5350; border-bottom: 2px solid #d0ccc5; }
      td { padding: 12px 10px; border-bottom: 1px solid #eae8e4; vertical-align: middle; }
      tr:nth-child(even) { background: #fafaf9; }
      .print-btn { margin-bottom: 20px; padding: 8px 16px; background: #E30613; color: #fff; border: none; border-radius: 3px; cursor: pointer; font-family: monospace; text-transform: uppercase; letter-spacing: 1px; }
      .print-btn:hover { opacity: 0.8; }
      @media print {
        body { margin: 0; padding: 20px; }
        .print-btn { display: none; }
        table { page-break-inside: auto; }
        tr { page-break-inside: avoid; page-break-after: auto; }
        thead { display: table-header-group; }
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div>
        <div class="logo">MASP<span>_</span></div>
        <div class="title">Alertas de Variação Brusca de Umidade (&gt; 10 p.p. / 24h)</div>
        <div class="context-box">
          <strong>${tx.period}:</strong> ${periodoStr}<br>
          <strong>SENSORES:</strong> ${pontosStr}
        </div>
      </div>
      <div class="meta">
        Gerado em: ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR')}<br>
        <strong>Total de Alertas: ${alertas.length}</strong>
      </div>
    </div>
    <button class="print-btn" onclick="window.print()">⎙ Salvar PDF / Imprimir</button>
    <table>
      <thead>
        <tr>
          <th>Ponto de Medição</th>
          <th>Data / ${tx.period}</th>
          <th>Variação</th>
          <th>UR Mín &rarr; Máx</th>
          <th>Em Exposição</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </body>
  </html>`;

  const blob = new Blob([html], {type: 'text/html;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
}

const I18N = {
  pt: {
    title: "Relatório de Climatização Museal",
    subtitle: "Conservação Preventiva de Acervos",
    period: "Período",
    standard: "Padrão de Conformidade",
    points: "Pontos de Medição",
    point_col: "Ponto de Medição",
    total_med: "Total de Medições",
    generated: "GERADO EM",
    guide_title: "Guia Completo de Interpretação",
    how_to_read: "Como Ler Este Relatório",
    exec_summary: "01 — Resumo Executivo",
    exec_summary_text: "A Página 1 apresenta uma visão geral do período monitorado, incluindo:",
    avg_compliance: "Conformidade Média",
    avg_compliance_desc: "das medidas estão dentro da faixa de conformidade",
    avg_compliance_detail: "Percentual geral de aderência ao padrão selecionado",
    sensors_attention: "Sensores em Atenção",
    sensors_attention_desc: "com menos de 80% das medições dentro da faixa de conformidade",
    sensors_critical: "Sensores Críticos",
    sensors_critical_desc: "com menos de 70% das medições dentro do padrão",
    best_perf_desc: "das medições dentro do padrão",
    worst_perf_desc: "das medições dentro do padrão",
    comparative_table: "Tabela Comparativa",
    comparative_table_detail: "Visão lado a lado de todos os pontos",
    time_series_detail: "Temperatura e Umidade ao longo do período",
    compliance_zone_detail: "Faixa verde indica limites permitidos",
    exhibition_marks_detail: "Linhas tracejadas indicam quando o acervo estava em exibição",
    occurrences_detail: "Eventos como manutenção, falhas e intervenções",
    excellent_compliance: "Excelente conformidade",
    attention_review: "Atenção — revisar",
    critical_action: "Crítico — ação urgente",
    individual_pages: "02 — Páginas Individuais de Sensores",
    individual_pages_text: "Para cada ponto de medição, você encontrará:",
    time_series_charts: "Gráficos de série temporal",
    compliance_zone: "Zona de conformidade",
    exhibition_marks: "Marcações de exposição",
    occurrences_label: "Ocorrências",
    colors_symbols: "03 — Interpretação de Cores e Símbolos",
    excellent: "Excelente",
    attention: "Atenção",
    critical: "Crítico",
    understanding_deviations: "04 — Entendendo os Desvios",
    deviations_text: "Em cada página de sensor, a seção 'Análise de Desvios' decompõe as medições fora da conformidade em:",
    within_range: "dentro da faixa de conformidade",
    above: "Acima",
    below: "Abaixo",
    too_hot_humid: "mais quente/úmido",
    too_cold_dry: "mais frio/seco",
    ref_standards: "05 — Padrões de Referência",
    intl_lenders: "06 — Para Emprestadores Internacionais",
    intl_lenders_text: "Este relatório demonstra o controle climático sistemático do acervo e sua adequação aos critérios internacionais.",
    toc: "SUMÁRIO",
    gen_summary: "Sumário Geral",
    comp_view: "Visão Comparativa e Tabela de Conformidade",
    sensor_analyses: "Análises por Ponto de Medição",
    page_abbr: "pág.",
    measurements: "Medições",
    gen_conf: "Conf. Geral",
    temp_avg: "T Média",
    ur_avg: "UR Média",
    status: "Status",
    best_perf: "Melhor desempenho",
    worst_perf: "Pior desempenho",
    on_exhibition: "Em Exposição",
    maintenance: "Manutenção",
    tech_notes: "Notas Técnicas",
    dev_analysis_t: "Análise de Desvios — Temperatura (°C)",
    dev_analysis_ur: "Análise de Desvios — Umidade Relativa (%)",
    within_range_label: "DENTRO DA FAIXA",
    above_limit: "ACIMA DO LIMITE",
    below_limit: "ABAIXO DO LIMITE",
    normal_meds: "medições normais",
    too_hot_label: "Muito Quente",
    too_cold_label: "Muito Frio",
    too_humid_label: "Muito Úmido",
    too_dry_label: "Muito Seco",
    comparative_view: "Visão Comparativa — Tabela de Conformidade",
    excellent_colon: "Excelente:",
    attention_colon: "Atenção:",
    critical_colon: "Crítico:",
    monthly_evolution: "Evolução Histórica · Conformidade Mensal",
    comparative_trend: "Tendência de Conformidade Comparativa — Todos os Sensores",
    trend_text: "Este gráfico consolida o desempenho de todos os pontos de medição selecionados. As curvas permitem identificar períodos de instabilidade coletiva (causados por fatores externos ou falhas sistêmicas) versus desvios pontuais de sensores específicos.",
    legend_analysis: "Legenda de Análise de Tendência",
    high_stability: "ESTABILIDADE ALTA",
    high_stability_text: "Linhas na zona superior (90-100%) indicam controle rigoroso do microclima.",
    variation_alert: "ALERTA DE VARIAÇÃO",
    variation_alert_text: "Cruzamento de linhas ou quedas bruscas para a zona central exigem investigação.",
    critical_deviation: "DESVIO CRÍTICO",
    critical_deviation_text: "Permanência abaixo de 70% indica falha persistente no sistema de climatização.",
    occurrences_period: "Ocorrências no período",
    occurrences_registered: "Ocorrências Registradas",
    inside_range: "dentro da faixa de conformidade",
    zone: "Zona",
    outside_zone: "Fora da zona",
    in_exhibition: "Em exposição",
    outside_range: "Fora da faixa de conformidade",
    records_in_period: "Registros no período",
    save_pdf: "Salvar PDF",
    close: "Fechar",
    month: "Mês",
    monthly_evolution_label: "Evolução Mensal"
  },
  en: {
    title: "Museum Climate Control Report",
    subtitle: "Preventive Conservation of Collections",
    period: "Period",
    standard: "Compliance Standard",
    points: "Measurement Points",
    point_col: "Measurement Point",
    total_med: "Total Measurements",
    generated: "GENERATED ON",
    guide_title: "Complete Interpretation Guide",
    how_to_read: "How to Read This Report",
    exec_summary: "01 — Executive Summary",
    exec_summary_text: "Page 1 presents an overview of the monitored period, including:",
    avg_compliance: "Average Compliance",
    avg_compliance_desc: "of measurements are within compliance range",
    avg_compliance_detail: "Overall adherence percentage to the selected standard",
    sensors_attention: "Sensors in Attention",
    sensors_attention_desc: "with less than 80% of measurements within compliance range",
    sensors_critical: "Critical Sensors",
    sensors_critical_desc: "with less than 70% of measurements within the standard",
    best_perf_desc: "of measurements within the standard",
    worst_perf_desc: "of measurements within the standard",
    comparative_table: "Comparative Table",
    comparative_table_detail: "Side-by-side view of all points",
    time_series_detail: "Temperature and Humidity over the period",
    compliance_zone_detail: "Green band indicates permitted limits",
    exhibition_marks_detail: "Dashed lines indicate when the collection was on display",
    occurrences_detail: "Events such as maintenance, failures, and interventions",
    excellent_compliance: "Excellent compliance",
    attention_review: "Attention — review",
    critical_action: "Critical — urgent action",
    individual_pages: "02 — Individual Sensor Pages",
    individual_pages_text: "For each measurement point, you will find:",
    time_series_charts: "Time series charts",
    compliance_zone: "Compliance zone",
    exhibition_marks: "Exhibition markings",
    occurrences_label: "Occurrences",
    colors_symbols: "03 — Interpretation of Colors and Symbols",
    excellent: "Excellent",
    attention: "Attention",
    critical: "Critical",
    understanding_deviations: "04 — Understanding Deviations",
    deviations_text: "On each sensor page, the 'Deviation Analysis' section breaks down non-compliant measurements into:",
    within_range: "within compliance range",
    above: "Above",
    below: "Below",
    too_hot_humid: "too hot/humid",
    too_cold_dry: "too cold/dry",
    ref_standards: "05 — Reference Standards",
    intl_lenders: "06 — For International Lenders",
    intl_lenders_text: "This report demonstrates the systematic climate control of the collection and its compliance with international criteria.",
    toc: "TABLE OF CONTENTS",
    gen_summary: "General Summary",
    comp_view: "Comparative View and Compliance Table",
    sensor_analyses: "Analyses by Measurement Point",
    page_abbr: "p.",
    measurements: "Measurements",
    gen_conf: "Gen. Conf.",
    temp_avg: "Average T",
    ur_avg: "Average RH",
    status: "Status",
    best_perf: "Best performance",
    worst_perf: "Worst performance",
    on_exhibition: "On Exhibition",
    maintenance: "Maintenance",
    tech_notes: "Technical Notes",
    dev_analysis_t: "Deviation Analysis — Temperature (°C)",
    dev_analysis_ur: "Deviation Analysis — Relative Humidity (%)",
    within_range_label: "WITHIN RANGE",
    above_limit: "ABOVE LIMIT",
    below_limit: "BELOW LIMIT",
    normal_meds: "normal measurements",
    too_hot_label: "Too Hot",
    too_cold_label: "Too Cold",
    too_humid_label: "Too Humid",
    too_dry_label: "Too Dry",
    comparative_view: "Comparative View — Compliance Table",
    excellent_colon: "Excellent:",
    attention_colon: "Attention:",
    critical_colon: "Critical:",
    monthly_evolution: "Historical Evolution · Monthly Compliance",
    comparative_trend: "Comparative Compliance Trend — All Sensors",
    trend_text: "This chart consolidates the performance of all selected measurement points. The curves allow you to identify periods of collective instability (caused by external factors or systemic failures) versus isolated deviations from specific sensors.",
    legend_analysis: "Trend Analysis Legend",
    high_stability: "HIGH STABILITY",
    high_stability_text: "Lines in the upper zone (90-100%) indicate strict microclimate control.",
    variation_alert: "VARIATION ALERT",
    variation_alert_text: "Line crossovers or sharp drops to the central zone require investigation.",
    critical_deviation: "CRITICAL DEVIATION",
    critical_deviation_text: "Staying below 70% indicates persistent failure in the climate control system.",
    occurrences_period: "Occurrences in the period",
    occurrences_registered: "Registered Occurrences",
    inside_range: "within compliance range",
    zone: "Zone",
    outside_zone: "Outside zone",
    in_exhibition: "On exhibition",
    outside_range: "outside compliance range",
    records_in_period: "Records in the period",
    save_pdf: "Save PDF",
    close: "Close",
    month: "Month",
    monthly_evolution_label: "Monthly Evolution"
  }
};