const tx = {
  period: "período",
  title: "Relatório de Climatização Museal",
  subtitle: "Conservação Preventiva de Acervos",
  standard: "Padrão de Conformidade"
};

// Registro central de instâncias Chart.js — evita inicializações redundantes
window._charts = window._charts || {};

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

// Cache de pontos — compartilhado com ui.js (renderPontosTable) e api.js (loadTab)
window._pontosCache = [];

async function loadPontos(filters = {}) {
  const pontos = await API.get('pontos', filters);
  window._pontosCache = pontos;
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

          // Faixas vêm de getPadraoConformidade() (api.js) — fonte: padroes_conformidade
          const bizotP = getPadraoConformidade('bizot');
          const maspP  = getPadraoConformidade('masp');
          const ibramP = getPadraoConformidade('ibram');

          // Bizot
          const bx1 = x.getPixelForValue(bizotP.tMin), bx2 = x.getPixelForValue(bizotP.tMax);
          const by1 = y.getPixelForValue(bizotP.urMax), by2 = y.getPixelForValue(bizotP.urMin);
          ctx.fillStyle = COLORS.bizotFill().replace(/[\d.]+\)$/, '0.08)');
          ctx.fillRect(bx1, by1, bx2 - bx1, by2 - by1);
          ctx.strokeStyle = COLORS.bizot();
          ctx.lineWidth = 1;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(bx1, by1, bx2 - bx1, by2 - by1);
          ctx.fillStyle = COLORS.bizot();
          ctx.font = 'bold 9px "DM Mono", monospace';
          ctx.fillText('BIZOT', bx1 + 4, by1 + 12);

          // MASP
          const mx1 = x.getPixelForValue(maspP.tMin), mx2 = x.getPixelForValue(maspP.tMax);
          const my1 = y.getPixelForValue(maspP.urMax), my2 = y.getPixelForValue(maspP.urMin);
          ctx.fillStyle = COLORS.maspFill().replace(/[\d.]+\)$/, '0.08)');
          ctx.fillRect(mx1, my1, mx2 - mx1, my2 - my1);
          ctx.strokeStyle = COLORS.masp();
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(mx1, my1, mx2 - mx1, my2 - my1);
          ctx.fillStyle = COLORS.masp();
          ctx.font = 'bold 9px "DM Mono", monospace';
          ctx.fillText('MASP', mx1 + 4, my1 + 12);

          // IBRAM
          const ix1 = x.getPixelForValue(ibramP.tMin), ix2 = x.getPixelForValue(ibramP.tMax);
          const iy1 = y.getPixelForValue(ibramP.urMax), iy2 = y.getPixelForValue(ibramP.urMin);
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
  // Faixas vêm de getPadraoConformidade() (api.js) — fonte: padroes_conformidade
  const _pIbram = getPadraoConformidade('ibram'), _pMasp = getPadraoConformidade('masp'), _pBizot = getPadraoConformidade('bizot');
  const normaFaixas = {
    ibram: { tLabel:`T: ${_pIbram.tMin}–${_pIbram.tMax}°C`, urLabel:`UR: ${_pIbram.urMin}–${_pIbram.urMax}%`, tColor: COLORS.igramFill().replace(/[\d.]+\)$/, '0.12)'),  urColor: COLORS.blue().replace(/[\w#]/g, m => /[0-9a-f]/.test(m) ? m : '').slice(0, 7) + '1a)' },
    masp:  { tLabel:`T: ${_pMasp.tMin}–${_pMasp.tMax}°C`, urLabel:`UR: ${_pMasp.urMin}–${_pMasp.urMax}%`, tColor: COLORS.igramFill().replace(/[\d.]+\)$/, '0.12)'),  urColor: COLORS.maspFill().replace(/[\d.]+\)$/, '0.10)') },
    bizot: { tLabel:`T: ${_pBizot.tMin}–${_pBizot.tMax}°C`, urLabel:`UR: ${_pBizot.urMin}–${_pBizot.urMax}%`, tColor: COLORS.bizotFill().replace(/[\d.]+\)$/, '0.12)'), urColor: COLORS.bizotFill().replace(/[\d.]+\)$/, '0.12)') },
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
    const pontos   = getSelectedPontos();  // definida em ui.js
    const periodoBtn = document.querySelector('#fPeriodo .seg-btn.active')?.textContent?.trim() || 'Todos';

    // Labels legíveis
    const GRAN_LABEL  = { hora:'Hora a hora', dia:'Dia a dia', mes:'Mês a mês', ano:'Ano a ano' };
    const PADRAO_DESC = {
      ibram: `IBRAM — ${getPadraoConformidade('ibram').desc.replace(' · ', ' / ')}`,
      masp:  `MASP — ${getPadraoConformidade('masp').desc.replace(' · ', ' / ')}`,
      bizot: `Bizot — ${getPadraoConformidade('bizot').desc.replace(' · ', ' / ')}`,
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

// Labels das faixas exibidas na legenda — consumidas pela UI. Função (não objeto
// estático) porque getPadraoConformidade() só tem os valores reais do banco depois do
// boot; ver zonasFaixas acima para o mesmo padrão.
function _horarioLabels(chave) {
  const p = getPadraoConformidade(chave);
  return { labelTemp: `% fora da Temp (${p.tMin}–${p.tMax}°C)`, labelUr: `% fora da UR (${p.urMin}–${p.urMax}%)` };
}

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
  const faixas = _horarioLabels(padrao);

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
        const nomes = (window._pontosCache.length ? window._pontosCache : [])
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

  // Faixa vem de getPadraoConformidade() (api.js) — fonte: padroes_conformidade
  const faixas      = getPadraoConformidade(padrao);
  const faixaMin    = isTemp ? faixas.tMin : faixas.urMin;
  const faixaMax    = isTemp ? faixas.tMax : faixas.urMax;
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
          // Faixa segura IBRAM — vem de getPadraoConformidade() (api.js)
          const ibramP = getPadraoConformidade('ibram');
          const y1 = y.getPixelForValue(ibramP.urMax), y2 = y.getPixelForValue(ibramP.urMin);
          ctx.fillStyle = 'rgba(22,163,74,.06)';
          ctx.fillRect(chartArea.left, y1, chartArea.right - chartArea.left, y2 - y1);
          // Linha limite superior
          if (y.min <= ibramP.urMax && y.max >= ibramP.urMax) {
            const py = y.getPixelForValue(ibramP.urMax);
            ctx.strokeStyle = 'rgba(22,163,74,.4)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
            ctx.beginPath(); ctx.moveTo(chartArea.left, py); ctx.lineTo(chartArea.right, py); ctx.stroke();
            ctx.fillStyle = '#16a34a'; ctx.font = '9px "DM Mono", monospace';
            ctx.fillText(`${ibramP.urMax}% — limite sup.`, chartArea.left + 4, py - 3);
          }
          // Linha limite inferior
          if (y.min <= ibramP.urMin && y.max >= ibramP.urMin) {
            const py = y.getPixelForValue(ibramP.urMin);
            ctx.strokeStyle = 'rgba(22,163,74,.4)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
            ctx.beginPath(); ctx.moveTo(chartArea.left, py); ctx.lineTo(chartArea.right, py); ctx.stroke();
            ctx.fillStyle = '#16a34a'; ctx.font = '9px "DM Mono", monospace';
            ctx.fillText(`${ibramP.urMin}% — limite inf.`, chartArea.left + 4, py + 11);
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
