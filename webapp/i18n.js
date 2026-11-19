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
      patterns.push({ re: new RegExp(`^${source}$`), order, tpl: value });
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

// Traduce un texto. Conserva los espacios del principio y del final. Sin traducción devuelve el mismo texto.
export function t(text) {
  if (lang !== 'en' || text == null) return text;
  const s = String(text);
  const n = norm(s);
  if (!n) return s;
  let hit = exact.get(n);
  if (hit === undefined) {
    for (const p of patterns) {
      const m = n.match(p.re);
      if (!m) continue;
      hit = p.tpl.replace(/\{(\d+)\}/g, (_, i) => {
        const j = p.order.indexOf(i);
        const cap = j >= 0 ? m[j + 1] : '';
        const sub = exact.get(norm(cap));
        // Si lo capturado tiene traducción propia se usa, conservando sus espacios de los extremos.
        return sub === undefined ? cap : cap.match(/^\s*/)[0] + sub + cap.match(/\s*$/)[0];
      });
      break;
    }
  }
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

// Ayuda para completar el diccionario: con localStorage.pmh_i18n_debug = '1' guarda los textos sin traducir.
window.__i18n = { missing: () => [...missingSet].sort(), clear: () => missingSet.clear(), lang: () => lang };
