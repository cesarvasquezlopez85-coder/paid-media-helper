/* engine.js — lógica de negocio para la Plataforma de Google Ads.
   Puerto a JS de analysis.py / negative_keywords.py / copy_generator.py.
   Sin dependencias de UI — solo transforma datos. */

// ---------------------------------------------------------------------------
// Utilidades generales
// ---------------------------------------------------------------------------

export function detectDelimiter(sampleLine) {
  const counts = {
    ",": (sampleLine.match(/,/g) || []).length,
    "\t": (sampleLine.match(/\t/g) || []).length,
    ";": (sampleLine.match(/;/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export function parseDelimited(text, delimiter) {
  // Parser simple con soporte de comillas dobles.
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const rows = [];
  for (const line of lines) {
    if (line === "") continue;
    const cells = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else cur += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === delimiter) { cells.push(cur); cur = ""; }
        else cur += ch;
      }
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

export function textToTable(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== "") || "";
  const delimiter = detectDelimiter(firstLine);
  const rows = parseDelimited(text, delimiter);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ""; });
    return obj;
  });
  return { headers, records };
}

export function toNumber(raw) {
  if (raw === null || raw === undefined) return NaN;
  if (typeof raw === "number") return raw;
  const cleaned = String(raw).replace(/%/g, "").replace(/\$/g, "").replace(/,/g, "").trim();
  if (cleaned === "" || cleaned === "--") return NaN;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? NaN : n;
}

function findColumn(headers, candidates) {
  for (const c of candidates) if (headers.includes(c)) return c;
  return null;
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Función 1 — Análisis de rendimiento
// ---------------------------------------------------------------------------

const COLUMN_ALIASES = {
  campaign: ["Campaign", "Campaña"],
  status: ["Campaign status", "Estado de la campaña"],
  budget: ["Budget", "Presupuesto"],
  impressions: ["Impr.", "Impressions", "Impr"],
  clicks: ["Clicks", "Clics"],
  ctr: ["CTR"],
  avg_cpc: ["Avg. CPC", "CPC prom.", "CPC promedio"],
  cost: ["Cost", "Costo"],
  conversions: ["Conversions", "Conversiones"],
  cost_per_conv: ["Cost / conv.", "Costo/conv.", "Costo / conv."],
  conv_rate: ["Conv. rate", "Tasa de conv."],
  lost_is_budget: ["Search Lost IS (budget)", "IS perdido por presupuesto (búsqueda)", "Search lost IS (budget)"],
  lost_is_rank: ["Search Lost IS (rank)", "IS perdido por ranking (búsqueda)", "Search lost IS (rank)"],
  campaign_type: ["Campaign type", "Tipo de campaña"],
};

export const CTR_THRESHOLDS_BY_TYPE = {
  search_brand: 0.20,
  search_generic: 0.08,
  display: 0.01,
  performance_max: 0.03,
};
export const DEFAULT_CAMPAIGN_TYPE = "search_generic";

export const CAMPAIGN_TYPE_LABELS = {
  search_brand: "Search (marca)",
  search_generic: "Search (genérica)",
  display: "Display",
  performance_max: "Performance Max",
};

const CAMPAIGN_TYPE_ALIASES = {
  search: "search", "búsqueda": "search", busqueda: "search",
  display: "display", "red de display": "display",
  "performance max": "performance_max", "performance max campaigns": "performance_max",
  "máximo rendimiento": "performance_max", "maximo rendimiento": "performance_max",
};
const DEFAULT_BASE_TYPE = "search";

export const DEFAULT_BRAND_KEYWORDS = ["marca", "brand", "branded", "brnd"];

const THRESHOLDS = {
  cpa_high_vs_avg_pct: 0.20,
  lost_is_budget_high: 0.10,
  lost_is_rank_high: 0.10,
  min_cost_to_flag: 0.0,
};

function normalizeBaseType(raw) {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_BASE_TYPE;
  const key = String(raw).trim().toLowerCase();
  return CAMPAIGN_TYPE_ALIASES[key] || DEFAULT_BASE_TYPE;
}

function refineSearchType(name, brandKeywords) {
  const lower = String(name).toLowerCase();
  if (brandKeywords.some((kw) => kw && lower.includes(kw.toLowerCase()))) return "search_brand";
  return "search_generic";
}

export function loadCampaignReport(text, brandKeywords) {
  const bk = brandKeywords && brandKeywords.length ? brandKeywords : DEFAULT_BRAND_KEYWORDS;
  // El export nativo de campañas de Google Ads trae 2-3 líneas de título
  // (nombre del informe, cuenta, rango de fechas) antes del encabezado real
  // — igual que el export de "Términos de búsqueda". Se busca esa fila entre
  // las primeras antes de asumir que la línea 1 ya es el encabezado.
  let parsed = locateHeaderAndParse(text, COLUMN_ALIASES.campaign);
  if (!parsed) parsed = textToTable(text);
  const { headers, records } = parsed;
  const campaignCol = findColumn(headers, COLUMN_ALIASES.campaign);
  if (!campaignCol) {
    throw new Error('No se encontró una columna de campaña reconocible. Revisa que el archivo sea un export de campañas de Google Ads.');
  }
  // El export nativo de Google Ads agrega, al final del archivo, una fila de
  // total general ("Total: Campañas") y además un subtotal por cada tipo de
  // campaña presente ("Total: Cuenta", "Total: Búsqueda", "Total: Máximo
  // rendimiento", etc.). La etiqueta "Total: ..." no siempre cae en la
  // columna "Campaña" — la fila "Total: Campañas" real la trae en la columna
  // "Estado de la campaña", y deja "--" en "Campaña" (no vacío, no contiene
  // "total"), así que ese filtro por sí solo dejaba pasar esa fila como si
  // fuera una campaña real y duplicaba cada métrica del resumen. Ahora se
  // descarta la fila si CUALQUIER columna empieza con "Total:".
  const isTotalRow = (r) => Object.values(r).some((v) => /^\s*total\s*:/i.test(String(v ?? "")));
  const filtered = records.filter((r) => {
    const v = r[campaignCol];
    return v !== undefined && v !== "" && v !== "--" && !isTotalRow(r);
  });

  const numericFields = ["budget", "impressions", "clicks", "ctr", "avg_cpc", "cost", "conversions", "cost_per_conv", "conv_rate", "lost_is_budget", "lost_is_rank"];
  const typeCol = findColumn(headers, COLUMN_ALIASES.campaign_type);
  const statusCol = findColumn(headers, COLUMN_ALIASES.status);

  const rows = filtered.map((r) => {
    const row = { campaign: String(r[campaignCol]) };
    for (const field of numericFields) {
      const col = findColumn(headers, COLUMN_ALIASES[field]);
      let v = col ? toNumber(r[col]) : NaN;
      if (["ctr", "conv_rate", "lost_is_budget", "lost_is_rank"].includes(field) && !Number.isNaN(v)) v = v / 100;
      row[field] = v;
    }
    row.status = statusCol ? String(r[statusCol]) : "N/D";
    const base = typeCol ? normalizeBaseType(r[typeCol]) : DEFAULT_BASE_TYPE;
    row.campaign_type = base === "search" ? refineSearchType(row.campaign, bk) : base;
    row.has_type_column = !!typeCol;
    return row;
  });

  return rows;
}

export function computeMetrics(rows) {
  const totalCost = rows.reduce((s, r) => s + (Number.isNaN(r.cost) ? 0 : r.cost), 0);
  return rows.map((r) => {
    const row = { ...r };
    row.cpa = !Number.isNaN(row.cost_per_conv) ? row.cost_per_conv
      : (row.conversions > 0 ? row.cost / row.conversions : NaN);
    if (Number.isNaN(row.ctr) && row.impressions > 0) row.ctr = row.clicks / row.impressions;
    row.share_of_spend = totalCost > 0 ? (Number.isNaN(row.cost) ? 0 : row.cost) / totalCost : 0;
    return row;
  });
}

export function summarize(rows) {
  const totalCost = rows.reduce((s, r) => s + (Number.isNaN(r.cost) ? 0 : r.cost), 0);
  const totalConversions = rows.reduce((s, r) => s + (Number.isNaN(r.conversions) ? 0 : r.conversions), 0);
  const avgCpaWeighted = totalConversions > 0 ? totalCost / totalConversions : null;
  const validCpa = rows.map((r) => r.cpa).filter((v) => !Number.isNaN(v));
  const avgCpaSimple = validCpa.length ? validCpa.reduce((a, b) => a + b, 0) / validCpa.length : null;
  return {
    total_cost: totalCost,
    total_conversions: totalConversions,
    avg_cpa_weighted: avgCpaWeighted,
    avg_cpa_simple: avgCpaSimple,
    campanas_analizadas: rows.length,
    campanas_con_gasto: rows.filter((r) => r.cost > 0).length,
  };
}

export function generateRecommendations(rows) {
  const recs = [];
  const validCpa = rows.map((r) => r.cpa).filter((v) => !Number.isNaN(v));
  const avgCpa = validCpa.length ? validCpa.reduce((a, b) => a + b, 0) / validCpa.length : null;

  for (const row of rows) {
    const cost = Number.isNaN(row.cost) ? 0 : row.cost;
    if (cost < THRESHOLDS.min_cost_to_flag) continue;

    if (avgCpa && !Number.isNaN(row.cpa) && row.cpa > avgCpa * (1 + THRESHOLDS.cpa_high_vs_avg_pct)) {
      const pct = (row.cpa / avgCpa - 1) * 100;
      recs.push({
        campaign: row.campaign, categoria: "CPA",
        hallazgo: `CPA de $${row.cpa.toFixed(2)} está ${pct.toFixed(0)}% por arriba del promedio de cuenta ($${avgCpa.toFixed(2)}).`,
        recomendacion: "Revisar las palabras clave/segmentos de mayor gasto de esta campaña; pausar o bajar puja en las que no conviertan.",
        impacto_gasto: row.share_of_spend,
      });
    }
    if (!Number.isNaN(row.lost_is_budget) && row.lost_is_budget > THRESHOLDS.lost_is_budget_high) {
      recs.push({
        campaign: row.campaign, categoria: "Presupuesto",
        hallazgo: `Está perdiendo ${(row.lost_is_budget * 100).toFixed(0)}% de impression share por presupuesto limitado.`,
        recomendacion: "Si el CPA es sano, subir presupuesto — se está dejando de mostrar por falta de fondos, no por relevancia.",
        impacto_gasto: row.share_of_spend,
      });
    }
    const campaignType = row.campaign_type || DEFAULT_CAMPAIGN_TYPE;
    const ctrThreshold = CTR_THRESHOLDS_BY_TYPE[campaignType] ?? CTR_THRESHOLDS_BY_TYPE[DEFAULT_CAMPAIGN_TYPE];
    const typeLabel = CAMPAIGN_TYPE_LABELS[campaignType] || campaignType;
    if (!Number.isNaN(row.ctr) && row.ctr < ctrThreshold) {
      recs.push({
        campaign: row.campaign, categoria: "Relevancia (CTR)",
        hallazgo: `CTR de ${(row.ctr * 100).toFixed(2)}%, por debajo del mínimo saludable para ${typeLabel} (${(ctrThreshold * 100).toFixed(0)}%).`,
        recomendacion: "Revisar relevancia de anuncios y palabras clave; probar nuevo copy o ajustar tipos de concordancia.",
        impacto_gasto: row.share_of_spend,
      });
    }
    if (!Number.isNaN(row.lost_is_rank) && row.lost_is_rank > THRESHOLDS.lost_is_rank_high) {
      recs.push({
        campaign: row.campaign, categoria: "Ranking / Quality Score",
        hallazgo: `Está perdiendo ${(row.lost_is_rank * 100).toFixed(0)}% de impression share por ranking (calidad o puja).`,
        recomendacion: "Revisar Quality Score a nivel keyword y considerar subir puja solo si la relevancia del anuncio ya es buena.",
        impacto_gasto: row.share_of_spend,
      });
    }
  }
  recs.sort((a, b) => b.impacto_gasto - a.impacto_gasto);
  return recs;
}

// ---------------------------------------------------------------------------
// Función 2 — Negativización de términos de búsqueda
// ---------------------------------------------------------------------------

const TERM_COLUMN_ALIASES = {
  term: ["Término de búsqueda", "Search term"],
  clicks: ["Clics", "Clicks"],
  impr: ["Impr.", "Impressions"],
  cost: ["Costo", "Cost"],
  conversions: ["Conversiones", "Conversions"],
};

function locateHeaderAndParse(text, aliasCandidates) {
  const cleanText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = cleanText.split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return null;
  const delimiters = ["\t", ",", ";"];
  for (const delim of delimiters) {
    const rows = parseDelimited(lines.join("\n"), delim);
    for (let i = 0; i < Math.min(rows.length, 6); i++) {
      const cells = rows[i].map((c) => c.trim());
      if (aliasCandidates.some((a) => cells.includes(a))) {
        const headers = cells;
        const records = rows.slice(i + 1).map((r) => {
          const obj = {};
          headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ""; });
          return obj;
        });
        return { headers, records };
      }
    }
  }
  return null;
}

export function loadSearchTerms(text) {
  // El export nativo de "Términos de búsqueda" de Google Ads trae 2 líneas
  // de título antes del encabezado real, y puede venir en UTF-16/tabs o
  // como CSV estándar — se busca la fila de encabezado entre las primeras.
  let parsed = locateHeaderAndParse(text, TERM_COLUMN_ALIASES.term);
  if (!parsed) parsed = textToTable(text);
  const { headers, records } = parsed;
  const termCol = findColumn(headers, TERM_COLUMN_ALIASES.term);
  if (!termCol) throw new Error("No se encontró una columna de término de búsqueda reconocible.");
  const filtered = records.filter((r) => r[termCol] && !String(r[termCol]).startsWith("Total:"));
  return filtered.map((r) => {
    const row = { term: String(r[termCol]) };
    for (const field of ["clicks", "impr", "cost", "conversions"]) {
      const col = findColumn(headers, TERM_COLUMN_ALIASES[field]);
      const v = col ? toNumber(r[col]) : 0;
      row[field] = Number.isNaN(v) ? 0 : v;
    }
    return row;
  });
}

function normalizeAccents(text) {
  const accents = { "á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u", "ñ": "n", "ü": "u" };
  let out = String(text).toLowerCase();
  for (const [a, b] of Object.entries(accents)) out = out.split(a).join(b);
  return out;
}

export function classifyTerms(rows, coreTerms, exceptions) {
  const coreN = (coreTerms || []).map(normalizeAccents).filter(Boolean);
  const excN = (exceptions || []).map(normalizeAccents).filter(Boolean);
  return rows.map((r) => {
    const norm = normalizeAccents(r.term);
    const matchesCore = coreN.some((c) => norm.includes(c));
    const matchesExc = excN.some((e) => norm.includes(e));
    let clasificacion = "negativizar";
    if (matchesExc && matchesCore) clasificacion = "revisar";
    else if (matchesCore) clasificacion = "mantener";
    return { ...r, clasificacion };
  });
}

export function summarizeClassification(rows) {
  const cats = ["mantener", "revisar", "negativizar"];
  const out = {};
  for (const c of cats) {
    const sub = rows.filter((r) => r.clasificacion === c);
    out[c] = {
      terminos: sub.length,
      costo: sub.reduce((s, r) => s + r.cost, 0),
      clics: sub.reduce((s, r) => s + r.clicks, 0),
      conversiones: sub.reduce((s, r) => s + (r.conversions || 0), 0),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Función 3 — Generador de copys desde URL / HTML
// ---------------------------------------------------------------------------

export const HEADLINE_LIMIT = 30;
export const DESCRIPTION_LIMIT = 90;

const OFFER_PATTERNS = [
  /\d{1,3}\s?%\s?(de\s)?(descuento|off)/i,
  /(hasta|desde)\s+\d{1,3}\s?%/i,
  /env[íi]o\s+gratis/i,
  /entrega\s+gratis/i,
  /todo\s+inclu[íi]do/i,
  /sin\s+costo/i,
  /cuotas?\s+sin\s+inter[ée]s/i,
  /garant[íi]a\s+(de\s+)?\d+\s+(d[íi]as|meses|a[ñn]os)/i,
  /\d+x\d+/i,
  /[$€]\s?\d[\d.,]*/,
  /(oferta|promoci[óo]n)\s+(especial|exclusiva|limitada)?/i,
  /reserva\s+(ya|ahora|hoy)/i,
  /[úu]ltimas?\s+unidades/i,
  /solo\s+por\s+hoy/i,
];
const GENERIC_OFFERS = ["Precios Especiales", "Oferta Disponible", "Promoción Vigente"];

// El sitio es de hospedaje/viajes vs. retail genérico cambia el verbo y el
// tono correctos ("Reserva tu suite" suena natural, "Compra tu suite" no) —
// se detecta por palabras del rubro en dominio/título/H1/keyword.
const TRAVEL_HINTS = [
  "hotel", "resort", "suite", "hostal", "hostel", "apart", "playa", "spa",
  "reserva", "vuelo", "tour", "viaje", "turismo", "booking", "alojamiento",
  "cabana", "posada", "lodge", "villa", "glamping", "todo incluido",
];

function detectVocab(signals) {
  const haystack = normalizeAccents(`${signals.domain} ${signals.title} ${signals.h1} ${signals.keyword}`);
  const isTravel = TRAVEL_HINTS.some((h) => haystack.includes(h));
  return isTravel
    ? { verb: "Reserva", verbLower: "reserva", accion: "Reserva ya", accion2: "Vive la experiencia", cliente: "huéspedes" }
    : { verb: "Compra", verbLower: "compra", accion: "Compra ya", accion2: "Pide el tuyo hoy", cliente: "clientes" };
}

const HEADLINE_TEMPLATES = [
  "{keyword}", "{keyword} Oficial", "{verb} {keyword}", "{keyword} Hoy",
  "{keyword}: Oferta", "Descuento en {keyword}", "Vive {keyword}",
  "Mejor Precio: {keyword}", "{keyword} Garantizado", "{verb} {keyword} Ya",
  "{keyword} Disponible Ya", "{brand}: {keyword}", "{keyword} - {brand}",
  "{verb} Online: {keyword}", "{keyword} Sin Costo Extra", "{brand} Oficial",
  "{keyword} | Precio Especial", "No Te Pierdas {keyword}", "{keyword}: Cupos Limitados",
  "Última Oportunidad: {keyword}", "{keyword}, Elegido por Miles", "Así Es {keyword}",
  "{keyword} Te Espera", "Todos Hablan de {keyword}", "{keyword}: Precio de Hoy",
];
const DESCRIPTION_TEMPLATES = [
  "Descubre {keyword}. {offer}. {accion2} que estabas buscando.",
  "{keyword} al mejor precio. {offer}. {accion} y compruébalo tú mismo.",
  "{offer} en {keyword}. Miles de {cliente} ya lo disfrutan. {accion}.",
  "Encuentra {keyword} con garantía. {offer}. Todo listo en minutos.",
  "{brand} te espera con {keyword}. {offer}. Calidad que se nota.",
  "{keyword} disponible ahora. {offer}. Sin complicaciones, sin letras chicas.",
  "Conoce {keyword} de {brand}. {offer}. Atención real, todos los días.",
  "{offer} exclusiva en {keyword}. La oportunidad que esperabas, hoy.",
  "{keyword}: la opción preferida por miles de {cliente}. {offer}.",
  "Todo lo que buscas en {keyword} está aquí. {offer}. {accion}.",
  "{keyword} sin vueltas: {offer}. Así de fácil, así de rápido.",
  "{offer}. {keyword} pensado para que no tengas que preocuparte por nada.",
];

function clean(text) { return String(text || "").replace(/\s+/g, " ").trim(); }

function fit(text, limit) {
  text = clean(text);
  if (text.length <= limit) return text;
  let truncated = text.slice(0, limit);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > -1) truncated = truncated.slice(0, lastSpace);
  return truncated.trim();
}

// Muletillas de <title> que no aportan nada a marca/keyword y solo las
// alargan ("... Sitio Oficial", "... | Home").
const TITLE_FILLER = /\b(sitio oficial|p[aá]gina oficial|official site|home ?page)\b\.?\s*$/i;

function guessBrandAndKeyword(title, h1, domain) {
  const domainRoot = domain.replace(/^www\./, "").split(".")[0].toLowerCase();
  const cleanTitle = title ? clean(title.replace(TITLE_FILLER, "")) : "";
  const parts = cleanTitle ? cleanTitle.split(/\s*[|\-–:•]\s*/).map((p) => p.trim()).filter(Boolean) : [];
  let brand = null;
  if (parts.length > 1) {
    for (const part of parts) {
      const words = (part.toLowerCase().match(/[a-záéíóúñ]+/g) || []);
      if (words.some((w) => w.length >= 4 && domainRoot.includes(w))) { brand = part; break; }
    }
    if (!brand) brand = parts.reduce((a, b) => (b.length < a.length ? b : a));
  } else if (parts.length === 1) {
    // El <title> no trae separadores reales (frecuente en SEO de hoteles:
    // una sola frase larga) — en vez de usar el título completo como marca,
    // se busca el nombre del dominio dentro del texto y se toma una ventana
    // corta de palabras alrededor, para no arrastrar relleno tipo "en
    // Cartagena" o "Sitio Oficial" dentro del nombre de marca.
    const words = parts[0].split(/\s+/);
    const idx = words.findIndex((w) => {
      const bare = w.toLowerCase().replace(/[^a-záéíóúñ]/g, "");
      return bare.length >= 4 && domainRoot.includes(bare);
    });
    if (idx > -1) brand = words.slice(idx, idx + 3).join(" ");
  }
  if (!brand) brand = domainRoot.charAt(0).toUpperCase() + domainRoot.slice(1);

  let keyword = h1 ? h1.trim() : null;
  if (!keyword && parts.length > 1) {
    const remaining = parts.filter((p) => p !== brand);
    keyword = remaining.length ? remaining.reduce((a, b) => (b.length > a.length ? b : a)) : parts[0];
  }
  if (!keyword && parts.length === 1) keyword = parts[0];
  if (!keyword) keyword = brand;
  return { brand, keyword };
}

// Chrome de sitio que casi nunca es copy de producto — filtra lo que se
// cuele suelto fuera de <nav>/<footer> (p. ej. un selector de idioma que no
// usa markup semántico). Se compara ya sin acentos y en minúsculas.
const MENU_STOPWORDS = new Set([
  "login", "log in", "iniciar sesion", "cerrar sesion", "mi cuenta", "my account",
  "idioma", "idiomas", "language", "languages", "espanol", "ingles", "english", "spanish",
  "es", "en", "fr", "pt", "de", "it",
  "menu", "buscar", "search", "carrito", "cart",
  "inicio", "home", "mapa", "mapa del sitio", "sitemap", "site map",
  // Microcopy genérico de UI/formularios/filtros — no es copy de producto,
  // aunque no viva dentro de <nav>/<header>/<footer> (p. ej. un botón "Ver
  // más" suelto en medio de una tarjeta de contenido).
  "ver mas", "leer mas", "conocer mas", "saber mas", "mas informacion",
  "acceder", "ver todo", "ver todos", "ver todas", "ver todas las ofertas",
  "solicitar presupuesto", "solicitar informacion", "contactar", "contactanos",
  "escribenos", "enviar", "suscribirse", "registrarse", "comparar", "compartir",
  "imprimir", "volver", "regresar", "siguiente", "anterior", "empezar", "comenzar",
  "filtrar", "ordenar", "aplicar filtros", "limpiar filtros", "aceptar", "rechazar",
  "cerrar", "cancelar", "guardar", "ayuda", "preguntas frecuentes", "faq",
  "terminos y condiciones", "politica de privacidad", "aviso legal", "cookies",
].map(normalizeAccents));

export function extractSignals(html, url) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let domain = "sitio.com";
  try { domain = new URL(url).hostname; } catch (e) { /* keep default */ }

  const title = clean(doc.title || "");
  const metaTag = doc.querySelector('meta[name="description"]');
  const metaDescription = metaTag ? clean(metaTag.getAttribute("content")) : "";
  const h1el = doc.querySelector("h1");
  const h1 = h1el ? clean(h1el.textContent) : "";
  const h2s = Array.from(doc.querySelectorAll("h2")).map((h) => clean(h.textContent)).filter(Boolean);

  // Quita ruido que nunca es copy real antes de extraer listas/links/texto:
  // scripts y hojas de estilo (incluidas las que vienen embebidas en SVGs de
  // íconos dentro de <li>), y los bloques de navegación/encabezado/pie de
  // página, que casi siempre son menú (Login, Idiomas, Mapa, Habitaciones...)
  // y no producto. Muchos sitios no usan <nav> semántico — el navbar vive en
  // un <div class="navbar__..."> o similar — por eso también se cubren
  // patrones de clase típicos de menús (navbar, navigator, nav__, main-nav).
  doc.querySelectorAll(
    'script, style, noscript, nav, header, footer, [role="navigation"], ' +
    '[class*="navbar"], [class*="navigator"], [class*="nav__"], [class*="main-nav"], [class*="site-nav"]'
  ).forEach((el) => el.remove());

  const isMenuish = (t) => MENU_STOPWORDS.has(normalizeAccents(t));
  const liTexts = Array.from(doc.querySelectorAll("li")).map((li) => clean(li.textContent)).filter((t) => t.length >= 3 && t.length <= 100 && !isMenuish(t));
  const ctaTexts = Array.from(doc.querySelectorAll("a, button")).map((t) => clean(t.textContent)).filter((t) => t.length >= 3 && t.length <= 40 && !isMenuish(t));

  const fullText = clean(doc.body ? doc.body.textContent : "");
  const offers = [];
  for (const pattern of OFFER_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let m;
    while ((m = re.exec(fullText)) !== null) {
      const phrase = clean(m[0]);
      if (phrase && !offers.includes(phrase)) offers.push(phrase);
      if (!re.global) break;
    }
  }
  const finalOffers = offers.slice(0, 10).length ? offers.slice(0, 10) : GENERIC_OFFERS;

  const { brand, keyword } = guessBrandAndKeyword(title, h1, domain);

  return { title, meta_description: metaDescription, h1, h2s, li_texts: liTexts, cta_texts: ctaTexts, offers: finalOffers, brand, keyword, domain };
}

// Evita duplicar texto cuando la oferta detectada ya forma parte de la
// keyword (p. ej. keyword "Todo Incluido en Playa Manzanillo" + oferta
// "Todo Incluido" produciría "Todo Incluido en Todo Incluido en...").
function pickOffer(offers, keyword, i) {
  const kwNorm = normalizeAccents(keyword || "");
  const nonOverlapping = offers.filter((o) => !kwNorm.includes(normalizeAccents(o)));
  const pool = nonOverlapping.length ? nonOverlapping : offers;
  return pool[i % pool.length];
}

function stripBrandAndDangling(text, brand) {
  if (!brand || !text) return "";
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let stripped = text.replace(new RegExp(escaped, "gi"), "");
  stripped = clean(stripped.replace(/^[\s\-–:|]+|[\s\-–:|]+$/g, ""));
  const words = stripped.split(" ").filter(Boolean);
  while (words.length > 1 && DANGLING_WORDS.has(normalizeAccents(words[0]))) words.shift();
  while (words.length > 1 && DANGLING_WORDS.has(normalizeAccents(words[words.length - 1]).replace(/[:,.]$/, ""))) words.pop();
  return words.join(" ");
}

// Corta la marca del H1/keyword para no repetirla en plantillas tipo
// "{brand}: {keyword}". Si al quitar la marca (y las preposiciones colgantes
// que quedan, ver stripBrandAndDangling) sobra muy poco — como el H1 real de
// estelarplayamanzanillo.com, "ESTELAR Playa Manzanillo en Colombia", que
// tras quitar la marca solo deja "Colombia" — se intenta lo mismo con el
// <title> de la página, que suele traer más contenido de valor (ofertas,
// ciudad) antes del sufijo de marca.
function keywordWithoutBrand(signals) {
  const { keyword, brand, title } = signals;
  if (!brand || !keyword) return keyword;
  const fromH1 = stripBrandAndDangling(keyword, brand);
  if (fromH1.length >= 12) return fromH1;
  const fromTitle = stripBrandAndDangling(clean((title || "").replace(TITLE_FILLER, "")), brand);
  if (fromTitle.length >= 12) return fromTitle;
  return fromH1.length >= 6 ? fromH1 : keyword;
}

// Preposiciones/artículos que no deben quedar como última palabra de un
// titular — dejan la frase colgando ("Suites frente al" en vez de
// "Suites frente al mar").
const DANGLING_WORDS = new Set(
  ["a", "al", "de", "del", "en", "con", "para", "el", "la", "los", "las", "un", "una", "y", "o", "que", "su", "sus"].map(normalizeAccents)
);
function trimDangling(text) {
  text = text.replace(/[\s\-–:|]+$/, "");
  const words = text.split(" ");
  while (words.length > 1 && DANGLING_WORDS.has(normalizeAccents(words[words.length - 1]).replace(/[:,.]$/, ""))) {
    words.pop();
  }
  return words.join(" ").replace(/[\s\-–:|]+$/, "");
}
function fitHeadline(text) { return trimDangling(fit(text, HEADLINE_LIMIT)); }
// Mismo recorte para descripciones: un párrafo real de la página que exceda
// el límite no debe quedar cortado en una preposición/artículo suelto.
function fitDescription(text) { return trimDangling(fit(text, DESCRIPTION_LIMIT)); }

// Recorta a las primeras palabras que quepan en maxChars, en límite de
// palabra completa — evita que un keyword largo (p. ej. un H1 completo)
// combinado con texto de plantilla quede cortado a medio pensamiento
// ("...frente al mar en" en vez de "...en Cartagena").
function shortKeyword(keyword, maxChars = 22) {
  if (!keyword || keyword.length <= maxChars) return keyword;
  const words = keyword.split(/\s+/);
  let out = "";
  for (const w of words) {
    const candidate = out ? `${out} ${w}` : w;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  return trimDangling(out || words[0]);
}

export function generateHeadlines(signals, n = 15) {
  const candidates = [];
  const vocab = detectVocab(signals);
  const keywordShort = keywordWithoutBrand(signals);
  const keywordTight = shortKeyword(keywordShort);
  for (const raw of [signals.title, signals.h1, ...signals.h2s, ...signals.cta_texts]) {
    if (raw) candidates.push(fitHeadline(raw));
  }
  // Páginas sin H1/título distinto del nombre de marca dejan keyword===brand
  // — plantillas que combinan ambos ("{brand}: {keyword}") quedarían
  // repetidas ("Hotel X: Hotel X"), así que se omiten en ese caso.
  const keywordEqualsBrand = normalizeAccents(keywordTight) === normalizeAccents(signals.brand);
  for (const template of HEADLINE_TEMPLATES) {
    const isBare = template === "{keyword}";
    if (!isBare && keywordEqualsBrand && template.includes("{brand}") && template.includes("{keyword}")) continue;
    const kw = isBare ? signals.keyword : keywordTight;
    const text = template.replace(/\{keyword\}/g, kw).replace(/\{brand\}/g, signals.brand).replace(/\{verb\}/g, vocab.verb);
    candidates.push(fitHeadline(text));
  }
  const seen = new Set(); const result = [];
  for (const c of candidates) {
    const key = c.toLowerCase();
    if (c && !seen.has(key)) { seen.add(key); result.push(c); }
    if (result.length === n) break;
  }
  const fallbacks = [
    "Oferta Especial Hoy", `${vocab.verb} Seguro Online`, "Cupos Limitados",
    "Atención Personalizada", "Precios Increíbles", "Calidad Garantizada",
    "Disponibilidad Limitada", "Miles Ya Confían en Nosotros",
  ];
  let i = 0;
  while (result.length < n && i < 50) {
    const extra = fitHeadline(fallbacks[i % fallbacks.length]);
    if (!seen.has(extra.toLowerCase())) { seen.add(extra.toLowerCase()); result.push(extra); }
    i++;
  }
  return result.slice(0, n);
}

export function generateDescriptions(signals, n = 10) {
  const candidates = [];
  const vocab = detectVocab(signals);
  if (signals.meta_description) candidates.push(fitDescription(signals.meta_description));
  for (const li of signals.li_texts) candidates.push(fitDescription(li));
  const keywordShort = keywordWithoutBrand(signals);
  const keywordEqualsBrand = normalizeAccents(keywordShort) === normalizeAccents(signals.brand);
  DESCRIPTION_TEMPLATES.forEach((template, i) => {
    const usesBrand = template.includes("{brand}");
    if (keywordEqualsBrand && usesBrand && template.includes("{keyword}")) return;
    const offer = pickOffer(signals.offers, signals.keyword, i);
    const kw = usesBrand ? keywordShort : signals.keyword;
    const text = template
      .replace(/\{keyword\}/g, kw)
      .replace(/\{brand\}/g, signals.brand)
      .replace(/\{offer\}/g, offer)
      .replace(/\{accion2\}/g, vocab.accion2)
      .replace(/\{accion\}/g, vocab.accion)
      .replace(/\{cliente\}/g, vocab.cliente);
    candidates.push(fitDescription(text));
  });
  const seen = new Set(); const result = [];
  for (const c of candidates) {
    const key = c.toLowerCase();
    if (c && c.length >= 10 && !seen.has(key)) { seen.add(key); result.push(c); }
    if (result.length === n) break;
  }
  const fallbackShapes = [
    (kw, offer) => `${kw} con la confianza de ${signals.brand}. ${offer}. ${vocab.accion} y compruébalo.`,
    (kw, offer) => `${vocab.accion2}: ${kw}. ${offer}. Miles de ${vocab.cliente} ya lo hicieron.`,
    (kw, offer) => `${offer} en ${kw}. Rápido, claro y sin sorpresas de última hora.`,
  ];
  let i = 0;
  while (result.length < n && i < 50) {
    const offer = pickOffer(signals.offers, signals.keyword, i);
    const shape = fallbackShapes[i % fallbackShapes.length];
    const text = fitDescription(shape(keywordShort, offer));
    if (!seen.has(text.toLowerCase())) { seen.add(text.toLowerCase()); result.push(text); }
    i++;
  }
  return result.slice(0, n);
}

// Datos de ejemplo listos para un clic — permiten demostrar cada función
// sin depender de que el usuario tenga un archivo real a la mano.
export const SAMPLE_CAMPAIGN_CSV = `Campaign,Campaign status,Budget,Impr.,Clicks,CTR,Avg. CPC,Cost,Conversions,Cost / conv.,Conv. rate,Search Lost IS (budget),Search Lost IS (rank)
Search - Marca Estelar Manzanillo,Enabled,$50.00,12000,480,4.00%,$0.35,$168.00,22,$7.64,4.58%,2.00%,3.00%
Search - Habitaciones Cartagena,Enabled,$80.00,9000,300,3.33%,$1.20,$360.00,6,$60.00,2.00%,5.00%,8.00%
Search - Genérico Hoteles Caribe,Enabled,$60.00,15000,180,1.20%,$0.90,$162.00,9,$18.00,5.00%,4.00%,6.00%
Display - Remarketing,Enabled,$30.00,200000,800,0.40%,$0.15,$120.00,15,$8.00,1.88%,0.00%,0.00%
Search - Ofertas Fin de Semana,Enabled,$40.00,8000,320,4.00%,$0.45,$144.00,18,$8.00,5.63%,22.00%,3.00%
Search - Todo Incluido,Enabled,$70.00,11000,400,3.64%,$0.60,$240.00,14,$17.14,3.50%,2.00%,25.00%
Performance Max - Reservas,Enabled,$100.00,50000,900,1.80%,$0.70,$630.00,35,$18.00,3.89%,5.00%,4.00%
Search - Competidores Brand,Enabled,$35.00,5000,150,3.00%,$1.80,$270.00,3,$90.00,2.00%,1.00%,2.00%
Search - Bodas y Eventos,Enabled,$20.00,2000,60,3.00%,$0.50,$30.00,2,$15.00,3.33%,0.00%,1.00%
Search - Corporativo,Paused,$25.00,1000,25,2.50%,$0.60,$15.00,1,$15.00,4.00%,0.00%,0.00%
Total: all campaigns,--,,313000,3615,,,"$2,139.00",125,,,,`;

export const SAMPLE_SEARCH_TERMS_CSV = `Search term,Clicks,Impr.,Cost,Conversions
estelar playa manzanillo,210,3400,240.10,18
hotel estelar manzanillo cartagena,95,1500,88.40,7
reservar estelar manzanillo,60,900,52.00,5
manzanillo del mar apartamentos,42,880,38.75,0
manzanillo del mar cartagena barrio,25,610,19.90,0
hoteles baratos cartagena,110,4200,96.30,1
todo incluido cancun,88,3100,71.20,0
vuelos economicos bogota,54,2000,44.10,0
que hacer en cartagena gratis,37,1500,28.60,0
hotel estelar,140,2600,132.90,9
booking cartagena ofertas,63,1900,55.40,0
trabajo hotel cartagena,18,700,12.30,0
estelar apartamentos amoblados bogota,22,610,17.80,0`;

// Páginas de ejemplo (idénticas en espíritu a las usadas para probar
// copy_generator.py sin salida a internet) — permiten demostrar la función
// sin depender de que el fetch a una URL real no choque con CORS.
export const DEMO_PAGES = {
  completa: {
    label: "Ejemplo: página completa (hotel todo incluido)",
    url: "https://www.hotelesestelar.com/playa-manzanillo",
    html: `<html><head><title>Hotel Estelar Playa Manzanillo | Todo Incluido Cartagena</title>
    <meta name="description" content="Reserva tu Todo Incluido en Estelar Playa Manzanillo, Cartagena. Hasta 20% de descuento reservando online."></head>
    <body>
    <h1>Todo Incluido en Playa Manzanillo</h1>
    <h2>Habitaciones frente al mar</h2>
    <h2>3 piscinas y acceso directo a la playa</h2>
    <ul>
      <li>Desayuno, almuerzo y cena incluidos</li>
      <li>Bebidas nacionales ilimitadas</li>
      <li>Wifi gratis en todo el hotel</li>
      <li>Niños hasta 12 años se hospedan gratis</li>
    </ul>
    <p>Reserva ya y aprovecha hasta 20% de descuento. Cuotas sin interés disponibles.</p>
    <a href="#">Reservar Ahora</a>
    <button>Ver Disponibilidad</button>
    </body></html>`,
  },
  minima: {
    label: "Ejemplo: página mínima (solo título)",
    url: "https://www.hotelboutiquecentro.com/",
    html: `<html><head><title>Hotel Boutique Centro</title></head><body></body></html>`,
  },
};

// ---------------------------------------------------------------------------
// Función 4 — Bookings (reservas reales)
// ---------------------------------------------------------------------------

const BOOKING_COLUMN_ALIASES = {
  alta: ["Alta", "Fecha de alta", "Fecha de reserva", "Booking Date", "Reservation Date"],
  hotel: ["Hotel", "Propiedad", "Property"],
  canal: ["Canal", "Channel"],
  pais: ["Pais", "País", "Country", "Mercado", "Market"],
  afiliado: ["Afiliado", "Affiliate"],
  fecha_entrada: ["Fecha entrada", "Fecha de entrada", "Check-in", "Check In", "Arrival", "Fecha llegada", "Fecha de llegada"],
  fecha_salida: ["Fecha salida", "Fecha de salida", "Check-out", "Check Out", "Departure"],
};

// Decide si un grupo de fechas D/M/AAAA viene como día-primero o
// mes-primero: basta con que UNA fecha tenga un número >12 en alguna
// posición para saberlo sin ambigüedad. Devuelve null si el grupo es
// completamente ambiguo (todas las fechas con ambas posiciones ≤12).
function detectOrderFromValues(rawValues) {
  let sawDayFirst = false;
  let sawMonthFirst = false;
  for (const raw of rawValues) {
    const s = String(raw ?? "").trim();
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-]\d{4}$/);
    if (!m) continue;
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a > 12) sawDayFirst = true;
    if (b > 12) sawMonthFirst = true;
  }
  if (sawDayFirst && !sawMonthFirst) return "DMY";
  if (sawMonthFirst && !sawDayFirst) return "MDY";
  return null;
}

// Convierte texto de fecha en un objeto Date. order ("DMY" o "MDY") ya viene
// decidido por detectDateOrder a partir de todo el archivo, no por celda.
export function parseFlexibleDate(raw, order) {
  order = order === "MDY" ? "MDY" : "DMY";
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  if (/^\d{4,6}(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    if (serial > 20000 && serial < 80000) {
      const excelEpochMs = Date.UTC(1899, 11, 30);
      const d = new Date(excelEpochMs + serial * 86400000);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10), year = parseInt(m[3], 10);
    const [day, month] = order === "MDY" ? [b, a] : [a, b];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(year, month - 1, day);
      if (!Number.isNaN(d.getTime())) return d;
    }
    // La combinación no calza con el orden detectado para el archivo — se
    // prueba el orden contrario para esta celda puntual antes de rendirse
    // (mejor una fecha razonable que ninguna).
    const [day2, month2] = order === "MDY" ? [a, b] : [b, a];
    if (month2 >= 1 && month2 <= 12 && day2 >= 1 && day2 <= 31) {
      const d = new Date(year, month2 - 1, day2);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    if (!Number.isNaN(d.getTime())) return d;
  }

  const native = new Date(s);
  if (!Number.isNaN(native.getTime())) return native;

  return null;
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

// Igual que locateHeaderAndParse/textToTable, pero para datos que ya vienen
// como array de arrays (una hoja de Excel leída con valores crudos) en vez
// de texto — ver loadBookingsFromRows más abajo.
export function tableFromRows(rows2D, aliasCandidates) {
  for (let i = 0; i < Math.min(rows2D.length, 6); i++) {
    const cells = (rows2D[i] || []).map((c) => String(c ?? "").trim());
    if (aliasCandidates.some((a) => cells.includes(a))) {
      const headers = cells;
      const records = rows2D.slice(i + 1).map((r) => {
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ""; });
        return obj;
      });
      return { headers, records };
    }
  }
  const headers = (rows2D[0] || []).map((c) => String(c ?? "").trim());
  const records = rows2D.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ""; });
    return obj;
  });
  return { headers, records };
}

export function loadBookings(text) {
  let parsed = locateHeaderAndParse(text, BOOKING_COLUMN_ALIASES.alta);
  if (!parsed) parsed = textToTable(text);
  return loadBookingsFromTable(parsed.headers, parsed.records);
}

// rows2D: array de arrays tal como lo entrega XLSX.utils.sheet_to_json(sheet,
// {header:1, raw:true}) — con raw:true los números (incluidas las fechas,
// que Excel guarda como número de días desde 1900) llegan como número real
// de la celda, no como el texto que se vería en pantalla. Esto es clave:
// muchos exports de reservas formatean la fecha como "DD-MM-AA" (año de 2
// dígitos) o con hora incluida, y ese texto no se puede volver a parsear de
// forma confiable — leer el número real de la celda elimina la ambigüedad
// por completo, sin importar el formato de visualización.
export function loadBookingsFromRows(rows2D) {
  const { headers, records } = tableFromRows(rows2D, BOOKING_COLUMN_ALIASES.alta);
  return loadBookingsFromTable(headers, records);
}

export function loadBookingsFromTable(headers, records) {
  const altaCol = findColumn(headers, BOOKING_COLUMN_ALIASES.alta);
  const entradaCol = findColumn(headers, BOOKING_COLUMN_ALIASES.fecha_entrada);
  if (!altaCol || !entradaCol) {
    throw new Error('No se encontraron las columnas de fecha de reserva ("Alta") y/o fecha de entrada. Revisa que el archivo sea un export de reservas.');
  }
  const hotelCol = findColumn(headers, BOOKING_COLUMN_ALIASES.hotel);
  const canalCol = findColumn(headers, BOOKING_COLUMN_ALIASES.canal);
  const paisCol = findColumn(headers, BOOKING_COLUMN_ALIASES.pais);
  const afiliadoCol = findColumn(headers, BOOKING_COLUMN_ALIASES.afiliado);
  const salidaCol = findColumn(headers, BOOKING_COLUMN_ALIASES.fecha_salida);

  // Orden de respaldo, calculado con todas las fechas del archivo — solo se
  // usa para las reservas cuya propia fecha de alta/entrada/salida no trae
  // ninguna pista (las tres con día ≤12). Cuando sí hay pista, se prioriza
  // siempre la evidencia de la propia reserva: así, si el archivo mezcla
  // formatos entre filas (por ejemplo, porque se armó pegando exports de
  // distintos momentos), cada reserva se interpreta con su propia evidencia
  // en vez de forzar una sola regla para todo el archivo.
  const globalOrder = detectOrderFromValues(
    records.flatMap((r) => [r[altaCol], r[entradaCol], salidaCol ? r[salidaCol] : null])
  ) || "DMY";

  let sawUnambiguousDMY = false;
  let sawUnambiguousMDY = false;

  const rows = records
    .filter((r) => r[altaCol] !== undefined && r[altaCol] !== "")
    .map((r) => {
      const rowValues = [r[altaCol], r[entradaCol]];
      if (salidaCol) rowValues.push(r[salidaCol]);
      const rowOrderDetected = detectOrderFromValues(rowValues);
      if (rowOrderDetected === "DMY") sawUnambiguousDMY = true;
      if (rowOrderDetected === "MDY") sawUnambiguousMDY = true;
      const rowOrder = rowOrderDetected || globalOrder;

      const altaDate = parseFlexibleDate(r[altaCol], rowOrder);
      const entradaDate = parseFlexibleDate(r[entradaCol], rowOrder);
      const salidaDate = salidaCol ? parseFlexibleDate(r[salidaCol], rowOrder) : null;
      const leadDays = altaDate && entradaDate ? daysBetween(altaDate, entradaDate) : null;
      const stayNights = entradaDate && salidaDate ? daysBetween(entradaDate, salidaDate) : null;
      return {
        hotel: hotelCol ? String(r[hotelCol]).trim() || "N/D" : "N/D",
        canal: canalCol ? String(r[canalCol]).trim() || "N/D" : "N/D",
        pais: paisCol ? String(r[paisCol]).trim() || "Sin dato" : "Sin dato",
        afiliado: afiliadoCol ? String(r[afiliadoCol]).trim() || "N/D" : "N/D",
        altaDate, entradaDate, salidaDate, leadDays, stayNights,
      };
    });

  if (!rows.length) {
    throw new Error('El archivo no trae filas con fecha de reserva ("Alta"). Revisa que sea un export de reservas.');
  }
  return { rows, dateOrder: globalOrder, mixedFormats: sawUnambiguousDMY && sawUnambiguousMDY };
}

export function summarizeBookingsByMarket(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.pais || "Sin dato";
    if (!groups.has(key)) groups.set(key, { mercado: key, reservas: 0, noches: 0 });
    const g = groups.get(key);
    g.reservas += 1;
    if (r.stayNights !== null && !Number.isNaN(r.stayNights) && r.stayNights >= 0) g.noches += r.stayNights;
  }
  return Array.from(groups.values()).sort((a, b) => b.reservas - a.reservas);
}

export const LEAD_TIME_BUCKETS = [
  { label: "0-7 días", min: 0, max: 7 },
  { label: "8-14 días", min: 8, max: 14 },
  { label: "15-30 días", min: 15, max: 30 },
  { label: "31-60 días", min: 31, max: 60 },
  { label: "61+ días", min: 61, max: Infinity },
];

export function summarizeLeadTime(rows) {
  const buckets = LEAD_TIME_BUCKETS.map((b) => ({ ...b, reservas: 0 }));
  let sinDato = 0;
  const valid = [];
  for (const r of rows) {
    if (r.leadDays === null || Number.isNaN(r.leadDays) || r.leadDays < 0) { sinDato += 1; continue; }
    valid.push(r.leadDays);
    const bucket = buckets.find((b) => r.leadDays >= b.min && r.leadDays <= b.max);
    if (bucket) bucket.reservas += 1;
  }
  const promedio = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  return { buckets, sinDato, promedio, totalConDato: valid.length };
}

export function listBookingMarkets(rows) {
  return Array.from(new Set(rows.map((r) => r.pais))).sort((a, b) => a.localeCompare(b, "es"));
}

export function listBookingHotels(rows) {
  return Array.from(new Set(rows.map((r) => r.hotel))).sort((a, b) => a.localeCompare(b, "es"));
}

// Matriz mercado × mes de llegada — cada celda trae reservas y noches; cada
// mercado también trae su total y su promedio de noches por reserva. Se usa
// para el heatmap "Reservas, noches y promedio de noches por país".
export function summarizeByMarketAndMonth(rows) {
  const monthsSet = new Set();
  const cellMap = new Map(); // "mercado|mes" -> { reservas, noches }
  const marketTotals = new Map(); // mercado -> { reservas, noches }

  for (const r of rows) {
    if (!r.entradaDate) continue;
    const month = `${r.entradaDate.getFullYear()}-${String(r.entradaDate.getMonth() + 1).padStart(2, "0")}`;
    const market = r.pais || "Sin dato";
    const nights = r.stayNights !== null && !Number.isNaN(r.stayNights) && r.stayNights >= 0 ? r.stayNights : 0;

    monthsSet.add(month);

    const cellKey = market + "|" + month;
    if (!cellMap.has(cellKey)) cellMap.set(cellKey, { reservas: 0, noches: 0 });
    const cell = cellMap.get(cellKey);
    cell.reservas += 1;
    cell.noches += nights;

    if (!marketTotals.has(market)) marketTotals.set(market, { reservas: 0, noches: 0 });
    const total = marketTotals.get(market);
    total.reservas += 1;
    total.noches += nights;
  }

  const months = Array.from(monthsSet).sort();
  const markets = Array.from(marketTotals.entries())
    .map(([market, t]) => ({
      market,
      reservas: t.reservas,
      noches: t.noches,
      promNoches: t.reservas ? t.noches / t.reservas : 0,
      cells: months.map((month) => cellMap.get(market + "|" + month) || { reservas: 0, noches: 0 }),
    }))
    .sort((a, b) => b.reservas - a.reservas);

  return { months, markets };
}

// Índice = Date.getDay() (0 = domingo ... 6 = sábado).
const WEEKDAY_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const WEEKDAY_ORDER_MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

export function summarizeArrivalsByWeekday(rows) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  for (const r of rows) {
    if (!r.entradaDate) continue;
    counts[r.entradaDate.getDay()] += 1;
    total += 1;
  }
  return WEEKDAY_ORDER_MON_FIRST.map((dayIdx) => ({
    day: WEEKDAY_LABELS[dayIdx],
    reservas: counts[dayIdx],
    pct: total > 0 ? (counts[dayIdx] / total) * 100 : 0,
  }));
}

// Datos de ejemplo — mezcla de fechas de alta/entrada pasadas y futuras
// respecto a cuando se generó este archivo, para que el gráfico "a futuro"
// siempre tenga datos que mostrar sin depender de subir un archivo real.
export const SAMPLE_BOOKINGS_CSV = `Alta,Hotel,Canal,Pais,Afiliado,Fecha entrada,Fecha salida
05/01/2026,Estelar Playa Manzanillo,Booking.com,Colombia,N/D,20/02/2026,24/02/2026
12/01/2026,Estelar Playa Manzanillo,Directo,Estados Unidos,N/D,15/03/2026,20/03/2026
18/01/2026,Estelar Playa Manzanillo,Expedia,México,N/D,02/04/2026,06/04/2026
22/01/2026,Estelar Playa Manzanillo,Booking.com,Colombia,N/D,10/04/2026,13/04/2026
30/01/2026,Estelar Playa Manzanillo,Agencia,España,Agencia Sol,25/04/2026,29/04/2026
04/02/2026,Estelar Playa Manzanillo,Directo,Colombia,N/D,18/05/2026,21/05/2026
10/02/2026,Estelar Playa Manzanillo,Booking.com,Argentina,N/D,05/06/2026,10/06/2026
15/02/2026,Estelar Playa Manzanillo,Expedia,Estados Unidos,N/D,20/06/2026,24/06/2026
21/02/2026,Estelar Playa Manzanillo,Directo,Colombia,N/D,01/07/2026,05/07/2026
02/03/2026,Estelar Playa Manzanillo,Booking.com,México,N/D,28/07/2026,31/07/2026
09/03/2026,Estelar Playa Manzanillo,Directo,Colombia,N/D,10/08/2026,15/08/2026
14/03/2026,Estelar Playa Manzanillo,Agencia,Brasil,Agencia Sol,18/08/2026,22/08/2026
20/03/2026,Estelar Playa Manzanillo,Booking.com,Colombia,N/D,25/08/2026,28/08/2026
28/03/2026,Estelar Playa Manzanillo,Expedia,España,N/D,03/09/2026,07/09/2026
05/04/2026,Estelar Playa Manzanillo,Directo,Colombia,N/D,12/09/2026,16/09/2026
12/04/2026,Estelar Playa Manzanillo,Booking.com,Estados Unidos,N/D,20/09/2026,25/09/2026
19/04/2026,Estelar Playa Manzanillo,Directo,Colombia,N/D,05/10/2026,09/10/2026
26/04/2026,Estelar Playa Manzanillo,Agencia,Argentina,Agencia Sol,15/10/2026,19/10/2026
03/05/2026,Estelar Playa Manzanillo,Booking.com,Colombia,N/D,22/10/2026,26/10/2026
10/05/2026,Estelar Playa Manzanillo,Expedia,México,N/D,08/11/2026,12/11/2026
17/05/2026,Estelar Playa Manzanillo,Directo,Colombia,N/D,20/11/2026,24/11/2026
24/05/2026,Estelar Playa Manzanillo,Booking.com,España,N/D,10/12/2026,15/12/2026
31/05/2026,Estelar Playa Manzanillo,Directo,Colombia,N/D,22/12/2026,28/12/2026
07/06/2026,Estelar Playa Manzanillo,Booking.com,Estados Unidos,N/D,15/01/2027,20/01/2027
14/06/2026,Estelar Playa Manzanillo,Directo,Colombia,N/D,05/02/2027,09/02/2027
21/06/2026,Estelar Playa Manzanillo,Expedia,Brasil,N/D,18/02/2027,22/02/2027
28/06/2026,Estelar Playa Manzanillo,Directo,Colombia,N/D,10/03/2027,14/03/2027
05/07/2026,Estelar Playa Manzanillo,Booking.com,México,N/D,25/08/2026,29/08/2026
08/07/2026,Estelar Playa Manzanillo,Directo,Colombia,N/D,30/07/2026,02/08/2026
10/07/2026,Estelar Playa Manzanillo,Agencia,Argentina,Agencia Sol,15/09/2026,19/09/2026`;
