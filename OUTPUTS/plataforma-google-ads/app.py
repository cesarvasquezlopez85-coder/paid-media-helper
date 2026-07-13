"""
Plataforma de Análisis de Google Ads — v1 + v2.

Dos funciones:
  1. Análisis de rendimiento — sube un export de campañas (CSV/Excel) y
     obtén gráficas + recomendaciones de optimización.
  2. Negativización de términos de búsqueda — sube el export de search
     terms, define qué es relevante, y obtén una lista de candidatos a
     negativo lista para revisar antes de subir a Google Ads.

Correr localmente con:
    pip install -r requirements.txt
    streamlit run app.py
"""

import streamlit as st
import pandas as pd
import plotly.express as px

from analysis import load_report, compute_metrics, generate_recommendations, summarize
from negative_keywords import load_search_terms, classify_terms, summarize_classification
from copy_generator import (
    fetch_page, extract_signals, generate_headlines, generate_descriptions,
    HEADLINE_LIMIT, DESCRIPTION_LIMIT,
)

st.set_page_config(page_title="Google Ads — Plataforma de análisis", layout="wide")

st.sidebar.title("Google Ads — Plataforma")
page = st.sidebar.radio(
    "Función",
    ["Análisis de rendimiento", "Negativización de términos", "Generador de copys (URL)"],
)

# ===========================================================================
# PÁGINA 1 — Análisis de rendimiento (v1)
# ===========================================================================
if page == "Análisis de rendimiento":
    st.title("Análisis de rendimiento — Google Ads")
    st.caption(
        "Sube un export de campañas (CSV/Excel) y obtén gráficas y "
        "recomendaciones de optimización."
    )

    brand_keywords_input = st.text_input(
        "Palabras que identifican una campaña de Search como de marca (separadas por coma)",
        value="marca, brand, branded, brnd",
        help=(
            "El CTR saludable de Search de marca es mucho más alto que el de Search "
            "genérica (quien busca el nombre de la marca casi siempre hace clic). "
            "Ajusta esta lista si tu convención de nombres es distinta, ej. incluir "
            "el nombre del hotel/cliente."
        ),
    )
    brand_keywords = [k.strip() for k in brand_keywords_input.split(",") if k.strip()]

    uploaded_file = st.file_uploader(
        "Sube el export de campañas de Google Ads (CSV o Excel)",
        type=["csv", "xlsx", "xls"],
        key="campaign_file",
    )

    if uploaded_file is None:
        st.info("Esperando un archivo. Puedes usar sample_data.csv de esta carpeta para probar.")
        st.stop()

    is_excel = uploaded_file.name.lower().endswith((".xlsx", ".xls"))

    try:
        df = load_report(uploaded_file, is_excel=is_excel, brand_keywords=brand_keywords)
    except Exception as e:
        st.error(f"No se pudo leer el archivo: {e}")
        st.stop()

    df = compute_metrics(df)
    resumen = summarize(df)
    recomendaciones = generate_recommendations(df)

    st.header("Resumen ejecutivo")
    col1, col2, col3, col4, col5 = st.columns(5)
    col1.metric("Gasto total", f"${resumen['total_cost']:,.2f}")
    col2.metric("Conversiones", f"{resumen['total_conversions']:.0f}")
    col3.metric(
        "CPA promedio (ponderado por gasto)",
        f"${resumen['avg_cpa_weighted']:.2f}" if resumen["avg_cpa_weighted"] else "N/D",
        help="Gasto total / conversiones totales. Pondera las campañas grandes más que las chicas.",
    )
    col4.metric(
        "CPA promedio (simple entre campañas)",
        f"${resumen['avg_cpa_simple']:.2f}" if resumen["avg_cpa_simple"] else "N/D",
        help="Promedio del CPA de cada campaña, sin ponderar por gasto. Es el que usa la alerta de \"CPA alto\".",
    )
    col5.metric("Campañas con gasto", resumen["campanas_con_gasto"])

    st.header("Rendimiento por campaña")
    tab1, tab2, tab3, tab4 = st.tabs(["Gasto", "CPA", "CTR", "Impression share perdido"])

    with tab1:
        fig = px.bar(
            df.sort_values("cost", ascending=False),
            x="campaign", y="cost", title="Gasto por campaña",
            labels={"campaign": "Campaña", "cost": "Gasto ($)"},
        )
        st.plotly_chart(fig, use_container_width=True)

    with tab2:
        df_cpa = df.dropna(subset=["cpa"]).sort_values("cpa", ascending=False)
        fig = px.bar(
            df_cpa, x="campaign", y="cpa", title="CPA por campaña",
            labels={"campaign": "Campaña", "cpa": "CPA ($)"},
        )
        if resumen["avg_cpa_simple"]:
            fig.add_hline(
                y=resumen["avg_cpa_simple"], line_dash="dash", line_color="red",
                annotation_text="Promedio simple (usado en la alerta de CPA alto)",
            )
        st.plotly_chart(fig, use_container_width=True)

    with tab3:
        fig = px.bar(
            df.sort_values("ctr", ascending=False),
            x="campaign", y="ctr", title="CTR por campaña",
            labels={"campaign": "Campaña", "ctr": "CTR"},
        )
        fig.update_yaxes(tickformat=".1%")
        st.plotly_chart(fig, use_container_width=True)

    with tab4:
        is_cols = df[["campaign", "lost_is_budget", "lost_is_rank"]].melt(
            id_vars="campaign", var_name="tipo", value_name="valor"
        )
        is_cols["tipo"] = is_cols["tipo"].map({
            "lost_is_budget": "Perdido por presupuesto",
            "lost_is_rank": "Perdido por ranking",
        })
        fig = px.bar(
            is_cols, x="campaign", y="valor", color="tipo", barmode="group",
            title="Impression share perdido por campaña",
            labels={"campaign": "Campaña", "valor": "% perdido"},
        )
        fig.update_yaxes(tickformat=".0%")
        st.plotly_chart(fig, use_container_width=True)

    st.header("Recomendaciones de optimización")
    if not recomendaciones:
        st.success("No se detectaron banderas con los umbrales actuales. La cuenta luce estable.")
    else:
        for r in recomendaciones:
            with st.container(border=True):
                st.markdown(f"**{r['campaign']}** — _{r['categoria']}_  ·  {r['impacto_gasto']*100:.0f}% del gasto total")
                st.write(r["hallazgo"])
                st.write(f"➜ {r['recomendacion']}")

    st.divider()
    st.caption(
        "Los umbrales de este análisis son heurísticos y ajustables en analysis.py "
        "— no reemplazan el criterio del estratega de cuenta. El CTR mínimo se "
        "segmenta por tipo de campaña: Search marca 20%, Search genérica 8%, "
        "Display 1%, Performance Max 3%. Una campaña de Search se considera de "
        "marca si su nombre contiene alguna de las palabras clave definidas arriba; "
        "sin match, o sin la columna \"Campaign type\", se trata como Search genérica."
    )

# ===========================================================================
# PÁGINA 2 — Negativización de términos de búsqueda (v2)
# ===========================================================================
elif page == "Negativización de términos":
    st.title("Negativización de términos de búsqueda")
    st.caption(
        "Sube el export de \"Términos de búsqueda\" de Google Ads, define qué "
        "es relevante y obtén una lista de candidatos a negativo lista para "
        "revisar antes de subirla a Google Ads. Ningún término se publica "
        "automáticamente — esta plataforma solo prepara la lista."
    )

    col_a, col_b = st.columns(2)
    with col_a:
        core_input = st.text_area(
            "Términos núcleo (uno por línea) — lo que define \"relacionado\"",
            placeholder="estelar\nmanzanillo",
            height=100,
        )
    with col_b:
        exceptions_input = st.text_area(
            "Excepciones conocidas (opcional) — coincide con un núcleo pero "
            "se sabe que NO es relevante",
            placeholder="manzanillo del mar",
            height=100,
        )

    terms_file = st.file_uploader(
        "Sube el export de Términos de búsqueda (CSV de Google Ads)",
        type=["csv"],
        key="terms_file",
    )

    if terms_file is None:
        st.info("Esperando el archivo de términos de búsqueda.")
        st.stop()

    core_terms = [t.strip() for t in core_input.splitlines() if t.strip()]
    exceptions = [t.strip() for t in exceptions_input.splitlines() if t.strip()]

    if not core_terms:
        st.warning("Escribe al menos un término núcleo para poder clasificar.")
        st.stop()

    try:
        df_terms = load_search_terms(terms_file)
    except Exception as e:
        st.error(f"No se pudo leer el archivo: {e}")
        st.stop()

    df_class = classify_terms(df_terms, core_terms=core_terms, exceptions=exceptions)
    resumen_class = summarize_classification(df_class)

    st.header("Resumen de la clasificación")
    col1, col2, col3 = st.columns(3)
    col1.metric("Mantener", int(resumen_class.loc["mantener", "terminos"]))
    col2.metric("Revisar (ambiguos)", int(resumen_class.loc["revisar", "terminos"]))
    col3.metric("Candidatos a negativo", int(resumen_class.loc["negativizar", "terminos"]))

    fig = px.bar(
        resumen_class.reset_index(), x="clasificacion", y="costo",
        title="Gasto por categoría",
        labels={"clasificacion": "Categoría", "costo": "Gasto ($)"},
        color="clasificacion",
    )
    st.plotly_chart(fig, use_container_width=True)

    st.header("Candidatos a negativo")
    st.dataframe(
        df_class[df_class.clasificacion == "negativizar"]
        .sort_values("cost", ascending=False)[["term", "clicks", "impr", "cost"]],
        use_container_width=True,
    )
    st.download_button(
        "Descargar lista de negativos (CSV)",
        df_class[df_class.clasificacion == "negativizar"]["term"].to_csv(index=False),
        file_name="negativos_candidatos.csv",
    )

    st.header("Revisar antes de decidir")
    st.caption("Contienen un término núcleo pero también una excepción conocida — no se clasifican solos.")
    st.dataframe(
        df_class[df_class.clasificacion == "revisar"]
        .sort_values("cost", ascending=False)[["term", "clicks", "impr", "cost"]],
        use_container_width=True,
    )

    st.divider()
    st.caption(
        "El mecanismo compara texto contra los términos núcleo y las excepciones "
        "que tú definas — no usa un modelo de lenguaje por término (evita costo y "
        "latencia en cuentas grandes). Solo detecta la ambigüedad que anticipes "
        "como excepción; por eso nunca se debe subir \"candidatos a negativo\" a "
        "Google Ads sin que alguien los revise primero."
    )

# ===========================================================================
# PÁGINA 3 — Generador de copys desde URL (Función 3)
# ===========================================================================
else:
    st.title("Generador de copys de Google Ads desde una URL")
    st.caption(
        "Pega la URL de una página y obtén 15 títulos (≤30 caracteres) y 10 "
        "descripciones (≤90 caracteres) para un anuncio de búsqueda responsivo "
        "(RSA), orientados a conversión. No usa un modelo de lenguaje: extrae "
        "señales reales de la página (título, encabezados, CTAs, ofertas) y las "
        "combina con plantillas de copywriting — cada texto se valida contra el "
        "límite de caracteres antes de mostrarse."
    )

    url_input = st.text_input("URL de la página", placeholder="https://www.tusitio.com/producto")
    analizar = st.button("Analizar página")

    if analizar and url_input.strip():
        with st.spinner("Descargando y analizando la página..."):
            try:
                html, resolved_url = fetch_page(url_input.strip())
                signals = extract_signals(html, resolved_url)
                headlines = generate_headlines(signals, n=15)
                descriptions = generate_descriptions(signals, n=10)
            except Exception as e:
                st.error(f"No se pudo analizar la URL: {e}")
                st.stop()

        st.success(f"Página analizada: {resolved_url}")

        with st.expander("Señales detectadas en la página"):
            st.write(f"**Marca detectada:** {signals['brand']}")
            st.write(f"**Frase clave detectada:** {signals['keyword']}")
            st.write(f"**Ofertas encontradas:** {', '.join(signals['offers'])}")

        col1, col2 = st.columns(2)

        with col1:
            st.subheader(f"15 títulos (máx. {HEADLINE_LIMIT} caracteres)")
            df_h = pd.DataFrame({
                "Título": headlines,
                "Caracteres": [len(h) for h in headlines],
            })
            st.dataframe(df_h, use_container_width=True, hide_index=True)
            st.download_button(
                "Descargar títulos (CSV)",
                df_h["Título"].to_csv(index=False),
                file_name="titulos_rsa.csv",
            )

        with col2:
            st.subheader(f"10 descripciones (máx. {DESCRIPTION_LIMIT} caracteres)")
            df_d = pd.DataFrame({
                "Descripción": descriptions,
                "Caracteres": [len(d) for d in descriptions],
            })
            st.dataframe(df_d, use_container_width=True, hide_index=True)
            st.download_button(
                "Descargar descripciones (CSV)",
                df_d["Descripción"].to_csv(index=False),
                file_name="descripciones_rsa.csv",
            )

    st.divider()
    st.caption(
        "Limitación honesta: esto no \"entiende\" la página como lo haría un modelo "
        "de lenguaje — extrae texto real y lo combina con plantillas de "
        "conversión. Si la página tiene poco texto o carga su contenido por "
        "JavaScript, el resultado se apoya más en plantillas genéricas. Revisa "
        "siempre el copy antes de publicarlo — Google Ads además tiene políticas "
        "propias sobre mayúsculas, superlativos y símbolos que esta plataforma no valida."
    )
