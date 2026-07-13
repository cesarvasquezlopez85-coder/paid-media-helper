"""
Función 3 — Generador de copys de Google Ads a partir de una URL.

Sube (pega) la URL de una página y la plataforma genera 15 títulos
(≤30 caracteres) y 10 descripciones (≤90 caracteres) para un anuncio de
búsqueda responsivo (RSA), orientados a conversión.

No llama a un modelo de lenguaje: extrae señales reales de la página
(título, meta description, encabezados, textos de botones/CTA, ofertas
mencionadas) y las combina con plantillas de copywriting de conversión.
Es gratis e instantáneo, y cada texto se valida contra el límite real de
caracteres de Google Ads antes de mostrarse — nunca se entrega un título
u descripción que exceda el límite.

Limitación honesta: no "entiende" la página como lo haría un modelo de
lenguaje. Si la página tiene poco texto o está armada en JavaScript (el
contenido se carga después de cargar el HTML), la extracción va a ser
pobre y el resultado se apoya más en las plantillas genéricas.
"""

import re
import requests
from urllib.parse import urlparse
from bs4 import BeautifulSoup

HEADLINE_LIMIT = 30
DESCRIPTION_LIMIT = 90

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

OFFER_PATTERNS = [
    r"\d{1,3}\s?%\s?(de\s)?(descuento|off)",
    r"(hasta|desde)\s+\d{1,3}\s?%",
    r"env[íi]o\s+gratis",
    r"entrega\s+gratis",
    r"todo\s+inclu[íi]do",
    r"sin\s+costo",
    r"cuotas?\s+sin\s+inter[ée]s",
    r"garant[íi]a\s+(de\s+)?\d+\s+(d[íi]as|meses|a[ñn]os)",
    r"\d+x\d+",
    r"[\$€]\s?\d[\d.,]*",
    r"(oferta|promoci[óo]n)\s+(especial|exclusiva|limitada)?",
    r"reserva\s+(ya|ahora|hoy)",
    r"[úu]ltimas?\s+unidades",
    r"solo\s+por\s+hoy",
]

GENERIC_OFFERS = ["Precios Especiales", "Oferta Disponible", "Promoción Vigente"]

HEADLINE_TEMPLATES = [
    "{keyword}",
    "{keyword} Oficial",
    "Compra {keyword}",
    "{keyword} Hoy",
    "{keyword}: Oferta",
    "Descuento en {keyword}",
    "{keyword} Envío Gratis",
    "Mejor Precio: {keyword}",
    "{keyword} Garantizado",
    "Reserva {keyword}",
    "{keyword} Disponible Ya",
    "{brand}: {keyword}",
    "{keyword} - {brand}",
    "Compra Online: {keyword}",
    "{keyword} Sin Costo Extra",
    "{brand} Oficial",
    "{keyword} | Precio Especial",
]

DESCRIPTION_TEMPLATES = [
    "Descubre {keyword}. {offer}. Compra hoy y aprovecha los mejores precios online.",
    "{keyword} al mejor precio. {offer}. Envío rápido y atención garantizada.",
    "{offer} en {keyword}. Miles de clientes satisfechos. Compra segura hoy mismo.",
    "Encuentra {keyword} con garantía. {offer}. Haz tu pedido en minutos.",
    "{brand} te ofrece {keyword}. {offer}. Calidad y confianza en cada compra.",
    "{keyword} disponible ahora. {offer}. Reserva en línea sin complicaciones.",
    "Conoce {keyword} de {brand}. {offer}. Atención personalizada todos los días.",
    "{offer} exclusiva en {keyword}. No dejes pasar esta oportunidad, compra ya.",
    "{keyword}: la opción preferida por miles. {offer}. Compra 100% segura.",
    "Todo lo que buscas en {keyword} está aquí. {offer}. Pide el tuyo hoy.",
]


def _clean(text):
    return re.sub(r"\s+", " ", text or "").strip()


def _fit(text, limit):
    """Recorta el texto al límite de caracteres, cortando en un espacio si puede."""
    text = _clean(text)
    if len(text) <= limit:
        return text
    truncated = text[:limit]
    if " " in truncated:
        truncated = truncated[: truncated.rfind(" ")]
    return truncated.strip()


def fetch_page(url, timeout=15):
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    resp = requests.get(url, timeout=timeout, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return resp.text, url


def _guess_brand_and_keyword(title, h1, domain):
    domain_root = re.sub(r"^www\.", "", domain).split(".")[0].lower()
    parts = re.split(r"\s*[\|\-–:•]\s*", title) if title else []
    parts = [p.strip() for p in parts if p.strip()]

    # Preferimos la parte del título cuyas palabras aparezcan dentro del
    # dominio (ej. "Estelar" en "hotelesestelar.com") en vez de asumir que
    # la parte más corta es la marca — los sitios no siguen un orden fijo.
    brand = None
    for part in parts:
        words = re.findall(r"[a-záéíóúñ]+", part.lower())
        if any(len(w) >= 4 and w in domain_root for w in words):
            brand = part
            break
    if brand is None and parts:
        brand = min(parts, key=len)
    if brand is None:
        brand = domain_root.capitalize()

    keyword = h1.strip() if h1 else None
    if not keyword and parts:
        remaining = [p for p in parts if p.strip() != brand]
        keyword = max(remaining, key=len).strip() if remaining else parts[0].strip()
    if not keyword:
        keyword = domain_root.capitalize()

    return brand, keyword


def extract_signals(html, url):
    soup = BeautifulSoup(html, "html.parser")
    domain = urlparse(url).netloc

    title = _clean(soup.title.string) if soup.title and soup.title.string else ""
    meta_tag = soup.find("meta", attrs={"name": "description"})
    meta_description = _clean(meta_tag["content"]) if meta_tag and meta_tag.get("content") else ""

    h1 = _clean(soup.h1.get_text()) if soup.h1 else ""
    h2s = [_clean(h.get_text()) for h in soup.find_all("h2")]
    h2s = [h for h in h2s if h]

    li_texts = [_clean(li.get_text()) for li in soup.find_all("li")]
    li_texts = [t for t in li_texts if 3 <= len(t) <= 100]

    cta_texts = []
    for tag in soup.find_all(["a", "button"]):
        text = _clean(tag.get_text())
        if text and 3 <= len(text) <= 40:
            cta_texts.append(text)

    full_text = _clean(soup.get_text(" "))
    offers = []
    for pattern in OFFER_PATTERNS:
        for match in re.finditer(pattern, full_text, flags=re.IGNORECASE):
            phrase = _clean(match.group(0))
            if phrase and phrase not in offers:
                offers.append(phrase)
    offers = offers[:10] or GENERIC_OFFERS

    brand, keyword = _guess_brand_and_keyword(title, h1, domain)

    return {
        "title": title,
        "meta_description": meta_description,
        "h1": h1,
        "h2s": h2s,
        "li_texts": li_texts,
        "cta_texts": cta_texts,
        "offers": offers,
        "brand": brand,
        "keyword": keyword,
        "domain": domain,
    }


def _keyword_without_brand(keyword, brand):
    """Evita frases redundantes tipo '{brand} te ofrece {brand}...' cuando el
    H1/título ya incluye el nombre de la marca dentro de la frase clave."""
    if not brand or not keyword:
        return keyword
    stripped = re.sub(re.escape(brand), "", keyword, flags=re.IGNORECASE)
    stripped = _clean(re.sub(r"^[\s\-–:|]+|[\s\-–:|]+$", "", stripped))
    return stripped if len(stripped) >= 6 else keyword


def generate_headlines(signals, n=15):
    candidates = []
    keyword_short = _keyword_without_brand(signals["keyword"], signals["brand"])

    for raw in [signals["title"], signals["h1"], *signals["h2s"], *signals["cta_texts"]]:
        if raw:
            candidates.append(_fit(raw, HEADLINE_LIMIT))

    for template in HEADLINE_TEMPLATES:
        uses_brand = "{brand}" in template
        kw = keyword_short if uses_brand else signals["keyword"]
        text = template.format(keyword=kw, brand=signals["brand"])
        candidates.append(_fit(text, HEADLINE_LIMIT))

    seen = set()
    result = []
    for c in candidates:
        key = c.lower()
        if c and key not in seen:
            seen.add(key)
            result.append(c)
        if len(result) == n:
            break

    fallback_idx = 0
    generic_fallbacks = [
        "Oferta Especial Hoy", "Compra Segura Online", "Envío a Todo el País",
        "Atención Personalizada", "Precios Increíbles", "Calidad Garantizada",
    ]
    while len(result) < n:
        extra = _fit(generic_fallbacks[fallback_idx % len(generic_fallbacks)], HEADLINE_LIMIT)
        key = f"{extra}_{fallback_idx}"
        if extra.lower() not in seen:
            seen.add(extra.lower())
            result.append(extra)
        fallback_idx += 1
        if fallback_idx > 50:
            break

    return result[:n]


def generate_descriptions(signals, n=10):
    candidates = []

    if signals["meta_description"]:
        candidates.append(_fit(signals["meta_description"], DESCRIPTION_LIMIT))
    for li in signals["li_texts"]:
        candidates.append(_fit(li, DESCRIPTION_LIMIT))

    offers_cycle = signals["offers"]
    keyword_short = _keyword_without_brand(signals["keyword"], signals["brand"])
    for i, template in enumerate(DESCRIPTION_TEMPLATES):
        offer = offers_cycle[i % len(offers_cycle)]
        uses_brand = "{brand}" in template
        kw = keyword_short if uses_brand else signals["keyword"]
        text = template.format(keyword=kw, brand=signals["brand"], offer=offer)
        candidates.append(_fit(text, DESCRIPTION_LIMIT))

    seen = set()
    result = []
    for c in candidates:
        key = c.lower()
        if c and len(c) >= 10 and key not in seen:
            seen.add(key)
            result.append(c)
        if len(result) == n:
            break

    fallback_idx = 0
    while len(result) < n:
        offer = offers_cycle[fallback_idx % len(offers_cycle)]
        text = _fit(
            f"{keyword_short} con la confianza de {signals['brand']}. "
            f"{offer}. Compra hoy mismo, fácil y seguro.",
            DESCRIPTION_LIMIT,
        )
        if text.lower() not in seen:
            seen.add(text.lower())
            result.append(text)
        fallback_idx += 1
        if fallback_idx > 50:
            break

    return result[:n]


def analyze_url(url):
    html, resolved_url = fetch_page(url)
    signals = extract_signals(html, resolved_url)
    headlines = generate_headlines(signals, n=15)
    descriptions = generate_descriptions(signals, n=10)
    return signals, headlines, descriptions
