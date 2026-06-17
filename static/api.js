// Guard de dupla carga — reseta em vez de lançar exceção,
// pois um throw aqui aborta o DOMContentLoaded e trava o boot.
if (window.__masp_loaded) {
  console.warn('api.js: reload detectado, resetando estado.');
  window._charts = {};
}
window.__masp_loaded = true;

const tx = {
  period: "período",
  title: "Relatório de Climatização Museal",
  subtitle: "Conservação Preventiva de Acervos",
  standard: "Padrão de Conformidade"
};

// Registro central de instâncias Chart.js — evita inicializações redundantes
window._charts = window._charts || {};

// Callback do modal de confirmação de exclusão (compartilhado entre confirmDelete e confirmDeleteOcorrencia)
let _deleteFn = null;

// ── UTILITÁRIOS ───────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── PALETA DE CORES (CSS Variables) ───────────────────────
// Extrai cores da root CSS para manter sincronização entre
// dashboard e gráficos. Cacheado para performance.
const _colorCache = {};
function getColor(varName) {
  if (!_colorCache[varName]) {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(`--${varName}`).trim();
    _colorCache[varName] = value || '#cccccc'; // fallback cinza
  }
  return _colorCache[varName];
}

// Paleta de cores unificada
const COLORS = {
  ibram:      () => getColor('color-ibram'),
  masp:       () => getColor('color-masp'),
  bizot:      () => getColor('color-bizot'),
  confHigh:   () => getColor('color-conf-high'),
  confMed:    () => getColor('color-conf-med'),
  confLow:    () => getColor('color-conf-low'),
  igramFill:  () => getColor('color-ibram-fill'),
  maspFill:   () => getColor('color-masp-fill'),
  bizotFill:  () => getColor('color-bizot-fill'),
  confHighFill: () => getColor('color-conf-high-fill'),
  confMedFill: () => getColor('color-conf-med-fill'),
  blue:       () => getColor('blue'),
  grayText:   () => getColor('gray-text'),
  grayAxis:   () => getColor('gray-axis'),
  grayGrid:   () => getColor('gray-grid'),
  grayBorder: () => getColor('gray-border'),
  textPrimary: () => getColor('text-primary'),
  textMuted:   () => getColor('text-muted'),
  black:      () => getColor('black'),
  white:      () => getColor('white'),
};


// ── API ───────────────────────────────────────────────────
const API = {
  async get(path, params = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (Array.isArray(v)) {
        v.forEach(val => { if (val !== '') qs.append(k, val); });
      } else if (v !== '' && v != null) {
        qs.append(k, String(v));
      }
    });
    const url = `/api/${path}${qs.toString() ? '?' + qs.toString() : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  }
};

// ── FILTROS ───────────────────────────────────────────────
function getFilters() {
  const pontos = getSelectedPontos();
  const periodBtn = document.querySelector('#fPeriodo .seg-btn.active');
  return {
    ponto:              pontos,
    periodo_expositivo: periodBtn?.dataset.val || '',
    data_ini:           document.getElementById('fDataIni')?.value || '',
    data_fim:           document.getElementById('fDataFim')?.value || '',
  };
}

// ── CHIP SELECTOR DE PONTOS ───────────────────────────────
function togglePontoChip(btn) {
  btn.classList.toggle('active');
}

function getSelectedPontos() {
  return [...document.querySelectorAll('#fPontoGroups .chip-btn[data-nome].active')]
    .map(b => b.dataset.nome);
}

function selectAllPontos(checked) {
  document.querySelectorAll('#fPontoGroups .chip-btn[data-nome]')
    .forEach(b => b.classList.toggle('active', checked));
}

function selectGroupPontos(andar, checked) {
  document.querySelectorAll(`#fPontoGroups [data-andar-group="${CSS.escape(andar)}"] .chip-btn`)
    .forEach(b => b.classList.toggle('active', checked));
}

// ── SEGMENTED CONTROL ─────────────────────────────────────
function selectSeg(btn) {
  btn.closest('.seg-ctrl').querySelectorAll('.seg-btn')
    .forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

async function populateFilters() {
  const meta = await API.get('meta');

  // Persiste o sensor externo detectado pelo backend para uso no gráfico sazonal
  window._sensorExterno = meta.sensor_externo || 'Térreo';

  // ── Chip groups agrupados por andar ──
  const groups = document.getElementById('fPontoGroups');
  if (groups && meta.pontos.length) {
    const byAndar = {};
    meta.pontos.filter(p => p && p.nome).forEach(p => {
      const a = p.andar || 'Sem andar';
      if (!byAndar[a]) byAndar[a] = [];
      byAndar[a].push(p.nome);
    });

    groups.innerHTML = Object.entries(byAndar).map(([andar, nomes]) => `
      <div class="chip-group" data-andar-group="${escapeHtml(andar)}">
        <div class="chip-group-lbl" title="Clique para selecionar/desmarcar o andar">
          ${escapeHtml(andar)}
        </div>
        <div class="chip-group-chips">
          ${nomes.map(nome => `<button class="chip-btn" data-nome="${escapeHtml(nome)}">${escapeHtml(nome)}</button>`).join('')}
        </div>
      </div>`).join('');

    // Listeners adicionados após o innerHTML para evitar injeção via nomes de andar
    groups.querySelectorAll('.chip-group-lbl').forEach(lbl => {
      lbl.addEventListener('click', () => {
        const andar = lbl.closest('[data-andar-group]').dataset.andarGroup;
        selectGroupPontos(andar, !getGroupAllActive(andar));
      });
    });
    groups.querySelectorAll('.chip-btn[data-nome]').forEach(btn => {
      btn.addEventListener('click', () => togglePontoChip(btn));
    });
  }

  // ── Select do gráfico de orvalho ──
  const selOrvalho = document.getElementById('selOrvalhoSensor');
  if (selOrvalho && meta.pontos.length) {
    const prev = selOrvalho.value;
    selOrvalho.innerHTML = '<option value="">— selecione um sensor —</option>' +
      meta.pontos.filter(p => p?.nome)
        .map(p => `<option value="${escapeHtml(p.nome)}">${escapeHtml(p.nome)}</option>`)
        .join('');
    if (prev) selOrvalho.value = prev;
  }

// ── Checkboxes do relatório (Agrupados por Andar) ──
  const grid = document.getElementById('repSensores');
  if (grid && meta.pontos.length) {
    const pontosFiltrados = meta.pontos.filter(p => p && p.nome);
    const porAndar = {};
    
    pontosFiltrados.forEach(p => {
      const a = p.andar || 'Sem andar';
      if (!porAndar[a]) porAndar[a] = [];
      porAndar[a].push(p);
    });
    
    grid.innerHTML = Object.entries(porAndar).map(([andar, pontos]) => `
      <div style="grid-column: 1 / -1; margin: 16px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: .65rem; color: var(--gray-400); letter-spacing: 1px; text-transform: uppercase;">
        ${escapeHtml(andar)}
      </div>
      ${pontos.map(p => `
        <label class="rep-sensor-item">
          <input type="checkbox" class="rep-check" value="${escapeHtml(p.nome)}"
                 onchange="updateThreshRow(this); updateReportProgressIndicator();">
          <span>${escapeHtml(p.nome)}</span>
        </label>
      `).join('')}
    `).join('');
  }
  return meta;
}

function getGroupAllActive(andar) {
  const all  = [...document.querySelectorAll(`[data-andar-group="${CSS.escape(andar)}"] .chip-btn`)];
  return all.length > 0 && all.every(b => b.classList.contains('active'));
}



// ── MÉTRICAS ──────────────────────────────────────────────
async function loadMetricas(filters = {}) {
  const m = await API.get('metricas', filters);
  const fmt = v => (v != null ? v + '%' : '–');
  document.getElementById('mTotal').textContent = fmt(m.conf_total_ibram);
  document.getElementById('mMasp').textContent  = fmt(m.conf_masp);
  document.getElementById('mBizot').textContent = fmt(m.conf_bizot);
  document.getElementById('mMed').textContent   = (m.total ?? 0).toLocaleString('pt-BR');

  // 3 barras: pct0=total IBRAM, pct1=total MASP, pct2=total Bizot
  const vals = [m.conf_total_ibram, m.conf_masp, m.conf_bizot];
  const ids  = ['pct0', 'pct1', 'pct2'];
  const bars = document.querySelectorAll('.prog-fill-bar[data-w]');
  vals.forEach((val, i) => {
    const v = val ?? 0;
    if (bars[i]) { bars[i].dataset.w = v; bars[i].style.width = v + '%'; }
    const el = document.getElementById(ids[i]);
    if (el) el.textContent = v + '%';
  });
}

// ── PONTOS ────────────────────────────────────────────────
// Cache dos pontos para permitir re-renderização sem nova chamada à API
let _pontosCache = [];

function getActivePadrao() {
  return document.querySelector('#segPadrão .seg-btn.active')?.dataset.padrao || 'ibram';
}

function renderPontosTable() {
  const padrao  = getActivePadrao();
  const tb = document.getElementById('tPontos');
  if (!tb || !_pontosCache.length) return;

  // Mapeamento dos campos por padrão
  const campos = {
    ibram: { total: 'conf_total_ibram', temp: 'conf_temp_ibram', ur: 'conf_ur_ibram',  label: 'IBRAM  18–22°C / 50–60% UR' },
    masp:  { total: 'conf_total_masp',  temp: 'conf_temp_masp',  ur: 'conf_ur_masp',   label: 'MASP   18–23°C / 45–55% UR' },
    bizot: { total: 'conf_total_bizot', temp: 'conf_temp_bizot', ur: 'conf_ur_bizot',  label: 'Bizot  15–25°C / 40–60% UR' },
  };
  const c = campos[padrao];

  // Atualiza legenda no cabeçalho
  const head = document.getElementById('tPontosHead');
  if (head) {
    const color = padrao === 'ibram' ? COLORS.ibram() : padrao === 'masp' ? COLORS.masp() : COLORS.bizot();
    head.querySelector('th:nth-child(5)').textContent = 'Total';
    head.querySelector('th:nth-child(5)').title = c.label;
    head.querySelector('th:nth-child(5)').style.borderBottom = `2px solid ${color}`;
    head.querySelector('th:nth-child(6)').style.borderBottom = `2px solid ${color}`;
    head.querySelector('th:nth-child(7)').style.borderBottom = `2px solid ${color}`;
  }

  tb.innerHTML = _pontosCache.map(p => `
    <tr>
      <td><strong>${escapeHtml(p.ponto)}</strong></td>
      <td>${escapeHtml(p.andar) || '–'}</td>
      <td><span class="badge badge-blue">● Ativo</span></td>
      <td>${(p.medicoes||0).toLocaleString('pt-BR')}</td>
      <td>${badgeFor(p[c.total])}</td>
      <td>${badgeFor(p[c.temp])}</td>
      <td>${badgeFor(p[c.ur])}</td>
      <td>${p.temp_media ?? '–'}°C</td>
      <td>${p.ur_media ?? '–'}%</td>
    </tr>`).join('');
}

async function loadPontos(filters = {}) {
  const pontos = await API.get('pontos', filters);
  _pontosCache = pontos;
  renderPontosTable();

  // ── Gráfico de conformidade por sensor (barras horizontais) ──
  if (pontos.length) {
    _sensoresCache = pontos;
    renderSensores();
  }

  // Popula o select do gráfico horário com os sensores disponíveis
  const sel = document.getElementById('selHorarioSensor');
  if (sel && pontos.length) {
    const nomes = pontos.map(p => p.ponto || p.nome).filter(Boolean).sort();
    sel.innerHTML = '<option value="">Todos os sensores</option>' +
      nomes.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  }

  // Scatter T médio × UR médio — cada ponto = sensor, cor = conformidade total
  const cScatter = document.getElementById('cScatter');
  if (cScatter && pontos.length) {
    if (window._charts?.cScatter) window._charts.cScatter.destroy();
  
    const colorFor = v => v >= 80 ? COLORS.confHigh() : v >= 70 ? COLORS.confMed() : COLORS.confLow();
    const _padraoScatter = getActivePadrao();
    const _confKeyScatter = { ibram: 'conf_total_ibram', masp: 'conf_total_masp', bizot: 'conf_total_bizot' }[_padraoScatter];
    const scatterData = pontos.map(p => ({
      x: p.temp_media,
      y: p.ur_media,
      label: p.ponto,
      conf: p[_confKeyScatter] ?? 0,
    }));

    window._charts.cScatter = new Chart(cScatter, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Sensores',
          data: scatterData,
          backgroundColor: scatterData.map(d => {
            const col = colorFor(d.conf || 0);
            return col + 'cc';
          }),
          borderColor:     scatterData.map(d => colorFor(d.conf || 0)),
          borderWidth: 2,
          pointRadius: 10,
          pointHoverRadius: 13,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const d = scatterData[ctx.dataIndex];
                return [`${d.label}`, `T: ${d.x}°C  |  UR: ${d.y}%  |  Total: ${d.conf}%`];
              }
            }
          },
          // Anotação manual da zona ideal via afterDraw
        },
        scales: {
          x: {
            title: { display: true, text: 'TEMPERATURA MÉDIA (°C)', font: { family: "'DM Mono', monospace", size: 10 }, color: COLORS.grayAxis() },
            min: 15, max: 28,
            ticks: { callback: v => v + '°C' },
            grid: { color: COLORS.grayGrid() }
          },
          y: {
            title: { display: true, text: 'UR MÉDIA (%)', font: { family: "'DM Mono', monospace", size: 10 }, color: COLORS.grayAxis() },
            min: 30, max: 80,
            ticks: { callback: v => v + '%' },
            grid: { color: COLORS.grayGrid() }
          }
        }
      },
      plugins: [{
        id: 'zonasFaixas',
        afterDraw(chart) {
          const { ctx, scales: { x, y } } = chart;
          ctx.save();

          // Bizot: 15–25°C / 40–60% UR
          const bx1 = x.getPixelForValue(15), bx2 = x.getPixelForValue(25);
          const by1 = y.getPixelForValue(60), by2 = y.getPixelForValue(40);
          ctx.fillStyle = COLORS.bizotFill().replace(/[\d.]+\)$/, '0.08)');
          ctx.fillRect(bx1, by1, bx2 - bx1, by2 - by1);
          ctx.strokeStyle = COLORS.bizot();
          ctx.lineWidth = 1;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(bx1, by1, bx2 - bx1, by2 - by1);
          ctx.fillStyle = COLORS.bizot();
          ctx.font = 'bold 9px "DM Mono", monospace';
          ctx.fillText('BIZOT', bx1 + 4, by1 + 12);

          // MASP: 18–23°C / 45–55% UR
          const mx1 = x.getPixelForValue(18), mx2 = x.getPixelForValue(23);
          const my1 = y.getPixelForValue(55), my2 = y.getPixelForValue(45);
          ctx.fillStyle = COLORS.maspFill().replace(/[\d.]+\)$/, '0.08)');
          ctx.fillRect(mx1, my1, mx2 - mx1, my2 - my1);
          ctx.strokeStyle = COLORS.masp();
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(mx1, my1, mx2 - mx1, my2 - my1);
          ctx.fillStyle = COLORS.masp();
          ctx.font = 'bold 9px "DM Mono", monospace';
          ctx.fillText('MASP', mx1 + 4, my1 + 12);

          // IBRAM: 18–22°C / 50–60% UR
          const ix1 = x.getPixelForValue(18), ix2 = x.getPixelForValue(22);
          const iy1 = y.getPixelForValue(60), iy2 = y.getPixelForValue(50);
          ctx.fillStyle = COLORS.igramFill().replace(/[\d.]+\)$/, '0.05)');
          ctx.fillRect(ix1, iy1, ix2 - ix1, iy2 - iy1);
          ctx.strokeStyle = COLORS.ibram();
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 3]);
          ctx.strokeRect(ix1, iy1, ix2 - ix1, iy2 - iy1);
          ctx.fillStyle = COLORS.ibram();
          ctx.font = 'bold 9px "DM Mono", monospace';
          ctx.fillText('IBRAM', ix1 + 4, iy1 + 12);

          ctx.setLineDash([]);
          ctx.restore();

          // Legenda
          const lx = chart.chartArea.right - 150, ly = chart.chartArea.top + 10;
          [['≥ 80% Conforme (MASP)', COLORS.confHigh()], ['70–80%', COLORS.confMed()], ['< 70%', COLORS.confLow()]].forEach(([lbl, col], i) => {
            ctx.save();
            ctx.fillStyle = col;
            ctx.fillRect(lx, ly + i * 18, 10, 10);
            ctx.fillStyle = COLORS.textMuted();
            ctx.font = '9px "DM Mono", monospace';
            ctx.fillText(lbl, lx + 14, ly + i * 18 + 9);
            ctx.restore();
          });
        }
      }]
    });

    // Tooltip gerenciado pelo Chart.js via options.plugins.tooltip
  }
}

// ── MENSAL ────────────────────────────────────────────────
let _mensalCache = [];  // cache dos dados para re-renderização sem nova chamada

function getActiveMensalPadrao() {
  return document.querySelector('#segMensal .seg-btn.active')?.dataset.mensal || 'ibram';
}

function renderMensal() {
  const padrao = getActiveMensalPadrao();
  const canvas = document.getElementById('cMensal');
  if (!canvas || !_mensalCache.length) return;
  if (window._charts?.cMensal) { window._charts.cMensal.destroy(); window._charts.cMensal = null; }

  const d    = _mensalCache;
  const gran = document.querySelector('#segGranularidade .seg-btn.active')?.dataset.gran || 'mes';

  // ── Formata labels por granularidade ──────────────────────
  const MN = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  function fmtLabel(s) {
    if (!s) return '';
    if (gran === 'hora') {
      const m = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2})/);
      return m ? `${m[3]}/${m[2]} ${m[4]}h` : s;
    }
    if (gran === 'dia') {
      const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
      return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : s;
    }
    if (gran === 'mes') {
      const p = s.split('-');
      return p.length >= 2 ? `${MN[parseInt(p[1])-1] ?? ''} ${p[0]}` : s;
    }
    return s; // ano
  }

  const labels    = d.map(r => fmtLabel(r.mes));
  const manyPts   = d.length > 120;
  const fewPts    = d.length <= 10;   // ano a ano ou ${tx.period} muito curto
  const ptRadius  = manyPts ? 0 : fewPts ? 5 : 2;   // pontos maiores quando há poucos
  const ptHover   = manyPts ? 4 : fewPts ? 8 : 5;
  const lineWidth = manyPts ? 1.5 : fewPts ? 2.5 : 2;
  const maxTicks  = { hora: 24, dia: 31, mes: 18, ano: 10 }[gran] ?? 18;

  // ── Datasets ──────────────────────────────────────────────
  // spanGaps: true — conecta a linha através de ${tx.period}s sem dados (ex: sensor
  // instalado no meio do ano filtrado). Sem isso pontos isolados ficam desconectados.
  const allDS = [
    // IBRAM
    { id:'ibram_temp',  label:'Temp % (IBRAM)', data:d.map(r=>r.conf_temp_ibram  ??null),
      borderColor: COLORS.ibram(), backgroundColor: COLORS.igramFill(),
      fill:true,  tension:.3, pointRadius:ptRadius, pointHoverRadius:ptHover, borderWidth:lineWidth, spanGaps:true },
    { id:'ibram_ur',    label:'UR %   (IBRAM)', data:d.map(r=>r.conf_ur_ibram    ??null),
      borderColor: COLORS.bizot(), backgroundColor: COLORS.bizotFill(),
      fill:true,  tension:.3, pointRadius:ptRadius, pointHoverRadius:ptHover, borderWidth:lineWidth, spanGaps:true },
    { id:'ibram_total', label:'Total  (IBRAM)', data:d.map(r=>r.conf_total_ibram ??null),
      borderColor: COLORS.confHigh(), backgroundColor:'transparent',
      fill:false, tension:.3, pointRadius:fewPts?3:0, pointHoverRadius:ptHover, borderWidth:1.5, borderDash:[5,3], spanGaps:true },
    // MASP
    { id:'masp_temp',   label:'Temp % (MASP)',  data:d.map(r=>r.conf_temp_masp   ??null),
      borderColor: COLORS.ibram(), backgroundColor: COLORS.igramFill(),
      fill:true,  tension:.3, pointRadius:ptRadius, pointHoverRadius:ptHover, borderWidth:lineWidth, spanGaps:true },
    { id:'masp_ur',     label:'UR %   (MASP)',  data:d.map(r=>r.conf_ur_masp     ??null),
      borderColor: COLORS.masp(), backgroundColor: COLORS.maspFill(),
      fill:true,  tension:.3, pointRadius:ptRadius, pointHoverRadius:ptHover, borderWidth:lineWidth, spanGaps:true },
    { id:'masp_total',  label:'Total  (MASP)',  data:d.map(r=>r.conf_masp        ??null),
      borderColor: COLORS.confMed(), backgroundColor:'transparent',
      fill:false, tension:.3, pointRadius:fewPts?3:0, pointHoverRadius:ptHover, borderWidth:1.5, borderDash:[5,3], spanGaps:true },
    // Bizot
    { id:'bizot_temp',  label:'Temp % (Bizot)', data:d.map(r=>r.conf_temp_bizot  ??null),
      borderColor: COLORS.bizot(), backgroundColor: COLORS.bizotFill(),
      fill:false, tension:.3, pointRadius:ptRadius, pointHoverRadius:ptHover, borderWidth:lineWidth, spanGaps:true },
    { id:'bizot_ur',    label:'UR %   (Bizot)', data:d.map(r=>r.conf_ur_bizot    ??null),
      borderColor: COLORS.bizot(), backgroundColor: COLORS.bizotFill(),
      fill:false, tension:.3, pointRadius:ptRadius, pointHoverRadius:ptHover, borderWidth:lineWidth, spanGaps:true },
    { id:'bizot_total', label:'Total  (Bizot)', data:d.map(r=>r.conf_bizot       ??null),
      borderColor: COLORS.bizot(), backgroundColor:'transparent',
      fill:false, tension:.3, pointRadius:fewPts?3:0, pointHoverRadius:ptHover, borderWidth:1.5, borderDash:[5,3], spanGaps:true },
    // Todos (apenas totais)
    { id:'todos_ibram', label:'Total IBRAM',    data:d.map(r=>r.conf_total_ibram ??null),
      borderColor: COLORS.confHigh(), fill:false, tension:.3, pointRadius:fewPts?4:0, pointHoverRadius:ptHover, borderWidth:2, spanGaps:true },
    { id:'todos_masp',  label:'Total MASP',     data:d.map(r=>r.conf_masp        ??null),
      borderColor: COLORS.masp(), fill:false, tension:.3, pointRadius:fewPts?4:0, pointHoverRadius:ptHover, borderWidth:2, spanGaps:true },
    { id:'todos_bizot', label:'Total Bizot',    data:d.map(r=>r.conf_bizot       ??null),
      borderColor: COLORS.bizot(), fill:false, tension:.3, pointRadius:fewPts?4:0, pointHoverRadius:ptHover, borderWidth:2, spanGaps:true },
  ];

  const visMap = {
    ibram: ['ibram_temp','ibram_ur','ibram_total'],
    masp:  ['masp_temp', 'masp_ur', 'masp_total'],
    bizot: ['bizot_temp','bizot_ur','bizot_total'],
    todos: ['todos_ibram','todos_masp','todos_bizot'],
  };
  const datasets = allDS.filter(ds => (visMap[padrao] ?? visMap.ibram).includes(ds.id));

  // ── Eixo Y: garante que 70 e 90 fiquem sempre visíveis ───
  const allVals = datasets.flatMap(ds => ds.data).filter(v => v != null);
  const dataMin = allVals.length ? Math.min(...allVals) : 0;
  const dataMax = allVals.length ? Math.max(...allVals) : 100;
  const yMin = Math.max(0,   Math.floor((Math.min(dataMin, 65) - 2) / 5) * 5);
  const yMax = Math.min(100, Math.ceil( (Math.max(dataMax, 95) + 2) / 5) * 5);

  // ── Padrões para faixas de referência (label e cor) ──────
  const normaFaixas = {
    ibram: { tLabel:'T: 18–22°C', urLabel:'UR: 50–60%', tColor: COLORS.igramFill().replace(/[\d.]+\)$/, '0.12)'),  urColor: COLORS.blue().replace(/[\w#]/g, m => /[0-9a-f]/.test(m) ? m : '').slice(0, 7) + '1a)' },
    masp:  { tLabel:'T: 18–22°C', urLabel:'UR: 45–55%', tColor: COLORS.igramFill().replace(/[\d.]+\)$/, '0.12)'),  urColor: COLORS.maspFill().replace(/[\d.]+\)$/, '0.10)') },
    bizot: { tLabel:'T: 15–25°C', urLabel:'UR: 40–60%', tColor: COLORS.bizotFill().replace(/[\d.]+\)$/, '0.12)'), urColor: COLORS.bizotFill().replace(/[\d.]+\)$/, '0.12)') },
    todos: { tLabel:null,          urLabel:null,          tColor:null,                   urColor:null },
  };
  const faixa = normaFaixas[padrao] ?? normaFaixas.ibram;

  window._charts.cMensal = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, padding: 16 } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              return v == null ? null : ` ${ctx.dataset.label}: ${v}%`;
            },
            afterBody: ctx => {
              // Enriquece o tooltip com as exposições ativas neste ${tx.period}
              const i = ctx[0]?.dataIndex;
              if (i == null || !_exposicoesCache?.length) return [];
              const r = d[i];
              if (!r) return [];

              // Determina o intervalo deste ponto
              let labelIni, labelFim;
              if (gran === 'mes') {
                const [ano, mes] = r.mes.split('-');
                labelIni = `${ano}-${mes}-01`;
                const ultimoDia = new Date(parseInt(ano), parseInt(mes), 0).getDate();
                labelFim = `${ano}-${mes}-${String(ultimoDia).padStart(2,'0')}`;
              } else if (gran === 'dia') {
                labelIni = labelFim = r.mes;
              } else if (gran === 'ano') {
                labelIni = `${r.mes}-01-01`;
                labelFim = `${r.mes}-12-31`;
              } else {
                return [];
              }

              const d0 = new Date(labelIni), d1 = new Date(labelFim);
              const ativas = _exposicoesCache.filter(e => {
                const ei = new Date(e.inicio), ef = new Date(e.termino);
                return ei <= d1 && ef >= d0;
              });

              if (!ativas.length) return ['', '🔧 Sem exposição neste ${tx.period}'];
              const lines = [''];
              if (ativas.length === 1) {
                const e = ativas[0];
                const totalDias = Math.max(1, Math.round((d1 - d0) / 86400000) + 1);
                const expoIni = new Date(Math.max(d0, new Date(e.inicio)));
                const expoFim = new Date(Math.min(d1, new Date(e.termino)));
                const diasExpo = Math.round((expoFim - expoIni) / 86400000) + 1;
                const pct = Math.round(diasExpo / totalDias * 100);
                if (pct >= 100) {
                  lines.push(`🎨 ${tx.period} inteiramente expositivo`);
                } else {
                  lines.push(`⚠ ${tx.period} parcialmente expositivo (${pct}% dos dias)`);
                  lines.push(`   Montagem ou desmontagem em andamento`);
                }
              } else {
                lines.push(`🎨 ${ativas.length} exposições neste ${tx.period}`);
              }
              return lines;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: maxTicks, maxRotation: 45, font: { size: 10 } },
          grid: { color: '#e7e5e4' }
        },
        y: {
          min: yMin, max: yMax,
          ticks: { callback: v => v + '%', stepSize: 5 },
          grid: {
            color: ctx => {
              if (ctx.tick.value === 90) return COLORS.confHigh() + '66';
              if (ctx.tick.value === 70) return COLORS.confMed() + '4d';
              return '#e7e5e4';
            },
            lineWidth: ctx => (ctx.tick.value === 90 || ctx.tick.value === 70) ? 1.5 : 1,
          }
        }
      }
    },
    plugins: [{
      id: 'mensalOverlay',
      beforeDraw(chart) {
        const { ctx, chartArea: ca, scales: { x, y } } = chart;
        if (!ca) return;
        ctx.save();

        // ── Faixas de ${tx.period} expositivo — baseadas nas datas reais da tabela exposicoes ──
        // Usa _exposicoesCache (lista de {inicio, termino}) retornado pelo backend.
        // Classifica cada label do gráfico como: fora, parcialmente expositivo, ou totalmente expositivo.
        if (_exposicoesCache && _exposicoesCache.length) {
          labels.forEach((label, i) => {
            if (!label) return;

            // Determina o intervalo de datas que este label representa
            let labelIni, labelFim;
            if (gran === 'hora') {
              labelIni = label.replace(' ', 'T') + ':00:00';
              labelFim = label.replace(' ', 'T') + ':59:59';
            } else if (gran === 'dia') {
              labelIni = label;
              labelFim = label;
            } else if (gran === 'mes') {
              if (!d[i].mes) return; // Escudo
              const [ano, mes] = d[i].mes.split('-');
              labelIni = `${ano}-${mes}-01`;
              const ultimoDia = new Date(parseInt(ano), parseInt(mes), 0).getDate();
              labelFim = `${ano}-${mes}-${String(ultimoDia).padStart(2,'0')}`;
            } else { // ano
              labelIni = `${d[i].mes}-01-01`;
              labelFim = `${d[i].mes}-12-31`;
            }

            // Dias totais do ${tx.period} e dias em exposição
            const d0 = new Date(labelIni), d1 = new Date(labelFim);
            const totalDias = Math.max(1, Math.round((d1 - d0) / 86400000) + 1);
            let diasExpo = 0;

            for (const expo of _exposicoesCache) {
              const expoIni = new Date(expo.inicio);
              const expoFim = new Date(expo.termino);
              // Interseção do ${tx.period} com a exposição
              const overlapIni = new Date(Math.max(d0, expoIni));
              const overlapFim = new Date(Math.min(d1, expoFim));
              if (overlapIni <= overlapFim) {
                diasExpo += Math.round((overlapFim - overlapIni) / 86400000) + 1;
              }
            }
            diasExpo = Math.min(diasExpo, totalDias);

            if (diasExpo === 0) return; // sem exposição — sem sombreamento

            // Largura da barra deste ${tx.period} no canvas
            const xMid = x.getPixelForValue(i);
            const halfW = i === 0
              ? (x.getPixelForValue(1) - xMid) / 2
              : i === d.length - 1
                ? (xMid - x.getPixelForValue(i - 1)) / 2
                : Math.min(
                    (xMid - x.getPixelForValue(i - 1)) / 2,
                    (x.getPixelForValue(i + 1) - xMid) / 2
                  );
            const xLeft = xMid - halfW;
            const w = halfW * 2;

            if (gran === 'ano') {
              // Nível anual: sem sombreamento — quase todo ano tem ${tx.period} misto,
              // qualquer coloração vira ruído e dificulta a leitura das curvas.
            } else if (diasExpo >= totalDias) {
              // ${tx.period} inteiramente expositivo — fundo sólido suave
              ctx.fillStyle = COLORS.igramFill().replace(/[\d.]+\)$/, '0.05)');
              ctx.fillRect(xLeft, ca.top, w, ca.height);
            } else {
              // ${tx.period} parcialmente expositivo — listrado diagonal
              ctx.save();
              ctx.beginPath();
              ctx.rect(xLeft, ca.top, w, ca.height);
              ctx.clip();
              ctx.strokeStyle = COLORS.igramFill().replace(/[\d.]+\)$/, '0.15)');
              ctx.lineWidth = 3;
              const step = 7;
              for (let s = -ca.height; s < w + ca.height; s += step) {
                ctx.beginPath();
                ctx.moveTo(xLeft + s, ca.top);
                ctx.lineTo(xLeft + s + ca.height, ca.top + ca.height);
                ctx.stroke();
              }
              ctx.restore();
            }
          });
        }

        // ── Faixa verde: zona excelente (≥ 90%) ────────────
        const py90 = y.getPixelForValue(Math.min(yMax, 100));
        const py90b = y.getPixelForValue(90);
        if (py90b > ca.top) {
          ctx.fillStyle = COLORS.confHighFill();
          ctx.fillRect(ca.left, py90, ca.width, py90b - py90);
        }

        // ── Faixa âmbar: zona de atenção (70–90%) ──────────
        const py70 = y.getPixelForValue(70);
        if (py70 > py90b) {
          ctx.fillStyle = COLORS.confMedFill();
          ctx.fillRect(ca.left, py90b, ca.width, py70 - py90b);
        }

        // ── Linhas de referência 90% e 70% ─────────────────
        [
          { v:90, col: COLORS.confHigh(), lbl:'META 90%', align:'left'  },
          { v:70, col: COLORS.confMed(), lbl:'70%',       align:'right' },
        ].forEach(({ v, col, lbl, align }) => {
          if (v < yMin || v > yMax) return;
          const py = y.getPixelForValue(v);
          ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.moveTo(ca.left, py); ctx.lineTo(ca.right, py); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = col;
          ctx.font = 'bold 9px "DM Mono", monospace';
          const xPos = align === 'right' ? ca.right - 4 : ca.left + 4;
          ctx.textAlign = align === 'right' ? 'right' : 'left';
          ctx.fillText(lbl, xPos, py - 3);
          ctx.textAlign = 'left';
        });

        // Legenda movida para HTML — ver _renderMensalLegend() abaixo.
        // Remover a legenda do canvas elimina a sobreposição com as linhas
        // de dados na região 90–100% onde ficavam coladas.
        ctx.restore();
      }
    }]
  });

  // Atualiza legenda HTML abaixo do gráfico (fora do canvas, sem sobreposição)
  _renderMensalLegend(gran, faixa, _exposicoesCache);

}

// ── LEGENDA HTML DO GRÁFICO MENSAL ────────────────────────
/**
 * Renderiza a legenda do gráfico de conformidade temporal como um elemento
 * HTML posicionado fora do canvas — elimina sobreposição com linhas de dados.
 * O conteúdo varia por granularidade: no nível "ano", substitui o ícone de
 * "${tx.period} misto" por indicadores da faixa base de cobertura expositiva.
 */
function _renderMensalLegend(gran, faixa, exposicoes) {
  const el = document.getElementById('mensalExpoLegend');
  if (!el) return;
  const temExpo = exposicoes && exposicoes.length > 0;
  const items = [];

  // Faixas normativas (só quando padrão específico, não "todos")
  if (faixa && faixa.tLabel) {
    items.push(`<span class="mleg-item"><span class="mleg-sw" style="background:${faixa.tColor.replace(/[\d.]+\)$/, '0.65)')}"></span>${faixa.tLabel}</span>`);
    items.push(`<span class="mleg-item"><span class="mleg-sw" style="background:${faixa.urColor.replace(/[\d.]+\)$/, '0.65)')}"></span>${faixa.urLabel}</span>`);
  }

  // Linhas de referência
  items.push(`<span class="mleg-item"><span class="mleg-line" style="background:${COLORS.confHigh()}"></span>≥ 90% meta</span>`);
  items.push(`<span class="mleg-item"><span class="mleg-line" style="background:${COLORS.confMed()}"></span>70–90% atenção</span>`);

  // Exposição — não exibe legenda no nível anual (sem sombreamento nessa escala)
  if (temExpo && gran !== 'ano') {
    items.push(`<span class="mleg-item"><span class="mleg-sw" style="background:${COLORS.igramFill().replace(/[\d.]+\)$/, '0.15)')}"></span>🎨 Em exposição</span>`);
    items.push(`<span class="mleg-item"><span class="mleg-hatch"></span>⚠ ${tx.period} misto</span>`);
  }

  el.innerHTML = items.join('');
  el.style.display = 'flex';
}

// ── EXPORTAR GRÁFICO DE CONFORMIDADE TEMPORAL ─────────────
/**
 * Exporta o gráfico cMensal como PNG com fundo branco.
 *
 * O canvas do Chart.js é transparente; a composição abaixo:
 *   1. Cria um canvas temporário do mesmo tamanho
 *   2. Preenche fundo branco
 *   3. Copia o canvas do gráfico por cima
 *   4. Dispara o download com nome automático
 *
 * Nome do arquivo: MASP_Conformidade_<padrão>_<granularidade>_<dataIni>_<dataFim>.png
 */
function exportMensalChart() {
  const chartCanvas = document.getElementById('cMensal');
  if (!chartCanvas) { showToast('Gráfico não encontrado.', 'err'); return; }

  const btn = document.getElementById('btnExportMensal');
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

  try {
    // ── Coleta contexto dos filtros ativos ─────────────────
    const gran     = document.querySelector('#segGranularidade .seg-btn.active')?.dataset.gran || 'mes';
    const padrao   = document.querySelector('#segMensal .seg-btn.active')?.dataset.mensal || 'ibram';
    const f        = window._lastFilters || {};
    const dataIni  = f.data_ini || '';
    const dataFim  = f.data_fim || '';
    const pontos   = getSelectedPontos();  // usa função já existente no api.js
    const periodoBtn = document.querySelector('#fPeriodo .seg-btn.active')?.textContent?.trim() || 'Todos';

    // Labels legíveis
    const GRAN_LABEL  = { hora:'Hora a hora', dia:'Dia a dia', mes:'Mês a mês', ano:'Ano a ano' };
    const PADRAO_DESC = {
      ibram: 'IBRAM — 18–22°C / 50–60% UR',
      masp:  'MASP — 18–23°C / 45–55% UR',
      bizot: 'Bizot — 15–25°C / 40–60% UR',
      todos: 'Todos os padrões',
    };

    const periodoStr = (dataIni && dataFim) ? `${dataIni}  →  ${dataFim}` : '${tx.period} completo';
    const pontosStr  = pontos.length === 0
      ? 'Todos os pontos'
      : pontos.length <= 4
        ? pontos.join(' · ')
        : `${pontos.slice(0, 4).join(' · ')}  (+${pontos.length - 4})`;

    // ── Dimensões do canvas composto ──────────────────────
    // Usamos um fator de exportação fixo para garantir qualidade de impressão
    // independente do zoom ou resolução da tela.
    // Alvo: 2400px de largura (padrão para PDF A4 / apresentação).
    const SCREEN_W  = chartCanvas.width;   // largura física atual (CSS × devicePixelRatio)
    const EXPORT_W  = 2400;
    const XSCALE    = EXPORT_W / SCREEN_W; // ex: tela 1280px → XSCALE = 1.875
    const SCALE     = XSCALE;              // alias único — todo texto/padding usa esse valor

    const W        = EXPORT_W;
    const H_CHART  = Math.round(chartCanvas.height * XSCALE);
    const H_HEADER = Math.round(96  * SCALE);
    const H_LEGEND = Math.round(68  * SCALE);
    const H_TOTAL  = H_HEADER + H_CHART + H_LEGEND;
    const PAD      = Math.round(22 * SCALE);

    const tmp = document.createElement('canvas');
    tmp.width  = W;
    tmp.height = H_TOTAL;
    const ctx  = tmp.getContext('2d');

    // Fundo branco total
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H_TOTAL);

    // ── Cabeçalho ─────────────────────────────────────────
    // Faixa de topo preta (identidade MASP)
    ctx.fillStyle = COLORS.black();
    ctx.fillRect(0, 0, W, Math.round(3 * SCALE));

    // Logo
    ctx.font        = `500 ${Math.round(13 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle   = COLORS.black();
    ctx.fillText('MASP_', PAD, Math.round(22 * SCALE));

    // Linha de separação header / chart
    ctx.fillStyle = COLORS.grayBorder();
    ctx.fillRect(0, H_HEADER - Math.round(1 * SCALE), W, Math.round(1 * SCALE));

    // Col esquerda: padrão + granularidade
    const COL2 = Math.round(W * 0.42);
    ctx.font      = `500 ${Math.round(10 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle = COLORS.grayText();
    ctx.fillText('PADRÃO', PAD, Math.round(38 * SCALE));
    ctx.font      = `400 ${Math.round(11 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle = COLORS.textPrimary();
    ctx.fillText(PADRAO_DESC[padrao] || padrao.toUpperCase(), PAD, Math.round(52 * SCALE));

    ctx.font      = `500 ${Math.round(10 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle = COLORS.grayText();
    ctx.fillText('GRANULARIDADE', PAD, Math.round(68 * SCALE));
    ctx.font      = `400 ${Math.round(11 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle = COLORS.textPrimary();
    ctx.fillText(GRAN_LABEL[gran] || gran, PAD, Math.round(82 * SCALE));

    // Col central: ${tx.period}
    ctx.font      = `500 ${Math.round(10 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle = COLORS.grayText();
    ctx.fillText('${tx.period}', COL2, Math.round(38 * SCALE));
    ctx.font      = `400 ${Math.round(11 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle = COLORS.textPrimary();
    ctx.fillText(periodoStr, COL2, Math.round(52 * SCALE));

    ctx.font      = `500 ${Math.round(10 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle = COLORS.grayText();
    ctx.fillText('${tx.period} EXPOSITIVO', COL2, Math.round(68 * SCALE));
    ctx.font      = `400 ${Math.round(11 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle = COLORS.textPrimary();
    ctx.fillText(periodoBtn, COL2, Math.round(82 * SCALE));

    // Col direita: pontos
    const COL3 = Math.round(W * 0.72);
    ctx.font      = `500 ${Math.round(10 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle = COLORS.grayText();
    ctx.fillText('PONTOS SELECIONADOS', COL3, Math.round(38 * SCALE));
    ctx.font      = `400 ${Math.round(10 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle = COLORS.textPrimary();
    // Quebra manual se pontosStr for longo
    const maxW = W - COL3 - PAD;
    let pLine1 = '', pLine2 = '';
    const words = pontosStr.split(' · ');
    for (const w of words) {
      const candidate = pLine1 ? pLine1 + ' · ' + w : w;
      if (ctx.measureText(candidate).width < maxW) { pLine1 = candidate; }
      else { pLine2 = pLine2 ? pLine2 + ' · ' + w : w; }
    }
    ctx.fillText(pLine1, COL3, Math.round(52 * SCALE));
    if (pLine2) ctx.fillText(pLine2, COL3, Math.round(64 * SCALE));

    // ── Copia o gráfico ────────────────────────────────────
    ctx.drawImage(chartCanvas, 0, H_HEADER, W, H_CHART);

    // ── Legenda em duas linhas ──────────────────────────────
    // Linha 1: datasets do gráfico (puxados direto do Chart.js)
    // Linha 2: linhas de referência + contexto expositivo
    const FONT_LEG = Math.round(9.5 * SCALE);
    const LH       = Math.round(20 * SCALE);   // altura de cada linha de legenda
    const LEGEND_Y = H_HEADER + H_CHART + Math.round(8 * SCALE);
    const SW       = Math.round(18 * SCALE);   // largura do swatch de linha
    const SH       = Math.round(2.5 * SCALE);  // espessura da linha de amostra
    const GAP      = Math.round(22 * SCALE);   // espaço entre itens
    const DOT_R    = Math.round(4 * SCALE);    // raio do dot de fora-da-zona

    ctx.font = `400 ${FONT_LEG}px "DM Mono", monospace`;

    // ── HELPER: desenha um item de legenda e avança lx ─────
    function _drawLegItem(lx, ly, item) {
      ctx.save();
      const { type, color, dash, text, fillBox } = item;

      if (fillBox) {
        // Caixa preenchida (exposição, zona segura)
        ctx.fillStyle = fillBox;
        ctx.fillRect(lx, ly - Math.round(8 * SCALE), SW, Math.round(10 * SCALE));
        if (item.borderBottom) {
          ctx.fillStyle = item.borderBottom;
          ctx.fillRect(lx, ly + Math.round(2 * SCALE), SW, Math.round(3 * SCALE));
        }
      } else if (type === 'line') {
        // Linha colorida (sólida ou tracejada)
        ctx.strokeStyle = color;
        ctx.lineWidth   = Math.round((item.lw || 2) * SCALE);
        if (dash) ctx.setLineDash(dash.map(v => Math.round(v * SCALE)));
        ctx.beginPath();
        ctx.moveTo(lx, ly - Math.round(3 * SCALE));
        ctx.lineTo(lx + SW, ly - Math.round(3 * SCALE));
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (type === 'dot') {
        // Ponto vermelho (fora da zona)
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(lx + SW / 2, ly - Math.round(3 * SCALE), DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = COLORS.grayText();
      ctx.font      = `400 ${FONT_LEG}px "DM Mono", monospace`;
      ctx.fillText(text, lx + SW + Math.round(5 * SCALE), ly);
      ctx.restore();
      return lx + SW + Math.round(5 * SCALE) + ctx.measureText(text).width + GAP;
    }

    // ── LINHA 1: datasets do gráfico (cor + nome da série) ─
    // Fonte autoritativa: window._charts.cMensal.data.datasets
    const chartInst  = window._charts && window._charts.cMensal;
    const row1Items  = [];

    if (chartInst && chartInst.data && chartInst.data.datasets) {
      chartInst.data.datasets.forEach(ds => {
        if (ds.label && !ds.label.startsWith('_')) {
          row1Items.push({
            type:  'line',
            color: ds.borderColor  || '#8c8278',
            dash:  ds.borderDash   || null,
            lw:    ds.borderWidth  || 0.5,
            text:  ds.label,
          });
        }
      });
    }

    // Fallback se instância Chart.js não disponível
    if (!row1Items.length) {
      const PADRAO_LINES = {
        ibram: [['Temp % (IBRAM)', COLORS.ibram(),null], ['UR % (IBRAM)', COLORS.blue(),null], ['Total (IBRAM)', COLORS.confHigh(),[5,3]]],
        masp:  [['Temp % (MASP)', COLORS.ibram(),null],  ['UR % (MASP)', COLORS.masp(),null],  ['Total (MASP)', COLORS.confMed(),[5,3]]],
        bizot: [['Temp % (Bizot)','rgba(139,92,246,.75)',null], ['UR % (Bizot)', COLORS.bizot(),null], ['Total (Bizot)','#4f46e5',[5,3]]],
        todos: [['Total IBRAM', COLORS.confHigh(),null], ['Total MASP', COLORS.masp(),null], ['Total Bizot', COLORS.bizot(),null]],
      };
      (PADRAO_LINES[padrao] || []).forEach(([t,c,d]) => row1Items.push({ type:'line', color:c, dash:d, lw:2, text:t }));
    }

    let lx1 = PAD;
    const ly1 = LEGEND_Y + LH * 0;
    row1Items.forEach(item => { lx1 = _drawLegItem(lx1, ly1, item); });

    // ── LINHA 2: referências + exposição ───────────────────
    const row2Items = [
      { type:'line', color:'#16a34a', dash:[5,3], lw:1.5, text:'≥ 90% meta' },
      { type:'line', color:'#d97706', dash:[5,3], lw:1.5, text:'70% atenção' },
      { type:'dot',  color:'rgba(227,6,19,0.65)', text:'Fora da zona' },
    ];

    // Exposição: sem indicador no nível anual (sem sombreamento nessa escala)
    const temExpo = _exposicoesCache && _exposicoesCache.length > 0;
    if (temExpo && gran !== 'ano') {
      row2Items.push({ fillBox:'rgba(227,6,19,0.08)', text:'Em exposição' });
      row2Items.push({ fillBox:'rgba(227,6,19,0.04)', text:'${tx.period} misto', _hatch: true });
    }

    let lx2 = PAD;
    const ly2 = LEGEND_Y + LH;
    row2Items.forEach(item => {
      if (item._hatch) {
        // Swatch listrado para ${tx.period} misto
        ctx.save();
        ctx.beginPath();
        ctx.rect(lx2, ly2 - Math.round(8 * SCALE), SW, Math.round(10 * SCALE));
        ctx.clip();
        ctx.fillStyle = '#fff';
        ctx.fillRect(lx2, ly2 - Math.round(8 * SCALE), SW, Math.round(10 * SCALE));
        ctx.strokeStyle = 'rgba(227,6,19,.35)';
        ctx.lineWidth = Math.round(2 * SCALE);
        for (let s = -10; s < SW + 10; s += Math.round(4 * SCALE)) {
          ctx.beginPath();
          ctx.moveTo(lx2 + s, ly2 - Math.round(8 * SCALE));
          ctx.lineTo(lx2 + s + Math.round(10 * SCALE), ly2 + Math.round(2 * SCALE));
          ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = '#3d3630';
        ctx.font      = `400 ${FONT_LEG}px "DM Mono", monospace`;
        ctx.fillText(item.text, lx2 + SW + Math.round(5 * SCALE), ly2);
        lx2 += SW + Math.round(5 * SCALE) + ctx.measureText(item.text).width + GAP;
      } else {
        lx2 = _drawLegItem(lx2, ly2, item);
      }
    });

    // Linha separadora legenda/rodapé
    ctx.fillStyle = '#e8e4de';
    ctx.fillRect(PAD, LEGEND_Y + LH * 2 + Math.round(4 * SCALE), W - PAD * 2, Math.round(0.5 * SCALE));

    // Rodapé: data de geração
    ctx.font      = `400 ${Math.round(8 * SCALE)}px "DM Mono", monospace`;
    ctx.fillStyle = '#b0a99f';
    const rodape  = `Gerado em ${new Date().toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' })}  ·  MASP — Sistema de Monitoramento de Climatização`;
    ctx.textAlign = 'right';
    ctx.fillText(rodape, W - PAD, LEGEND_Y + LH * 2 + Math.round(16 * SCALE));
    ctx.textAlign = 'left';

    // ── Download ───────────────────────────────────────────
    const ini    = dataIni.replace(/-/g, '');
    const fim    = dataFim.replace(/-/g, '');
    const sufixo = [ini, fim].filter(Boolean).join('_');
    const nome   = `MASP_Conformidade_${padrao.toUpperCase()}_${gran}${sufixo ? '_' + sufixo : ''}.png`;

    const link = document.createElement('a');
    link.href     = tmp.toDataURL('image/png');
    link.download = nome;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast(`✓ Exportado como ${nome}`);
  } catch (e) {
    showToast('✗ Não foi possível exportar: ' + e.message, 'err');
    console.error('exportMensalChart:', e);
  } finally {
    if (btn) { btn.textContent = '↓ PNG'; btn.disabled = false; }
  }
}

let _sensoresCache = [];

function getActiveSensoresPadrao() {
  return document.querySelector('#segSensores .seg-btn.active')?.dataset.sensores || 'ibram';
}

function renderSensores() {
  const padrao  = getActiveSensoresPadrao();
  const canvas  = document.getElementById('cSensores');
  if (!canvas || !_sensoresCache.length) return;
  if (window._charts?.cSensores) window._charts.cSensores.destroy();

  // Campos e cores por padrão — cores unificadas da paleta
  const cfg = {
    ibram: { temp: 'conf_temp_ibram', ur: 'conf_ur_ibram',
             corTemp: COLORS.igramFill().replace(/[\d.]+\)$/, '0.75)'), corUr: COLORS.bizotFill().replace(/[\d.]+\)$/, '0.75)'),
             labelTemp: 'Temperatura % (IBRAM)', labelUr: 'UR % (IBRAM)' },
    masp:  { temp: 'conf_temp_masp',  ur: 'conf_ur_masp',
             corTemp: COLORS.igramFill().replace(/[\d.]+\)$/, '0.75)'), corUr: COLORS.maspFill().replace(/[\d.]+\)$/, '0.8)'),
             labelTemp: 'Temperatura % (MASP)',  labelUr: 'UR % (MASP)' },
    bizot: { temp: 'conf_temp_bizot', ur: 'conf_ur_bizot',
             corTemp: 'rgba(139,92,246,.75)', corUr: COLORS.bizotFill().replace(/[\d.]+\)$/, '0.75)'),
             labelTemp: 'Temperatura % (Bizot)', labelUr: 'UR % (Bizot)' },
  }[padrao];

  const sorted = [..._sensoresCache].sort((a, b) => (a[cfg.ur] || 0) - (b[cfg.ur] || 0));

  window._charts.cSensores = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: sorted.map(p => p.ponto),
      datasets: [
        { label: cfg.labelTemp, data: sorted.map(p => p[cfg.temp]),
          backgroundColor: cfg.corTemp, borderRadius: 2 },
        { label: cfg.labelUr,   data: sorted.map(p => p[cfg.ur]),
          backgroundColor: cfg.corUr,   borderRadius: 2 },
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { min: 0, max: 100,
          ticks: { callback: v => v + '%' },
          grid: { color: ctx => ctx.tick.value === 90 ? COLORS.confHigh() + '59' : '#e7e5e4' }
        },
        y: { ticks: { font: { size: 11 } }, grid: { display: false } }
      }
    },
    plugins: [{
      id: 'meta90',
      afterDraw(chart) {
        const { ctx, scales: { x } } = chart;
        const px = x.getPixelForValue(90);
        ctx.save();
        ctx.strokeStyle = COLORS.confHigh(); ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
        ctx.beginPath(); ctx.moveTo(px, chart.chartArea.top); ctx.lineTo(px, chart.chartArea.bottom); ctx.stroke();
        ctx.fillStyle = COLORS.confHigh(); ctx.font = '9px "DM Mono", monospace';
        ctx.fillText('90%', px + 3, chart.chartArea.top + 12);
        ctx.restore();
      }
    }]
  });
}

// Cache dos dados agregados por hora vindos do endpoint /api/horario.
// Estrutura: { ibram: {}, masp: {}, bizot: {} }
// Cada entrada: { ponto?: string, data: [{hora, nc_temp, nc_ur, n}] }
let _horarioCache = {};

// Labels das faixas exibidas na legenda — consumidas pela UI
const _horarioLabels = {
  ibram: { labelTemp: '% fora da Temp (18–22°C)', labelUr: '% fora da UR (50–60%)' },
  masp:  { labelTemp: '% fora da Temp (18–23°C)', labelUr: '% fora da UR (45–55%)' },
  bizot: { labelTemp: '% fora da Temp (15–25°C)', labelUr: '% fora da UR (40–60%)' },
};

/**
 * Busca os dados agregados do endpoint para o padrão e sensor dados,
 * armazena em _horarioCache e renderiza o gráfico.
 * Chamada ao trocar padrão, trocar sensor ou ao aplicar filtros.
 */
async function loadHorario(filters = {}) {
  const canvas = document.getElementById('cHorario');
  if (!canvas) return;

  const padrao      = document.querySelector('#segHorario .seg-btn.active')?.dataset.horario || 'ibram';
  const sensorFiltro = document.getElementById('selHorarioSensor')?.value || '';

  try {
    const params = { ...filters, padrao };
    if (sensorFiltro) params.ponto = sensorFiltro;
    const dados = await API.get('horario', params);
    _horarioCache = dados;   // [{hora, nc_temp, nc_ur, n}]
    renderHorario();
  } catch (e) {
    console.warn('loadHorario:', e);
  }
}

function renderHorario() {
  const canvas = document.getElementById('cHorario');
  if (!canvas || !_horarioCache.length) return;
  if (window._charts?.cHorario) window._charts.cHorario.destroy();

  const padrao = document.querySelector('#segHorario .seg-btn.active')?.dataset.horario || 'ibram';
  const faixas = _horarioLabels[padrao] || _horarioLabels.ibram;

  // Monta arrays indexados por hora (0–23); horas sem dados ficam null
  const ncTemp = Array(24).fill(null);
  const ncUr   = Array(24).fill(null);
  _horarioCache.forEach(r => {
    const h = r.hora;
    if (h >= 0 && h <= 23) {
      ncTemp[h] = r.nc_temp ?? null;
      ncUr[h]   = r.nc_ur   ?? null;
    }
  });

  const labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}h`);

  window._charts.cHorario = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: faixas.labelUr,   data: ncUr,
          backgroundColor: COLORS.bizotFill().replace(/[\d.]+\)$/, '0.7)'), borderRadius: 2 },
        { label: faixas.labelTemp, data: ncTemp,
          backgroundColor: COLORS.igramFill().replace(/[\d.]+\)$/, '0.6)'), borderRadius: 2 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top' },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y ?? '–'}%` } }
      },
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { display: false } },
        y: { min: 0, max: 100, ticks: { callback: v => v + '%' }, grid: { color: '#e7e5e4' } }
      }
    }
  });
}

// Cache das exposições reais para o sombreamento do gráfico temporal
let _exposicoesCache = [];

async function loadMensal(filters = {}) {
  const gran = document.querySelector('#segGranularidade .seg-btn.active')?.dataset.gran || 'mes';
  const resp = await API.get('agregado', { ...filters, granularidade: gran });

  // Suporta tanto o formato novo {dados, exposicoes} quanto o formato legado (array direto)
  const dados     = Array.isArray(resp) ? resp : (resp?.dados ?? []);
  const exposicoes = Array.isArray(resp) ? [] : (resp?.exposicoes ?? []);

  if (!dados?.length) return;

  _mensalCache     = dados;
  _exposicoesCache = exposicoes;

  const el = document.getElementById('mensalSubtitle');
  if (el) el.textContent = ({
    hora: '% de medições dentro das faixas — hora a hora',
    dia:  '% de medições dentro das faixas — dia a dia',
    mes:  '% de medições dentro das faixas — mês a mês',
    ano:  '% de medições dentro das faixas — ano a ano',
  })[gran] ?? '% de medições dentro das faixas';

  renderMensal();

  // ── Gráfico horário ──
  const cHorario = document.getElementById('cHorario');
  if (cHorario) {
    try {
      const sel = document.getElementById('selHorarioSensor');
      if (sel) {
        const nomes = (_pontosCache.length ? _pontosCache : [])
          .map(p => p.ponto || p.nome).filter(Boolean).sort();
        sel.innerHTML = '<option value="">Todos os sensores</option>' +
          nomes.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
      }
      await loadHorario(filters);
    } catch (e) { console.warn('cHorario:', e); }
  }

  // ── Dispersão T×UR ──
  const cDisp = document.getElementById('cDispersao');
  if (cDisp) {
    if (window._charts?.cDispersao) window._charts.cDispersao.destroy();
    try {
      const dispersao = await API.get('dispersao', filters);

      if (dispersao.length) {
        const maxN = Math.max(...dispersao.map(d => d.n));

        window._charts.cDispersao = new Chart(cDisp, {
          type: 'scatter',
          data: {
            datasets: [{
              label: 'Densidade de leituras',
              data: dispersao.map(d => ({ x: d.t, y: d.ur, n: d.n })),
              backgroundColor: dispersao.map(d => {
                const alpha = Math.max(0.08, Math.min(0.88, d.n / maxN * 4));
                const inside = d.t >= 18 && d.t <= 22 && d.ur >= 50 && d.ur <= 60;
                const color = inside ? COLORS.bizot() : COLORS.ibram();
                return color.slice(0, -1) + `, ${alpha})`;
              }),
              pointRadius: dispersao.map(d => Math.max(3, Math.min(14, Math.sqrt(d.n / maxN) * 16))),
              pointHoverRadius: 16,
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: {
                label: ctx => {
                  const d = dispersao[ctx.dataIndex];
                  return `T=${d.t}°C  UR=${d.ur}%  (${d.n.toLocaleString('pt-BR')} leituras)`;
                }
              }}
            },
            scales: {
              x: { min: 13, max: 30,
                title: { display: true, text: 'TEMPERATURA (°C)', font: { family: "'DM Mono', monospace", size: 10 }, color: '#a8a29e' },
                ticks: { callback: v => v + '°C' },
                grid: { color: '#e7e5e4' }
              },
              y: { min: 25, max: 85,
                title: { display: true, text: 'UR (%)', font: { family: "'DM Mono', monospace", size: 10 }, color: '#a8a29e' },
                ticks: { callback: v => v + '%' },
                grid: { color: '#e7e5e4' }
              }
            }
          },
          plugins: [{
            id: 'zonaIbramDisp',
            afterDraw(chart) {
              const { ctx, scales: { x, y } } = chart;
              const x1 = x.getPixelForValue(18), x2 = x.getPixelForValue(22);
              const y1 = y.getPixelForValue(60), y2 = y.getPixelForValue(50);
              ctx.save();
              ctx.strokeStyle = COLORS.ibram(); ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
              ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
              ctx.fillStyle = COLORS.igramFill().replace(/[\d.]+\)$/, '0.05)');
              ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
              ctx.setLineDash([]);
              ctx.fillStyle = COLORS.ibram(); ctx.font = 'bold 9px "DM Mono", monospace';
              ctx.fillText('IBRAM', x1 + 4, y1 + 12);
              ctx.restore();
            }
          }]
        });
      }
    } catch(e) { console.warn('cDispersao:', e); }
  }
}

// ── SAZONAL ───────────────────────────────────────────────
let _sazonalCache = [];

function renderSazonal() {
  const canvas = document.getElementById('cSazonal');
  if (!canvas || !_sazonalCache.length) return;
  if (window._charts?.cSazonal) window._charts.cSazonal.destroy();

  const campo   = document.querySelector('#segSazonalCampo .seg-btn.active')?.dataset.sazonal || 'temp';
  const padrao  = document.querySelector('#segSazonalPadrao .seg-btn.active')?.dataset.padraoSazonal || 'ibram';
  const isTemp  = campo === 'temp';
  const pfx     = isTemp ? 'temp' : 'ur';
  const unidade = isTemp ? '°C'   : '%';

  const faixas = {
    ibram: { tempMin: 18, tempMax: 22, urMin: 50, urMax: 60, label: 'IBRAM' },
    masp:  { tempMin: 18, tempMax: 23, urMin: 45, urMax: 55, label: 'MASP'  },
    bizot: { tempMin: 15, tempMax: 25, urMin: 40, urMax: 60, label: 'Bizot' },
  }[padrao];
  const faixaMin    = isTemp ? faixas.tempMin : faixas.urMin;
  const faixaMax    = isTemp ? faixas.tempMax : faixas.urMax;
  const padraoLabel = faixas.label;

  const estacoes = ['Verão', 'Outono', 'Inverno', 'Primavera'];

  const get = (estacao, tipo, sufixo) => {
    const r = _sazonalCache.find(d => d.estacao === estacao && d.tipo === tipo);
    return r ? r[`${pfx}_${sufixo}`] : null;
  };

  // Constrói os 6 datasets:
  // banda inferior interno (p25), banda superior interno (p75) → área preenchida
  // linha mediana interno
  // idem para externo
  const labels = estacoes;

  const bandaIntP25  = estacoes.map(e => get(e, 'interno', 'p25'));
  const bandaIntP75  = estacoes.map(e => get(e, 'interno', 'p75'));
  const medianaInt   = estacoes.map(e => get(e, 'interno', 'p50'));
  const bandaExtP25  = estacoes.map(e => get(e, 'externo', 'p25'));
  const bandaExtP75  = estacoes.map(e => get(e, 'externo', 'p75'));
  const medianaExt   = estacoes.map(e => get(e, 'externo', 'p50'));

  // Tooltips ricos por ponto
  const tooltipInt = estacoes.map(e => ({
    p25: get(e,'interno','p25'), p50: get(e,'interno','p50'),
    p75: get(e,'interno','p75'), min: get(e,'interno','min'),
    max: get(e,'interno','max'), media: get(e,'interno','media'),
  }));
  const tooltipExt = estacoes.map(e => ({
    p25: get(e,'externo','p25'), p50: get(e,'externo','p50'),
    p75: get(e,'externo','p75'), min: get(e,'externo','min'),
    max: get(e,'externo','max'), media: get(e,'externo','media'),
  }));

  window._charts.cSazonal = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        // ── Banda IQR interno (p25→p75 preenchido) ──
        { label: '_int_p75', data: bandaIntP75,
          borderColor: 'transparent', backgroundColor: COLORS.igramFill().replace(/[\d.]+\)$/, '0.12)'),
          fill: '+1', pointRadius: 0, tension: .3, order: 4 },
        { label: '_int_p25', data: bandaIntP25,
          borderColor: 'transparent', backgroundColor: COLORS.igramFill().replace(/[\d.]+\)$/, '0.12)'),
          fill: false, pointRadius: 0, tension: .3, order: 5 },
        // ── Mediana interno ──
        { label: 'Interno — mediana',
          data: medianaInt,
          borderColor: COLORS.ibram(), backgroundColor: COLORS.ibram(),
          borderWidth: 2.5, pointRadius: 5, pointHoverRadius: 7,
          tension: .3, fill: false, order: 2 },
        // ── Banda IQR externo (p25→p75 preenchido) ──
        { label: '_ext_p75', data: bandaExtP75,
          borderColor: 'transparent', backgroundColor: COLORS.bizotFill().replace(/[\d.]+\)$/, '0.12)'),
          fill: '+1', pointRadius: 0, tension: .3, order: 6 },
        { label: '_ext_p25', data: bandaExtP25,
          borderColor: 'transparent', backgroundColor: COLORS.bizotFill().replace(/[\d.]+\)$/, '0.12)'),
          fill: false, pointRadius: 0, tension: .3, order: 7 },
        // ── Mediana externo ──
        { label: `Externo (${window._sensorExterno || 'Térreo'}) — mediana`,
          data: medianaExt,
          borderColor: COLORS.bizot(), backgroundColor: COLORS.bizot(),
          borderWidth: 2.5, pointRadius: 5, pointHoverRadius: 7,
          tension: .3, fill: false, order: 3 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            filter: item => !item.text.startsWith('_'),  // oculta bandas da legenda
          }
        },
        tooltip: {
          filter: item => !item.dataset.label.startsWith('_'),
          callbacks: {
            label: ctx => {
              const isInt = ctx.dataset.label.includes('Interno');
              const d = isInt ? tooltipInt[ctx.dataIndex] : tooltipExt[ctx.dataIndex];
              if (!d || d.p50 == null) return null;
              const lbl = isInt ? 'Interno' : 'Externo';
              return [
                `${lbl}`,
                `  Mediana: ${d.p50}${unidade}`,
                `  IQR (25–75%): ${d.p25}–${d.p75}${unidade}`,
                `  Min / Max: ${d.min} / ${d.max}${unidade}`,
                `  Média: ${d.media}${unidade}`,
              ];
            },
            title: ctx => ctx[0]?.label || '',
          }
        }
      },
      scales: {
        x: { grid: { color: '#e7e5e4' } },
        y: {
          ticks: { callback: v => v + unidade },
          grid: {
            color: ctx =>
              ctx.tick.value === faixaMin || ctx.tick.value === faixaMax
                ? COLORS.igramFill().replace(/[\d.]+\)$/, '0.35)') : '#e7e5e4'
          }
        }
      }
    },
    plugins: [{
      id: 'faixasIbram',
      afterDraw(chart) {
        const { ctx, scales: { y }, chartArea } = chart;
        ctx.save();
        // Área de conformidade IBRAM preenchida levemente
        const y1 = y.getPixelForValue(faixaMax);
        const y2 = y.getPixelForValue(faixaMin);
        ctx.fillStyle = COLORS.confHighFill().replace(/[\d.]+\)$/, '0.04)');
        ctx.fillRect(chartArea.left, y1, chartArea.right - chartArea.left, y2 - y1);
        // Labels das linhas de referência
        [faixaMin, faixaMax].forEach(v => {
          const py = y.getPixelForValue(v);
          ctx.strokeStyle = COLORS.igramFill().replace(/[\d.]+\)$/, '0.4)');
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(chartArea.left, py);
          ctx.lineTo(chartArea.right, py);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = COLORS.ibram();
          ctx.font = '9px "DM Mono", monospace';
          ctx.fillText(`${padraoLabel} ${v}${unidade}`, chartArea.left + 4, py - 3);
        });
        ctx.restore();
      }
    }]
  });
}

async function loadSazonal(filters = {}) {
  try {
    const externo = window._sensorExterno || 'Térreo';
    // Sazonal usa o histórico completo — ignora filtros de data e de ponto
    // porque precisa de múltiplos anos e múltiplos sensores para mostrar
    // padrões sazonais representativos. Só respeita periodo_expositivo.
    const params = { externo };
    if (filters.periodo_expositivo) params.periodo_expositivo = filters.periodo_expositivo;
    const dados = await API.get('sazonal', params);
    if (!dados.length) return;
    _sazonalCache = dados;
    renderSazonal();
  } catch(e) { console.warn('cSazonal:', e); }
}

// ── EXPOSIÇÕES ────────────────────────────────────────────
async function loadExposicoes() {
  const expos = await API.get('exposicoes');
  const tb = document.getElementById('tExposicoes');
  if (tb) tb.innerHTML = expos.map(e => {
    const maspPct = e.conf_masp ?? e.conf_total_ibram ?? 0;
    const cls = maspPct>=80?'badge-green':maspPct>=70?'badge-amber':'badge-red';
    const lbl = maspPct>=75?'Excelente':maspPct>=60?'Bom':'Atenção';
    return `<tr>
      <td><strong>${escapeHtml(e.nome)}</strong></td>
      <td style="font-family:var(--mono);font-size:.75rem">${e.data_inicio||'–'} / ${e.data_fim||'–'}</td>
      <td>${escapeHtml(e.espacos)||'–'}</td>
      <td>${(e.medicoes||0).toLocaleString('pt-BR')}</td>
      <td>${badgeFor(e.conf_bizot ?? e.conf_total_ibram)}</td>
      <td>${badgeFor(e.conf_masp)}</td>
      <td>${badgeFor(e.conf_bizot)}</td>
      <td><span class="badge ${cls}">${lbl}</span></td>
    </tr>`;
  }).join('');

  const canvas = document.getElementById('cExpoComp');
  if (canvas && expos.length) {
    if (window._charts?.cExpoComp) window._charts.cExpoComp.destroy();
    window._charts.cExpoComp = new Chart(canvas, {
      type: 'bar',
      data: { labels: expos.map(e => e.nome), datasets: [
        { label: 'Total IBRAM', data: expos.map(e => e.conf_total_ibram ?? e.conf_bizot),
          backgroundColor: COLORS.confHighFill(), borderColor: COLORS.confHigh(), borderWidth:1 },
        { label: 'Total MASP',  data: expos.map(e => e.conf_masp),
          backgroundColor: COLORS.maspFill(), borderColor: COLORS.masp(), borderWidth:1 },
        { label: 'Total Bizot', data: expos.map(e => e.conf_bizot),
          backgroundColor: COLORS.bizotFill(), borderColor: COLORS.bizot(), borderWidth:1 }
      ]},
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top' } },
        scales: {
          x: { ticks: { maxRotation: 30 }, grid: { display: false } },
          y: { min: 0, max: 100, ticks: { callback: v => v + '%' }, grid: { color: '#e7e5e4' } }
        }
      }
    });
  }
}

// ── ALERTAS ───────────────────────────────────────────────
async function loadAlertas(filters = {}) {
  let alertas = [];
  try {
    alertas = await API.get('alertas', filters);
    if (!alertas.length) alertas = await API.get('alertas/calcular', filters);
  } catch { try { alertas = await API.get('alertas/calcular', filters); } catch {} }

  window._currentAlertas = alertas;

  const pill = document.getElementById('alertPill');
  if (pill) pill.textContent = alertas.length;
  const list = document.getElementById('alertList');
  if (list) {
    // Formata um timestamp para DD/MM/AAAA e HH:MM separados
    function fmtDt(dt) {
      if (!dt) return { data: null, hora: null };
      const s = String(dt);
      const data = s.substring(0, 10);
      const hora = s.substring(11, 16) || null;
      const [ano, mes, dia] = data.split('-');
      return { data: `${dia}/${mes}/${ano}`, hora };
    }

    list.innerHTML = alertas.map(a => {
      const dtIniRaw = a.data_inicio || a.dia || null;
      const dtFimRaw = a.data_fim    || null;
      const ini = fmtDt(dtIniRaw);
      const fim = fmtDt(dtFimRaw);

      // Monta a linha de quando/onde
      // Formato: "05/07/2025 — variou entre 14:30 e 14:31"
      // ou só "05/07/2025" se não houver hora
      let quando = ini.data || '–';
      if (ini.hora && fim.hora && ini.hora !== fim.hora) {
        quando += ` — entre ${ini.hora} e ${fim.hora}`;
      } else if (ini.hora) {
        quando += ` às ${ini.hora}`;
      }

      // Localização: andar · prédio
      const andar  = a.andar  ? escapeHtml(a.andar)  : '';
      const predio = a.predio ? escapeHtml(a.predio)  : '';
      const local  = [andar, predio].filter(Boolean).join(' · ');

      // Variação de UR — suporta tanto /api/alertas quanto /api/alertas/calcular
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

      const expositivo = a.periodo_expositivo
        ? '<span style="color:#E30613;font-weight:600">🎨 ${tx.period} expositivo</span>'
        : '<span style="color:var(--gray-400)">fora do ${tx.period} expositivo</span>';

      return `<div class="alert-item">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
          <strong style="font-size:.88rem">${escapeHtml(a.ponto)}</strong>
          ${local ? `<span style="font-family:var(--mono);font-size:.7rem;color:var(--gray-400)">${local}</span>` : ''}
        </div>
        <div style="margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-family:var(--mono);font-size:.78rem;color:var(--gray-600)">
            📅 ${quando}
          </span>
          <span style="font-family:var(--mono);font-size:.82rem;font-weight:700;color:${dirCor}">
            ${dir} ${variacao} p.p.
          </span>
          <span style="font-family:var(--mono);font-size:.78rem;color:var(--gray-500)">
            UR: ${urI}% → ${urF}%
          </span>
        </div>
        <div style="margin-top:3px;font-size:.75rem">${expositivo}</div>
      </div>`;
    }).join('') || '<p style="color:var(--gray-300);font-size:.8rem;padding:8px">Nenhum alerta.</p>';
  }

  buildHeatmap(alertas);
  buildAlertCharts(alertas);
}

// ── GRÁFICOS DE ALERTAS — calculados dos dados já carregados ──
function buildAlertCharts(alertas) {

  // Mostra/esconde o card
  const card = document.getElementById('cardAlertasMarcadores');
  if (card) card.style.display = alertas.length ? '' : 'none';
  if (!alertas.length) return;

  const canvas = document.getElementById('cAlertasMarcadores');
  if (!canvas) return;
  if (window._charts.cAlertasMarcadores) window._charts.cAlertasMarcadores.destroy();

  // Busca a série de UR do ${tx.period} atual via API para a linha de fundo.
  // Usa /api/amplitude que já agrega por sensor/dia — pegamos a média de UR por dia
  // de todos os sensores (ou dos filtrados via _lastFilters).
  const f = window._lastFilters || {};
  API.get('mensal', f).then(dados => {
    if (!dados.length) return;

    // Usamos os dados mensais para a linha de UR — simples e leve
    const labels  = dados.map(r => r.mes);
    const urData  = dados.map(r => r.ur_med ?? r.ur_media ?? null);

    // Agrupa alertas por mês para os marcadores
    const alertasPorMes = {};
    alertas.forEach(a => {
      const mes = (a.data_inicio || a.dia || '').substring(0, 7);
      if (!mes) return;
      if (!alertasPorMes[mes]) alertasPorMes[mes] = { count: 0, varMax: 0, detalhes: [] };
      alertasPorMes[mes].count++;
      const v = Math.abs(a.variacao ?? ((a.ur_final ?? a.ur_max ?? 0) - (a.ur_inicial ?? a.ur_min ?? 0)));
      alertasPorMes[mes].varMax = Math.max(alertasPorMes[mes].varMax, v);
      alertasPorMes[mes].detalhes.push(a);
    });

    // Dataset de marcadores: y = UR do mês, só onde há alertas
    const marcadores = labels.map((mes, i) => {
      if (!alertasPorMes[mes]) return null;
      return { x: i, y: urData[i], info: alertasPorMes[mes] };
    }).filter(Boolean);

    window._charts.cAlertasMarcadores = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          // Linha de UR
          {
            label: 'Umidade Relativa — média mensal (%)',
            data: urData,
            borderColor: '#36a2eb',
            backgroundColor: 'rgba(54,162,235,.08)',
            borderWidth: 2,
            pointRadius: 3, pointHoverRadius: 6,
            tension: .4, fill: true,
            yAxisID: 'y', order: 2,
          },
          // Marcadores de eventos
          {
            label: 'Eventos de variação > 10 p.p.',
            data: marcadores.map(m => ({ x: m.x, y: m.y })),
            borderColor: 'transparent',
            backgroundColor: '#E30613',
            pointStyle: 'triangle',
            pointRadius: marcadores.map(m => Math.min(6 + m.info.count, 14)),
            pointHoverRadius: 16,
            showLine: false,
            yAxisID: 'y', order: 1,
          },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true } },
          tooltip: {
            callbacks: {
              label: ctx => {
                if (ctx.datasetIndex === 0) {
                  const v = ctx.parsed.y;
                  return v != null ? `UR média: ${v}%` : null;
                }
                // Marcador de evento
                const m = marcadores[ctx.dataIndex];
                if (!m) return null;
                return [
                  `Eventos no mês: ${m.info.count}`,
                  `Maior variação: ${m.info.varMax.toFixed(1)} p.p.`,
                ];
              }
            }
          }
        },
        scales: {
          y: {
            min: 20, max: 100,
            title: { display: true, text: 'UMIDADE RELATIVA (%)',
                     font: { family: "'DM Mono', monospace", size: 10 }, color: '#a8a29e' },
            ticks: { callback: v => v + '%' },
            grid: { color: '#e7e5e4' },
          },
          x: {
            ticks: { maxTicksLimit: 18, maxRotation: 45, font: { size: 10 } },
            grid: { color: '#e7e5e4' },
          }
        }
      },
      plugins: [{
        // Faixas horizontais de zona de UR
        id: 'zonaUR',
        afterDraw(chart) {
          const { ctx, scales: { y }, chartArea } = chart;
          if (!y) return;
          ctx.save();
          // Faixa segura IBRAM 50–60%
          const y1 = y.getPixelForValue(60), y2 = y.getPixelForValue(50);
          ctx.fillStyle = 'rgba(22,163,74,.06)';
          ctx.fillRect(chartArea.left, y1, chartArea.right - chartArea.left, y2 - y1);
          // Linha limite 60%
          if (y.min <= 60 && y.max >= 60) {
            const py = y.getPixelForValue(60);
            ctx.strokeStyle = 'rgba(22,163,74,.4)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
            ctx.beginPath(); ctx.moveTo(chartArea.left, py); ctx.lineTo(chartArea.right, py); ctx.stroke();
            ctx.fillStyle = '#16a34a'; ctx.font = '9px "DM Mono", monospace';
            ctx.fillText('60% — limite sup.', chartArea.left + 4, py - 3);
          }
          // Linha limite 50%
          if (y.min <= 50 && y.max >= 50) {
            const py = y.getPixelForValue(50);
            ctx.strokeStyle = 'rgba(22,163,74,.4)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
            ctx.beginPath(); ctx.moveTo(chartArea.left, py); ctx.lineTo(chartArea.right, py); ctx.stroke();
            ctx.fillStyle = '#16a34a'; ctx.font = '9px "DM Mono", monospace';
            ctx.fillText('50% — limite inf.', chartArea.left + 4, py + 11);
          }
          ctx.setLineDash([]); ctx.restore();
        }
      }]
    });
  }).catch(e => console.warn('buildAlertCharts:', e));
}

function buildHeatmap(alertas) {
  const wrap = document.getElementById('heatmapWrap');
  if (!wrap) return;
  const alertPorDia = {};
  alertas.forEach(a => {
    const d = (a.data_inicio||a.dia||'').substring(0,10);
    if (d) alertPorDia[d] = (alertPorDia[d]||0) + 1;
  });
  const anos = [...new Set(Object.keys(alertPorDia).map(d=>d.substring(0,4)))].sort();
  const anosExibir = anos.length ? anos.slice(-2) : [new Date().getFullYear()-1, new Date().getFullYear()];
  const MNAMES = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
  const months = [];
  anosExibir.forEach(y => { for (let m=0;m<12;m++) months.push(new Date(y,m,1)); });
  wrap.innerHTML = months.map(first => {
    const y=first.getFullYear(), mo=first.getMonth();
    const daysInMonth=new Date(y,mo+1,0).getDate(), startDay=first.getDay();
    let cells='';
    for(let i=0;i<startDay;i++) cells+=`<div class="hm-day empty"></div>`;
    for(let d=1;d<=daysInMonth;d++){
      const key=`${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const cnt=alertPorDia[key]||0;
      const lvl=cnt===0?0:cnt<=2?1:cnt<=5?2:cnt<=10?3:4;
      cells+=`<div class="hm-day hm-l${lvl}" onmouseenter="showTt(event,'${key}',${cnt})" onmouseleave="hideTt()">${d}</div>`;
    }
    return `<div class="hm-month">
      <div class="hm-month-title">${MNAMES[mo]} ${y}</div>
      <div class="hm-wd">${['D','S','T','Q','Q','S','S'].map(w=>`<span>${w}</span>`).join('')}</div>
      <div class="hm-days">${cells}</div>
    </div>`;
  }).join('');
}



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

// Padrões fixos por norma
const PADROES_NORMA = {
  ibram:   { urMin: 50, urMax: 60, tMin: 18, tMax: 22, label: 'IBRAM',   desc: '18–22°C · 50–60% UR' },
  masp:    { urMin: 45, urMax: 55, tMin: 18, tMax: 23, label: 'MASP',    desc: '18–23°C · 45–55% UR' },
  bizot:   { urMin: 40, urMax: 60, tMin: 15, tMax: 25, label: 'Bizot',   desc: '15–25°C · 40–60% UR' },
  hibrido: { label: 'Híbrido (MASP + Bizot)', desc: '1º Andar (18–23°C / 45–55%) · Demais (15–25°C / 40–60%)' },
  custom:  { label: 'Personalizado', desc: 'Faixas por ponto' },
};

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
    desvios.forEach(d => {
      d.ocorrencia_vinculada = null;
      d.justificativa_auto = null;
      for (const o of ocorrencias) {
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
    includeCover: document.getElementById('repIncludeCover')?.checked ?? true,
    includeInstructions: document.getElementById('repIncludeInstructions')?.checked ?? true,
    includeSummary: document.getElementById('repIncludeSummary')?.checked ?? true,
    includeSensors: document.getElementById('repIncludeSensors')?.checked ?? true,
    includeCharts: document.getElementById('repIncludeCharts')?.checked ?? true,
    includeOccurrences: document.getElementById('repIncludeOccurrences')?.checked ?? true,
    includeMonthly: document.getElementById('repIncludeMonthly')?.checked ?? true,
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
      
      const sensorOcorrs = ocorrencias.filter(o =>
        o.afeta_predio_todo || o.sensores?.some(s => s.nome === sensor)
      );
      allData.push({ sensor, serie, stats: pontosRes[0] || {}, thresh: getReportThresholds(sensor), ocorrencias: sensorOcorrs, mensalAPI: mensalRes });
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
    includeOccurrences: contentSettings.includeOccurrences !== false,
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

  const terreoPts = subsample(terreoDados, MAX_PTS);
  const temTerreo = terreoDados.length > 0;

  const sensorsData = allData.map(({ sensor, serie, stats, thresh, ocorrencias, mensalAPI }) => {
    
    // LÓGICA DO PADRÃO HÍBRIDO
    let p = isCustom ? thresh : norma;
    if (padrao === 'hibrido') {
      const andar = (stats.andar || '').toLowerCase();
      if (andar.includes('1o andar') || andar.includes('1º andar') || andar.includes('primeiro')) {
        p = { tMin: 18, tMax: 23, urMin: 45, urMax: 55, label: 'MASP' };
      } else {
        p = { tMin: 15, tMax: 25, urMin: 40, urMax: 60, label: 'Bizot' };
      }
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
    const terreoAlgn=alignTerreo(serieSub,terreoPts);
    
    return { sensor, serie, serieSub, terreoAlgn, stats, thresh:effectiveThresh, conf, ct, cur, monthly, ocorrencias, safeId };
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
          <div style="font-family:monospace;font-size:18px;font-weight:900;color:#0d0d0d">${sensorsData.reduce((sum,d)=>sum+d.serie.length,0).toLocaleString('pt-BR')}</div>
        </div>
      </div>
      
      <div style="border-top:2.5px solid #b5a9a1;padding-top:28px;width:100%;text-align:center">
        <div style="font-family:monospace;font-size:10px;color:#8c8278;letter-spacing:2px;font-weight:600">
          ${tx.generated} ${new Date().toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'}).toUpperCase()}
        </div>
        <div style="font-family:monospace;font-size:9px;color:#a8a29e;letter-spacing:1px;margin-top:6px">
          ${new Date().toLocaleTimeString('pt-BR')}
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
  const best       = [...sensorsDataSorted].sort((a,b)=>(b.conf??0)-(a.conf??0))[0];
  const worst      = [...sensorsDataSorted].sort((a,b)=>(a.conf??100)-(b.conf??100))[0];

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
      <div class="kpi-card kpi-card-sm">
        <div class="kpi-lbl">${tx.best_perf}</div>
        <div class="kpi-sensor-name ok" style="font-size:11px">${escapeHtml(best?.sensor||'–')}</div>
        <div class="kpi-sensor-val ok">${pct(best?.conf)}</div>
        <div style="font-size:10px; color:#6b6057; margin-top:2px">${tx.best_perf_desc}</div>
      </div>
      <div class="kpi-card kpi-card-sm">
        <div class="kpi-lbl">${tx.worst_perf}</div>
        <div class="kpi-sensor-name bad" style="font-size:11px">${escapeHtml(worst?.sensor||'–')}</div>
        <div class="kpi-sensor-val bad">${pct(worst?.conf)}</div>
        <div style="font-size:10px; color:#6b6057; margin-top:2px">${tx.worst_perf_desc}</div>
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
          <td class="td-num">${d.serie.length.toLocaleString('pt-BR')}</td>
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
  const monthlyTrendsPage = content.includeMonthly ? `
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
  const sensorPages = sensorsDataForPages.map(({ sensor, serie, serieSub, terreoAlgn, stats, thresh, conf, ct, cur, monthly, ocorrencias, safeId }) => {
    const monthlyHtml = monthly.length>1 && content.includeCharts?`
    <div class="side-block">
      <div class="block-title">${tx.monthly_evolution_label} — ${thresh.label}</div>
      <table class="monthly-table">
        <thead><tr><th>${tx.month}</th><th>N</th><th class="th-padrao">${thresh.label}</th><th>T</th><th>UR</th></tr></thead>
        <tbody>${monthly.map(m=>`
          <tr>
            <td>${fmtMonth(m.mes)}</td>
            <td class="td-num">${m.n.toLocaleString('pt-BR')}</td>
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
        const fim  = o.data_fim ? o.data_fim.substring(0, 16).replace('T', ' ') : (lang === 'pt' ? 'em aberto' : 'ongoing');
        const auto = o.tipo === 'pico_automatico';
        const sensNomes = (o.sensores || []).map(s => escapeHtml(s.nome)).join(', ');
        const respHtml = o.responsavel ? `<span class="ocorr-resp">${escapeHtml(o.responsavel)}</span>` : '';
        const sensHtml = sensNomes ? `<div style="font-family:monospace;font-size:9px;color:#8c8278;margin-bottom:4px">${lang === 'pt' ? 'Sensores:' : 'Sensors:'} ${sensNomes}</div>` : '';
        return '<div class="ocorr-item ocorr-' + o.tipo + '">'
          + '<div class="ocorr-row1">'
          + '<span class="ocorr-badge">' + (OCORR_LABELS[o.tipo] || o.tipo) + '</span>'
          + (auto ? '<span class="ocorr-auto-tag">⚡ ' + (lang === 'pt' ? 'automático' : 'automatic') + '</span>' : '')
          + '<span class="ocorr-datas">' + ini + ' → ' + fim + '</span>'
          + respHtml
          + '</div>'
          + sensHtml
          + '<p class="ocorr-desc">' + escapeHtml(o.descricao) + '</p>'
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
          <div class="sensor-period">${period} &nbsp;·&nbsp; ${serie.length.toLocaleString('pt-BR')} medições</div>
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
        <span class="stat-val ${cls(cur)}">${pct(cur)}</span>
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
        <div class="chart-wrap" style="margin-top:12px"><canvas id="${safeId}_T"></canvas></div>
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
        <div class="chart-wrap" style="margin-top:12px"><canvas id="${safeId}_R"></canvas></div>
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
              <div class="desvio-sub">${tDentro.toLocaleString('pt-BR')} ${tx.normal_meds}</div>
            </div>
            <div class="desvio-card warn">
              <div class="desvio-titulo"><span style="color:#92400e">↑</span> ${tx.above_limit}</div>
              <div class="desvio-kpi" style="color:#92400e">${(tAcima/tot*100).toFixed(1)}%</div>
              <div class="desvio-sub">${tAcima.toLocaleString('pt-BR')} medições (${tx.too_hot_label})</div>
            </div>
            <div class="desvio-card" style="background:rgba(37,99,235,0.04);border-color:#bfdbfe">
              <div class="desvio-titulo"><span style="color:#1d4ed8">↓</span> ${tx.below_limit}</div>
              <div class="desvio-kpi" style="color:#1d4ed8">${(tAbaixo/tot*100).toFixed(1)}%</div>
              <div class="desvio-sub">${tAbaixo.toLocaleString('pt-BR')} medições (${tx.too_cold_label})</div>
            </div>
          </div>

          <div class="sec-title" style="margin-bottom:14px;border-bottom:none">${tx.dev_analysis_ur}</div>
          <div class="desvios-grid">
            <div class="desvio-card ok">
              <div class="desvio-titulo"><span style="color:#15803d">✓</span> ${tx.within_range_label}</div>
              <div class="desvio-kpi" style="color:#15803d">${(uDentro/tot*100).toFixed(1)}%</div>
              <div class="desvio-sub">${uDentro.toLocaleString('pt-BR')} ${tx.normal_meds}</div>
            </div>
            <div class="desvio-card" style="background:rgba(217,119,6,0.04);border-color:#fde68a">
              <div class="desvio-titulo"><span style="color:#b45309">↑</span> ${tx.above_limit}</div>
              <div class="desvio-kpi" style="color:#b45309">${(uAcima/tot*100).toFixed(1)}%</div>
              <div class="desvio-sub">${uAcima.toLocaleString('pt-BR')} medições (${tx.too_humid_label})</div>
            </div>
            <div class="desvio-card bad">
              <div class="desvio-titulo"><span style="color:#991b1b">↓</span> ${tx.below_limit}</div>
              <div class="desvio-kpi" style="color:#991b1b">${(uAbaixo/tot*100).toFixed(1)}%</div>
              <div class="desvio-sub">${uAbaixo.toLocaleString('pt-BR')} medições (${tx.too_dry_label})</div>
            </div>
          </div>
        </div>
        `;
      })()}

      ${ocorrHtml}
    </div>`;
  });

  const chartPayload = sensorsDataSorted.map(({ safeId, serieSub, terreoAlgn, thresh, ocorrencias }) => ({
    safeId, thresh, serie: serieSub, terreo: terreoAlgn,
    // Processa período expositivo com validações robustas
    periodoExpo: serieSub.map(r => {
      if (!r) return 0;
      // Aceita 1, "1", true, ou valores que não sejam 0 ou "0"
      const val = r.periodo_expositivo;
      if (val === 1 || val === "1" || val === true) return 1;
      return 0;
    }),
    /* Captura o nome da exposição de cada ponto da série */
    periodoExpoNomes: serieSub.map(r => {
      if (!r || r.periodo_expositivo !== 1 && r.periodo_expositivo !== "1") return null;
      return r.periodo_expositivo_nome || null;
    }),
    ocorrs: (ocorrencias||[]).map(o=>({ dataStr:o.data_inicio||'', color:OCORR_COLORS[o.tipo]||'#888', label:OCORR_LABELS[o.tipo]||o.tipo })),
    customMarkers: contentSettings.customMarkers || []
  }));
  const dataJSON = JSON.stringify(chartPayload).replace(/<\/script>/gi,'<\\/script>');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
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
  if(pY1>aT) ctx.fillText('Máx: '+zm.zMax+zm.unit,aL+8,pY1-7);
  if(pY2<aB) ctx.fillText('Mín: '+zm.zMin+zm.unit,aL+8,pY2+16);
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
  
  if(terreoData && terreoData.length) datasets.push({label:'Térreo', data:terreoData, borderColor:'#94a3b8', borderWidth: 1, borderDash:[6, 4], pointRadius:0, fill:false, tension: 0.4});

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
    while(i<periodoExpo.length){
      if(periodoExpo[i]===1){
        var s=i;
        var nomeExpo = (typeof periodoExpoNomes !== 'undefined') ? periodoExpoNomes[i] : null;
        // Avança enquanto mantém encontrando 1s
        while(i<periodoExpo.length&&periodoExpo[i]===1)i++;
        // Garante que i-1 está dentro dos limites válidos
        var endIdx = Math.min(i-1, periodoExpo.length-1);
        if(endIdx < s) endIdx = s; // Se s é o último índice
        
        var x1=xs.getPixelForValue(s);
        var x2=xs.getPixelForValue(endIdx);
        
        // Certifica que x1 <= x2 (em caso de erro de renderização)
        if(x1 > x2) { var temp = x1; x1 = x2; x2 = temp; }
        var w=Math.max(x2-x1,1);
        
        // Desenha o fundo sombreado
        ctx.fillStyle='rgba(227,6,19,0.05)';
        ctx.fillRect(x1,ca.top,w,ca.height-STRIP_H);
        
        // Desenha a barrinha vermelha na base
        ctx.fillStyle='rgba(227,6,19,0.32)';
        ctx.fillRect(x1,ca.bottom-STRIP_H,w,STRIP_H);
        
        // Escreve o nome da exposição no topo (se houver)
        if(nomeExpo){
          ctx.fillStyle='rgba(227,6,19,0.6)';
          ctx.font='600 9px "IBM Plex Mono", monospace';
          ctx.textAlign='left';
          // Corta o texto se ele for maior que a faixa
          var textToDraw = nomeExpo;
          if(ctx.measureText(textToDraw).width > w - 4) textToDraw = textToDraw.substring(0, 10) + "...";
          if(w > 30) ctx.fillText(textToDraw.toUpperCase(), x1 + 4, ca.top + 12);
        }
      }else{i++;}
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
        tooltip:{backgroundColor:'#1a1614',titleColor:'#fafafa',bodyColor:'#c0ae9f',borderColor:'#5a5350',borderWidth:1.2,cornerRadius:3,padding:{x:14,y:11},titleFont:{family:'monospace',size:11,weight:'bold'},bodyFont:{family:'monospace',size:11},callbacks:{title:function(items){return 'Data/Hora: '+(rawLabels[items[0].dataIndex]||'');},label:function(ctx){var v=ctx.parsed.y;if(v==null)return null;if(ctx.datasetIndex===0){var expo=periodoExpo&&periodoExpo.length>ctx.dataIndex&&periodoExpo[ctx.dataIndex]===1;var status=(v>=zMin&&v<=zMax)?' ✓ Conforme':' ✗ Fora';return'Sensor: '+v.toFixed(2)+unit+status+(expo?' | Em exposição':'');}if(ctx.datasetIndex===1&&terreoData&&terreoData.length)return'Térreo (ref): '+v.toFixed(2)+unit;return null;}}}
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
  // 1. Gráficos individuais (o que já funcionava)
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
  var MN=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
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

// ── TOAST DE CONFIRMAÇÃO ──────────────────────────────────
function showToast(msg, type = 'ok', duration = 6000) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;bottom:28px;right:28px;z-index:9999;display:flex;flex-direction:column;gap:10px;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  const bg = type === 'ok' ? '#16a34a' : type === 'warn' ? '#d97706' : '#E30613';
  toast.style.cssText = `background:${bg};color:#fff;font-family:var(--mono);font-size:.8rem;letter-spacing:1px;
    padding:14px 22px;border-radius:2px;box-shadow:0 4px 18px rgba(0,0,0,.25);
    max-width:420px;line-height:1.5;opacity:0;transform:translateY(12px);transition:all .28s ease;`;
  toast.textContent = msg;
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
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

async function handleFilesAPI(files) {
  const csvFiles  = files.filter(f => /\.csv$/i.test(f.name));
  const jsonFiles = files.filter(f => /\.json$/i.test(f.name));

  if (csvFiles.length) {
    // Verifica se é testo multi-sensor
    const text  = await csvFiles[0].text();
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const counts = { ';': 0, ',': 0, '\t': 0 };
    lines[0].split('').forEach(c => { if (counts[c] !== undefined) counts[c]++; });
    const delim = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0];

    if (isTestoMultiSensor(lines, delim)) {
      await processTestoCSV(csvFiles[0], text, delim);
    } else {
      await openCSVModal(csvFiles[0]);
    }
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
const PADROES = {
  ibram: { label: 'IBRAM', tMin: 18, tMax: 22, uMin: 50, uMax: 60 },
  masp:  { label: 'MASP',  tMin: 18, tMax: 23, uMin: 45, uMax: 55 },
  bizot: { label: 'Bizot', tMin: 15, tMax: 25, uMin: 40, uMax: 60 },
};

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

    for (const [key, p] of Object.entries(PADROES)) {
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

    const rows = Object.entries(PADROES).map(([key, p]) => {
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
            ${Object.entries(PADROES).map(([key, p]) => {
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

async function processTestoCSV(file, text, delim) {
  const wrap = document.getElementById('progWrap');
  const fill = document.getElementById('progFill');
  const list = document.getElementById('fileList');
  wrap.classList.remove('hidden');
  fill.style.width = '20%';

  const row = document.createElement('div');
  row.className = 'file-row';
  row.textContent = `⏳ ${file.name} — detectado formato testo (multi-sensor), parseando...`;
  list.innerHTML = '';
  list.appendChild(row);

  try {
    const { rows, sensors } = await parseTestoCSV(text, delim);
    if (!rows.length) throw new Error('Nenhum dado válido encontrado.');

    fill.style.width = '50%';
    row.textContent = `⏳ ${file.name} — ${rows.length.toLocaleString()} leituras de ${sensors.length} sensor(es), enviando...`;

    const blob = new Blob([JSON.stringify(rows)], { type: 'application/json' });
    const formData = new FormData();
    formData.append('file', new File([blob], file.name.replace(/\.csv$/i, '.json')));

    const res  = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    fill.style.width = '100%';

    if (data.status === 'ok') {
      row.className   = 'file-row ok';
      row.textContent = `✓ ${file.name} — ${data.importadas.toLocaleString()} medições salvas · ${data.duplicadas} duplicadas ignoradas`;
      showToast(
        `✓ CSV testo importado!\n${data.importadas.toLocaleString('pt-BR')} medições salvas · ${data.duplicadas} duplicadas ignoradas.`,
        'ok', 6000
      );
      if (data.sensores_novos_lista?.length) openReviewModal(data.sensores_novos_lista);
      if (data.picos_sugeridos?.length) setTimeout(() => openPicosModal(data.picos_sugeridos), 500);

      // Analisa não-conformidades e abre modal de revisão se houver problemas
      const analise = analisarNaoConformidades(rows);
      if (analise.length > 0) {
        setTimeout(() => openNaoConformidadesModal(analise), 800);
      }
    } else {
      throw new Error(data.erro || 'Erro desconhecido');
    }
  } catch (e) {
    row.className   = 'file-row err';
    row.textContent = `✗ ${file.name} — ${e.message}`;
    showToast(`✗ Erro ao importar ${file.name}: ${e.message}`, 'err');
  }

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

// ── ORQUESTRAÇÃO ──────────────────────────────────────────
async function applyFilters() {
  const loader = document.getElementById('loader');
  loader.classList.add('show');
  try {
    const f = getFilters();
    window._lastFilters = f;

    // Reseta flags — filtro novo significa recarregar tudo
    if (typeof _resetTabFlags === 'function') _resetTabFlags();

    // Recarrega apenas a aba atualmente visível
    const abaAtiva = document.querySelector('.tab-pane.active')?.id?.replace('tab-', '') || 'visao';
    await loadTab(abaAtiva, f);

    const parts = [];
    const pontos  = f.ponto || [];
    const total   = document.querySelectorAll('#fPontoGroups .chip-btn[data-nome]').length;
    if (pontos.length > 0 && pontos.length < total) {
      parts.push(pontos.length === 1 ? pontos[0] : `${pontos.length} pontos`);
    }
    const period = document.querySelector('#fPeriodo .seg-btn.active')?.textContent?.trim();
    if (period && period !== 'Todos') parts.push(period.toLowerCase());
    if (f.data_ini) parts.push(`de ${f.data_ini}`);
    if (f.data_fim) parts.push(`até ${f.data_fim}`);

    document.getElementById('filterInfo').textContent =
      parts.length ? parts.join(' · ') : 'Exibindo todos os dados';
  } finally {
    loader.classList.remove('show');
  }
}

// ── LAZY LOADING POR ABA ─────────────────────────────────
// Cada aba carrega seus dados apenas na primeira visita.
// applyFilters reseta os flags para forçar recarga ao filtrar.

const _tabLoaded = {
  visao:        false,
  pontos:       false,
  exposicoes:   false,
  alertas:      false,
  ocorrencias:  false,
};

function _resetTabFlags() {
  Object.keys(_tabLoaded).forEach(k => _tabLoaded[k] = false);
}

// Carrega os dados da aba ativa
async function loadTab(tab, filters = {}) {
  switch (tab) {
    case 'visao':
      if (_tabLoaded.visao) return;
      await Promise.all([
        loadMetricas(filters),
        loadMensal(filters),
        loadPontos(filters),   // popula _pontosCache, cSensores e select do horário
      ]);
      await loadSazonal(filters); // depois de _sensorExterno estar definido
      await loadOrvalho(filters); // depende do select populado por populateFilters
      _tabLoaded.visao = true;
      break;

    case 'pontos':
      if (_tabLoaded.pontos) return;
      // cScatter está na aba pontos — reusa _pontosCache se já foi carregado
      if (!_pontosCache.length) await loadPontos(filters);
      else { renderPontosTable(); renderSensores(); }
      _tabLoaded.pontos = true;
      break;

    case 'exposicoes':
      if (_tabLoaded.exposicoes) return;
      await loadExposicoes();
      _tabLoaded.exposicoes = true;
      break;

    case 'alertas':
      if (_tabLoaded.alertas) return;
      await loadAlertas(filters);
      _tabLoaded.alertas = true;
      break;

    case 'ocorrencias':
      if (_tabLoaded.ocorrencias) return;
      await loadOcorrenciasTab(filters);
      _tabLoaded.ocorrencias = true;
      break;
  }
}

// Boot: carrega apenas a aba inicial (Visão Geral)
async function loadAll(filters = {}) {
  const hash = location.hash.replace('#', '') || 'visao';
  const abaInicial = ['visao','pontos','exposicoes','alertas','ocorrencias'].includes(hash) ? hash : 'visao';
  await loadTab(abaInicial, filters);
}


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
      _tabLoaded.ocorrencias = false;
      await loadOcorrenciasTab();
      _tabLoaded.ocorrencias = true;
    } catch(e) { showToast('✗ Erro: ' + e.message, 'err'); }
  };
  document.getElementById('deleteConfirmBtn').onclick = _deleteFn;
  document.getElementById('deleteModal').classList.remove('hidden');
}

// ── GERENCIAR: SUB-TABS ───────────────────────────────────
function switchGTab(name, btn) {
  document.querySelectorAll('.gtab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.gtab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('gtab-' + name).classList.add('active');
  btn.classList.add('active');
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
    _tabLoaded.ocorrencias = false;
   await Promise.all([
   loadOcorrenciasTab()
 ]);
    _tabLoaded.ocorrencias = true;
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

// ── CHART.JS DEFAULTS — identidade visual do dashboard ────
// Tipografia
Chart.defaults.font.family = "'DM Mono', monospace";
Chart.defaults.font.size   = 11;
Chart.defaults.color       = '#a8a29e'; // --gray-300: ticks e labels auxiliares

// Grid uniforme com --border do dashboard
Chart.defaults.scale.grid.color     = '#e7e5e4';
Chart.defaults.scale.grid.lineWidth = 1;

// Tooltip: fundo --black, DM Mono, cantos quadrados como o resto da UI
Chart.defaults.plugins.tooltip.backgroundColor = '#0a0a0a';
Chart.defaults.plugins.tooltip.titleColor       = '#fafafa';
Chart.defaults.plugins.tooltip.bodyColor        = '#a8a29e';
Chart.defaults.plugins.tooltip.borderColor      = '#44403c';
Chart.defaults.plugins.tooltip.borderWidth      = 1;
Chart.defaults.plugins.tooltip.cornerRadius     = 2;
Chart.defaults.plugins.tooltip.padding          = { x: 12, y: 10 };
Chart.defaults.plugins.tooltip.titleFont        = { family: "'DM Mono', monospace", size: 11, weight: '500' };
Chart.defaults.plugins.tooltip.bodyFont         = { family: "'DM Mono', monospace", size: 11 };
Chart.defaults.plugins.tooltip.boxWidth         = 10;
Chart.defaults.plugins.tooltip.boxHeight        = 10;
Chart.defaults.plugins.tooltip.boxPadding       = 4;

// Legenda: DM Mono, box compacto, cinza médio
Chart.defaults.plugins.legend.labels.font        = { family: "'DM Mono', monospace", size: 11 };
Chart.defaults.plugins.legend.labels.color       = '#78716c';
Chart.defaults.plugins.legend.labels.boxWidth    = 12;
Chart.defaults.plugins.legend.labels.boxHeight   = 12;
Chart.defaults.plugins.legend.labels.padding     = 18;
Chart.defaults.plugins.legend.labels.usePointStyle = false;

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

// ── PONTO DE ORVALHO ─────────────────────────────────────

let _orvalhoCache = [];

async function loadOrvalho(filters = {}) {
  const sensor = document.getElementById('selOrvalhoSensor')?.value || '';
  const wrap   = document.getElementById('orvalhoWrap');
  if (!wrap) return;

  if (!sensor) {
    wrap.innerHTML = `<div style="font-family:var(--mono);font-size:.75rem;color:var(--gray-400);
      padding:40px;text-align:center;letter-spacing:1px">
      SELECIONE UM SENSOR PARA VISUALIZAR O PONTO DE ORVALHO</div>`;
    if (window._charts?.cOrvalho) { window._charts.cOrvalho.destroy(); delete window._charts.cOrvalho; }
    return;
  }

  // Passa data_ini/data_fim dos filtros ativos; omite chips de ponto (conflito)
  const f = {
    ponto:              sensor,
    data_ini:           filters.data_ini           || '',
    data_fim:           filters.data_fim           || '',
    periodo_expositivo: filters.periodo_expositivo || '',
  };

  try {
    const dados = await API.get('orvalho_serie', f);
    _orvalhoCache = dados;

    if (!dados.length) {
      wrap.innerHTML = `<div style="font-family:var(--mono);font-size:.75rem;color:var(--gray-400);
        padding:40px;text-align:center;letter-spacing:1px">
        SEM DADOS PARA O SENSOR E ${tx.period} SELECIONADOS</div>`;
      if (window._charts?.cOrvalho) { window._charts.cOrvalho.destroy(); delete window._charts.cOrvalho; }
      return;
    }

    // Garante que o canvas existe no wrap
    if (!document.getElementById('cOrvalho')) {
      wrap.innerHTML = `<div class="chart-wrap chart-wrap-tall"><canvas id="cOrvalho"></canvas></div>`;
    }
    renderOrvalho();
  } catch(e) { console.warn('loadOrvalho:', e); }
}

function renderOrvalho() {
  const canvas = document.getElementById('cOrvalho');
  if (!canvas || !_orvalhoCache.length) return;
  if (window._charts?.cOrvalho) window._charts.cOrvalho.destroy();

  const d      = _orvalhoCache;
  const labels = d.map(r => r.dt);
  const tData  = d.map(r => r.t_med);
  const urData = d.map(r => r.ur_med);
  const tdData = d.map(r => r.td_med);

  window._charts.cOrvalho = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        // Temperatura — laranja sólida
        {
          label: 'Temperatura (°C)',
          data: tData,
          borderColor: '#f97316',
          backgroundColor: '#f97316',
          borderWidth: 1.5,
          pointRadius: 3, pointHoverRadius: 7,
          tension: .35, fill: false,
          yAxisID: 'yT', order: 1,
        },
        // Ponto de Orvalho — azul escuro com área sombreada
        {
          label: 'Ponto de Orvalho (°C)',
          data: tdData,
          borderColor: '#1e3a5f',
          backgroundColor: 'rgba(30,58,95,.12)',
          borderWidth: 1.5,
          pointRadius: 3, pointHoverRadius: 7,
          tension: .35, fill: true,
          yAxisID: 'yT', order: 2,
        },
        // UR — ciano tracejado, eixo direito
        {
          label: 'Umidade Relativa (%)',
          data: urData,
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6,182,212,.06)',
          borderWidth: 2,
          pointRadius: 2, pointHoverRadius: 6,
          tension: .35, fill: false,
          borderDash: [5, 3],
          yAxisID: 'yUR', order: 3,
        },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { usePointStyle: true, pointStyleWidth: 20, font: { size: 12 } }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (v == null) return null;
              if (ctx.dataset.label.includes('UR') || ctx.dataset.label.includes('Umidade'))
                return `${ctx.dataset.label}: ${v}%`;
              return `${ctx.dataset.label}: ${v}°C`;
            },
            afterBody: ctx => {
              // Mostra margem T−Td inline no tooltip
              const i   = ctx[0]?.dataIndex;
              const t   = tData[i];
              const td  = tdData[i];
              if (t != null && td != null) {
                const m = (t - td).toFixed(1);
                const zona = m < 2 ? '🔴 Risco de condensação'
                           : m < 4 ? '🟡 Atenção'
                           : '🟢 Seguro';
                return [`Margem T−Td: ${m}°C  ${zona}`];
              }
              return [];
            }
          }
        }
      },
      scales: {
        yT: {
          position: 'left',
          title: { display: true, text: 'Graus Celsius (°C)',
                   font: { family: "'DM Mono', monospace", size: 10 }, color: '#a8a29e' },
          ticks: { callback: v => v + '°C' },
          grid: { color: '#e7e5e4' },
        },
        yUR: {
          position: 'right',
          min: 30, max: 100,
          title: { display: true, text: 'Humidade (%)',
                   font: { family: "'DM Mono', monospace", size: 10 }, color: '#a8a29e' },
          ticks: { callback: v => v + '%', color: '#06b6d4' },
          grid: { display: false },
        },
        x: {
          ticks: { maxTicksLimit: 10, maxRotation: 0, font: { size: 10 } },
          grid: { color: '#e7e5e4' },
        }
      }
    },
    plugins: [{
      // Área sombreada entre T e Td colorida pela zona de risco
      id: 'margemOrvalho',
      afterDraw(chart) {
        const { ctx, scales: { yT, x }, chartArea } = chart;
        if (!yT || !x || d.length < 2) return;
        ctx.save();
        d.forEach((r, i) => {
          if (r.t_med == null || r.td_med == null) return;
          const margem = r.t_med - r.td_med;
          const cor = margem < 2 ? 'rgba(220,38,38,.18)'
                    : margem < 4 ? 'rgba(217,119,6,.12)'
                    : 'rgba(22,163,74,.08)';

          const xL = i === 0 ? chartArea.left
            : (x.getPixelForValue(i - 1) + x.getPixelForValue(i)) / 2;
          const xR = i === d.length - 1 ? chartArea.right
            : (x.getPixelForValue(i) + x.getPixelForValue(i + 1)) / 2;

          const yTop = yT.getPixelForValue(r.t_med);
          const yBot = yT.getPixelForValue(r.td_med);
          ctx.fillStyle = cor;
          ctx.fillRect(xL, yTop, xR - xL, yBot - yTop);
        });
        ctx.restore();
      }
    }]
  });
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
    _tabLoaded.ocorrencias = false;
    loadOcorrenciasTab().catch(() => {});
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  const banner = document.getElementById('infoBanner');

  window._lastFilters = typeof getFilters === 'function' ? getFilters() : {};
  try {
    const metaBoot = await populateFilters();  // já chama /api/meta internamente
    // Reutiliza o meta retornado por populateFilters — evita segunda chamada à API.
    // Usa ultima_medicao do banco para definir o ${tx.period} padrão (últimos 30 dias
    // a partir da data mais recente — não de hoje, que pode estar muito à frente dos dados).
    const fIni = document.getElementById('fDataIni');
    const fFim = document.getElementById('fDataFim');
    if (metaBoot && metaBoot.ultima_medicao && fIni && fFim) {
      const ultima = new Date(metaBoot.ultima_medicao + 'T12:00:00');
      const ini30  = new Date(ultima); ini30.setDate(ultima.getDate() - 30);
      fFim.value = ultima.toISOString().slice(0, 10);
      fIni.value = ini30.toISOString().slice(0, 10);
      window._ultimaMedicao = metaBoot.ultima_medicao;  // persiste para clearFilters
    }
    // Reatualiza após datas definidas
    window._lastFilters = getFilters();
    await loadAll();
    banner.dataset.status = 'ok';
    banner.style.cssText = 'background:#f0fdf4;border-left-color:#16a34a;color:#15803d';
    banner.textContent = '✓ DADOS REAIS — conectado ao banco climatizacao_museu.db';
    document.getElementById('filterInfo').textContent = 'Exibindo dados dos últimos 30 dias';
  } catch (e) {
    console.error('Erro ao carregar:', e);
    banner.dataset.status = 'err';
    banner.style.cssText = 'background:#fff7ed;border-left-color:#d97706;color:#92400e';
    banner.textContent = '⚠ Não foi possível conectar à API — verifique se o servidor Flask está rodando.';
  }
});

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
    ongoing: "em aberto",
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
    ongoing: "ongoing",
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