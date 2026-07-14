import * as engine from './engine.js';

// ---------------------------------------------------------------------------
// Estado de la aplicación
// ---------------------------------------------------------------------------

const state = {
  page: 'rendimiento',
  layoutVariant: 'A',

  rend: {
    brandKeywords: 'marca, brand, branded, brnd',
    status: 'idle', error: null, fileName: null,
    rows: null, resumen: null, recs: null,
    chartTab: 'gasto',
  },

  neg: {
    core: 'estelar\nmanzanillo',
    exceptions: 'manzanillo del mar',
    status: 'idle', error: null, fileName: null, rows: null,
  },

  copy: {
    url: '', status: 'idle', error: null,
    signals: null, headlines: null, descriptions: null,
    showFallback: false, htmlPaste: '',
  },

  book: {
    status: 'idle', error: null, fileName: null, rows: null, dateOrder: null,
    marketFilter: 'all', hotelFilter: 'all',
  },
};

const PAGE_META = {
  rendimiento: {
    title: 'Análisis de rendimiento',
    caption: 'Sube un export de campañas (CSV/Excel) y obtén gráficas y recomendaciones de optimización priorizadas por gasto.',
  },
  negativizacion: {
    title: 'Negativización de términos de búsqueda',
    caption: 'Sube el export de "Términos de búsqueda", define qué es relevante y obtén una lista de candidatos a negativo lista para revisar antes de subirla a Google Ads.',
  },
  copys: {
    title: 'Generador de copys desde URL',
    caption: 'Pega la URL de una página y obtén 15 títulos (≤30 caracteres) y 10 descripciones (≤90 caracteres) para un anuncio de búsqueda responsivo.',
  },
  bookings: {
    title: 'Bookings',
    caption: 'Sube el export de reservas reales (Excel/CSV) y obtén reservas por mercado, días de antelación entre la reserva y la estadía, y un heatmap de reservas por mes de llegada y mercado.',
  },
};

const REC_CATEGORY_META = {
  'CPA': { icon: 'trending-up', tone: 'dark' },
  'Presupuesto': { icon: 'bar-chart-2', tone: 'gold' },
  'Relevancia (CTR)': { icon: 'search', tone: 'dark' },
  'Ranking / Quality Score': { icon: 'refresh-cw', tone: 'gold' },
};

// ---------------------------------------------------------------------------
// Utilidades de formato / seguridad
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'N/D';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}
function pctWidth(v, max) {
  if (!max || Number.isNaN(v)) return 2;
  return Math.max(2, Math.min(100, (v / max) * 100));
}
function icon(name, size = 18) {
  return `<i data-lucide="${name}" width="${size}" height="${size}"></i>`;
}

// ---------------------------------------------------------------------------
// Render raíz
// ---------------------------------------------------------------------------

const root = document.getElementById('page-root');

function render() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === state.page);
  });

  const meta = PAGE_META[state.page];
  let toggleHtml = '';
  if (state.page === 'rendimiento' && state.rend.status === 'ready') {
    toggleHtml = `
      <div class="seg-control">
        <button class="seg-btn ${state.layoutVariant === 'A' ? 'active' : ''}" data-action="layout-a">Vista estándar</button>
        <button class="seg-btn ${state.layoutVariant === 'B' ? 'active' : ''}" data-action="layout-b">Vista densa</button>
      </div>`;
  }

  let pageHtml = '';
  if (state.page === 'rendimiento') pageHtml = renderRendPage();
  else if (state.page === 'negativizacion') pageHtml = renderNegPage();
  else if (state.page === 'copys') pageHtml = renderCopyPage();
  else pageHtml = renderBookPage();

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">${escapeHtml(meta.title)}</h1>
        <p class="page-caption">${escapeHtml(meta.caption)}</p>
      </div>
      ${toggleHtml}
    </div>
    ${pageHtml}
  `;

  bindEvents();
  if (window.lucide) window.lucide.createIcons();
}

// ---------------------------------------------------------------------------
// Página 1 — Rendimiento
// ---------------------------------------------------------------------------

function renderRendPage() {
  const s = state.rend;

  let body = '';
  if (s.status === 'idle') {
    body = `
      <div class="card state-panel idle">
        ${icon('upload-cloud', 30)}
        <p>Esperando un archivo. Sube un export real o usa el ejemplo para ver el análisis completo.</p>
      </div>`;
  } else if (s.status === 'loading') {
    body = `
      <div class="card state-panel loading">
        <div class="spinner"></div>
        <p>Analizando archivo…</p>
      </div>`;
  } else if (s.status === 'error') {
    body = `
      <div class="error-panel">
        <strong>No se pudo leer el archivo.</strong> ${escapeHtml(s.error)}
      </div>`;
  } else if (s.status === 'ready') {
    body = state.layoutVariant === 'A' ? renderRendLayoutA() : renderRendLayoutB();
    const hasCpaFilePct = (s.rows || []).some((r) => !Number.isNaN(r.cpa_file_pct));
    body += `
      <p class="footnote">
        Los umbrales son heurísticos y ajustables — no reemplazan el criterio del estratega de cuenta.
        CTR mínimo por tipo: Search marca 20%, Search genérica 8%, Display 1%, Performance Max 3%.
        Sin la columna "Campaign type", o sin match de marca en el nombre, se trata como Search genérica.
        ${hasCpaFilePct ? ' "CPA (según archivo, %)" es la columna "CPA" tal cual viene en tu export — es una métrica distinta al CPA en $ que ya calculamos desde "Costo/conv." (usado en el resto de la pantalla).' : ''}
      </p>`;
  }

  return `
    <div class="card control-panel align-end">
      <div class="field">
        <label>Palabras que identifican una campaña de marca (separadas por coma)</label>
        <input type="text" id="rend-brand-keywords" value="${escapeHtml(s.brandKeywords)}" style="width:320px" />
      </div>
      <div class="field">
        <label>Export de campañas (CSV o Excel)</label>
        <input type="file" id="rend-file" accept=".csv,.xlsx,.xls" />
      </div>
      <button class="btn-outline" data-action="rend-demo">Usar sample_data.csv de ejemplo</button>
      ${s.fileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.fileName)}</strong></div>` : ''}
    </div>
    ${body}
  `;
}

function buildGastoRows(rows) {
  const maxVal = Math.max(1, ...rows.map((r) => r.cost || 0));
  return [...rows].sort((a, b) => (b.cost || 0) - (a.cost || 0)).map((r) => ({
    campaign: r.campaign,
    valueLabel: fmtMoney(r.cost || 0),
    width: pctWidth(r.cost || 0, maxVal),
    color: 'var(--navy-800)',
  }));
}
function buildCpaRows(rows, avgCpaSimple) {
  const valid = rows.filter((r) => !Number.isNaN(r.cpa));
  const maxVal = Math.max(1, ...valid.map((r) => r.cpa));
  return [...valid].sort((a, b) => b.cpa - a.cpa).map((r) => {
    const flagged = avgCpaSimple && r.cpa > avgCpaSimple * 1.2;
    return {
      campaign: r.campaign,
      valueLabel: fmtMoney(r.cpa) + (flagged ? ' · alto' : ''),
      width: pctWidth(r.cpa, maxVal),
      color: flagged ? 'var(--danger)' : 'var(--navy-800)',
    };
  });
}
function buildCtrRows(rows) {
  const valid = rows.filter((r) => !Number.isNaN(r.ctr));
  const maxVal = Math.max(0.01, ...valid.map((r) => r.ctr));
  return [...valid].sort((a, b) => b.ctr - a.ctr).map((r) => {
    const type = r.campaign_type || 'search_generic';
    const threshold = engine.CTR_THRESHOLDS_BY_TYPE[type] ?? engine.CTR_THRESHOLDS_BY_TYPE.search_generic;
    const flagged = r.ctr < threshold;
    return {
      campaign: r.campaign,
      valueLabel: (r.ctr * 100).toFixed(2) + '% · mín. ' + (threshold * 100).toFixed(0) + '%',
      width: pctWidth(r.ctr, maxVal),
      color: flagged ? 'var(--danger)' : 'var(--navy-800)',
    };
  });
}
// Columna "CPA" del archivo, en % — distinta del CPA en $ que ya calculamos
// nosotros (cpa, desde "Costo/conv."). Solo aparece cuando el export trae
// esa columna (reportes con métricas de adquisición de clientes nuevos).
function buildCpaFilePctRows(rows) {
  const valid = rows.filter((r) => !Number.isNaN(r.cpa_file_pct));
  const maxVal = Math.max(0.01, ...valid.map((r) => r.cpa_file_pct));
  return [...valid].sort((a, b) => b.cpa_file_pct - a.cpa_file_pct).map((r) => ({
    campaign: r.campaign,
    valueLabel: (r.cpa_file_pct * 100).toFixed(2) + '%',
    width: pctWidth(r.cpa_file_pct, maxVal),
    color: 'var(--navy-800)',
  }));
}
function buildIsRows(rows) {
  const maxVal = Math.max(0.01, ...rows.map((r) => (r.lost_is_budget || 0) + (r.lost_is_rank || 0)));
  return [...rows].sort((a, b) => ((b.lost_is_budget || 0) + (b.lost_is_rank || 0)) - ((a.lost_is_budget || 0) + (a.lost_is_rank || 0))).map((r) => {
    const budget = r.lost_is_budget || 0, rank = r.lost_is_rank || 0;
    return {
      campaign: r.campaign,
      valueLabel: `Presup. ${(budget * 100).toFixed(0)}% · Rank ${(rank * 100).toFixed(0)}%`,
      width: pctWidth(budget + rank, maxVal),
      color: 'var(--gold-600)',
    };
  });
}

function barRowsHtml(rows, compact) {
  return rows.map((r) => `
    <div class="bar-row">
      <div class="bar-label">${escapeHtml(r.campaign)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${r.width}%;background:${r.color}"></div></div>
      <div class="bar-value">${escapeHtml(r.valueLabel)}</div>
    </div>`).join('');
}

function renderRendLayoutA() {
  const s = state.rend;
  const rows = s.rows, resumen = s.resumen, recs = s.recs || [];

  const hasCpaFilePct = rows.some((r) => !Number.isNaN(r.cpa_file_pct));

  const tabMap = {
    gasto: buildGastoRows(rows),
    cpa: buildCpaRows(rows, resumen.avg_cpa_simple),
    ctr: buildCtrRows(rows),
    is: buildIsRows(rows),
  };
  if (hasCpaFilePct) tabMap.cpa_file = buildCpaFilePctRows(rows);
  const activeRows = tabMap[s.chartTab] || tabMap.gasto;

  const tabDefs = [
    ['gasto', 'Gasto'], ['cpa', 'CPA'], ['ctr', 'CTR'], ['is', 'Impression share perdido'],
  ];
  if (hasCpaFilePct) tabDefs.push(['cpa_file', 'CPA (archivo, %)']);
  const tabs = tabDefs
    .map(([key, label]) => `<button class="tab-btn ${s.chartTab === key ? 'active' : ''}" data-rend-tab="${key}">${label}</button>`).join('');

  const recsHtml = recs.length
    ? `<div class="rec-list">${recs.map((r) => {
        const metaR = REC_CATEGORY_META[r.categoria] || { icon: 'bar-chart-2', tone: 'dark' };
        const impactoPct = (r.impacto_gasto * 100).toFixed(0) + '%';
        return `
          <div class="card rec-card">
            <div class="icon-tile tone-${metaR.tone}">${icon(metaR.icon, 18)}</div>
            <div class="rec-body">
              <div class="rec-head">
                <span class="rec-campaign">${escapeHtml(r.campaign)}</span>
                <span class="rec-cat">${escapeHtml(r.categoria)}</span>
              </div>
              <p class="rec-hallazgo">${escapeHtml(r.hallazgo)}</p>
              <p class="rec-recomendacion">➜ ${escapeHtml(r.recomendacion)}</p>
            </div>
            <div class="rec-impact">
              <div class="rec-impact-label">Impacto</div>
              <div class="rec-impact-value">${impactoPct}</div>
            </div>
          </div>`;
      }).join('')}</div>`
    : `<div class="ok-panel">No se detectaron banderas con los umbrales actuales. La cuenta luce estable.</div>`;

  return `
    <div class="stat-grid">
      <div class="card stat-card">
        <div class="stat-label">Gasto total</div>
        <div class="stat-value">${fmtMoney(resumen.total_cost)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Conversiones</div>
        <div class="stat-value">${fmtInt(resumen.total_conversions)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">CPA promedio · ponderado por gasto</div>
        <div class="stat-value">${resumen.avg_cpa_weighted != null ? fmtMoney(resumen.avg_cpa_weighted) : 'N/D'}</div>
        <div class="stat-sub">Gasto total ÷ conversiones totales</div>
      </div>
      <div class="card stat-card accent">
        <div class="stat-label">CPA promedio · simple entre campañas</div>
        <div class="stat-value">${resumen.avg_cpa_simple != null ? fmtMoney(resumen.avg_cpa_simple) : 'N/D'}</div>
        <div class="stat-sub">Usado por la alerta de "CPA alto"</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Campañas con gasto</div>
        <div class="stat-value">${fmtInt(resumen.campanas_con_gasto)}</div>
      </div>
    </div>

    <div class="card chart-card">
      <div class="tab-row">${tabs}</div>
      <div class="bar-rows">${barRowsHtml(activeRows)}</div>
    </div>

    <div>
      <h2 class="section-title">Recomendaciones de optimización (${recs.length})</h2>
      ${recsHtml}
    </div>
  `;
}

function renderRendLayoutB() {
  const s = state.rend;
  const rows = s.rows, resumen = s.resumen, recs = s.recs || [];

  const gastoRows = buildGastoRows(rows);
  const cpaRows = buildCpaRows(rows, resumen.avg_cpa_simple);
  const ctrRows = buildCtrRows(rows);
  const isRows = buildIsRows(rows);
  const hasCpaFilePct = rows.some((r) => !Number.isNaN(r.cpa_file_pct));
  const cpaFilePctRows = hasCpaFilePct ? buildCpaFilePctRows(rows) : [];

  const recsHtml = recs.length
    ? recs.map((r) => `
        <div class="dense-rec-item">
          <div class="dense-rec-head">
            <span>${escapeHtml(r.campaign)}</span>
            <span>${escapeHtml(r.categoria)}</span>
          </div>
          <p>${escapeHtml(r.recomendacion)}</p>
        </div>`).join('')
    : `<p style="font-size:12.5px;color:var(--ok-text)">Sin banderas — cuenta estable.</p>`;

  return `
    <div class="dense-grid">
      <div class="dense-col-left">
        <div class="card dense-panel">
          <h3>Resumen ejecutivo</h3>
          <div class="dense-row"><span>Gasto total</span><strong>${fmtMoney(resumen.total_cost)}</strong></div>
          <div class="dense-row"><span>Conversiones</span><strong>${fmtInt(resumen.total_conversions)}</strong></div>
          <div class="dense-row"><span>CPA ponderado</span><strong>${resumen.avg_cpa_weighted != null ? fmtMoney(resumen.avg_cpa_weighted) : 'N/D'}</strong></div>
          <div class="dense-row accent"><span>CPA simple (alerta)</span><strong>${resumen.avg_cpa_simple != null ? fmtMoney(resumen.avg_cpa_simple) : 'N/D'}</strong></div>
          <div class="dense-row"><span>Campañas con gasto</span><strong>${fmtInt(resumen.campanas_con_gasto)}</strong></div>
        </div>
        <div class="card dense-recs">
          <h3>Recomendaciones (${recs.length})</h3>
          ${recsHtml}
        </div>
      </div>
      <div class="dense-col-right">
        <div class="card dense-panel">
          <h3 class="dense-chart-title">Gasto por campaña</h3>
          <div class="bar-rows compact">${barRowsHtml(gastoRows)}</div>
        </div>
        <div class="card dense-panel">
          <h3 class="dense-chart-title">CPA por campaña</h3>
          <div class="bar-rows compact">${barRowsHtml(cpaRows)}</div>
        </div>
        <div class="card dense-panel">
          <h3 class="dense-chart-title">CTR por campaña</h3>
          <div class="bar-rows compact">${barRowsHtml(ctrRows)}</div>
        </div>
        <div class="card dense-panel">
          <h3 class="dense-chart-title">Impression share perdido</h3>
          <div class="bar-rows compact">${barRowsHtml(isRows)}</div>
        </div>
        ${hasCpaFilePct ? `
        <div class="card dense-panel">
          <h3 class="dense-chart-title">CPA (según archivo, %)</h3>
          <div class="bar-rows compact">${barRowsHtml(cpaFilePctRows)}</div>
        </div>` : ''}
      </div>
    </div>
  `;
}

// Los exports de Google Ads en español a veces vienen en UTF-16 (con BOM) en
// vez de UTF-8 — leerlos como UTF-8 no solo rompe los acentos, rompe también
// cualquier comparación de texto exacta (ej. las filas "Total: ..." dejan de
// matchear la palabra "total" porque cada caracter queda separado por un
// byte nulo, y esas filas terminan tratándose como campañas reales). Se
// detecta la codificación real por el BOM en vez de asumir UTF-8 siempre.
function decodeFileText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer);
  }
  return new TextDecoder('utf-8').decode(buffer);
}

function readFileAsCsvText(file) {
  return new Promise((resolve, reject) => {
    const isExcel = /\.(xlsx|xls)$/i.test(file.name);
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    if (isExcel) {
      reader.onload = () => {
        try {
          const data = new Uint8Array(reader.result);
          const wb = window.XLSX.read(data, { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          resolve(window.XLSX.utils.sheet_to_csv(sheet));
        } catch (err) { reject(new Error('No se pudo leer el archivo Excel: ' + err.message)); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = () => {
        try { resolve(decodeFileText(reader.result)); }
        catch (err) { reject(new Error('No se pudo leer el archivo.')); }
      };
      reader.readAsArrayBuffer(file);
    }
  });
}

function runRendAnalysis(text, fileName) {
  const s = state.rend;
  try {
    const brandKeywords = s.brandKeywords.split(',').map((v) => v.trim()).filter(Boolean);
    const rowsRaw = engine.loadCampaignReport(text, brandKeywords);
    const rows = engine.computeMetrics(rowsRaw);
    const resumen = engine.summarize(rows);
    const recs = engine.generateRecommendations(rows);
    Object.assign(s, { status: 'ready', rows, resumen, recs, fileName });
  } catch (err) {
    Object.assign(s, { status: 'error', error: err.message || String(err), fileName });
  }
  render();
}

// ---------------------------------------------------------------------------
// Página 2 — Negativización
// ---------------------------------------------------------------------------

function renderNegPage() {
  const s = state.neg;

  let body = '';
  if (s.status === 'idle') {
    body = `
      <div class="card state-panel idle">
        ${icon('search', 30)}
        <p>Esperando el archivo de términos de búsqueda. Ningún término se publica automáticamente.</p>
      </div>`;
  } else if (s.status === 'loading') {
    body = `
      <div class="card state-panel loading">
        <div class="spinner"></div>
        <p>Clasificando términos…</p>
      </div>`;
  } else if (s.status === 'error') {
    body = `<div class="error-panel"><strong>No se pudo clasificar.</strong> ${escapeHtml(s.error)}</div>`;
  } else if (s.status === 'ready') {
    body = renderNegReady();
  }

  return `
    <div class="card control-panel">
      <div class="field" style="flex:1;min-width:240px">
        <label>Terminos de la campaña (lo que si debe ir)</label>
        <textarea id="neg-core" rows="3" style="width:100%;resize:vertical">${escapeHtml(s.core)}</textarea>
        <p class="field-hint">Una palabra o frase corta por línea, no la frase completa. Un término de búsqueda se mantiene si contiene <em>alguna</em> de estas líneas — mientras más corta la línea, más variantes reales captura (ej. usa <code>click clack</code> en vez de <code>click clack bogota</code>, si no cada búsqueda tendría que traer las tres palabras juntas y en ese orden para calzar).</p>
      </div>
      <div class="field" style="flex:1;min-width:240px">
        <label>Define los terminos de busqueda que no deben ir (Opcional)</label>
        <textarea id="neg-exceptions" rows="3" style="width:100%;resize:vertical">${escapeHtml(s.exceptions)}</textarea>
        <p class="field-hint">Para términos que coinciden con una línea de arriba pero sabes que no aplican (ej. otra sede de la marca, otra ciudad) — en vez de mantenerse solos, pasan a "revisar" para que los decidas a mano.</p>
      </div>
    </div>
    <div class="card control-panel align-end" style="margin-top:-8px">
      <div class="field">
        <label>Export de "Términos de búsqueda" (CSV)</label>
        <input type="file" id="neg-file" accept=".csv" />
      </div>
      <button class="btn-outline" data-action="neg-demo">Usar datos de ejemplo</button>
      ${s.fileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.fileName)}</strong></div>` : ''}
    </div>
    ${body}
  `;
}

function renderNegReady() {
  const rows = state.neg.rows;
  const summary = engine.summarizeClassification(rows);
  const maxCost = Math.max(1, summary.mantener.costo, summary.revisar.costo, summary.negativizar.costo);

  const chartRows = [
    { campaign: 'Mantener', valueLabel: fmtMoney(summary.mantener.costo), width: pctWidth(summary.mantener.costo, maxCost), color: 'var(--navy-800)' },
    { campaign: 'Revisar', valueLabel: fmtMoney(summary.revisar.costo), width: pctWidth(summary.revisar.costo, maxCost), color: 'var(--gold-600)' },
    { campaign: 'Negativizar', valueLabel: fmtMoney(summary.negativizar.costo), width: pctWidth(summary.negativizar.costo, maxCost), color: 'var(--danger)' },
  ];

  const negativizarAll = rows.filter((r) => r.clasificacion === 'negativizar').sort((a, b) => b.cost - a.cost);
  const revisarAll = rows.filter((r) => r.clasificacion === 'revisar').sort((a, b) => b.cost - a.cost);

  const termRowHtml = (r) => `
    <tr>
      <td>${escapeHtml(r.term)}</td>
      <td>${fmtInt(r.clicks)}</td>
      <td>${fmtInt(r.impr)}</td>
      <td>${fmtMoney(r.cost)}</td>
    </tr>`;

  const candidatosCaption = negativizarAll.length > 50 ? `mostrando 50 de ${negativizarAll.length}` : `${negativizarAll.length} términos`;
  const revisarCaption = revisarAll.length > 50 ? `mostrando 50 de ${revisarAll.length}` : `${revisarAll.length} términos`;

  const totalCosto = summary.mantener.costo + summary.revisar.costo + summary.negativizar.costo;
  const ahorroPct = totalCosto > 0 ? (summary.negativizar.costo / totalCosto) * 100 : 0;
  const ahorroRows = [
    { campaign: 'Gasto total analizado', valueLabel: fmtMoney(totalCosto), width: 100, color: 'var(--navy-800)' },
    { campaign: 'Ahorro si niegas estos términos', valueLabel: `${fmtMoney(summary.negativizar.costo)} · ${ahorroPct.toFixed(1)}%`, width: pctWidth(summary.negativizar.costo, totalCosto), color: 'var(--ok-text)' },
  ];
  const conversionesEnRiesgo = summary.negativizar.conversiones;

  return `
    <div class="stat-grid">
      <div class="card stat-card">
        <div class="stat-label">Mantener</div>
        <div class="stat-value lg">${fmtInt(summary.mantener.terminos)}</div>
        <div class="stat-sub">${fmtMoney(summary.mantener.costo)} · ${fmtInt(summary.mantener.clics)} clics</div>
      </div>
      <div class="card stat-card accent">
        <div class="stat-label">Revisar (ambiguos)</div>
        <div class="stat-value lg">${fmtInt(summary.revisar.terminos)}</div>
        <div class="stat-sub">${fmtMoney(summary.revisar.costo)} · ${fmtInt(summary.revisar.clics)} clics</div>
      </div>
      <div class="card stat-card danger">
        <div class="stat-label">Candidatos a negativo</div>
        <div class="stat-value lg">${fmtInt(summary.negativizar.terminos)}</div>
        <div class="stat-sub">${fmtMoney(summary.negativizar.costo)} · ${fmtInt(summary.negativizar.clics)} clics</div>
      </div>
    </div>

    <div class="card chart-card">
      <h3 class="dense-chart-title">Ahorro estimado si negativizas los terminos de busqueda</h3>
      <div style="display:flex;gap:28px;flex-wrap:wrap;align-items:flex-end;margin-bottom:16px">
        <div>
          <div class="stat-label" style="color:var(--ok-text)">Ahorro estimado</div>
          <div class="stat-value" style="color:var(--ok-text)">${fmtMoney(summary.negativizar.costo)}</div>
          <div class="stat-sub">${ahorroPct.toFixed(1)}% del gasto total en este reporte</div>
        </div>
      </div>
      ${conversionesEnRiesgo > 0 ? `
        <div class="error-panel" style="margin-bottom:16px">
          <strong>Ojo antes de negativizar todo el listado:</strong> estos términos también generaron ${fmtInt(conversionesEnRiesgo)} conversion${conversionesEnRiesgo === 1 ? '' : 'es'}. Revisa cuáles convierten antes de negativizarlos — negarlos a ciegas también corta esas conversiones.
        </div>` : ''}
      <div class="bar-rows">${barRowsHtml(ahorroRows)}</div>
      <p style="margin:14px 0 0;font-size:11.5px;color:var(--color-text-muted)">Ahorro = gasto ya invertido en los términos que caen en "Candidatos a negativo" en este reporte — no incluye los términos en "Revisar", que todavía no están decididos.</p>
    </div>

    <div class="card chart-card">
      <h3 class="dense-chart-title">Gasto por categoría</h3>
      <div class="bar-rows">${barRowsHtml(chartRows)}</div>
    </div>

    <div class="card table-panel" style="margin-bottom:20px">
      <div class="table-panel-head">
        <h3>Candidatos a negativo — ${candidatosCaption}</h3>
        <button class="btn-outline sm" data-action="download-neg-candidatos">Descargar CSV completo</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Término</th><th>Clics</th><th>Impr.</th><th>Costo</th></tr></thead>
          <tbody>${negativizarAll.slice(0, 50).map(termRowHtml).join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="card table-panel">
      <div class="table-panel-head">
        <h3>Revisar antes de decidir — ${revisarCaption}</h3>
        <button class="btn-outline sm" data-action="download-neg-revisar">Descargar CSV</button>
      </div>
      <p style="margin:0 0 12px;font-size:12.5px;color:var(--color-text-muted)">Contienen un término núcleo pero también una excepción conocida — no se clasifican solos.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Término</th><th>Clics</th><th>Impr.</th><th>Costo</th></tr></thead>
          <tbody>${revisarAll.slice(0, 50).map(termRowHtml).join('')}</tbody>
        </table>
      </div>
    </div>

    <p class="footnote">
      El mecanismo compara texto contra los términos núcleo y las excepciones definidas — no usa un modelo de lenguaje por término.
      Solo detecta la ambigüedad anticipada como excepción; nunca subas "candidatos a negativo" a Google Ads sin revisión humana.
    </p>
  `;
}

function runNegAnalysis(text, fileName) {
  const s = state.neg;
  try {
    const coreTerms = s.core.split('\n').map((v) => v.trim()).filter(Boolean);
    if (!coreTerms.length) throw new Error('Escribe al menos un término núcleo para poder clasificar.');
    const exceptions = s.exceptions.split('\n').map((v) => v.trim()).filter(Boolean);
    const rows = engine.loadSearchTerms(text);
    const classified = engine.classifyTerms(rows, coreTerms, exceptions);
    Object.assign(s, { status: 'ready', rows: classified, fileName });
  } catch (err) {
    Object.assign(s, { status: 'error', error: err.message || String(err), fileName });
  }
  render();
}

// ---------------------------------------------------------------------------
// Página 3 — Generador de copys
// ---------------------------------------------------------------------------

function renderCopyPage() {
  const s = state.copy;

  let body = '';
  if (s.status === 'idle') {
    body = `
      <div class="card state-panel idle">
        ${icon('send', 30)}
        <p>Pega una URL o usa un ejemplo para generar 15 títulos y 10 descripciones.</p>
      </div>`;
  } else if (s.status === 'loading') {
    body = `
      <div class="card state-panel loading">
        <div class="spinner"></div>
        <p>Descargando y analizando la página…</p>
      </div>`;
  } else if (s.status === 'error') {
    body = `<div class="error-panel">${escapeHtml(s.error)}</div>`;
  } else if (s.status === 'ready') {
    body = renderCopyReady();
  }

  const fallbackHtml = s.showFallback ? `
    <div style="margin-top:14px;display:flex;flex-direction:column;gap:8px">
      <textarea id="copy-html-paste" rows="4" placeholder="Pega aquí el HTML de la página" style="width:100%;font-family:ui-monospace,monospace;font-size:12px;resize:vertical">${escapeHtml(s.htmlPaste)}</textarea>
      <div><button class="btn-dark" data-action="copy-analyze-html">Analizar HTML pegado</button></div>
    </div>` : '';

  return `
    <div class="card control-panel" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px">
        <div class="field" style="flex:1;min-width:280px">
          <label>URL de la página</label>
          <input type="text" id="copy-url" placeholder="https://www.tusitio.com/producto" value="${escapeHtml(s.url)}" style="width:100%" />
        </div>
        <button class="btn-accent" data-action="copy-analyze-url">Analizar página</button>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <span style="font-size:12px;color:var(--color-text-muted)">Ejemplos rápidos:</span>
        <button class="btn-outline xs" data-action="copy-demo-completa">Página completa (hotel)</button>
        <button class="btn-outline xs" data-action="copy-demo-minima">Página mínima</button>
        <button class="btn-link" data-action="copy-toggle-fallback">¿No cargó? Pega el HTML</button>
      </div>
      ${fallbackHtml}
    </div>
    ${body}
  `;
}

function renderCopyReady() {
  const s = state.copy;
  const signals = s.signals;

  const headlineRows = s.headlines.map((h) => `
    <tr><td>${escapeHtml(h.text)}</td><td style="text-align:right;color:var(--color-text-muted)">${h.chars}</td></tr>`).join('');
  const descriptionRows = s.descriptions.map((d) => `
    <tr><td>${escapeHtml(d.text)}</td><td style="text-align:right;color:var(--color-text-muted)">${d.chars}</td></tr>`).join('');

  return `
    <div class="card signals-panel">
      <div class="signal-block">
        <div class="signal-label">Marca detectada</div>
        <div class="signal-value">${escapeHtml(signals.brand)}</div>
      </div>
      <div class="signal-block">
        <div class="signal-label">Frase clave detectada</div>
        <div class="signal-value">${escapeHtml(signals.keyword)}</div>
      </div>
      <div class="signal-block wide">
        <div class="signal-label">Ofertas encontradas</div>
        <div class="signal-value">${escapeHtml(signals.offers.join(', '))}</div>
      </div>
    </div>

    <div class="two-col">
      <div class="card table-panel">
        <div class="table-panel-head">
          <h3>15 títulos (máx. ${engine.HEADLINE_LIMIT} caracteres)</h3>
          <button class="btn-outline xs" data-action="download-copy-headlines">Descargar CSV</button>
        </div>
        <table>
          <thead><tr><th>Título</th><th style="text-align:right">Caract.</th></tr></thead>
          <tbody>${headlineRows}</tbody>
        </table>
      </div>
      <div class="card table-panel">
        <div class="table-panel-head">
          <h3>10 descripciones (máx. ${engine.DESCRIPTION_LIMIT} caracteres)</h3>
          <button class="btn-outline xs" data-action="download-copy-descriptions">Descargar CSV</button>
        </div>
        <table>
          <thead><tr><th>Descripción</th><th style="text-align:right">Caract.</th></tr></thead>
          <tbody>${descriptionRows}</tbody>
        </table>
      </div>
    </div>

    <p class="footnote">
      Esto no "entiende" la página como un modelo de lenguaje — extrae texto real y lo combina con plantillas de conversión.
      Revisa siempre el copy antes de publicarlo; Google Ads tiene políticas propias (mayúsculas, superlativos, marcas de terceros)
      que esta plataforma no valida.
    </p>
  `;
}

function finishCopyAnalysis(html, url) {
  const s = state.copy;
  try {
    const signals = engine.extractSignals(html, url);
    const headlines = engine.generateHeadlines(signals, 15).map((t) => ({ text: t, chars: t.length }));
    const descriptions = engine.generateDescriptions(signals, 10).map((t) => ({ text: t, chars: t.length }));
    Object.assign(s, { status: 'ready', signals, headlines, descriptions, error: null });
  } catch (err) {
    Object.assign(s, { status: 'error', error: 'No se pudo analizar el contenido: ' + (err.message || String(err)) });
  }
  render();
}

function onCopyAnalyzeUrl() {
  const s = state.copy;
  const raw = s.url.trim();
  if (!raw) return;
  const url = raw.startsWith('http') ? raw : 'https://' + raw;
  s.status = 'loading'; s.error = null;
  render();
  // La descarga ocurre del lado del servidor (endpoint /api/fetch en server.py)
  // para evitar el bloqueo CORS que el navegador aplica a fetch() directo a
  // otro dominio. Si ese endpoint no está disponible (p. ej. abriendo el sitio
  // con un http.server genérico en vez de server.py), cae al mismo mensaje
  // de fallback de siempre.
  fetch('/api/fetch?url=' + encodeURIComponent(url))
    .then((resp) => resp.json().then((data) => ({ ok: resp.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data && data.error ? data.error : 'No se pudo descargar la página.');
      finishCopyAnalysis(data.html, data.url || url);
    })
    .catch((err) => {
      let msg = err.message || 'No se pudo descargar la página automáticamente.';
      if (!/[.!?]$/.test(msg.trim())) msg = msg.trim() + '.';
      Object.assign(s, {
        status: 'error',
        error: msg + ' Pega el HTML manualmente abajo, o prueba un ejemplo.',
        showFallback: true,
      });
      render();
    });
}

// ---------------------------------------------------------------------------
// Página 4 — Bookings
// ---------------------------------------------------------------------------

function renderBookPage() {
  const s = state.book;

  let body = '';
  if (s.status === 'idle') {
    body = `
      <div class="card state-panel idle">
        ${icon('calendar-days', 30)}
        <p>Esperando el archivo de reservas. Sube un export real o usa el ejemplo para ver las gráficas completas.</p>
      </div>`;
  } else if (s.status === 'loading') {
    body = `
      <div class="card state-panel loading">
        <div class="spinner"></div>
        <p>Procesando reservas…</p>
      </div>`;
  } else if (s.status === 'error') {
    body = `<div class="error-panel"><strong>No se pudo leer el archivo.</strong> ${escapeHtml(s.error)}</div>`;
  } else if (s.status === 'ready') {
    body = renderBookReady();
  }

  return `
    <div class="card control-panel align-end">
      <div class="field">
        <label>Export de reservas (CSV o Excel)</label>
        <input type="file" id="book-file" accept=".csv,.xlsx,.xls" />
      </div>
      <button class="btn-outline" data-action="book-demo">Usar datos de ejemplo</button>
      ${s.fileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.fileName)}</strong></div>` : ''}
    </div>
    ${body}
  `;
}

function renderBookReady() {
  const s = state.book;
  const allRows = s.rows;
  const allMarkets = engine.listBookingMarkets(allRows);
  const allHotels = engine.listBookingHotels(allRows);
  const rows = allRows
    .filter((r) => s.marketFilter === 'all' || r.pais === s.marketFilter)
    .filter((r) => s.hotelFilter === 'all' || r.hotel === s.hotelFilter);

  const marketFilterOptions = ['<option value="all">Todos los mercados</option>']
    .concat(allMarkets.map((m) => `<option value="${escapeHtml(m)}" ${s.marketFilter === m ? 'selected' : ''}>${escapeHtml(m)}</option>`))
    .join('');
  const hotelFilterOptions = ['<option value="all">Todos los hoteles</option>']
    .concat(allHotels.map((h) => `<option value="${escapeHtml(h)}" ${s.hotelFilter === h ? 'selected' : ''}>${escapeHtml(h)}</option>`))
    .join('');

  const totalReservas = rows.length;
  const totalNoches = rows.reduce((sum, r) => sum + (r.stayNights !== null && !Number.isNaN(r.stayNights) && r.stayNights >= 0 ? r.stayNights : 0), 0);
  const markets = engine.listBookingMarkets(rows);

  const byMarket = engine.summarizeBookingsByMarket(rows);
  const maxReservasMarket = Math.max(1, ...byMarket.map((m) => m.reservas));
  const marketRows = byMarket.map((m) => ({
    campaign: m.mercado,
    valueLabel: `${fmtInt(m.reservas)} reservas · ${fmtInt(m.noches)} noches`,
    width: pctWidth(m.reservas, maxReservasMarket),
    color: 'var(--navy-800)',
  }));

  const leadSummary = engine.summarizeLeadTime(rows);
  const maxLead = Math.max(1, ...leadSummary.buckets.map((b) => b.reservas));
  const leadRows = leadSummary.buckets.map((b) => ({
    campaign: b.label,
    valueLabel: `${fmtInt(b.reservas)} reservas`,
    width: pctWidth(b.reservas, maxLead),
    color: 'var(--gold-600)',
  }));

  const dateOrderLabel = s.dateOrder === 'MDY' ? 'MM/DD/AAAA (mes primero)' : 'DD/MM/AAAA (día primero)';

  return `
    <p style="margin:0 0 16px;font-size:12px;color:var(--color-text-muted)">
      Formato de fecha por defecto en este archivo: <strong style="color:var(--color-text-heading)">${dateOrderLabel}</strong>
      (cada reserva se interpreta primero con su propia fecha de alta/entrada/salida; esto solo se usa cuando una reserva
      no trae ninguna pista propia). Si "Antelación promedio" o las noches por reserva se ven muy altas, avísame.
    </p>
    ${s.mixedFormats ? `
      <div class="error-panel" style="margin-bottom:16px">
        <strong>Este archivo mezcla formatos de fecha entre filas</strong> — algunas reservas traen día/mes en un orden y otras
        en el orden contrario (visible porque hay fechas con día &gt;12 en ambas posiciones en distintas filas). Cada reserva
        ya se interpreta con su propia evidencia cuando la tiene, pero vale la pena que revises el archivo — podría venir de
        pegar exports de distintos sistemas o fechas.
      </div>` : ''}
    <div class="card" style="padding:16px 20px;margin-bottom:20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <label style="font-size:12px;font-weight:600;color:var(--color-text-heading)">Filtrar por mercado</label>
      <select id="book-market-filter">${marketFilterOptions}</select>
      ${allHotels.length > 1 ? `
        <label style="font-size:12px;font-weight:600;color:var(--color-text-heading)">Filtrar por hotel</label>
        <select id="book-hotel-filter">${hotelFilterOptions}</select>
      ` : ''}
      ${s.marketFilter !== 'all' || s.hotelFilter !== 'all' ? `
        <span style="font-size:12px;color:var(--color-text-muted)">Mostrando solo
          ${s.marketFilter !== 'all' ? `<strong style="color:var(--color-text-heading)">${escapeHtml(s.marketFilter)}</strong>` : ''}
          ${s.marketFilter !== 'all' && s.hotelFilter !== 'all' ? ' · ' : ''}
          ${s.hotelFilter !== 'all' ? `<strong style="color:var(--color-text-heading)">${escapeHtml(s.hotelFilter)}</strong>` : ''}
          — todo lo de abajo está filtrado.
        </span>` : ''}
    </div>
    <div class="stat-grid">
      <div class="card stat-card">
        <div class="stat-label">Reservas totales</div>
        <div class="stat-value">${fmtInt(totalReservas)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Noches de habitación</div>
        <div class="stat-value">${fmtInt(totalNoches)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Mercados distintos</div>
        <div class="stat-value">${fmtInt(markets.length)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Antelación promedio</div>
        <div class="stat-value">${leadSummary.promedio != null ? fmtInt(leadSummary.promedio) + ' días' : 'N/D'}</div>
        <div class="stat-sub">${fmtInt(leadSummary.totalConDato)} reservas con fecha válida</div>
      </div>
    </div>

    <div class="card chart-card">
      <h3 class="dense-chart-title">Reservas por mercado</h3>
      <div class="bar-rows">${barRowsHtml(marketRows)}</div>
    </div>

    <div class="card chart-card">
      <h3 class="dense-chart-title">Días de antelación (reserva → estadía)</h3>
      <div class="bar-rows">${barRowsHtml(leadRows)}</div>
      ${leadSummary.sinDato > 0 ? `<p style="margin:14px 0 0;font-size:11.5px;color:var(--color-text-muted)">${fmtInt(leadSummary.sinDato)} reserva(s) sin fecha de reserva y/o de entrada válidas, excluidas de este cálculo.</p>` : ''}
    </div>

    <div class="card chart-card">
      <h3 class="dense-chart-title">Reservas, noches y promedio de noches por mercado</h3>
      ${renderBookingsHeatmap(rows)}
    </div>

    <div class="card chart-card">
      <h3 class="dense-chart-title">Distribución de llegadas (%) por día de la semana</h3>
      ${renderArrivalsByWeekday(rows)}
    </div>

    <p class="footnote">
      El formato de fecha (día primero vs. mes primero) se detecta mirando todas las fechas del archivo a la vez: basta con
      que una fecha traiga un número mayor a 12 en alguna posición para saber con certeza cuál es el día — esa misma regla
      se aplica después a todas las fechas del archivo, para que la fecha de entrada y la de salida de una misma reserva
      nunca se interpreten con el día y el mes invertidos entre sí.
    </p>
  `;
}

function heatColor(value, max) {
  const light = [244, 245, 248]; // --gray-50
  const dark = [20, 33, 61]; // --navy-800
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const rgb = light.map((c, i) => Math.round(c + (dark[i] - c) * ratio));
  return { bg: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`, fg: ratio > 0.55 ? '#ffffff' : 'var(--color-text-heading)' };
}

function renderBookingsHeatmap(rows) {
  const summary = engine.summarizeByMarketAndMonth(rows);
  if (!summary.months.length) {
    return `<p style="font-size:12.5px;color:var(--color-text-muted)">No hay reservas con fecha de entrada válida para graficar.</p>`;
  }
  const maxNoches = Math.max(1, ...summary.markets.flatMap((m) => m.cells.map((c) => c.noches)));

  const headerCells = summary.months.map((m) => `<th>${escapeHtml(m)}</th>`).join('');
  const bodyRows = summary.markets.map((m) => {
    const cells = m.cells.map((c) => {
      const { bg, fg } = heatColor(c.noches, maxNoches);
      const content = c.reservas > 0
        ? `<div class="heatmap-cell-main">${fmtInt(c.reservas)}</div><div class="heatmap-cell-sub">(${fmtInt(c.noches)}N)</div>`
        : `<div class="heatmap-cell-main" style="opacity:.35">0</div>`;
      return `<td class="heatmap-cell" style="background:${bg};color:${fg}">${content}</td>`;
    }).join('');
    return `
      <tr>
        <td class="heatmap-row-label">${escapeHtml(m.market)}</td>
        ${cells}
        <td><div class="heatmap-avg-cell">${m.promNoches.toFixed(2)}</div></td>
      </tr>`;
  }).join('');

  return `
    <div class="heatmap-wrap">
      <table class="heatmap-table">
        <thead><tr><th></th>${headerCells}<th>Prom.<br>noches</th></tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <p style="margin:12px 0 0;font-size:11px;color:var(--color-text-muted)">Formato de celda: reservas (noches). La columna derecha muestra el promedio de noches por reserva de cada mercado. Mes = mes de llegada (entrada), incluye todo el rango del archivo (pasado y futuro).</p>
  `;
}

function renderArrivalsByWeekday(rows) {
  const data = engine.summarizeArrivalsByWeekday(rows);
  const total = data.reduce((s, d) => s + d.reservas, 0);
  if (!total) {
    return `<p style="font-size:12.5px;color:var(--color-text-muted)">No hay reservas con fecha de entrada válida para graficar.</p>`;
  }
  const maxPct = Math.max(1, ...data.map((d) => d.pct));

  const headerCells = data.map((d) => `<th>${d.day}</th>`).join('');
  const cells = data.map((d) => {
    const { bg, fg } = heatColor(d.pct, maxPct);
    return `<td class="heatmap-cell" style="background:${bg};color:${fg}"><div class="heatmap-cell-main">${d.pct.toFixed(1)}%</div><div class="heatmap-cell-sub">${fmtInt(d.reservas)}</div></td>`;
  }).join('');

  return `
    <div class="heatmap-wrap">
      <table class="heatmap-table">
        <thead><tr><th></th>${headerCells}</tr></thead>
        <tbody><tr><td class="heatmap-row-label">Llegadas</td>${cells}</tr></tbody>
      </table>
    </div>
    <p style="margin:12px 0 0;font-size:11px;color:var(--color-text-muted)">% de reservas según el día de la semana de la fecha de entrada (llegada), sobre el total de reservas con fecha válida.</p>
  `;
}

function finishBookAnalysis(result, fileName) {
  const s = state.book;
  Object.assign(s, { status: 'ready', rows: result.rows, dateOrder: result.dateOrder, mixedFormats: result.mixedFormats, fileName, marketFilter: 'all', hotelFilter: 'all' });
  render();
}

function runBookAnalysisFromText(text, fileName) {
  const s = state.book;
  try {
    finishBookAnalysis(engine.loadBookings(text), fileName);
  } catch (err) {
    Object.assign(s, { status: 'error', error: err.message || String(err), fileName });
    render();
  }
}

// Lee la hoja con XLSX.utils.sheet_to_json({raw:true}) en vez de convertirla
// a texto: con raw:true, las celdas de fecha llegan como el número de serie
// real de Excel (días desde 1900), no como el texto formateado en pantalla
// (que puede traer año de 2 dígitos, hora incluida, etc. — formatos que no
// se pueden volver a parsear de forma confiable). Esto elimina de raíz la
// ambigüedad de fecha para archivos Excel reales.
function readExcelRows(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = new Uint8Array(reader.result);
        const wb = window.XLSX.read(data, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        resolve(window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' }));
      } catch (err) { reject(new Error('No se pudo leer el archivo Excel: ' + err.message)); }
    };
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsArrayBuffer(file);
  });
}

function runBookAnalysisFromRows(rows2D, fileName) {
  const s = state.book;
  try {
    finishBookAnalysis(engine.loadBookingsFromRows(rows2D), fileName);
  } catch (err) {
    Object.assign(s, { status: 'error', error: err.message || String(err), fileName });
    render();
  }
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

function bindEvents() {
  // Rendimiento
  const rendBrandInput = document.getElementById('rend-brand-keywords');
  if (rendBrandInput) rendBrandInput.addEventListener('input', (e) => { state.rend.brandKeywords = e.target.value; });

  const rendFileInput = document.getElementById('rend-file');
  if (rendFileInput) rendFileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    state.rend.status = 'loading'; state.rend.error = null; state.rend.fileName = file.name;
    render();
    readFileAsCsvText(file).then((text) => runRendAnalysis(text, file.name))
      .catch((err) => { state.rend.status = 'error'; state.rend.error = err.message || String(err); render(); });
  });

  document.querySelectorAll('[data-rend-tab]').forEach((btn) => {
    btn.addEventListener('click', () => { state.rend.chartTab = btn.dataset.rendTab; render(); });
  });

  // Negativización
  const negCoreInput = document.getElementById('neg-core');
  if (negCoreInput) negCoreInput.addEventListener('input', (e) => { state.neg.core = e.target.value; });
  const negExcInput = document.getElementById('neg-exceptions');
  if (negExcInput) negExcInput.addEventListener('input', (e) => { state.neg.exceptions = e.target.value; });

  const negFileInput = document.getElementById('neg-file');
  if (negFileInput) negFileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    state.neg.status = 'loading'; state.neg.error = null; state.neg.fileName = file.name;
    render();
    const reader = new FileReader();
    reader.onload = () => {
      try { runNegAnalysis(decodeFileText(reader.result), file.name); }
      catch (err) { state.neg.status = 'error'; state.neg.error = 'No se pudo leer el archivo.'; render(); }
    };
    reader.onerror = () => { state.neg.status = 'error'; state.neg.error = 'No se pudo leer el archivo.'; render(); };
    reader.readAsArrayBuffer(file);
  });

  // Generador de copys
  const copyUrlInput = document.getElementById('copy-url');
  if (copyUrlInput) copyUrlInput.addEventListener('input', (e) => { state.copy.url = e.target.value; });
  const copyHtmlPasteInput = document.getElementById('copy-html-paste');
  if (copyHtmlPasteInput) copyHtmlPasteInput.addEventListener('input', (e) => { state.copy.htmlPaste = e.target.value; });

  // Bookings
  const bookFileInput = document.getElementById('book-file');
  if (bookFileInput) bookFileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    state.book.status = 'loading'; state.book.error = null; state.book.fileName = file.name;
    render();
    const isExcel = /\.(xlsx|xls)$/i.test(file.name);
    const onError = (err) => { state.book.status = 'error'; state.book.error = err.message || String(err); render(); };
    if (isExcel) {
      readExcelRows(file).then((rows2D) => runBookAnalysisFromRows(rows2D, file.name)).catch(onError);
    } else {
      readFileAsCsvText(file).then((text) => runBookAnalysisFromText(text, file.name)).catch(onError);
    }
  });
  const bookMarketFilter = document.getElementById('book-market-filter');
  if (bookMarketFilter) bookMarketFilter.addEventListener('change', (e) => {
    state.book.marketFilter = e.target.value;
    render();
  });
  const bookHotelFilter = document.getElementById('book-hotel-filter');
  if (bookHotelFilter) bookHotelFilter.addEventListener('change', (e) => {
    state.book.hotelFilter = e.target.value;
    render();
  });
  // Acciones (data-action)
  root.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => handleAction(el.dataset.action));
  });
}

function handleAction(action) {
  switch (action) {
    case 'layout-a': state.layoutVariant = 'A'; render(); break;
    case 'layout-b': state.layoutVariant = 'B'; render(); break;

    case 'rend-demo': {
      state.rend.status = 'loading'; state.rend.error = null; state.rend.fileName = 'sample_data.csv';
      render();
      setTimeout(() => runRendAnalysis(engine.SAMPLE_CAMPAIGN_CSV, 'sample_data.csv'), 250);
      break;
    }

    case 'neg-demo': {
      state.neg.status = 'loading'; state.neg.error = null; state.neg.fileName = 'negativos_ejemplo.csv';
      render();
      setTimeout(() => runNegAnalysis(engine.SAMPLE_SEARCH_TERMS_CSV, 'negativos_ejemplo.csv'), 250);
      break;
    }
    case 'download-neg-candidatos': {
      const rows = state.neg.rows.filter((r) => r.clasificacion === 'negativizar').sort((a, b) => b.cost - a.cost);
      const data = [['Término', 'Clics', 'Impresiones', 'Costo'], ...rows.map((r) => [r.term, r.clicks, r.impr, r.cost.toFixed(2)])];
      engine.downloadCsv('negativos_candidatos.csv', data);
      break;
    }
    case 'download-neg-revisar': {
      const rows = state.neg.rows.filter((r) => r.clasificacion === 'revisar').sort((a, b) => b.cost - a.cost);
      const data = [['Término', 'Clics', 'Impresiones', 'Costo'], ...rows.map((r) => [r.term, r.clicks, r.impr, r.cost.toFixed(2)])];
      engine.downloadCsv('negativos_revisar.csv', data);
      break;
    }

    case 'copy-analyze-url': onCopyAnalyzeUrl(); break;
    case 'copy-toggle-fallback': state.copy.showFallback = !state.copy.showFallback; render(); break;
    case 'copy-analyze-html': {
      const html = state.copy.htmlPaste;
      if (!html || !html.trim()) return;
      state.copy.status = 'loading'; state.copy.error = null;
      render();
      setTimeout(() => finishCopyAnalysis(html, state.copy.url.trim() || 'https://pagina-pegada.com'), 200);
      break;
    }
    case 'copy-demo-completa': {
      const demo = engine.DEMO_PAGES.completa;
      state.copy.url = demo.url; state.copy.status = 'loading'; state.copy.error = null;
      render();
      setTimeout(() => finishCopyAnalysis(demo.html, demo.url), 250);
      break;
    }
    case 'copy-demo-minima': {
      const demo = engine.DEMO_PAGES.minima;
      state.copy.url = demo.url; state.copy.status = 'loading'; state.copy.error = null;
      render();
      setTimeout(() => finishCopyAnalysis(demo.html, demo.url), 250);
      break;
    }
    case 'download-copy-headlines': {
      const data = [['Título', 'Caracteres'], ...state.copy.headlines.map((h) => [h.text, h.chars])];
      engine.downloadCsv('titulos_rsa.csv', data);
      break;
    }
    case 'download-copy-descriptions': {
      const data = [['Descripción', 'Caracteres'], ...state.copy.descriptions.map((d) => [d.text, d.chars])];
      engine.downloadCsv('descripciones_rsa.csv', data);
      break;
    }

    case 'book-demo': {
      state.book.status = 'loading'; state.book.error = null; state.book.fileName = 'reservas_ejemplo.csv';
      render();
      setTimeout(() => runBookAnalysisFromText(engine.SAMPLE_BOOKINGS_CSV, 'reservas_ejemplo.csv'), 250);
      break;
    }
  }
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => { state.page = btn.dataset.nav; render(); });
});

// El servidor ya redirige a /login si no hay sesión al pedir esta página,
// pero esto también cubre el caso de que la sesión expire a mitad de uso.
fetch('/api/me').then((r) => r.json()).then((data) => {
  if (!data.authenticated) { window.location.href = '/login'; return; }
  const el = document.getElementById('sidebar-username');
  if (el) el.textContent = data.username;
});

document.getElementById('sidebar-logout')?.addEventListener('click', () => {
  fetch('/api/logout', { method: 'POST' }).finally(() => { window.location.href = '/login'; });
});

// Sidebar colapsable — la preferencia se recuerda entre sesiones.
const SIDEBAR_COLLAPSED_KEY = 'pmh_sidebar_collapsed';
const sidebarEl = document.getElementById('sidebar');
const sidebarToggleBtn = document.getElementById('sidebar-toggle');
if (sidebarEl && localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') {
  sidebarEl.classList.add('collapsed');
}
sidebarToggleBtn?.addEventListener('click', () => {
  const collapsed = sidebarEl.classList.toggle('collapsed');
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  sidebarToggleBtn.title = collapsed ? 'Expandir menú' : 'Colapsar menú';
  sidebarToggleBtn.setAttribute('aria-label', sidebarToggleBtn.title);
});

render();
