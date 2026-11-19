// Idioma de la interfaz (español / inglés). Se traduce de forma central y por diccionario:
// el texto en español del código es la clave y i18n-en.js trae su versión en inglés. Lo que no
// tenga traducción se queda en español, así que una pantalla a medio traducir nunca se rompe.
//
// - En español no se hace nada (cero costo): el diccionario ni se descarga.
// - En inglés se traduce cada texto, y los atributos placeholder/title/aria-label/alt, de lo que
//   se dibuja en pantalla, y un observador traduce también lo que se agregue después.
// - Una frase con datos va como patrón: «Mostrando {0} de {1}» → «Showing {0} of {1}».
// - La elección se guarda en el navegador y en el usuario (para que lo siga a otro computador).

const LS_KEY = 'pmh_lang';
export const SUPPORTED = ['es', 'en'];

let lang = 'es';
let dictLoaded = false;
const exact = new Map();
const patterns = [];
const trackedText = new WeakMap(); // nodo de texto → { orig, shown }
const trackedAttr = new WeakMap(); // elemento → { atributo: { orig, shown } }
const missingSet = new Set();
let observer = null;
let applying = false;
let ready = Promise.resolve();
const changeListeners = [];

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'NOSCRIPT']);
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

function readStored() {
  try { const v = localStorage.getItem(LS_KEY); return SUPPORTED.includes(v) ? v : null; } catch (e) { return null; }
}
function storeLang(v) { try { localStorage.setItem(LS_KEY, v); } catch (e) { /* sin almacenamiento: no pasa nada */ } }
function debugOn() { try { return localStorage.getItem('pmh_i18n_debug') === '1'; } catch (e) { return false; } }

export function getLang() { return lang; }
// Idioma para fechas y horas (nombres de meses y días).
export function dateLocale() { return lang === 'en' ? 'en-US' : 'es-CO'; }
export function onLangChange(fn) { changeListeners.push(fn); }

function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

function buildIndex(dict) {
  exact.clear(); patterns.length = 0;
  Object.entries(dict).forEach(([key, value]) => {
    const k = norm(key);
    if (/\{n?\d+\}/.test(k)) {
      const order = [];
      const source = k.split(/(\{n?\d+\})/).map((part) => {
        const m = part.match(/^\{(n?)(\d+)\}$/);
        if (m) { order.push(m[2]); return m[1] ? '(\\d[\\d.,]*)' : '(.*?)'; } // {n0}: solo un número
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      // Texto fijo más largo del patrón: si el texto no lo contiene, ni se prueba la expresión regular (más rápido con muchos patrones).
      const needle = k.split(/\{n?\d+\}/).reduce((a, b) => (b.length > a.length ? b : a), '');
      patterns.push({ re: new RegExp(`^${source}$`), order, tpl: value, needle, lead: /^\{n?\d+\}/.test(k), trail: /\{n?\d+\}$/.test(k), dot: k.includes(' · ') });
    } else {
      exact.set(k, value);
    }
  });
  // Los patrones más largos primero, para que uno general no se coma a uno específico.
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);
}

async function loadDict() {
  if (dictLoaded) return;
  const mod = await import('./i18n-en.js');
  buildIndex(mod.EN || {});
  dictLoaded = true;
}

// Textos con varias piezas (separadas por « · » o varias frases seguidas): se traducen pieza por pieza.
// Con strict, solo si TODAS las piezas tienen traducción (así un patrón general no parte mal una frase larga).
const PART_SPLITS = [[' · ', / · /], [' ', /(?<=[.!?])\s+(?=\S)/]];
function translateParts(n, depth, strict) {
  for (const [sep, re] of PART_SPLITS) {
    const parts = n.split(re);
    if (parts.length < 2) continue;
    let any = false;
    let all = true;
    const out = parts.map((part) => {
      const sub = lookup(part, depth + 1);
      if (sub === undefined) { all = false; return part; }
      any = true;
      return sub;
    });
    if (strict ? all : any) return out.join(sep);
  }
  return undefined;
}

// Busca la traducción de un texto ya normalizado (sin tocar los espacios de los extremos). Devuelve undefined si no hay.
// Lo que capturan los marcadores también se traduce (con entradas exactas o con otros patrones), hasta 3 niveles.
function lookup(n, depth) {
  const direct = exact.get(n);
  if (direct !== undefined) return direct;
  if (depth > 3) return undefined;
  // Títulos de las reglas de la auditoría («A4 · Conversiones»): el código va aparte y el resto se traduce solo.
  const rule = n.match(/^([A-Z]{1,2}\d{1,2}[a-z]?) · (.+)$/);
  if (rule) {
    const sub = lookup(rule[2], depth + 1);
    if (sub !== undefined) return rule[1] + ' · ' + sub;
  }
  // Prefijo de viñeta «➜ »: se traduce el resto de la frase por separado (si no, un patrón genérico con coma lo parte mal).
  if (n.startsWith('➜ ')) {
    const sub = lookup(n.slice(2), depth + 1);
    if (sub !== undefined) return '➜ ' + sub;
  }
  if (depth <= 2) {
    const whole = translateParts(n, depth, true);
    if (whole !== undefined) return whole;
  }
  for (const p of patterns) {
    if (p.needle && !n.includes(p.needle)) continue;
    const m = n.match(p.re);
    if (!m) continue;
    // Un patrón que empieza con un marcador no puede tragarse un «**etiqueta:**» ni un «etiqueta: valor» (líneas de Markdown): ahí se traduce por partes.
    if (p.lead && /\*\*|: /.test(m[1])) continue;
    // Un patrón sin « · » no se traga varias piezas unidas con « · »: se traducen una por una (último recurso de abajo).
    if (!p.dot && ((p.lead && m[1].includes(' · ')) || (p.trail && m[m.length - 1].includes(' · ')))) continue;
    return p.tpl.replace(/\{(\d+)\}/g, (_, i) => {
      const j = p.order.indexOf(i);
      const cap = j >= 0 ? m[j + 1] : '';
      const cn = norm(cap);
      const sub = cn ? lookup(cn, depth + 1) : undefined;
      // Si lo capturado tiene traducción propia se usa, conservando sus espacios de los extremos.
      return sub === undefined ? cap : cap.match(/^\s*/)[0] + sub + cap.match(/\s*$/)[0];
    });
  }
  // Último recurso: lo que se pueda traducir por piezas, aunque no todas.
  if (depth <= 2) return translateParts(n, depth, false);
  return undefined;
}

// Traduce un texto. Conserva los espacios del principio y del final. Sin traducción devuelve el mismo texto.
export function t(text) {
  if (lang !== 'en' || text == null) return text;
  const s = String(text);
  const n = norm(s);
  if (!n) return s;
  const hit = lookup(n, 0);
  if (hit === undefined) return s;
  return s.match(/^\s*/)[0] + hit + s.match(/\s*$/)[0];
}

function noteMissing(text) {
  if (!debugOn()) return;
  const n = norm(text);
  if (n.length >= 2 && /[A-Za-zÁÉÍÓÚáéíóúñÑ]{2}/.test(n)) missingSet.add(n);
}

function applyText(node) {
  const parent = node.parentNode;
  if (!parent || SKIP_TAGS.has(parent.nodeName)) return;
  const rec = trackedText.get(node);
  const orig = rec && node.nodeValue === rec.shown ? rec.orig : node.nodeValue;
  const out = t(orig);
  if (out !== orig) {
    node.nodeValue = out;
    trackedText.set(node, { orig, shown: out });
  } else {
    if (rec) trackedText.delete(node);
    noteMissing(orig);
  }
}

function applyAttrs(el) {
  for (const a of ATTRS) {
    if (!el.hasAttribute || !el.hasAttribute(a)) continue;
    const recs = trackedAttr.get(el) || {};
    const cur = el.getAttribute(a);
    const orig = recs[a] && cur === recs[a].shown ? recs[a].orig : cur;
    const out = t(orig);
    if (out !== orig) {
      el.setAttribute(a, out);
      recs[a] = { orig, shown: out };
      trackedAttr.set(el, recs);
    } else {
      if (recs[a]) { delete recs[a]; }
      noteMissing(orig);
    }
  }
}

function restoreText(node) {
  const rec = trackedText.get(node);
  if (rec && node.nodeValue === rec.shown) node.nodeValue = rec.orig;
  trackedText.delete(node);
}
function restoreAttrs(el) {
  const recs = trackedAttr.get(el);
  if (!recs) return;
  for (const a of Object.keys(recs)) {
    if (el.getAttribute(a) === recs[a].shown) el.setAttribute(a, recs[a].orig);
  }
  trackedAttr.delete(el);
}

function walk(root, fnText, fnEl) {
  if (!root) return;
  if (root.nodeType === 3) { fnText(root); return; }
  if (root.nodeType !== 1) return;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  fnEl(root);
  let n = tw.nextNode();
  while (n) {
    if (n.nodeType === 3) fnText(n);
    else fnEl(n);
    n = tw.nextNode();
  }
}

let titleOrig = null;
function applyTitle() {
  if (titleOrig === null) titleOrig = document.title;
  document.title = lang === 'en' ? t(titleOrig) : titleOrig;
}

function applyAll(root) {
  applying = true;
  try {
    walk(root || document.body, applyText, applyAttrs);
    applyTitle();
  } finally {
    applying = false;
    if (observer) observer.takeRecords();
  }
}
function restoreAll() {
  applying = true;
  try { walk(document.body, restoreText, restoreAttrs); applyTitle(); } finally { applying = false; }
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    if (applying || lang !== 'en') return;
    applying = true;
    try {
      records.forEach((r) => {
        if (r.type === 'childList') r.addedNodes.forEach((n) => walk(n, applyText, applyAttrs));
        else if (r.type === 'attributes' && r.target.nodeType === 1) applyAttrs(r.target);
      });
    } finally {
      applying = false;
      observer.takeRecords();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ATTRS });
}
function stopObserver() { if (observer) { observer.disconnect(); observer = null; } }

function markSwitch() {
  document.querySelectorAll('.lang-switch [data-lang]').forEach((b) => {
    const on = b.dataset.lang === lang;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function saveToServer(next) {
  try {
    fetch('/api/language', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: next }) }).catch(() => {});
  } catch (e) { /* sin sesión (login): se guarda al entrar */ }
}

// Cambia el idioma. opts.persist === false: no lo manda al servidor (cuando viene del propio servidor).
export async function setLang(next, opts = {}) {
  if (!SUPPORTED.includes(next)) return;
  if (next === 'en') await loadDict();
  const changed = next !== lang;
  lang = next;
  storeLang(next);
  document.documentElement.lang = next;
  if (next === 'en') { applyAll(); startObserver(); } else { stopObserver(); restoreAll(); }
  markSwitch();
  if (opts.persist !== false) saveToServer(next);
  if (changed) changeListeners.forEach((fn) => { try { fn(next); } catch (e) { /* un oyente no tumba a los demás */ } });
}

// Al arrancar: el idioma guardado en el navegador (o español) antes de dibujar la página.
export async function initLang() {
  ready = (async () => {
    const stored = readStored();
    if (stored === 'en') await setLang('en', { persist: false });
    else { document.documentElement.lang = 'es'; markSwitch(); }
    document.querySelectorAll('.lang-switch [data-lang]').forEach((b) => {
      b.addEventListener('click', () => setLang(b.dataset.lang));
    });
  })();
  await ready;
}

// Con la sesión iniciada: manda el idioma que la persona tiene guardado en el servidor; si no tiene, sube el del navegador.
export function syncServerLang(serverLang) {
  ready.then(() => {
    if (SUPPORTED.includes(serverLang)) {
      if (serverLang !== lang) setLang(serverLang, { persist: false });
    } else if (readStored()) {
      saveToServer(lang);
    }
  });
}

// Para quien no tiene el interruptor habilitado: vuelve a español sin tocar lo guardado en el servidor.
export function forceSpanish() {
  ready.then(() => { if (lang !== 'es') setLang('es', { persist: false }); });
}

// ---- Descargas (HTML, Markdown): se traducen al generarlas, con el mismo diccionario ----
// HTML: se lee como página y se traducen los textos y los atributos, igual que en pantalla.
function translateHtmlString(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tw = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n = tw.currentNode;
  while (n) {
    if (n.nodeType === 3) {
      if (n.parentNode && !SKIP_TAGS.has(n.parentNode.nodeName)) n.nodeValue = t(n.nodeValue);
    } else if (n.nodeType === 1) {
      for (const a of ATTRS) if (n.hasAttribute(a)) n.setAttribute(a, t(n.getAttribute(a)));
    }
    n = tw.nextNode();
  }
  doc.documentElement.setAttribute('lang', 'en');
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

// Markdown: línea por línea. Las filas de tabla, celda por celda; las demás, primero la línea completa,
// luego sin el marcador de inicio (#, -, *), y al final por pedazos: «**etiqueta:** valor» y «etiqueta: valor».
function translateMarkdownString(md) {
  return md.split('\n').map((line) => {
    const m = line.match(/^(\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+)?)(.*)$/);
    const prefix = m[1]; const rest = m[2];
    if (/^\|.*\|\s*$/.test(rest)) {
      if (/^\|[\s:|-]+\|\s*$/.test(rest)) return line; // la fila de guiones
      return prefix + rest.split('|').map((c) => t(c)).join('|');
    }
    const whole = t(rest);
    if (whole !== rest) return prefix + whole;
    const full = t(line);
    if (full !== line) return full;
    return prefix + rest.split(/(\*\*[^*]+\*\*)/).map((seg) => {
      const b = seg.match(/^\*\*([^*]+)\*\*$/);
      if (b) {
        const inner = b[1]; const ti = t(inner);
        if (ti !== inner) return '**' + ti + '**';
        const lab = inner.match(/^(.*?):$/);
        return '**' + (lab ? t(lab[1]) + ':' : inner) + '**';
      }
      const kv = seg.match(/^(\s*)([^:]{1,40}):\s(.+)$/);
      if (kv) {
        const k2 = t(kv[2]); const v2 = t(kv[3]);
        if (k2 !== kv[2] || v2 !== kv[3]) return kv[1] + k2 + ': ' + v2;
      }
      return t(seg);
    }).join('');
  }).join('\n');
}

export function translateDownload(content, mime) {
  if (lang !== 'en' || typeof content !== 'string') return content;
  try {
    if (/html/i.test(mime)) return translateHtmlString(content);
    if (/markdown/i.test(mime)) return translateMarkdownString(content);
  } catch (e) { /* si algo falla, se descarga el original en español */ }
  return content;
}

// Ayuda para completar el diccionario: con localStorage.pmh_i18n_debug = '1' guarda los textos sin traducir.
window.__i18n = { missing: () => [...missingSet].sort(), clear: () => missingSet.clear(), lang: () => lang, t };
