// ── BASE FUNCTIONS (sem dependências de API) ──────────────
function switchTab(name, btn) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  history.replaceState(null, '', '#' + name);

  // Carrega dados da aba se ainda não foram carregados
  if (typeof loadTab === 'function') {
    loadTab(name, window._lastFilters || {}).catch(e => console.warn('loadTab:', e));
  }
}

function toggleInfoPopover(id) {
  const wrap = document.getElementById(id);
  const isOpen = wrap.classList.contains('open');
  // Fecha todos os outros popovers abertos
  document.querySelectorAll('.info-icon-wrap.open').forEach(el => el.classList.remove('open'));
  if (!isOpen) {
    wrap.classList.add('open');
    // Detecta se o popover está vazando pela borda esquerda da janela
    const popover = wrap.querySelector('.info-popover');
    if (popover) {
      popover.style.right  = '';
      popover.style.left   = '';
      const rect = popover.getBoundingClientRect();
      if (rect.left < 8) {
        popover.style.right = 'auto';
        popover.style.left  = '0';
      }
    }
  }
}

// Fecha popovers ao clicar fora
document.addEventListener('click', e => {
  if (!e.target.closest('.info-icon-wrap')) {
    document.querySelectorAll('.info-icon-wrap.open').forEach(el => el.classList.remove('open'));
  }
});

function toggleAlerts() {
  const wrap = document.getElementById('alertListWrap');
  const chev = document.getElementById('alertChev');
  wrap.classList.toggle('collapsed');
  chev.classList.toggle('collapsed');
  chev.textContent = wrap.classList.contains('collapsed') ? '▶' : '▼';
}

function badgeFor(v) {
  if (v == null) return '<span class="badge badge-gray">–</span>';
  if (v >= 85) return `<span class="badge badge-green">${v}%</span>`;
  if (v >= 70) return `<span class="badge badge-amber">${v}%</span>`;
  return `<span class="badge badge-red">${v}%</span>`;
}

function clearFilters() {
  // Restaura o estado padrão do boot: todos os pontos selecionados,
  // período expositivo = Todos, intervalo = últimos 30 dias a partir da última medição.
  if (window.selectAllPontos) selectAllPontos(true);
  document.querySelectorAll('#fPeriodo .seg-btn').forEach(b => b.classList.remove('active'));
  const allBtn = document.querySelector('#fPeriodo .seg-btn[data-val=""]');
  if (allBtn) allBtn.classList.add('active');
  // Usa a data mais recente do banco (salva no boot) ou hoje como fallback
  const ref   = window._ultimaMedicao ? new Date(window._ultimaMedicao + 'T12:00:00') : new Date();
  const ini30 = new Date(ref); ini30.setDate(ref.getDate() - 30);
  document.getElementById('fDataIni').value = ini30.toISOString().slice(0, 10);
  document.getElementById('fDataFim').value = ref.toISOString().slice(0, 10);
  document.getElementById('filterInfo').textContent = 'Exibindo dados dos últimos 30 dias';
}

function showTt(e, date, cnt) {
  const tt = document.getElementById('hmTt');
  tt.textContent = `${date}: ${cnt} alerta${cnt !== 1 ? 's' : ''}`;
  tt.style.display = 'block';
  tt.style.left = (e.clientX + 12) + 'px';
  tt.style.top = (e.clientY - 28) + 'px';
}
function hideTt() { document.getElementById('hmTt').style.display = 'none'; }

// Drag & drop
const zone = document.getElementById('uploadZone');
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
zone.addEventListener('drop', e => {
  e.preventDefault();
  zone.classList.remove('drag');
  const files = [...e.dataTransfer.files].filter(f => /\.(json|csv)$/i.test(f.name));
  if (files.length && window.handleFilesAPI) handleFilesAPI(files);
});

// Restaura aba ativa a partir do hash da URL (ex: #analise, #gerenciar)
(function() {
  const hash = location.hash.slice(1);
  if (hash) {
    const pane = document.getElementById('tab-' + hash);
    const btn  = document.querySelector(`.tab-btn[onclick*="'${hash}'"]`);
    if (pane && btn) {
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      pane.classList.add('active');
      btn.classList.add('active');
    }
  }
})();

// ── STATUS DOT — sincroniza com o infoBanner (modificado pelo api.js) ──
(function() {
  const banner = document.getElementById('infoBanner');
  const dot    = document.getElementById('statusDot');
  const lbl    = document.getElementById('statusLabel');
  if (!banner || !dot || !lbl) return;

  function syncDot() {
    const status = banner.dataset.status || '';
    if (status === 'ok') {
      dot.className = 'status-dot ok';
      lbl.textContent = 'BANCO CONECTADO';
    } else if (status === 'warn') {
      dot.className = 'status-dot warn';
      lbl.textContent = 'AVISO';
    } else if (status === 'err') {
      dot.className = 'status-dot err';
      lbl.textContent = 'ERRO DE CONEXÃO';
    } else {
      dot.className = 'status-dot';
      lbl.textContent = 'CONECTANDO...';
    }
  }

  const obs = new MutationObserver(syncDot);
  obs.observe(banner, { attributes: true, attributeFilter: ['data-status'] });
})();

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

  // ── Chip groups agrupados por prédio + andar ──
  // Agrupar só por andar quebraria com dois prédios (Lina e Pietro): ambos podem ter
  // um "2º Andar" e os sensores de um apareceriam misturados com os do outro.
  const groups = document.getElementById('fPontoGroups');
  if (groups && meta.pontos.length) {
    const byAndar = {};
    meta.pontos.filter(p => p && p.nome).forEach(p => {
      const a = `${p.predio || 'Lina'} · ${p.andar || 'Sem andar'}`;
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

// ── Checkboxes do relatório (Agrupados por Prédio + Andar) ──
  const grid = document.getElementById('repSensores');
  if (grid && meta.pontos.length) {
    const pontosFiltrados = meta.pontos.filter(p => p && p.nome);
    const porAndar = {};

    pontosFiltrados.forEach(p => {
      const a = `${p.predio || 'Lina'} · ${p.andar || 'Sem andar'}`;
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

function getActivePadrao() {
  return document.querySelector('#segPadrão .seg-btn.active')?.dataset.padrao || 'ibram';
}

function renderPontosTable() {
  const padrao  = getActivePadrao();
  const tb = document.getElementById('tPontos');
  if (!tb || !window._pontosCache.length) return;

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

  tb.innerHTML = window._pontosCache.map(p => `
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

// ── GERENCIAR: SUB-TABS ───────────────────────────────────
function switchGTab(name, btn) {
  document.querySelectorAll('.gtab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.gtab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('gtab-' + name).classList.add('active');
  btn.classList.add('active');
}
