"""
Motor v2 — Negativización de términos de búsqueda.

Recibe el export de "Términos de búsqueda" de Google Ads y una definición de
qué se considera relevante (términos núcleo + excepciones conocidas), y
devuelve cada término clasificado en una de tres categorías:

  - "mantener"    → relacionado con la marca/oferta, no tocar.
  - "revisar"     → contiene un término núcleo pero también coincide con una
                    excepción conocida (ambigüedad real) → requiere ojo humano.
  - "negativizar" → candidato a agregarse como palabra clave negativa.

Por qué no usa un LLM por término: en cuentas de 100+ clientes, clasificar
miles de términos por semana vía API tiene costo y latencia no triviales.
Este mecanismo es determinístico y gratis, y en la prueba con datos reales
de Estelar Playa Manzanillo separó correctamente casos genuinamente
ambiguos (ver "excepciones" más abajo) sin necesitar una llamada externa.
Su límite: solo detecta la ambigüedad que el usuario anticipa como
excepción — no descubre matices nuevos que nadie haya escrito. Por eso la
categoría "revisar" existe, y por eso nunca se debe auto-publicar
"negativizar" sin que alguien lo confirme.
"""

import io
import pandas as pd

COLUMN_ALIASES = {
    "term": ["Término de búsqueda", "Search term"],
    "match_type": ["Tipo de concordancia", "Match type"],
    "added_excluded": ["Agregadas/excluidas", "Added/Excluded"],
    "clicks": ["Clics", "Clicks"],
    "impr": ["Impr.", "Impressions"],
    "cost": ["Costo", "Cost"],
    "conversions": ["Conversiones", "Conversions"],
}


def _find_column(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None


def _to_number(series):
    if series.dtype != object:
        return pd.to_numeric(series, errors="coerce")
    cleaned = (
        series.astype(str)
        .str.replace("%", "", regex=False)
        .str.replace("$", "", regex=False)
        .str.replace(",", "", regex=False)
        .str.strip()
    )
    return pd.to_numeric(cleaned, errors="coerce")


def load_search_terms(file_path_or_buffer):
    """
    Carga el export de "Términos de búsqueda" de Google Ads.

    Google Ads exporta este reporte como CSV separado por tabs en UTF-16,
    con 2 líneas de encabezado de texto antes de la fila de columnas. Si
    ese formato falla, hace un segundo intento como CSV estándar (UTF-8,
    coma) por si el archivo viene de otra fuente (ej. Windsor.ai).
    """
    raw_bytes = None
    if hasattr(file_path_or_buffer, "read"):
        raw_bytes = file_path_or_buffer.read()
        if isinstance(raw_bytes, str):
            raw_bytes = raw_bytes.encode("utf-8")
    else:
        with open(file_path_or_buffer, "rb") as f:
            raw_bytes = f.read()

    df_raw = None
    # Intento 1: formato nativo de Google Ads (UTF-16, tabs, 2 líneas de título)
    try:
        df_raw = pd.read_csv(io.BytesIO(raw_bytes), sep="\t", encoding="utf-16", skiprows=2)
    except Exception:
        df_raw = None

    # Intento 2: CSV estándar
    if df_raw is None or _find_column(df_raw, COLUMN_ALIASES["term"]) is None:
        for encoding in ("utf-8", "latin-1"):
            try:
                candidate = pd.read_csv(io.BytesIO(raw_bytes), encoding=encoding)
                if _find_column(candidate, COLUMN_ALIASES["term"]) is not None:
                    df_raw = candidate
                    break
            except Exception:
                continue

    if df_raw is None:
        raise ValueError("No se pudo leer el archivo con ningún formato conocido.")

    term_col = _find_column(df_raw, COLUMN_ALIASES["term"])
    if term_col is None:
        raise ValueError(
            "No se encontró una columna de término de búsqueda reconocible."
        )

    df_raw = df_raw[df_raw[term_col].notna()].copy()
    df_raw = df_raw[~df_raw[term_col].astype(str).str.startswith("Total:")]

    df = pd.DataFrame()
    df["term"] = df_raw[term_col].astype(str)

    for field in ["clicks", "impr", "cost", "conversions"]:
        col = _find_column(df_raw, COLUMN_ALIASES[field])
        df[field] = _to_number(df_raw[col]) if col is not None else 0.0
    df[["clicks", "impr", "cost", "conversions"]] = df[["clicks", "impr", "cost", "conversions"]].fillna(0)

    return df


def _normalize(text):
    text = str(text).lower()
    accents = {"á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u", "ñ": "n", "ü": "u"}
    for a, b in accents.items():
        text = text.replace(a, b)
    return text


def classify_terms(df, core_terms, exceptions=None):
    """
    core_terms: lista de palabras o frases que definen "relacionado" (ej.
        ["estelar", "manzanillo"]). Un término se considera relacionado si
        contiene AL MENOS UNO de estos.
    exceptions: lista de frases que, aunque contengan un término núcleo, se
        sabe que NO son relevantes (ej. ["manzanillo del mar"] porque es un
        barrio distinto a la playa donde está el hotel). Si un término
        coincide con un núcleo Y con una excepción, se manda a "revisar" en
        vez de descartarlo de una — la excepción es una señal de alerta,
        no una certeza absoluta.
    """
    exceptions = exceptions or []
    core_terms_n = [_normalize(t) for t in core_terms if t.strip()]
    exceptions_n = [_normalize(t) for t in exceptions if t.strip()]

    df = df.copy()
    df["term_norm"] = df["term"].apply(_normalize)

    def classify(t):
        matches_core = any(c in t for c in core_terms_n)
        matches_exception = any(e in t for e in exceptions_n)
        if matches_exception and matches_core:
            return "revisar"
        if matches_core:
            return "mantener"
        return "negativizar"

    df["clasificacion"] = df["term_norm"].apply(classify)
    return df.drop(columns=["term_norm"])


def summarize_classification(df):
    resumen = (
        df.groupby("clasificacion")
        .agg(terminos=("term", "count"), costo=("cost", "sum"), clics=("clicks", "sum"))
        .reindex(["mantener", "revisar", "negativizar"])
        .fillna(0)
    )
    return resumen
