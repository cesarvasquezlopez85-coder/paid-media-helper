"""
Motor de análisis para reportes de rendimiento de Google Ads (nivel campaña).

Recibe un export CSV/Excel descargado directo de Google Ads (reporte de
campañas) y devuelve:
  1. Un DataFrame con métricas derivadas.
  2. Una lista de recomendaciones de optimización, priorizadas por impacto.

No depende de Streamlit ni de ningún framework de UI para que se pueda
probar y reusar de forma independiente (ver test_analysis.py).
"""

import pandas as pd
import numpy as np

# ---------------------------------------------------------------------------
# Mapeo de columnas: Google Ads exporta encabezados distintos según el
# idioma de la cuenta. Mapeamos variantes conocidas a nombres internos.
# ---------------------------------------------------------------------------
COLUMN_ALIASES = {
    "campaign": ["Campaign", "Campaña"],
    "status": ["Campaign status", "Estado de la campaña"],
    "budget": ["Budget", "Presupuesto"],
    "impressions": ["Impr.", "Impressions", "Impr"],
    "clicks": ["Clicks", "Clics"],
    "ctr": ["CTR"],
    "avg_cpc": ["Avg. CPC", "CPC prom.", "CPC promedio"],
    "cost": ["Cost", "Costo"],
    "conversions": ["Conversions", "Conversiones"],
    "cost_per_conv": ["Cost / conv.", "Costo/conv.", "Costo / conv."],
    "conv_rate": ["Conv. rate", "Tasa de conv."],
    "lost_is_budget": [
        "Search Lost IS (budget)",
        "IS perdido por presupuesto (búsqueda)",
        "Search lost IS (budget)",
    ],
    "lost_is_rank": [
        "Search Lost IS (rank)",
        "IS perdido por ranking (búsqueda)",
        "Search lost IS (rank)",
    ],
    "campaign_type": ["Campaign type", "Tipo de campaña"],
}

# Umbrales heurísticos v1 — ajustables. No sustituyen el criterio de un
# estratega de cuenta, son un primer filtro para priorizar dónde mirar.
THRESHOLDS = {
    "cpa_high_vs_avg_pct": 0.20,       # CPA 20% arriba del promedio de cuenta
    "lost_is_budget_high": 0.10,       # >10% de IS perdido por presupuesto
    "lost_is_rank_high": 0.10,         # >10% de IS perdido por ranking
    "min_cost_to_flag": 0.0,           # costo mínimo para considerar una campaña relevante
}

# CTR mínimo saludable, segmentado por tipo de campaña. El 2% único de v1
# generaba alertas falsas en dos direcciones: en Display/Performance Max
# (CTR naturalmente más bajo que Search) y en Search de marca (CTR
# naturalmente mucho más alto que Search genérica, porque quien busca el
# nombre de la marca casi siempre hace clic). Por eso Search se divide en
# marca y genérica.
#
# Si el archivo no trae "Campaign type", o trae un tipo no reconocido
# (Shopping, Video, etc.), se trata como Search; y dentro de Search, si el
# nombre de la campaña no matchea ninguna palabra de marca, se trata como
# genérica — el fallback más conservador (evita "esconder" alertas reales
# bajo el umbral alto de marca).
CTR_THRESHOLDS_BY_TYPE = {
    "search_brand": 0.20,
    "search_generic": 0.08,   # cesar dio un rango de 7-10%; 8% como punto medio, ajustable
    "display": 0.01,
    "performance_max": 0.03,
}
DEFAULT_CAMPAIGN_TYPE = "search_generic"

CAMPAIGN_TYPE_LABELS = {
    "search_brand": "Search (marca)",
    "search_generic": "Search (genérica)",
    "display": "Display",
    "performance_max": "Performance Max",
}

# Variantes conocidas (ES/EN, tal como las exporta Google Ads) normalizadas
# a un tipo base. "search" se refina después en marca/genérica según el
# nombre de la campaña (ver _refine_search_type).
CAMPAIGN_TYPE_ALIASES = {
    "search": "search",
    "búsqueda": "search",
    "busqueda": "search",
    "display": "display",
    "red de display": "display",
    "performance max": "performance_max",
    "performance max campaigns": "performance_max",
    "máximo rendimiento": "performance_max",
    "maximo rendimiento": "performance_max",
}
DEFAULT_BASE_TYPE = "search"

# Palabras que, si aparecen en el nombre de la campaña, la marcan como de
# marca. Ajustable por cuenta si la convención de nombres es distinta
# (ej. "Estelar", "Branded", etc.) — hoy es una lista fija por simplicidad;
# pasar `brand_keywords` a load_report() para sobreescribirla.
DEFAULT_BRAND_KEYWORDS = ["marca", "brand", "branded", "brnd"]


def _normalize_base_type(raw_value):
    """Mapea el valor crudo de 'Campaign type' a search/display/performance_max.

    Cualquier valor vacío o no reconocido (Shopping, Video, etc.) cae en
    Search por defecto — comportamiento actual, sin bloquear el análisis.
    """
    if raw_value is None or (isinstance(raw_value, float) and np.isnan(raw_value)):
        return DEFAULT_BASE_TYPE
    key = str(raw_value).strip().lower()
    return CAMPAIGN_TYPE_ALIASES.get(key, DEFAULT_BASE_TYPE)


def _refine_search_type(campaign_name, brand_keywords):
    """Dentro de Search, distingue marca de genérica por el nombre de campaña.

    Sin evidencia de marca en el nombre, cae en genérica (el umbral más bajo
    y más conservador) en vez de asumir marca.
    """
    name = str(campaign_name).lower()
    if any(kw.lower() in name for kw in brand_keywords):
        return "search_brand"
    return "search_generic"


def _find_column(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None


def _to_number(series):
    """Convierte columnas tipo '12.34%' o '$1,234.56' a float."""
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


def load_report(file_path_or_buffer, is_excel=False, brand_keywords=None):
    """Carga el export de Google Ads y normaliza nombres de columnas.

    brand_keywords: palabras que identifican una campaña de Search como de
    marca (case-insensitive, substring del nombre de campaña). Por defecto
    usa DEFAULT_BRAND_KEYWORDS; pásalo para ajustar por cuenta.
    """
    brand_keywords = brand_keywords if brand_keywords else DEFAULT_BRAND_KEYWORDS
    if is_excel:
        df_raw = pd.read_excel(file_path_or_buffer)
    else:
        df_raw = pd.read_csv(file_path_or_buffer)

    # Google Ads suele incluir filas de resumen ("Total: ...") al final —
    # las descartamos si la columna de campaña viene vacía.
    campaign_col = _find_column(df_raw, COLUMN_ALIASES["campaign"])
    if campaign_col is None:
        raise ValueError(
            "No se encontró una columna de campaña reconocible. "
            "Revisa que el archivo sea un export de campañas de Google Ads."
        )
    df_raw = df_raw[df_raw[campaign_col].notna()].copy()
    df_raw = df_raw[~df_raw[campaign_col].astype(str).str.lower().str.contains("total")]

    df = pd.DataFrame()
    df["campaign"] = df_raw[campaign_col].astype(str)

    numeric_fields = [
        "budget", "impressions", "clicks", "ctr", "avg_cpc", "cost",
        "conversions", "cost_per_conv", "conv_rate", "lost_is_budget",
        "lost_is_rank",
    ]
    for field in numeric_fields:
        col = _find_column(df_raw, COLUMN_ALIASES[field])
        if col is not None:
            values = _to_number(df_raw[col])
            # CTR, conv_rate, lost_is_* vienen como % en Google Ads (ej. "3.45%")
            if field in ("ctr", "conv_rate", "lost_is_budget", "lost_is_rank"):
                values = values / 100.0
            df[field] = values
        else:
            df[field] = np.nan

    status_col = _find_column(df_raw, COLUMN_ALIASES["status"])
    df["status"] = df_raw[status_col].astype(str) if status_col is not None else "N/D"

    # Tipo de campaña (para segmentar el umbral de CTR). Si el archivo no
    # trae la columna "Campaign type", se trata toda la cuenta como Search
    # (comportamiento actual, no bloquea el análisis); dentro de Search, se
    # distingue marca de genérica por el nombre de la campaña.
    type_col = _find_column(df_raw, COLUMN_ALIASES["campaign_type"])
    if type_col is not None:
        base_types = df_raw[type_col].apply(_normalize_base_type)
    else:
        base_types = pd.Series([DEFAULT_BASE_TYPE] * len(df_raw), index=df_raw.index)

    df["campaign_type"] = [
        _refine_search_type(name, brand_keywords) if base == "search" else base
        for name, base in zip(df["campaign"], base_types)
    ]

    return df


def compute_metrics(df):
    """Agrega métricas derivadas necesarias para las recomendaciones."""
    df = df.copy()

    # CPA: usa la columna nativa si viene en el export; si no, la calcula.
    if df["cost_per_conv"].isna().all():
        df["cpa"] = np.where(
            df["conversions"] > 0, df["cost"] / df["conversions"], np.nan
        )
    else:
        df["cpa"] = df["cost_per_conv"]

    if df["ctr"].isna().all():
        df["ctr"] = np.where(
            df["impressions"] > 0, df["clicks"] / df["impressions"], np.nan
        )

    total_cost = df["cost"].sum()
    df["share_of_spend"] = np.where(total_cost > 0, df["cost"] / total_cost, 0)

    return df


def generate_recommendations(df):
    """
    Devuelve una lista de recomendaciones ordenadas por prioridad
    (impacto esperado = share_of_spend de la campaña).

    Sigue el orden del paso 2 del framework de la agencia: CPA/ROAS primero,
    luego presupuesto/pacing, luego CTR/relevancia, luego impression share.
    """
    recs = []
    valid_cpa = df["cpa"].dropna()
    avg_cpa = valid_cpa.mean() if not valid_cpa.empty else None

    for _, row in df.iterrows():
        campaign = row["campaign"]
        cost = row.get("cost", 0) or 0
        if cost < THRESHOLDS["min_cost_to_flag"]:
            continue

        # 1. CPA alto vs. promedio de cuenta
        if avg_cpa and pd.notna(row["cpa"]) and row["cpa"] > avg_cpa * (1 + THRESHOLDS["cpa_high_vs_avg_pct"]):
            pct = (row["cpa"] / avg_cpa - 1) * 100
            recs.append({
                "campaign": campaign,
                "categoria": "CPA",
                "hallazgo": f"CPA de {row['cpa']:.2f} está {pct:.0f}% por arriba del promedio de cuenta ({avg_cpa:.2f}).",
                "recomendacion": "Revisar las palabras clave/segmentos de mayor gasto de esta campaña; pausar o bajar puja en las que no conviertan.",
                "impacto_gasto": row["share_of_spend"],
            })

        # 2. Presupuesto: IS perdido por presupuesto alto -> oportunidad de crecer
        if pd.notna(row["lost_is_budget"]) and row["lost_is_budget"] > THRESHOLDS["lost_is_budget_high"]:
            recs.append({
                "campaign": campaign,
                "categoria": "Presupuesto",
                "hallazgo": f"Está perdiendo {row['lost_is_budget']*100:.0f}% de impression share por presupuesto limitado.",
                "recomendacion": "Si el CPA es sano, subir presupuesto — se está dejando de mostrar por falta de fondos, no por relevancia.",
                "impacto_gasto": row["share_of_spend"],
            })

        # 3. CTR bajo -> problema de relevancia de anuncios/keywords.
        # El umbral se segmenta por tipo de campaña, y dentro de Search por
        # marca vs. genérica; tipos no reconocidos o sin columna caen en el
        # umbral por defecto (Search genérica, el más conservador).
        campaign_type = row.get("campaign_type", DEFAULT_CAMPAIGN_TYPE)
        ctr_threshold = CTR_THRESHOLDS_BY_TYPE.get(campaign_type, CTR_THRESHOLDS_BY_TYPE[DEFAULT_CAMPAIGN_TYPE])
        type_label = CAMPAIGN_TYPE_LABELS.get(campaign_type, campaign_type)
        if pd.notna(row["ctr"]) and row["ctr"] < ctr_threshold:
            recs.append({
                "campaign": campaign,
                "categoria": "Relevancia (CTR)",
                "hallazgo": (
                    f"CTR de {row['ctr']*100:.2f}%, por debajo del mínimo saludable "
                    f"para {type_label} ({ctr_threshold*100:.0f}%)."
                ),
                "recomendacion": "Revisar relevancia de anuncios y palabras clave; probar nuevo copy o ajustar tipos de concordancia.",
                "impacto_gasto": row["share_of_spend"],
            })

        # 4. IS perdido por ranking -> problema de calidad/puja
        if pd.notna(row["lost_is_rank"]) and row["lost_is_rank"] > THRESHOLDS["lost_is_rank_high"]:
            recs.append({
                "campaign": campaign,
                "categoria": "Ranking / Quality Score",
                "hallazgo": f"Está perdiendo {row['lost_is_rank']*100:.0f}% de impression share por ranking (calidad o puja).",
                "recomendacion": "Revisar Quality Score a nivel keyword y considerar subir puja solo si la relevancia del anuncio ya es buena.",
                "impacto_gasto": row["share_of_spend"],
            })

    recs.sort(key=lambda r: r["impacto_gasto"], reverse=True)
    return recs


def summarize(df):
    """Resumen ejecutivo de la cuenta (paso 4 del framework: lenguaje de negocio).

    Muestra dos versiones del CPA promedio de cuenta, diferenciadas para no
    confundirlas (Fase 1 — antes había una sola etiqueta "CPA promedio de
    cuenta" que en realidad mezclaba dos cálculos distintos según la pantalla):
      - avg_cpa_weighted: gasto total / conversiones totales. Pondera las
        campañas grandes más que las chicas. Es el que ya usaba el resumen
        ejecutivo.
      - avg_cpa_simple: promedio simple del CPA entre campañas (sin ponderar
        por gasto). Es el que usa la alerta de "CPA alto" en
        generate_recommendations, para que la alerta y el número mostrado
        coincidan.
    """
    total_cost = df["cost"].sum()
    total_conversions = df["conversions"].sum()
    avg_cpa_weighted = total_cost / total_conversions if total_conversions > 0 else None

    valid_cpa = df["cpa"].dropna()
    avg_cpa_simple = valid_cpa.mean() if not valid_cpa.empty else None

    return {
        "total_cost": total_cost,
        "total_conversions": total_conversions,
        "avg_cpa_weighted": avg_cpa_weighted,
        "avg_cpa_simple": avg_cpa_simple,
        "campanas_analizadas": len(df),
        "campanas_con_gasto": int((df["cost"] > 0).sum()),
    }
