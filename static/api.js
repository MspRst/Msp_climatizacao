// Guard de dupla carga — reseta em vez de lançar exceção,
// pois um throw aqui aborta o DOMContentLoaded e trava o boot.
if (window.__masp_loaded) {
  console.warn('api.js: reload detectado, resetando estado.');
  window._charts = {};
}
window.__masp_loaded = true;

// ── PADRÕES DE CONFORMIDADE ────────────────────────────────
// Fonte única de verdade: tabela padroes_conformidade no banco. populateFilters()
// (ui.js) preenche window._padroes a partir de /api/meta assim que o boot responde.
// O fallback abaixo cobre só o instante entre o parse deste script e essa resposta
// (valores idênticos ao banco) — nunca uma segunda cópia pra manter em dia. Antes
// disso, cada tela (métricas, gráficos, relatório) repetia esses números por conta
// própria — já causou um bug real de legenda com a faixa errada (ANALISE-TECNICA §2.4).
const _PADROES_FALLBACK = {
  ibram: { tMin: 18, tMax: 22, urMin: 50, urMax: 60, label: 'IBRAM', desc: '18–22°C · 50–60% UR' },
  masp:  { tMin: 18, tMax: 23, urMin: 45, urMax: 55, label: 'MASP',  desc: '18–23°C · 45–55% UR' },
  bizot: { tMin: 15, tMax: 25, urMin: 40, urMax: 60, label: 'Bizot', desc: '15–25°C · 40–60% UR' },
};
function getPadraoConformidade(chave) {
  return (window._padroes && window._padroes[chave]) || _PADROES_FALLBACK[chave];
}

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

window._tabLoaded = {
  visao:        false,
  pontos:       false,
  exposicoes:   false,
  alertas:      false,
  ocorrencias:  false,
};

function _resetTabFlags() {
  Object.keys(window._tabLoaded).forEach(k => window._tabLoaded[k] = false);
}

// Carrega os dados da aba ativa
async function loadTab(tab, filters = {}) {
  switch (tab) {
    case 'visao':
      if (window._tabLoaded.visao) return;
      await Promise.all([
        loadMetricas(filters),
        loadMensal(filters),
        loadPontos(filters),   // popula window._pontosCache, cSensores e select do horário
      ]);
      await loadSazonal(filters); // depois de _sensorExterno estar definido
      await loadOrvalho(filters); // depende do select populado por populateFilters
      window._tabLoaded.visao = true;
      break;

    case 'pontos':
      if (window._tabLoaded.pontos) return;
      // cScatter está na aba pontos — reusa window._pontosCache se já foi carregado
      if (!window._pontosCache.length) await loadPontos(filters);
      else { renderPontosTable(); renderSensores(); }
      window._tabLoaded.pontos = true;
      break;

    case 'exposicoes':
      if (window._tabLoaded.exposicoes) return;
      await loadExposicoes();
      window._tabLoaded.exposicoes = true;
      break;

    case 'alertas':
      if (window._tabLoaded.alertas) return;
      await loadAlertas(filters);
      window._tabLoaded.alertas = true;
      break;

    case 'ocorrencias':
      if (window._tabLoaded.ocorrencias) return;
      await loadOcorrenciasTab(filters);
      window._tabLoaded.ocorrencias = true;
      break;
  }
}

// Boot: carrega apenas a aba inicial (Visão Geral)
async function loadAll(filters = {}) {
  const hash = location.hash.replace('#', '') || 'visao';
  const abaInicial = ['visao','pontos','exposicoes','alertas','ocorrencias'].includes(hash) ? hash : 'visao';
  await loadTab(abaInicial, filters);
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
