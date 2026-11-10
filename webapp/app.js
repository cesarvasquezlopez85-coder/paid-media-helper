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
    chartTab: 'gasto', campaignFilter: 'all',
    source: 'file', // 'file' | 'api'
    api: {
      statusChecked: false, configured: false,
      accountsStatus: 'idle', accounts: [], accountId: '', accountIdManual: '',
      dateFrom: '', dateTo: '', onlyActive: false,
      simulated: false, error: null,
      // Filtrar el selector de cuenta por sub-MCC (ej. una marca de hotel
      // con decenas de cuentas) en vez de buscar en el listado plano —
      // mismo patrón que ROAS. Solo admins.
      mcc: {
        status: 'idle', groups: [], filter: '',
        selectedId: '', selectedName: '', accountIdsStatus: 'idle', accountIds: null, error: null,
      },
    },
    // Prueba interna: lectura priorizada de los hallazgos vía Claude AI —
    // solo visible para administradores mientras se valida el flujo.
    ai: { status: 'idle', narrativa: null, error: null },
  },

  neg: {
    tab: 'reglas', // 'reglas' | 'ia' (la pestaña "Con IA" solo la ve el super admin)
    ai: negAiFresh(),
    core: '',
    exceptions: '',
    status: 'idle', error: null, fileName: null, rows: null,
    sortBy: 'cost', sortDir: 'desc',
    campaignFilter: 'all', // por campaign_id — solo aplica con source==='api'
    source: 'file', // 'file' | 'api'
    api: {
      statusChecked: false, configured: false,
      accountsStatus: 'idle', accounts: [], accountId: '', accountIdManual: '',
      dateFrom: '', dateTo: '', period: '30', // '30' | '60' | '90' | 'custom'
      simulated: false, error: null,
      allCampaigns: [], // {id, name} de TODAS las campañas activas de la cuenta — no solo las que tienen search terms
      mcc: {
        status: 'idle', groups: [], filter: '',
        selectedId: '', selectedName: '', accountIdsStatus: 'idle', accountIds: null, error: null,
      },
    },
    // Subida de negativos a Google Ads (solo con source === 'api', necesita
    // campaign_id por término). selected: Set de claves "term::campaign_id".
    push: {
      selected: new Set(),
      status: 'idle', // idle | previewing | preview_ready | pushing | done | error
      preview: null, result: null, error: null,
    },
  },

  copy: {
    url: '', status: 'idle', error: null,
    signals: null, headlines: null, descriptions: null,
    showFallback: false, htmlPaste: '',
    // Generación con IA: formato elegido, resultado por grupos y opciones.
    ai: { status: 'idle', format: null, result: null, error: null, lang: 'es', keywords: '' },
  },

  book: {
    status: 'idle', error: null, fileName: null, rows: null, dateOrder: null,
    marketFilter: 'all', hotelFilter: 'all',
    mode: 'single',
    compare: {
      current: { status: 'idle', error: null, fileName: null, rows: null },
      previous: { status: 'idle', error: null, fileName: null, rows: null },
      marketFilter: 'all', hotelFilter: 'all',
    },
  },

  compare: {
    current: { status: 'idle', error: null, fileName: null, rows: null },
    previous: { status: 'idle', error: null, fileName: null, rows: null },
    campaignFilter: 'all',
    campaignTypeFilter: 'all',
    hotelFilter: 'all',
    hotelBy: 'cuenta', // cómo se agrupa el resumen por hotel: 'cuenta' (varias cuentas) o 'nombre' (prefijo del nombre de campaña)
    brandKeywords: 'marca, brand, branded, brnd',
    source: 'file', // 'file' | 'api'
    api: {
      statusChecked: false, configured: false,
      accountsStatus: 'idle', accounts: [], accountId: '', accountIdManual: '',
      current: { dateFrom: '', dateTo: '' },
      previous: { dateFrom: '', dateTo: '' },
      onlyActive: false,
      currency: '', // moneda de las cuentas traídas (EUR, COP…); los importes la muestran en vez de "$"
      accountIds: [], accountSearch: '', // varias cuentas (hoteles) para un total combinado
      partial: [], combinedNote: null,   // cuentas que fallaron y descripción del total mostrado
      simulated: false, error: null,
      mcc: {
        status: 'idle', groups: [], filter: '',
        selectedId: '', selectedName: '', accountIdsStatus: 'idle', accountIds: null, error: null,
      },
    },
  },

  opportunity: {
    brandKeywords: 'marca, brand, branded, brnd',
    status: 'idle', error: null, fileName: null,
    rows: null, campaignFilter: 'all', typeFilter: [], excludeBrand: false, hotelFilter: 'all',
    sortBy: 'revenue_lost', sortDir: 'desc',
    source: 'file', // 'file' | 'api'
    api: {
      statusChecked: false, configured: false,
      accountsStatus: 'idle', accounts: [], accountId: '', accountIdManual: '',
      accountIds: [], accountSearch: '', partial: [],
      dateFrom: '', dateTo: '', onlyActive: false,
      simulated: false, error: null,
      mcc: {
        status: 'idle', groups: [], filter: '',
        selectedId: '', selectedName: '', accountIdsStatus: 'idle', accountIds: null, error: null,
      },
    },
    // Serie diaria de Impression Share para el gráfico de tendencia — solo
    // existe en modo API (necesita granularidad por día, que un CSV no trae).
    isTrend: { status: 'idle', rows: null, error: null },
  },

  forecast: {
    status: 'idle', error: null, fileName: null,
    rows: null, hotelFilter: 'all', monthsAhead: 6,
    investmentRows: null, investmentFileName: null, investmentError: null,
    growthGoalPct: '',
    // Meses reales que el usuario excluye del ajuste (evento puntual), y
    // qué ventana de meses usa el ROAS combinado ('recent' | 'all').
    excludedPeriods: [], roasWindow: 'recent',
    // Qué desplegables están abiertos (se conservan al volver a pintar).
    open: { options: false, calc: false },
  },

  // Sección ROAS — solo existe conectada a Google Ads (el ROAS objetivo de
  // la estrategia de puja no viene en ningún CSV, y ajustarlo necesita
  // escribir a la cuenta real), así que no hay modo "Subir archivo" acá.
  audit: {
    status: 'idle', error: null, report: null, reportAccountName: '',
    history: { status: 'idle', rows: null, error: null, customerId: '' },
    api: {
      statusChecked: false, configured: false,
      accountsStatus: 'idle', accounts: [], accountId: '', accountIdManual: '',
      days: 30, simulated: false, error: null,
      mcc: { status: 'idle', groups: [], filter: '', selectedId: '', selectedName: '', accountIdsStatus: 'idle', accountIds: null, error: null },
    },
    // Cuestionario del hotel — ver auditoria_reglas_propuesta.md, sección 1.
    ctx: {
      hotel_name: '', brand_terms: '', brand_campaign_words: 'marca, brand, branded, brnd',
      goal: 'roas', target: '', hotel_feed: 'nose',
    },
    ai: { status: 'idle', narrativa: null, error: null },
  },
  roas: {
    status: 'idle', error: null, rows: null,
    api: {
      statusChecked: false, configured: false,
      accountsStatus: 'idle', accounts: [], accountId: '', accountIdManual: '',
      dateFrom: '', dateTo: '', onlyActive: false,
      simulated: false, error: null,
      // Filtrar el selector de cuenta por sub-MCC (ej. una marca de hotel
      // con decenas de cuentas) en vez de buscar en el listado plano —
      // mismo "Agregar un MCC completo" de Ritmo de consumo, pero acá solo
      // angosta el <select> en vez de agregar a una watchlist. Solo admins.
      mcc: {
        status: 'idle', groups: [], filter: '',
        selectedId: '', selectedName: '', accountIdsStatus: 'idle', accountIds: null, error: null,
      },
    },
    // Ajuste de ROAS objetivo — un solo campaign_id "en edición" a la vez.
    // Nunca hay un solo clic entre decidir el nuevo valor y escribirlo en
    // la cuenta real: siempre pasa por vista previa (validateOnly) antes de
    // que el botón de confirmar quede disponible — mismo patrón que
    // Negativización, aunque acá la vista previa de Google es menos
    // confiable (ver nota en google_ads_client.py sobre ROAS_ADJUSTABLE_STRATEGIES),
    // así que el filtro real de seguridad es el chequeo de estrategia
    // compatible antes de construir la operación, no la vista previa en sí.
    adjust: {
      campaignId: null, newTargetRoas: '',
      status: 'idle', // idle | previewing | preview_ready | applying | done | error
      preview: null, result: null, error: null,
    },
  },

  // Recomendaciones propias de Google Ads (RecommendationService) — el
  // motor de reglas/ML del propio Google, no un modelo de lenguaje (eso es
  // el "Ask Advisor" nuevo de Google, que no tiene API pública — ver
  // Resumen_Proyecto.md). Sin toggle de archivo (no existe en ningún CSV),
  // mismo patrón que ROAS pero sin rango de fechas — las recomendaciones
  // de Google no son por periodo.
  recs: {
    status: 'idle', error: null, rows: null, score: null,
    campaignFilter: 'all', // 'all' | '__account__' (recomendaciones sin campaña) | nombre de campaña
    api: {
      statusChecked: false, configured: false,
      accountsStatus: 'idle', accounts: [], accountId: '', accountIdManual: '',
      simulated: false, error: null,
      // Filtrar el selector de cuenta por sub-MCC (ej. una marca de hotel
      // con decenas de cuentas) en vez de buscar en el listado plano —
      // mismo patrón que ROAS/Rendimiento. Solo admins.
      mcc: {
        status: 'idle', groups: [], filter: '',
        selectedId: '', selectedName: '', accountIdsStatus: 'idle', accountIds: null, error: null,
      },
    },
    // Aplicar/descartar no tienen vista previa de Google (a diferencia de
    // negativos y ROAS) — cada clic ejecuta de inmediato, por eso la
    // confirmación es del lado del cliente (confirm()) antes de llamar.
    // Un estado por resource_name, no uno global — se puede aplicar una
    // fila mientras otra sigue esperando.
    actions: {}, // resource_name -> { status: 'idle'|'busy'|'error', error }
  },

  // Hoteles — modificadores de oferta de campañas de hotel (AdGroupBidModifier).
  // Se elige cuenta + rango, se listan las campañas de hotel y se edita una
  // campaña a la vez. Misma regla que ROAS/IA Max: vista previa antes de escribir.
  hotel: {
    api: {
      statusChecked: false, configured: false,
      accountsStatus: 'idle', accounts: [], accountId: '', accountIdManual: '',
      dateFrom: hotelDefaultDates().from, dateTo: hotelDefaultDates().to,
      simulated: false, error: null,
      mcc: {
        status: 'idle', groups: [], filter: '',
        selectedId: '', selectedName: '', accountIdsStatus: 'idle', accountIds: null, error: null,
      },
    },
    list: { status: 'idle', error: null, campaigns: [], currency: '', templateLocked: false, filter: '' },
    detail: {
      status: 'idle', error: null, data: null, campaignId: null,
      edits: {}, // 'tipo|tramo' -> texto escrito por el usuario
      flow: { status: 'idle', preview: null, result: null, error: null }, // idle | previewing | preview_ready | applying | done | error
    },
  },
  // Campañas — todas las campañas de las cuentas de la lista de Ritmo de consumo, con KPIs del rango y
  // pausar/activar desde la misma fila. Solo super admin mientras se afina.
  campanas: {
    watchlistStatus: 'idle', watchlist: [], status: 'idle', error: null, partial: [], rows: [], simulated: false,
    dateFrom: hotelDefaultDates().from, dateTo: hotelDefaultDates().to, loadToken: 0,
    hotelBy: 'cuenta', hotelFilter: 'all', typeFilter: 'all', statusFilter: 'ENABLED', sortBy: 'cost', search: '',
    confirm: null, busy: {}, notice: null,
    loadedFrom: '', loadedTo: '', // rango con el que se trajo la tabla; el detalle de cada campaña usa el mismo
    detail: emptyCampanaDetail(0),
  },
  // Historial de cambios (change_event) de una cuenta de la lista de Ritmo de consumo. Solo super admin mientras se afina.
  cambios: {
    watchlistStatus: 'idle', watchlist: [], accountId: '', days: 30,
    status: 'idle', error: null, rows: [], truncated: false, warnings: {}, simulated: false, currency: '',
    loaded: null, loadToken: 0, filters: emptyCambiosFilters(), limit: 100,
  },
  // IA Max (AI Max for Search) — a diferencia de "Ask Advisor", sí tiene
  // API real (Campaign.ai_max_setting, desde v25). Tres sub-vistas sobre
  // las mismas campañas Search de la cuenta elegida: estado/toggle, qué
  // sirvió AI Max de verdad, y si eso choca con negativos ya reales en la
  // cuenta (Función 9/Negativización). Sin rango de fechas — todo acá es
  // configuración o estado actual, no una métrica de un periodo.
  iamax: {
    tab: 'estado', // 'estado' | 'servido' | 'creado' | 'excluir' | 'cruce'
    status: 'idle', error: null, rows: null,
    api: {
      statusChecked: false, configured: false,
      accountsStatus: 'idle', accounts: [], accountId: '', accountIdManual: '',
      onlyActive: false,
      simulated: false, error: null,
      mcc: {
        status: 'idle', groups: [], filter: '',
        selectedId: '', selectedName: '', accountIdsStatus: 'idle', accountIds: null, error: null,
      },
    },
    // Igual que ROAS: nunca un solo clic entre decidir y escribir — siempre
    // pasa por vista previa (validateOnly) antes de que "Confirmar" quede
    // disponible.
    toggle: {
      campaignId: null,
      status: 'idle', // idle | previewing | preview_ready | applying | done | error
      newEnable: null, preview: null, result: null, error: null,
    },
    served: {
      status: 'idle', error: null, rows: null, negatives: null,
      campaignFilter: 'all',
    },
    // Lo que creó IA Max (solo lectura): recursos automáticos, combinaciones término + página + titular y
    // páginas a las que mandó el tráfico. `sub` = qué tabla se ve; `days` = periodo (7, 14 o 30).
    created: {
      status: 'idle', error: null, data: null, sub: 'assets', campaignFilter: 'all', days: 30,
      sort: { assets: null, combinations: null, pages: null }, // { key, dir } por vista; null = orden de Google (por costo)
      selected: {}, // páginas marcadas en la tabla para excluir: clave campaña|página -> { campaign_id, campaign_name, page }
    },
    // Exclusiones de página (WEBPAGE negativo por campaña): lista actual, lista de trabajo y flujo vista previa -> aplicar.
    urlx: {
      status: 'idle', error: null, rows: null, campaigns: null,
      draft: [], pasteText: '', pasteCampaign: '', pasteNote: null,
      flow: { status: 'idle', preview: null, result: null, error: null, invalid: null }, // idle | previewing | preview_ready | applying | done | error
      remove: { pending: null, status: 'idle', error: null },
    },
  },

  // Exclusiones de contenido a nivel de cuenta (CustomerNegativeCriterion) —
  // categorías de contenido no apto y de apps, excluidas de TODA la cuenta
  // de una vez. Es la única palanca que existe para Performance Max (no
  // tiene exclusión por campaña); por eso pesa más para PMax/Demand Gen/
  // Display/Video y casi no toca Search. A pedido explícito de cesar
  // (2026-09-23).
  contentExclusions: {
    status: 'idle', error: null,
    contentLabels: null, appCategories: null, appCategoriesCatalog: null,
    api: {
      statusChecked: false, configured: false,
      accountsStatus: 'idle', accounts: [], accountId: '', accountIdManual: '',
      simulated: false, error: null,
      mcc: {
        status: 'idle', groups: [], filter: '',
        selectedId: '', selectedName: '', accountIdsStatus: 'idle', accountIds: null, error: null,
      },
    },
    // Igual que Negativización: selección múltiple con vista previa
    // (validateOnly) antes de que "Confirmar" quede disponible.
    addLabels: {
      selected: new Set(), // content_label_type
      status: 'idle', error: null, preview: null, result: null,
    },
    addApp: {
      filter: '',
      selected: new Set(), // category_resource_name — selección múltiple, igual que addLabels
      status: 'idle', error: null, preview: null, result: null,
    },
    // Estado de "quitar" por fila — mismo patrón que el toggle de IA Max:
    // un solo resource_name editándose a la vez, nunca un clic directo a
    // escribir sin pasar por vista previa.
    remove: {
      resourceName: null,
      status: 'idle', error: null, preview: null, result: null,
    },
  },

  // Planificador de palabras clave — Ideas, Histórico, y Pronóstico
  // (KeywordPlanIdeaService). Todo de solo lectura, nada escribe en la
  // cuenta — no hay vista previa/confirmar acá, a diferencia de ROAS/
  // Negativización/IA Max/Exclusiones de contenido. Performance Planner (la
  // curva de presupuesto vs. conversiones de campañas YA activas) no tiene
  // API pública — esto es lo más cercano que sí existe.
  keywordPlanner: {
    tab: 'ideas', // 'ideas' | 'historico' | 'pronostico'
    api: {
      statusChecked: false, configured: false,
      accountsStatus: 'idle', accounts: [], accountId: '', accountIdManual: '',
      simulated: false, error: null,
      mcc: {
        status: 'idle', groups: [], filter: '',
        selectedId: '', selectedName: '', accountIdsStatus: 'idle', accountIds: null, error: null,
      },
    },
    // Geo e idioma se comparten entre las 3 pestañas — se buscan por nombre
    // (SuggestGeoTargetConstants) en vez de escribir IDs a mano.
    geo: {
      query: '', status: 'idle', results: [], selected: [], error: null,
    },
    languages: {
      status: 'idle', list: [], selectedResourceName: '', error: null,
    },
    network: 'GOOGLE_SEARCH_AND_PARTNERS', // GOOGLE_SEARCH | GOOGLE_SEARCH_AND_PARTNERS
    ideas: {
      seedKeywords: '', seedUrl: '',
      status: 'idle', error: null, rows: null, totalSize: 0,
      sortBy: 'avg_monthly_searches', sortDir: 'desc',
    },
    historico: {
      keywordsText: '',
      status: 'idle', error: null, rows: null,
      sortBy: 'avg_monthly_searches', sortDir: 'desc',
      modalKeyword: null, // texto de la keyword cuyo detalle está abierto, o null
    },
    // No optimiza nada solo — el usuario elige presupuesto/puja y esto
    // estima el resultado de ESA combinación puntual (sin curva automática).
    pronostico: {
      keywordsText: '', matchType: 'BROAD', biddingMode: 'MAXIMIZE_CONVERSIONS',
      dailyBudget: '', maxCpcBid: '', dailyTargetSpend: '', maxCpcBidCeiling: '',
      startDate: '', endDate: '', currencyCode: '',
      status: 'idle', error: null, result: null,
    },
  },

  // Ritmo de consumo — a diferencia del resto de las secciones, no trabaja
  // sobre UNA cuenta elegida sino sobre una lista de cuentas que cada
  // usuario arma a mano ("watchlist", ver user_pacing_watchlist en
  // server.py), independiente de a cuántas cuentas tenga acceso en total.
  pacing: {
    statusChecked: false, configured: false,
    accountsStatus: 'idle', accounts: [], accountToAdd: '', accountsError: null,
    watchlistStatus: 'idle', watchlist: null, // [{customer_id, account_name}]
    rowsStatus: 'idle', rows: null, error: null, simulated: false,
    sortBy: 'account_name', sortDir: 'asc',
    hotelFilter: [], // customer_id de los hoteles marcados en el selector de la tabla; [] = todos
    hotelMenuOpen: false,
    // Periodo consultado (AAAA-MM, desde/hasta); '' = mes en curso. Un periodo ya
    // cerrado se compara contra el objetivo completo en vez de contra un ritmo
    // esperado a la fecha; con varios meses se suman objetivos y gastos.
    monthFrom: '', monthTo: '',
    // Agregar un sub-MCC completo de un jalón (solo admins) — ver
    // list_mcc_groups/list_mcc_group_accounts en google_ads_client.py.
    mcc: {
      status: 'idle', groups: [], filter: '', error: null,
      addStatus: 'idle', addError: null, addResult: null, // addResult: {found, added}
    },
    // Ventana flotante con las campañas activas de una cuenta vigilada
    // (KPIs del mes en curso + presupuesto diario, ajustable) — se abre al
    // hacer click en el nombre de la cuenta en la tabla.
    campaignsModal: {
      customerId: null, accountName: null, highlightId: null, // highlightId: campaña a resaltar (viene del detalle de Campañas)
      status: 'idle', rows: null, error: null, simulated: false,
      adjust: {
        budgetResourceName: null, newBudget: '',
        status: 'idle', preview: null, result: null, error: null,
      },
      // IDs de campaña cuyo ROAS objetivo ya se mostró al hacer click en
      // la estrategia de puja — se arma al vuelo, nada que traer del
      // servidor (target_roas ya viene en la fila).
      revealedRoasIds: new Set(),
    },
  },

  // Solo visible/usable para usuarios con is_admin=1 (el servidor también
  // lo exige en cada endpoint /api/admin/*, esto es solo la UI).
  admin: {
    usage: { status: 'idle', days: 30, rows: [], meta: null, error: null }, // consumo de la IA por usuario y día
    usersStatus: 'idle', users: [], usersError: null,
    accessStatus: 'idle', access: [], mccAccess: [], accessError: null,
    deleteStatus: 'idle', deleteError: null,
    revokeStatus: 'idle', revokeError: null,
    setAdminStatus: 'idle', setAdminError: null,
    grant: {
      userId: '', customerId: '', accountName: '',
      accountsStatus: 'idle', accounts: [], accountsError: null, accountFilter: '',
      status: 'idle', error: null, // idle | granting | error
    },
    // Acceso por MCC: el usuario queda ligado a un sub-MCC completo (todas
    // sus cuentas, también las futuras) en vez de una fila por cuenta.
    mccGrant: {
      userId: '', groupsStatus: 'idle', groups: [], groupsError: null, filter: '',
      pickedId: '', pickedName: '', countStatus: 'idle', count: null, countError: null,
      status: 'idle', error: null, // idle | granting | error
    },
    // Contraseña temporal recién generada — se muestra UNA sola vez (nunca
    // vuelve a quedar accesible, ni siquiera para el admin que la generó).
    resetPassword: { status: 'idle', error: null, result: null }, // result: { username, temp_password }
  },
};

// Se activa cuando /api/me (o la respuesta de login) trae
// must_change_password=true — bloquea el resto de la app hasta que la
// persona defina una contraseña propia. Ver renderForcePasswordChangePanel.
let forcePasswordChange = false;
const pwChangeState = { status: 'idle', error: null }; // idle | saving | error

// Se completa con la respuesta de /api/me al cargar la página — controla
// si se muestra el botón "Administración" del sidebar.
const currentUser = { username: null, isAdmin: false, isSuperAdmin: false };

// Diseño de la interfaz: desde el 2026-11-01 todos los usuarios ven el rediseño Roiback (hoja de estilos
// styles-roiback.css más los colores que este archivo escribe a mano). El diseño anterior ("current",
// styles.css) ya no se ofrece, pero themed() y las constantes AUDIT_*_THEMES conservan sus dos valores
// por si hay que volver atrás con un solo cambio.
const APP_THEME = 'roiback';
function themed(current, roiback) { return APP_THEME === 'roiback' ? roiback : current; }
function themedFontsLink(legacyHref) {
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="${themed(legacyHref, 'https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Lato:wght@400;700&display=swap')}" rel="stylesheet">`;
}
const PLUS_JAKARTA_HREF = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;700;800&display=swap';

const PAGE_META = {
  cambios: {
    title: 'Historial de cambios',
    caption: 'Quién cambió qué en una cuenta de Google Ads en los últimos 30 días: presupuestos, pujas, estados, negativas y anuncios, con filtros y descarga en CSV y HTML.',
  },
  campanas: {
    title: 'Campañas',
    caption: 'Todas las campañas de las cuentas de tu lista de Ritmo de consumo, con sus KPIs; pausa o activa cada una desde aquí y filtra por hotel y tipo de campaña.',
  },
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
    caption: 'Pega la URL de una página y obtén borradores de copys con IA para Search, Performance Max, Demand Gen, YouTube y Meta, o la versión con plantillas para un anuncio de búsqueda responsivo.',
  },
  bookings: {
    title: 'Bookings',
    caption: 'Sube el export de reservas reales (Excel/CSV) y obtén reservas por mercado, días de antelación entre la reserva y la estadía, y un heatmap de reservas por mes de llegada y mercado.',
  },
  comparativa: {
    title: 'Comparar periodos',
    caption: 'Sube el export de campañas de dos periodos distintos y obtén qué campañas mejoraron o empeoraron, con recomendaciones basadas en la tendencia.',
  },
  oportunidad: {
    title: 'Oportunidad de ingresos',
    caption: 'Sube un export de campañas y estima cuántos ingresos adicionales se habrían generado en las campañas limitadas por presupuesto si no lo hubieran estado — análisis retrospectivo, no una predicción.',
  },
  proyeccion: {
    title: 'Proyección de ventas',
    caption: 'Sube las ventas mensuales del hotel y te decimos cuánto esperamos vender los próximos meses y qué tan confiable es esa cifra.',
  },
  auditoria: {
    title: 'Auditoría de cuenta',
    caption: 'Revisa la configuración de una cuenta de hotel — conversiones, redes, estructura, palabras clave y activos — y descarga un informe con los hallazgos priorizados.',
  },
  roas: {
    title: 'ROAS',
    caption: 'Compara el ROAS logrado contra el ROAS objetivo configurado en la estrategia de puja de cada campaña, y ajústalo directo desde acá cuando la estrategia lo permita.',
  },
  recomendaciones: {
    title: 'Recomendaciones de Google',
    caption: 'El puntaje de optimización y las recomendaciones que Google Ads ya generó para la cuenta — revísalas, y aplícalas o descártalas directo desde acá.',
  },
  hoteles: {
    title: 'Hoteles',
    caption: 'Modificadores de oferta de las campañas de hotel: ventana de reserva, duración de la estancia, día de entrada y fechas elegidas. Ve cómo rinde cada tramo y ajústalos campaña por campaña.',
  },
  iamax: {
    title: 'IA Max',
    caption: 'Estado de AI Max en campañas Search, qué está sirviendo de verdad, y si choca con negativos ya escritos en la cuenta.',
  },
  exclusiones: {
    title: 'Exclusiones de contenido',
    caption: 'Excluye categorías de contenido no apto y de apps de toda la cuenta de una vez — aplica sobre todo a Performance Max, Demand Gen, Display y Video; casi no toca Search.',
  },
  keywordplanner: {
    title: 'Planificador de palabras clave',
    caption: 'Descubre keywords nuevas, revisa su histórico de búsquedas, y pronostica clics/costo/conversiones para una campaña hipotética antes de pitchearla.',
  },
  pacing: {
    title: 'Ritmo de consumo',
    caption: 'Elige qué cuentas vigilar y compara el gasto del mes en curso contra el objetivo mensual configurado en Billing > Presupuestos de cuenta, para detectar si van por arriba o por abajo del ritmo esperado.',
  },
  administracion: {
    title: 'Administración',
    caption: 'Gestiona quién tiene cuenta en la plataforma y a qué cuentas de Google Ads puede acceder cada usuario.',
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

// Código de moneda (p. ej. "EUR") que fmtMoney pone delante del importe en vez de "$". Solo se activa mientras se
// dibuja una página que conoce la moneda de sus datos (hoy, Comparar periodos con Google Ads) y se apaga al terminar.
let moneyCurrencyCode = null;
function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'N/D';
  const num = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return moneyCurrencyCode ? `${moneyCurrencyCode}\u00a0${num}` : '$' + num;
}

// Corre `fn` con los importes mostrados en la moneda `code` (o con "$" si no hay), y la restaura al terminar.
function withMoneyCurrency(code, fn) {
  const prev = moneyCurrencyCode;
  moneyCurrencyCode = code || null;
  try { return fn(); } finally { moneyCurrencyCode = prev; }
}
function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}
// n como fracción 0-1 (puede pasar de 1, ej. 1.37 = 137% ya consumido).
function fmtPct0(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'N/D';
  return Math.round(n * 100) + '%';
}
// Fondo tipo mapa de calor para una celda de tabla — más intenso mientras
// más alto el valor (0-1). scale amplifica valores típicamente bajos
// (ej. % perdido) para que el color se note sin tener que llegar a 100%.
function heatCell(value, rgb, scale) {
  if (Number.isNaN(value)) return '';
  const alpha = Math.max(0, Math.min(0.55, value * (scale || 1.4)));
  return `background:rgba(${rgb},${alpha.toFixed(2)});font-weight:600`;
}
function pctWidth(v, max) {
  if (!max || Number.isNaN(v)) return 2;
  return Math.max(2, Math.min(100, (v / max) * 100));
}
function icon(name, size = 18) {
  return `<i data-lucide="${name}" width="${size}" height="${size}"></i>`;
}

// ---------------------------------------------------------------------------
// Gráficas con Chart.js (piloto en Rendimiento, ver mountRendCharts) — el
// resto de la app sigue con las barras CSS (barRowsHtml) hasta decidir si
// se extiende. root.innerHTML se reemplaza entero en cada render(), así que
// cualquier <canvas> y su Chart.js asociado quedan huérfanos — hay que
// destruirlos a mano antes de pisar el DOM y volver a montarlos después.
// ---------------------------------------------------------------------------

const chartRegistry = {};
function destroyAllCharts() {
  Object.keys(chartRegistry).forEach((id) => {
    chartRegistry[id].destroy();
    delete chartRegistry[id];
  });
}
function cssVar(name, depth = 0) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // Algunas variables apuntan a otra variable (ej. --color-border: var(--gray-300))
  // — la mayoría de los navegadores ya la resuelven en getComputedStyle, pero
  // por si acaso, se resuelve un nivel más a mano.
  const nested = depth < 3 && /^var\((--[\w-]+)\)$/.exec(raw);
  return nested ? cssVar(nested[1], depth + 1) : raw;
}
// Traduce los colores var(--foo) que ya usan los builders de barras (CSS) a
// colores reales — el canvas de Chart.js no resuelve custom properties.
function resolveChartColor(raw) {
  const match = /^var\((--[\w-]+)\)$/.exec((raw || '').trim());
  return match ? (cssVar(match[1]) || raw) : raw;
}
// rows: misma forma que ya devuelven buildGastoRows/buildCpaRows/etc.
// ({campaign, value, valueLabel, color}) — un solo builder de config para
// no repetir la configuración de Chart.js en cada gráfica de barras
// horizontal de Rendimiento.
function mountHorizontalBarChart(canvasId, rows) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !window.Chart) return;
  const ctx = canvas.getContext('2d');
  const gridColor = cssVar('--color-border') || '#e5e7eb';
  const textColor = cssVar('--color-text-body') || '#333';
  const datalabelFont = '600 11px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
  // El texto de valueLabel varía mucho de largo entre pestañas ("$630.00" vs
  // "Presup. 22% · Rank 30%") — un padding fijo a la derecha se queda corto
  // con las etiquetas largas o deja demasiado aire con las cortas. Se mide
  // el texto real con el mismo canvas antes de crear la gráfica.
  ctx.font = datalabelFont;
  const maxLabelWidth = rows.reduce((max, r) => Math.max(max, ctx.measureText(r.valueLabel).width), 0);
  const chart = new window.Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.campaign),
      datasets: [{
        data: rows.map((r) => r.value),
        backgroundColor: rows.map((r) => resolveChartColor(r.color)),
        borderRadius: 6,
        borderSkipped: false,
        maxBarThickness: 28,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500, easing: 'easeOutQuart' },
      layout: { padding: { right: Math.ceil(maxLabelWidth) + 20 } },
      scales: {
        x: { display: false, grid: { display: false } },
        y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 12 } } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar('--navy-900') || '#0f172a',
          padding: 10,
          cornerRadius: 8,
          displayColors: false,
          callbacks: { label: (item) => rows[item.dataIndex].valueLabel },
        },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: textColor,
          font: { size: 11, weight: '600', family: getComputedStyle(document.body).fontFamily },
          formatter: (_v, ctx) => rows[ctx.dataIndex].valueLabel,
        },
      },
    },
    plugins: window.ChartDataLabels ? [window.ChartDataLabels] : [],
  });
  chartRegistry[canvasId] = chart;
}

// ---------------------------------------------------------------------------
// Render raíz
// ---------------------------------------------------------------------------

const root = document.getElementById('page-root');

// Pantalla forzada tras un reset de contraseña por un admin — reemplaza el
// resto de la app hasta que la persona defina una contraseña propia.
function renderForcePasswordChangePanel() {
  return `
    <div class="page-header">
      <div>
        <h1 class="page-title">Cambia tu contraseña</h1>
        <p class="page-caption">Un administrador restableció tu contraseña. Antes de continuar, define una nueva que solo tú conozcas.</p>
      </div>
    </div>
    <div class="card control-panel" style="max-width:420px;flex-direction:column;align-items:stretch">
      <div class="field">
        <label>Contraseña temporal (la que te dieron)</label>
        <input type="password" id="pwchange-current" autocomplete="current-password" />
      </div>
      <div class="field">
        <label>Nueva contraseña (mínimo 10 caracteres)</label>
        <input type="password" id="pwchange-new" autocomplete="new-password" minlength="10" />
      </div>
      <div class="field">
        <label>Repite la nueva contraseña</label>
        <input type="password" id="pwchange-confirm" autocomplete="new-password" minlength="10" />
      </div>
      ${pwChangeState.error ? `<div class="error-panel">${escapeHtml(pwChangeState.error)}</div>` : ''}
      <button class="btn-accent" data-action="pwchange-submit" ${pwChangeState.status === 'saving' ? 'disabled' : ''}>
        ${pwChangeState.status === 'saving' ? 'Guardando…' : 'Guardar nueva contraseña'}
      </button>
    </div>`;
}

function submitPasswordChange() {
  const current = document.getElementById('pwchange-current').value;
  const next = document.getElementById('pwchange-new').value;
  const confirmValue = document.getElementById('pwchange-confirm').value;
  if (next.length < 10) {
    pwChangeState.status = 'error'; pwChangeState.error = 'La nueva contraseña debe tener al menos 10 caracteres.';
    render();
    return;
  }
  if (next !== confirmValue) {
    pwChangeState.status = 'error'; pwChangeState.error = 'Las dos contraseñas nuevas no coinciden.';
    render();
    return;
  }
  pwChangeState.status = 'saving'; pwChangeState.error = null;
  render();
  fetch('/api/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: current, new_password: next }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'No se pudo cambiar la contraseña.');
      forcePasswordChange = false;
      pwChangeState.status = 'idle'; pwChangeState.error = null;
      render();
    })
    .catch((err) => {
      pwChangeState.status = 'error'; pwChangeState.error = err.message || String(err);
      render();
    });
}

// Las gráficas de Chart.js dibujan en un canvas y no heredan la tipografía de la página: con el diseño
// nuevo se les da la fuente de la página; con el actual se dejan los valores originales de Chart.js.
function applyChartDefaults() {
  if (typeof Chart === 'undefined' || Chart.__pmhTheme === APP_THEME) return;
  if (!Chart.__pmhOrig) Chart.__pmhOrig = { family: Chart.defaults.font.family, color: Chart.defaults.color };
  if (APP_THEME === 'roiback') {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = cssVar('--color-text-body') || '#10222f';
  } else {
    Chart.defaults.font.family = Chart.__pmhOrig.family;
    Chart.defaults.color = Chart.__pmhOrig.color;
  }
  Chart.__pmhTheme = APP_THEME;
}

function render() {
  applyChartDefaults();
  // Los <canvas> de Chart.js (ver mountHorizontalBarChart) quedan huérfanos
  // en cuanto root.innerHTML se reemplace abajo — hay que destruir las
  // instancias viejas ANTES, si no Chart.js sigue dibujando sobre un canvas
  // que ya no existe en el DOM.
  destroyAllCharts();

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === state.page);
  });

  // root.innerHTML se reemplaza entero en cada render — un input que dispara
  // render() en cada tecla (ej. el buscador de cuentas de Administración)
  // perdería el foco y el cursor a mitad de escritura si no se restaura acá.
  const active = document.activeElement;
  let focusId = null, selStart = null, selEnd = null;
  if (active && root.contains(active) && active.id) {
    focusId = active.id;
    if (typeof active.selectionStart === 'number') {
      selStart = active.selectionStart;
      selEnd = active.selectionEnd;
    }
  }

  if (forcePasswordChange) {
    root.innerHTML = renderForcePasswordChangePanel();
    bindEvents();
    if (window.lucide) window.lucide.createIcons();
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus();
        if (selStart !== null && typeof el.setSelectionRange === 'function') {
          el.setSelectionRange(selStart, selEnd);
        }
      }
    }
    return;
  }

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
  else if (state.page === 'comparativa') pageHtml = renderComparePage();
  else if (state.page === 'oportunidad') pageHtml = renderOpportunityPage();
  else if (state.page === 'proyeccion') pageHtml = renderForecastPage();
  else if (state.page === 'roas') pageHtml = renderRoasPage();
  else if (state.page === 'auditoria') pageHtml = renderAuditPage();
  else if (state.page === 'recomendaciones') pageHtml = renderRecsPage();
  else if (state.page === 'iamax') pageHtml = renderIaMaxPage();
  else if (state.page === 'hoteles') pageHtml = renderHotelPage();
  else if (state.page === 'campanas') pageHtml = renderCampanasPage();
  else if (state.page === 'cambios') pageHtml = renderCambiosPage();
  else if (state.page === 'exclusiones') pageHtml = renderContentExclusionsPage();
  else if (state.page === 'keywordplanner') pageHtml = renderKeywordPlannerPage();
  else if (state.page === 'pacing') pageHtml = renderPacingPage();
  else if (state.page === 'administracion') pageHtml = renderAdminPage();
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
  mountCharts();

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (selStart !== null && typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(selStart, selEnd);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Página 1 — Rendimiento
// ---------------------------------------------------------------------------

function renderRendPage() {
  return withMoneyCurrency(state.rend.source === 'api' ? state.rend.currency : null, () => renderRendPageBody());
}

function renderRendPageBody() {
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
    const filteredRows = getRendFilteredRows();
    const hasCpaFilePct = filteredRows.some((r) => !Number.isNaN(r.cpa_file_pct));
    body += `
      <p class="footnote">
        Los umbrales son heurísticos y ajustables — no reemplazan el criterio del estratega de cuenta.
        CTR mínimo por tipo: Search marca 20%, Search genérica 8%, Display 1%, Performance Max 3%.
        CPA % óptimo por tipo (gasto ÷ valor de conversión, dispara la alerta de "CPA alto" si se supera): Search marca 11%, Performance Max 20%, Demand Gen 30%, Display 30%, Search genérica 30%. Solo se evalúa si el archivo trae "Valor de conv.".
        Sin la columna "Campaign type", o sin match de marca en el nombre, se trata como Search genérica.
        ${hasCpaFilePct ? ' La columna "CPA %" de la tabla es la columna "CPA" tal cual viene en tu export — una métrica distinta a la tarjeta "CPA %" de arriba (esa es gasto ÷ valor de conv.).' : ''}
      </p>`;
  }

  let campaignFilterHtml = '';
  if (s.status === 'ready' && s.rows && s.rows.length) {
    const campaigns = [...new Set(s.rows.map((r) => r.campaign))].sort((a, b) => a.localeCompare(b));
    const options = ['<option value="all">Todas las campañas</option>']
      .concat(campaigns.map((c) => `<option value="${escapeHtml(c)}" ${s.campaignFilter === c ? 'selected' : ''}>${escapeHtml(c)}</option>`))
      .join('');
    campaignFilterHtml = `
      <div class="field">
        <label>Ver solo esta campaña</label>
        <select id="rend-campaign-filter" style="width:320px">${options}</select>
      </div>`;
  }

  // El campo de palabras de marca solo se muestra subiendo archivo — en modo
  // API se usa el valor que ya tenga guardado (por defecto DEFAULT_BRAND_KEYWORDS)
  // sin pedírselo al usuario cada vez, para no ensuciar esa pantalla. La
  // clasificación marca/genérica se sigue aplicando igual en ambos modos.
  const brandKeywordsField = s.source === 'file' ? `
      <div class="field">
        <label>Palabras que identifican una campaña de marca (separadas por coma)</label>
        <input type="text" id="rend-brand-keywords" value="${escapeHtml(s.brandKeywords)}" style="width:320px" />
      </div>` : '';

  return `
    <div class="card control-panel align-end">
      ${brandKeywordsField}
      <div class="seg-control">
        <button class="seg-btn ${s.source === 'file' ? 'active' : ''}" data-action="rend-source-file">Subir archivo</button>
        <button class="seg-btn ${s.source === 'api' ? 'active' : ''}" data-action="rend-source-api">Conectar Google Ads</button>
      </div>
      ${s.source === 'file' ? `
        <div class="field">
          <label>Export de campañas (CSV o Excel)</label>
          <input type="file" id="rend-file" accept=".csv,.xlsx,.xls" />
        </div>
        <button class="btn-outline" data-action="rend-demo">Usar sample_data.csv de ejemplo</button>
        ${s.fileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.fileName)}</strong></div>` : ''}
      ` : renderRendApiPanel()}
      ${campaignFilterHtml}
    </div>
    ${body}
  `;
}

// ---------------------------------------------------------------------------
// Fuente de datos: API de Google Ads (en vez de subir archivo) — V2, en
// construcción. Mientras GOOGLE_ADS_* no esté configurado en el servidor
// (developer token pendiente de aprobación de Google), /api/google-ads/*
// sirve cuentas y campañas simuladas, marcadas como tal, para poder probar
// todo el flujo (cuenta → rango de fechas → tabla) desde ya.
function loadRendMccGroups() {
  const m = state.rend.api.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => { m.status = 'error'; m.error = err.message || String(err); render(); });
}

function applyRendMccFilter(groupId, groupName) {
  const a = state.rend.api;
  const m = a.mcc;
  m.selectedId = groupId; m.selectedName = groupName;
  m.accountIdsStatus = 'loading'; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(groupId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.accountIds = new Set((data.accounts || []).map((acc) => acc.id));
      m.accountIdsStatus = 'ready';
      // Si la cuenta que ya estaba elegida no cuelga de este MCC, se limpia.
      if (a.accountId && !m.accountIds.has(a.accountId)) a.accountId = '';
      render();
    })
    .catch((err) => { m.accountIdsStatus = 'error'; m.error = err.message || String(err); render(); });
}

function clearRendMccFilter() {
  const m = state.rend.api.mcc;
  m.selectedId = ''; m.selectedName = ''; m.accountIds = null; m.accountIdsStatus = 'idle'; m.filter = '';
  render();
}

function renderRendMccFilterPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.rend.api.mcc;

  if (m.selectedId) {
    const countLabel = m.accountIdsStatus === 'loading' ? 'cargando…'
      : m.accountIdsStatus === 'ready' ? `${m.accountIds.size} cuenta(s)`
      : 'error';
    return `
      <div class="field">
        <label>Filtrando por MCC</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="delta-badge neutral">${escapeHtml(m.selectedName)} — ${countLabel}</span>
          <button class="btn-link" data-action="rend-mcc-clear">Quitar filtro</button>
        </div>
      </div>`;
  }

  if (m.status === 'idle') {
    return `<div class="field"><button class="btn-outline sm" data-action="rend-mcc-load">Filtrar por MCC (ej. una cadena de hoteles)</button></div>`;
  }
  if (m.status === 'loading') {
    return `<div class="field"><p class="footnote">Cargando agrupaciones del MCC…</p></div>`;
  }
  if (m.status === 'error') {
    return `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  }

  const filter = (m.filter || '').trim().toLowerCase();
  let matches = [];
  if (filter.length >= 2) {
    matches = m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25);
  }
  const matchesHtml = matches.length
    ? `<div class="table-scroll" style="max-height:200px;margin-top:8px">
        <table><tbody>
          ${matches.map((g) => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
              <td><button class="btn-outline xs" data-rend-mcc-pick="${escapeHtml(g.id)}" data-rend-mcc-pick-name="${escapeHtml(g.name)}">Usar</button></td>
            </tr>`).join('')}
        </tbody></table>
      </div>`
    : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');

  return `
    <div class="field">
      <label>Filtrar por MCC</label>
      <input type="text" id="rend-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:320px" />
      ${matchesHtml}
    </div>`;
}

function renderRendApiPanel() {
  const a = state.rend.api;

  if (!a.statusChecked) {
    return `<div class="field"><p class="footnote">Consultando la conexión con Google Ads…</p></div>`;
  }

  const simulatedNotice = a.simulated ? `
    <div class="ok-panel" style="margin:10px 0">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor
      (falta la aprobación del developer token de Google) — estos son datos de ejemplo, no de una cuenta real.
      El flujo (selector de cuenta, rango de fechas, tabla) es el mismo que va a usar la conexión real.
    </div>` : '';

  if (a.accountsStatus === 'idle') {
    return `
      <div class="field">
        <p class="footnote">${a.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.'}</p>
        <button class="btn-outline" data-action="rend-api-load-accounts">Ver cuentas disponibles</button>
      </div>`;
  }

  if (a.accountsStatus === 'loading') {
    return `<div class="field"><p class="footnote">Cargando cuentas…</p></div>`;
  }

  if (a.accountsStatus === 'error') {
    return `
      <div class="error-panel">
        <strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(a.error)}
      </div>`;
  }

  const mccFilterActive = a.mcc.selectedId && a.mcc.accountIds;
  const visibleAccounts = mccFilterActive ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
  const accountOptions = ['<option value="">Elige una cuenta…</option>']
    .concat(visibleAccounts.map((acc) => `<option value="${escapeHtml(acc.id)}" ${a.accountId === acc.id ? 'selected' : ''}>${escapeHtml(acc.name)} (${escapeHtml(acc.id)})</option>`))
    .join('');

  return `
    ${simulatedNotice}
    ${renderRendMccFilterPanel()}
    <div class="field">
      <label>Cuenta${mccFilterActive ? ` (${visibleAccounts.length} en "${escapeHtml(a.mcc.selectedName)}")` : ''}</label>
      <select id="rend-api-account" style="width:320px">${accountOptions}</select>
    </div>
    <div class="field">
      <label>...o escribe el ID de la cuenta</label>
      <input type="text" id="rend-api-account-manual" value="${escapeHtml(a.accountIdManual)}" placeholder="ej. 6862893390" style="width:160px" />
      <p class="field-hint">Si escribes un ID aquí, se usa este en vez del seleccionado arriba — útil si ya lo tienes copiado y no quieres buscarlo en la lista.</p>
    </div>
    <div style="display:flex;gap:24px;flex-wrap:nowrap">
      <div class="field">
        <label>Desde</label>
        <input type="date" id="rend-api-date-from" value="${escapeHtml(a.dateFrom)}" />
      </div>
      <div class="field">
        <label>Hasta</label>
        <input type="date" id="rend-api-date-to" value="${escapeHtml(a.dateTo)}" />
      </div>
    </div>
    <div class="field">
      <label style="display:flex;align-items:center;gap:8px;font-weight:400">
        <input type="checkbox" id="rend-api-only-active" ${a.onlyActive ? 'checked' : ''} />
        Solo campañas activas
      </label>
    </div>
    <button class="btn-accent" data-action="rend-api-fetch">Traer datos de Google Ads</button>
    ${a.error ? `<div class="error-panel" style="margin-top:10px"><strong>No se pudo traer el reporte.</strong> ${escapeHtml(a.error)}</div>` : ''}
  `;
}

function getRendFilteredRows() {
  const s = state.rend;
  if (!s.rows) return [];
  return s.campaignFilter === 'all' ? s.rows : s.rows.filter((r) => r.campaign === s.campaignFilter);
}

function buildGastoRows(rows) {
  const maxVal = Math.max(1, ...rows.map((r) => r.cost || 0));
  return [...rows].sort((a, b) => (b.cost || 0) - (a.cost || 0)).map((r) => ({
    campaign: r.campaign,
    value: r.cost || 0,
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
      value: r.cpa,
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
      value: r.ctr * 100,
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
    value: r.cpa_file_pct * 100,
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
      value: (budget + rank) * 100,
      valueLabel: `Presup. ${(budget * 100).toFixed(0)}% · Rank ${(rank * 100).toFixed(0)}%`,
      width: pctWidth(budget + rank, maxVal),
      color: 'var(--accent-600)',
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

// Le manda el resumen + hallazgos ya calculados a Claude y muestra una lectura
// priorizada en prosa. Disponible para todos los usuarios con sesión; el servidor
// limita a 10 análisis por hora por usuario (server.py: AI_RATE_LIMIT).
function renderAiAnalysisPanel() {
  const ai = state.rend.ai;

  let inner;
  if (ai.status === 'loading') {
    inner = `<div class="spinner"></div><p class="footnote">Analizando con IA…</p>`;
  } else if (ai.status === 'error') {
    inner = `
      <div class="error-panel"><strong>No se pudo generar el análisis.</strong> ${escapeHtml(ai.error)}</div>
      <button class="btn-outline" data-action="rend-ai-analizar">Reintentar</button>`;
  } else if (ai.status === 'ready') {
    const paragraphs = (ai.narrativa || '').split(/\n+/).filter(Boolean)
      .map((p) => `<p class="ai-narrativa">${escapeHtml(p)}</p>`).join('');
    inner = `${paragraphs}<button class="btn-outline" data-action="rend-ai-analizar">Volver a analizar</button>`;
  } else {
    inner = `
      <button class="btn-outline" data-action="rend-ai-analizar">${icon('sparkles', 16)} Analizar con IA</button>
      <p class="field-hint">Le pide a Claude una lectura priorizada de estos hallazgos. Hasta 10 análisis por hora por persona.</p>`;
  }

  return `
    <div class="card ai-analysis-card">
      <div class="rec-head" style="margin-bottom:8px"><span class="rec-cat">Análisis con IA</span></div>
      ${inner}
    </div>`;
}

function renderRendLayoutA() {
  const s = state.rend;
  const rows = getRendFilteredRows();
  const resumen = engine.summarize(rows);
  const recs = engine.generateRecommendations(rows);

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
  if (hasCpaFilePct) tabDefs.push(['cpa_file', 'CPA %']);
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
        <div class="stat-label">Valor de conversión</div>
        <div class="stat-value">${resumen.total_conv_value != null ? fmtMoney(resumen.total_conv_value) : 'N/D'}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">CPA promedio · simple entre campañas</div>
        <div class="stat-value">${resumen.avg_cpa_simple != null ? fmtMoney(resumen.avg_cpa_simple) : 'N/D'}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">ROAS</div>
        <div class="stat-value">${resumen.roas != null ? (resumen.roas * 100).toFixed(0) + '%' : 'N/D'}</div>
        <div class="stat-sub">Valor de conv. ÷ gasto</div>
      </div>
      <div class="card stat-card accent">
        <div class="stat-label">CPA %</div>
        <div class="stat-value">${resumen.cpa_pct != null ? (resumen.cpa_pct * 100).toFixed(1) + '%' : 'N/D'}</div>
        <div class="stat-sub">Gasto ÷ valor de conv. — usado por la alerta de "CPA alto"</div>
      </div>
    </div>

    <div class="card chart-card">
      <div class="tab-row">${tabs}</div>
      <div style="height:${Math.max(240, activeRows.length * 34)}px"><canvas id="rend-chart-main"></canvas></div>
    </div>

    <div>
      <h2 class="section-title">Recomendaciones de optimización (${recs.length})</h2>
      ${renderAiAnalysisPanel()}
      ${recsHtml}
    </div>
  `;
}

function renderRendLayoutB() {
  const s = state.rend;
  const rows = getRendFilteredRows();
  const resumen = engine.summarize(rows);
  const recs = engine.generateRecommendations(rows);

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
          <div class="dense-row"><span>Valor de conversión</span><strong>${resumen.total_conv_value != null ? fmtMoney(resumen.total_conv_value) : 'N/D'}</strong></div>
          <div class="dense-row"><span>CPA simple</span><strong>${resumen.avg_cpa_simple != null ? fmtMoney(resumen.avg_cpa_simple) : 'N/D'}</strong></div>
          <div class="dense-row"><span>ROAS</span><strong>${resumen.roas != null ? (resumen.roas * 100).toFixed(0) + '%' : 'N/D'}</strong></div>
          <div class="dense-row accent"><span>CPA % (alerta)</span><strong>${resumen.cpa_pct != null ? (resumen.cpa_pct * 100).toFixed(1) + '%' : 'N/D'}</strong></div>
        </div>
        <div class="card dense-recs">
          <h3>Recomendaciones (${recs.length})</h3>
          ${renderAiAnalysisPanel()}
          ${recsHtml}
        </div>
      </div>
      <div class="dense-col-right">
        <div class="card dense-panel">
          <h3 class="dense-chart-title">Gasto por campaña</h3>
          <div style="height:${Math.max(160, gastoRows.length * 24)}px"><canvas id="rend-chart-gasto"></canvas></div>
        </div>
        <div class="card dense-panel">
          <h3 class="dense-chart-title">CPA por campaña</h3>
          <div style="height:${Math.max(160, cpaRows.length * 24)}px"><canvas id="rend-chart-cpa"></canvas></div>
        </div>
        <div class="card dense-panel">
          <h3 class="dense-chart-title">CTR por campaña</h3>
          <div style="height:${Math.max(160, ctrRows.length * 24)}px"><canvas id="rend-chart-ctr"></canvas></div>
        </div>
        <div class="card dense-panel">
          <h3 class="dense-chart-title">Impression share perdido</h3>
          <div style="height:${Math.max(160, isRows.length * 24)}px"><canvas id="rend-chart-is"></canvas></div>
        </div>
        ${hasCpaFilePct ? `
        <div class="card dense-panel">
          <h3 class="dense-chart-title">CPA %</h3>
          <div style="height:${Math.max(160, cpaFilePctRows.length * 24)}px"><canvas id="rend-chart-cpafile"></canvas></div>
        </div>` : ''}
      </div>
    </div>
  `;
}

// Se llama después de que render() reemplaza root.innerHTML y bindEvents() —
// necesita que los <canvas> ya existan en el DOM. Solo Rendimiento por ahora
// (piloto); las demás páginas siguen con las barras CSS (barRowsHtml).
function mountCharts() {
  if (state.page === 'rendimiento') mountRendCharts();
  else if (state.page === 'roas') mountRoasCharts();
  else if (state.page === 'keywordplanner') mountKeywordPlannerCharts();
  else if (state.page === 'campanas') mountCampanaCharts();
}

function mountRendCharts() {
  const s = state.rend;
  if (s.status !== 'ready') return;
  const rows = getRendFilteredRows();
  const resumen = engine.summarize(rows);
  const hasCpaFilePct = rows.some((r) => !Number.isNaN(r.cpa_file_pct));

  if (state.layoutVariant === 'B') {
    mountHorizontalBarChart('rend-chart-gasto', buildGastoRows(rows));
    mountHorizontalBarChart('rend-chart-cpa', buildCpaRows(rows, resumen.avg_cpa_simple));
    mountHorizontalBarChart('rend-chart-ctr', buildCtrRows(rows));
    mountHorizontalBarChart('rend-chart-is', buildIsRows(rows));
    if (hasCpaFilePct) mountHorizontalBarChart('rend-chart-cpafile', buildCpaFilePctRows(rows));
  } else {
    const tabMap = {
      gasto: buildGastoRows(rows),
      cpa: buildCpaRows(rows, resumen.avg_cpa_simple),
      ctr: buildCtrRows(rows),
      is: buildIsRows(rows),
    };
    if (hasCpaFilePct) tabMap.cpa_file = buildCpaFilePctRows(rows);
    const activeRows = tabMap[s.chartTab] || tabMap.gasto;
    mountHorizontalBarChart('rend-chart-main', activeRows);
  }
}

// Piloto de Chart.js extendido a ROAS — a diferencia de Rendimiento (una
// sola serie por gráfica), acá se comparan 2 series por campaña (logrado
// vs. objetivo) en la misma barra agrupada, así que necesita su propia
// función en vez de reusar mountHorizontalBarChart.
function mountRoasCharts() {
  const s = state.roas;
  if (s.status !== 'ready') return;
  const rows = [...(s.rows || [])]
    .filter((r) => r.target_roas != null)
    .sort((a, b) => (b.roas ?? -1) - (a.roas ?? -1));
  if (!rows.length) return;
  mountRoasComparisonChart('roas-chart-main', rows);
}

function mountRoasComparisonChart(canvasId, rows) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !window.Chart) return;
  const ctx = canvas.getContext('2d');
  const gridColor = cssVar('--color-border') || '#e5e7eb';
  const textColor = cssVar('--color-text-body') || '#333';
  const navy = cssVar('--navy-800') || '#14213d';
  const gold = cssVar('--accent-600') || '#daa802';
  const fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const fmtPct = (v) => Math.round(v) + '%';
  const achieved = rows.map((r) => (r.roas ?? 0) * 100);
  const target = rows.map((r) => (r.target_roas ?? 0) * 100);
  const datalabelFont = '600 10.5px ' + fontFamily;
  ctx.font = datalabelFont;
  const maxLabelWidth = [...achieved, ...target].reduce((max, v) => Math.max(max, ctx.measureText(fmtPct(v)).width), 0);
  const chart = new window.Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.campaign_name),
      datasets: [
        { label: 'ROAS logrado', data: achieved, backgroundColor: navy, borderRadius: 6, borderSkipped: false },
        { label: 'ROAS objetivo', data: target, backgroundColor: gold, borderRadius: 6, borderSkipped: false },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500, easing: 'easeOutQuart' },
      layout: { padding: { right: Math.ceil(maxLabelWidth) + 20 } },
      scales: {
        x: { display: false, grid: { display: false } },
        y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 12 } } },
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: { color: textColor, boxWidth: 12, font: { size: 11.5, family: fontFamily } },
        },
        tooltip: {
          backgroundColor: cssVar('--navy-900') || '#0f172a',
          padding: 10,
          cornerRadius: 8,
          callbacks: { label: (item) => `${item.dataset.label}: ${fmtPct(item.parsed.x)}` },
        },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: textColor,
          font: { size: 10.5, weight: '600', family: fontFamily },
          formatter: (v) => fmtPct(v),
        },
      },
    },
    plugins: window.ChartDataLabels ? [window.ChartDataLabels] : [],
  });
  chartRegistry[canvasId] = chart;
}

// Piloto de Chart.js en Planificador de keywords: el top 10 por volumen
// (Descubre keywords) reusa mountHorizontalBarChart tal cual; el histórico
// necesita una mini-gráfica (sparkline) POR FILA, así que se monta una
// instancia de Chart.js por keyword en vez de una sola para toda la tabla.
function mountKeywordPlannerCharts() {
  const s = state.keywordPlanner;
  if (s.tab === 'ideas' && s.ideas.rows && s.ideas.rows.length) {
    const top = getKeywordPlannerTop10(s.ideas.rows);
    const chartRows = top.map((r) => ({
      campaign: r.text,
      value: r.avg_monthly_searches || 0,
      valueLabel: fmtInt(r.avg_monthly_searches),
      color: KWP_COMPETITION_BAR_COLOR[r.competition] || 'var(--navy-800)',
    }));
    mountHorizontalBarChart('kwp-chart-volume', chartRows);
  } else if (s.tab === 'historico' && s.historico.rows && s.historico.rows.length) {
    getKeywordHistoricoSorted().forEach((r, idx) => {
      mountSparklineChart(`kwp-trend-${idx}`, r.monthly_search_volumes);
    });
    mountKeywordHistoricoModalChart();
  }
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
    Object.assign(s, { status: 'ready', rows, resumen, recs, fileName, campaignFilter: 'all' });
  } catch (err) {
    Object.assign(s, { status: 'error', error: err.message || String(err), fileName });
  }
  render();
}

// Misma salida que runRendAnalysis, pero a partir de filas que ya llegaron
// estructuradas desde /api/google-ads/campaigns (server.py), en vez de
// texto CSV — se salta engine.loadCampaignReport y usa
// engine.loadCampaignReportFromApi, que arma la misma forma de fila.
function runRendAnalysisFromApiRows(apiRows, fileName) {
  const s = state.rend;
  try {
    const brandKeywords = s.brandKeywords.split(',').map((v) => v.trim()).filter(Boolean);
    const rowsRaw = engine.loadCampaignReportFromApi(apiRows, brandKeywords);
    const rows = engine.computeMetrics(rowsRaw);
    const resumen = engine.summarize(rows);
    const recs = engine.generateRecommendations(rows);
    Object.assign(s, { status: 'ready', rows, resumen, recs, fileName, campaignFilter: 'all' });
  } catch (err) {
    Object.assign(s, { status: 'error', error: err.message || String(err), fileName });
  }
  render();
}

function runAiAnalysis() {
  const s = state.rend;
  s.ai = { status: 'loading', narrativa: null, error: null };
  render();

  fetch('/api/ai/analizar-rendimiento', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumen: s.resumen, recs: s.recs }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      s.ai = { status: 'ready', narrativa: data.narrativa, error: null };
      render();
    })
    .catch((err) => {
      s.ai = { status: 'error', narrativa: null, error: err.message || String(err) };
      render();
    });
}

function ensureGoogleAdsStatusLoaded() {
  const a = state.rend.api;
  if (a.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { a.statusChecked = true; a.configured = !!data.configured; render(); })
    .catch(() => { a.statusChecked = true; a.configured = false; render(); });
}

function loadGoogleAdsAccounts() {
  const a = state.rend.api;
  a.accountsStatus = 'loading'; a.error = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.accounts = data.accounts || [];
      a.simulated = !!data.simulated;
      if (!a.dateFrom || !a.dateTo) {
        const today = new Date();
        const monthAgo = new Date(today);
        monthAgo.setDate(monthAgo.getDate() - 30);
        a.dateTo = today.toISOString().slice(0, 10);
        a.dateFrom = monthAgo.toISOString().slice(0, 10);
      }
      a.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.accountsStatus = 'error'; a.error = err.message || String(err);
      render();
    });
}

function fetchGoogleAdsCampaigns() {
  const a = state.rend.api;
  // El ID escrito a mano gana sobre el seleccionado en la lista, si hay uno.
  const manualId = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  const customerId = manualId || a.accountId;
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }
  if (!a.dateFrom || !a.dateTo) { a.error = 'Elige el rango de fechas primero.'; render(); return; }

  a.error = null;
  state.rend.status = 'loading'; state.rend.error = null;
  render();

  const params = new URLSearchParams({ customer_id: customerId || '', date_from: a.dateFrom, date_to: a.dateTo, only_active: a.onlyActive ? '1' : '0' });
  fetch(`/api/google-ads/campaigns?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.simulated = !!data.simulated;
      state.rend.currency = data.currency || '';
      const account = a.accounts.find((acc) => acc.id === customerId);
      const label = a.simulated
        ? `Google Ads (simulado) — ${a.dateFrom} a ${a.dateTo}`
        : `Google Ads — ${account ? account.name : customerId} — ${a.dateFrom} a ${a.dateTo}`;
      runRendAnalysisFromApiRows(data.rows || [], label);
    })
    .catch((err) => {
      a.error = err.message || String(err);
      state.rend.status = 'idle';
      render();
    });
}

// ---------------------------------------------------------------------------
// Comparativa de periodos — mismo export de campañas (Función 1) subido dos
// veces, de dos rangos de fecha distintos, para ver tendencia en vez de
// solo la foto de un momento.
// ---------------------------------------------------------------------------

function runCompareAnalysis(which, text, fileName) {
  const slot = state.compare[which];
  try {
    const brandKeywords = state.compare.brandKeywords.split(',').map((v) => v.trim()).filter(Boolean);
    const rowsRaw = engine.loadCampaignReport(text, brandKeywords);
    rowsRaw.forEach((r) => { r.campaign_raw = r.campaign; r.hotel = deriveHotelName(r.campaign); });
    const rows = engine.computeMetrics(rowsRaw);
    Object.assign(slot, { status: 'ready', error: null, rows, fileName });
  } catch (err) {
    Object.assign(slot, { status: 'error', error: err.message || String(err), fileName, rows: null });
  }
  state.compare.campaignFilter = 'all';
  state.compare.campaignTypeFilter = 'all';
  state.compare.hotelFilter = 'all';
  render();
}

function runCompareAnalysisFromApiRows(which, apiRows, fileName) {
  const slot = state.compare[which];
  try {
    const brandKeywords = state.compare.brandKeywords.split(',').map((v) => v.trim()).filter(Boolean);
    const rowsRaw = engine.loadCampaignReportFromApi(apiRows, brandKeywords);
    // Con varias cuentas, el nombre de la cuenta va delante: dos hoteles pueden tener una campaña con el mismo
    // nombre y la comparación empareja por nombre. Se pone DESPUÉS de clasificar la campaña, para que una palabra
    // como "marca" en el nombre del hotel no convierta todas sus campañas en de marca.
    // `hotel`: con varias cuentas, el nombre de la cuenta; con una sola o con archivo, lo que hay antes del primer " - "
    // del nombre de la campaña (igual que Oportunidad de ingresos).
    rowsRaw.forEach((r, i) => {
      const acct = apiRows[i] && apiRows[i]._account;
      r.campaign_raw = r.campaign;
      r.hotel = acct || deriveHotelName(r.campaign);
      r.hotel_is_account = !!acct;
      if (acct) r.campaign = `${acct} › ${r.campaign}`;
    });
    const rows = engine.computeMetrics(rowsRaw);
    Object.assign(slot, { status: 'ready', error: null, rows, fileName });
  } catch (err) {
    Object.assign(slot, { status: 'error', error: err.message || String(err), fileName, rows: null });
  }
}

// Hotel de una fila según el corte elegido: la cuenta (solo existe con varias cuentas) o lo que va antes del primer
// " - " del nombre de la campaña. null = sin hotel con este corte.
function compareHotelOf(r) {
  if (state.compare.hotelBy === 'nombre') return deriveHotelName(r.campaign_raw || r.campaign);
  return r.hotel_is_account ? r.hotel : null;
}

// ignoreHotel=true: lo que alimenta el resumen por hotel, que debe seguir mostrando a todos los hoteles aunque se
// haya elegido ver solo uno en el resto de la página.
function getCompareFilteredRows(ignoreHotel = false) {
  const s = state.compare;
  let currentRows = s.current.rows || [];
  let previousRows = s.previous.rows || [];
  if (!ignoreHotel && s.hotelFilter !== 'all') {
    currentRows = currentRows.filter((r) => compareHotelOf(r) === s.hotelFilter);
    previousRows = previousRows.filter((r) => compareHotelOf(r) === s.hotelFilter);
  }
  if (s.campaignFilter !== 'all') {
    currentRows = currentRows.filter((r) => r.campaign === s.campaignFilter);
    previousRows = previousRows.filter((r) => r.campaign === s.campaignFilter);
  }
  if (s.campaignTypeFilter !== 'all') {
    currentRows = currentRows.filter((r) => r.campaign_type === s.campaignTypeFilter);
    previousRows = previousRows.filter((r) => r.campaign_type === s.campaignTypeFilter);
  }
  return { currentRows, previousRows };
}

// ---------------------------------------------------------------------------
// Comparativa de periodos — fuente API: mismo patrón que Rendimiento, pero
// con UN solo selector de cuenta (se compara la misma cuenta en dos rangos
// de fecha) y DOS pares de fecha (periodo actual / periodo anterior). Se
// traen ambos periodos en paralelo con /api/google-ads/campaigns.
// ---------------------------------------------------------------------------

function ensureCompareGoogleAdsStatusLoaded() {
  const a = state.compare.api;
  if (a.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { a.statusChecked = true; a.configured = !!data.configured; render(); })
    .catch(() => { a.statusChecked = true; a.configured = false; render(); });
}

function loadCompareGoogleAdsAccounts() {
  const a = state.compare.api;
  a.accountsStatus = 'loading'; a.error = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.accounts = data.accounts || [];
      a.simulated = !!data.simulated;
      if (!a.current.dateFrom || !a.current.dateTo) {
        const today = new Date();
        const monthAgo = new Date(today);
        monthAgo.setDate(monthAgo.getDate() - 30);
        a.current.dateTo = today.toISOString().slice(0, 10);
        a.current.dateFrom = monthAgo.toISOString().slice(0, 10);
      }
      if (!a.previous.dateFrom || !a.previous.dateTo) {
        // Por defecto, el mismo rango de días pero el mes anterior — el
        // usuario puede ajustarlo a cualquier periodo que quiera comparar.
        const from = new Date(a.current.dateFrom);
        const to = new Date(a.current.dateTo);
        const spanDays = Math.round((to - from) / 86400000);
        const prevTo = new Date(from);
        prevTo.setDate(prevTo.getDate() - 1);
        const prevFrom = new Date(prevTo);
        prevFrom.setDate(prevFrom.getDate() - spanDays);
        a.previous.dateTo = prevTo.toISOString().slice(0, 10);
        a.previous.dateFrom = prevFrom.toISOString().slice(0, 10);
      }
      a.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.accountsStatus = 'error'; a.error = err.message || String(err);
      render();
    });
}

function compareSelectedCustomerIds() {
  const a = state.compare.api;
  const manual = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  return [...new Set([...a.accountIds, ...(manual ? [manual] : [])])];
}

// Trae los dos periodos de una o varias cuentas. Con varias, junta las campañas de todas en un solo conjunto
// (el total combinado) — solo si comparten moneda — y deja fuera las cuentas que fallen en cualquiera de los dos.
function fetchCompareGoogleAdsCampaigns() {
  const a = state.compare.api;
  const ids = compareSelectedCustomerIds();
  if (!ids.length && !a.simulated) { a.error = 'Marca al menos una cuenta o escribe su ID primero.'; render(); return; }
  if (ids.length > OPP_MAX_ACCOUNTS) { a.error = `Elige como máximo ${OPP_MAX_ACCOUNTS} cuentas por comparación (marcaste ${ids.length}).`; render(); return; }
  if (!a.current.dateFrom || !a.current.dateTo || !a.previous.dateFrom || !a.previous.dateTo) {
    a.error = 'Elige el rango de fechas de ambos periodos.'; render(); return;
  }

  a.error = null; a.partial = []; a.combinedNote = null;
  state.compare.current.status = 'loading'; state.compare.current.error = null;
  state.compare.previous.status = 'loading'; state.compare.previous.error = null;
  render();

  const targets = ids.length ? ids : [''];
  const accountName = (id) => { const acc = a.accounts.find((x) => x.id === id); return acc ? acc.name : id; };
  const fetchPeriod = (id, dateFrom, dateTo) => {
    const params = new URLSearchParams({ customer_id: id, date_from: dateFrom, date_to: dateTo, only_active: a.onlyActive ? '1' : '0' });
    return fetch(`/api/google-ads/campaigns?${params.toString()}`)
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok, data }) => { if (!ok) throw new Error(data.error || 'Error desconocido.'); return data; });
  };

  oppMapPool(targets, 4, (id) => Promise.all([
    fetchPeriod(id, a.current.dateFrom, a.current.dateTo),
    fetchPeriod(id, a.previous.dateFrom, a.previous.dateTo),
  ])
    .then(([cur, prev]) => ({ id, cur: cur.rows || [], prev: prev.rows || [], currency: cur.currency || prev.currency || '', simulated: !!cur.simulated || !!prev.simulated }))
    .catch((err) => ({ id, error: err.message || String(err) }))
  ).then((results) => {
    const good = results.filter((r) => !r.error);
    const bad = results.filter((r) => r.error);
    if (!good.length) throw new Error(bad[0].error + (bad.length > 1 ? ` (y ${bad.length - 1} cuentas más con error)` : ''));
    // Un total combinado mezcla las cifras de todas las cuentas: no tiene sentido sumar euros con pesos.
    const byCurrency = new Map();
    good.forEach((r) => { if (r.currency) byCurrency.set(r.currency, [...(byCurrency.get(r.currency) || []), accountName(r.id)]); });
    if (byCurrency.size > 1) {
      const detail = [...byCurrency.entries()].map(([cur, names]) => `${cur}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`).join(' · ');
      throw new Error(`Las cuentas elegidas usan monedas distintas (${detail}). Un total combinado mezclaría monedas: elige cuentas con la misma.`);
    }
    a.simulated = good.some((r) => r.simulated);
    a.partial = bad.map((r) => `${accountName(r.id)}: ${r.error}`);
    const multi = good.length > 1;
    // Si dos cuentas se llaman igual, el id las distingue.
    const names = good.map((r) => accountName(r.id));
    const label = (r, i) => (names.filter((n) => n === names[i]).length > 1 ? `${names[i]} (${r.id})` : names[i]);
    const tag = (rows, r, i) => (multi ? rows.map((row) => ({ ...row, _account: label(r, i) })) : rows);
    const curRows = good.flatMap((r, i) => tag(r.cur, r, i));
    const prevRows = good.flatMap((r, i) => tag(r.prev, r, i));
    const currency = byCurrency.size ? [...byCurrency.keys()][0] : '';
    a.currency = currency;
    let who;
    if (a.simulated) who = 'Google Ads (simulado)';
    else if (!multi) who = `Google Ads — ${names[0]}`;
    else who = `Google Ads — ${good.length} cuentas (${names.slice(0, 3).join(', ')}${good.length > 3 ? '…' : ''})`;
    runCompareAnalysisFromApiRows('current', curRows, `${who} — ${a.current.dateFrom} a ${a.current.dateTo}`);
    runCompareAnalysisFromApiRows('previous', prevRows, `${who} — ${a.previous.dateFrom} a ${a.previous.dateTo}`);
    a.combinedNote = multi
      ? `Total combinado de ${good.length} cuentas (${names.join(', ')})${currency ? `, todas en ${currency}` : ''}. Cada campaña lleva delante el nombre de su hotel.`
      : null;
    state.compare.campaignFilter = 'all';
    state.compare.campaignTypeFilter = 'all';
    state.compare.hotelFilter = 'all';
    render();
  }).catch((err) => {
    a.error = err.message || String(err);
    state.compare.current.status = 'idle';
    state.compare.previous.status = 'idle';
    render();
  });
}

function loadCompareMccGroups() {
  const m = state.compare.api.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => { m.status = 'error'; m.error = err.message || String(err); render(); });
}

function applyCompareMccFilter(groupId, groupName) {
  const a = state.compare.api;
  const m = a.mcc;
  m.selectedId = groupId; m.selectedName = groupName;
  m.accountIdsStatus = 'loading'; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(groupId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.accountIds = new Set((data.accounts || []).map((acc) => acc.id));
      m.accountIdsStatus = 'ready';
      if (a.accountId && !m.accountIds.has(a.accountId)) a.accountId = '';
      render();
    })
    .catch((err) => { m.accountIdsStatus = 'error'; m.error = err.message || String(err); render(); });
}

function clearCompareMccFilter() {
  const m = state.compare.api.mcc;
  m.selectedId = ''; m.selectedName = ''; m.accountIds = null; m.accountIdsStatus = 'idle'; m.filter = '';
  render();
}

function renderCompareMccFilterPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.compare.api.mcc;

  if (m.selectedId) {
    const countLabel = m.accountIdsStatus === 'loading' ? 'cargando…'
      : m.accountIdsStatus === 'ready' ? `${m.accountIds.size} cuenta(s)`
      : 'error';
    return `
      <div class="field">
        <label>Filtrando por MCC</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="delta-badge neutral">${escapeHtml(m.selectedName)} — ${countLabel}</span>
          <button class="btn-link" data-action="compare-mcc-clear">Quitar filtro</button>
        </div>
      </div>`;
  }

  if (m.status === 'idle') {
    return `<div class="field"><button class="btn-outline sm" data-action="compare-mcc-load">Filtrar por MCC (ej. una cadena de hoteles)</button></div>`;
  }
  if (m.status === 'loading') {
    return `<div class="field"><p class="footnote">Cargando agrupaciones del MCC…</p></div>`;
  }
  if (m.status === 'error') {
    return `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  }

  const filter = (m.filter || '').trim().toLowerCase();
  let matches = [];
  if (filter.length >= 2) {
    matches = m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25);
  }
  const matchesHtml = matches.length
    ? `<div class="table-scroll" style="max-height:200px;margin-top:8px">
        <table><tbody>
          ${matches.map((g) => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
              <td><button class="btn-outline xs" data-compare-mcc-pick="${escapeHtml(g.id)}" data-compare-mcc-pick-name="${escapeHtml(g.name)}">Usar</button></td>
            </tr>`).join('')}
        </tbody></table>
      </div>`
    : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');

  return `
    <div class="field">
      <label>Filtrar por MCC</label>
      <input type="text" id="compare-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:320px" />
      ${matchesHtml}
    </div>`;
}

function renderCompareApiPanel() {
  const a = state.compare.api;

  if (!a.statusChecked) {
    return `<div class="field"><p class="footnote">Consultando la conexión con Google Ads…</p></div>`;
  }

  const simulatedNotice = a.simulated ? `
    <div class="ok-panel" style="margin:10px 0">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor
      (falta la aprobación del developer token de Google) — estos son datos de ejemplo, no de una cuenta real.
    </div>` : '';

  if (a.accountsStatus === 'idle') {
    return `
      <div class="field">
        <p class="footnote">${a.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.'}</p>
        <button class="btn-outline" data-action="compare-api-load-accounts">Ver cuentas disponibles</button>
      </div>`;
  }
  if (a.accountsStatus === 'loading') {
    return `<div class="field"><p class="footnote">Cargando cuentas…</p></div>`;
  }
  if (a.accountsStatus === 'error') {
    return `<div class="error-panel"><strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(a.error)}</div>`;
  }

  const mccFilterActive = a.mcc.selectedId && a.mcc.accountIds;
  const visibleAccounts = mccFilterActive ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
  const q = (a.accountSearch || '').trim().toLowerCase();
  const matches = q ? visibleAccounts.filter((acc) => `${acc.name} ${acc.id}`.toLowerCase().includes(q)) : visibleAccounts;
  const shown = matches.slice(0, 150);
  const selected = new Set(a.accountIds);
  const canMarkAll = matches.length > 0 && matches.length <= OPP_MAX_ACCOUNTS;
  const accountList = shown.length
    ? shown.map((acc) => `<label style="display:flex;align-items:center;gap:8px;font-weight:400;padding:3px 0;cursor:pointer"><input type="checkbox" data-cmp-acct="${escapeHtml(acc.id)}" ${selected.has(acc.id) ? 'checked' : ''} /><span>${escapeHtml(acc.name)} <span style="opacity:.6">(${escapeHtml(acc.id)})</span></span></label>`).join('')
    : '<p class="footnote" style="margin:6px 0">Ninguna cuenta coincide.</p>';

  return `
    ${simulatedNotice}
    ${renderCompareMccFilterPanel()}
    <div class="field" style="min-width:380px">
      <label>Cuentas (hoteles) a comparar juntas${mccFilterActive ? ` (${visibleAccounts.length} en "${escapeHtml(a.mcc.selectedName)}")` : ''}</label>
      <input type="text" id="compare-api-account-search" placeholder="Buscar por nombre o ID…" value="${escapeHtml(a.accountSearch || '')}" style="width:380px" />
      <div style="width:380px;max-height:230px;overflow:auto;border:1px solid var(--gray-200);border-radius:8px;padding:6px 12px;margin-top:6px;background:var(--white)">${accountList}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <button class="btn-outline xs" data-action="cmp-acct-all" ${canMarkAll ? '' : 'disabled'} title="${canMarkAll ? '' : `Se pueden marcar todas solo cuando hay ${OPP_MAX_ACCOUNTS} o menos a la vista`}">Marcar las ${matches.length} a la vista</button>
        <button class="btn-outline xs" data-action="cmp-acct-none" ${a.accountIds.length ? '' : 'disabled'}>Quitar marcas</button>
        <span class="footnote">${a.accountIds.length} marcada${a.accountIds.length === 1 ? '' : 's'} · máximo ${OPP_MAX_ACCOUNTS} · con varias se muestra el total combinado (deben compartir moneda)${matches.length > shown.length ? ` · mostrando ${shown.length} de ${matches.length}, afina la búsqueda` : ''}</span>
      </div>
    </div>
    <div class="field">
      <label>...o escribe el ID de la cuenta</label>
      <input type="text" id="compare-api-account-manual" value="${escapeHtml(a.accountIdManual)}" placeholder="ej. 6862893390" style="width:160px" />
    </div>
    <div class="field">
      <label>Periodo actual — desde/hasta</label>
      <div style="display:flex;gap:10px;flex-wrap:nowrap">
        <input type="date" id="compare-api-current-date-from" value="${escapeHtml(a.current.dateFrom)}" />
        <input type="date" id="compare-api-current-date-to" value="${escapeHtml(a.current.dateTo)}" />
      </div>
    </div>
    <div class="field">
      <label>Periodo anterior — desde/hasta</label>
      <div style="display:flex;gap:10px;flex-wrap:nowrap">
        <input type="date" id="compare-api-previous-date-from" value="${escapeHtml(a.previous.dateFrom)}" />
        <input type="date" id="compare-api-previous-date-to" value="${escapeHtml(a.previous.dateTo)}" />
      </div>
    </div>
    <div class="field">
      <label style="display:flex;align-items:center;gap:8px;font-weight:400">
        <input type="checkbox" id="compare-api-only-active" ${a.onlyActive ? 'checked' : ''} />
        Solo campañas activas
      </label>
    </div>
    <button class="btn-accent" data-action="compare-api-fetch">Traer ambos periodos de Google Ads</button>
    ${a.error ? `<div class="error-panel" style="margin-top:10px"><strong>No se pudo traer el reporte.</strong> ${escapeHtml(a.error)}</div>` : ''}
    ${a.combinedNote ? `<div class="ok-panel" style="margin-top:10px">${escapeHtml(a.combinedNote)}</div>` : ''}
    ${a.partial && a.partial.length ? `<div class="error-panel" style="margin-top:10px"><strong>${a.partial.length === 1 ? 'Una cuenta no se pudo traer y quedó fuera de la comparación:' : `${a.partial.length} cuentas no se pudieron traer y quedaron fuera de la comparación:`}</strong><ul style="margin:6px 0 0 18px">${a.partial.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></div>` : ''}
  `;
}

// mode: 'good_up' (subir es mejora, ej. conversiones/CTR/ROAS), 'good_down'
// (bajar es mejora, ej. CPA), o 'neutral' (solo se informa la tendencia,
// sin juicio de bueno/malo — ej. gasto, que puede subir a propósito).
function deltaBadge(pct, mode) {
  if (pct == null) return '<span class="delta-badge neutral">—</span>';
  const arrow = pct > 0 ? '▲' : (pct < 0 ? '▼' : '—');
  let cls = 'neutral';
  if (mode === 'good_up') cls = pct > 0 ? 'good' : (pct < 0 ? 'bad' : 'neutral');
  else if (mode === 'good_down') cls = pct < 0 ? 'good' : (pct > 0 ? 'bad' : 'neutral');
  return `<span class="delta-badge ${cls}">${arrow} ${Math.abs(pct * 100).toFixed(0)}%</span>`;
}

// Resumen por hotel de los dos periodos: gasto, conversiones, CPA y ROAS de cada uno con su variación y su peso en
// el gasto total. Solo con varias cuentas de Google Ads, donde cada hotel es una cuenta sin ambigüedad. Con una sola
// cuenta o con archivos NO se muestra: el hotel solo se podría deducir del nombre de la campaña, y en la prueba con
// el archivo de ejemplo eso daba "Search", "Performance Max" y "Display", que son tipos de campaña y no hoteles.
function compareHotelData() {
  const { currentRows, previousRows } = getCompareFilteredRows(true);
  const all = [...currentRows, ...previousRows];
  const hotels = [...new Set(all.map(compareHotelOf).filter(Boolean))];
  const byName = state.compare.hotelBy === 'nombre';
  const campaignCount = new Set(all.map((r) => r.campaign)).size;
  // Por nombre: si cada campaña sería su propio "hotel" (ninguna comparte prefijo), el corte no agrupa nada.
  if (hotels.length < 2 || (byName && hotels.length >= campaignCount)) return null;
  const groups = hotels.map((h) => {
    const cur = currentRows.filter((r) => compareHotelOf(r) === h);
    const prev = previousRows.filter((r) => compareHotelOf(r) === h);
    const cs = engine.summarize(cur); const ps = engine.summarize(prev);
    return { hotel: h, cur, prev, cs, ps, d: engine.compareSummaries(cs, ps), campaigns: new Set(cur.map((r) => r.campaign)).size };
  }).sort((x, y) => y.cs.total_cost - x.cs.total_cost);
  const total = engine.summarize(currentRows); const totalPrev = engine.summarize(previousRows);
  return { groups, total, totalPrev, totalD: engine.compareSummaries(total, totalPrev), byName };
}

function renderCompareHotelSummary() {
  const hd = compareHotelData();
  if (!hd) return '';
  const { groups, total, totalD, byName } = hd;
  const roasText = (sm) => (sm.roas != null ? `${(sm.roas * 100).toFixed(0)}%` : 'N/D');
  const cpaText = (sm) => (sm.avg_cpa_weighted != null ? fmtMoney(sm.avg_cpa_weighted) : 'N/D');
  const share = (sm) => (total.total_cost > 0 ? `${((sm.total_cost / total.total_cost) * 100).toFixed(0)}% del gasto` : '');

  const rows = groups.map((g) => {
    const onlyPrev = !g.cur.length;
    const isNew = !g.prev.length;
    return `
      <tr>
        <td><strong>${escapeHtml(g.hotel)}</strong>${isNew ? ' <span class="delta-badge neutral">nuevo</span>' : ''}${onlyPrev ? ' <span class="delta-badge neutral">sin datos en el periodo actual</span>' : ''}<div class="footnote">${g.campaigns} campaña${g.campaigns === 1 ? '' : 's'}</div></td>
        <td>${fmtMoney(g.cs.total_cost)} ${deltaBadge(g.d.delta_cost, 'neutral')}<div class="footnote">${share(g.cs)}</div></td>
        <td>${fmtInt(g.cs.total_conversions)} ${deltaBadge(g.d.delta_conversions, 'good_up')}</td>
        <td>${cpaText(g.cs)} ${deltaBadge(g.d.delta_cpa, 'good_down')}</td>
        <td>${roasText(g.cs)} ${deltaBadge(g.d.delta_roas, 'good_up')}</td>
      </tr>`;
  }).join('');
  return `
    <div class="card chart-card" style="margin-top:16px">
      <h3 class="dense-chart-title">Resumen por hotel (${groups.length})</h3>
      <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Hotel</th><th>Gasto</th><th>Conversiones</th><th>CPA</th><th>ROAS</th></tr></thead>
          <tbody>${rows}
            <tr style="font-weight:600"><td>Total</td><td>${fmtMoney(total.total_cost)} ${deltaBadge(totalD.delta_cost, 'neutral')}</td><td>${fmtInt(total.total_conversions)} ${deltaBadge(totalD.delta_conversions, 'good_up')}</td><td>${cpaText(total)} ${deltaBadge(totalD.delta_cpa, 'good_down')}</td><td>${roasText(total)} ${deltaBadge(totalD.delta_roas, 'good_up')}</td></tr>
          </tbody>
        </table>
      </div>
      <p class="footnote" style="margin-top:10px">Cifras del periodo actual; las flechas comparan con el periodo anterior. ${byName ? 'El hotel se toma de lo que va antes del primer " - " en el nombre de la campaña.' : 'Cada hotel es una de las cuentas elegidas.'}</p>
    </div>`;
}

// Todo lo que se ve en pantalla en Comparar periodos (con los filtros aplicados), para armar los informes.
function compareResultData() {
  const s = state.compare;
  const { currentRows, previousRows } = getCompareFilteredRows();
  const currentSummary = engine.summarize(currentRows);
  const previousSummary = engine.summarize(previousRows);
  const { matched, onlyCurrent, onlyPrevious } = engine.compareCampaignPeriods(currentRows, previousRows);
  const filters = [];
  if (s.hotelFilter !== 'all') filters.push(['Hotel', s.hotelFilter]);
  if (s.campaignTypeFilter !== 'all') filters.push(['Tipo de campaña', engine.CAMPAIGN_TYPE_LABELS[s.campaignTypeFilter] || s.campaignTypeFilter]);
  if (s.campaignFilter !== 'all') filters.push(['Campaña', s.campaignFilter]);
  return {
    currentLabel: s.current.fileName || 'Periodo actual', previousLabel: s.previous.fileName || 'Periodo anterior',
    currentSummary, previousSummary, deltas: engine.compareSummaries(currentSummary, previousSummary),
    matched, onlyCurrent, onlyPrevious, trendRecs: engine.generateTrendRecommendations(matched),
    hotel: compareHotelData(), filters, currency: s.source === 'api' ? s.api.currency : '',
  };
}

const COMPARE_NOTE = 'Las campañas se emparejan por nombre exacto entre los dos periodos: si una campaña se renombró, aparece como "nueva" en un lado y "ya no aparece" en el otro. '
  + 'Los cambios comparan el periodo actual contra el anterior; en Gasto no se juzga bueno o malo porque subir puede ser intencional. '
  + 'Umbrales de la recomendación por tendencia: CPA +20%, CTR -20%, conversiones -20%, o gasto +30% sin que suban las conversiones.';

function compareReportBodyHtml() {
  const d = compareResultData();
  const e = escapeHtml;
  const pct1 = (v) => (v == null || Number.isNaN(v) ? 'N/D' : `${(v * 100).toFixed(1)}%`);
  const pct0 = (v) => (v == null || Number.isNaN(v) ? 'N/D' : `${(v * 100).toFixed(0)}%`);
  // Variación coloreada: verde mejora, rojo empeora (según la métrica), gris neutral.
  const delta = (pct, mode) => {
    if (pct == null) return '<span style="color:#6b7280">—</span>';
    const up = pct > 0; const flat = pct === 0;
    let color = '#6b7280';
    if (mode === 'good_up') color = flat ? '#6b7280' : (up ? '#1d6b41' : '#b3261e');
    else if (mode === 'good_down') color = flat ? '#6b7280' : (up ? '#b3261e' : '#1d6b41');
    return `<span style="color:${color};font-weight:600">${flat ? '—' : (up ? '▲' : '▼')} ${Math.abs(pct * 100).toFixed(0)}%</span>`;
  };
  const metric = (label, value, deltaHtml, prev) => `<div class="ar-metric"><div class="ar-metric-l">${e(label)}</div><div class="ar-metric-v">${e(value)}</div><div style="font-size:12px;color:#6b7280;margin-top:3px">${deltaHtml} vs. ${e(prev)}</div></div>`;
  const cs = d.currentSummary; const ps = d.previousSummary; const dl = d.deltas;
  const na = (v, f) => (v != null ? f(v) : 'N/D');
  const small = (t) => `<div style="font-weight:400;font-size:11.5px;color:#6b7280;margin-top:2px">${e(t)}</div>`;

  const hotelBlock = d.hotel ? (() => {
    const { groups, total, totalD, byName } = d.hotel;
    const share = (sm) => (total.total_cost > 0 ? `${((sm.total_cost / total.total_cost) * 100).toFixed(0)}% del gasto` : '');
    const cpa = (sm) => (sm.avg_cpa_weighted != null ? fmtMoney(sm.avg_cpa_weighted) : 'N/D');
    const rows = groups.map((g) => `<tr>
      <td><strong>${e(g.hotel)}</strong>${small(`${g.campaigns} campaña${g.campaigns === 1 ? '' : 's'}${!g.prev.length ? ' · nuevo' : ''}${!g.cur.length ? ' · sin datos en el periodo actual' : ''}`)}</td>
      <td>${e(fmtMoney(g.cs.total_cost))} ${delta(g.d.delta_cost, 'neutral')}${small(share(g.cs))}</td>
      <td>${e(fmtInt(g.cs.total_conversions))} ${delta(g.d.delta_conversions, 'good_up')}</td>
      <td>${e(cpa(g.cs))} ${delta(g.d.delta_cpa, 'good_down')}</td>
      <td>${e(pct0(g.cs.roas))} ${delta(g.d.delta_roas, 'good_up')}</td></tr>`).join('');
    return `<div class="ar-block"><h2 class="ar-h2">Resumen por hotel (${groups.length})<small>${byName ? 'El hotel se toma de lo que va antes del primer " - " en el nombre de la campaña.' : 'Cada hotel es una de las cuentas elegidas.'}</small></h2>
      <div class="ar-card"><div class="ar-tw"><table class="ar-tbl ar-compact"><thead><tr><th>Hotel</th><th>Gasto</th><th>Conversiones</th><th>CPA</th><th>ROAS</th></tr></thead>
      <tbody>${rows}<tr><td><strong>Total</strong></td><td><strong>${e(fmtMoney(total.total_cost))}</strong> ${delta(totalD.delta_cost, 'neutral')}</td><td><strong>${e(fmtInt(total.total_conversions))}</strong> ${delta(totalD.delta_conversions, 'good_up')}</td><td><strong>${e(cpa(total))}</strong> ${delta(totalD.delta_cpa, 'good_down')}</td><td><strong>${e(pct0(total.roas))}</strong> ${delta(totalD.delta_roas, 'good_up')}</td></tr></tbody></table></div></div></div>`;
  })() : '';

  const recsHtml = d.trendRecs.length
    ? d.trendRecs.map((r) => `<div class="ar-card" style="margin-bottom:10px"><div><strong>${e(r.campaign)}</strong> · <span style="color:#6b7280">${e(r.categoria)}</span> · impacto ${(r.impacto_gasto * 100).toFixed(0)}%</div><div style="margin-top:6px">${e(r.hallazgo)}</div><div style="margin-top:6px"><strong>➜</strong> ${e(r.recomendacion)}</div></div>`).join('')
    : '<div class="ar-card">No se detectaron caídas ni subidas fuertes entre los dos periodos con los umbrales actuales.</div>';

  const rows = d.matched.map((m) => `<tr>
    <td>${e(m.campaign)}</td>
    <td>${e(fmtMoney(m.current.cost))} ${delta(m.delta_cost, 'neutral')}</td>
    <td>${e(pct1(m.current.cpa_pct))} ${delta(m.delta_cpa_pct, 'good_down')}</td>
    <td>${e(Number.isNaN(m.current.ctr) ? 'N/D' : (m.current.ctr * 100).toFixed(2) + '%')} ${delta(m.delta_ctr, 'good_up')}</td>
    <td>${e(fmtInt(m.current.conversions))} ${delta(m.delta_conversions, 'good_up')}</td></tr>`).join('');
  const onlyList = (title, list) => (list.length ? `<div class="ar-block"><h2 class="ar-h2">${e(title)} (${list.length})</h2><div class="ar-card"><table class="ar-tbl ar-compact"><tbody>${list.map((r) => `<tr><td>${e(r.campaign)}</td><td style="text-align:right">${e(fmtMoney(r.cost))}</td></tr>`).join('')}</tbody></table></div></div>` : '');

  return `
    <div class="ar">
      <div class="ar-eyebrow">Comparar periodos</div>
      <div class="ar-title">Cómo cambiaron las campañas entre dos periodos</div>
      <div class="ar-sub">Actual: <strong>${e(d.currentLabel)}</strong><br>Anterior: <strong>${e(d.previousLabel)}</strong>${d.currency ? `<br>Moneda: <strong>${e(d.currency)}</strong>` : ''}${d.filters.length ? `<br>Filtros: ${d.filters.map(([k, v]) => `${e(k)}: <strong>${e(v)}</strong>`).join(' · ')}` : ''} · Generado ${new Date().toISOString().slice(0, 10)}</div>
      <div class="ar-block"><div class="ar-grid">
        ${metric('Gasto total', fmtMoney(cs.total_cost), delta(dl.delta_cost, 'neutral'), fmtMoney(ps.total_cost))}
        ${metric('Conversiones', fmtInt(cs.total_conversions), delta(dl.delta_conversions, 'good_up'), fmtInt(ps.total_conversions))}
        ${metric('CPA promedio (ponderado)', na(cs.avg_cpa_weighted, fmtMoney), delta(dl.delta_cpa, 'good_down'), na(ps.avg_cpa_weighted, fmtMoney))}
        ${metric('ROAS', pct0(cs.roas), delta(dl.delta_roas, 'good_up'), pct0(ps.roas))}
        ${metric('Valor de conversión', na(cs.total_conv_value, fmtMoney), delta(dl.delta_conv_value, 'good_up'), na(ps.total_conv_value, fmtMoney))}
        ${metric('CPA %', pct1(cs.cpa_pct), delta(dl.delta_cpa_pct, 'good_down'), pct1(ps.cpa_pct))}
      </div></div>
      ${hotelBlock}
      <div class="ar-block"><h2 class="ar-h2">Recomendaciones por tendencia (${d.trendRecs.length})</h2>${recsHtml}</div>
      <div class="ar-block"><h2 class="ar-h2">Campañas comparadas (${d.matched.length})</h2>
      <div class="ar-card"><div class="ar-tw"><table class="ar-tbl ar-compact"><thead><tr><th style="min-width:200px">Campaña</th><th>Gasto</th><th>CPA %</th><th>CTR</th><th>Conversiones</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>
      ${onlyList('Campañas nuevas en el periodo actual', d.onlyCurrent)}
      ${onlyList('Campañas que no aparecen en el periodo actual', d.onlyPrevious)}
      <div class="ar-note">${e(COMPARE_NOTE)}</div>
      <div class="ar-foot">Generado con Paid Media Helper a partir de datos de Google Ads o de los archivos subidos. Las cifras son las que reporta Google Ads: no verifican reservas reales ni ingresos finales del hotel.</div>
    </div>`;
}

function buildCompareHtml() {
  return withMoneyCurrency(state.compare.source === 'api' ? state.compare.api.currency : null, () => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comparar periodos</title>
${themedFontsLink(PLUS_JAKARTA_HREF)}
<style>body{margin:0;padding:40px 20px;background:#f4f5f8}@media print{body{background:#fff;padding:0}@page{margin:14mm}}${AUDIT_REPORT_CSS}.ar-compact th,.ar-compact td{padding:7px 6px;font-size:12.5px}</style>
</head><body>${compareReportBodyHtml()}</body></html>`);
}

function buildCompareMarkdown() {
  return withMoneyCurrency(state.compare.source === 'api' ? state.compare.api.currency : null, () => {
    const d = compareResultData();
    const pct1 = (v) => (v == null || Number.isNaN(v) ? 'N/D' : `${(v * 100).toFixed(1)}%`);
    const pct0 = (v) => (v == null || Number.isNaN(v) ? 'N/D' : `${(v * 100).toFixed(0)}%`);
    const dm = (pct) => (pct == null ? '—' : pct === 0 ? '—' : `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct * 100).toFixed(0)}%`);
    const cs = d.currentSummary; const ps = d.previousSummary; const dl = d.deltas;
    const na = (v, f) => (v != null ? f(v) : 'N/D');
    const cell = (t) => String(t).replace(/\|/g, '\\|');
    const lines = [];
    lines.push('# Comparar periodos', '');
    lines.push(`- Periodo actual: ${d.currentLabel}`);
    lines.push(`- Periodo anterior: ${d.previousLabel}`);
    if (d.currency) lines.push(`- Moneda: ${d.currency}`);
    if (d.filters.length) lines.push(`- Filtros: ${d.filters.map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
    lines.push(`- Generado: ${new Date().toISOString().slice(0, 10)}`, '');
    lines.push('## Cifras del periodo', '', '| Métrica | Actual | Anterior | Cambio |', '|---|---|---|---|');
    lines.push(`| Gasto total | ${fmtMoney(cs.total_cost)} | ${fmtMoney(ps.total_cost)} | ${dm(dl.delta_cost)} |`);
    lines.push(`| Conversiones | ${fmtInt(cs.total_conversions)} | ${fmtInt(ps.total_conversions)} | ${dm(dl.delta_conversions)} |`);
    lines.push(`| CPA promedio (ponderado) | ${na(cs.avg_cpa_weighted, fmtMoney)} | ${na(ps.avg_cpa_weighted, fmtMoney)} | ${dm(dl.delta_cpa)} |`);
    lines.push(`| ROAS | ${pct0(cs.roas)} | ${pct0(ps.roas)} | ${dm(dl.delta_roas)} |`);
    lines.push(`| Valor de conversión | ${na(cs.total_conv_value, fmtMoney)} | ${na(ps.total_conv_value, fmtMoney)} | ${dm(dl.delta_conv_value)} |`);
    lines.push(`| CPA % | ${pct1(cs.cpa_pct)} | ${pct1(ps.cpa_pct)} | ${dm(dl.delta_cpa_pct)} |`);
    if (d.hotel) {
      const { groups, total, totalD, byName } = d.hotel;
      const cpa = (sm) => (sm.avg_cpa_weighted != null ? fmtMoney(sm.avg_cpa_weighted) : 'N/D');
      lines.push('', `## Resumen por hotel (${groups.length})`, '', byName ? 'El hotel se toma de lo que va antes del primer " - " en el nombre de la campaña.' : 'Cada hotel es una de las cuentas elegidas.', '');
      lines.push('| Hotel | Campañas | Gasto | Cambio | % del gasto | Conversiones | Cambio | CPA | Cambio | ROAS | Cambio |', '|---|---|---|---|---|---|---|---|---|---|---|');
      groups.forEach((g) => lines.push(`| ${cell(g.hotel)}${!g.prev.length ? ' (nuevo)' : ''}${!g.cur.length ? ' (sin datos en el periodo actual)' : ''} | ${g.campaigns} | ${fmtMoney(g.cs.total_cost)} | ${dm(g.d.delta_cost)} | ${total.total_cost > 0 ? ((g.cs.total_cost / total.total_cost) * 100).toFixed(0) + '%' : 'N/D'} | ${fmtInt(g.cs.total_conversions)} | ${dm(g.d.delta_conversions)} | ${cpa(g.cs)} | ${dm(g.d.delta_cpa)} | ${pct0(g.cs.roas)} | ${dm(g.d.delta_roas)} |`));
      lines.push(`| **Total** | | **${fmtMoney(total.total_cost)}** | ${dm(totalD.delta_cost)} | 100% | **${fmtInt(total.total_conversions)}** | ${dm(totalD.delta_conversions)} | **${cpa(total)}** | ${dm(totalD.delta_cpa)} | **${pct0(total.roas)}** | ${dm(totalD.delta_roas)} |`);
    }
    lines.push('', `## Recomendaciones por tendencia (${d.trendRecs.length})`, '');
    if (d.trendRecs.length) {
      d.trendRecs.forEach((r) => lines.push(`### ${r.campaign}`, '', `**${r.categoria}** · impacto ${(r.impacto_gasto * 100).toFixed(0)}%`, '', r.hallazgo, '', `➜ ${r.recomendacion}`, ''));
    } else lines.push('No se detectaron caídas ni subidas fuertes entre los dos periodos con los umbrales actuales.');
    lines.push('', `## Campañas comparadas (${d.matched.length})`, '', '| Campaña | Gasto | Cambio | CPA % | Cambio | CTR | Cambio | Conversiones | Cambio |', '|---|---|---|---|---|---|---|---|---|');
    d.matched.forEach((m) => lines.push(`| ${cell(m.campaign)} | ${fmtMoney(m.current.cost)} | ${dm(m.delta_cost)} | ${pct1(m.current.cpa_pct)} | ${dm(m.delta_cpa_pct)} | ${Number.isNaN(m.current.ctr) ? 'N/D' : (m.current.ctr * 100).toFixed(2) + '%'} | ${dm(m.delta_ctr)} | ${fmtInt(m.current.conversions)} | ${dm(m.delta_conversions)} |`));
    const onlyList = (title, list) => { if (list.length) { lines.push('', `## ${title} (${list.length})`, '', ...list.map((r) => `- ${r.campaign}: ${fmtMoney(r.cost)}`)); } };
    onlyList('Campañas nuevas en el periodo actual', d.onlyCurrent);
    onlyList('Campañas que no aparecen en el periodo actual', d.onlyPrevious);
    lines.push('', '---', COMPARE_NOTE, '', 'Informe generado con Paid Media Helper. Las cifras son las que reporta Google Ads o los archivos subidos: no verifican reservas reales ni ingresos finales del hotel.');
    return lines.join('\n');
  });
}

function compareFileName(ext) {
  return `comparar-periodos_${new Date().toISOString().slice(0, 10)}.${ext}`;
}

function renderComparePage() {
  const c = state.compare;
  return withMoneyCurrency(c.source === 'api' ? c.api.currency : null, renderComparePageBody);
}

function renderComparePageBody() {
  const s = state.compare;
  const bothReady = s.current.status === 'ready' && s.previous.status === 'ready';

  // El campo de palabras de marca solo se muestra subiendo archivo — en modo
  // API se usa el valor que ya tenga guardado, mismo criterio que Rendimiento.
  const brandKeywordsField = s.source === 'file' ? `
      <div class="field">
        <label>Palabras que identifican una campaña de marca (separadas por coma)</label>
        <input type="text" id="compare-brand-keywords" value="${escapeHtml(s.brandKeywords)}" style="width:320px" />
      </div>` : '';

  const uploadPanel = `
    <div class="card control-panel align-end">
      ${brandKeywordsField}
      <div class="seg-control">
        <button class="seg-btn ${s.source === 'file' ? 'active' : ''}" data-action="compare-source-file">Subir archivo</button>
        <button class="seg-btn ${s.source === 'api' ? 'active' : ''}" data-action="compare-source-api">Conectar Google Ads</button>
      </div>
      ${s.source === 'file' ? `
        <div class="field">
          <label>Periodo actual (CSV o Excel)</label>
          <input type="file" id="compare-current-file" accept=".csv,.xlsx,.xls" />
          ${s.current.fileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.current.fileName)}</strong></div>` : ''}
        </div>
        <div class="field">
          <label>Periodo anterior (CSV o Excel)</label>
          <input type="file" id="compare-previous-file" accept=".csv,.xlsx,.xls" />
          ${s.previous.fileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.previous.fileName)}</strong></div>` : ''}
        </div>
        <button class="btn-outline" data-action="compare-demo">Usar ejemplo (dos periodos)</button>
      ` : renderCompareApiPanel()}
    </div>`;

  let errorHtml = '';
  if (s.current.status === 'error') errorHtml += `<div class="error-panel"><strong>Periodo actual:</strong> ${escapeHtml(s.current.error)}</div>`;
  if (s.previous.status === 'error') errorHtml += `<div class="error-panel"><strong>Periodo anterior:</strong> ${escapeHtml(s.previous.error)}</div>`;

  if (!bothReady) {
    return `
      ${uploadPanel}
      ${errorHtml}
      <div class="card state-panel idle">
        ${icon('git-compare', 30)}
        <p>Sube el export del periodo actual y del periodo anterior, o conecta Google Ads, para ver la comparativa.</p>
      </div>`;
  }

  const allCampaignNames = [...new Set([...s.current.rows.map((r) => r.campaign), ...s.previous.rows.map((r) => r.campaign)])].sort((a, b) => a.localeCompare(b));
  const allCampaignTypes = [...new Set([...s.current.rows.map((r) => r.campaign_type), ...s.previous.rows.map((r) => r.campaign_type)])].filter(Boolean);
  const hotelSummaryHtml = renderCompareHotelSummary();
  const allHotels = [...new Set([...s.current.rows, ...s.previous.rows].map(compareHotelOf).filter(Boolean))].sort((x, y) => x.localeCompare(y));
  const showHotelFilter = allHotels.length > 1 && hotelSummaryHtml !== '';
  const hotelByHint = s.hotelBy === 'nombre'
    ? (hotelSummaryHtml ? 'El hotel se toma de lo que va antes del primer " - " del nombre de la campaña (por ejemplo "Estelar Hoteles - CO:es - Search" → Estelar Hoteles). Sirve si tus campañas se nombran así.'
      : 'Con este corte no se forman al menos 2 grupos distintos (o cada campaña sería su propio hotel). Revisa cómo se nombran las campañas.')
    : (hotelSummaryHtml ? 'Cada hotel es una de las cuentas elegidas.' : 'Con una sola cuenta o con archivos, elige "Por nombre de campaña" para ver el resumen por hotel.');
  const campaignFilterHtml = `
    <div class="card control-panel align-end">
      <div class="field">
        <label>Resumen por hotel</label>
        <select id="compare-hotel-by" style="width:260px">
          <option value="cuenta" ${s.hotelBy === 'cuenta' ? 'selected' : ''}>Por cuenta (varias cuentas)</option>
          <option value="nombre" ${s.hotelBy === 'nombre' ? 'selected' : ''}>Por nombre de campaña</option>
        </select>
        <p class="field-hint" style="max-width:340px">${escapeHtml(hotelByHint)}</p>
      </div>
      ${showHotelFilter ? `
      <div class="field">
        <label>Ver solo este hotel</label>
        <select id="compare-hotel-filter" style="width:260px">
          <option value="all" ${s.hotelFilter === 'all' ? 'selected' : ''}>Todos los hoteles</option>
          ${allHotels.map((h) => `<option value="${escapeHtml(h)}" ${s.hotelFilter === h ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="field">
        <label>Ver solo esta campaña</label>
        <select id="compare-campaign-filter" style="width:280px">
          <option value="all" ${s.campaignFilter === 'all' ? 'selected' : ''}>Todas las campañas</option>
          ${allCampaignNames.map((c) => `<option value="${escapeHtml(c)}" ${s.campaignFilter === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
      </div>
      ${allCampaignTypes.length > 1 ? `
      <div class="field">
        <label>Ver solo este tipo de campaña</label>
        <select id="compare-campaign-type-filter" style="width:220px">
          <option value="all" ${s.campaignTypeFilter === 'all' ? 'selected' : ''}>Todos los tipos</option>
          ${allCampaignTypes.map((t) => `<option value="${escapeHtml(t)}" ${s.campaignTypeFilter === t ? 'selected' : ''}>${escapeHtml(engine.CAMPAIGN_TYPE_LABELS[t] || t)}</option>`).join('')}
        </select>
      </div>` : ''}
    </div>`;

  const { currentRows, previousRows } = getCompareFilteredRows();
  const currentSummary = engine.summarize(currentRows);
  const previousSummary = engine.summarize(previousRows);
  const deltas = engine.compareSummaries(currentSummary, previousSummary);
  const { matched, onlyCurrent, onlyPrevious } = engine.compareCampaignPeriods(currentRows, previousRows);
  const trendRecs = engine.generateTrendRecommendations(matched);

  const statGrid = `
    <div class="stat-grid">
      <div class="card stat-card">
        <div class="stat-label">Gasto total</div>
        <div class="stat-value">${fmtMoney(currentSummary.total_cost)}</div>
        <div class="stat-sub">${deltaBadge(deltas.delta_cost, 'neutral')} vs. ${fmtMoney(previousSummary.total_cost)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Conversiones</div>
        <div class="stat-value">${fmtInt(currentSummary.total_conversions)}</div>
        <div class="stat-sub">${deltaBadge(deltas.delta_conversions, 'good_up')} vs. ${fmtInt(previousSummary.total_conversions)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">CPA promedio (ponderado)</div>
        <div class="stat-value">${currentSummary.avg_cpa_weighted != null ? fmtMoney(currentSummary.avg_cpa_weighted) : 'N/D'}</div>
        <div class="stat-sub">${deltaBadge(deltas.delta_cpa, 'good_down')} vs. ${previousSummary.avg_cpa_weighted != null ? fmtMoney(previousSummary.avg_cpa_weighted) : 'N/D'}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">ROAS</div>
        <div class="stat-value">${currentSummary.roas != null ? (currentSummary.roas * 100).toFixed(0) + '%' : 'N/D'}</div>
        <div class="stat-sub">${deltaBadge(deltas.delta_roas, 'good_up')} vs. ${previousSummary.roas != null ? (previousSummary.roas * 100).toFixed(0) + '%' : 'N/D'}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Valor de conversión</div>
        <div class="stat-value">${currentSummary.total_conv_value != null ? fmtMoney(currentSummary.total_conv_value) : 'N/D'}</div>
        <div class="stat-sub">${deltaBadge(deltas.delta_conv_value, 'good_up')} vs. ${previousSummary.total_conv_value != null ? fmtMoney(previousSummary.total_conv_value) : 'N/D'}</div>
      </div>
      <div class="card stat-card accent">
        <div class="stat-label">CPA %</div>
        <div class="stat-value">${currentSummary.cpa_pct != null ? (currentSummary.cpa_pct * 100).toFixed(1) + '%' : 'N/D'}</div>
        <div class="stat-sub">${deltaBadge(deltas.delta_cpa_pct, 'good_down')} vs. ${previousSummary.cpa_pct != null ? (previousSummary.cpa_pct * 100).toFixed(1) + '%' : 'N/D'}</div>
      </div>
    </div>`;

  const recsHtml = trendRecs.length
    ? `<div class="rec-list">${trendRecs.map((r) => {
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
    : `<div class="ok-panel">No se detectaron caídas ni subidas fuertes entre los dos periodos con los umbrales actuales.</div>`;

  const tableRows = matched.map((m) => {
    const cpaPctText = !Number.isNaN(m.current.cpa_pct) ? (m.current.cpa_pct * 100).toFixed(1) + '%' : 'N/D';
    const ctrText = !Number.isNaN(m.current.ctr) ? (m.current.ctr * 100).toFixed(2) + '%' : 'N/D';
    return `
      <tr>
        <td>${escapeHtml(m.campaign)}</td>
        <td>${fmtMoney(m.current.cost)} ${deltaBadge(m.delta_cost, 'neutral')}</td>
        <td>${cpaPctText} ${deltaBadge(m.delta_cpa_pct, 'good_down')}</td>
        <td>${ctrText} ${deltaBadge(m.delta_ctr, 'good_up')}</td>
        <td>${fmtInt(m.current.conversions)} ${deltaBadge(m.delta_conversions, 'good_up')}</td>
      </tr>`;
  }).join('');

  const onlyListsHtml = (onlyCurrent.length || onlyPrevious.length) ? `
    <div class="dense-grid" style="margin-top:16px">
      ${onlyCurrent.length ? `
        <div class="card dense-panel">
          <h3 class="dense-chart-title">Campañas nuevas en el periodo actual (${onlyCurrent.length})</h3>
          ${onlyCurrent.map((r) => `<div class="dense-row"><span>${escapeHtml(r.campaign)}</span><strong>${fmtMoney(r.cost)}</strong></div>`).join('')}
        </div>` : ''}
      ${onlyPrevious.length ? `
        <div class="card dense-panel">
          <h3 class="dense-chart-title">Campañas que no aparecen en el periodo actual (${onlyPrevious.length})</h3>
          ${onlyPrevious.map((r) => `<div class="dense-row"><span>${escapeHtml(r.campaign)}</span><strong>${fmtMoney(r.cost)}</strong></div>`).join('')}
        </div>` : ''}
    </div>` : '';

  return `
    ${uploadPanel}
    ${campaignFilterHtml}
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:10px">
      <button class="btn-outline sm" data-action="compare-download-html">Descargar informe (HTML)</button>
      <button class="btn-outline sm" data-action="compare-download-md">Descargar Markdown</button>
    </div>
    ${statGrid}
    ${hotelSummaryHtml}
    <div style="margin-top:16px">
      <h2 class="section-title">Recomendaciones por tendencia (${trendRecs.length})</h2>
      ${recsHtml}
    </div>
    <div class="card chart-card" style="margin-top:16px">
      <h3 class="dense-chart-title">Campañas comparadas (${matched.length})</h3>
      <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Campaña</th><th>Gasto</th><th>CPA %</th><th>CTR</th><th>Conversiones</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>
    ${onlyListsHtml}
    <p class="footnote">
      Las campañas se emparejan por nombre exacto entre los dos archivos — si una campaña se renombró entre periodos, va a aparecer como "nueva" en un lado y "ya no aparece" en el otro.
      Los badges ▲/▼ comparan el periodo actual contra el anterior: verde es mejora, rojo es empeora. En Gasto no se juzga bueno/malo porque subir puede ser intencional.
      Umbrales de la recomendación por tendencia: CPA +20%, CTR -20%, conversiones -20%, o gasto +30% sin que suban las conversiones.
    </p>
  `;
}

// ---------------------------------------------------------------------------
// Oportunidad de ingresos — mismo export de campañas (Función 1)
// ---------------------------------------------------------------------------

function runOpportunityAnalysis(text, fileName) {
  const s = state.opportunity;
  try {
    const brandKeywords = s.brandKeywords.split(',').map((v) => v.trim()).filter(Boolean);
    const rowsRaw = engine.loadCampaignReport(text, brandKeywords);
    const rows = engine.computeMetrics(rowsRaw);
    Object.assign(s, { status: 'ready', error: null, rows, fileName, campaignFilter: 'all', typeFilter: [], hotelFilter: 'all' });
  } catch (err) {
    Object.assign(s, { status: 'error', error: err.message || String(err), fileName, rows: null });
  }
  render();
}

function runOpportunityAnalysisFromApiRows(apiRows, fileName) {
  const s = state.opportunity;
  try {
    const brandKeywords = s.brandKeywords.split(',').map((v) => v.trim()).filter(Boolean);
    const rowsRaw = engine.loadCampaignReportFromApi(apiRows, brandKeywords);
    const rows = engine.computeMetrics(rowsRaw);
    Object.assign(s, { status: 'ready', error: null, rows, fileName, campaignFilter: 'all', typeFilter: [], hotelFilter: 'all' });
  } catch (err) {
    Object.assign(s, { status: 'error', error: err.message || String(err), fileName, rows: null });
  }
  render();
}

function ensureOpportunityGoogleAdsStatusLoaded() {
  const a = state.opportunity.api;
  if (a.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { a.statusChecked = true; a.configured = !!data.configured; render(); })
    .catch(() => { a.statusChecked = true; a.configured = false; render(); });
}

function loadOpportunityGoogleAdsAccounts() {
  const a = state.opportunity.api;
  a.accountsStatus = 'loading'; a.error = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.accounts = data.accounts || [];
      a.simulated = !!data.simulated;
      if (!a.dateFrom || !a.dateTo) {
        const today = new Date();
        const monthAgo = new Date(today);
        monthAgo.setDate(monthAgo.getDate() - 30);
        a.dateTo = today.toISOString().slice(0, 10);
        a.dateFrom = monthAgo.toISOString().slice(0, 10);
      }
      a.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.accountsStatus = 'error'; a.error = err.message || String(err);
      render();
    });
}

const OPP_MAX_ACCOUNTS = 20;

// Cuentas marcadas en la lista más la que se escriba a mano, sin repetir.
function oppSelectedCustomerIds() {
  const a = state.opportunity.api;
  const manual = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  return [...new Set([...a.accountIds, ...(manual ? [manual] : [])])];
}

// Corre `worker` sobre cada elemento con pocas llamadas a la vez, para no
// disparar decenas de consultas juntas contra la cuota de Google Ads.
function oppMapPool(items, size, worker) {
  const out = new Array(items.length);
  let next = 0;
  const run = () => {
    if (next >= items.length) return Promise.resolve();
    const i = next++;
    return Promise.resolve(worker(items[i])).then((r) => { out[i] = r; }).then(run);
  };
  return Promise.all(Array.from({ length: Math.min(size, items.length) }, run)).then(() => out);
}

function fetchOpportunityGoogleAdsCampaigns() {
  const a = state.opportunity.api;
  const ids = oppSelectedCustomerIds();
  if (!ids.length && !a.simulated) { a.error = 'Marca al menos una cuenta o escribe su ID primero.'; render(); return; }
  if (ids.length > OPP_MAX_ACCOUNTS) { a.error = `Elige como máximo ${OPP_MAX_ACCOUNTS} cuentas por análisis (marcaste ${ids.length}).`; render(); return; }
  if (!a.dateFrom || !a.dateTo) { a.error = 'Elige el rango de fechas primero.'; render(); return; }

  a.error = null; a.partial = [];
  state.opportunity.status = 'loading'; state.opportunity.error = null;
  render();

  const targets = ids.length ? ids : [''];
  const accountName = (id) => { const acc = a.accounts.find((x) => x.id === id); return acc ? acc.name : id; };
  oppMapPool(targets, 4, (id) => {
    const params = new URLSearchParams({ customer_id: id, date_from: a.dateFrom, date_to: a.dateTo, only_active: a.onlyActive ? '1' : '0' });
    return fetch(`/api/google-ads/campaigns?${params.toString()}`)
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || 'Error desconocido.');
        return { id, rows: data.rows || [], simulated: !!data.simulated, currency: data.currency || '' };
      })
      .catch((err) => ({ id, error: err.message || String(err) }));
  }).then((results) => {
    const good = results.filter((r) => !r.error);
    const bad = results.filter((r) => r.error);
    if (!good.length) throw new Error(bad[0].error + (bad.length > 1 ? ` (y ${bad.length - 1} cuentas más con error)` : ''));
    // Un análisis conjunto suma cifras de todas las cuentas: no tiene sentido mezclar euros con pesos.
    const byCurrency = new Map();
    good.forEach((r) => { if (r.currency) byCurrency.set(r.currency, [...(byCurrency.get(r.currency) || []), accountName(r.id)]); });
    if (byCurrency.size > 1) {
      const detail = [...byCurrency.entries()].map(([cur, names]) => `${cur}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`).join(' · ');
      throw new Error(`Las cuentas elegidas usan monedas distintas (${detail}). Un análisis conjunto mezclaría monedas: elige cuentas con la misma.`);
    }
    state.opportunity.currency = byCurrency.size ? [...byCurrency.keys()][0] : '';
    a.simulated = good.some((r) => r.simulated);
    a.partial = bad.map((r) => `${accountName(r.id)}: ${r.error}`);
    const rows = good.flatMap((r) => r.rows);
    let who;
    if (a.simulated) who = 'Google Ads (simulado)';
    else if (good.length === 1) who = `Google Ads — ${accountName(good[0].id)}`;
    else who = `Google Ads — ${good.length} cuentas (${good.slice(0, 3).map((r) => accountName(r.id)).join(', ')}${good.length > 3 ? '…' : ''})`;
    runOpportunityAnalysisFromApiRows(rows, `${who} — ${a.dateFrom} a ${a.dateTo}`);
  }).catch((err) => {
    a.error = err.message || String(err);
    state.opportunity.status = 'idle';
    render();
  });

  fetchOpportunityImpressionShareTrend(targets, a.dateFrom, a.dateTo);
}

// Serie diaria de Impression Share para el gráfico de tendencia — llamada
// aparte de fetchOpportunityGoogleAdsCampaigns() para que, si esta falla,
// no tumbe el embudo/tabla principal (que sí funcionó). Solo tiene sentido
// en modo API: un CSV nativo de campañas no trae desglose día a día. Con varias
// cuentas junta las filas de todas (una por campaña y día), que luego se agregan.
function fetchOpportunityImpressionShareTrend(customerIds, dateFrom, dateTo) {
  const t = state.opportunity.isTrend;
  t.status = 'loading'; t.error = null;
  render();
  oppMapPool(customerIds, 4, (id) => {
    const params = new URLSearchParams({ customer_id: id || '', date_from: dateFrom, date_to: dateTo });
    return fetch(`/api/google-ads/impression-share-daily?${params.toString()}`)
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || 'Error desconocido.');
        return { rows: data.rows || [] };
      })
      .catch((err) => ({ error: err.message || String(err) }));
  }).then((results) => {
    const good = results.filter((r) => !r.error);
    if (!good.length) throw new Error(results[0].error);
    t.status = 'ready'; t.rows = good.flatMap((r) => r.rows);
    render();
  }).catch((err) => {
    t.status = 'error'; t.error = err.message || String(err);
    render();
  });
}

function loadOppMccGroups() {
  const m = state.opportunity.api.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => { m.status = 'error'; m.error = err.message || String(err); render(); });
}

function applyOppMccFilter(groupId, groupName) {
  const a = state.opportunity.api;
  const m = a.mcc;
  m.selectedId = groupId; m.selectedName = groupName;
  m.accountIdsStatus = 'loading'; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(groupId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.accountIds = new Set((data.accounts || []).map((acc) => acc.id));
      m.accountIdsStatus = 'ready';
      if (a.accountId && !m.accountIds.has(a.accountId)) a.accountId = '';
      a.accountIds = a.accountIds.filter((id) => m.accountIds.has(id));
      render();
    })
    .catch((err) => { m.accountIdsStatus = 'error'; m.error = err.message || String(err); render(); });
}

function clearOppMccFilter() {
  const m = state.opportunity.api.mcc;
  m.selectedId = ''; m.selectedName = ''; m.accountIds = null; m.accountIdsStatus = 'idle'; m.filter = '';
  render();
}

function renderOppMccFilterPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.opportunity.api.mcc;

  if (m.selectedId) {
    const countLabel = m.accountIdsStatus === 'loading' ? 'cargando…'
      : m.accountIdsStatus === 'ready' ? `${m.accountIds.size} cuenta(s)`
      : 'error';
    return `
      <div class="field">
        <label>Filtrando por MCC</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="delta-badge neutral">${escapeHtml(m.selectedName)} — ${countLabel}</span>
          <button class="btn-link" data-action="opp-mcc-clear">Quitar filtro</button>
        </div>
      </div>`;
  }

  if (m.status === 'idle') {
    return `<div class="field"><button class="btn-outline sm" data-action="opp-mcc-load">Filtrar por MCC (ej. una cadena de hoteles)</button></div>`;
  }
  if (m.status === 'loading') {
    return `<div class="field"><p class="footnote">Cargando agrupaciones del MCC…</p></div>`;
  }
  if (m.status === 'error') {
    return `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  }

  const filter = (m.filter || '').trim().toLowerCase();
  let matches = [];
  if (filter.length >= 2) {
    matches = m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25);
  }
  const matchesHtml = matches.length
    ? `<div class="table-scroll" style="max-height:200px;margin-top:8px">
        <table><tbody>
          ${matches.map((g) => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
              <td><button class="btn-outline xs" data-opp-mcc-pick="${escapeHtml(g.id)}" data-opp-mcc-pick-name="${escapeHtml(g.name)}">Usar</button></td>
            </tr>`).join('')}
        </tbody></table>
      </div>`
    : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');

  return `
    <div class="field">
      <label>Filtrar por MCC</label>
      <input type="text" id="opp-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:320px" />
      ${matchesHtml}
    </div>`;
}

function renderOpportunityApiPanel() {
  const a = state.opportunity.api;

  if (!a.statusChecked) {
    return `<div class="field"><p class="footnote">Consultando la conexión con Google Ads…</p></div>`;
  }

  const simulatedNotice = a.simulated ? `
    <div class="ok-panel" style="margin:10px 0">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor
      (falta la aprobación del developer token de Google) — estos son datos de ejemplo, no de una cuenta real.
    </div>` : '';

  if (a.accountsStatus === 'idle') {
    return `
      <div class="field">
        <p class="footnote">${a.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.'}</p>
        <button class="btn-outline" data-action="opp-api-load-accounts">Ver cuentas disponibles</button>
      </div>`;
  }
  if (a.accountsStatus === 'loading') {
    return `<div class="field"><p class="footnote">Cargando cuentas…</p></div>`;
  }
  if (a.accountsStatus === 'error') {
    return `<div class="error-panel"><strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(a.error)}</div>`;
  }

  const mccFilterActive = a.mcc.selectedId && a.mcc.accountIds;
  const visibleAccounts = mccFilterActive ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
  const q = (a.accountSearch || '').trim().toLowerCase();
  const matches = q ? visibleAccounts.filter((acc) => `${acc.name} ${acc.id}`.toLowerCase().includes(q)) : visibleAccounts;
  const shown = matches.slice(0, 150);
  const selected = new Set(a.accountIds);
  const canMarkAll = matches.length > 0 && matches.length <= OPP_MAX_ACCOUNTS;
  const accountList = shown.length
    ? shown.map((acc) => `<label style="display:flex;align-items:center;gap:8px;font-weight:400;padding:3px 0;cursor:pointer"><input type="checkbox" data-opp-acct="${escapeHtml(acc.id)}" ${selected.has(acc.id) ? 'checked' : ''} /><span>${escapeHtml(acc.name)} <span style="opacity:.6">(${escapeHtml(acc.id)})</span></span></label>`).join('')
    : '<p class="footnote" style="margin:6px 0">Ninguna cuenta coincide.</p>';

  return `
    ${simulatedNotice}
    ${renderOppMccFilterPanel()}
    <div class="field" style="min-width:380px">
      <label>Cuentas a analizar juntas${mccFilterActive ? ` (${visibleAccounts.length} en "${escapeHtml(a.mcc.selectedName)}")` : ''}</label>
      <input type="text" id="opp-api-account-search" placeholder="Buscar por nombre o ID…" value="${escapeHtml(a.accountSearch || '')}" style="width:380px" />
      <div style="width:380px;max-height:230px;overflow:auto;border:1px solid var(--gray-200);border-radius:8px;padding:6px 12px;margin-top:6px;background:var(--white)">${accountList}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <button class="btn-outline xs" data-action="opp-acct-all" ${canMarkAll ? '' : 'disabled'} title="${canMarkAll ? '' : `Se pueden marcar todas solo cuando hay ${OPP_MAX_ACCOUNTS} o menos a la vista`}">Marcar las ${matches.length} a la vista</button>
        <button class="btn-outline xs" data-action="opp-acct-none" ${a.accountIds.length ? '' : 'disabled'}>Quitar marcas</button>
        <span class="footnote">${a.accountIds.length} marcada${a.accountIds.length === 1 ? '' : 's'} · máximo ${OPP_MAX_ACCOUNTS} por análisis${matches.length > shown.length ? ` · mostrando ${shown.length} de ${matches.length}, afina la búsqueda` : ''}</span>
      </div>
    </div>

    <div class="field">
      <label>...o escribe el ID de la cuenta</label>
      <input type="text" id="opp-api-account-manual" value="${escapeHtml(a.accountIdManual)}" placeholder="ej. 6862893390" style="width:160px" />
    </div>
    <div style="display:flex;gap:24px;flex-wrap:nowrap">
      <div class="field">
        <label>Desde</label>
        <input type="date" id="opp-api-date-from" value="${escapeHtml(a.dateFrom)}" />
      </div>
      <div class="field">
        <label>Hasta</label>
        <input type="date" id="opp-api-date-to" value="${escapeHtml(a.dateTo)}" />
      </div>
    </div>
    <div class="field">
      <label style="display:flex;align-items:center;gap:8px;font-weight:400">
        <input type="checkbox" id="opp-api-only-active" ${a.onlyActive ? 'checked' : ''} />
        Solo campañas activas
      </label>
    </div>
    <button class="btn-accent" data-action="opp-api-fetch">Traer datos de Google Ads</button>
    ${a.error ? `<div class="error-panel" style="margin-top:10px"><strong>No se pudo traer el reporte.</strong> ${escapeHtml(a.error)}</div>` : ''}
    ${a.partial && a.partial.length ? `<div class="error-panel" style="margin-top:10px"><strong>${a.partial.length === 1 ? 'Una cuenta no se pudo traer y quedó fuera del análisis:' : `${a.partial.length} cuentas no se pudieron traer y quedaron fuera del análisis:`}</strong><ul style="margin:6px 0 0 18px">${a.partial.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></div>` : ''}
  `;
}

// El export de Google Ads no trae una columna de hotel/propiedad — se
// deriva del nombre de campaña, tomando lo que hay antes del primer
// " - " (así vienen nombradas las cuentas reales, ej. "Estelar Hoteles -
// CO:es - PMAX Corpo" → hotel "Estelar Hoteles"). Si el nombre no tiene
// ese separador, se usa el nombre completo.
function deriveHotelName(campaign) {
  const idx = campaign.indexOf(' - ');
  return idx > -1 ? campaign.slice(0, idx).trim() : campaign.trim();
}

function getOpportunityFilteredRows() {
  const s = state.opportunity;
  let rows = s.rows || [];
  if (s.hotelFilter !== 'all') rows = rows.filter((r) => deriveHotelName(r.campaign) === s.hotelFilter);
  if (s.typeFilter.length) rows = rows.filter((r) => s.typeFilter.includes(r.campaign_type));
  // Elegir una campaña específica, o el tipo "Search (marca)", es una decisión explícita
  // del usuario: se muestra igual aunque sea de marca, no la tapa el checkbox de excluir.
  if (s.campaignFilter !== 'all') return rows.filter((r) => r.campaign === s.campaignFilter);
  return s.excludeBrand && !s.typeFilter.includes('search_brand') ? rows.filter((r) => r.campaign_type !== 'search_brand') : rows;
}

// Datos del resultado de Oportunidad de ingresos tal como se ven en pantalla (filtros aplicados y
// tabla en el mismo orden): los comparten la descarga en CSV y el informe en HTML.
function opportunityResultData() {
  const s = state.opportunity;
  const rows = getOpportunityFilteredRows();
  const summary = engine.summarizeRevenueOpportunity(rows);
  const keyFn = OPP_SORT_KEYS[s.sortBy] || OPP_SORT_KEYS.revenue_lost;
  const opps = summary.opportunities.filter((o) => o.has_data).sort((a, b) => {
    const va = keyFn(a), vb = keyFn(b);
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : (va - vb);
    return s.sortDir === 'asc' ? cmp : -cmp;
  });
  const typeLabel = (t) => engine.CAMPAIGN_TYPE_LABELS[t] || t || 'N/D';
  const filters = [
    ['Origen', s.fileName || ''],
    ['Hotel', s.hotelFilter === 'all' ? 'Todos' : s.hotelFilter],
    ['Tipo de campaña', s.typeFilter.length ? s.typeFilter.map(typeLabel).join(' + ') : 'Todos'],
    ['Campaña', s.campaignFilter === 'all' ? 'Todas las seleccionadas' : s.campaignFilter],
    ['Campañas de marca', s.excludeBrand ? 'Excluidas' : 'Incluidas'],
  ];
  const trend = s.source === 'api' && s.isTrend.status === 'ready' && s.isTrend.rows
    ? engine.aggregateImpressionShareDaily(s.isTrend.rows, new Set(rows.map((r) => r.campaign))) : [];
  return { summary, opps, filters, typeLabel, trend, funnel: engine.buildOpportunityFunnel(summary.opportunities) };
}

// CSV: resumen con los filtros arriba y, debajo, la tabla de campañas con una fila TOTAL.
function downloadOpportunityResult() {
  const { summary, opps, filters, typeLabel } = opportunityResultData();
  const num = (v, d = 2) => (v == null || Number.isNaN(v) ? '' : Number(v).toFixed(d));
  const pct = (v) => (v == null || Number.isNaN(v) ? '' : (v * 100).toFixed(1));
  const sum = (f) => opps.reduce((acc, o) => acc + (Number.isNaN(f(o)) || f(o) == null ? 0 : f(o)), 0);
  const data = [
    ['Oportunidad de ingresos'],
    ...filters,
    [],
    ['Ingresos que se habrían ganado', num(summary.revenue_lost)],
    ['Inversión adicional necesaria', summary.extra_budget != null ? num(summary.extra_budget) : 'N/D'],
    ['ROAS promedio (%)', summary.roas != null ? num(summary.roas * 100, 0) : 'N/D'],
    ['Conversiones perdidas', num(summary.conversions_lost, 0)],
    ['Gasto total', num(summary.total_cost)],
    ['Valor de conversión total', num(summary.total_conv_value)],
    [],
    ['Campaña', 'Tipo', 'Estrategia', 'ROAS (%)', 'Impression share (%)', 'Perdido por ranking (%)', 'Perdido por presupuesto (%)', 'Ingresos perdidos', 'Gasto', 'Conversiones', 'Conversiones perdidas'],
    ...opps.map((o) => [
      o.campaign, typeLabel(o.campaign_type), o.bid_strategy || 'N/D',
      o.campaign_roas != null ? num(o.campaign_roas * 100, 0) : '',
      pct(o.impr_share), pct(o.lost_is_rank), pct(o.lost_is_budget),
      num(o.revenue_lost), num(o.cost), num(o.conversions, 1), num(o.conversions_lost, 1),
    ]),
    ['TOTAL', '', '', '', '', '', '', num(sum((o) => o.revenue_lost)), num(sum((o) => o.cost)), num(sum((o) => o.conversions), 1), num(sum((o) => o.conversions_lost), 1)],
  ];
  engine.downloadCsv(`oportunidad_ingresos_${new Date().toISOString().slice(0, 10)}.csv`, data);
}

// Gráficas del informe HTML de Oportunidad de ingresos. Son versiones autosuficientes de las de la
// pantalla (colores literales y sin variables de la app), para que se vean igual fuera de la plataforma.
function oppReportFunnelHtml(f) {
  if (!f.has_data) return '';
  const e = escapeHtml;
  const pct0 = (v) => `${(v * 100).toFixed(0)}%`;
  const box = (label, value, hl) => `<div style="border:1px solid ${hl ? '#1d6b41' : '#e3e6ec'};background:${hl ? '#e3f4ea' : '#fff'};border-radius:12px;padding:10px 14px;text-align:center"><div style="font-size:12px;color:#6b7280">${e(label)}</div><div style="font-size:18px;font-weight:800;color:${hl ? '#1d6b41' : '#14213d'}">${e(value)}</div></div>`;
  const pill = (label, value, bg, fg) => `<div style="text-align:center"><span style="display:inline-block;background:${bg};color:${fg};border-radius:999px;padding:4px 14px;font-size:12px;font-weight:700">${e(label)}: ${e(value)}</span></div>`;
  const col = (title, border, bg, color, nodes) => `<div style="border:1.5px solid ${border};background:${bg};border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:8px"><div style="text-align:center;font-weight:800;color:${color};text-transform:uppercase;font-size:11.5px;letter-spacing:.04em;margin-bottom:6px">${e(title)}</div>${nodes.join('')}</div>`;
  const red = ['#d23c3c', '#fbe3e1'], green = ['#1d6b41', '#e3f4ea'];
  const left = col('Escenario actual · con límite de presupuesto', '#f0c4c0', '#fdf3f2', '#a8231f', [
    box('Inversión', fmtMoney(f.investment)), box('Total de búsquedas', fmtInt(f.totalQueries)),
    pill('Perdido por presupuesto', pct0(f.lostIsBudgetPct), red[1], '#a8231f'), box('Búsquedas disponibles', fmtInt(f.availableQueries)),
    pill('Impression Share', pct0(f.imprSharePct), red[1], '#a8231f'), box('Impresiones', fmtInt(f.impressions)),
    box('Clics', fmtInt(f.clicks)), box('Conversiones', fmtInt(f.conversions)), box('Valor de conversión', fmtMoney(f.convValue), true)]);
  const right = col('Escenario sin límite de presupuesto', '#bfe3cd', '#f1faf4', '#1d6b41', [
    box('Inversión estimada', f.extraBudget != null ? fmtMoney(f.investmentUnconstrained) : 'N/D'), box('Total de búsquedas', fmtInt(f.totalQueries)),
    pill('Perdido por presupuesto', '0%', green[1], green[0]), box('Búsquedas disponibles', fmtInt(f.totalQueries)),
    pill('Impression Share potencial', pct0(f.potentialImprSharePct), green[1], green[0]), box('Impresiones potenciales', fmtInt(f.potentialImpressions)),
    box('Clics potenciales', fmtInt(f.potentialClicks)), box('Conversiones potenciales', fmtInt(f.potentialConversions)), box('Valor de conversión potencial', fmtMoney(f.potentialConvValue), true)]);
  return `<div class="ar-block"><h2 class="ar-h2">De dónde venimos y a dónde podríamos llegar</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">${left}${right}</div></div>`;
}

function oppReportShareBarsHtml(opps) {
  const rows = opps.filter((o) => !Number.isNaN(o.impr_share));
  if (!rows.length) return '';
  const e = escapeHtml;
  const sorted = [...rows].sort((a, b) => (b.lost_is_budget || 0) - (a.lost_is_budget || 0));
  const bar = (label, v, color) => `<div style="display:flex;align-items:center;gap:10px;margin-top:5px"><div style="width:170px;font-size:12.5px;color:#6b7280;flex:none">${e(label)}</div><div style="flex:1;height:10px;background:#eceff4;border-radius:999px;overflow:hidden"><div style="width:${((v || 0) * 100).toFixed(1)}%;height:100%;background:${color}"></div></div><div style="width:40px;text-align:right;font-size:12.5px;font-weight:700;flex:none">${((v || 0) * 100).toFixed(0)}%</div></div>`;
  const groups = sorted.map((o) => `<div style="margin-bottom:18px"><div style="font-weight:700;font-size:13.5px">${e(o.campaign)}</div>${bar('Impr. Share', o.impr_share, '#c5c9d3')}${bar('Perdido por ranking', o.lost_is_rank, '#ff9800')}${bar('Perdido por presupuesto', o.lost_is_budget, '#d23c3c')}</div>`).join('');
  return `<div class="ar-block"><h2 class="ar-h2">Impression Share: presupuesto contra ranking<small>Ordenado de mayor a menor % perdido por presupuesto: ahí está la oportunidad de subir presupuesto.</small></h2><div class="ar-card">${groups}</div></div>`;
}

function oppReportTrendHtml(dailyRows) {
  const rows = (dailyRows || []).filter((r) => r.impr_share != null || r.lost_is_budget != null || r.lost_is_rank != null);
  if (rows.length < 2) return '';
  const e = escapeHtml;
  const W = 680, H = 230, ML = 42, MR = 16, MT = 14, MB = 28;
  const plotW = W - ML - MR, plotH = H - MT - MB, n = rows.length;
  const x = (i) => ML + (i / (n - 1)) * plotW;
  const y = (v) => MT + plotH - Math.max(0, Math.min(1, v || 0)) * plotH;
  const series = [
    { key: 'lost_is_budget', label: 'Perdido por presupuesto', color: '#d23c3c' },
    { key: 'lost_is_rank', label: 'Perdido por ranking', color: '#ff9800' },
    { key: 'impr_share', label: 'Impr. Share', color: '#7d8798' },
  ];
  const lines = series.map((sr) => {
    const pts = rows.map((r, i) => ({ i, v: r[sr.key] })).filter((p) => p.v != null);
    if (pts.length < 2) return '';
    const path = pts.map((p, k) => `${k === 0 ? 'M' : 'L'} ${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    return `<path d="${path}" fill="none" stroke="${sr.color}" stroke-width="2.5" />`;
  }).join('');
  const grid = [0, 0.25, 0.5, 0.75, 1].map((fr) => `<line x1="${ML}" y1="${y(fr).toFixed(1)}" x2="${W - MR}" y2="${y(fr).toFixed(1)}" stroke="#e3e6ec" stroke-width="1" /><text x="${ML - 6}" y="${(y(fr) + 3).toFixed(1)}" font-size="10" fill="#6b7280" text-anchor="end">${(fr * 100).toFixed(0)}%</text>`).join('');
  const every = Math.max(1, Math.ceil(n / 8));
  const xl = rows.map((r, i) => ({ r, i })).filter(({ i }) => i % every === 0).map(({ r, i }) => {
    const d = new Date(`${r.date}T00:00:00`);
    const label = Number.isNaN(d.getTime()) ? r.date : d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
    return `<text x="${x(i).toFixed(1)}" y="${H - 8}" font-size="10" fill="#6b7280" text-anchor="middle">${e(label)}</text>`;
  }).join('');
  const legend = series.map((sr) => `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:16px;font-size:12.5px"><span style="width:10px;height:10px;border-radius:2px;background:${sr.color};display:inline-block"></span>${e(sr.label)}</span>`).join('');
  return `<div class="ar-block"><h2 class="ar-h2">Evolución de Impression Share<small>Vista de cuenta día a día, ponderada por impresiones de campañas Search.</small></h2>
    <div class="ar-card"><div style="margin-bottom:10px">${legend}</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Evolución diaria de Impression Share">${grid}${lines}${xl}</svg></div></div>`;
}

// Informe en HTML: un solo archivo, con el mismo estilo del informe de la auditoría
// (AUDIT_REPORT_CSS) — se abre en cualquier navegador y se guarda como PDF con Ctrl+P.
function opportunityReportBodyHtml() {
  const { summary, opps, filters, typeLabel, trend, funnel: f } = opportunityResultData();
  const e = escapeHtml;
  const pct0 = (v) => (v == null || Number.isNaN(v) ? 'N/D' : `${(v * 100).toFixed(0)}%`);
  const metric = (label, value) => `<div class="ar-metric"><div class="ar-metric-l">${e(label)}</div><div class="ar-metric-v">${e(value)}</div></div>`;
  const sumOf = (fn) => opps.reduce((acc, o) => acc + (fn(o) == null || Number.isNaN(fn(o)) ? 0 : fn(o)), 0);

  const small = (t) => `<div style="font-weight:400;font-size:11.5px;color:#6b7280;margin-top:2px">${e(t)}</div>`;
  const body = opps.map((o) => `<tr>
    <td>${e(o.campaign)}${small(`${typeLabel(o.campaign_type)} · ${(o.bid_strategy || 'N/D').replace(/_/g, ' ')}`)}</td>
    <td>${o.campaign_roas != null ? `${(o.campaign_roas * 100).toFixed(0)}%` : 'N/D'}</td>
    <td>${pct0(o.impr_share)}</td><td>${pct0(o.lost_is_rank)}</td><td>${pct0(o.lost_is_budget)}</td>
    <td>${e(fmtMoney(o.revenue_lost))}</td><td>${e(fmtMoney(o.cost))}</td><td>${e(fmtInt(o.conversions))}</td><td>${e(fmtInt(o.conversions_lost))}</td></tr>`).join('');
  const total = `<tr><td><strong>Total</strong></td><td></td><td></td><td></td><td></td>
    <td><strong>${e(fmtMoney(sumOf((o) => o.revenue_lost)))}</strong></td><td><strong>${e(fmtMoney(sumOf((o) => o.cost)))}</strong></td>
    <td><strong>${e(fmtInt(sumOf((o) => o.conversions)))}</strong></td><td><strong>${e(fmtInt(sumOf((o) => o.conversions_lost)))}</strong></td></tr>`;

  return `
    <div class="ar">
      <div class="ar-eyebrow">Oportunidad de ingresos</div>
      <div class="ar-title">Cuánto se dejó de ganar por límite de presupuesto</div>
      <div class="ar-sub">${filters.map(([k, v]) => `${e(k)}: <strong>${e(v)}</strong>`).join(' · ')} · Generado ${new Date().toISOString().slice(0, 10)}</div>
      <div class="ar-card" style="text-align:center">
        <div class="ar-eyebrow" style="color:#6b7280">Podrías haber incrementado tus ingresos en</div>
        <div class="ar-title" style="color:#1d6b41;margin:6px 0 0">${e(fmtMoney(summary.revenue_lost))}</div>
      </div>
      <div class="ar-block"><div class="ar-grid">
        ${metric('Si hubieras invertido', summary.extra_budget != null ? `${fmtMoney(summary.extra_budget)} adicional` : 'N/D')}
        ${metric('Asumiendo un ROAS de', summary.roas != null ? `${(summary.roas * 100).toFixed(0)}%` : 'N/D')}
        ${metric('Conversiones perdidas', fmtInt(summary.conversions_lost))}
        ${metric('Gasto del periodo', fmtMoney(summary.total_cost))}
        ${metric('Valor de conversión', fmtMoney(summary.total_conv_value))}
      </div></div>
      ${oppReportFunnelHtml(f)}
      ${oppReportTrendHtml(trend)}
      ${oppReportShareBarsHtml(opps)}
      <div class="ar-block"><h2 class="ar-h2">Campañas con mayor oportunidad de presupuesto<small>IS = Impression Share · LR = perdido por ranking · LB = perdido por presupuesto</small></h2>
      <div class="ar-card"><div class="ar-tw"><table class="ar-tbl ar-compact"><thead><tr><th style="min-width:190px">Campaña</th><th>ROAS</th><th>IS</th><th>LR</th><th>LB</th><th>Ingresos perdidos</th><th>Gasto</th><th>Conv.</th><th>Conv. perdidas</th></tr></thead>
      <tbody>${body}${total}</tbody></table></div></div></div>
      <div class="ar-note">Es un análisis retrospectivo, no una predicción: para cada campaña asume el mismo Ad Auction Win Rate y la misma tasa de conversión que ya tiene, y calcula qué habría pasado sin el límite de presupuesto. La inversión adicional se calcula con el ROAS promedio de las campañas incluidas.</div>
      <div class="ar-foot">Generado con Paid Media Helper a partir de datos de Google Ads. Las cifras son las que reporta Google Ads: no verifican reservas reales ni ingresos finales del hotel.</div>
    </div>`;
}

function buildOpportunityHtml() {
  return withMoneyCurrency(state.opportunity.source === 'api' ? state.opportunity.currency : null, () => buildOpportunityHtmlBody());
}

function buildOpportunityHtmlBody() {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oportunidad de ingresos</title>
${themedFontsLink(PLUS_JAKARTA_HREF)}
<style>body{margin:0;padding:40px 20px;background:#f4f5f8}@media print{body{background:#fff;padding:0}@page{margin:14mm}}${AUDIT_REPORT_CSS}.ar-compact th,.ar-compact td{padding:7px 6px;font-size:12.5px}</style>
</head><body>${opportunityReportBodyHtml()}</body></html>`;
}

function downloadOpportunityHtml() {
  downloadTextFile(buildOpportunityHtml(), `oportunidad_ingresos_${new Date().toISOString().slice(0, 10)}.html`, 'text/html');
}

function renderOpportunityPage() {
  return withMoneyCurrency(state.opportunity.source === 'api' ? state.opportunity.currency : null, () => renderOpportunityPageBody());
}

function renderOpportunityPageBody() {
  const s = state.opportunity;

  // El campo de palabras de marca solo se muestra subiendo archivo — en modo
  // API se usa el valor que ya tenga guardado, mismo criterio que Rendimiento.
  const brandKeywordsField = s.source === 'file' ? `
      <div class="field">
        <label>Palabras que identifican una campaña de marca (separadas por coma)</label>
        <input type="text" id="opp-brand-keywords" value="${escapeHtml(s.brandKeywords)}" style="width:320px" />
      </div>` : '';

  const controlPanel = `
    <div class="card control-panel align-end">
      ${brandKeywordsField}
      <div class="seg-control">
        <button class="seg-btn ${s.source === 'file' ? 'active' : ''}" data-action="opp-source-file">Subir archivo</button>
        <button class="seg-btn ${s.source === 'api' ? 'active' : ''}" data-action="opp-source-api">Conectar Google Ads</button>
      </div>
      ${s.source === 'file' ? `
        <div class="field">
          <label>Export de campañas (CSV o Excel)</label>
          <input type="file" id="opp-file" accept=".csv,.xlsx,.xls" />
        </div>
        <button class="btn-outline" data-action="opp-demo">Usar ejemplo</button>
        ${s.fileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.fileName)}</strong></div>` : ''}
      ` : renderOpportunityApiPanel()}
    </div>`;

  let body = '';
  if (s.status === 'idle') {
    body = `
      <div class="card state-panel idle">
        ${icon('trending-up', 30)}
        <p>Esperando datos. Además de las columnas/campos habituales de Rendimiento, necesita "Search Impr. Share" y "Valor de conv." para poder calcular la oportunidad — sube un archivo, usa el ejemplo, o conecta Google Ads.</p>
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
    body = renderOpportunityReady();
  }

  return `${controlPanel}${body}`;
}

// Nodo tipo "píldora" con borde punteado — para tasas/porcentajes (Search
// Lost IS, Impression Share), igual que en la referencia.
function funnelPill(label, value, color) {
  return `
    <div style="background:#fff;border:2px dashed ${color};border-radius:999px;padding:6px 16px;text-align:center;min-width:130px">
      <div style="font-size:9.5px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.03em;line-height:1.2">${escapeHtml(label)}</div>
      <div style="font-size:15px;font-weight:700;color:${color}">${value}</div>
    </div>`;
}
// Nodo tipo caja sólida — para cantidades y montos (búsquedas, impresiones,
// clics, conversiones, valor de conversión).
function funnelBox(label, value, big) {
  return `
    <div style="background:#fff;border:1px solid var(--color-border);border-radius:10px;padding:${big ? '10px 18px' : '6px 16px'};text-align:center;min-width:130px">
      <div style="font-size:9.5px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.03em;line-height:1.2">${escapeHtml(label)}</div>
      <div style="font-size:${big ? '18px' : '15px'};font-weight:700;color:var(--color-text-heading)">${value}</div>
    </div>`;
}
// Une los nodos con una línea vertical continua detrás (una "columna
// vertebral"), para que el flujo se lea de un vistazo en vez de ser solo
// texto apilado.
function funnelColumn(nodesHtml, lineColor) {
  return `
    <div style="position:relative">
      <div style="position:absolute;left:50%;top:4px;bottom:4px;width:2px;background:${lineColor};opacity:.45;transform:translateX(-50%)"></div>
      <div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:14px">
        ${nodesHtml}
      </div>
    </div>`;
}
function funnelConnector(height) {
  return `<div style="width:2px;height:${height || 16}px;background:var(--color-border)"></div>`;
}

// Diagrama "de dónde venimos, a dónde podríamos llegar": mismo embudo de
// la referencia que trajo cesar, con los números reales de las campañas
// seleccionadas — escenario actual (con límite de presupuesto) a la
// izquierda, escenario sin límite a la derecha, con la misma tasa de
// victoria en subasta y la misma tasa de conversión en ambos. Los nodos
// van conectados por una línea continua para que se lea como un flujo,
// no como una lista de números sueltos.
function renderOpportunityFunnel(f) {
  if (!f.has_data) return '';
  const pct = (v) => (v * 100).toFixed(0) + '%';

  const leftNodes = [
    funnelBox('Inversión', fmtMoney(f.investment)),
    funnelBox('Total de búsquedas', fmtInt(f.totalQueries)),
    funnelPill('Perdido por presupuesto', pct(f.lostIsBudgetPct), 'var(--danger)'),
    funnelBox('Búsquedas disponibles', fmtInt(f.availableQueries)),
    funnelPill('Impression Share', pct(f.imprSharePct), 'var(--danger)'),
    funnelBox('Impresiones', fmtInt(f.impressions)),
    funnelBox('Clics', fmtInt(f.clicks)),
    funnelBox('Conversiones', fmtInt(f.conversions)),
    funnelBox('Valor de conversión', fmtMoney(f.convValue), true),
  ].join('');

  const rightNodes = [
    funnelBox('Inversión estimada', f.extraBudget != null ? fmtMoney(f.investmentUnconstrained) : 'N/D'),
    funnelBox('Total de búsquedas', fmtInt(f.totalQueries)),
    funnelPill('Perdido por presupuesto', '0%', 'var(--ok-text)'),
    funnelBox('Búsquedas disponibles', fmtInt(f.totalQueries)),
    funnelPill('Impression Share potencial', pct(f.potentialImprSharePct), 'var(--ok-text)'),
    funnelBox('Impresiones potenciales', fmtInt(f.potentialImpressions)),
    funnelBox('Clics potenciales', fmtInt(f.potentialClicks)),
    funnelBox('Conversiones potenciales', fmtInt(f.potentialConversions)),
    funnelBox('Valor de conversión potencial', fmtMoney(f.potentialConvValue), true),
  ].join('');

  const left = `
    <div style="border:1.5px solid var(--danger-border);border-radius:12px;padding:18px;background:var(--danger-bg)">
      <div style="text-align:center;font-weight:700;color:var(--danger);text-transform:uppercase;font-size:11.5px;letter-spacing:.04em;margin-bottom:16px">Escenario actual · con límite de presupuesto</div>
      ${funnelColumn(leftNodes, 'var(--danger)')}
    </div>`;

  const right = `
    <div style="border:1.5px solid var(--ok-border);border-radius:12px;padding:18px;background:var(--ok-bg)">
      <div style="text-align:center;font-weight:700;color:var(--ok-text);text-transform:uppercase;font-size:11.5px;letter-spacing:.04em;margin-bottom:16px">Sin límite de presupuesto</div>
      ${funnelColumn(rightNodes, 'var(--ok-text)')}
    </div>`;

  return `
    <div class="card chart-card">
      <h3 class="dense-chart-title">De dónde venimos, a dónde podríamos llegar</h3>
      <p style="font-size:12.5px;color:var(--color-text-muted);margin-bottom:14px">Mismo Ad Auction Win Rate y misma tasa de conversión en ambos escenarios — la diferencia es solo no perder búsquedas por presupuesto. Sigue la línea de cada columna de arriba hacia abajo.</p>
      <div style="background:var(--gray-50);border:1px solid var(--color-border);border-radius:10px;padding:14px 16px;margin-bottom:18px;font-size:12.5px;color:var(--color-text-body);line-height:1.5">
        <strong style="color:var(--color-text-heading)">¿De dónde salen "Total de búsquedas" y "Búsquedas disponibles"?</strong>
        Google Ads no entrega el total de búsquedas directamente — se reconstruye a partir de datos reales: si tuviste 296,000 impresiones y eso fue el 89% de las búsquedas posibles (Impression Share), el total era 296,000 ÷ 0,89 ≈ 332,600 (<strong>Total de búsquedas = Impresiones ÷ Impression Share</strong>).
        De ese total, una parte no llegó ni a competir porque el presupuesto diario ya se había agotado — eso es el "% perdido por presupuesto". El resto sí compitió: esas son las <strong>Búsquedas disponibles = Total de búsquedas × (1 − % perdido por presupuesto)</strong>.
        De ahí sale la Tasa de victoria en subasta (Impresiones ÷ Búsquedas disponibles) — el número clave que se asume igual en el escenario sin límite de presupuesto.
      </div>
      <div class="two-col">
        ${left}
        ${right}
      </div>
      <div style="display:flex;flex-direction:column;align-items:center">
        ${funnelConnector(18)}
        <div style="border:2px solid var(--navy-800);border-radius:999px;padding:8px 20px;font-weight:700;color:var(--navy-800);background:#fff;font-size:13px">
          Tasa de victoria en subasta: ${pct(f.adAuctionWinRate)} (igual en los dos escenarios)
        </div>
        ${funnelConnector(18)}
      </div>
      <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap">
        <div style="background:var(--accent-500);color:var(--navy-900);padding:14px 22px;border-radius:10px;text-align:center;min-width:190px">
          <div style="font-size:11px;text-transform:uppercase;font-weight:600">Conversiones perdidas por presupuesto</div>
          <div style="font-size:24px;font-weight:700;margin-top:4px">${fmtInt(f.conversionsLost)}</div>
        </div>
        <div style="background:var(--accent-600);color:#fff;padding:14px 22px;border-radius:10px;text-align:center;min-width:190px">
          <div style="font-size:11px;text-transform:uppercase;font-weight:600">Ingresos perdidos por presupuesto</div>
          <div style="font-size:24px;font-weight:700;margin-top:4px">${fmtMoney(f.revenueLost)}</div>
        </div>
      </div>
    </div>`;
}

// Gráfica de tendencia de Impression Share día a día — mismo estilo SVG sin
// librerías externas que el gráfico de Proyección de ventas (renderForecastChart),
// simplificado: tres líneas en escala 0-100%, sin banda de rango ni
// proyección. Reutiliza las clases .forecast-hover-col/.forecast-tooltip/
// .forecast-hover-guide tal cual — el wiring de hover en bindEvents ya es
// genérico (busca esas clases en cualquier parte de la página), así que no
// hace falta JS nuevo para el tooltip. Solo existe en modo API: un CSV
// nativo de campañas no trae desglose por día.
function renderImpressionShareTrendChart(dailyRows) {
  const rows = (dailyRows || []).filter((r) => r.impr_share != null || r.lost_is_budget != null || r.lost_is_rank != null);
  if (rows.length < 2) return '';

  const W = 680, H = 220, ML = 40, MR = 16, MT = 16, MB = 26;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const n = rows.length;

  const x = (i) => ML + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v) => MT + plotH - (Math.max(0, Math.min(1, v || 0)) * plotH);

  const series = [
    { key: 'lost_is_budget', label: 'Perdido por presupuesto', color: 'var(--danger)' },
    { key: 'lost_is_rank', label: 'Perdido por ranking', color: themed('#3b82f6', '#ff9800') },
    { key: 'impr_share', label: 'Impr. Share', color: 'var(--gray-500)' },
  ];

  const linesHtml = series.map((s) => {
    const pts = rows.map((r, i) => ({ i, v: r[s.key] })).filter((p) => p.v != null);
    if (pts.length < 2) return '';
    const path = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    return `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.5" />`;
  }).join('');

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    const yy = y(frac);
    return `<line x1="${ML}" y1="${yy.toFixed(1)}" x2="${W - MR}" y2="${yy.toFixed(1)}" stroke="var(--color-border)" stroke-width="1" />
      <text x="${ML - 6}" y="${(yy + 3).toFixed(1)}" font-size="10" fill="var(--color-text-muted)" text-anchor="end">${(frac * 100).toFixed(0)}%</text>`;
  }).join('');

  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const xLabels = rows.map((r, i) => ({ r, i })).filter(({ i }) => i % labelEvery === 0).map(({ r, i }) => {
    const d = new Date(`${r.date}T00:00:00`);
    const label = Number.isNaN(d.getTime()) ? r.date : d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
    return `<text x="${x(i).toFixed(1)}" y="${H - 6}" font-size="10" fill="var(--color-text-muted)" text-anchor="middle">${escapeHtml(label)}</text>`;
  }).join('');

  const colStep = n > 1 ? plotW / (n - 1) : plotW;
  const hoverCols = rows.map((r, i) => {
    const d = new Date(`${r.date}T00:00:00`);
    const dateLabel = Number.isNaN(d.getTime()) ? r.date : d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
    const lines = [dateLabel];
    if (r.impr_share != null) lines.push(`Impr. Share: ${(r.impr_share * 100).toFixed(1)}%`);
    if (r.lost_is_rank != null) lines.push(`Perdido por ranking: ${(r.lost_is_rank * 100).toFixed(1)}%`);
    if (r.lost_is_budget != null) lines.push(`Perdido por presupuesto: ${(r.lost_is_budget * 100).toFixed(1)}%`);
    const rectX = (x(i) - colStep / 2).toFixed(1);
    return `<rect class="forecast-hover-col" x="${rectX}" y="${MT}" width="${colStep.toFixed(1)}" height="${plotH}" fill="transparent" data-x="${x(i).toFixed(1)}" data-tooltip="${escapeHtml(lines.join('\n'))}"></rect>`;
  }).join('');

  const legendHtml = series.map((s) => `
    <span style="display:inline-flex;align-items:center;gap:6px;margin-right:16px;font-size:12px;color:var(--color-text-body)">
      <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color}"></span>${escapeHtml(s.label)}
    </span>`).join('');

  return `
    <div class="card chart-card">
      <h3 class="dense-chart-title">Evolución de Impression Share</h3>
      <p style="font-size:12.5px;color:var(--color-text-muted);margin-bottom:10px">Vista de cuenta día a día, ponderada por impresiones de campañas Search (Impression Share solo existe para ese tipo de campaña).</p>
      <div style="margin-bottom:10px">${legendHtml}</div>
      <div style="position:relative">
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:240px;display:block" xmlns="http://www.w3.org/2000/svg">
          ${gridLines}
          ${linesHtml}
          <line class="forecast-hover-guide" x1="0" y1="${MT}" x2="0" y2="${H - MB}" stroke="var(--navy-800)" stroke-width="1" style="opacity:0" />
          ${xLabels}
          ${hoverCols}
        </svg>
        <div class="forecast-tooltip"></div>
      </div>
    </div>`;
}

// Gráfica de Impression Share por campaña: Impr. Share vs. % perdido por
// ranking vs. % perdido por presupuesto — la campaña con el rojo más alto
// es donde está la oportunidad de subir presupuesto (mismo criterio que
// la gráfica 3 de la referencia que trajo cesar). Se ordena de mayor a
// menor "perdido por presupuesto" para identificarla rápido.
function renderImprShareChart(rows) {
  const withShare = rows.filter((r) => !Number.isNaN(r.impr_share));
  if (!withShare.length) return '';
  const sorted = [...withShare].sort((a, b) => (b.lost_is_budget || 0) - (a.lost_is_budget || 0));
  const groups = sorted.map((r) => {
    const bars = [
      { label: 'Impr. Share', value: r.impr_share || 0, color: 'var(--gray-300)' },
      { label: 'Perdido por ranking', value: r.lost_is_rank || 0, color: themed('#3b82f6', '#ff9800') },
      { label: 'Perdido por presupuesto', value: r.lost_is_budget || 0, color: 'var(--danger)' },
    ];
    const barsHtml = bars.map((b) => `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(b.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(b.value * 100).toFixed(1)}%;background:${b.color}"></div></div>
        <div class="bar-value">${(b.value * 100).toFixed(0)}%</div>
      </div>`).join('');
    return `
      <div style="margin-bottom:18px">
        <div style="font-weight:600;font-size:13px;color:var(--color-text-heading);margin-bottom:6px">${escapeHtml(r.campaign)}</div>
        <div class="bar-rows compact">${barsHtml}</div>
      </div>`;
  }).join('');

  return `
    <div class="card chart-card">
      <h3 class="dense-chart-title">Impression Share: presupuesto vs. ranking</h3>
      <p style="font-size:12.5px;color:var(--color-text-muted);margin-bottom:12px">Ordenado de mayor a menor % perdido por presupuesto — ahí está la oportunidad de subir presupuesto.</p>
      ${groups}
    </div>`;
}

// Columnas ordenables de la tabla de acción — click en el encabezado
// ordena por esa métrica, un segundo click invierte el orden.
const OPP_SORT_KEYS = {
  campaign: (o) => o.campaign.toLowerCase(),
  bid_strategy: (o) => (o.bid_strategy || '').toLowerCase(),
  campaign_roas: (o) => o.campaign_roas ?? -Infinity,
  impr_share: (o) => o.impr_share ?? -Infinity,
  lost_is_rank: (o) => o.lost_is_rank ?? -Infinity,
  lost_is_budget: (o) => o.lost_is_budget ?? -Infinity,
  revenue_lost: (o) => o.revenue_lost,
  cost: (o) => o.cost ?? -Infinity,
  conversions: (o) => o.conversions ?? -Infinity,
  conversions_lost: (o) => o.conversions_lost,
};
function oppSortTh(label, key, s) {
  const active = s.sortBy === key;
  const arrow = active ? (s.sortDir === 'desc' ? ' ▼' : ' ▲') : '';
  return `<th data-opp-sort="${key}" style="cursor:pointer;user-select:none${active ? ';color:var(--color-text-heading)' : ''}">${escapeHtml(label)}${arrow}</th>`;
}

function renderOpportunityReady() {
  const s = state.opportunity;
  const allRows = s.rows || [];
  const allHotels = [...new Set(allRows.map((r) => deriveHotelName(r.campaign)))].sort((a, b) => a.localeCompare(b));
  const hotelFilteredRows = s.hotelFilter === 'all' ? allRows : allRows.filter((r) => deriveHotelName(r.campaign) === s.hotelFilter);
  const typeFilteredRows = s.typeFilter.length ? hotelFilteredRows.filter((r) => s.typeFilter.includes(r.campaign_type)) : hotelFilteredRows;
  const allCampaignNames = [...new Set(typeFilteredRows.map((r) => r.campaign))].sort((a, b) => a.localeCompare(b));
  const typeOrder = Object.keys(engine.CAMPAIGN_TYPE_LABELS);
  const presentTypes = [...new Set(allRows.map((r) => r.campaign_type).filter(Boolean))]
    .sort((a, b) => (typeOrder.indexOf(a) + 1 || 99) - (typeOrder.indexOf(b) + 1 || 99));
  const typeChip = (on, attrs, label) => `<button class="${on ? 'btn-accent' : 'btn-outline'} xs" ${attrs} aria-pressed="${on}">${escapeHtml(label)}</button>`;
  const typeFieldHtml = presentTypes.length > 1 ? `
      <div class="field">
        <label>Tipo de campaña</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${typeChip(!s.typeFilter.length, 'data-opp-type="__all"', 'Todos')}
          ${presentTypes.map((t) => typeChip(s.typeFilter.includes(t), `data-opp-type="${escapeHtml(t)}"`, engine.CAMPAIGN_TYPE_LABELS[t] || t)).join('')}
        </div>
      </div>` : '';

  const hotelFieldHtml = allHotels.length > 1 ? `
      <div class="field">
        <label>Hotel</label>
        <select id="opp-hotel-filter" style="width:220px">
          <option value="all" ${s.hotelFilter === 'all' ? 'selected' : ''}>Todos los hoteles</option>
          ${allHotels.map((h) => `<option value="${escapeHtml(h)}" ${s.hotelFilter === h ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}
        </select>
      </div>` : '';

  // La casilla se muestra siempre (también con la API): si estaba oculta, "Todos" dejaba fuera las
  // campañas de marca sin que se viera por qué, y no coincidía con sumar los tipos a mano.
  const hiddenBrand = new Set(hotelFilteredRows.filter((r) => r.campaign_type === 'search_brand').map((r) => r.campaign));
  const brandNote = s.excludeBrand && hiddenBrand.size && !s.typeFilter.includes('search_brand') && s.campaignFilter === 'all'
    ? `<span class="field-hint">${hiddenBrand.size === 1 ? 'Hay 1 campaña de marca que no se cuenta' : `Hay ${hiddenBrand.size} campañas de marca que no se cuentan`}. Desmarca la casilla para incluir${hiddenBrand.size === 1 ? 'la' : 'las'}.</span>` : '';
  const excludeBrandFieldHtml = `
      <div class="field">
        <label style="display:flex;align-items:center;gap:8px;font-weight:400">
          <input type="checkbox" id="opp-exclude-brand" ${s.excludeBrand ? 'checked' : ''} />
          Excluir campañas de marca (recomendado para un ROAS realista)
        </label>
        ${brandNote}
      </div>`;

  const filterPanel = `
    <div class="card control-panel align-end">
      ${excludeBrandFieldHtml}
      ${hotelFieldHtml}
      ${typeFieldHtml}
      <div class="field">
        <label>Ver solo esta campaña</label>
        <select id="opp-campaign-filter" style="width:320px">
          <option value="all" ${s.campaignFilter === 'all' ? 'selected' : ''}>Todas las campañas seleccionadas</option>
          ${allCampaignNames.map((c) => `<option value="${escapeHtml(c)}" ${s.campaignFilter === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
      </div>
    </div>`;

  const rows = getOpportunityFilteredRows();
  const withData = rows.filter((r) => !Number.isNaN(r.impr_share) && r.impr_share > 0 && !Number.isNaN(r.lost_is_budget));
  if (!withData.length) {
    return `
      ${filterPanel}
      <div class="error-panel">
        Ninguna de las campañas seleccionadas trae las columnas "Search Impr. Share" y "Search Lost IS (budget)" con datos válidos — sin esas columnas no se puede calcular la oportunidad de ingresos. Revisa que el export de Google Ads las incluya, o prueba con "Usar ejemplo".
      </div>`;
  }

  const summary = engine.summarizeRevenueOpportunity(rows);

  const headline = `
    <div class="card" style="padding:28px 32px;text-align:center;margin-bottom:20px">
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn-outline sm" data-action="opp-download-html">Descargar informe (HTML)</button><button class="btn-outline sm" data-action="opp-download" style="margin-left:8px">Descargar CSV</button></div>
      <div style="font-size:13px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Podrías haber incrementado tus ingresos en</div>
      <div style="font-family:var(--font-display);font-size:40px;font-weight:700;color:var(--ok-text)">${fmtMoney(summary.revenue_lost)}</div>
      <div style="display:flex;gap:32px;justify-content:center;margin-top:18px;flex-wrap:wrap">
        <div>
          <div style="font-size:12px;color:var(--color-text-muted)">Si hubieras invertido</div>
          <div style="font-size:22px;font-weight:700;color:var(--danger)">${summary.extra_budget != null ? fmtMoney(summary.extra_budget) : 'N/D'}</div>
          <div style="font-size:11px;color:var(--color-text-muted)">adicional</div>
        </div>
        <div>
          <div style="font-size:12px;color:var(--color-text-muted)">Asumiendo un ROAS de</div>
          <div style="font-size:22px;font-weight:700;color:var(--color-accent-strong)">${summary.roas != null ? (summary.roas * 100).toFixed(0) + '%' : 'N/D'}</div>
          <div style="font-size:11px;color:var(--color-text-muted)">promedio de las campañas seleccionadas</div>
        </div>
        <div>
          <div style="font-size:12px;color:var(--color-text-muted)">Conversiones perdidas</div>
          <div style="font-size:22px;font-weight:700;color:var(--navy-800)">${fmtInt(summary.conversions_lost)}</div>
        </div>
      </div>
    </div>`;

  const sortKeyFn = OPP_SORT_KEYS[s.sortBy] || OPP_SORT_KEYS.revenue_lost;
  const sortedOpportunities = summary.opportunities.filter((o) => o.has_data).sort((a, b) => {
    const va = sortKeyFn(a), vb = sortKeyFn(b);
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : (va - vb);
    return s.sortDir === 'asc' ? cmp : -cmp;
  });

  const tableRows = sortedOpportunities.map((o) => `
    <tr>
      <td>${escapeHtml(o.campaign)}</td>
      <td>${escapeHtml(o.bid_strategy || 'N/D')}</td>
      <td>${o.campaign_roas != null ? (o.campaign_roas * 100).toFixed(0) + '%' : 'N/D'}</td>
      <td style="${heatCell(o.impr_share, '59,130,246', 0.6)}">${(o.impr_share * 100).toFixed(0)}%</td>
      <td style="${heatCell(o.lost_is_rank, '245,158,11')}">${(o.lost_is_rank * 100).toFixed(0)}%</td>
      <td style="${heatCell(o.lost_is_budget, '179,53,43')}">${(o.lost_is_budget * 100).toFixed(0)}%</td>
      <td>${fmtMoney(o.revenue_lost)}</td>
      <td>${fmtMoney(o.cost)}</td>
      <td>${fmtInt(o.conversions)}</td>
      <td>${fmtInt(o.conversions_lost)}</td>
    </tr>`).join('');

  const funnel = engine.buildOpportunityFunnel(summary.opportunities);

  // Tendencia diaria de Impression Share — solo en modo API (necesita
  // granularidad por día, que un CSV nativo de campañas no trae).
  let isTrendHtml = '';
  if (s.source === 'api') {
    const t = s.isTrend;
    if (t.status === 'loading') {
      isTrendHtml = `<div class="card state-panel loading"><div class="spinner"></div><p>Cargando evolución de Impression Share…</p></div>`;
    } else if (t.status === 'error') {
      isTrendHtml = `<div class="error-panel"><strong>No se pudo cargar la evolución de Impression Share.</strong> ${escapeHtml(t.error)}</div>`;
    } else if (t.status === 'ready' && t.rows) {
      // t.rows viene sin agregar (una fila por campaña y día) — se agrega acá
      // según las campañas que quedaron después de los filtros de hotel/
      // campaña/marca ya aplicados (mismo `rows` de arriba), para que el
      // gráfico se recalcule al cambiar cualquiera de esos filtros.
      const campaignNames = new Set(rows.map((r) => r.campaign));
      const aggregated = engine.aggregateImpressionShareDaily(t.rows, campaignNames);
      isTrendHtml = renderImpressionShareTrendChart(aggregated);
    }
  }

  return `
    ${filterPanel}
    ${headline}
    ${renderOpportunityFunnel(funnel)}
    ${isTrendHtml}
    ${renderImprShareChart(withData)}
    <div class="card chart-card">
      <h3 class="dense-chart-title">Campañas con mayor oportunidad de presupuesto sin límite</h3>
      <p style="font-size:12.5px;color:var(--color-text-muted);margin-bottom:12px">Haz clic en cualquier columna para ordenar por esa métrica. IS = Impression Share, LR = % perdido por ranking, LB = % perdido por presupuesto.</p>
      <div style="overflow-x:auto">
        <table>
          <thead><tr>
            ${oppSortTh('Campaña', 'campaign', s)}
            ${oppSortTh('Estrategia', 'bid_strategy', s)}
            ${oppSortTh('ROAS', 'campaign_roas', s)}
            ${oppSortTh('IS', 'impr_share', s)}
            ${oppSortTh('LR', 'lost_is_rank', s)}
            ${oppSortTh('LB', 'lost_is_budget', s)}
            ${oppSortTh('Ingresos perdidos', 'revenue_lost', s)}
            ${oppSortTh('Gasto', 'cost', s)}
            ${oppSortTh('Conversiones', 'conversions', s)}
            ${oppSortTh('Conv. perdidas', 'conversions_lost', s)}
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>
    <p class="footnote">
      Análisis retrospectivo, no una predicción: asume que, sin límite de presupuesto, cada campaña habría mantenido la misma tasa de conversión y el mismo Ad Auction Win Rate que ya tiene. El presupuesto extra a invertir se calcula con el ROAS promedio del conjunto de campañas seleccionado (no el de cada campaña individual) — por eso se recomienda excluir campañas de marca, que suelen tener un ROAS artificialmente alto y distorsionan el promedio.
      Metodología: Total de búsquedas = Impresiones ÷ Impression Share. Búsquedas disponibles = Total × (1 − % perdido por presupuesto). Tasa de victoria en subasta = Impresiones ÷ Búsquedas disponibles. Sin límite de presupuesto, Impresiones potenciales = Tasa de victoria × Total de búsquedas — de ahí se proyectan clics, conversiones y valor de conversión con las mismas tasas reales de la campaña.
    </p>
  `;
}

// ---------------------------------------------------------------------------
// Función 7 — Proyección de ventas (tendencia + estacionalidad)
// ---------------------------------------------------------------------------

function fmtMoneyShort(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'N/D';
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
  return fmtMoney(n);
}

const MONTH_ABBR_ES = ['', 'ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function shortPeriodLabel(year, month) {
  return `${MONTH_ABBR_ES[month]} ${String(year).slice(2)}`;
}

// Suma los ingresos de todos los hoteles del archivo, mes a mes, para la
// opción "Todos los hoteles" del filtro.
function aggregateRevenueByPeriod(rows) {
  const byPeriod = new Map();
  for (const r of rows) {
    const existing = byPeriod.get(r.period);
    if (existing) existing.revenue += r.revenue;
    else byPeriod.set(r.period, { period: r.period, year: r.year, month: r.month, hotel: 'Todos', revenue: r.revenue });
  }
  return [...byPeriod.values()];
}

function renderForecastPage() {
  const s = state.forecast;

  let body = '';
  if (s.status === 'idle') {
    body = `
      <div class="card state-panel idle">
        ${icon('trending-up', 30)}
        <p><strong>¿Cuánto vamos a vender los próximos meses?</strong></p>
        <ol class="fc-steps">
          <li>Sube las ventas mensuales del hotel (las que salen de tu sistema de reservas).</li>
          <li>Elige cuántos meses quieres proyectar.</li>
          <li>Listo: verás cuánto esperamos vender y qué tan confiable es.</li>
        </ol>
        <p class="fc-muted">Se necesitan mínimo ${engine.MIN_MONTHS_FOR_FORECAST} meses de histórico. Con 24 o más la proyección es mucho más confiable.</p>
      </div>`;
  } else if (s.status === 'loading') {
    body = `
      <div class="card state-panel loading">
        <div class="spinner"></div>
        <p>Calculando la proyección…</p>
      </div>`;
  } else if (s.status === 'error') {
    body = `<div class="error-panel"><strong>No se pudo calcular la proyección.</strong> ${escapeHtml(s.error)}</div>`;
  } else if (s.status === 'ready') {
    body = renderForecastReady();
  }

  const allHotels = s.rows ? engine.listRevenueHotels(s.rows) : [];
  const hotelFieldHtml = allHotels.length > 1 ? `
      <div class="field">
        <label>Hotel</label>
        <select id="forecast-hotel-filter" style="width:220px">
          <option value="all" ${s.hotelFilter === 'all' ? 'selected' : ''}>Todos los hoteles (sumados)</option>
          ${allHotels.map((h) => `<option value="${escapeHtml(h)}" ${s.hotelFilter === h ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}
        </select>
      </div>` : '';

  return `
    <div class="card control-panel align-end">
      <div class="field">
        <label>Ventas mensuales del hotel (CSV o Excel)</label>
        <input type="file" id="forecast-file" accept=".csv,.xlsx,.xls" />
        <p class="field-hint">Una fila por mes, con el mes (ej. 2024-01 o "Enero 2024") y las ventas. Si el archivo trae varios hoteles, agrega una columna "Hotel".</p>
      </div>
      <button class="btn-outline" data-action="forecast-demo">Usar datos de ejemplo</button>
      ${s.fileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.fileName)}</strong></div>` : ''}
      ${hotelFieldHtml}
      <div class="field">
        <label>Proyectar</label>
        <div class="seg-control">
          <button class="seg-btn ${s.monthsAhead === 3 ? 'active' : ''}" data-action="forecast-horizon-3">3 meses</button>
          <button class="seg-btn ${s.monthsAhead === 6 ? 'active' : ''}" data-action="forecast-horizon-6">6 meses</button>
          <button class="seg-btn ${s.monthsAhead === 12 ? 'active' : ''}" data-action="forecast-horizon-12">12 meses</button>
        </div>
      </div>
      ${s.status === 'ready' ? '<button class="btn-outline" data-action="download-forecast-html">Descargar HTML</button>' : ''}
    </div>
    ${s.status === 'ready' ? renderForecastOptions() : ''}
    ${body}
  `;
}

// Lo opcional va plegado para no estorbar: la meta de crecimiento y la
// inversión pagada (todos los canales, no solo Google Ads — a pedido de cesar)
// con la que se calcula cuánto invertir. Solo aparece cuando ya hay proyección.
function renderForecastOptions() {
  const s = state.forecast;
  const active = (Number.isNaN(parseFloat(s.growthGoalPct)) ? 0 : 1) + (s.investmentRows && s.investmentRows.length ? 1 : 0);
  return `
    <details class="forecast-details" data-forecast-details="options" ${s.open.options ? 'open' : ''}>
      <summary>Opcional: cuánto invertir y meta de crecimiento${active ? ` · ${active} activa${active > 1 ? 's' : ''}` : ''}</summary>
      <div class="fc-details-body fc-options">
        <div class="field">
          <label>Meta de crecimiento (%)</label>
          <input type="number" id="forecast-growth-goal" value="${escapeHtml(s.growthGoalPct)}" placeholder="ej. 20" step="0.1" style="width:100px" />
          <p class="field-hint">Ej. 20 = quieres vender 20% más de lo que esperamos. Te mostramos cuánto falta y cuánto invertir.</p>
        </div>
        <div class="field">
          <label>Inversión pagada de cada mes (CSV o Excel)</label>
          <input type="file" id="forecast-investment-file" accept=".csv,.xlsx,.xls" />
          <p class="field-hint">Una fila por mes, con el mes y la inversión (suma de todos los canales pagados, no solo Google Ads). Con esto calculamos cuánto invertir para lograr las ventas.</p>
          ${s.investmentFileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.investmentFileName)}</strong></div>` : ''}
          ${s.investmentError ? `<div class="error-panel" style="margin-top:8px">${escapeHtml(s.investmentError)}</div>` : ''}
        </div>
        <button class="btn-outline" data-action="forecast-investment-demo">Usar inversión de ejemplo</button>
      </div>
    </details>`;
}

// Semáforo de confiabilidad en lenguaje llano. Sale de la prueba contra el
// pasado cuando hay histórico suficiente; si no, solo de cuántos meses hay.
function forecastReliability(result) {
  const bt = result.backtest;
  let level;
  if (result.monthsUsed < 18 || (bt && (bt.mape > 0.15 || bt.beatsNaive === false))) level = 'baja';
  else if (!bt || result.monthsUsed < engine.SHORT_HISTORY_MONTHS || bt.mape > 0.08 || result.outliers.length) level = 'media';
  else level = 'alta';
  const reason = bt
    ? `Probamos el método con los últimos ${bt.holdout} meses reales, sin mostrárselos: se equivocó ${(bt.mape * 100).toFixed(1)}% en promedio por mes.`
    : `Solo hay ${result.monthsUsed} meses de datos: no alcanza para comprobarlo contra meses reales (se necesitan ${engine.MIN_MONTHS_FOR_BACKTEST}).`;
  const hints = [];
  if (bt && bt.beatsNaive === false) hints.push('No mejora al método simple de repetir el año pasado.');
  if (bt && result.monthsUsed < engine.SHORT_HISTORY_MONTHS) hints.push('Con 24 meses o más sería más confiable.');
  if (result.outliers.length) hints.push('Hay meses atípicos por revisar.');
  return { level, label: { alta: 'Alta', media: 'Media', baja: 'Baja' }[level], reason, hints };
}

const fmtSignedPct = (v) => (v === null || v === undefined || Number.isNaN(v) ? 'N/D' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);

// Arma todo lo que la pantalla y la descarga CSV necesitan, en un solo lugar,
// para que los dos muestren exactamente los mismos números. Lanza si el
// histórico no alcanza para proyectar.
function buildForecastModel() {
  const s = state.forecast;
  const allRows = s.rows || [];
  const source = s.hotelFilter === 'all' ? aggregateRevenueByPeriod(allRows) : allRows.filter((r) => r.hotel === s.hotelFilter);
  const rows = source.slice().sort((a, b) => (a.year - b.year) || (a.month - b.month));
  const result = engine.computeSeasonalForecast(rows, s.monthsAhead, { excludePeriods: s.excludedPeriods });

  let investment = null;
  let investmentError = null;
  if (s.investmentRows && s.investmentRows.length) {
    try {
      investment = engine.computeRequiredInvestment(result.history, s.investmentRows, result.forecast, { window: s.roasWindow });
    } catch (err) {
      investmentError = err.message || String(err);
    }
  }
  const investmentByPeriod = investment ? new Map(investment.forecastWithInvestment.map((f) => [f.period, f.investmentNeeded])) : null;

  let goal = null;
  const growthGoalPctNum = parseFloat(s.growthGoalPct);
  if (!Number.isNaN(growthGoalPctNum)) goal = engine.computeGrowthGoal(result.history, result.forecast, growthGoalPctNum);
  const goalByPeriod = goal ? new Map(goal.forecastWithGoal.map((f) => [f.period, f.goal])) : null;
  const gapByPeriod = goal ? new Map(goal.forecastWithGoal.map((f) => [f.period, f.gap])) : null;
  const goalVsPriorByPeriod = goal ? new Map(goal.forecastWithGoal.map((f) => [f.period, f.goalVsPriorPct])) : null;
  const goalInvestmentByPeriod = (goal && investment && investment.blendedRoas)
    ? new Map(goal.forecastWithGoal.map((f) => [f.period, f.goal != null ? f.goal / investment.blendedRoas : null]))
    : null;

  // Cuánto más hay que invertir para llegar a la meta que para sostener la
  // proyección, solo en los meses que tienen meta.
  let extraInvestment = null;
  if (goalInvestmentByPeriod && investmentByPeriod) {
    let goalInv = 0, baseInv = 0;
    goalInvestmentByPeriod.forEach((v, period) => {
      if (v != null) { goalInv += v; baseInv += investmentByPeriod.get(period) || 0; }
    });
    extraInvestment = goalInv - baseInv;
  }

  return {
    result, investment, investmentError, investmentByPeriod,
    goal, growthGoalPctNum, goalByPeriod, gapByPeriod, goalVsPriorByPeriod, goalInvestmentByPeriod, extraInvestment,
  };
}

function renderForecastNotices(result) {
  const items = [];
  const label = (p) => { const [y, m] = p.split('-').map(Number); return shortPeriodLabel(y, m); };

  if (result.excludedPartial.length) {
    items.push(`<li>${result.excludedPartial.map(label).join(', ')} no se usó porque el mes todavía no termina. Sí se proyecta.</li>`);
  }
  if (result.missingPeriods.length) {
    const shown = result.missingPeriods.slice(0, 6).map(label).join(', ');
    items.push(`<li>Faltan ${result.missingPeriods.length} mes(es) en el archivo (${shown}${result.missingPeriods.length > 6 ? '…' : ''}). Revisa que no se hayan perdido al exportar.</li>`);
  }
  result.outliers.forEach((o) => {
    items.push(`<li><strong>${shortPeriodLabel(o.year, o.month)}</strong> vendió ${fmtMoneyShort(o.revenue)} y esperábamos ${fmtMoneyShort(o.fitted)} (${fmtSignedPct(o.devPct)}). Si fue algo puntual (cierre, remodelación, evento), excluirlo mejora la proyección.
      <button class="btn-outline sm" data-forecast-exclude="${escapeHtml(o.period)}">Excluir ese mes</button></li>`);
  });
  if (result.excludedPeriods.length) {
    items.push(`<li>Meses excluidos: ${result.excludedPeriods.map((p) => `<strong>${label(p)}</strong> <button class="btn-outline sm" data-forecast-restore="${escapeHtml(p)}">Volver a incluir</button>`).join(' &nbsp; ')}</li>`);
  }
  if (!items.length) return '';
  return `<div class="forecast-notice"><strong>Revisa estos datos</strong><ul>${items.join('')}</ul></div>`;
}

// Índice de temporada de cada mes calendario: cuánto se desvía de un mes
// "normal" del año (+20% = un mes 20% por encima del promedio).
function renderSeasonalIndexChart(seasonalIndex, lowSample) {
  const W = 680, H = 200, ML = 16, MR = 16, MT = 26, MB = 30;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const vals = [...Array(12).keys()].map((i) => seasonalIndex[i + 1]);
  const maxDev = Math.max(0.15, ...vals.map((v) => Math.abs(v - 1))) * 1.35;
  const yMid = MT + plotH / 2;
  const k = (plotH / 2) / maxDev;
  const bw = plotW / 12;
  const bars = vals.map((v, i) => {
    const m = i + 1;
    const low = lowSample.includes(m);
    const h = Math.abs(v - 1) * k;
    const x = ML + i * bw + bw * 0.18;
    const y = v >= 1 ? yMid - h : yMid;
    const color = v >= 1 ? 'var(--accent-600)' : 'var(--navy-800)';
    const txtY = v >= 1 ? y - 5 : y + h + 12;
    return `<g>
      <title>${MONTH_ABBR_ES[m]}: ${fmtSignedPct(v - 1)} vs. un mes normal${low ? ' (menos de 2 observaciones, poco confiable)' : ''}</title>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${color}" fill-opacity="${low ? 0.35 : 0.9}" rx="2" />
      <text x="${(x + bw * 0.32).toFixed(1)}" y="${txtY.toFixed(1)}" font-size="10" fill="var(--color-text-muted)" text-anchor="middle">${fmtSignedPct(v - 1).replace('.0%', '%')}${low ? '*' : ''}</text>
      <text x="${(x + bw * 0.32).toFixed(1)}" y="${H - 8}" font-size="10" fill="var(--color-text-muted)" text-anchor="middle">${MONTH_ABBR_ES[m]}</text>
    </g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:230px;display:block" xmlns="http://www.w3.org/2000/svg">
      <line x1="${ML}" y1="${yMid.toFixed(1)}" x2="${W - MR}" y2="${yMid.toFixed(1)}" stroke="var(--color-border)" stroke-width="1" />
      ${bars}
    </svg>`;
}

// Prueba contra el pasado: lo que habría proyectado el método con los últimos
// meses ocultos, frente a lo que pasó de verdad.
function renderForecastBacktest(result) {
  const bt = result.backtest;
  if (!bt) {
    return `<p class="fc-p">Se necesitan al menos ${engine.MIN_MONTHS_FOR_BACKTEST} meses de histórico para ocultar los últimos meses, proyectarlos y compararlos con lo real. Con ${result.monthsUsed} meses solo se puede ver qué tan bien el método explica el pasado (error ${(result.mape * 100).toFixed(1)}%), que siempre luce mejor que la precisión real.</p>`;
  }
  const over = bt.totalErrPct !== null && bt.totalErrPct > 0;
  const verdict = bt.beatsNaive === null ? ''
    : bt.beatsNaive ? ' El método supera a esa regla simple, así que sí aporta.'
      : ' El método no supera a esa regla simple: toma la proyección con cautela.';
  return `
    <p class="fc-p">
      Se ocultaron los últimos ${bt.holdout} meses reales, se proyectaron sin verlos y se compararon con lo que pasó.
      El método se equivocó <strong>${(bt.mape * 100).toFixed(1)}%</strong> en promedio por mes y <strong>${bt.totalErrPct === null ? 'N/D' : Math.abs(bt.totalErrPct * 100).toFixed(1) + '% ' + (over ? 'de más' : 'de menos')}</strong> en el total.
      ${bt.naiveMape !== null ? `La regla simple "repetir el mismo mes del año pasado" se equivocó ${(bt.naiveMape * 100).toFixed(1)}%.` : ''}${verdict}
    </p>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Mes</th><th>Vendió</th><th>Habríamos proyectado</th><th>Error</th><th>Repetir año pasado</th></tr></thead>
        <tbody>${bt.rows.map((r) => `
          <tr>
            <td>${shortPeriodLabel(r.year, r.month)}</td>
            <td>${fmtMoneyShort(r.actual)}</td>
            <td>${fmtMoneyShort(r.predicted)}</td>
            <td>${fmtSignedPct(r.errPct)}</td>
            <td>${r.naive !== null && r.actual > 0 ? fmtSignedPct((r.naive - r.actual) / r.actual) : 'N/D'}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function renderForecastPlan(model) {
  const { result, investment, goal, growthGoalPctNum, goalInvestmentByPeriod, extraInvestment } = model;
  if (!investment && !goal) return '';
  const row = (title, big, sub) => `
    <div class="fc-plan-row">
      <div><div class="fc-plan-title">${title}</div><div class="fc-line muted">${sub}</div></div>
      <div class="fc-plan-big">${big}</div>
    </div>`;
  const rows = [];
  if (goal) {
    rows.push(row(`Meta: vender ${growthGoalPctNum}% más de lo esperado`, fmtMoneyShort(goal.totalGoal),
      `${fmtMoneyShort(goal.gapTotal)} más que lo esperado${goal.goalVsPriorPct !== null ? ` · equivale a ${fmtSignedPct(goal.goalVsPriorPct)} frente al año pasado` : ''}`));
  }
  if (investment) {
    const windowText = investment.windowUsed === 'recent' ? `últimos ${investment.roasMonths} meses` : 'todo el histórico';
    rows.push(row('Inversión para vender lo esperado', fmtMoneyShort(investment.totalInvestmentNeeded),
      `Cada $1 invertido trajo $${investment.blendedRoas.toFixed(1)} en ventas (${windowText})`));
    if (goalInvestmentByPeriod) {
      const total = [...goalInvestmentByPeriod.values()].reduce((s2, v) => s2 + (v || 0), 0);
      rows.push(row('Inversión para lograr la meta', fmtMoneyShort(total),
        extraInvestment !== null ? `${extraInvestment >= 0 ? '+' : '−'}${fmtMoneyShort(Math.abs(extraInvestment))} más que para lo esperado` : ''));
    }
  }
  return `
    <div class="card fc-plan">
      <div class="fc-eyebrow">${goal ? 'Meta e inversión' : 'Inversión necesaria'}</div>
      ${rows.join('')}
      ${investment ? '' : '<p class="fc-muted" style="margin:10px 0 0">Para ver cuánto invertir, sube tu inversión mensual en la sección "Opcional".</p>'}
      ${model.investmentError ? `<div class="error-panel" style="margin-top:10px"><strong>No se pudo calcular la inversión.</strong> ${escapeHtml(model.investmentError)}</div>` : ''}
    </div>`;
}

function renderForecastReady() {
  const s = state.forecast;
  let model;
  try {
    model = buildForecastModel();
  } catch (err) {
    return `<div class="error-panel"><strong>No se pudo calcular la proyección.</strong> ${escapeHtml(err.message)}${s.excludedPeriods.length ? ' <button class="btn-outline sm" data-forecast-restore-all="1">Volver a incluir los meses excluidos</button>' : ''}</div>`;
  }
  const { result, investment, investmentByPeriod, goal, goalByPeriod, goalInvestmentByPeriod } = model;

  const first = result.history[0], last = result.history[result.history.length - 1];
  const fc = result.forecast;
  const totalForecast = fc.reduce((s2, f) => s2 + f.value, 0);
  const totalLow = fc.reduce((s2, f) => s2 + f.low, 0);
  const totalHigh = fc.reduce((s2, f) => s2 + f.high, 0);
  const yoy = result.yoy;
  const rel = forecastReliability(result);
  const trendPct = result.intercept > 0 ? (12 * result.slope / result.intercept) * 100 : null;

  const roasToggle = (investment && investment.recentAvailable) ? `
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0 4px;flex-wrap:wrap">
      <span class="fc-muted">Qué meses usar para calcular el retorno:</span>
      <div class="seg-control">
        <button class="seg-btn ${investment.windowUsed === 'recent' ? 'active' : ''}" data-action="forecast-roas-recent">Últimos ${engine.ROAS_RECENT_MONTHS} meses</button>
        <button class="seg-btn ${investment.windowUsed === 'all' ? 'active' : ''}" data-action="forecast-roas-all">Todo el histórico</button>
      </div>
    </div>` : '';

  const calcDetails = `
    <details class="forecast-details" data-forecast-details="calc" ${s.open.calc ? 'open' : ''}>
      <summary>Ver cómo se calculó y qué tan confiable es</summary>
      <div class="fc-details-body">
        <h4 class="fc-h">¿Qué tan bien funciona?</h4>
        ${renderForecastBacktest(result)}

        <h4 class="fc-h">Meses fuertes y flojos del año</h4>
        ${renderSeasonalIndexChart(result.seasonalIndex, result.monthsWithLowSample)}
        <p class="fc-muted" style="margin:8px 0 0">Cuánto se aleja cada mes de un mes "normal": +20% = un mes 20% por encima del promedio. ${result.monthsWithLowSample.length ? '* = hay menos de 2 años de ese mes, poco confiable.' : ''}</p>

        ${investment ? `<h4 class="fc-h">Retorno de la inversión</h4>
        <p class="fc-p">Cada $1 invertido en publicidad trajo <strong>$${investment.blendedRoas.toFixed(1)}</strong> en ventas (${investment.windowUsed === 'recent' ? `últimos ${investment.roasMonths} meses` : `todo el histórico, ${investment.roasMonths} meses`}).${(investment.recentAvailable && (investment.roasAll.toFixed(1) !== investment.roasRecent.toFixed(1))) ? ` Con ${investment.windowUsed === 'recent' ? 'todo el histórico' : `los últimos ${engine.ROAS_RECENT_MONTHS} meses`} sería $${(investment.windowUsed === 'recent' ? investment.roasAll : investment.roasRecent).toFixed(1)}.` : ''} Es el retorno de todos los canales pagados juntos contra todas las ventas del hotel.</p>
        ${roasToggle}` : ''}

        <h4 class="fc-h">Cómo se calcula</h4>
        <ul class="fc-list">
          <li>Se usaron ${result.monthsOfHistory} meses (${shortPeriodLabel(first.year, first.month)} a ${shortPeriodLabel(last.year, last.month)})${result.monthsUsed !== result.monthsOfHistory ? `, ${result.monthsUsed} en el cálculo` : ''}. La tendencia es ${trendPct === null ? 'N/D' : (trendPct >= 0 ? '+' : '') + trendPct.toFixed(1) + '%'} por año, sin contar la temporada.</li>
          <li>Se separa lo que sube o baja con el tiempo (tendencia) de lo que se repite cada año (temporada), y se proyectan juntas.</li>
          <li>El rango probable cubre cerca del ${Math.round(result.interval.level * 100)}% de los casos y se ensancha cuanto más lejos está el mes${result.interval.floorApplied ? `; con menos de 24 meses se usa un mínimo de ±${(engine.SHORT_HISTORY_MIN_REL_SD * 100).toFixed(0)}%` : ''}. Es una referencia, no una garantía.</li>
          <li>No puede ver lo que el histórico no muestra: aperturas, remodelaciones, cambios de tarifa o eventos.</li>
          ${investment ? '<li>La inversión asume que cada $1 seguirá trayendo lo mismo que antes; si se escala mucho, ese retorno suele bajar.</li>' : ''}
          ${goal ? '<li>La meta es lo esperado × (1 + el % que escribiste).</li>' : ''}
        </ul>
      </div>
    </details>`;

  return `
    <div class="fc-top">
      <div class="card fc-hero">
        <div class="fc-eyebrow">Lo que esperamos vender · ${shortPeriodLabel(fc[0].year, fc[0].month)} a ${shortPeriodLabel(fc[fc.length - 1].year, fc[fc.length - 1].month)}</div>
        <div class="fc-big">${fmtMoneyShort(totalForecast)}</div>
        ${yoy.pct !== null ? `<div class="fc-line"><strong>${fmtSignedPct(yoy.pct)}</strong> frente al mismo periodo del año pasado${yoy.monthsCompared < s.monthsAhead ? ` (${yoy.monthsCompared} de ${s.monthsAhead} meses comparables)` : ''}</div>` : ''}
        <div class="fc-line muted">Rango probable: ${fmtMoneyShort(totalLow)} a ${fmtMoneyShort(totalHigh)}</div>
      </div>
      <div class="card fc-rel fc-rel-${rel.level}">
        <div class="fc-eyebrow">Qué tan confiable es</div>
        <div class="fc-rel-level">${rel.label}</div>
        <div class="fc-line">${rel.reason}</div>
        ${rel.hints.map((h) => `<div class="fc-line muted">${h}</div>`).join('')}
      </div>
    </div>

    ${renderForecastNotices(result)}
    ${renderForecastPlan(model)}

    <div class="card chart-card">
      <h3 class="dense-chart-title">Ventas reales y lo que esperamos</h3>
      ${renderForecastChart(result.history, result.forecast, goalByPeriod, investmentByPeriod, goalInvestmentByPeriod)}
      <p style="margin:10px 0 0;font-size:11.5px;color:var(--color-text-muted)">
        <span style="color:var(--navy-800)">■</span> ventas reales &nbsp;
        <span style="color:var(--accent-600)">■</span> lo que esperamos &nbsp;
        <span style="color:var(--accent-600);opacity:.4">■</span> rango probable
        ${goal ? `&nbsp; <span style="color:var(--ok-text)">┄</span> meta` : ''}
        ${result.excludedPeriods.length ? `&nbsp; <span style="color:var(--danger)">○</span> mes excluido` : ''}
      </p>
    </div>

    <div class="card table-panel" style="margin-bottom:16px">
      <div class="table-panel-head">
        <h3>Mes a mes</h3>
        <button class="btn-outline sm" data-action="download-forecast">Descargar CSV con todo el detalle</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Mes</th><th>Ventas esperadas</th><th>Rango probable</th><th>Mismo mes año pasado</th><th>Cambio</th>${investment ? '<th>Inversión necesaria</th>' : ''}${goal ? '<th>Meta</th>' : ''}${goalInvestmentByPeriod ? '<th>Inversión para la meta</th>' : ''}</tr></thead>
          <tbody>${fc.map((f) => `
            <tr>
              <td style="white-space:nowrap">${shortPeriodLabel(f.year, f.month)}</td>
              <td><strong>${fmtMoneyShort(f.value)}</strong></td>
              <td style="white-space:nowrap">${fmtMoneyShort(f.low)} – ${fmtMoneyShort(f.high)}</td>
              <td>${f.prior !== null ? fmtMoneyShort(f.prior) : 'N/D'}</td>
              <td>${fmtSignedPct(f.yoyPct)}</td>
              ${investment ? `<td>${fmtMoneyShort(investmentByPeriod.get(f.period))}</td>` : ''}
              ${goal ? `<td>${goalByPeriod.get(f.period) != null ? fmtMoneyShort(goalByPeriod.get(f.period)) : 'N/D'}</td>` : ''}
              ${goalInvestmentByPeriod ? `<td>${goalInvestmentByPeriod.get(f.period) != null ? fmtMoneyShort(goalInvestmentByPeriod.get(f.period)) : 'N/D'}</td>` : ''}
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    ${calcDetails}
  `;
}

// SVG sin librerías — línea de real/ajuste/proyección + banda de rango,
// mismo criterio del resto de la plataforma de no depender de un paquete
// de gráficas externo.
function renderForecastChart(history, forecast, goalByPeriod, investmentByPeriod, goalInvestmentByPeriod) {
  const W = 680, H = 230, ML = 56, MR = 16, MT = 16, MB = 26;
  const plotW = W - ML - MR, plotH = H - MT - MB;

  const goalValues = goalByPeriod ? [...goalByPeriod.values()].filter((v) => v != null) : [];
  const allPoints = [...history.map((h) => ({ t: h.t, values: [h.revenue, h.fitted] })),
    ...forecast.map((f) => ({ t: f.t, values: [f.value, f.low, f.high, ...(goalByPeriod && goalByPeriod.get(f.period) != null ? [goalByPeriod.get(f.period)] : [])] }))];
  const tMax = Math.max(1, allPoints[allPoints.length - 1].t);
  const yMax = Math.max(1, ...allPoints.flatMap((p) => p.values), ...goalValues) * 1.08;

  const x = (t) => ML + (t / tMax) * plotW;
  const y = (v) => MT + plotH - (Math.max(0, v) / yMax) * plotH;

  const actualPath = history.map((h, i) => `${i === 0 ? 'M' : 'L'} ${x(h.t).toFixed(1)},${y(h.revenue).toFixed(1)}`).join(' ');

  const lastHist = history[history.length - 1];
  const forecastPoints = [{ t: lastHist.t, value: lastHist.revenue, low: lastHist.revenue, high: lastHist.revenue }, ...forecast];
  const forecastPath = forecastPoints.map((f, i) => `${i === 0 ? 'M' : 'L'} ${x(f.t).toFixed(1)},${y(f.value).toFixed(1)}`).join(' ');
  const bandTop = forecastPoints.map((f) => `${x(f.t).toFixed(1)},${y(f.high).toFixed(1)}`).join(' L ');
  const bandBottom = forecastPoints.slice().reverse().map((f) => `${x(f.t).toFixed(1)},${y(f.low).toFixed(1)}`).join(' L ');
  const bandPath = `M ${bandTop} L ${bandBottom} Z`;

  // Línea de meta: parte del mismo punto que la proyección (último mes real)
  // para que las tres líneas arranquen del mismo lugar en el gráfico — se
  // corta si algún mes futuro no tiene su equivalente del año pasado.
  let goalPath = '';
  if (goalByPeriod) {
    const goalPoints = [{ t: lastHist.t, value: lastHist.revenue }, ...forecast
      .filter((f) => goalByPeriod.get(f.period) != null)
      .map((f) => ({ t: f.t, value: goalByPeriod.get(f.period) }))];
    if (goalPoints.length > 1) {
      goalPath = goalPoints.map((g, i) => `${i === 0 ? 'M' : 'L'} ${x(g.t).toFixed(1)},${y(g.value).toFixed(1)}`).join(' ');
    }
  }

  const gridLines = [0, 0.5, 1].map((frac) => {
    const val = yMax * frac;
    const yy = y(val);
    return `<line x1="${ML}" y1="${yy.toFixed(1)}" x2="${W - MR}" y2="${yy.toFixed(1)}" stroke="var(--color-border)" stroke-width="1" />
      <text x="${ML - 8}" y="${(yy + 3).toFixed(1)}" font-size="10" fill="var(--color-text-muted)" text-anchor="end">${fmtMoneyShort(val)}</text>`;
  }).join('');

  const labelEvery = Math.max(1, Math.ceil(allPoints.length / 9));
  const xLabels = allPoints.filter((_, i) => i % labelEvery === 0).map((p) => {
    const src = p.t <= lastHist.t ? history.find((h) => h.t === p.t) : forecast.find((f) => f.t === p.t);
    if (!src) return '';
    return `<text x="${x(p.t).toFixed(1)}" y="${H - 6}" font-size="10" fill="var(--color-text-muted)" text-anchor="middle">${shortPeriodLabel(src.year, src.month)}</text>`;
  }).join('');

  // Columnas invisibles para el hover: una por mes (histórico + proyectado),
  // con el texto del tooltip guardado en data-tooltip — bindEvents() les
  // agrega los listeners de mouseenter/mouseleave después de renderizar.
  const colStep = plotW / tMax;
  const hoverCols = allPoints.map((p) => {
    const isHistory = p.t <= lastHist.t;
    const src = isHistory ? history.find((h) => h.t === p.t) : forecast.find((f) => f.t === p.t);
    if (!src) return '';
    let lines;
    if (isHistory) {
      lines = [shortPeriodLabel(src.year, src.month), `Ventas reales: ${fmtMoney(src.revenue)}`];
      if (src.excluded) lines.push('Mes excluido del cálculo');
    } else {
      lines = [shortPeriodLabel(src.year, src.month), `Esperado: ${fmtMoney(src.value)}`, `Rango probable: ${fmtMoney(src.low)} – ${fmtMoney(src.high)}`];
      if (src.prior !== null && src.prior !== undefined) lines.push(`Año pasado: ${fmtMoney(src.prior)} (${src.yoyPct === null ? 'N/D' : (src.yoyPct >= 0 ? '+' : '') + (src.yoyPct * 100).toFixed(1) + '%'})`);
      const inv = investmentByPeriod && investmentByPeriod.get(src.period);
      if (inv != null) lines.push(`Inversión necesaria: ${fmtMoney(inv)}`);
      const g = goalByPeriod && goalByPeriod.get(src.period);
      if (g != null) {
        const prior = src.prior;
        lines.push(`Meta: ${fmtMoney(g)}${prior > 0 ? ` (${g / prior - 1 >= 0 ? '+' : ''}${((g / prior - 1) * 100).toFixed(1)}% vs. año pasado)` : ''}`);
      }
      const gInv = goalInvestmentByPeriod && goalInvestmentByPeriod.get(src.period);
      if (gInv != null) lines.push(`Inversión para la meta: ${fmtMoney(gInv)}`);
    }
    const rectX = (x(p.t) - colStep / 2).toFixed(1);
    return `<rect class="forecast-hover-col" x="${rectX}" y="${MT}" width="${colStep.toFixed(1)}" height="${plotH}" fill="transparent" data-x="${x(p.t).toFixed(1)}" data-tooltip="${escapeHtml(lines.join('\n'))}"></rect>`;
  }).join('');

  return `
    <div style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:260px;display:block" xmlns="http://www.w3.org/2000/svg">
        ${gridLines}
        <path d="${bandPath}" fill="var(--accent-600)" fill-opacity="0.15" stroke="none" />
        <path d="${forecastPath}" fill="none" stroke="var(--accent-600)" stroke-width="2.5" />
        <path d="${actualPath}" fill="none" stroke="var(--navy-800)" stroke-width="2.5" />
        ${goalPath ? `<path d="${goalPath}" fill="none" stroke="var(--ok-text)" stroke-width="2" stroke-dasharray="1 4" stroke-linecap="round" />` : ''}
        ${history.filter((h) => h.excluded).map((h) => `<circle cx="${x(h.t).toFixed(1)}" cy="${y(h.revenue).toFixed(1)}" r="4.5" fill="#fff" stroke="var(--danger)" stroke-width="1.8" />`).join('')}
        <line x1="${x(lastHist.t).toFixed(1)}" y1="${MT}" x2="${x(lastHist.t).toFixed(1)}" y2="${H - MB}" stroke="var(--color-border)" stroke-width="1" stroke-dasharray="2 3" />
        <line class="forecast-hover-guide" x1="0" y1="${MT}" x2="0" y2="${H - MB}" stroke="var(--navy-800)" stroke-width="1" style="opacity:0" />
        ${xLabels}
        ${hoverCols}
      </svg>
      <div class="forecast-tooltip"></div>
    </div>`;
}

// Descarga de toda la proyección como una página HTML autocontenida (estilos
// de la plataforma incrustados, gráficos en SVG, sin botones), para mandarla
// por correo o guardarla como PDF con Ctrl+P. Usa los mismos renderizadores
// de la pantalla, así que muestra exactamente los mismos números.
async function downloadForecastHtml() {
  const s = state.forecast;
  if (s.status !== 'ready') return;
  let model;
  try { model = buildForecastModel(); } catch (err) { return; }
  const { result, investment, goal, growthGoalPctNum } = model;

  const box = document.createElement('div');
  box.innerHTML = renderForecastReady();
  box.querySelectorAll('button, [data-forecast-details="options"], .forecast-hover-col, .forecast-hover-guide, .forecast-tooltip').forEach((el) => el.remove());
  box.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));

  const first = result.history[0], last = result.history[result.history.length - 1];
  const allHotels = engine.listRevenueHotels(s.rows || []).filter((h) => h !== 'N/D');
  const hotel = s.hotelFilter !== 'all' ? s.hotelFilter : (allHotels.length > 1 ? 'Todos los hoteles (sumados)' : (allHotels[0] || ''));
  const meta = [
    hotel ? `Hotel: ${hotel}` : null,
    s.fileName ? `Archivo: ${s.fileName}` : null,
    `Histórico: ${shortPeriodLabel(first.year, first.month)} a ${shortPeriodLabel(last.year, last.month)}`,
    `Horizonte: ${s.monthsAhead} meses`,
  ].filter(Boolean);
  const meta2 = [
    goal ? `Meta de crecimiento: proyección +${growthGoalPctNum}%` : null,
    investment ? `ROAS combinado: ${investment.windowUsed === 'recent' ? `últimos ${investment.roasMonths} meses` : 'histórico completo'}` : null,
    result.excludedPeriods.length ? `Meses excluidos del modelo: ${result.excludedPeriods.join(', ')}` : null,
  ].filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);
  const body = `
    <h1>Proyección de ventas</h1>
    <p class="meta">${meta.map(escapeHtml).join(' · ')}</p>
    ${meta2.length ? `<p class="meta">${meta2.map(escapeHtml).join(' · ')}</p>` : ''}
    <p class="meta">Generado el ${today}</p>
    <div style="margin-top:16px">${box.innerHTML}</div>`;
  const html = await campanasHtmlDocument('Proyección de ventas', body, true);
  downloadTextFile(html, `proyeccion_ventas${hotel ? '_' + cambiosSlug(hotel) : ''}_${today}.html`, 'text/html');
}

function runForecastAnalysis(text, fileName) {
  const s = state.forecast;
  try {
    const rows = engine.loadRevenueHistory(text);
    if (!rows.length) throw new Error('No se encontraron filas válidas — revisa el formato de las columnas de mes e ingresos.');
    Object.assign(s, { status: 'ready', rows, fileName, hotelFilter: 'all', excludedPeriods: [] });
  } catch (err) {
    Object.assign(s, { status: 'error', error: err.message || String(err), fileName });
  }
  render();
}

function runForecastInvestmentAnalysis(text, fileName) {
  const s = state.forecast;
  try {
    const investmentRows = engine.loadInvestmentHistory(text);
    if (!investmentRows.length) throw new Error('No se encontraron filas válidas — revisa el formato de las columnas de mes e inversión.');
    Object.assign(s, { investmentRows, investmentFileName: fileName, investmentError: null });
  } catch (err) {
    Object.assign(s, { investmentRows: null, investmentFileName: fileName, investmentError: err.message || String(err) });
  }
  render();
}

// ---------------------------------------------------------------------------
// Página 2 — Negativización
// ---------------------------------------------------------------------------

function renderNegPage() {
  return withMoneyCurrency((state.neg.tab === 'ia' && currentUser.isSuperAdmin) ? state.neg.ai.currency : (state.neg.source === 'api' ? state.neg.currency : null), () => renderNegPageBody());
}

function renderNegPageBody() {
  const s = state.neg;
  const tabs = currentUser.isSuperAdmin ? `
    <div class="seg-control" style="margin-bottom:20px">
      <button class="seg-btn ${s.tab !== 'ia' ? 'active' : ''}" data-action="neg-tab-reglas">Por reglas</button>
      <button class="seg-btn ${s.tab === 'ia' ? 'active' : ''}" data-action="neg-tab-ia">Con IA</button>
    </div>` : '';
  if (currentUser.isSuperAdmin && s.tab === 'ia') {
    ensureNegGoogleAdsStatusLoaded();
    ensureNegAiHistory();
    return `${tabs}${renderNegAiTab()}`;
  }

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

  // Filtro por campaña — solo tiene sentido con source==='api', porque un
  // CSV no trae campaign_id/campaign_name por fila. Deja ver solo los
  // términos de una campaña puntual antes de decidir qué subir como negativo.
  // Lista TODAS las campañas activas de la cuenta (s.api.allCampaigns), no
  // solo las que aparecen en s.rows — search_term_view solo trae Search, así
  // que sin esto Performance Max/Demand Gen/Display nunca aparecerían acá
  // aunque estén activas (se unen las de s.rows por si acaso, ya que
  // allCampaigns puede fallar en cargar sin tumbar el flujo principal).
  let campaignFilterHtml = '';
  if (s.source === 'api' && s.status === 'ready' && s.rows) {
    const campaignsById = new Map();
    (s.api.allCampaigns || []).forEach((c) => { if (c.id) campaignsById.set(c.id, c.name || c.id); });
    s.rows.forEach((r) => { if (r.campaign_id && !campaignsById.has(r.campaign_id)) campaignsById.set(r.campaign_id, r.campaign_name || r.campaign_id); });
    const campaigns = [...campaignsById.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    if (campaigns.length) {
      const options = ['<option value="all">Todas las campañas</option>']
        .concat(campaigns.map(([id, name]) => `<option value="${escapeHtml(id)}" ${s.campaignFilter === id ? 'selected' : ''}>${escapeHtml(name)}</option>`))
        .join('');
      campaignFilterHtml = `
        <div class="field">
          <label>Ver solo esta campaña</label>
          <select id="neg-campaign-filter" style="width:320px">${options}</select>
        </div>`;
    }
  }

  return `
    ${tabs}
    <div class="card control-panel">
      <div class="field" style="flex:1;min-width:240px">
        <label>Terminos de la campaña (lo que si debe ir)</label>
        <textarea id="neg-core" rows="3" style="width:100%;resize:vertical" placeholder="ej. estelar&#10;manzanillo">${escapeHtml(s.core)}</textarea>
        <p class="field-hint">Una palabra o frase corta por línea, no la frase completa. Un término de búsqueda se mantiene si contiene <em>alguna</em> de estas líneas — mientras más corta la línea, más variantes reales captura (ej. usa <code>click clack</code> en vez de <code>click clack bogota</code>, si no cada búsqueda tendría que traer las tres palabras juntas y en ese orden para calzar).</p>
      </div>
      <div class="field" style="flex:1;min-width:240px">
        <label>Define los terminos de busqueda que no deben ir (Opcional)</label>
        <textarea id="neg-exceptions" rows="3" style="width:100%;resize:vertical" placeholder="ej. manzanillo del mar">${escapeHtml(s.exceptions)}</textarea>
        <p class="field-hint">Para términos que coinciden con una línea de arriba pero sabes que no aplican (ej. otra sede de la marca, otra ciudad) — en vez de mantenerse solos, pasan a "revisar" para que los decidas a mano.</p>
      </div>
    </div>
    <div class="card control-panel align-end" style="margin-top:-8px">
      <div class="seg-control">
        <button class="seg-btn ${s.source === 'file' ? 'active' : ''}" data-action="neg-source-file">Subir archivo</button>
        <button class="seg-btn ${s.source === 'api' ? 'active' : ''}" data-action="neg-source-api">Conectar Google Ads</button>
      </div>
      ${s.source === 'file' ? `
        <div class="field">
          <label>Export de "Términos de búsqueda" (CSV)</label>
          <input type="file" id="neg-file" accept=".csv" />
        </div>
        <button class="btn-outline" data-action="neg-demo">Usar datos de ejemplo</button>
        ${s.fileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.fileName)}</strong></div>` : ''}
      ` : renderNegApiPanel()}
      ${campaignFilterHtml}
    </div>
    ${body}
  `;
}

function getNegFilteredRows() {
  const s = state.neg;
  if (!s.rows) return [];
  return s.campaignFilter === 'all' ? s.rows : s.rows.filter((r) => r.campaign_id === s.campaignFilter);
}

// Mismo patrón que renderRendApiPanel (Rendimiento) — cuenta + rango de
// fechas para traer el reporte de términos de búsqueda directo de Google
// Ads, con la campaña de cada término (necesaria para poder subir negativos
// después). Ver runNegAnalysisFromApiRows / fetchGoogleAdsSearchTerms.
function loadNegMccGroups() {
  const m = state.neg.api.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => { m.status = 'error'; m.error = err.message || String(err); render(); });
}

function applyNegMccFilter(groupId, groupName) {
  const a = state.neg.api;
  const m = a.mcc;
  m.selectedId = groupId; m.selectedName = groupName;
  m.accountIdsStatus = 'loading'; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(groupId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.accountIds = new Set((data.accounts || []).map((acc) => acc.id));
      m.accountIdsStatus = 'ready';
      if (a.accountId && !m.accountIds.has(a.accountId)) a.accountId = '';
      render();
    })
    .catch((err) => { m.accountIdsStatus = 'error'; m.error = err.message || String(err); render(); });
}

function clearNegMccFilter() {
  const m = state.neg.api.mcc;
  m.selectedId = ''; m.selectedName = ''; m.accountIds = null; m.accountIdsStatus = 'idle'; m.filter = '';
  render();
}

function renderNegMccFilterPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.neg.api.mcc;

  if (m.selectedId) {
    const countLabel = m.accountIdsStatus === 'loading' ? 'cargando…'
      : m.accountIdsStatus === 'ready' ? `${m.accountIds.size} cuenta(s)`
      : 'error';
    return `
      <div class="field">
        <label>Filtrando por MCC</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="delta-badge neutral">${escapeHtml(m.selectedName)} — ${countLabel}</span>
          <button class="btn-link" data-action="neg-mcc-clear">Quitar filtro</button>
        </div>
      </div>`;
  }

  if (m.status === 'idle') {
    return `<div class="field"><button class="btn-outline sm" data-action="neg-mcc-load">Filtrar por MCC (ej. una cadena de hoteles)</button></div>`;
  }
  if (m.status === 'loading') {
    return `<div class="field"><p class="footnote">Cargando agrupaciones del MCC…</p></div>`;
  }
  if (m.status === 'error') {
    return `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  }

  const filter = (m.filter || '').trim().toLowerCase();
  let matches = [];
  if (filter.length >= 2) {
    matches = m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25);
  }
  const matchesHtml = matches.length
    ? `<div class="table-scroll" style="max-height:200px;margin-top:8px">
        <table><tbody>
          ${matches.map((g) => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
              <td><button class="btn-outline xs" data-neg-mcc-pick="${escapeHtml(g.id)}" data-neg-mcc-pick-name="${escapeHtml(g.name)}">Usar</button></td>
            </tr>`).join('')}
        </tbody></table>
      </div>`
    : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');

  return `
    <div class="field">
      <label>Filtrar por MCC</label>
      <input type="text" id="neg-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:320px" />
      ${matchesHtml}
    </div>`;
}

function renderNegApiPanel(fetchAction = 'neg-api-fetch', fetchLabel = 'Traer términos de Google Ads') {
  const a = state.neg.api;

  if (!a.statusChecked) {
    return `<div class="field"><p class="footnote">Consultando la conexión con Google Ads…</p></div>`;
  }

  const simulatedNotice = a.simulated ? `
    <div class="ok-panel" style="margin:10px 0">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor
      (falta la aprobación del developer token de Google) — estos son datos de ejemplo, no de una cuenta real.
    </div>` : '';

  if (a.accountsStatus === 'idle') {
    return `
      <div class="field">
        <p class="footnote">${a.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.'}</p>
        <button class="btn-outline" data-action="neg-api-load-accounts">Ver cuentas disponibles</button>
      </div>`;
  }
  if (a.accountsStatus === 'loading') {
    return `<div class="field"><p class="footnote">Cargando cuentas…</p></div>`;
  }
  if (a.accountsStatus === 'error') {
    return `<div class="error-panel"><strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(a.error)}</div>`;
  }

  const mccFilterActive = a.mcc.selectedId && a.mcc.accountIds;
  const visibleAccounts = mccFilterActive ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
  const accountOptions = ['<option value="">Elige una cuenta…</option>']
    .concat(visibleAccounts.map((acc) => `<option value="${escapeHtml(acc.id)}" ${a.accountId === acc.id ? 'selected' : ''}>${escapeHtml(acc.name)} (${escapeHtml(acc.id)})</option>`))
    .join('');

  return `
    ${simulatedNotice}
    ${renderNegMccFilterPanel()}
    <div class="field">
      <label>Cuenta${mccFilterActive ? ` (${visibleAccounts.length} en "${escapeHtml(a.mcc.selectedName)}")` : ''}</label>
      <select id="neg-api-account" style="width:320px">${accountOptions}</select>
    </div>
    <div class="field">
      <label>...o escribe el ID de la cuenta</label>
      <input type="text" id="neg-api-account-manual" value="${escapeHtml(a.accountIdManual)}" placeholder="ej. 6862893390" style="width:160px" />
    </div>
    <div class="field">
      <label>Periodo</label>
      <select id="neg-api-period" style="width:190px">
        ${[['30', 'Últimos 30 días'], ['60', 'Últimos 60 días'], ['90', 'Últimos 90 días'], ['custom', 'Fechas personalizadas']]
          .map(([v, label]) => `<option value="${v}" ${(a.period || '30') === v ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    ${(a.period || '30') === 'custom' ? `
    <div style="display:flex;gap:24px;flex-wrap:nowrap">
      <div class="field">
        <label>Desde</label>
        <input type="date" id="neg-api-date-from" value="${escapeHtml(a.dateFrom)}" />
      </div>
      <div class="field">
        <label>Hasta</label>
        <input type="date" id="neg-api-date-to" value="${escapeHtml(a.dateTo)}" />
      </div>
    </div>` : `<div class="field"><p class="footnote" style="margin:0">${escapeHtml(a.dateFrom)} a ${escapeHtml(a.dateTo)}</p></div>`}
    <button class="btn-accent" data-action="${fetchAction}">${fetchLabel}</button>
    ${a.error ? `<div class="error-panel" style="margin-top:10px"><strong>No se pudo traer el reporte.</strong> ${escapeHtml(a.error)}</div>` : ''}
  `;
}

// Columnas ordenables de "Candidatos a negativo" — mismo patrón que la
// tabla de acción de Oportunidad de ingresos (oppSortTh/OPP_SORT_KEYS).
const NEG_SORT_KEYS = {
  term: (r) => r.term.toLowerCase(),
  clicks: (r) => r.clicks,
  impr: (r) => r.impr,
  cost: (r) => r.cost,
  conversions: (r) => r.conversions || 0,
};
function negSortTh(label, key, s) {
  const active = s.sortBy === key;
  const arrow = active ? (s.sortDir === 'desc' ? ' ▼' : ' ▲') : '';
  return `<th data-neg-sort="${key}" style="cursor:pointer;user-select:none${active ? ';color:var(--color-text-heading)' : ''}">${escapeHtml(label)}${arrow}</th>`;
}

// Panel de escritura real sobre la cuenta — solo aparece con source==='api',
// porque necesita campaign_id por término (no lo trae un CSV). La vista
// previa (validate_only) siempre corre antes de que "Confirmar" pueda
// aplicar el cambio de verdad; nunca hay un solo clic entre "seleccionar" y
// "escribir en la cuenta real".
function renderNegPushPanel() {
  const s = state.neg;
  const p = s.push;
  const selectedCount = p.selected.size;
  const candidatesCount = getNegFilteredRows().filter((r) => r.clasificacion === 'negativizar').length;
  const busy = p.status === 'previewing' || p.status === 'pushing';
  // Lista aparte de los términos marcados — para poder revisarlos de un
  // vistazo antes de confirmar, sin tener que buscarlos entre todos los
  // candidatos de la tabla de arriba. Se arma contra s.rows (no filtrado
  // por campaña) porque las claves seleccionadas son term::campaign_id.
  const selectedRows = (s.rows || []).filter((r) => p.selected.has(`${r.term}::${r.campaign_id}`));

  // Ahorro estimado SOLO de lo que está marcado ahora mismo — distinto del
  // "ahorro estimado" de arriba (que suma TODOS los candidatos a negativo,
  // estén marcados o no). Las categorías de Performance Max no traen costo
  // (cost_na) — se cuentan aparte para no inflar el número con "N/D" como si
  // fuera $0.
  const selectedWithCost = selectedRows.filter((r) => !r.cost_na);
  const selectedCostNaCount = selectedRows.length - selectedWithCost.length;
  const selectedSavings = selectedWithCost.reduce((sum, r) => sum + (r.cost || 0), 0);
  const selectedConversions = selectedRows.reduce((sum, r) => sum + (r.conversions || 0), 0);

  const savingsHtml = selectedCount > 0 ? `
    <div class="ok-panel" style="margin-bottom:12px">
      <strong>Ahorro estimado con estos ${selectedCount} término${selectedCount === 1 ? '' : 's'}: ${fmtMoney(selectedSavings)}</strong>
      ${selectedCostNaCount > 0 ? `<div style="margin-top:4px;font-size:12px">${selectedCostNaCount} de los seleccionados son categorías de Performance Max sin costo reportado (N/D) — no están incluidas en este número.</div>` : ''}
    </div>
    ${selectedConversions > 0 ? `
      <div class="error-panel" style="margin-bottom:12px">
        <strong>Ojo:</strong> lo seleccionado también generó ${fmtInt(selectedConversions)} conversión${selectedConversions === 1 ? '' : 'es'}. Revisa antes de confirmar — negativizar a ciegas también corta esas conversiones.
      </div>` : ''}` : '';

  const selectedListHtml = selectedCount > 0 ? `
    <div class="table-scroll" style="max-height:200px;border:1px solid var(--color-border);border-radius:var(--radius-sm);margin-bottom:12px">
      <table>
        <thead><tr><th>Término seleccionado</th><th>Campaña</th><th>Costo</th></tr></thead>
        <tbody>${selectedRows.map((r) => `
          <tr>
            <td>${escapeHtml(r.term)}${r.is_category ? ' <span class="delta-badge neutral">categoría PMax</span>' : ''}</td>
            <td>${escapeHtml(r.campaign_name || 'N/D')}</td>
            <td>${r.cost_na ? 'N/D' : fmtMoney(r.cost)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>` : '';

  return `
    <div class="card table-panel" style="margin-bottom:20px">
      <h3 class="dense-chart-title">Subir negativos a Google Ads</h3>
      <p style="margin:0 0 12px;font-size:12.5px;color:var(--color-text-muted)">Marca los términos en la tabla de arriba — se agregan como negativo de concordancia exacta, directo en la campaña donde aparecieron. La vista previa valida contra Google Ads sin aplicar nada; solo al confirmar queda escrito de verdad en la cuenta.</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn-outline sm" data-action="neg-push-select-all">Seleccionar los ${candidatesCount} candidatos</button>
        <button class="btn-outline sm" data-action="neg-push-select-none">Deseleccionar todos</button>
        <span style="font-size:12.5px;color:var(--color-text-muted)">${selectedCount} seleccionado${selectedCount === 1 ? '' : 's'}</span>
      </div>

      ${savingsHtml}
      ${selectedListHtml}

      ${p.status === 'idle' || p.status === 'error' ? `
        <button class="btn-accent" data-action="neg-push-preview" ${selectedCount === 0 || busy ? 'disabled' : ''}>Vista previa</button>
        ${p.error ? `<div class="error-panel" style="margin-top:10px">${escapeHtml(p.error)}</div>` : ''}
      ` : ''}

      ${busy ? `<p class="footnote">${p.status === 'previewing' ? 'Validando con Google Ads (vista previa, no aplica nada todavía)…' : 'Subiendo negativos a Google Ads…'}</p>` : ''}

      ${p.status === 'preview_ready' && p.preview ? `
        <div class="ok-panel" style="margin:10px 0">
          <strong>Vista previa lista.</strong> Google Ads validó ${p.preview.created} de ${p.preview.items.length} sin problema — nada se aplicó todavía.
          ${p.preview.failed && p.preview.failed.length ? `<div style="margin-top:6px"><strong>${p.preview.failed.length} no pasaron la validación:</strong><br>${p.preview.failed.map((m) => escapeHtml(m)).join('<br>')}</div>` : ''}
        </div>
        <button class="btn-accent" data-action="neg-push-confirm">Confirmar y subir a Google Ads</button>
        <button class="btn-outline" data-action="neg-push-cancel">Cancelar</button>
      ` : ''}

      ${p.status === 'done' && p.result ? `
        <div class="ok-panel" style="margin:10px 0">
          <strong>Listo.</strong> Se subieron ${p.result.created} negativos a Google Ads.
          ${p.result.failed && p.result.failed.length ? `<div style="margin-top:6px"><strong>${p.result.failed.length} fallaron:</strong><br>${p.result.failed.map((m) => escapeHtml(m)).join('<br>')}</div>` : ''}
        </div>
      ` : ''}
    </div>`;
}

function renderNegReady() {
  const s = state.neg;
  const rows = getNegFilteredRows();
  const summary = engine.summarizeClassification(rows);
  const maxCost = Math.max(1, summary.mantener.costo, summary.revisar.costo, summary.negativizar.costo);
  const hasCampaign = s.source === 'api';

  const chartRows = [
    { campaign: 'Mantener', valueLabel: fmtMoney(summary.mantener.costo), width: pctWidth(summary.mantener.costo, maxCost), color: 'var(--navy-800)' },
    { campaign: 'Revisar', valueLabel: fmtMoney(summary.revisar.costo), width: pctWidth(summary.revisar.costo, maxCost), color: 'var(--warn-strong)' },
    { campaign: 'Negativizar', valueLabel: fmtMoney(summary.negativizar.costo), width: pctWidth(summary.negativizar.costo, maxCost), color: 'var(--danger)' },
  ];

  const sortKeyFn = NEG_SORT_KEYS[s.sortBy] || NEG_SORT_KEYS.cost;
  const sortDirMul = s.sortDir === 'asc' ? 1 : -1;
  const negativizarAll = rows.filter((r) => r.clasificacion === 'negativizar')
    .sort((a, b) => (sortKeyFn(a) > sortKeyFn(b) ? 1 : sortKeyFn(a) < sortKeyFn(b) ? -1 : 0) * sortDirMul);
  const revisarAll = rows.filter((r) => r.clasificacion === 'revisar').sort((a, b) => b.cost - a.cost);

  const hasPmaxCategory = rows.some((r) => r.is_category);
  const termRowHtml = (r, withCheckbox) => `
    <tr>
      ${withCheckbox ? `<td><input type="checkbox" class="neg-push-checkbox" data-key="${escapeHtml(`${r.term}::${r.campaign_id}`)}" ${s.push.selected.has(`${r.term}::${r.campaign_id}`) ? 'checked' : ''} /></td>` : ''}
      <td>${escapeHtml(r.term)}${r.is_category ? ` <span class="delta-badge neutral" title="Categoría de búsqueda de Performance Max — Google agrupa búsquedas parecidas bajo esta etiqueta en vez de exponer el término literal exacto.">categoría PMax</span>` : ''}</td>
      ${hasCampaign ? `<td>${escapeHtml(r.campaign_name || 'N/D')}</td>` : ''}
      <td>${fmtInt(r.clicks)}</td>
      <td>${fmtInt(r.impr)}</td>
      <td>${r.cost_na ? 'N/D' : fmtMoney(r.cost)}</td>
      <td>${fmtInt(r.conversions || 0)}</td>
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
          <thead><tr>
            ${hasCampaign ? '<th></th>' : ''}
            ${negSortTh('Término', 'term', s)}
            ${hasCampaign ? '<th>Campaña</th>' : ''}
            ${negSortTh('Clics', 'clicks', s)}
            ${negSortTh('Impr.', 'impr', s)}
            ${negSortTh('Costo', 'cost', s)}
            ${negSortTh('Conversiones', 'conversions', s)}
          </tr></thead>
          <tbody>${negativizarAll.slice(0, 50).map((r) => termRowHtml(r, hasCampaign)).join('')}</tbody>
        </table>
      </div>
    </div>

    ${hasCampaign ? renderNegPushPanel() : ''}

    <div class="card table-panel">
      <div class="table-panel-head">
        <h3>Revisar antes de decidir — ${revisarCaption}</h3>
        <button class="btn-outline sm" data-action="download-neg-revisar">Descargar CSV</button>
      </div>
      <p style="margin:0 0 12px;font-size:12.5px;color:var(--color-text-muted)">Contienen un término núcleo pero también una excepción conocida — no se clasifican solos.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Término</th>${hasCampaign ? '<th>Campaña</th>' : ''}<th>Clics</th><th>Impr.</th><th>Costo</th><th>Conversiones</th></tr></thead>
          <tbody>${revisarAll.slice(0, 50).map((r) => termRowHtml(r, false)).join('')}</tbody>
        </table>
      </div>
    </div>

    <p class="footnote">
      El mecanismo compara texto contra los términos núcleo y las excepciones definidas — no usa un modelo de lenguaje por término.
      Solo detecta la ambigüedad anticipada como excepción; nunca subas "candidatos a negativo" a Google Ads sin revisión humana.
      ${hasPmaxCategory ? ' Los términos marcados "categoría PMax" vienen de campañas Performance Max: Google no expone el texto exacto de búsqueda para este tipo de campaña vía API (ni en la interfaz), solo categorías que agrupan búsquedas parecidas — el costo por categoría tampoco está disponible (columna "N/D"), así que el ahorro estimado de arriba no lo incluye. La escritura de negativos sí está confirmada contra una cuenta real para Performance Max, igual que en Search.' : ''}
    </p>
  `;
}

function runNegAnalysis(text, fileName) {
  const s = state.neg;
  try {
    const coreTerms = s.core.split('\n').map((v) => v.trim()).filter(Boolean);
    if (!coreTerms.length) throw new Error('Escribe al menos un término núcleo para poder clasificar.');
    const exceptions = s.exceptions.split('\n').map((v) => v.trim()).filter(Boolean);
    s.currency = '';
    const rows = engine.loadSearchTerms(text);
    const classified = engine.classifyTerms(rows, coreTerms, exceptions);
    Object.assign(s, { status: 'ready', rows: classified, fileName, campaignFilter: 'all' });
  } catch (err) {
    Object.assign(s, { status: 'error', error: err.message || String(err), fileName });
  }
  render();
}

function runNegAnalysisFromApiRows(apiRows, fileName) {
  const s = state.neg;
  try {
    const coreTerms = s.core.split('\n').map((v) => v.trim()).filter(Boolean);
    if (!coreTerms.length) throw new Error('Escribe al menos un término núcleo para poder clasificar.');
    const exceptions = s.exceptions.split('\n').map((v) => v.trim()).filter(Boolean);
    const rows = engine.loadSearchTermsFromApi(apiRows);
    const classified = engine.classifyTerms(rows, coreTerms, exceptions);
    s.push.selected = new Set(); s.push.status = 'idle'; s.push.preview = null; s.push.result = null; s.push.error = null;
    Object.assign(s, { status: 'ready', rows: classified, fileName, campaignFilter: 'all' });
  } catch (err) {
    Object.assign(s, { status: 'error', error: err.message || String(err), fileName });
  }
  render();
}

// Periodo rápido (30, 60 o 90 días): termina ayer, porque el día en curso viene incompleto.
function negApplyPeriod(period) {
  const a = state.neg.api;
  a.period = period;
  if (period === 'custom') return;
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const to = new Date(); to.setDate(to.getDate() - 1);
  const from = new Date(to); from.setDate(from.getDate() - (Number(period) - 1));
  a.dateFrom = iso(from); a.dateTo = iso(to);
}

function ensureNegGoogleAdsStatusLoaded() {
  const a = state.neg.api;
  if (a.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { a.statusChecked = true; a.configured = !!data.configured; render(); })
    .catch(() => { a.statusChecked = true; a.configured = false; render(); });
}

function loadNegGoogleAdsAccounts() {
  const a = state.neg.api;
  a.accountsStatus = 'loading'; a.error = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.accounts = data.accounts || [];
      a.simulated = !!data.simulated;
      if (!a.dateFrom || !a.dateTo) negApplyPeriod(a.period || '30');
      a.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.accountsStatus = 'error'; a.error = err.message || String(err);
      render();
    });
}

function fetchGoogleAdsSearchTerms() {
  const a = state.neg.api;
  const manualId = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  const customerId = manualId || a.accountId;
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }
  if (!a.dateFrom || !a.dateTo) { a.error = 'Elige el rango de fechas primero.'; render(); return; }

  a.error = null;
  state.neg.status = 'loading'; state.neg.error = null;
  render();

  const params = new URLSearchParams({ customer_id: customerId || '', date_from: a.dateFrom, date_to: a.dateTo });
  const campaignListParams = new URLSearchParams({ customer_id: customerId || '' });

  // Se traen en paralelo: los términos de búsqueda (solo Search, por diseño
  // de Google) y el listado completo de campañas activas (todos los tipos)
  // — el segundo alimenta el filtro por campaña para que también se puedan
  // ver campañas Performance Max / Demand Gen / Display aunque no tengan
  // términos que negativizar.
  Promise.all([
    fetch(`/api/google-ads/search-terms?${params.toString()}`).then((r) => r.json().then((data) => ({ ok: r.ok, data }))),
    fetch(`/api/google-ads/campaign-list?${campaignListParams.toString()}`).then((r) => r.json().then((data) => ({ ok: r.ok, data }))),
  ])
    .then(([termsResp, campaignsResp]) => {
      if (!termsResp.ok) throw new Error(termsResp.data.error || 'Error desconocido.');
      a.simulated = !!termsResp.data.simulated;
      state.neg.currency = termsResp.data.currency || '';
      a.allCampaigns = campaignsResp.ok ? (campaignsResp.data.campaigns || []) : [];
      const account = a.accounts.find((acc) => acc.id === customerId);
      const label = a.simulated
        ? `Google Ads (simulado) — ${a.dateFrom} a ${a.dateTo}`
        : `Google Ads — ${account ? account.name : customerId} — ${a.dateFrom} a ${a.dateTo}`;
      runNegAnalysisFromApiRows(termsResp.data.rows || [], label);
    })
    .catch((err) => {
      a.error = err.message || String(err);
      state.neg.status = 'idle';
      render();
    });
}

// Sube a Google Ads los negativos marcados en state.neg.push.selected.
// preview=true valida sin aplicar (vista previa) — solo al confirmar
// (preview=false) el cambio queda escrito de verdad en la cuenta real.
function pushNegativeKeywords(preview) {
  const s = state.neg;
  const a = s.api;
  const manualId = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  const customerId = manualId || a.accountId;
  const rows = s.rows || [];
  const items = [...s.push.selected].map((key) => {
    const row = rows.find((r) => `${r.term}::${r.campaign_id}` === key);
    return row ? { campaign_id: row.campaign_id, term: row.term, campaign_name: row.campaign_name } : null;
  }).filter(Boolean);

  if (!items.length) { s.push.error = 'Selecciona al menos un término.'; render(); return; }

  s.push.status = preview ? 'previewing' : 'pushing';
  s.push.error = null;
  render();

  fetch('/api/google-ads/negative-keywords', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: customerId,
      items: items.map((i) => ({ campaign_id: i.campaign_id, campaign_name: i.campaign_name, term: i.term })),
      validate_only: preview,
    }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (preview) {
        s.push.status = 'preview_ready';
        s.push.preview = { ...data, items };
      } else {
        s.push.status = 'done';
        s.push.result = data;
        s.push.selected = new Set();
      }
      render();
    })
    .catch((err) => {
      s.push.status = 'error';
      s.push.error = err.message || String(err);
      render();
    });
}

// ---------------------------------------------------------------------------
// Negativización — pestaña "Con IA" (en afinado: solo super admin).
//
// La IA (Claude) lee los términos de búsqueda y dice qué negativizar —agrupado
// por tema, con la palabra o frase negativa propuesta—, qué dejar y qué
// revisar. El servidor valida lo que contesta con código (negativos_ia.py):
// choques con términos que convierten o de marca, palabras genéricas,
// negativas que ya existen. Subir a Google Ads usa el mismo flujo de vista
// previa y confirmar que la vista de reglas.
// ---------------------------------------------------------------------------

function negAiFresh() {
  return {
    ctx: { marca: '', destino: '', ofrece: '', no_ofrece: '' },
    view: 'ia', // 'ia' | 'palabras'
    words: { status: 'idle', error: null, result: null }, // palabras frecuentes sin IA
    includePmax: true, pmaxFallback: false, // incluir términos reales de Performance Max (campaign_search_term_view)
    rowsStatus: 'idle', rowsError: null, rows: null, rowsLabel: '', customerId: '',
    status: 'idle', error: null, result: null,
    selected: new Set(), // "n:<id de negativa>" | "e:<id de tema>"
    push: { status: 'idle', preview: null, result: null, error: null },
    // Historial de subidas de la cuenta y el deshacer de una de ellas (vista previa y confirmar).
    hist: { status: 'idle', customer: '', uploads: [], error: null, open: new Set(), undo: { uploadId: null, status: 'idle', preview: null, result: null, error: null } },
  };
}

// Los temas con negativas marcables: los de la IA y el de "Palabras frecuentes" (sin IA); comparten selección y subida.
function negAiAllTemas() {
  const ai = state.neg.ai;
  return [...((ai.result && ai.result.temas) || []), ...((ai.words && ai.words.result && ai.words.result.temas) || [])];
}

function negAiCustomerId() {
  const a = state.neg.api;
  return (a.accountIdManual || '').replace(/[^0-9]/g, '') || a.accountId;
}

function resetNegAiResult() {
  const ai = state.neg.ai;
  ai.status = 'idle'; ai.error = null; ai.result = null;
  ai.words = { status: 'idle', error: null, result: null };
  ai.selected = new Set();
  ai.push = { status: 'idle', preview: null, result: null, error: null };
}

function negAiSetRows(rows, label, customerId) {
  const ai = state.neg.ai;
  ai.rows = rows; ai.rowsLabel = label; ai.customerId = customerId || '';
  ai.rowsStatus = 'ready'; ai.rowsError = null;
  resetNegAiResult();
  render();
}

function fetchNegAiTerms() {
  const s = state.neg;
  const a = s.api;
  const ai = s.ai;
  const customerId = negAiCustomerId();
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }
  if (!a.dateFrom || !a.dateTo) { a.error = 'Elige el rango de fechas primero.'; render(); return; }
  a.error = null;
  ai.rowsStatus = 'loading'; ai.rowsError = null;
  render();
  const params = new URLSearchParams({ customer_id: customerId || '', date_from: a.dateFrom, date_to: a.dateTo });
  if (ai.includePmax) params.set('pmax_terms', '1');
  fetch(`/api/google-ads/search-terms?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.simulated = !!data.simulated;
      ai.currency = data.currency || '';
      const account = a.accounts.find((acc) => acc.id === customerId);
      const label = a.simulated
        ? `Google Ads (simulado) — ${a.dateFrom} a ${a.dateTo}`
        : `Google Ads — ${account ? account.name : customerId} — ${a.dateFrom} a ${a.dateTo}`;
      ai.pmaxFallback = !!data.pmax_fallback;
      negAiSetRows(engine.loadSearchTermsFromApi(data.rows || []), label, customerId);
    })
    .catch((err) => { ai.rowsStatus = 'idle'; a.error = err.message || String(err); render(); });
}

function negAiRowsPayload() {
  return state.neg.ai.rows.map((r) => ({
    term: r.term, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
    clicks: r.clicks, impr: r.impr, cost: r.cost_na ? 0 : r.cost, conversions: r.conversions, is_category: !!r.is_category, pmax: !!r.pmax,
  }));
}

// Palabras que se repiten, gastan y nunca convirtieron: sin IA, sin costo, sobre todos los términos.
function runNegAiWords() {
  const ai = state.neg.ai;
  if (!ai.rows || !ai.rows.length) { ai.words = { status: 'error', error: 'Primero trae los términos de búsqueda.', result: null }; render(); return; }
  if (!ai.ctx.marca.trim()) { ai.words = { status: 'error', error: 'Escribe el nombre del hotel o la marca: sirve para que ninguna palabra sugerida la incluya.', result: null }; render(); return; }
  ai.words = { status: 'loading', error: null, result: null };
  ai.push = { status: 'idle', preview: null, result: null, error: null };
  render();
  fetch('/api/negativos/palabras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: ai.customerId, contexto: { marca: ai.ctx.marca, destino: ai.ctx.destino }, rows: negAiRowsPayload() }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      ai.words = { status: 'ready', error: null, result: data };
      render();
    })
    .catch((err) => { ai.words = { status: 'error', error: err.message || String(err), result: null }; render(); });
}

function runNegAiAnalysis() {
  const ai = state.neg.ai;
  if (!ai.rows || !ai.rows.length) { ai.error = 'Primero trae los términos de búsqueda.'; ai.status = 'error'; render(); return; }
  if (!ai.ctx.marca.trim()) { ai.error = 'Escribe el nombre del hotel o la marca: sirve para que la IA nunca niegue búsquedas de tu propia marca.'; ai.status = 'error'; render(); return; }
  ai.status = 'loading'; ai.error = null; ai.result = null;
  ai.selected = new Set(); ai.push = { status: 'idle', preview: null, result: null, error: null };
  render();
  fetch('/api/ai/analizar-negativos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: ai.customerId,
      contexto: ai.ctx,
      rows: ai.rows.map((r) => ({
        term: r.term, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
        clicks: r.clicks, impr: r.impr, cost: r.cost_na ? 0 : r.cost, conversions: r.conversions, is_category: !!r.is_category, pmax: !!r.pmax,
      })),
    }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      ai.result = data; ai.status = 'ready';
      // Por defecto se marcan las palabras de riesgo bajo que aún no existen en la cuenta.
      (data.temas || []).forEach((t) => t.negativas.forEach((n) => {
        if (negAiIsSafeDefault(n)) ai.selected.add(`n:${n.id}`);
      }));
      render();
    })
    .catch((err) => { ai.status = 'error'; ai.error = err.message || String(err); render(); });
}

// Términos sueltos marcados en "Revisar" (r:) o en "Qué dejar" (k:), con su origen.
function negAiMarkedTerms() {
  const ai = state.neg.ai;
  const res = ai.result || {};
  const out = [];
  (res.revisar || []).forEach((t) => { if (ai.selected.has(`r:${t.key}`)) out.push({ ...t, from: 'revisar' }); });
  (res.mantener || []).forEach((g) => g.terminos.forEach((t) => { if (ai.selected.has(`k:${t.key}`)) out.push({ ...t, from: 'dejar' }); }));
  return out;
}

// Lo marcado, listo para subir: [{ campaign_id, campaign_name, term, match_type }] sin repetidos.
function negAiSelectedItems() {
  const ai = state.neg.ai;
  const items = []; const seen = new Set();
  const add = (camps, term, matchType) => (camps || []).forEach((c) => {
    const key = `${c.id}|${term}|${matchType}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ campaign_id: c.id, campaign_name: c.name, term, match_type: matchType, pmax: !!c.pmax });
  });
  negAiAllTemas().forEach((t) => {
    t.negativas.forEach((n) => { if (ai.selected.has(`n:${n.id}`)) add(n.campanias, n.texto, n.concordancia === 'FRASE' ? 'PHRASE' : 'EXACT'); });
    if (ai.selected.has(`e:${t.id}`)) t.exactas.forEach((e) => add(e.campanias, e.term, 'EXACT'));
  });
  negAiMarkedTerms().forEach((t) => add(t.campanias, t.term, 'EXACT'));
  return items;
}

function pushNegAi(preview) {
  const ai = state.neg.ai;
  const items = negAiSelectedItems();
  if (!items.length) { ai.push.status = 'error'; ai.push.error = 'Marca al menos una palabra negativa con campañas donde subirla.'; render(); return; }
  ai.push.status = preview ? 'previewing' : 'pushing'; ai.push.error = null;
  render();
  fetch('/api/google-ads/negative-keywords', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: ai.customerId,
      origen: 'ia',
      items: items.map((i) => ({ campaign_id: i.campaign_id, campaign_name: i.campaign_name, term: i.term, match_type: i.match_type })),
      validate_only: preview,
    }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (preview) { ai.push.status = 'preview_ready'; ai.push.preview = { ...data, items }; }
      else { ai.push.status = 'done'; ai.push.result = data; ai.selected = new Set(); ai.hist.status = 'idle'; }
      render();
    })
    .catch((err) => { ai.push.status = 'error'; ai.push.error = err.message || String(err); render(); });
}

function ensureNegAiHistory() {
  const h = state.neg.ai.hist;
  const customerId = negAiCustomerId() || (state.neg.api.simulated ? 'simulada' : '');
  if (!customerId) return;
  if (h.status === 'idle' || (h.customer !== customerId && h.status !== 'loading')) loadNegAiHistory(customerId);
}

function loadNegAiHistory(customerId) {
  const h = state.neg.ai.hist;
  h.status = 'loading'; h.customer = customerId; h.error = null;
  fetch(`/api/google-ads/negative-uploads?customer_id=${encodeURIComponent(customerId === 'simulada' ? '' : customerId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      h.uploads = data.uploads || []; h.status = 'ready';
      render();
    })
    .catch((err) => { h.status = 'error'; h.error = err.message || String(err); render(); });
}

// Deshacer una subida: primero la vista previa de Google (no quita nada) y solo después "Confirmar y quitar".
function undoNegAiUpload(uploadId, preview) {
  const h = state.neg.ai.hist;
  const u = h.undo;
  u.uploadId = uploadId; u.status = preview ? 'previewing' : 'removing'; u.error = null;
  render();
  fetch('/api/google-ads/negative-uploads/undo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: h.customer === 'simulada' ? '' : h.customer, upload_id: uploadId, validate_only: preview }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (preview) { u.status = 'preview_ready'; u.preview = data; render(); }
      else { u.status = 'done'; u.result = data; loadNegAiHistory(h.customer); }
    })
    .catch((err) => { u.status = 'error'; u.error = err.message || String(err); render(); });
}

function renderNegAiHistory() {
  const h = state.neg.ai.hist;
  const customerId = negAiCustomerId() || (state.neg.api.simulated ? 'simulada' : '');
  if (!customerId) return '';
  const u = h.undo;
  let body = '';
  if (h.status === 'loading' || h.status === 'idle') body = '<p class="footnote">Cargando el historial…</p>';
  else if (h.status === 'error') body = `<div class="error-panel">${escapeHtml(h.error)}</div>`;
  else if (!h.uploads.length) body = '<p class="footnote">Todavía no se ha subido ninguna negativa a esta cuenta desde la plataforma. Aquí aparecerán las que subas, con quién y cuándo, y podrás deshacerlas.</p>';
  else {
    body = h.uploads.map((up) => {
      const isOpen = h.open.has(up.id);
      const mine = u.uploadId === up.id;
      let undoHtml = '';
      if (up.activas > 0) {
        if (mine && (u.status === 'previewing' || u.status === 'removing')) {
          undoHtml = `<span class="footnote">${u.status === 'previewing' ? 'Validando con Google Ads…' : 'Quitando las negativas…'}</span>`;
        } else if (mine && u.status === 'preview_ready' && u.preview) {
          undoHtml = `<div class="ok-panel" style="margin:8px 0;padding:10px 12px;font-size:12.5px"><strong>Vista previa lista.</strong> Google validó quitar ${u.preview.removed} negativa${u.preview.removed === 1 ? '' : 's'}; todavía no se quitó nada. Esas búsquedas podrían volver a servirse.
            ${u.preview.failed && u.preview.failed.length ? `<div style="margin-top:6px"><strong>${u.preview.failed.length} no se podrían quitar:</strong><br>${u.preview.failed.map((m) => escapeHtml(m)).join('<br>')}</div>` : ''}
            <div style="margin-top:8px;display:flex;gap:8px"><button class="btn-accent sm" data-neg-ai-undo-confirm="${up.id}">Confirmar y quitar</button><button class="btn-outline sm" data-action="neg-ai-undo-cancel">Cancelar</button></div></div>`;
        } else {
          undoHtml = `<button class="btn-outline sm" data-neg-ai-undo="${up.id}">Deshacer</button>`;
        }
      } else {
        undoHtml = `<span class="delta-badge neutral">${up.undone_at ? 'deshecha' : 'sin negativas activas'}</span>`;
      }
      const err = mine && u.status === 'error' ? `<div class="error-panel" style="margin-top:6px;font-size:12px">${escapeHtml(u.error)}</div>` : '';
      const done = mine && u.status === 'done' && u.result ? `<div class="ok-panel" style="margin-top:6px;padding:8px 12px;font-size:12.5px"><strong>Listo.</strong> Se quitaron ${u.result.removed} negativa${u.result.removed === 1 ? '' : 's'}.${u.result.failed && u.result.failed.length ? ` ${u.result.failed.length} no se pudieron quitar: ${u.result.failed.map((m) => escapeHtml(m)).join('; ')}` : ''}</div>` : '';
      const items = isOpen ? `<div class="table-scroll" style="max-height:240px;margin-top:8px"><table>
        <thead><tr><th>Negativa</th><th>Concordancia</th><th>Campaña</th><th>Estado</th></tr></thead>
        <tbody>${up.items.map((i) => `<tr><td>${escapeHtml(i.text)}</td><td>${i.match_type === 'PHRASE' ? 'frase' : 'exacta'}</td><td>${escapeHtml(i.campaign_name || i.campaign_id)}</td><td>${i.removed ? '<span class="delta-badge neutral">quitada</span>' : '<span class="delta-badge good">activa</span>'}</td></tr>`).join('')}</tbody></table></div>
        ${up.created > up.items.length ? `<p class="footnote">Mostrando ${up.items.length} de ${up.created}.</p>` : ''}` : '';
      return `
        <div style="border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:10px">
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between">
            <div style="font-size:13px"><strong>${fmtDateTime(up.created_at)}</strong> · ${escapeHtml(up.username)} · <span class="delta-badge neutral">${up.origen === 'ia' ? 'con IA' : 'por reglas'}</span>
              <span class="footnote" style="margin-left:6px">${up.created} negativa${up.created === 1 ? '' : 's'} · ${up.activas} activa${up.activas === 1 ? '' : 's'}</span></div>
            <div style="display:flex;gap:8px;align-items:center"><button class="btn-outline sm" data-neg-ai-hist-open="${up.id}">${isOpen ? 'Ocultar' : 'Ver'}</button>${mine && (u.status === 'preview_ready' || u.status === 'previewing' || u.status === 'removing') ? '' : undoHtml}</div>
          </div>
          ${mine && (u.status === 'preview_ready' || u.status === 'previewing' || u.status === 'removing') ? undoHtml : ''}
          ${err}${done}${items}
        </div>`;
    }).join('');
  }
  return `
    <div class="card table-panel" style="margin-top:20px">
      <div class="table-panel-head"><h3>Historial de negativas subidas</h3><button class="btn-outline sm" data-action="neg-ai-hist-reload">Actualizar</button></div>
      <p style="margin:0 0 10px;font-size:12.5px;color:var(--color-text-muted)">Lo que se subió a esta cuenta desde la plataforma (con IA o por reglas). Deshacer quita esas negativas de las campañas, con vista previa antes; no toca las que se pusieron por otra vía.</p>
      ${body}
    </div>`;
}

function downloadNegAiCsv() {
  const ai = state.neg.ai;
  const rows = [['Palabra negativa', 'Concordancia', 'Campaña', 'Tema']];
  negAiAllTemas().forEach((t) => {
    t.negativas.forEach((n) => {
      if (!ai.selected.has(`n:${n.id}`)) return;
      const camps = n.campanias.length ? n.campanias : [{ name: '' }];
      camps.forEach((c) => rows.push([n.texto, n.concordancia === 'FRASE' ? 'Frase' : 'Exacta', c.name, t.tema]));
    });
    if (ai.selected.has(`e:${t.id}`)) t.exactas.forEach((e) => {
      const camps = e.campanias.length ? e.campanias : [{ name: '' }];
      camps.forEach((c) => rows.push([e.term, 'Exacta', c.name, t.tema]));
    });
  });
  negAiMarkedTerms().forEach((t) => {
    const camps = t.campanias.length ? t.campanias : [{ name: '' }];
    camps.forEach((c) => rows.push([t.term, 'Exacta', c.name, t.from === 'dejar' ? 'Dejar' : 'Revisar']));
  });
  engine.downloadCsv('negativas_ia.csv', rows);
}

// Se marcan solas las de riesgo bajo que aún no existen y que bloquean gasto real: una negativa que no
// frena ni un centavo solo ensucia la cuenta; sigue disponible para marcarla a mano.
function negAiIsSafeDefault(n) {
  return n.riesgo === 'bajo' && !n.ya_existe && n.bloquea.costo > 0;
}

function negAiRiskBadge(risk) {
  if (risk === 'alto') return '<span class="delta-badge bad">riesgo alto</span>';
  if (risk === 'medio') return '<span class="delta-badge warn">riesgo medio</span>';
  return '<span class="delta-badge good">riesgo bajo</span>';
}

function negAiTermsTable(terms, limit) {
  const shown = terms.slice(0, limit);
  return `
    <div class="table-scroll" style="max-height:260px">
      <table>
        <thead><tr><th>Término</th><th>Clics</th><th>Costo</th><th>Conv.</th></tr></thead>
        <tbody>${shown.map((t) => `<tr><td>${escapeHtml(t.term)}${t.pmax ? ' <span class="delta-badge neutral">PMax</span>' : ''}</td><td>${fmtInt(t.clicks)}</td><td>${fmtMoney(t.cost)}</td><td>${fmtInt(t.conversions)}</td></tr>`).join('')}</tbody>
      </table>
    </div>
    ${terms.length > shown.length ? `<p class="footnote">Mostrando ${shown.length} de ${terms.length}.</p>` : ''}`;
}

function renderNegAiTema(t, canPush) {
  const ai = state.neg.ai;
  const negRows = t.negativas.map((n) => {
    const choques = n.choques.length ? `
      <div style="margin-top:4px;font-size:12px;color:var(--danger)">Choca con: ${n.choques.map((c) => `"${escapeHtml(c.term)}" (${c.motivo === 'convierte' ? `convierte: ${fmtInt(c.conversions)} conv.` : c.motivo === 'marca' ? 'lleva la marca' : c.motivo === 'parecida' ? 'parece un error de escritura de la marca' : 'la IA lo dejó'})`).join(', ')}${n.choques_total > n.choques.length ? ` y ${n.choques_total - n.choques.length} más` : ''}.</div>` : '';
    const kwConf = n.conflictos_kw_total ? `
      <div style="margin-top:4px;font-size:12px;color:var(--danger)"><strong>Bloquearía tu propia palabra clave activa:</strong> ${n.conflictos_kw.map((c) => `"${escapeHtml(c.keyword)}" (${escapeHtml(c.campaign)})`).join(', ')}${n.conflictos_kw_total > n.conflictos_kw.length ? ` y ${n.conflictos_kw_total - n.conflictos_kw.length} más` : ''}.</div>` : '';
    const ejemplos = n.ejemplos && n.ejemplos.length ? `
      <div style="margin-top:4px;font-size:12px;color:var(--color-text-muted)">Ejemplos: ${n.ejemplos.map((e) => `"${escapeHtml(e)}"`).join(', ')}.</div>` : '';
    const extra = n.extra.terminos ? `
      <div style="margin-top:4px;font-size:12px;color:var(--color-text-muted)">También bloquea ${n.extra.terminos} término${n.extra.terminos === 1 ? '' : 's'} que la IA no revisó (${fmtMoney(n.extra.costo)}): ${n.extra.ejemplos.map((e) => `"${escapeHtml(e)}"`).join(', ')}.</div>` : '';
    const disabled = n.ya_existe;
    return `
      <tr>
        <td><input type="checkbox" data-neg-ai-sel="n:${escapeHtml(n.id)}" ${ai.selected.has(`n:${n.id}`) ? 'checked' : ''} ${disabled ? 'disabled' : ''} /></td>
        <td><strong>${escapeHtml(n.texto)}</strong> <span class="delta-badge neutral">${n.concordancia === 'FRASE' ? 'frase' : 'exacta'}</span>${kwConf}${choques}${ejemplos}${extra}</td>
        <td>${fmtInt(n.bloquea.terminos)} término${n.bloquea.terminos === 1 ? '' : 's'}<div style="margin:2px 0 0;font-size:11.5px;color:var(--color-text-muted)">${fmtMoney(n.bloquea.costo)} · ${fmtInt(n.bloquea.clics)} clics</div></td>
        <td>${negAiRiskBadge(n.riesgo)}</td>
        <td>${n.ya_existe ? '<span class="footnote">ya existe en las campañas</span>' : (canPush ? `${n.campanias.length} campaña${n.campanias.length === 1 ? '' : 's'}` : '<span class="footnote">—</span>')}</td>
      </tr>`;
  }).join('');
  const exactasCost = t.exactas.reduce((sum, e) => sum + e.cost, 0);
  const exactasKw = t.exactas.filter((e) => e.kw_conflicto).length;
  const exactasRow = t.exactas.length ? `
    <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px">
      <input type="checkbox" data-neg-ai-sel="e:${escapeHtml(t.id)}" ${ai.selected.has(`e:${t.id}`) ? 'checked' : ''} />
      <span>Alternativa segura: subir solo estos ${t.exactas.length} término${t.exactas.length === 1 ? '' : 's'} como negativas exactas (sin los que convierten) · ${fmtMoney(exactasCost)}${exactasKw ? ` · <strong style="color:var(--danger)">${exactasKw} ${exactasKw === 1 ? 'es una palabra clave tuya activa' : 'son palabras clave tuyas activas'}</strong>` : ''}</span>
    </label>` : '';
  return `
    <div class="card table-panel" style="margin-bottom:16px">
      <div class="table-panel-head">
        <h3>${escapeHtml(t.tema)}</h3>
        <span class="footnote">${fmtInt(t.total.terminos)} término${t.total.terminos === 1 ? '' : 's'} · ${fmtMoney(t.total.costo)} · ${fmtInt(t.total.clics)} clics</span>
      </div>
      <p style="margin:0 0 12px;font-size:13px">${escapeHtml(t.razon)}</p>
      ${t.negativas.length ? `
        <div class="table-scroll" style="max-height:480px"><table>
          <thead><tr><th></th><th>Palabra negativa propuesta</th><th>Bloquearía</th><th>Riesgo</th><th>Campañas</th></tr></thead>
          <tbody>${negRows}</tbody>
        </table></div>` : '<p class="footnote">La IA no propuso una palabra negativa válida para este tema; puedes usar la alternativa de abajo.</p>'}
      ${exactasRow}
      ${t.terminos.length ? `<details style="margin-top:12px"><summary style="cursor:pointer;font-size:13px">Ver los ${t.terminos.length} término${t.terminos.length === 1 ? '' : 's'} de este tema</summary>${negAiTermsTable(t.terminos, 50)}</details>` : ''}
    </div>`;
}

function renderNegAiPushPanel() {
  const ai = state.neg.ai;
  const p = ai.push;
  const items = negAiSelectedItems();
  const busy = p.status === 'previewing' || p.status === 'pushing';
  const selectedNeg = []; let exactasCount = 0;
  negAiAllTemas().forEach((t) => {
    t.negativas.forEach((n) => { if (ai.selected.has(`n:${n.id}`)) selectedNeg.push(n); });
    if (ai.selected.has(`e:${t.id}`)) exactasCount += t.exactas.length;
  });
  const selectedReview = negAiMarkedTerms(); // sueltos de "revisar" y de "dejar"
  const reviewBrand = selectedReview.filter((r) => r.es_marca).length;
  // Lo marcado que bloquearía palabras clave activas: negativas de frase/exacta con choque, términos sueltos que son
  // una palabra clave tuya y exactas de la alternativa segura que lo son.
  let exactasKwMarcadas = 0;
  negAiAllTemas().forEach((t) => { if (ai.selected.has(`e:${t.id}`)) exactasKwMarcadas += t.exactas.filter((e) => e.kw_conflicto).length; });
  const kwConflicts = selectedNeg.filter((n) => n.conflictos_kw_total > 0).length + selectedReview.filter((r) => r.kw_conflicto).length + exactasKwMarcadas;
  // Unión de términos: dos negativas que bloquean el mismo término (p. ej. con y sin tilde) cuentan una vez.
  const blockedByKey = new Map();
  selectedNeg.forEach((n) => (n.bloqueados || []).forEach(([key, cost, conv]) => blockedByKey.set(key, [cost, conv])));
  negAiAllTemas().forEach((t) => {
    if (ai.selected.has(`e:${t.id}`)) t.exactas.forEach((e) => blockedByKey.set(e.key, [e.cost, 0]));
  });
  selectedReview.forEach((r) => blockedByKey.set(r.key, [r.cost, r.conversions]));
  let savings = 0; let convAtRisk = 0;
  blockedByKey.forEach(([cost, conv]) => { savings += cost; convAtRisk += conv; });
  const highRisk = selectedNeg.filter((n) => n.riesgo === 'alto');
  const canPush = !!ai.customerId;
  const campaigns = new Set(items.map((i) => i.campaign_id)).size;

  return `
    <div class="card table-panel" style="margin-bottom:20px">
      <h3 class="dense-chart-title">Lo que vas a subir</h3>
      <p style="margin:0 0 12px;font-size:12.5px;color:var(--color-text-muted)">
        ${canPush
          ? 'Cada palabra se agrega como negativa en las campañas donde aparecieron sus términos. La vista previa valida contra Google Ads sin aplicar nada; solo al confirmar queda escrito en la cuenta.'
          : 'Con un archivo no hay campañas asociadas a cada término, así que no se puede subir directo. Descarga el CSV con lo marcado y súbelo desde Google Ads Editor.'}
      </p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn-outline sm" data-action="neg-ai-select-safe">Marcar las de riesgo bajo con gasto</button>
        <button class="btn-outline sm" data-action="neg-ai-select-none">Quitar todas</button>
        <button class="btn-outline sm" data-action="neg-ai-csv" ${selectedNeg.length || exactasCount || selectedReview.length ? '' : 'disabled'}>Descargar CSV de lo marcado</button>
        <span style="font-size:12.5px;color:var(--color-text-muted)">${selectedNeg.length} palabra${selectedNeg.length === 1 ? '' : 's'}${exactasCount ? ` + ${exactasCount} exacta${exactasCount === 1 ? '' : 's'}` : ''}${selectedReview.length ? ` + ${selectedReview.length} término${selectedReview.length === 1 ? '' : 's'} suelto${selectedReview.length === 1 ? '' : 's'}` : ''}${canPush ? ` · ${items.length} negativa${items.length === 1 ? '' : 's'} en ${campaigns} campaña${campaigns === 1 ? '' : 's'}` : ''}</span>
      </div>
      ${selectedNeg.length ? `<div class="ok-panel" style="margin-bottom:12px"><strong>Gasto de los términos que bloquearían: ${fmtMoney(savings)}</strong> (gasto ya hecho en el periodo; el ahorro real depende de que esas búsquedas se repitan).</div>` : ''}
      ${kwConflicts ? `<div class="error-panel" style="margin-bottom:12px"><strong>Cuidado:</strong> ${kwConflicts === 1 ? 'una de las negativas marcadas bloquearía' : `${kwConflicts} de las negativas marcadas bloquearían`} una palabra clave tuya que está activa. Esas palabras dejarían de servirse; revisa el detalle en rojo antes de subir.</div>` : ''}
      ${reviewBrand ? `<div class="error-panel" style="margin-bottom:12px"><strong>Ojo:</strong> ${reviewBrand === 1 ? 'marcaste un término que lleva' : `marcaste ${reviewBrand} términos que llevan`} el nombre del hotel o la marca: al negativizarlos dejarías de aparecer en esas búsquedas propias.</div>` : ''}
      ${highRisk.length ? `<div class="error-panel" style="margin-bottom:12px"><strong>Ojo:</strong> ${highRisk.length === 1 ? 'una palabra marcada choca' : `${highRisk.length} palabras marcadas chocan`} con términos que convierten o llevan la marca${convAtRisk > 0 ? ` (${fmtInt(convAtRisk)} conversión${convAtRisk === 1 ? '' : 'es'} en juego)` : ''}. Revisa el detalle de cada una o usa la alternativa segura.</div>` : ''}
      ${canPush && (p.status === 'idle' || p.status === 'error') ? `
        <button class="btn-accent" data-action="neg-ai-push-preview" ${items.length === 0 || busy ? 'disabled' : ''}>Vista previa</button>
        ${p.error ? `<div class="error-panel" style="margin-top:10px">${escapeHtml(p.error)}</div>` : ''}` : ''}
      ${busy ? `<p class="footnote">${p.status === 'previewing' ? 'Validando con Google Ads (vista previa, no aplica nada todavía)…' : 'Subiendo negativas a Google Ads…'}</p>` : ''}
      ${p.status === 'preview_ready' && p.preview ? `
        <div class="ok-panel" style="margin:10px 0">
          <strong>Vista previa lista.</strong> Google Ads validó ${p.preview.created} de ${p.preview.items.length} sin problema — nada se aplicó todavía.
          ${p.preview.failed && p.preview.failed.length ? `<div style="margin-top:6px"><strong>${p.preview.failed.length} no pasaron la validación:</strong><br>${p.preview.failed.map((m) => escapeHtml(m)).join('<br>')}</div>` : ''}
        </div>
        <button class="btn-accent" data-action="neg-ai-push-confirm">Confirmar y subir a Google Ads</button>
        <button class="btn-outline" data-action="neg-ai-push-cancel">Cancelar</button>` : ''}
      ${p.status === 'done' && p.result ? `
        <div class="ok-panel" style="margin:10px 0"><strong>Listo.</strong> Se ${p.result.created === 1 ? 'subió' : 'subieron'} ${p.result.created} negativa${p.result.created === 1 ? '' : 's'} a Google Ads.
          ${p.result.failed && p.result.failed.length ? `<div style="margin-top:6px"><strong>${p.result.failed.length} fallaron:</strong><br>${p.result.failed.map((m) => escapeHtml(m)).join('<br>')}</div>` : ''}
        </div>` : ''}
    </div>`;
}

// Grupos de términos con casilla, de dos orígenes: "r" = lo que la IA puso a revisar (agrupado por su pregunta)
// y "k" = lo que la IA dejaría (agrupado por motivo). Ordenados del grupo con más gasto al de menos.
// `seguros` = los que la casilla del grupo puede marcar: no convierten y todavía no existen como negativa
// exacta (o no hay campañas, en modo archivo). En "revisar" tampoco se marcan en bloque los que llevan la
// marca; en "dejar" sí, porque casi todo lo de ahí es de marca y la persona ya decidió mirarlo.
function negAiTermGroups(kind, result, canPush) {
  let raw;
  if (kind === 'r') {
    const byQuestion = new Map();
    ((result && result.revisar) || []).forEach((t) => {
      if (!byQuestion.has(t.pregunta)) byQuestion.set(t.pregunta, []);
      byQuestion.get(t.pregunta).push(t);
    });
    raw = [...byQuestion.entries()].map(([title, terms]) => ({ title, subtitle: '', terms }));
  } else {
    raw = ((result && result.mantener) || []).map((g) => ({ title: g.grupo, subtitle: g.razon, terms: g.terminos }));
  }
  return raw.map((g) => ({
    ...g,
    cost: g.terms.reduce((sum, t) => sum + t.cost, 0),
    conversions: g.terms.reduce((sum, t) => sum + t.conversions, 0),
    seguros: g.terms.filter((t) => t.conversions === 0 && !t.kw_conflicto && (kind === 'k' || !t.es_marca) && (t.campanias.length || !canPush)),
  })).sort((x, y) => y.cost - x.cost);
}

function renderNegAiTermGroup(g, idx, kind, canPush) {
  const ai = state.neg.ai;
  const marked = g.seguros.filter((t) => ai.selected.has(`${kind}:${t.key}`)).length;
  const state3 = g.seguros.length === 0 ? 'none' : marked === g.seguros.length ? 'all' : marked > 0 ? 'some' : 'off';
  const excluded = g.terms.length - g.seguros.length;
  const brandCount = g.terms.filter((t) => t.es_marca).length;
  const why = kind === 'r' ? 'convierten, llevan la marca, son una palabra clave tuya o ya existen' : 'convierten, son una palabra clave tuya o ya existen';
  return `
    <div style="border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:12px 14px;margin-bottom:12px">
      <label style="display:flex;gap:10px;align-items:flex-start;font-size:13.5px;${g.seguros.length ? 'cursor:pointer' : ''}">
        <input type="checkbox" data-neg-ai-group="${kind}:${idx}" data-state="${state3}" ${state3 === 'all' ? 'checked' : ''} ${g.seguros.length ? '' : 'disabled'} style="margin-top:3px" />
        <span>
          <strong>${escapeHtml(g.title)}</strong>
          ${g.subtitle ? `<span style="display:block;margin:2px 0 0;font-size:13px">${escapeHtml(g.subtitle)}</span>` : ''}
          <span class="footnote" style="display:block;margin:2px 0 0">${fmtInt(g.terms.length)} término${g.terms.length === 1 ? '' : 's'} · ${fmtMoney(g.cost)} · ${fmtInt(g.conversions)} conv.${g.seguros.length ? ` · la casilla marca ${fmtInt(g.seguros.length)}${excluded ? ` (los otros ${fmtInt(excluded)} ${why}: márcalos a mano si quieres)` : ''}` : ` · ninguno se puede marcar en bloque (${why})`}${kind === 'k' && brandCount ? ` · ${fmtInt(brandCount)} llevan la marca: negativizarlos te sacaría de esas búsquedas propias` : ''}</span>
        </span>
      </label>
      <div class="table-scroll" style="max-height:260px;margin-top:8px"><table>
        <thead><tr><th></th><th>Término</th><th>Clics</th><th>Costo</th><th>Conv.</th></tr></thead>
        <tbody>${g.terms.map((t) => `<tr>
          <td><input type="checkbox" data-neg-ai-sel="${kind}:${escapeHtml(t.key)}" ${ai.selected.has(`${kind}:${t.key}`) ? 'checked' : ''} ${t.campanias.length || !canPush ? '' : 'disabled title="Ya existe como negativa exacta en sus campañas"'} /></td>
          <td>${escapeHtml(t.term)}${t.pmax ? ' <span class="delta-badge neutral">PMax</span>' : ''}${t.es_marca ? ' <span class="delta-badge warn">lleva la marca</span>' : ''}${t.kw_conflicto ? ' <span class="delta-badge bad" title="Existe una palabra clave activa con exactamente estas palabras en una de sus campañas">es tu palabra clave</span>' : ''}${t.conversions > 0 ? ' <span class="delta-badge bad">convierte</span>' : ''}</td>
          <td>${fmtInt(t.clicks)}</td><td>${fmtMoney(t.cost)}</td><td>${fmtInt(t.conversions)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

function renderNegAiResult() {
  const ai = state.neg.ai;
  const r = ai.result;
  const rs = r.resumen;
  const canPush = !!ai.customerId;
  const avisos = (r.avisos || []).length ? `
    <div class="card" style="margin-bottom:16px;padding:14px 18px">
      <strong style="font-size:13px">Lo que el código corrigió o descartó de la propuesta de la IA</strong>
      <ul style="margin:8px 0 0 18px;font-size:12.5px">${r.avisos.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
    </div>` : '';
  const keepGroups = negAiTermGroups('k', r, canPush);
  const keep = keepGroups.length ? `
    <div class="card table-panel" style="margin-bottom:16px">
      <p style="margin:0 0 10px;font-size:12.5px;color:var(--color-text-muted)">Esto es lo que la IA dejaría. Si algún término te parece demasiado genérico o no te sirve, márcalo (o marca el grupo) para negativizarlo: se sube como negativa <strong>exacta</strong>, con el resto de lo marcado.</p>
      ${keepGroups.map((g, idx) => renderNegAiTermGroup(g, idx, 'k', canPush)).join('')}
    </div>` : '';
  const review = (r.revisar || []).length ? `
    <div class="card table-panel" style="margin-bottom:16px">
      <div class="table-panel-head">
        <h3>Revisar antes de decidir (${r.revisar.length})</h3>
        <span style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn-outline sm" data-action="neg-ai-review-select-nonconv">Marcar los que no convierten</button>
          <button class="btn-outline sm" data-action="neg-ai-review-select-none">Quitar marcas</button>
        </span>
      </div>
      <p style="margin:0 0 10px;font-size:12.5px;color:var(--color-text-muted)">Están agrupados por la duda que tuvo la IA. La casilla de cada grupo marca de una vez los términos seguros del grupo; también puedes marcar uno por uno. Se suben como negativas <strong>exactas</strong> en las campañas donde aparecieron, junto con el resto de lo marcado más arriba.</p>
      ${negAiTermGroups('r', r, canPush).map((g, idx) => renderNegAiTermGroup(g, idx, 'r', canPush)).join('')}
    </div>` : '';

  return `
    <div class="stat-grid">
      <div class="card stat-card danger">
        <div class="stat-label">Negativizar</div>
        <div class="stat-value lg">${fmtInt(rs.negativizar.terminos)}</div>
        <div class="stat-sub">${fmtMoney(rs.negativizar.costo)} · ${fmtInt(rs.negativizar.clics)} clics</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Dejar</div>
        <div class="stat-value lg">${fmtInt(rs.mantener.terminos)}</div>
        <div class="stat-sub">${fmtMoney(rs.mantener.costo)} · ${fmtInt(rs.mantener.conversiones)} conversiones</div>
      </div>
      <div class="card stat-card accent">
        <div class="stat-label">Revisar</div>
        <div class="stat-value lg">${fmtInt(rs.revisar.terminos)}</div>
        <div class="stat-sub">${fmtMoney(rs.revisar.costo)} · ${fmtInt(rs.revisar.clics)} clics</div>
      </div>
    </div>
    <p class="footnote" style="margin:-4px 0 16px">La IA revisó ${fmtInt(rs.analizados)} de ${fmtInt(rs.terminos_total)} términos (los de más gasto y todos los que convierten).${rs.no_analizados ? ` Los otros ${fmtInt(rs.no_analizados)} (${fmtMoney(rs.costo_no_analizado)}) son cola larga: no se clasificaron, pero cada palabra negativa se midió contra ellos y se avisa si los bloquea.` : ''}${r.negativas_fuentes && r.negativas_existentes ? ` Se tuvieron en cuenta las negativas que la cuenta ya tiene: ${fmtInt(r.negativas_fuentes.campania)} de campaña${r.negativas_fuentes.listas ? ` y ${fmtInt(r.negativas_fuentes.palabras_listas)} palabras de ${fmtInt(r.negativas_fuentes.listas)} lista${r.negativas_fuentes.listas === 1 ? '' : 's'} compartida${r.negativas_fuentes.listas === 1 ? '' : 's'}${r.negativas_fuentes.listas_cuenta ? ` (${fmtInt(r.negativas_fuentes.listas_cuenta)} de la cuenta)` : ''}` : ''}.${r.negativas_fuentes.errores ? ' No se pudo leer alguna fuente de negativas; revisa la subida con la vista previa.' : ''}` : ''}${r.palabras_clave_activas != null ? ` Cada negativa se comprobó contra tus ${fmtInt(r.palabras_clave_activas)} palabras clave activas.` : ' No se pudo comprobar contra tus palabras clave activas (con un archivo no hay cuenta); revisa la subida con la vista previa.'}${r.ya_bloqueados && r.ya_bloqueados.terminos ? ` Se dejaron fuera ${fmtInt(r.ya_bloqueados.terminos)} término${r.ya_bloqueados.terminos === 1 ? '' : 's'} (${fmtMoney(r.ya_bloqueados.costo)}) que ya bloquea una negativa existente de su campaña.` : ''}</p>
    ${avisos}
    <h3 style="margin:18px 0 10px">Qué negativizar, por tema</h3>
    ${(r.temas || []).length ? r.temas.map((t) => renderNegAiTema(t, canPush)).join('') : '<div class="card state-panel idle"><p>La IA no encontró términos para negativizar en este periodo.</p></div>'}
    ${(r.temas || []).length || (r.revisar || []).length ? renderNegAiPushPanel() : ''}
    <h3 style="margin:18px 0 10px">Qué dejar</h3>
    ${keep || '<p class="footnote">La IA no marcó términos para dejar.</p>'}
    ${review}
    <p class="footnote">La IA propone y el código verifica, pero la decisión es tuya: nunca subas negativas sin revisar las de riesgo medio o alto. Las negativas no cubren variantes cercanas (plurales, errores de escritura), por eso a veces hay dos formas de la misma palabra.</p>`;
}

function renderNegAiWordsView() {
  const ai = state.neg.ai;
  const w = ai.words;
  if (w.status === 'loading') return '<div class="card state-panel loading"><div class="spinner"></div><p>Buscando las palabras que más gastan sin convertir…</p></div>';
  if (w.status === 'error') return `<div class="error-panel"><strong>No se pudo calcular.</strong> ${escapeHtml(w.error)}</div>`;
  if (w.status !== 'ready' || !w.result) {
    return `<div class="card state-panel idle">${icon('list-filter', 30)}<p>Busca, sin IA y sin costo, las palabras que se repiten en varios términos, gastan y nunca han convertido. Sirve para ver patrones en toda la cola larga, no solo en lo que analiza la IA.</p></div>`;
  }
  const r = w.result;
  const canPush = !!ai.customerId;
  const extra = [
    r.palabras_clave_activas != null ? `Cada una se comprobó contra tus ${fmtInt(r.palabras_clave_activas)} palabras clave activas.` : 'No se pudo comprobar contra tus palabras clave activas (con un archivo no hay cuenta).',
    r.ya_bloqueados && r.ya_bloqueados.terminos ? `Se dejaron fuera ${fmtInt(r.ya_bloqueados.terminos)} término${r.ya_bloqueados.terminos === 1 ? '' : 's'} que ya bloquea una negativa existente.` : '',
  ].filter(Boolean).join(' ');
  return `
    <p class="footnote" style="margin:0 0 14px">${fmtInt(r.resumen.candidatas)} palabra${r.resumen.candidatas === 1 ? '' : 's'} o frase${r.resumen.candidatas === 1 ? '' : 's'} candidata${r.resumen.candidatas === 1 ? '' : 's'}, sobre ${fmtInt(r.resumen.terminos_total)} términos. Se descartan las genéricas de hotel, la marca y el destino, y lo que aparece en un solo término. ${escapeHtml(extra)} Mira los ejemplos antes de marcar: una palabra puede cortar también búsquedas buenas que aún no han convertido.</p>
    ${r.temas.length ? r.temas.map((t) => renderNegAiTema(t, canPush)).join('') + renderNegAiPushPanel() : '<div class="card state-panel idle"><p>No hay palabras repetidas que gasten sin convertir en este periodo.</p></div>'}`;
}

function renderNegAiTab() {
  const s = state.neg;
  const ai = s.ai;
  const ctxField = (id, label, placeholder, hint, rows) => `
    <div class="field" style="flex:1;min-width:240px">
      <label>${label}</label>
      <textarea id="${id}" rows="${rows}" style="width:100%;resize:vertical" placeholder="${placeholder}">${escapeHtml(ai.ctx[id.replace('neg-ai-', '')])}</textarea>
      ${hint ? `<p class="field-hint">${hint}</p>` : ''}
    </div>`;

  const sourcePanel = `
    <div class="card control-panel align-end" style="margin-top:-8px">
      <div class="seg-control">
        <button class="seg-btn ${s.source === 'file' ? 'active' : ''}" data-action="neg-source-file">Subir archivo</button>
        <button class="seg-btn ${s.source === 'api' ? 'active' : ''}" data-action="neg-source-api">Conectar Google Ads</button>
      </div>
      ${s.source === 'file' ? `
        <div class="field">
          <label>Export de "Términos de búsqueda" (CSV)</label>
          <input type="file" id="neg-ai-file" accept=".csv" />
        </div>` : `
        <div class="field">
          <label style="display:flex;align-items:center;gap:8px;font-weight:400">
            <input type="checkbox" id="neg-ai-include-pmax" ${ai.includePmax ? 'checked' : ''} />
            Incluir campañas de Performance Max (términos reales con costo)
          </label>
        </div>
        ${renderNegApiPanel('neg-ai-fetch', 'Traer términos de Google Ads')}`}
    </div>`;

  let termsBox = '';
  if (ai.rowsStatus === 'loading') termsBox = '<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo los términos de búsqueda…</p></div>';
  else if (ai.rowsError) termsBox = `<div class="error-panel">${escapeHtml(ai.rowsError)}</div>`;
  else if (ai.rows) {
    const real = ai.rows.filter((r) => !r.is_category);
    const cost = real.reduce((sum, r) => sum + (r.cost || 0), 0);
    const uniq = new Set(real.map((r) => r.term.toLowerCase())).size;
    const pmaxCount = new Set(real.filter((r) => r.pmax).map((r) => r.term.toLowerCase())).size;
    termsBox = `
      <div class="card" style="padding:16px 20px;margin-bottom:16px">
        <strong>${fmtInt(uniq)} términos de búsqueda cargados</strong>${pmaxCount ? ` (${fmtInt(pmaxCount)} de Performance Max)` : ''} · ${fmtMoney(cost)} de gasto · ${escapeHtml(ai.rowsLabel)}
        ${ai.pmaxFallback ? '<div class="footnote">No se pudieron traer los términos de Performance Max; se usaron las categorías de siempre.</div>' : ''}
        ${ai.rows.length !== real.length ? `<div class="footnote">${ai.rows.length - real.length} categorías de Performance Max se dejan fuera: no traen el texto exacto de la búsqueda.</div>` : ''}
        <div style="margin-top:12px">${ai.view === 'palabras'
          ? `<button class="btn-accent" data-action="neg-ai-words-run" ${ai.words.status === 'loading' ? 'disabled' : ''}>${ai.words.result ? 'Volver a calcular' : 'Buscar palabras frecuentes'}</button><span class="footnote" style="margin-left:10px">No usa IA ni tiene costo.</span>`
          : `<button class="btn-accent" data-action="neg-ai-run" ${ai.status === 'loading' ? 'disabled' : ''}>${ai.result ? 'Volver a analizar con IA' : 'Analizar con IA'}</button><span class="footnote" style="margin-left:10px">Usa Claude; hay un tope de análisis por hora.</span>`}</div>
      </div>`;
  }

  let body = '';
  if (ai.status === 'loading') body = '<div class="card state-panel loading"><div class="spinner"></div><p>La IA está revisando los términos… puede tardar hasta un par de minutos.</p></div>';
  else if (ai.status === 'error') body = `<div class="error-panel"><strong>No se pudo analizar.</strong> ${escapeHtml(ai.error)}</div>`;
  else if (ai.status === 'ready' && ai.result) body = renderNegAiResult();
  else if (!ai.rows && ai.rowsStatus === 'idle') body = `<div class="card state-panel idle">${icon('sparkles', 30)}<p>Cuéntale a la IA qué es el hotel, trae los términos de búsqueda y te dirá cuáles negativizar (agrupados por tema), cuáles dejar y cuáles revisar.</p></div>`;

  return `
    <div class="card control-panel">
      ${ctxField('neg-ai-marca', 'Hotel o marca (lo que NUNCA se debe negativizar)', 'ej. estelar&#10;hotel estelar cartagena', 'Una por línea. Ningún término que lleve estas palabras se recomendará negativizar, y ninguna negativa puede ser igual a ellas.', 3)}
      ${ctxField('neg-ai-destino', 'Destino o ciudad', 'ej. cartagena&#10;manzanillo', 'Una por línea. Sirve para detectar búsquedas de otras ciudades.', 3)}
      ${ctxField('neg-ai-ofrece', 'Qué ofrece (opcional)', 'ej. hotel frente al mar, todo incluido, para familias', '', 3)}
      ${ctxField('neg-ai-no_ofrece', 'Qué NO ofrece o no quieres atraer (opcional)', 'ej. hostales, apartamentos por días, eventos corporativos', '', 3)}
    </div>
    ${sourcePanel}
    ${termsBox}
    ${ai.rows ? `<div class="seg-control" style="margin:0 0 16px"><button class="seg-btn ${ai.view !== 'palabras' ? 'active' : ''}" data-action="neg-ai-view-ia">Análisis con IA</button><button class="seg-btn ${ai.view === 'palabras' ? 'active' : ''}" data-action="neg-ai-view-palabras">Palabras frecuentes (sin IA)</button></div>` : ''}
    ${ai.view === 'palabras' && ai.rows ? renderNegAiWordsView() : body}
    ${renderNegAiHistory()}`;
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

    ${renderCopyAiPanel()}

    <h3 class="section-title" style="margin:24px 0 8px">Versión con plantillas (sin IA)</h3>
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

const COPY_AI_FORMATS = [
  { key: 'search', label: 'Search', action: 'copy-ai-search' },
  { key: 'pmax', label: 'Performance Max', action: 'copy-ai-pmax' },
  { key: 'dgen', label: 'Demand Gen', action: 'copy-ai-dgen' },
  { key: 'youtube', label: 'YouTube', action: 'copy-ai-youtube' },
  { key: 'meta', label: 'Meta', action: 'copy-ai-meta' },
];

function renderCopyAiPanel() {
  const ai = state.copy.ai;
  const loading = ai.status === 'loading';
  const buttons = COPY_AI_FORMATS.map((f) => `
    <button class="${ai.format === f.key && ai.status !== 'idle' ? 'btn-accent' : 'btn-outline'}" data-action="${f.action}" ${loading ? 'disabled' : ''}>${icon('sparkles', 16)} ${f.label}</button>`).join('');

  let body = '';
  if (loading) {
    body = `<div class="state-panel loading" style="margin-top:14px"><div class="spinner"></div><p>Escribiendo los copys para ${escapeHtml((COPY_AI_FORMATS.find((f) => f.key === ai.format) || {}).label || '')}… puede tardar hasta un minuto.</p></div>`;
  } else if (ai.status === 'error') {
    body = `<div class="error-panel" style="margin-top:14px"><strong>No se pudo generar.</strong> ${escapeHtml(ai.error)}</div>`;
  } else if (ai.status === 'ready' && ai.result) {
    const r = ai.result;
    const groups = r.groups.map((g, gi) => {
      const rows = g.items.map((it, ii) => `
        <tr><td>${escapeHtml(it.text)}</td>
        <td style="text-align:right;color:var(--color-text-muted);white-space:nowrap">${it.chars}/${g.limit}</td>
        <td style="text-align:right"><button class="btn-link" data-copy-ai-copy="${gi}:${ii}">Copiar</button></td></tr>`).join('');
      const warn = g.short ? `<p class="footnote" style="color:var(--color-warn,#8a5d00)">Solo salieron ${g.items.length} de ${g.count} textos válidos. Vuelve a generar para completar.</p>` : '';
      return `
        <div class="card table-panel">
          <div class="table-panel-head">
            <h3>${escapeHtml(g.label)} (máx. ${g.limit} caracteres)</h3>
            <span><button class="btn-outline xs" data-copy-ai-copy="${gi}:all">Copiar todo</button>
            <button class="btn-outline xs" data-copy-ai-csv="${gi}">Descargar CSV</button></span>
          </div>
          <table><thead><tr><th>Texto</th><th style="text-align:right">Caract.</th><th></th></tr></thead><tbody>${rows}</tbody></table>
          ${warn}
        </div>`;
    }).join('');
    body = `
      <h3 class="section-title" style="margin:18px 0 6px">${escapeHtml(r.label)}</h3>
      ${r.note ? `<p class="footnote">${escapeHtml(r.note)}</p>` : ''}
      <div class="two-col">${groups}</div>
      <p class="footnote">Borrador generado con IA solo con lo que dice la página. Revísalo antes de publicarlo: no se valida contra las políticas de Google Ads ni contra las condiciones del hotel (tarifas, promociones vigentes).</p>`;
  }

  return `
    <div class="card ai-analysis-card" style="margin-top:16px">
      <div class="rec-head" style="margin-bottom:8px"><span class="rec-cat">Copys con IA · borrador a revisar</span></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
        <div class="field"><label>Idioma</label>
          <select id="copy-ai-lang">
            <option value="es" ${ai.lang === 'es' ? 'selected' : ''}>Español</option>
            <option value="en" ${ai.lang === 'en' ? 'selected' : ''}>Inglés</option>
            <option value="pt" ${ai.lang === 'pt' ? 'selected' : ''}>Portugués</option>
          </select></div>
        <div class="field" style="flex:1;min-width:260px"><label>Palabras clave (opcional)</label>
          <input type="text" id="copy-ai-keywords" placeholder="ej. hotel en Cartagena, todo incluido" value="${escapeHtml(ai.keywords)}" style="width:100%" /></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${buttons}</div>
      <p class="field-hint">Elige el tipo de campaña: cada uno usa sus propios formatos y límites de caracteres. Hasta 10 generaciones por hora por persona.</p>
      ${body}
    </div>`;
}

function generateCopyAi(format) {
  const s = state.copy;
  const ai = s.ai;
  if (!s.signals || ai.status === 'loading') return;
  ai.status = 'loading'; ai.format = format; ai.error = null; ai.result = null;
  render();
  const sig = Object.assign({}, s.signals, { offers: s.signals.offers_detected || [] });
  fetch('/api/ai/generar-copys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formato: format, signals: sig, idioma: ai.lang, keywords: ai.keywords }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      ai.status = 'ready'; ai.result = data; render();
    })
    .catch((err) => { ai.status = 'error'; ai.error = err.message || String(err); render(); });
}

function copyAiCopy(ref) {
  const ai = state.copy.ai;
  if (!ai.result) return;
  const [gi, which] = ref.split(':');
  const g = ai.result.groups[Number(gi)];
  if (!g) return;
  const text = which === 'all' ? g.items.map((it) => it.text).join('\n') : (g.items[Number(which)] || {}).text;
  if (!text) return;
  const done = () => { /* sin aviso: el botón es de uso rápido */ };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
}

function copyAiCsv(gi) {
  const ai = state.copy.ai;
  const g = ai.result && ai.result.groups[Number(gi)];
  if (!g) return;
  const data = [['Texto', 'Caracteres'], ...g.items.map((it) => [it.text, it.chars])];
  engine.downloadCsv(`copys_${ai.result.formato}_${g.key}.csv`, data);
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

  const modeToggle = `
    <div class="seg-control" style="margin-bottom:16px">
      <button class="seg-btn ${s.mode === 'single' ? 'active' : ''}" data-action="book-mode-single">Análisis único</button>
      <button class="seg-btn ${s.mode === 'compare' ? 'active' : ''}" data-action="book-mode-compare">Comparar periodos</button>
    </div>`;

  if (s.mode === 'compare') return modeToggle + renderBookComparePage();

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
    ${modeToggle}
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

// ---------------------------------------------------------------------------
// Bookings — Comparar periodos (mismo criterio que Función 5, campañas)
// ---------------------------------------------------------------------------

function runBookCompareAnalysisFromText(which, text, fileName) {
  const slot = state.book.compare[which];
  try {
    const result = engine.loadBookings(text);
    Object.assign(slot, { status: 'ready', error: null, rows: result.rows, fileName });
    state.book.compare.marketFilter = 'all'; state.book.compare.hotelFilter = 'all';
  } catch (err) {
    Object.assign(slot, { status: 'error', error: err.message || String(err), fileName, rows: null });
  }
  render();
}

function runBookCompareAnalysisFromRows(which, rows2D, fileName) {
  const slot = state.book.compare[which];
  try {
    const result = engine.loadBookingsFromRows(rows2D);
    Object.assign(slot, { status: 'ready', error: null, rows: result.rows, fileName });
    state.book.compare.marketFilter = 'all'; state.book.compare.hotelFilter = 'all';
  } catch (err) {
    Object.assign(slot, { status: 'error', error: err.message || String(err), fileName, rows: null });
  }
  render();
}

function renderBookComparePage() {
  const s = state.book.compare;
  const bothReady = s.current.status === 'ready' && s.previous.status === 'ready';

  const uploadPanel = `
    <div class="card control-panel align-end">
      <div class="field">
        <label>Periodo actual (CSV o Excel)</label>
        <input type="file" id="book-compare-current-file" accept=".csv,.xlsx,.xls" />
        ${s.current.fileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.current.fileName)}</strong></div>` : ''}
      </div>
      <div class="field">
        <label>Periodo anterior (CSV o Excel)</label>
        <input type="file" id="book-compare-previous-file" accept=".csv,.xlsx,.xls" />
        ${s.previous.fileName ? `<div class="filename-hint">Archivo: <strong>${escapeHtml(s.previous.fileName)}</strong></div>` : ''}
      </div>
      <button class="btn-outline" data-action="book-compare-demo">Usar ejemplo (dos periodos)</button>
    </div>`;

  let errorHtml = '';
  if (s.current.status === 'error') errorHtml += `<div class="error-panel"><strong>Periodo actual:</strong> ${escapeHtml(s.current.error)}</div>`;
  if (s.previous.status === 'error') errorHtml += `<div class="error-panel"><strong>Periodo anterior:</strong> ${escapeHtml(s.previous.error)}</div>`;

  if (!bothReady) {
    return `
      ${uploadPanel}
      ${errorHtml}
      <div class="card state-panel idle">
        ${icon('git-compare', 30)}
        <p>Sube el export de reservas del periodo actual y del periodo anterior (o usa el ejemplo) para ver la comparativa.</p>
      </div>`;
  }

  const allMarkets = [...new Set([...engine.listBookingMarkets(s.current.rows), ...engine.listBookingMarkets(s.previous.rows)])].sort((a, b) => a.localeCompare(b, 'es'));
  const allHotels = [...new Set([...engine.listBookingHotels(s.current.rows), ...engine.listBookingHotels(s.previous.rows)])].sort((a, b) => a.localeCompare(b, 'es'));

  const filterPanel = `
    <div class="card" style="padding:16px 20px;margin-bottom:20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <label style="font-size:12px;font-weight:600;color:var(--color-text-heading)">Filtrar por mercado</label>
      <select id="book-compare-market-filter">
        <option value="all" ${s.marketFilter === 'all' ? 'selected' : ''}>Todos los mercados</option>
        ${allMarkets.map((m) => `<option value="${escapeHtml(m)}" ${s.marketFilter === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
      </select>
      ${allHotels.length > 1 ? `
        <label style="font-size:12px;font-weight:600;color:var(--color-text-heading)">Filtrar por hotel</label>
        <select id="book-compare-hotel-filter">
          <option value="all" ${s.hotelFilter === 'all' ? 'selected' : ''}>Todos los hoteles</option>
          ${allHotels.map((h) => `<option value="${escapeHtml(h)}" ${s.hotelFilter === h ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}
        </select>` : ''}
    </div>`;

  const currentRows = s.current.rows
    .filter((r) => s.marketFilter === 'all' || r.pais === s.marketFilter)
    .filter((r) => s.hotelFilter === 'all' || r.hotel === s.hotelFilter);
  const previousRows = s.previous.rows
    .filter((r) => s.marketFilter === 'all' || r.pais === s.marketFilter)
    .filter((r) => s.hotelFilter === 'all' || r.hotel === s.hotelFilter);

  const cmp = engine.compareBookingPeriods(currentRows, previousRows);

  const statGrid = `
    <div class="stat-grid">
      <div class="card stat-card">
        <div class="stat-label">Reservas totales</div>
        <div class="stat-value">${fmtInt(cmp.total_reservas_current)}</div>
        <div class="stat-sub">${deltaBadge(cmp.delta_reservas, 'good_up')} vs. ${fmtInt(cmp.total_reservas_previous)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Noches de habitación</div>
        <div class="stat-value">${fmtInt(cmp.total_noches_current)}</div>
        <div class="stat-sub">${deltaBadge(cmp.delta_noches, 'good_up')} vs. ${fmtInt(cmp.total_noches_previous)}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Promedio noches/reserva</div>
        <div class="stat-value">${cmp.avg_noches_current != null ? cmp.avg_noches_current.toFixed(1) : 'N/D'}</div>
        <div class="stat-sub">vs. ${cmp.avg_noches_previous != null ? cmp.avg_noches_previous.toFixed(1) : 'N/D'}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Antelación promedio</div>
        <div class="stat-value">${cmp.lead_avg_current != null ? fmtInt(cmp.lead_avg_current) + ' días' : 'N/D'}</div>
        <div class="stat-sub">${deltaBadge(cmp.delta_lead, 'neutral')} vs. ${cmp.lead_avg_previous != null ? fmtInt(cmp.lead_avg_previous) + ' días' : 'N/D'}</div>
      </div>
    </div>`;

  const tableRows = cmp.markets.map((m) => `
    <tr>
      <td>${escapeHtml(m.mercado)}</td>
      <td>${fmtInt(m.current_reservas)} ${deltaBadge(m.delta_reservas, 'good_up')}</td>
      <td>${fmtInt(m.current_noches)} ${deltaBadge(m.delta_noches, 'good_up')}</td>
      <td>${fmtInt(m.previous_reservas)}</td>
      <td>${fmtInt(m.previous_noches)}</td>
    </tr>`).join('');

  const leadTableRows = cmp.lead_buckets.map((b) => `
    <tr>
      <td>${escapeHtml(b.label)}</td>
      <td>${fmtInt(b.current_reservas)} ${deltaBadge(b.delta, 'neutral')}</td>
      <td>${fmtInt(b.previous_reservas)}</td>
    </tr>`).join('');

  return `
    ${uploadPanel}
    ${filterPanel}
    ${statGrid}
    <div class="card chart-card">
      <h3 class="dense-chart-title">Reservas por mercado — periodo actual vs. anterior</h3>
      <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Mercado</th><th>Reservas (actual)</th><th>Noches (actual)</th><th>Reservas (anterior)</th><th>Noches (anterior)</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>
    <div class="card chart-card">
      <h3 class="dense-chart-title">Días de antelación (reserva → estadía) — actual vs. anterior</h3>
      <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Antelación</th><th>Reservas (actual)</th><th>Reservas (anterior)</th></tr></thead>
          <tbody>${leadTableRows}</tbody>
        </table>
      </div>
    </div>
    <div class="card chart-card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px">
        <h3 class="dense-chart-title" style="margin:0">Reservas, noches y prom. de noches por mercado — periodo actual vs. anterior</h3>
        <button class="btn-outline sm" data-action="book-compare-download-markets-html" title="Descarga esta gráfica como una página HTML que cabe completa en una sola pantalla">Descargar (HTML)</button>
      </div>
      ${renderBookingsHeatmapCompare(currentRows, previousRows, bookingPeriodShiftMonths(s.current.rows, s.previous.rows))}
    </div>
    <div class="card chart-card">
      <h3 class="dense-chart-title">Llegadas por día de semana — periodo actual vs. anterior</h3>
      ${renderArrivalsByWeekdayCompare(currentRows, previousRows)}
    </div>
    <p class="footnote">
      Las reservas se agrupan por mercado (país). Los badges ▲/▼ comparan el periodo actual contra el anterior — más es mejor en reservas, noches y conversiones; en antelación solo se informa la tendencia, sin juicio de bueno/malo.
    </p>
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
    color: 'var(--accent-600)',
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
  const light = themed([244, 245, 248], [248, 248, 248]); // --gray-50
  const dark = themed([20, 33, 61], [16, 34, 47]); // --navy-800 / tinta
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

// Flecha de cambio para el mapa de calor comparado: verde si sube, roja si baja (más es mejor).
// `label` es el texto que acompaña la flecha (diferencia absoluta o porcentaje ya formateado).
function heatDeltaBadge(diff, label) {
  if (!diff) return '<span class="delta-badge neutral">—</span>';
  return `<span class="delta-badge ${diff > 0 ? 'good' : 'bad'}">${diff > 0 ? '▲' : '▼'} ${label}</span>`;
}

// Mapa de calor de mercados por mes de llegada con los dos periodos en la misma tabla: cada celda
// muestra las reservas del periodo actual con el % de cambio frente al mismo mes del anterior (verde
// si sube, rojo si baja); el valor anterior queda en el tooltip. Solo se comparan los meses que tienen
// llegadas en los dos periodos: un mes que solo está en el actual se muestra sin %, y los meses que solo
// están en el anterior se ocultan (siguen sumados en las columnas de Total). Si los dos archivos son de
// épocas distintas (por ejemplo, reservas hechas en oct-2026 y en oct-2025), `shiftMonths` desplaza los meses
// del anterior para que cada mes se compare con el que le corresponde (oct-2026 contra oct-2025).
const BOOK_OTHER_MARKETS = 'Otros mercados';

function bookingPeriodShiftMonths(currentAll, previousAll) {
  const firstAlta = (rows) => rows.reduce((min, r) => {
    if (!r.altaDate) return min;
    const idx = r.altaDate.getFullYear() * 12 + r.altaDate.getMonth();
    return min === null || idx < min ? idx : min;
  }, null);
  const c = firstAlta(currentAll);
  const p = firstAlta(previousAll);
  return c === null || p === null ? 0 : c - p;
}

function addMonthsToKey(key, n) {
  const [y, m] = key.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

function bookingShiftLabel(n) {
  if (!n) return '';
  const abs = Math.abs(n);
  if (abs % 12 === 0) return abs === 12 ? 'un año' : `${abs / 12} años`;
  return abs === 1 ? '1 mes' : `${abs} meses`;
}

function renderBookingsHeatmapCompare(currentRows, previousRows, shiftMonths = 0) {
  const cur = engine.summarizeByMarketAndMonth(currentRows);
  const prev = engine.summarizeByMarketAndMonth(previousRows);
  if (!cur.months.length) {
    return `<p style="font-size:12.5px;color:var(--color-text-muted)">No hay reservas del periodo actual con fecha de entrada válida para graficar.</p>`;
  }
  const months = cur.months;
  const prevKeys = prev.months.map((m) => addMonthsToKey(m, shiftMonths)); // mes del anterior ya llevado a la época del actual
  const prevMonthSet = new Set(prevKeys);
  const prevLabelOf = new Map(prevKeys.map((k, i) => [k, prev.months[i]]));
  const sharedCount = months.filter((m) => prevMonthSet.has(m)).length;
  const hiddenIdx = prevKeys.map((k, i) => (months.includes(k) ? -1 : i)).filter((i) => i >= 0);
  const hiddenPrevMonths = hiddenIdx.map((i) => prev.months[i]);
  const hiddenPrevReservas = prev.markets.reduce((acc, m) => acc + hiddenIdx.reduce((a, i) => a + m.cells[i].reservas, 0), 0);
  const curMap = new Map(cur.markets.map((m) => [m.market, m]));
  const prevMap = new Map(prev.markets.map((m) => [m.market, m]));
  const markets = [...new Set([...cur.markets.map((m) => m.market), ...prev.markets.map((m) => m.market)])]
    .sort((a, b) => (a === BOOK_OTHER_MARKETS) - (b === BOOK_OTHER_MARKETS) || ((curMap.get(b) || {}).reservas || 0) - ((curMap.get(a) || {}).reservas || 0) || ((prevMap.get(b) || {}).reservas || 0) - ((prevMap.get(a) || {}).reservas || 0));
  const empty = { reservas: 0, noches: 0 };
  const cellOf = (map, market, month, monthsList) => {
    const m = map.get(market);
    const i = monthsList.indexOf(month);
    return m && i >= 0 ? m.cells[i] : empty;
  };
  const maxNoches = Math.max(1, ...cur.markets.flatMap((m) => m.cells.map((c) => c.noches)));

  const headerCells = months.map((m) => `<th${shiftMonths && prevLabelOf.has(m) ? ` title="Se compara con ${escapeHtml(prevLabelOf.get(m))} del periodo anterior"` : ''}>${escapeHtml(m)}</th>`).join('');
  const bodyRows = markets.map((market) => {
    const cm = curMap.get(market);
    const pm = prevMap.get(market);
    const cells = months.map((month) => {
      const c = cellOf(curMap, market, month, cur.months);
      const p = cellOf(prevMap, market, month, prevKeys);
      const { bg, fg } = heatColor(c.noches, maxNoches);
      // Cambio de reservas del mes frente al periodo anterior, en %: verde si sube, rojo si baja.
      // Sin base anterior (0) no hay % posible: se marca "nuevo". El valor anterior queda en el tooltip.
      const comparable = prevMonthSet.has(month);
      let badge = '';
      if (!comparable) {
        badge = '';
      } else if (p.reservas > 0) {
        const pct = (c.reservas - p.reservas) / p.reservas;
        badge = heatDeltaBadge(c.reservas - p.reservas, `${Math.abs(pct * 100).toFixed(0)}%`);
      } else if (c.reservas > 0) {
        badge = heatDeltaBadge(1, 'nuevo');
      }
      const content = c.reservas === 0 && p.reservas === 0
        ? `<div class="heatmap-cell-main" style="opacity:.35">0</div>`
        : `<div class="heatmap-cell-main">${fmtInt(c.reservas)} ${badge}</div>${c.reservas > 0 ? `<div class="heatmap-cell-sub">(${fmtInt(c.noches)}N)</div>` : ''}`;
      const tip = `Actual: ${fmtInt(c.reservas)} reservas (${fmtInt(c.noches)} noches) · Anterior${comparable && shiftMonths ? ` (${prevLabelOf.get(month)})` : ''}: ${comparable ? `${fmtInt(p.reservas)} reservas (${fmtInt(p.noches)} noches)` : 'sin llegadas en este mes, no se compara'}`;
      return `<td class="heatmap-cell" style="background:${bg};color:${fg}" title="${escapeHtml(tip)}">${content}</td>`;
    }).join('');
    const cr = cm ? cm.reservas : 0;
    const pr = pm ? pm.reservas : 0;
    const resPct = pr > 0 ? (cr - pr) / pr : null;
    const cp = cm ? cm.promNoches : null;
    const pp = pm ? pm.promNoches : null;
    const promPct = cp != null && pp != null && pp > 0 ? (cp - pp) / pp : null;
    const pctLabel = (v) => `${Math.abs(v * 100).toFixed(0)}%`;
    return `
      <tr>
        <td class="heatmap-row-label">${escapeHtml(market)}</td>
        <td><div class="heatmap-avg-cell">${fmtInt(cr)} ${resPct == null ? '' : heatDeltaBadge(resPct, pctLabel(resPct))}</div><div class="heatmap-cell-sub" style="color:var(--color-text-muted)">ant. ${fmtInt(pr)}</div></td>
        <td><div class="heatmap-avg-cell">${cp != null ? cp.toFixed(2) : '—'} ${promPct == null ? '' : heatDeltaBadge(promPct, pctLabel(promPct))}</div><div class="heatmap-cell-sub" style="color:var(--color-text-muted)">ant. ${pp != null ? pp.toFixed(2) : '—'}</div></td>
        ${cells}
      </tr>`;
  }).join('');

  return `
    <div class="heatmap-wrap">
      <table class="heatmap-table">
        <thead><tr><th></th><th>Total<br>reservas</th><th>Prom.<br>noches</th>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    ${shiftMonths ? `<p style="margin:10px 0 0;font-size:12px;color:var(--color-text-muted)">Los periodos son de épocas distintas, así que cada mes se compara con el de ${bookingShiftLabel(shiftMonths)} ${shiftMonths > 0 ? 'antes' : 'después'} (por ejemplo, ${escapeHtml(months[0])} contra ${escapeHtml(addMonthsToKey(months[0], -shiftMonths))}).</p>` : ''}
    ${!sharedCount ? `<p style="margin:10px 0 0;font-size:12px;color:var(--color-text-muted)">Los dos periodos no comparten ningún mes de llegada, así que mes a mes no hay con qué comparar: usa las columnas de Total.</p>` : ''}
    ${hiddenPrevMonths.length ? `<p style="margin:10px 0 0;font-size:12px;color:var(--color-text-muted)">${hiddenPrevMonths.length === 1 ? 'No se muestra 1 mes con llegadas' : `No se muestran ${hiddenPrevMonths.length} meses con llegadas`} solo en el periodo anterior (${escapeHtml(hiddenPrevMonths[0])}${hiddenPrevMonths.length > 1 ? ` a ${escapeHtml(hiddenPrevMonths[hiddenPrevMonths.length - 1])}` : ''}, ${fmtInt(hiddenPrevReservas)} reserva${hiddenPrevReservas === 1 ? '' : 's'}): siguen incluidas en las columnas de Total.</p>` : ''}
    <p style="margin:12px 0 0;font-size:11px;color:var(--color-text-muted)">Formato de celda: reservas del periodo actual con el % de cambio frente al mes equivalente del periodo anterior (▲ verde sube, ▼ rojo baja; "nuevo" = no había reservas ese mes en el anterior) y, debajo, las noches entre paréntesis. Pasa el cursor sobre una celda para ver el valor del periodo anterior. Las dos primeras columnas comparan el total de reservas y el promedio de noches por reserva de cada mercado. Mes = mes de llegada (entrada); solo se compara cuando el mes tiene llegadas en los dos periodos. El color de fondo sigue las noches del periodo actual.</p>
  `;
}

// HTML descargable del mapa de mercados (actual vs. anterior). Es una página autosuficiente que ajusta
// las columnas al ancho de la pantalla para que se vea completa sin desplazarse; el HTML del mapa es el
// mismo de la pantalla, con estilos propios.
function buildBookCompareMarketsHtml() {
  const s = state.book.compare;
  const currentRows = s.current.rows
    .filter((r) => s.marketFilter === 'all' || r.pais === s.marketFilter)
    .filter((r) => s.hotelFilter === 'all' || r.hotel === s.hotelFilter);
  const previousRows = s.previous.rows
    .filter((r) => s.marketFilter === 'all' || r.pais === s.marketFilter)
    .filter((r) => s.hotelFilter === 'all' || r.hotel === s.hotelFilter);
  // Para que quepa en una sola pantalla, solo se muestran los mercados con más reservas; el resto se junta en una fila.
  const MAX_MARKETS = 12;
  const totals = new Map();
  [...currentRows, ...previousRows].forEach((r) => { const k = r.pais || 'Sin dato'; totals.set(k, (totals.get(k) || 0) + 1); });
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const grouped = ranked.length > MAX_MARKETS + 1;
  const keep = new Set(ranked.slice(0, MAX_MARKETS));
  const group = (rows) => (grouped ? rows.map((r) => (keep.has(r.pais || 'Sin dato') ? r : { ...r, pais: BOOK_OTHER_MARKETS })) : rows);
  const scope = [s.marketFilter !== 'all' ? `Mercado: ${s.marketFilter}` : 'Todos los mercados', s.hotelFilter !== 'all' ? `Hotel: ${s.hotelFilter}` : 'Todos los hoteles'].join(' · ');
  const today = new Date().toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reservas por mercado — periodo actual vs. anterior</title>
${themedFontsLink('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap')}
<style>
${themed(':root{--gray-50:#f4f5f8;--gray-100:#eceef2;--color-text-heading:#14213d;--color-text-muted:#6b7280;--color-border:#d7dae1;--ok-bg:#eef6f1;--ok-text:#256a45;--danger:#b3352b;--danger-bg:#fbeceb}', ':root{--gray-50:#f8f8f8;--gray-100:#f2f2f2;--color-text-heading:#10222f;--color-text-muted:#5f5c5d;--color-border:#e4e4e4;--ok-bg:#dcf6e6;--ok-text:#15733d;--danger:#d5455f;--danger-bg:#fbe4e8}')}
*{box-sizing:border-box}
${themed("body{margin:0;padding:16px 20px;font-family:Inter,system-ui,-apple-system,sans-serif;color:var(--color-text-heading);background:#fff}\nh1{font-size:clamp(15px,1.6vw,22px);margin:0 0 4px}", "body{margin:0;padding:16px 20px;font-family:'Lato','Segoe UI',system-ui,sans-serif;color:var(--color-text-heading);background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}\nh1{font-family:'Montserrat','Lato',system-ui,sans-serif;font-size:clamp(15px,1.6vw,22px);font-weight:800;text-transform:uppercase;margin:0 0 4px}")}
.meta{font-size:clamp(10px,.85vw,12.5px);color:var(--color-text-muted);margin:0 0 12px}
.heatmap-wrap{overflow:visible}
.heatmap-table{border-collapse:separate;border-spacing:2px;width:100%;table-layout:fixed}
.heatmap-table th{${themed('', "font-family:'Montserrat','Lato',system-ui,sans-serif;")}font-size:clamp(8px,.72vw,10.5px);font-weight:${themed('600', '700')};color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.02em;padding:3px 1px;text-align:center}
.heatmap-table th:first-child,.heatmap-row-label{width:8%}
.heatmap-table td{padding:0;text-align:center;white-space:normal;overflow:hidden}
.heatmap-row-label{text-align:left!important;font-size:clamp(9px,.85vw,12.5px);font-weight:600;padding:0 4px!important}
.heatmap-cell{border-radius:5px;padding:5px 1px!important;min-width:0}
.heatmap-cell-main{font-size:clamp(9px,.85vw,13px);font-weight:700;line-height:1.25}
.heatmap-cell-sub{font-size:clamp(7.5px,.65vw,10px);opacity:.85;line-height:1.2}
.heatmap-avg-cell{font-weight:700;font-size:clamp(9px,.8vw,12.5px);background:var(--gray-50);border:1px solid var(--color-border);border-radius:5px;padding:5px 1px}
.delta-badge{display:inline-block;font-size:clamp(7.5px,.65vw,11px);font-weight:600;padding:0 4px;border-radius:999px;white-space:nowrap}
.delta-badge.good{background:var(--ok-bg);color:var(--ok-text)}
.delta-badge.bad{background:var(--danger-bg);color:var(--danger)}
.delta-badge.neutral{background:var(--gray-100);color:var(--color-text-muted)}
.note{font-size:clamp(9px,.75vw,11px);color:var(--color-text-muted);margin:10px 0 0}
@media print{@page{size:landscape;margin:8mm}body{padding:0}}
</style></head><body>
<h1>Reservas, noches y prom. de noches por mercado — periodo actual vs. anterior</h1>
<p class="meta">${escapeHtml(scope)} · Actual: ${escapeHtml(s.current.fileName || 'periodo actual')} · Anterior: ${escapeHtml(s.previous.fileName || 'periodo anterior')} · Generado el ${today} con Paid Media Helper</p>
${renderBookingsHeatmapCompare(group(currentRows), group(previousRows), bookingPeriodShiftMonths(s.current.rows, s.previous.rows))}
${grouped ? `<p class="note">Se muestran los ${MAX_MARKETS} mercados con más reservas; los otros ${ranked.length - MAX_MARKETS} mercados se suman en la fila "${BOOK_OTHER_MARKETS}". En la aplicación puedes ver todos.</p>` : ''}
</body></html>`;
}

// Llegadas por día de la semana con los dos periodos en el mismo cuadro: una fila por periodo y una
// tercera con la flecha del cambio en reservas (verde si sube, roja si baja) y, debajo, el cambio
// en puntos porcentuales del peso de ese día sobre el total de llegadas.
function renderArrivalsByWeekdayCompare(currentRows, previousRows) {
  const cur = engine.summarizeArrivalsByWeekday(currentRows);
  const prev = engine.summarizeArrivalsByWeekday(previousRows);
  const curTotal = cur.reduce((acc, d) => acc + d.reservas, 0);
  const prevTotal = prev.reduce((acc, d) => acc + d.reservas, 0);
  if (!curTotal && !prevTotal) {
    return `<p style="font-size:12.5px;color:var(--color-text-muted)">No hay reservas con fecha de entrada válida para graficar.</p>`;
  }
  const maxPct = Math.max(1, ...cur.map((d) => d.pct), ...prev.map((d) => d.pct));
  const headerCells = cur.map((d) => `<th>${d.day}</th>`).join('');
  const heatCells = (data) => data.map((d) => {
    const { bg, fg } = heatColor(d.pct, maxPct);
    return `<td class="heatmap-cell" style="background:${bg};color:${fg}"><div class="heatmap-cell-main">${d.pct.toFixed(1)}%</div><div class="heatmap-cell-sub">${fmtInt(d.reservas)}</div></td>`;
  }).join('');
  const changeCells = cur.map((d, i) => {
    const diff = d.reservas - prev[i].reservas;
    const pp = d.pct - prev[i].pct;
    return `<td class="heatmap-cell" style="background:var(--gray-50);color:var(--color-text-heading)"><div class="heatmap-cell-main">${heatDeltaBadge(diff, (diff > 0 ? '+' : '') + fmtInt(diff))}</div><div class="heatmap-cell-sub" style="color:var(--color-text-muted)">${pp > 0 ? '+' : ''}${pp.toFixed(1)} pp</div></td>`;
  }).join('');

  return `
    <div class="heatmap-wrap">
      <table class="heatmap-table">
        <thead><tr><th></th>${headerCells}</tr></thead>
        <tbody>
          <tr><td class="heatmap-row-label">Actual</td>${heatCells(cur)}</tr>
          <tr><td class="heatmap-row-label">Anterior</td>${heatCells(prev)}</tr>
          <tr><td class="heatmap-row-label">Cambio</td>${changeCells}</tr>
        </tbody>
      </table>
    </div>
    <p style="margin:12px 0 0;font-size:11px;color:var(--color-text-muted)">% de reservas según el día de la semana de la fecha de entrada (llegada), sobre el total de reservas con fecha válida de cada periodo; debajo, el número de reservas. La fila Cambio muestra la diferencia en reservas con una flecha (▲ verde sube, ▼ roja baja) y, en pequeño, la diferencia del peso del día en puntos porcentuales (pp).</p>
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
// Sección ROAS — solo modo API (el ROAS objetivo de la estrategia de puja
// no existe en ningún CSV). Trae, por campaña: ROAS logrado (gasto vs.
// valor de conversión real) y ROAS objetivo configurado, y permite
// ajustarlo cuando la estrategia de puja lo soporta (TARGET_ROAS o
// Maximizar valor de conversión, sin compartir la estrategia con otras
// campañas). Ver google_ads_client.py → ROAS_ADJUSTABLE_STRATEGIES para
// por qué el chequeo de compatibilidad se hace en la plataforma y no se
// deja en manos de validateOnly de Google (confirmado con una cuenta real
// que es más permisivo de lo que parece).
// ---------------------------------------------------------------------------

const BID_STRATEGY_LABELS_ES = {
  TARGET_ROAS: 'ROAS objetivo',
  MAXIMIZE_CONVERSION_VALUE: 'Maximizar valor de conversión',
  MAXIMIZE_CONVERSIONS: 'Maximizar conversiones',
  TARGET_CPA: 'CPA objetivo',
  MAXIMIZE_CLICKS: 'Maximizar clics',
  TARGET_SPEND: 'Gasto objetivo',
  MANUAL_CPC: 'CPC manual',
  MANUAL_CPM: 'CPM manual',
  MANUAL_CPV: 'CPV manual',
  TARGET_IMPRESSION_SHARE: 'Cuota de impresiones objetivo',
  PERCENT_CPC: 'CPC por porcentaje',
  COMMISSION: 'Comisión',
};

// Google Ads usa el mismo bidding_strategy_type (MAXIMIZE_CONVERSION_VALUE)
// tanto para "Maximizar valor de conversión" sin objetivo como para "Target
// ROAS" — la campaña de Maximizar valor de conversión CON un ROAS objetivo
// configurado. La UI de Google solo la llama "Target ROAS" en el segundo
// caso; confirmado contra una cuenta real (2026-07-30): la única campaña
// con target_roas != null entre varias "Maximizar valor de conversión" era
// justo la que cesar reportó como "Target ROAS" en Google Ads. Por eso la
// etiqueta depende de si hay un objetivo configurado, no solo del tipo.
function roasStrategyLabel(row) {
  if (row.bidding_strategy_type === 'MAXIMIZE_CONVERSION_VALUE' && row.target_roas != null) {
    return 'ROAS objetivo';
  }
  return BID_STRATEGY_LABELS_ES[row.bidding_strategy_type] || row.bidding_strategy_type;
}

function ensureRoasGoogleAdsStatusLoaded() {
  const a = state.roas.api;
  if (a.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { a.statusChecked = true; a.configured = !!data.configured; render(); })
    .catch(() => { a.statusChecked = true; a.configured = false; render(); });
}

function loadRoasGoogleAdsAccounts() {
  const a = state.roas.api;
  a.accountsStatus = 'loading'; a.error = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.accounts = data.accounts || [];
      a.simulated = !!data.simulated;
      if (!a.dateFrom || !a.dateTo) {
        const today = new Date();
        const monthAgo = new Date(today);
        monthAgo.setDate(monthAgo.getDate() - 30);
        a.dateTo = today.toISOString().slice(0, 10);
        a.dateFrom = monthAgo.toISOString().slice(0, 10);
      }
      a.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.accountsStatus = 'error'; a.error = err.message || String(err);
      render();
    });
}

// focusId: campaña que viene del detalle de Campañas; si se puede ajustar, queda con el editor abierto.
function fetchRoasByCampaign(focusId) {
  const s = state.roas;
  const a = s.api;
  const manualId = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  const customerId = manualId || a.accountId;
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }
  if (!a.dateFrom || !a.dateTo) { a.error = 'Elige el rango de fechas primero.'; render(); return; }

  a.error = null;
  s.status = 'loading'; s.error = null; s.focusId = focusId || null; s.focusNote = null;
  render();

  const params = new URLSearchParams({ customer_id: customerId || '', date_from: a.dateFrom, date_to: a.dateTo, only_active: a.onlyActive ? '1' : '0' });
  fetch(`/api/google-ads/roas?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.simulated = !!data.simulated;
      s.rows = data.rows || [];
      s.status = 'ready';
      s.adjust = { campaignId: null, newTargetRoas: '', status: 'idle', preview: null, result: null, error: null };
      if (focusId) {
        const fr = s.rows.find((r) => r.campaign_id === focusId);
        if (!fr) s.focusNote = 'Esa campaña no tiene datos en este rango de fechas, así que no aparece en la tabla.';
        else if (fr.is_portfolio) s.focusNote = 'Esa campaña usa una estrategia de puja compartida con otras campañas: aquí solo se puede ver.';
        else if (!fr.adjustable) s.focusNote = `Esa campaña usa la estrategia ${roasStrategyLabel(fr)}, que no tiene ROAS objetivo para ajustar.`;
        else s.adjust.campaignId = focusId;
      }
      render();
      if (focusId) scrollToFocusRow('roas-focus-row');
    })
    .catch((err) => {
      a.error = err.message || String(err);
      s.status = 'idle';
      render();
    });
}

// preview=true valida sin aplicar; preview=false escribe de verdad en la
// cuenta. El chequeo de "esta estrategia sí soporta ROAS objetivo" ya pasó
// en el cliente antes de mostrar el botón "Ajustar" — este llamado repite
// el chequeo también del lado del servidor (google_ads_client.py), por si
// la fila quedó desactualizada.
function adjustRoasTarget(preview) {
  const s = state.roas;
  const adj = s.adjust;
  const row = (s.rows || []).find((r) => r.campaign_id === adj.campaignId);
  if (!row) { adj.error = 'No se encontró la campaña.'; render(); return; }

  const pct = parseFloat(adj.newTargetRoas);
  if (Number.isNaN(pct) || pct <= 0) { adj.error = 'Escribe un ROAS objetivo válido, mayor que cero (ej. 350 para 350%).'; render(); return; }

  const a = s.api;
  const manualId = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  const customerId = manualId || a.accountId;

  adj.status = preview ? 'previewing' : 'applying';
  adj.error = null;
  render();

  fetch('/api/google-ads/roas-adjust', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: customerId,
      campaign_id: row.campaign_id,
      bidding_strategy_type: row.bidding_strategy_type,
      target_roas: pct / 100, // la API espera un ratio (3.5 = 350%), no un porcentaje
      validate_only: preview,
    }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (preview) {
        adj.status = 'preview_ready';
        adj.preview = { targetRoasPct: pct, campaignName: row.campaign_name };
      } else {
        adj.status = 'done';
        adj.result = { targetRoasPct: pct, campaignName: row.campaign_name };
        row.target_roas = pct / 100; // refleja el nuevo valor en la tabla sin tener que volver a traer todo
      }
      render();
    })
    .catch((err) => {
      adj.status = 'error';
      adj.error = err.message || String(err);
      render();
    });
}

function loadRoasMccGroups() {
  const m = state.roas.api.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => { m.status = 'error'; m.error = err.message || String(err); render(); });
}

function applyRoasMccFilter(groupId, groupName) {
  const a = state.roas.api;
  const m = a.mcc;
  m.selectedId = groupId; m.selectedName = groupName;
  m.accountIdsStatus = 'loading'; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(groupId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.accountIds = new Set((data.accounts || []).map((acc) => acc.id));
      m.accountIdsStatus = 'ready';
      // Si la cuenta que ya estaba elegida no cuelga de este MCC, se limpia.
      if (a.accountId && !m.accountIds.has(a.accountId)) a.accountId = '';
      render();
    })
    .catch((err) => { m.accountIdsStatus = 'error'; m.error = err.message || String(err); render(); });
}

function clearRoasMccFilter() {
  const m = state.roas.api.mcc;
  m.selectedId = ''; m.selectedName = ''; m.accountIds = null; m.accountIdsStatus = 'idle'; m.filter = '';
  render();
}

function renderRoasMccFilterPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.roas.api.mcc;

  if (m.selectedId) {
    const countLabel = m.accountIdsStatus === 'loading' ? 'cargando…'
      : m.accountIdsStatus === 'ready' ? `${m.accountIds.size} cuenta(s)`
      : 'error';
    return `
      <div class="field">
        <label>Filtrando por MCC</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="delta-badge neutral">${escapeHtml(m.selectedName)} — ${countLabel}</span>
          <button class="btn-link" data-action="roas-mcc-clear">Quitar filtro</button>
        </div>
      </div>`;
  }

  if (m.status === 'idle') {
    return `<div class="field"><button class="btn-outline sm" data-action="roas-mcc-load">Filtrar por MCC (ej. una cadena de hoteles)</button></div>`;
  }
  if (m.status === 'loading') {
    return `<div class="field"><p class="footnote">Cargando agrupaciones del MCC…</p></div>`;
  }
  if (m.status === 'error') {
    return `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  }

  const filter = (m.filter || '').trim().toLowerCase();
  let matches = [];
  if (filter.length >= 2) {
    matches = m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25);
  }
  const matchesHtml = matches.length
    ? `<div class="table-scroll" style="max-height:200px;margin-top:8px">
        <table><tbody>
          ${matches.map((g) => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
              <td><button class="btn-outline xs" data-roas-mcc-pick="${escapeHtml(g.id)}" data-roas-mcc-pick-name="${escapeHtml(g.name)}">Usar</button></td>
            </tr>`).join('')}
        </tbody></table>
      </div>`
    : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');

  return `
    <div class="field">
      <label>Filtrar por MCC</label>
      <input type="text" id="roas-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:320px" />
      ${matchesHtml}
    </div>`;
}

function renderRoasApiPanel() {
  const a = state.roas.api;

  if (!a.statusChecked) {
    return `<div class="field"><p class="footnote">Consultando la conexión con Google Ads…</p></div>`;
  }

  const simulatedNotice = a.simulated ? `
    <div class="ok-panel" style="margin:10px 0">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor
      (falta la aprobación del developer token de Google) — estos son datos de ejemplo, no de una cuenta real.
    </div>` : '';

  if (a.accountsStatus === 'idle') {
    return `
      <div class="card control-panel align-end">
        <div class="field">
          <p class="footnote">${a.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.'}</p>
          <button class="btn-outline" data-action="roas-api-load-accounts">Ver cuentas disponibles</button>
        </div>
      </div>`;
  }
  if (a.accountsStatus === 'loading') {
    return `<div class="card control-panel align-end"><div class="field"><p class="footnote">Cargando cuentas…</p></div></div>`;
  }
  if (a.accountsStatus === 'error') {
    return `<div class="error-panel"><strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(a.error)}</div>`;
  }

  const mccFilterActive = a.mcc.selectedId && a.mcc.accountIds;
  const visibleAccounts = mccFilterActive ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
  const accountOptions = ['<option value="">Elige una cuenta…</option>']
    .concat(visibleAccounts.map((acc) => `<option value="${escapeHtml(acc.id)}" ${a.accountId === acc.id ? 'selected' : ''}>${escapeHtml(acc.name)} (${escapeHtml(acc.id)})</option>`))
    .join('');

  return `
    <div class="card control-panel align-end">
      ${simulatedNotice}
      ${renderRoasMccFilterPanel()}
      <div class="field">
        <label>Cuenta${mccFilterActive ? ` (${visibleAccounts.length} en "${escapeHtml(a.mcc.selectedName)}")` : ''}</label>
        <select id="roas-api-account" style="width:320px">${accountOptions}</select>
      </div>
      <div class="field">
        <label>...o escribe el ID de la cuenta</label>
        <input type="text" id="roas-api-account-manual" value="${escapeHtml(a.accountIdManual)}" placeholder="ej. 6862893390" style="width:160px" />
      </div>
      <div style="display:flex;gap:24px;flex-wrap:nowrap">
        <div class="field">
          <label>Desde</label>
          <input type="date" id="roas-api-date-from" value="${escapeHtml(a.dateFrom)}" />
        </div>
        <div class="field">
          <label>Hasta</label>
          <input type="date" id="roas-api-date-to" value="${escapeHtml(a.dateTo)}" />
        </div>
      </div>
      <div class="field">
        <label style="display:flex;align-items:center;gap:8px;font-weight:400">
          <input type="checkbox" id="roas-api-only-active" ${a.onlyActive ? 'checked' : ''} />
          Solo campañas activas
        </label>
      </div>
      <button class="btn-accent" data-action="roas-api-fetch">Traer ROAS de Google Ads</button>
      ${a.error ? `<div class="error-panel" style="margin-top:10px"><strong>No se pudo traer el reporte.</strong> ${escapeHtml(a.error)}</div>` : ''}
    </div>`;
}

function renderRoasAdjustRow(row) {
  const s = state.roas;
  const adj = s.adjust;
  const isEditing = adj.campaignId === row.campaign_id;
  const strategyLabel = roasStrategyLabel(row);

  if (!isEditing) {
    if (row.is_portfolio) {
      return `<span class="footnote" title="Esta campaña usa una estrategia de puja compartida con otras campañas — ajustarla desde acá afectaría a todas, así que se deja en solo lectura.">Estrategia compartida — solo lectura</span>`;
    }
    if (!row.adjustable) {
      return `<span class="footnote" title="La estrategia ${escapeHtml(strategyLabel)} no tiene un ROAS objetivo — habría que cambiar de estrategia de puja primero.">No ajustable desde acá</span>`;
    }
    return `<button class="btn-outline sm" data-action="roas-edit-start" data-campaign="${escapeHtml(row.campaign_id)}">Ajustar</button>`;
  }

  const busy = adj.status === 'previewing' || adj.status === 'applying';

  if (adj.status === 'idle' || adj.status === 'error') {
    return `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="text" id="roas-adjust-input" value="${escapeHtml(adj.newTargetRoas)}" placeholder="ej. 350" style="width:80px" />
        <span class="footnote">%</span>
        <button class="btn-accent sm" data-action="roas-edit-preview" ${busy ? 'disabled' : ''}>Vista previa</button>
        <button class="btn-outline sm" data-action="roas-edit-cancel">Cancelar</button>
      </div>
      ${adj.error ? `<div class="error-panel" style="margin-top:6px;font-size:12px">${escapeHtml(adj.error)}</div>` : ''}`;
  }

  if (busy) {
    return `<p class="footnote">${adj.status === 'previewing' ? 'Validando con Google Ads (vista previa, no aplica nada todavía)…' : 'Aplicando el cambio en Google Ads…'}</p>`;
  }

  if (adj.status === 'preview_ready' && adj.preview) {
    return `
      <div class="ok-panel" style="margin:6px 0;padding:10px 12px;font-size:12.5px">
        <strong>Vista previa lista.</strong> Vas a cambiar el ROAS objetivo de "${escapeHtml(adj.preview.campaignName)}" a <strong>${adj.preview.targetRoasPct}%</strong> — esto cambia cómo puja Google en una campaña real y en producción.
        <div style="margin-top:8px;display:flex;gap:8px">
          <button class="btn-accent sm" data-action="roas-edit-confirm">Confirmar y aplicar</button>
          <button class="btn-outline sm" data-action="roas-edit-cancel">Cancelar</button>
        </div>
      </div>`;
  }

  if (adj.status === 'done' && adj.result) {
    return `<div class="ok-panel" style="margin:6px 0;padding:8px 12px;font-size:12.5px"><strong>Listo.</strong> ROAS objetivo actualizado a ${adj.result.targetRoasPct}%.</div>`;
  }

  return '';
}

function renderRoasPage() {
  const s = state.roas;
  // No hay modo "Subir archivo" en esta sección (el ROAS objetivo no viene
  // en ningún CSV), así que a diferencia de las páginas con toggle, acá
  // hay que disparar la consulta de estado apenas se entra a la página —
  // idempotente, ensureRoasGoogleAdsStatusLoaded() no repite la llamada
  // una vez que ya tiene respuesta.
  ensureRoasGoogleAdsStatusLoaded();

  const controlPanel = renderRoasApiPanel();

  let body = '';
  if (s.status === 'idle') {
    body = `
      <div class="card state-panel idle">
        ${icon('percent', 30)}
        <p>Conecta una cuenta de Google Ads y trae el rango de fechas para ver el ROAS logrado y el ROAS objetivo de cada campaña.</p>
      </div>`;
  } else if (s.status === 'loading') {
    body = `
      <div class="card state-panel loading">
        <div class="spinner"></div>
        <p>Trayendo ROAS por campaña…</p>
      </div>`;
  } else if (s.status === 'ready') {
    const rows = [...(s.rows || [])].sort((a, b) => (b.roas ?? -1) - (a.roas ?? -1));
    const rowsHtml = rows.map((r) => `
      <tr${s.focusId && r.campaign_id === s.focusId ? ' id="roas-focus-row" style="background:var(--gold-100,#fdf1d8)"' : ''}>
        <td>${escapeHtml(r.campaign_name)}</td>
        <td>${escapeHtml(roasStrategyLabel(r))}</td>
        <td>${r.roas != null ? (r.roas * 100).toFixed(0) + '%' : 'N/D'}</td>
        <td>${r.target_roas != null ? (r.target_roas * 100).toFixed(0) + '%' : 'N/D'}</td>
        <td>${renderRoasAdjustRow(r)}</td>
      </tr>`).join('');

    const roasChartRows = rows.filter((r) => r.target_roas != null);

    body = rows.length ? `
      ${roasChartRows.length ? `
      <div class="card chart-card" style="margin-bottom:20px">
        <h3 class="dense-chart-title">ROAS logrado vs. objetivo (${roasChartRows.length})</h3>
        <div style="height:${Math.max(240, roasChartRows.length * 34)}px"><canvas id="roas-chart-main"></canvas></div>
      </div>` : ''}
      <div class="card table-panel">
        <div class="table-panel-head">
          <h3>ROAS por campaña (${rows.length})</h3>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Campaña</th><th>Estrategia de puja</th><th>ROAS logrado</th><th>ROAS objetivo</th><th>Ajustar</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <p class="footnote" style="margin-top:14px">
          El ROAS logrado es gasto real vs. valor de conversión real, en el rango de fechas elegido. El ROAS objetivo solo existe para campañas con estrategia "ROAS objetivo" o "Maximizar valor de conversión" — el resto de estrategias no tienen ese concepto y no se pueden ajustar desde acá.
          Ajustar el ROAS objetivo cambia de verdad cómo puja Google en la cuenta real — la vista previa de Google para este cambio en particular es menos confiable que la de negativos (validó sin error incluso una estrategia incompatible en una prueba), así que el chequeo de "esta campaña sí admite ROAS objetivo" lo hace la plataforma antes de dejar ajustar, no solo Google.
        </p>
      </div>` : `<div class="error-panel">No se encontraron campañas con datos en este rango de fechas.</div>`;
  } else if (s.status === 'error') {
    body = `<div class="error-panel"><strong>No se pudo traer el reporte.</strong> ${escapeHtml(s.error)}</div>`;
  }

  const focusNote = s.focusNote ? `<div class="error-panel" style="margin-bottom:16px">${escapeHtml(s.focusNote)}</div>` : '';
  return `${controlPanel}${focusNote}${body}`;
}

// ---------------------------------------------------------------------------
// Página — Recomendaciones de Google (Función 9, solo lectura)
// ---------------------------------------------------------------------------

function ensureRecsGoogleAdsStatusLoaded() {
  const a = state.recs.api;
  if (a.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { a.statusChecked = true; a.configured = !!data.configured; render(); })
    .catch(() => { a.statusChecked = true; a.configured = false; render(); });
}

function loadRecsGoogleAdsAccounts() {
  const a = state.recs.api;
  a.accountsStatus = 'loading'; a.error = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.accounts = data.accounts || [];
      a.simulated = !!data.simulated;
      a.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.accountsStatus = 'error'; a.error = err.message || String(err);
      render();
    });
}

// focusName: campaña que viene del detalle de Campañas; deja el filtro puesto en ella si Google tiene recomendaciones para ella.
function fetchRecommendations(focusName) {
  const s = state.recs;
  const a = s.api;
  const manualId = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  const customerId = manualId || a.accountId;
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }

  a.error = null;
  s.status = 'loading'; s.error = null; s.focusNote = null;
  render();

  const params = new URLSearchParams({ customer_id: customerId || '' });
  fetch(`/api/google-ads/recommendations?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.simulated = !!data.simulated;
      s.currency = data.currency || '';
      s.rows = data.rows || [];
      s.score = data.score || null;
      s.actions = {};
      s.campaignFilter = 'all';
      if (focusName) {
        if (s.rows.some((r) => r.campaign_name === focusName)) s.campaignFilter = focusName;
        else s.focusNote = 'Google no tiene recomendaciones activas para esa campaña; se muestran las de toda la cuenta.';
      }
      s.status = 'ready';
      render();
    })
    .catch((err) => {
      a.error = err.message || String(err);
      s.status = 'idle';
      render();
    });
}

// Filtro por campaña — a diferencia de otras pantallas, acá no hace falta
// una llamada aparte a la API para listar campañas: ya vienen en las
// filas que trajo fetchRecommendations. Algunas recomendaciones no están
// atadas a ninguna campaña (ej. "Mover presupuesto sin usar" es a nivel de
// cuenta) — esas se agrupan bajo el valor especial '__account__' en vez de
// perderse o mezclarse con "Todas".
function getRecsFilteredRows() {
  const s = state.recs;
  const rows = s.rows || [];
  if (s.campaignFilter === 'all') return rows;
  if (s.campaignFilter === '__account__') return rows.filter((r) => !r.campaign_name);
  return rows.filter((r) => r.campaign_name === s.campaignFilter);
}

// Aplicar/descartar no tienen vista previa de Google (a diferencia de
// negativos y ROAS, ver nota en server.py) — el confirm() de acá ES la
// única confirmación que existe antes de escribir en la cuenta real.
function applyRecommendation(row) {
  if (!window.confirm(`¿Aplicar "${row.type_label}" en Google Ads? Este cambio queda escrito de inmediato en la cuenta real — no hay vista previa para este tipo de acción.`)) return;
  recommendationAction(row, 'apply');
}

function dismissRecommendation(row) {
  if (!window.confirm(`¿Descartar la recomendación "${row.type_label}"? Google dejará de sugerirla — no cambia nada en la cuenta, solo oculta la sugerencia.`)) return;
  recommendationAction(row, 'dismiss');
}

function recommendationAction(row, kind) {
  const s = state.recs;
  const a = s.api;
  const manualId = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  const customerId = manualId || a.accountId;
  const key = row.resource_name;
  s.actions[key] = { status: 'busy', error: null };
  render();

  fetch(`/api/google-ads/recommendations/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId || '', resource_name: row.resource_name }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      // Optimista: la recomendación ya no aplica (aplicada o descartada),
      // se quita de la lista en vez de dejarla marcada — evita que alguien
      // le vuelva a dar clic a algo que Google ya procesó.
      s.rows = (s.rows || []).filter((r) => r.resource_name !== key);
      delete s.actions[key];
      render();
    })
    .catch((err) => {
      s.actions[key] = { status: 'error', error: err.message || String(err) };
      render();
    });
}

// El impacto que trae cada recomendación varía mucho por tipo (algunas
// traen conversiones proyectadas, otras solo clics o costo, muchas no
// traen nada) — confirmado contra una cuenta real (2026-08-11), no todas
// las recomendaciones de Google tienen el mismo detalle. Se muestra lo más
// concreto que haya, en este orden de preferencia.
function recImpactLabel(r) {
  if (r.potential_conversions != null) return `hasta ${fmtInt(r.potential_conversions)} conv.`;
  if (r.potential_clicks != null) return `hasta ${fmtInt(r.potential_clicks)} clics`;
  if (r.potential_impressions != null) return `hasta ${fmtInt(r.potential_impressions)} impr.`;
  if (r.potential_cost != null) return `≈ ${fmtMoney(r.potential_cost)}`;
  return 'Ver en Google Ads';
}

function loadRecsMccGroups() {
  const m = state.recs.api.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => { m.status = 'error'; m.error = err.message || String(err); render(); });
}

function applyRecsMccFilter(groupId, groupName) {
  const a = state.recs.api;
  const m = a.mcc;
  m.selectedId = groupId; m.selectedName = groupName;
  m.accountIdsStatus = 'loading'; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(groupId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.accountIds = new Set((data.accounts || []).map((acc) => acc.id));
      m.accountIdsStatus = 'ready';
      // Si la cuenta que ya estaba elegida no cuelga de este MCC, se limpia.
      if (a.accountId && !m.accountIds.has(a.accountId)) a.accountId = '';
      render();
    })
    .catch((err) => { m.accountIdsStatus = 'error'; m.error = err.message || String(err); render(); });
}

function clearRecsMccFilter() {
  const m = state.recs.api.mcc;
  m.selectedId = ''; m.selectedName = ''; m.accountIds = null; m.accountIdsStatus = 'idle'; m.filter = '';
  render();
}

function renderRecsMccFilterPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.recs.api.mcc;

  if (m.selectedId) {
    const countLabel = m.accountIdsStatus === 'loading' ? 'cargando…'
      : m.accountIdsStatus === 'ready' ? `${m.accountIds.size} cuenta(s)`
      : 'error';
    return `
      <div class="field">
        <label>Filtrando por MCC</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="delta-badge neutral">${escapeHtml(m.selectedName)} — ${countLabel}</span>
          <button class="btn-link" data-action="recs-mcc-clear">Quitar filtro</button>
        </div>
      </div>`;
  }

  if (m.status === 'idle') {
    return `<div class="field"><button class="btn-outline sm" data-action="recs-mcc-load">Filtrar por MCC (ej. una cadena de hoteles)</button></div>`;
  }
  if (m.status === 'loading') {
    return `<div class="field"><p class="footnote">Cargando agrupaciones del MCC…</p></div>`;
  }
  if (m.status === 'error') {
    return `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  }

  const filter = (m.filter || '').trim().toLowerCase();
  let matches = [];
  if (filter.length >= 2) {
    matches = m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25);
  }
  const matchesHtml = matches.length
    ? `<div class="table-scroll" style="max-height:200px;margin-top:8px">
        <table><tbody>
          ${matches.map((g) => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
              <td><button class="btn-outline xs" data-recs-mcc-pick="${escapeHtml(g.id)}" data-recs-mcc-pick-name="${escapeHtml(g.name)}">Usar</button></td>
            </tr>`).join('')}
        </tbody></table>
      </div>`
    : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');

  return `
    <div class="field">
      <label>Filtrar por MCC</label>
      <input type="text" id="recs-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:320px" />
      ${matchesHtml}
    </div>`;
}

function renderRecsApiPanel() {
  const a = state.recs.api;

  if (!a.statusChecked) {
    return `<div class="field"><p class="footnote">Consultando la conexión con Google Ads…</p></div>`;
  }

  const simulatedNotice = a.simulated ? `
    <div class="ok-panel" style="margin:10px 0">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor
      (falta la aprobación del developer token de Google) — estos son datos de ejemplo, no de una cuenta real.
    </div>` : '';

  if (a.accountsStatus === 'idle') {
    return `
      <div class="card control-panel align-end">
        <div class="field">
          <p class="footnote">${a.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.'}</p>
          <button class="btn-outline" data-action="recs-api-load-accounts">Ver cuentas disponibles</button>
        </div>
      </div>`;
  }
  if (a.accountsStatus === 'loading') {
    return `<div class="card control-panel align-end"><div class="field"><p class="footnote">Cargando cuentas…</p></div></div>`;
  }
  if (a.accountsStatus === 'error') {
    return `<div class="error-panel"><strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(a.error)}</div>`;
  }

  const mccFilterActive = a.mcc.selectedId && a.mcc.accountIds;
  const visibleAccounts = mccFilterActive ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
  const accountOptions = ['<option value="">Elige una cuenta…</option>']
    .concat(visibleAccounts.map((acc) => `<option value="${escapeHtml(acc.id)}" ${a.accountId === acc.id ? 'selected' : ''}>${escapeHtml(acc.name)} (${escapeHtml(acc.id)})</option>`))
    .join('');

  return `
    <div class="card control-panel align-end">
      ${simulatedNotice}
      ${renderRecsMccFilterPanel()}
      <div class="field">
        <label>Cuenta${mccFilterActive ? ` (${visibleAccounts.length} en "${escapeHtml(a.mcc.selectedName)}")` : ''}</label>
        <select id="recs-api-account" style="width:320px">${accountOptions}</select>
      </div>
      <div class="field">
        <label>...o escribe el ID de la cuenta</label>
        <input type="text" id="recs-api-account-manual" value="${escapeHtml(a.accountIdManual)}" placeholder="ej. 6862893390" style="width:160px" />
      </div>
      <button class="btn-accent" data-action="recs-api-fetch">Traer recomendaciones</button>
      ${a.error ? `<div class="error-panel" style="margin-top:10px"><strong>No se pudo traer las recomendaciones.</strong> ${escapeHtml(a.error)}</div>` : ''}
    </div>`;
}

function renderRecsPage() {
  return withMoneyCurrency(state.recs.currency, () => renderRecsPageBody());
}

function renderRecsPageBody() {
  const s = state.recs;
  // Igual que ROAS: no hay modo "Subir archivo" (esto no viene en ningún
  // CSV), así que hace falta disparar la consulta de estado apenas se
  // entra a la página.
  ensureRecsGoogleAdsStatusLoaded();

  const controlPanel = renderRecsApiPanel();

  let scoreCard = '';
  if (s.status === 'ready' && s.score && s.score.score != null) {
    const pct = Math.round(s.score.score * 100);
    scoreCard = `
      <div class="card stat-card accent" style="max-width:260px;margin-bottom:20px">
        <div class="stat-label">Puntaje de optimización</div>
        <div class="stat-value lg">${pct}%</div>
        <div class="stat-sub">Mismo puntaje que se ve en la pestaña "Recomendaciones" de Google Ads</div>
      </div>`;
  }

  let body = '';
  if (s.status === 'idle') {
    body = `
      <div class="card state-panel idle">
        ${icon('lightbulb', 30)}
        <p>Conecta una cuenta de Google Ads para ver su puntaje de optimización y las recomendaciones que Google ya generó para ella.</p>
      </div>`;
  } else if (s.status === 'loading') {
    body = `
      <div class="card state-panel loading">
        <div class="spinner"></div>
        <p>Trayendo recomendaciones…</p>
      </div>`;
  } else if (s.status === 'ready') {
    const allRows = s.rows || [];
    const hasAccountLevel = allRows.some((r) => !r.campaign_name);
    const campaignNames = [...new Set(allRows.map((r) => r.campaign_name).filter(Boolean))].sort();
    const filterPanel = allRows.length ? `
      <div class="card control-panel align-end" style="margin-bottom:20px">
        <div class="field">
          <label>Ver solo esta campaña</label>
          <select id="recs-campaign-filter" style="width:320px">
            <option value="all" ${s.campaignFilter === 'all' ? 'selected' : ''}>Todas las campañas</option>
            ${hasAccountLevel ? `<option value="__account__" ${s.campaignFilter === '__account__' ? 'selected' : ''}>Toda la cuenta (sin campaña)</option>` : ''}
            ${campaignNames.map((c) => `<option value="${escapeHtml(c)}" ${s.campaignFilter === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
          </select>
        </div>
      </div>` : '';

    const rows = getRecsFilteredRows();
    const rowsHtml = rows.map((r) => {
      const action = s.actions[r.resource_name];
      const busy = action && action.status === 'busy';
      const actionCell = busy ? `<span class="footnote">Procesando…</span>` : `
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn-outline xs" data-rec-apply="${escapeHtml(r.resource_name)}">Aplicar</button>
          <button class="btn-outline xs" data-rec-dismiss="${escapeHtml(r.resource_name)}">Descartar</button>
        </div>
        ${action && action.status === 'error' ? `<div class="error-panel" style="margin-top:6px;font-size:11px;padding:6px 8px">${escapeHtml(action.error)}</div>` : ''}`;
      return `
      <tr>
        <td>${escapeHtml(r.type_label)}</td>
        <td>${escapeHtml(r.campaign_name || 'Toda la cuenta')}</td>
        <td>${escapeHtml(recImpactLabel(r))}</td>
        <td>${actionCell}</td>
      </tr>`;
    }).join('');

    const countLabel = s.campaignFilter === 'all' ? `${rows.length}` : `${rows.length} de ${allRows.length}`;

    if (!allRows.length) {
      body = `
        ${scoreCard}
        <div class="card state-panel idle">${icon('check-circle', 30)}<p>Google Ads no tiene recomendaciones activas para esta cuenta ahora mismo.</p></div>`;
    } else {
      body = `
        ${scoreCard}
        ${filterPanel}
        ${rows.length ? `
        <div class="card table-panel">
          <div class="table-panel-head">
            <h3>Recomendaciones activas (${countLabel})</h3>
          </div>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Recomendación</th><th>Campaña</th><th>Impacto estimado</th><th>Acción</th></tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          <p class="footnote" style="margin-top:14px">
            Estas son las recomendaciones y el puntaje que el motor propio de Google Ads ya calculó para la cuenta — no un análisis de IA generativa (eso es un plan aparte, todavía no construido). "Aplicar" y "Descartar" escriben en la cuenta real de inmediato — Google no ofrece vista previa para esta acción, así que la confirmación es la única red de seguridad. Las recomendaciones que piden un valor específico (presupuesto, palabra clave, texto de anuncio) van a fallar al aplicarlas — esas todavía hay que resolverlas directo en Google Ads.
          </p>
        </div>` : `
        <div class="card state-panel idle">${icon('check-circle', 30)}<p>Ninguna recomendación activa para esta campaña.</p></div>`}`;
    }
  } else if (s.status === 'error') {
    body = `<div class="error-panel"><strong>No se pudo traer las recomendaciones.</strong> ${escapeHtml(s.error)}</div>`;
  }

  const focusNote = s.focusNote ? `<div class="ok-panel" style="margin-bottom:16px">${escapeHtml(s.focusNote)}</div>` : '';
  return `${controlPanel}${focusNote}${body}`;
}

// ---------------------------------------------------------------------------
// Página — IA Max (AI Max for Search). A diferencia de "Ask Advisor", sí
// tiene API real (Campaign.ai_max_setting, desde v25 — confirmado contra el
// .proto, ver google_ads_client.py). Tres sub-vistas sobre la misma cuenta:
// estado/toggle, qué sirvió AI Max de verdad, y cruce con negativos ya
// reales en la cuenta.
// ---------------------------------------------------------------------------

// El selector de cuenta es compartido por las 3 pestañas, pero cada una se
// trae con su propio botón ("Traer datos de IA Max" solo trae Estado;
// "Traer lo que sirvió AI Max" solo trae Servido/Cruce). Sin este reset, al
// cambiar de cuenta las pestañas que no se volvieron a traer seguían
// mostrando los datos de la cuenta anterior como si fueran de la actual —
// bug real reportado por cesar (2026-08-19).
function resetIaMaxAccountData() {
  const s = state.iamax;
  s.status = 'idle'; s.error = null; s.rows = null; s.currency = '';
  s.toggle = { campaignId: null, status: 'idle', newEnable: null, preview: null, result: null, error: null };
  s.served = { status: 'idle', error: null, rows: null, negatives: null, campaignFilter: 'all' };
  s.created = { status: 'idle', error: null, data: null, sub: s.created ? s.created.sub : 'assets', campaignFilter: 'all', days: s.created ? s.created.days : 30, sort: { assets: null, combinations: null, pages: null }, selected: {} };
  s.urlx = { status: 'idle', error: null, rows: null, campaigns: null, draft: [], pasteText: '', pasteCampaign: '', pasteNote: null, flow: { status: 'idle', preview: null, result: null, error: null, invalid: null }, remove: { pending: null, status: 'idle', error: null } };
}

function ensureIaMaxGoogleAdsStatusLoaded() {
  const a = state.iamax.api;
  if (a.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { a.statusChecked = true; a.configured = !!data.configured; render(); })
    .catch(() => { a.statusChecked = true; a.configured = false; render(); });
}

function loadIaMaxGoogleAdsAccounts() {
  const a = state.iamax.api;
  a.accountsStatus = 'loading'; a.error = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.accounts = data.accounts || [];
      a.simulated = !!data.simulated;
      a.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.accountsStatus = 'error'; a.error = err.message || String(err);
      render();
    });
}

function iaMaxCustomerId() {
  const a = state.iamax.api;
  const manualId = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  return manualId || a.accountId;
}

function fetchIaMaxStatus() {
  const s = state.iamax;
  const a = s.api;
  const customerId = iaMaxCustomerId();
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }

  a.error = null;
  s.status = 'loading'; s.error = null;
  render();

  const params = new URLSearchParams({ customer_id: customerId || '', only_active: a.onlyActive ? '1' : '0' });
  fetch(`/api/google-ads/ai-max?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.simulated = !!data.simulated;
      s.rows = data.rows || [];
      s.status = 'ready';
      s.toggle = { campaignId: null, status: 'idle', newEnable: null, preview: null, result: null, error: null };
      render();
    })
    .catch((err) => {
      a.error = err.message || String(err);
      s.status = 'idle';
      render();
    });
}

// preview=true valida sin aplicar; preview=false escribe de verdad en la
// cuenta. Igual que ROAS: nunca un solo clic entre decidir y escribir.
function toggleAiMax(preview) {
  const s = state.iamax;
  const t = s.toggle;
  const row = (s.rows || []).find((r) => r.campaign_id === t.campaignId);
  if (!row) { t.error = 'No se encontró la campaña.'; render(); return; }

  const customerId = iaMaxCustomerId();
  t.status = preview ? 'previewing' : 'applying';
  t.error = null;
  render();

  fetch('/api/google-ads/ai-max-toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: customerId,
      campaign_id: row.campaign_id,
      enable: t.newEnable,
      validate_only: preview,
    }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (preview) {
        t.status = 'preview_ready';
        t.preview = { enable: t.newEnable, campaignName: row.campaign_name };
      } else {
        t.status = 'done';
        t.result = { enable: t.newEnable, campaignName: row.campaign_name };
        row.enabled = t.newEnable; // refleja el nuevo valor en la tabla sin volver a traer todo
      }
      render();
    })
    .catch((err) => {
      t.status = 'error';
      t.error = err.message || String(err);
      render();
    });
}

function fetchIaMaxServed() {
  const s = state.iamax;
  const a = s.api;
  const sv = s.served;
  const customerId = iaMaxCustomerId();
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }

  a.error = null;
  sv.status = 'loading'; sv.error = null;
  render();

  const params = new URLSearchParams({ customer_id: customerId || '' });
  fetch(`/api/google-ads/ai-max-served?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.simulated = !!data.simulated;
      state.iamax.currency = data.currency || '';
      sv.rows = engine.crossReferenceAiMaxServed(data.rows || [], data.negatives || []);
      sv.negatives = data.negatives || [];
      sv.campaignFilter = 'all';
      sv.status = 'ready';
      render();
    })
    .catch((err) => {
      a.error = err.message || String(err);
      sv.status = 'idle';
      render();
    });
}

function getIaMaxServedFiltered() {
  const sv = state.iamax.served;
  const rows = sv.rows || [];
  if (sv.campaignFilter === 'all') return rows;
  return rows.filter((r) => r.campaign_name === sv.campaignFilter);
}

function loadIaMaxMccGroups() {
  const m = state.iamax.api.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => { m.status = 'error'; m.error = err.message || String(err); render(); });
}

function applyIaMaxMccFilter(groupId, groupName) {
  const a = state.iamax.api;
  const m = a.mcc;
  m.selectedId = groupId; m.selectedName = groupName;
  m.accountIdsStatus = 'loading'; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(groupId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.accountIds = new Set((data.accounts || []).map((acc) => acc.id));
      m.accountIdsStatus = 'ready';
      if (a.accountId && !m.accountIds.has(a.accountId)) a.accountId = '';
      render();
    })
    .catch((err) => { m.accountIdsStatus = 'error'; m.error = err.message || String(err); render(); });
}

function clearIaMaxMccFilter() {
  const m = state.iamax.api.mcc;
  m.selectedId = ''; m.selectedName = ''; m.accountIds = null; m.accountIdsStatus = 'idle'; m.filter = '';
  render();
}

function renderIaMaxMccFilterPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.iamax.api.mcc;

  if (m.selectedId) {
    const countLabel = m.accountIdsStatus === 'loading' ? 'cargando…'
      : m.accountIdsStatus === 'ready' ? `${m.accountIds.size} cuenta(s)`
      : 'error';
    return `
      <div class="field">
        <label>Filtrando por MCC</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="delta-badge neutral">${escapeHtml(m.selectedName)} — ${countLabel}</span>
          <button class="btn-link" data-action="iamax-mcc-clear">Quitar filtro</button>
        </div>
      </div>`;
  }

  if (m.status === 'idle') {
    return `<div class="field"><button class="btn-outline sm" data-action="iamax-mcc-load">Filtrar por MCC (ej. una cadena de hoteles)</button></div>`;
  }
  if (m.status === 'loading') {
    return `<div class="field"><p class="footnote">Cargando agrupaciones del MCC…</p></div>`;
  }
  if (m.status === 'error') {
    return `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  }

  const filter = (m.filter || '').trim().toLowerCase();
  let matches = [];
  if (filter.length >= 2) {
    matches = m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25);
  }
  const matchesHtml = matches.length
    ? `<div class="table-scroll" style="max-height:200px;margin-top:8px">
        <table><tbody>
          ${matches.map((g) => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
              <td><button class="btn-outline xs" data-iamax-mcc-pick="${escapeHtml(g.id)}" data-iamax-mcc-pick-name="${escapeHtml(g.name)}">Usar</button></td>
            </tr>`).join('')}
        </tbody></table>
      </div>`
    : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');

  return `
    <div class="field">
      <label>Filtrar por MCC</label>
      <input type="text" id="iamax-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:320px" />
      ${matchesHtml}
    </div>`;
}

function renderIaMaxApiPanel() {
  const a = state.iamax.api;

  if (!a.statusChecked) {
    return `<div class="field"><p class="footnote">Consultando la conexión con Google Ads…</p></div>`;
  }

  const simulatedNotice = a.simulated ? `
    <div class="ok-panel" style="margin:10px 0">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor
      (falta la aprobación del developer token de Google) — estos son datos de ejemplo, no de una cuenta real.
    </div>` : '';

  if (a.accountsStatus === 'idle') {
    return `
      <div class="card control-panel align-end">
        <div class="field">
          <p class="footnote">${a.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.'}</p>
          <button class="btn-outline" data-action="iamax-api-load-accounts">Ver cuentas disponibles</button>
        </div>
      </div>`;
  }
  if (a.accountsStatus === 'loading') {
    return `<div class="card control-panel align-end"><div class="field"><p class="footnote">Cargando cuentas…</p></div></div>`;
  }
  if (a.accountsStatus === 'error') {
    return `<div class="error-panel"><strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(a.error)}</div>`;
  }

  const mccFilterActive = a.mcc.selectedId && a.mcc.accountIds;
  const visibleAccounts = mccFilterActive ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
  const accountOptions = ['<option value="">Elige una cuenta…</option>']
    .concat(visibleAccounts.map((acc) => `<option value="${escapeHtml(acc.id)}" ${a.accountId === acc.id ? 'selected' : ''}>${escapeHtml(acc.name)} (${escapeHtml(acc.id)})</option>`))
    .join('');

  return `
    <div class="card control-panel align-end">
      ${simulatedNotice}
      ${renderIaMaxMccFilterPanel()}
      <div class="field">
        <label>Cuenta${mccFilterActive ? ` (${visibleAccounts.length} en "${escapeHtml(a.mcc.selectedName)}")` : ''}</label>
        <select id="iamax-api-account" style="width:320px">${accountOptions}</select>
      </div>
      <div class="field">
        <label>...o escribe el ID de la cuenta</label>
        <input type="text" id="iamax-api-account-manual" value="${escapeHtml(a.accountIdManual)}" placeholder="ej. 6862893390" style="width:160px" />
      </div>
      <div class="field">
        <label style="display:flex;align-items:center;gap:8px;font-weight:400">
          <input type="checkbox" id="iamax-api-only-active" ${a.onlyActive ? 'checked' : ''} />
          Solo campañas activas
        </label>
      </div>
      <button class="btn-accent" data-action="iamax-api-fetch">Traer datos de IA Max</button>
      ${a.error ? `<div class="error-panel" style="margin-top:10px"><strong>No se pudo traer los datos.</strong> ${escapeHtml(a.error)}</div>` : ''}
    </div>`;
}

function renderIaMaxToggleCell(row) {
  const s = state.iamax;
  const t = s.toggle;
  const isEditing = t.campaignId === row.campaign_id;

  if (!isEditing) {
    const label = row.enabled ? 'Apagar' : 'Prender';
    return `<button class="btn-outline sm" data-action="iamax-toggle-start" data-campaign="${escapeHtml(row.campaign_id)}" data-enable="${row.enabled ? '0' : '1'}">${label}</button>`;
  }

  const busy = t.status === 'previewing' || t.status === 'applying';

  if (t.status === 'idle' || t.status === 'error') {
    return `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn-accent sm" data-action="iamax-toggle-preview" ${busy ? 'disabled' : ''}>Vista previa</button>
        <button class="btn-outline sm" data-action="iamax-toggle-cancel">Cancelar</button>
      </div>
      ${t.error ? `<div class="error-panel" style="margin-top:6px;font-size:12px">${escapeHtml(t.error)}</div>` : ''}`;
  }

  if (busy) {
    return `<p class="footnote">${t.status === 'previewing' ? 'Validando con Google Ads (vista previa, no aplica nada todavía)…' : 'Aplicando el cambio en Google Ads…'}</p>`;
  }

  if (t.status === 'preview_ready' && t.preview) {
    return `
      <div class="ok-panel" style="margin:6px 0;padding:10px 12px;font-size:12.5px">
        <strong>Vista previa lista.</strong> Vas a ${t.preview.enable ? 'prender' : 'apagar'} AI Max en "${escapeHtml(t.preview.campaignName)}" — esto cambia de verdad cómo se sirven los anuncios de esta campaña en producción.
        <div style="margin-top:8px;display:flex;gap:8px">
          <button class="btn-accent sm" data-action="iamax-toggle-confirm">Confirmar y aplicar</button>
          <button class="btn-outline sm" data-action="iamax-toggle-cancel">Cancelar</button>
        </div>
      </div>`;
  }

  if (t.status === 'done' && t.result) {
    return `<div class="ok-panel" style="margin:6px 0;padding:8px 12px;font-size:12.5px"><strong>Listo.</strong> AI Max ${t.result.enable ? 'activado' : 'desactivado'}.</div>`;
  }

  return '';
}

function iaMaxAutomationBadge(row, status) {
  if (!row.enabled) return '<span class="footnote">—</span>';
  if (status === 'OPTED_IN') return '<span class="delta-badge warn">Prendido</span>';
  if (status === 'OPTED_OUT') return '<span class="delta-badge neutral">Apagado</span>';
  return '<span class="footnote">N/D</span>';
}

function renderIaMaxEstadoTab() {
  const s = state.iamax;
  if (s.status === 'idle') {
    return `
      <div class="card state-panel idle">
        ${icon('wand-2', 30)}
        <p>Conecta una cuenta de Google Ads para ver qué campañas Search tienen AI Max activo.</p>
      </div>`;
  }
  if (s.status === 'loading') {
    return `<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo estado de AI Max…</p></div>`;
  }
  if (s.status === 'error') {
    return `<div class="error-panel"><strong>No se pudo traer el estado.</strong> ${escapeHtml(s.error)}</div>`;
  }
  const rows = s.rows || [];
  if (!rows.length) {
    return `<div class="ok-panel">No se encontraron campañas Search en esta cuenta.</div>`;
  }
  const rowsHtml = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.campaign_name)}</td>
      <td>${r.enabled ? '<span class="delta-badge good">Activo</span>' : '<span class="delta-badge neutral">Inactivo</span>'}</td>
      <td>${iaMaxAutomationBadge(r, r.text_customization)}</td>
      <td>${iaMaxAutomationBadge(r, r.final_url_expansion)}</td>
      <td>${renderIaMaxToggleCell(r)}</td>
    </tr>`).join('');
  return `
    <div class="card table-panel">
      <div class="table-panel-head"><h3>Campañas Search (${rows.length})</h3></div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Campaña</th><th>AI Max</th><th>Textos automáticos</th><th>Expansión de URL</th><th>Acción</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="footnote" style="margin-top:14px">
        "Textos automáticos" deja que Google cree titulares y descripciones propios; "Expansión de URL" deja que mande el tráfico a páginas de tu sitio distintas a la que pusiste en el anuncio. Los dos vienen apagados por defecto y solo funcionan con AI Max activo; aquí solo se leen (lo que crearon se ve en la pestaña "Qué creó IA Max").<br>
        Prender/apagar AI Max cambia de verdad cómo Google sirve esta campaña en producción — la vista previa (validateOnly) valida el cambio sin aplicarlo, igual que en ROAS.
      </p>
    </div>`;
}

// Etiquetas de segments.search_term_match_source — solo los dos valores que
// puede traer esta consulta (filtrada explícitamente a esos dos en
// google_ads_client.py), pero con respaldo por si Google agrega uno nuevo.
const AI_MAX_MATCH_SOURCE_LABELS = {
  AI_MAX_KEYWORDLESS: 'Sin palabra clave',
  AI_MAX_BROAD_MATCH: 'Concordancia amplia',
};
function aiMaxMatchSourceLabel(raw) {
  return AI_MAX_MATCH_SOURCE_LABELS[raw] || raw;
}

function renderIaMaxServidoTab() {
  const s = state.iamax;
  const sv = s.served;

  if (sv.status === 'idle') {
    return `
      <div class="card state-panel idle">
        ${icon('file-search', 30)}
        <p>Trae qué términos de búsqueda sirvió AI Max de verdad en esta cuenta, con sus métricas — últimos 30 días.</p>
        <button class="btn-accent" data-action="iamax-served-fetch">Traer lo que sirvió AI Max</button>
      </div>`;
  }
  if (sv.status === 'loading') {
    return `<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo términos servidos…</p></div>`;
  }
  if (sv.status === 'error') {
    return `<div class="error-panel"><strong>No se pudo traer el reporte.</strong> ${escapeHtml(sv.error)}</div>`;
  }

  const allRows = sv.rows || [];
  const campaignNames = [...new Set(allRows.map((r) => r.campaign_name))].sort();
  const filterPanel = allRows.length ? `
    <div class="card control-panel align-end" style="margin-bottom:20px">
      <div class="field">
        <label>Ver solo esta campaña</label>
        <select id="iamax-served-campaign-filter" style="width:320px">
          <option value="all" ${sv.campaignFilter === 'all' ? 'selected' : ''}>Todas las campañas</option>
          ${campaignNames.map((c) => `<option value="${escapeHtml(c)}" ${sv.campaignFilter === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
      </div>
      <button class="btn-outline" data-action="iamax-served-fetch">Volver a traer</button>
    </div>` : '';

  const rows = getIaMaxServedFiltered();
  if (!rows.length) {
    return `${filterPanel}<div class="ok-panel">Ningún término de búsqueda con origen AI Max en los últimos 30 días para esta cuenta (o esta campaña). Si acabas de activarlo, puede que todavía no haya suficiente tráfico servido.</div>`;
  }
  const rowsHtml = rows.map((r) => `
    <tr class="${r.conflict ? 'row-flag' : ''}">
      <td>${escapeHtml(r.campaign_name)}</td>
      <td>${escapeHtml(r.ad_group_name)}</td>
      <td>${escapeHtml(r.search_term)}</td>
      <td>${escapeHtml(aiMaxMatchSourceLabel(r.match_source))}</td>
      <td>${fmtInt(r.impressions)}</td>
      <td>${fmtInt(r.clicks)}</td>
      <td>${fmtMoney(r.cost)}</td>
      <td>${fmtInt(r.conversions)}</td>
    </tr>`).join('');

  return `
    ${filterPanel}
    <div class="card table-panel">
      <div class="table-panel-head"><h3>Términos servidos por AI Max, últimos 30 días (${rows.length})</h3></div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Campaña</th><th>Grupo de anuncios</th><th>Término de búsqueda</th><th>Origen</th><th>Impr.</th><th>Clics</th><th>Costo</th><th>Conv.</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="footnote" style="margin-top:14px">
        "Sin palabra clave" = AI Max encontró la búsqueda sin que existiera una keyword para ella; "Concordancia amplia" = la amplió a partir de una keyword existente. Las filas resaltadas ya aparecen también en la pestaña "Cruce con negativos".
      </p>
    </div>`;
}

function fetchIaMaxCreated() {
  const s = state.iamax;
  const a = s.api;
  const cr = s.created;
  const customerId = iaMaxCustomerId();
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }

  a.error = null;
  cr.status = 'loading'; cr.error = null;
  render();

  const params = new URLSearchParams({ customer_id: customerId || '', days: String(cr.days) });
  fetch(`/api/google-ads/ai-max-created?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.simulated = !!data.simulated;
      state.iamax.currency = data.currency || '';
      cr.data = data;
      cr.campaignFilter = 'all';
      cr.status = 'ready';
      render();
    })
    .catch((err) => {
      cr.error = err.message || String(err);
      cr.status = 'error';
      render();
    });
}

// Filas de la tabla activa de "Qué creó IA Max", ya filtradas por campaña.
function getIaMaxCreatedRows() {
  const cr = state.iamax.created;
  const data = cr.data || {};
  const rows = (cr.sub === 'assets' ? data.assets : cr.sub === 'combinations' ? data.combinations : data.pages) || [];
  const filtered = cr.campaignFilter === 'all' ? rows : rows.filter((r) => r.campaign_name === cr.campaignFilter);
  const sort = cr.sort[cr.sub];
  if (!sort) return filtered;
  const dir = sort.dir === 'asc' ? 1 : -1;
  const value = (r) => {
    if (sort.key === 'cpa') return r.conversions ? r.cost / r.conversions : null; // sin conversiones: siempre al final
    if (sort.key === 'field_type') return AI_MAX_FIELD_TYPE_LABELS[r.field_type] || r.field_type || '';
    return r[sort.key];
  };
  return [...filtered].sort((a, b) => {
    const va = value(a); const vb = value(b);
    if (va === null || va === undefined) return (vb === null || vb === undefined) ? 0 : 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === 'string' || typeof vb === 'string') return dir * String(va).localeCompare(String(vb), 'es', { numeric: true, sensitivity: 'base' });
    return dir * (va - vb);
  });
}

const IAMAX_TEXT_SORT_KEYS = new Set(['campaign_name', 'field_type', 'text', 'search_term', 'headline', 'landing_page', 'page']);
// Encabezado ordenable: ▲ de menor a mayor, ▼ de mayor a menor; ↕ en las columnas que todavía no se usan.
function iaMaxSortTh(label, key) {
  const cur = state.iamax.created.sort[state.iamax.created.sub];
  const active = cur && cur.key === key;
  const arrow = active ? (cur.dir === 'asc' ? ' ▲' : ' ▼') : ' <span style="opacity:.35">↕</span>';
  return `<th data-iamax-sort="${key}" style="cursor:pointer;user-select:none${active ? ';color:var(--color-text-heading)' : ''}" title="Ordenar por ${escapeHtml(label)}">${escapeHtml(label)}${arrow}</th>`;
}

const AI_MAX_FIELD_TYPE_LABELS = {
  HEADLINE: 'Titular', DESCRIPTION: 'Descripción', SITELINK: 'Enlace de sitio', CALLOUT: 'Texto destacado',
  STRUCTURED_SNIPPET: 'Fragmento', LONG_HEADLINE: 'Titular largo', BUSINESS_NAME: 'Nombre del negocio',
  MARKETING_IMAGE: 'Imagen', SQUARE_MARKETING_IMAGE: 'Imagen cuadrada',
};

function downloadIaMaxCreatedCsv() {
  const cr = state.iamax.created;
  const rows = getIaMaxCreatedRows();
  const money = (n) => Number(n || 0).toFixed(2);
  const metrics = (r) => [r.impressions, r.clicks, money(r.cost), Number(r.conversions || 0).toFixed(1)];
  let header; let body; let name;
  if (cr.sub === 'assets') {
    name = 'ia_max_recursos_creados';
    header = ['Campaña', 'Tipo', 'Texto', 'Etiqueta de rendimiento', 'Impresiones', 'Clics', 'Costo', 'Conversiones'];
    body = rows.map((r) => [r.campaign_name, AI_MAX_FIELD_TYPE_LABELS[r.field_type] || r.field_type, r.text || `(${r.asset_type})`, r.performance_label, ...metrics(r)]);
  } else if (cr.sub === 'combinations') {
    name = 'ia_max_combinaciones';
    header = ['Campaña', 'Término de búsqueda', 'Página', 'Titular que usó IA Max', 'Impresiones', 'Clics', 'Costo', 'Conversiones'];
    body = rows.map((r) => [r.campaign_name, r.search_term, r.landing_page, r.headline, ...metrics(r)]);
  } else {
    name = 'ia_max_paginas';
    header = ['Campaña', 'Página', 'Impresiones', 'Clics', 'Costo', 'Conversiones'];
    body = rows.map((r) => [r.campaign_name, r.page, ...metrics(r)]);
  }
  engine.downloadCsv(`${name}_${cr.data.days || 30}d_${new Date().toISOString().slice(0, 10)}.csv`, [header, ...body]);
}

function renderIaMaxCreadoTab() {
  const s = state.iamax;
  const cr = s.created;

  if (cr.status === 'idle') {
    return `
      <div class="card state-panel idle">
        ${icon('sparkles', 30)}
        <p>Trae lo que Google creó por su cuenta con AI Max y cómo le fue: los titulares y recursos automáticos, qué titular y qué página usó para cada búsqueda, y a qué páginas de tu sitio mandó el tráfico.</p>
        <button class="btn-accent" data-action="iamax-created-fetch">Traer lo que creó IA Max</button>
      </div>`;
  }
  if (cr.status === 'loading') {
    return `<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo lo que creó IA Max (puede tardar unos segundos)…</p></div>`;
  }
  if (cr.status === 'error') {
    return `<div class="error-panel"><strong>No se pudo traer el reporte.</strong> ${escapeHtml(cr.error)}</div>`;
  }

  const data = cr.data || {};
  const campaigns = [...new Set([...(data.assets || []), ...(data.combinations || []), ...(data.pages || [])].map((r) => r.campaign_name))].sort();
  const errs = Object.entries(data.errors || {});
  const errorsHtml = errs.length ? `<div class="error-panel" style="margin-bottom:14px"><strong>Una parte del reporte no se pudo traer:</strong> ${errs.map(([k, v]) => `${({ assets: 'recursos creados', combinations: 'combinaciones', pages: 'páginas' })[k] || k} (${escapeHtml(v)})`).join('; ')}.</div>` : '';

  const controls = `
    <div class="card control-panel align-end" style="margin-bottom:20px">
      <div class="field">
        <label>Periodo</label>
        <select id="iamax-created-days" style="width:160px">
          ${[7, 14, 30].map((d) => `<option value="${d}" ${cr.days === d ? 'selected' : ''}>Últimos ${d} días</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Ver solo esta campaña</label>
        <select id="iamax-created-campaign" style="width:320px">
          <option value="all" ${cr.campaignFilter === 'all' ? 'selected' : ''}>Todas las campañas</option>
          ${campaigns.map((c) => `<option value="${escapeHtml(c)}" ${cr.campaignFilter === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
      </div>
      <button class="btn-outline" data-action="iamax-created-fetch">Volver a traer</button>
    </div>`;

  const counts = {
    assets: (data.assets || []).length,
    combinations: data.combinations_total || (data.combinations || []).length,
    pages: data.pages_total || (data.pages || []).length,
  };
  const subTabs = `
    <div class="seg-control" style="margin-bottom:16px">
      <button class="seg-btn ${cr.sub === 'assets' ? 'active' : ''}" data-action="iamax-created-sub-assets">Recursos creados (${counts.assets})</button>
      <button class="seg-btn ${cr.sub === 'combinations' ? 'active' : ''}" data-action="iamax-created-sub-combinations">Búsqueda + titular + página (${counts.combinations})</button>
      <button class="seg-btn ${cr.sub === 'pages' ? 'active' : ''}" data-action="iamax-created-sub-pages">Páginas a las que mandó tráfico (${counts.pages})</button>
    </div>`;

  const rows = getIaMaxCreatedRows();
  const flag = (r) => (r.cost > 0 && !r.conversions ? 'row-warn' : '');
  const cpa = (r) => (r.conversions ? fmtMoney(r.cost / r.conversions) : 'N/D');
  const metricCells = (r) => `<td>${fmtInt(r.impressions)}</td><td>${fmtInt(r.clicks)}</td><td>${fmtMoney(r.cost)}</td><td>${Number(r.conversions || 0).toFixed(1)}</td><td>${cpa(r)}</td>`;
  const metricHead = [['Impr.', 'impressions'], ['Clics', 'clicks'], ['Costo', 'cost'], ['Conv.', 'conversions'], ['Costo/conv', 'cpa']].map(([l, k]) => iaMaxSortTh(l, k)).join('');
  const urlCell = (u) => (u ? `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(u)}">${escapeHtml(u.replace(/^https?:\/\//, '').slice(0, 70))}</a>` : '—');

  let table = ''; let note = '';
  if (cr.sub === 'assets') {
    table = `<thead><tr>${iaMaxSortTh('Campaña', 'campaign_name')}${iaMaxSortTh('Tipo', 'field_type')}${iaMaxSortTh('Texto creado por Google', 'text')}${metricHead}</tr></thead>
      <tbody>${rows.map((r) => `<tr class="${flag(r)}"><td>${escapeHtml(r.campaign_name)}</td><td>${escapeHtml(AI_MAX_FIELD_TYPE_LABELS[r.field_type] || r.field_type)}</td><td>${escapeHtml(r.text || `(${r.asset_type})`)}</td>${metricCells(r)}</tr>`).join('')}</tbody>`;
    note = 'Son los recursos que Google creó por su cuenta (textos automáticos). Google no da una etiqueta de rendimiento para ellos; el rendimiento es el de los anuncios donde se mostraron. No se pueden crear ni editar desde la API, solo se pueden pausar o quitar en Google Ads. Suelen ser pocos: es normal ver 1 o 2.';
  } else if (cr.sub === 'combinations') {
    table = `<thead><tr>${iaMaxSortTh('Campaña', 'campaign_name')}${iaMaxSortTh('Búsqueda', 'search_term')}${iaMaxSortTh('Titular que usó IA Max', 'headline')}${iaMaxSortTh('Página', 'landing_page')}${metricHead}</tr></thead>
      <tbody>${rows.map((r) => `<tr class="${flag(r)}"><td>${escapeHtml(r.campaign_name)}</td><td>${escapeHtml(r.search_term)}</td><td>${escapeHtml(r.headline)}</td><td>${urlCell(r.landing_page)}</td>${metricCells(r)}</tr>`).join('')}</tbody>`;
    note = `Para cada búsqueda, el titular dinámico y la página que armó AI Max. Ordenado por costo${counts.combinations > (data.combinations || []).length ? `; se muestran ${(data.combinations || []).length} de ${counts.combinations} combinaciones` : ''}.`;
  } else {
    table = `<thead><tr><th style="width:34px"></th>${iaMaxSortTh('Campaña', 'campaign_name')}${iaMaxSortTh('Página', 'page')}${metricHead}</tr></thead>
      <tbody>${rows.map((r) => { const key = `${r.campaign_id}|${r.page}`; return `<tr class="${flag(r)}"><td><input type="checkbox" data-iamax-page-check="${escapeHtml(key)}" ${cr.selected[key] ? 'checked' : ''} aria-label="Marcar para excluir" /></td><td>${escapeHtml(r.campaign_name)}</td><td>${urlCell(r.page)}</td>${metricCells(r)}</tr>`; }).join('')}</tbody>`;
    note = `A qué páginas mandó el tráfico la expansión de URL. Se agrupa por página (sin los parámetros de seguimiento). Ordenado por costo${counts.pages > (data.pages || []).length ? `; se muestran ${(data.pages || []).length} de ${counts.pages}` : ''}. Si ves páginas que no son para reservar (fotos, contacto, políticas), la expansión de URL se está llevando tráfico que no convierte.`;
  }

  const empty = !rows.length;
  return `
    ${errorsHtml}${controls}${subTabs}
    ${empty ? `<div class="ok-panel">No hay datos de este reporte en los últimos ${cr.days} días para ${cr.campaignFilter === 'all' ? 'esta cuenta' : 'esta campaña'}. Si AI Max se activó hace poco, puede que todavía no haya suficiente tráfico, o que la campaña no tenga activados los textos automáticos o la expansión de URL.</div>` : `
    <div class="card table-panel">
      <div class="table-panel-head">
        <h3>${({ assets: 'Recursos creados por Google', combinations: 'Búsqueda + titular + página', pages: 'Páginas a las que mandó tráfico' })[cr.sub]}, últimos ${cr.days} días (${rows.length})</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${cr.sub === 'pages' ? `<button class="btn-accent sm" id="iamax-pages-exclude-btn" data-action="iamax-pages-exclude" ${Object.keys(cr.selected).length ? '' : 'disabled'}>Excluir las seleccionadas (${Object.keys(cr.selected).length})</button>` : ''}
          <button class="btn-outline sm" data-action="iamax-created-csv">Descargar CSV</button>
        </div>
      </div>
      <p class="footnote" style="margin:0 0 12px"><span class="legend-swatch-warn"></span><strong>Fila en ámbar:</strong> gastó dinero sin generar conversiones en el periodo${rows.some((r) => r.cost > 0 && !r.conversions) ? ` (${rows.filter((r) => r.cost > 0 && !r.conversions).length} de ${rows.length})` : ' (ninguna en esta vista)'}. Es una señal para revisar, no un error: con pocos clics todavía puede no haber conversiones.</p>
      <div class="table-scroll"><table>${table}</table></div>
      <p class="footnote" style="margin-top:14px">${note}</p>
    </div>`}`;
}

function resetIaMaxUrlxFlow() {
  state.iamax.urlx.flow = { status: 'idle', preview: null, result: null, error: null, invalid: null };
}

function openIaMaxExcluirTab() {
  state.iamax.tab = 'excluir';
  if (state.iamax.urlx.status === 'idle') loadIaMaxUrlExclusions(); else render();
}

function loadIaMaxUrlExclusions() {
  const s = state.iamax;
  const a = s.api;
  const ux = s.urlx;
  const customerId = iaMaxCustomerId();
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }
  a.error = null;
  ux.status = 'loading'; ux.error = null;
  render();
  fetch(`/api/google-ads/ai-max-url-exclusions?customer_id=${encodeURIComponent(customerId || '')}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.simulated = !!data.simulated;
      ux.rows = data.rows || [];
      ux.campaigns = data.campaigns || [];
      if (!ux.pasteCampaign || !ux.campaigns.some((c) => c.campaign_id === ux.pasteCampaign && c.eligible)) {
        const first = ux.campaigns.find((c) => c.eligible);
        ux.pasteCampaign = first ? first.campaign_id : '';
      }
      ux.status = 'ready';
      render();
    })
    .catch((err) => { ux.error = err.message || String(err); ux.status = 'error'; render(); });
}

function addIaMaxDraftItems(items) {
  const ux = state.iamax.urlx;
  let added = 0;
  items.forEach((it) => {
    if (!ux.draft.some((d) => d.campaign_id === it.campaign_id && d.mode === it.mode && d.value === it.value)) { ux.draft.push(it); added += 1; }
  });
  resetIaMaxUrlxFlow();
  return added;
}

function addIaMaxPasteToDraft() {
  const ux = state.iamax.urlx;
  const campaign = (ux.campaigns || []).find((c) => c.campaign_id === ux.pasteCampaign);
  if (!campaign) { ux.pasteNote = 'Elige primero la campaña donde aplicar.'; render(); return; }
  const lines = ux.pasteText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) { ux.pasteNote = 'Pega al menos una página.'; render(); return; }
  const added = addIaMaxDraftItems(lines.map((value) => ({
    campaign_id: campaign.campaign_id, campaign_name: campaign.campaign_name,
    mode: /^https?:\/\//i.test(value) ? 'equals' : 'contains', value,
  })));
  ux.pasteText = '';
  ux.pasteNote = `Se agregaron ${added} página${added === 1 ? '' : 's'} a la lista${added < lines.length ? ` (${lines.length - added} ya estaban)` : ''}.`;
  render();
}

// Archivo con direcciones: .txt/.csv (una por línea, o primera columna) o Excel (primera columna). Se pasan al cuadro de texto para revisarlas.
function loadIaMaxUrlxFile(file) {
  const ux = state.iamax.urlx;
  const done = (values) => {
    const header = /^(url|urls|pagina|página|paginas|páginas|page|pages|direccion|dirección|enlace|link)$/i;
    const clean = values.map((v) => String(v == null ? '' : v).trim()).filter((v) => v && !header.test(v));
    ux.pasteText = [ux.pasteText.trim(), ...clean].filter(Boolean).join('\n');
    ux.pasteNote = `Se leyeron ${clean.length} línea${clean.length === 1 ? '' : 's'} del archivo "${file.name}". Revísalas y pulsa "Agregar a la lista".`;
    render();
  };
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    file.arrayBuffer().then((buf) => {
      const wb = XLSX.read(buf, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
      done(rows.map((r) => (r || [])[0]));
    }).catch(() => { ux.pasteNote = 'No se pudo leer el archivo de Excel.'; render(); });
  } else {
    file.text().then((text) => done(text.split(/\r?\n/).map((l) => l.split(',')[0].replace(/^"|"$/g, '')))).catch(() => { ux.pasteNote = 'No se pudo leer el archivo.'; render(); });
  }
}

function sendSelectedPagesToExclude() {
  const s = state.iamax;
  const picked = Object.values(s.created.selected);
  if (!picked.length) return;
  addIaMaxDraftItems(picked.map((p) => ({ campaign_id: p.campaign_id, campaign_name: p.campaign_name, mode: 'equals', value: p.page })));
  s.created.selected = {};
  openIaMaxExcluirTab();
}

function submitIaMaxUrlExclusions(validateOnly) {
  const s = state.iamax;
  const ux = s.urlx;
  const a = s.api;
  const customerId = iaMaxCustomerId();
  if (!ux.draft.length) return;
  ux.flow = { status: validateOnly ? 'previewing' : 'applying', preview: ux.flow.preview, result: null, error: null, invalid: null };
  render();
  fetch('/api/google-ads/ai-max-url-exclusions/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId || '', validate_only: validateOnly, items: ux.draft }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) { ux.flow = { status: 'error', preview: null, result: null, error: data.error || 'Error desconocido.', invalid: data.invalid || null }; render(); return; }
      a.simulated = !!data.simulated;
      if (validateOnly) { ux.flow = { status: 'preview_ready', preview: data, result: null, error: null, invalid: null }; render(); return; }
      ux.flow = { status: 'done', preview: null, result: data, error: null, invalid: null };
      ux.draft = [];
      loadIaMaxUrlExclusions();
    })
    .catch((err) => { ux.flow = { status: 'error', preview: null, result: null, error: err.message || String(err), invalid: null }; render(); });
}

function confirmIaMaxUrlxRemove() {
  const s = state.iamax;
  const ux = s.urlx;
  const customerId = iaMaxCustomerId();
  const rn = ux.remove.pending;
  if (!rn) return;
  ux.remove = { pending: rn, status: 'removing', error: null };
  render();
  fetch('/api/google-ads/ai-max-url-exclusions/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId || '', validate_only: false, resource_names: [rn] }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok || (data.failed && data.failed.length)) throw new Error((data.failed && data.failed[0]) || data.error || 'Error desconocido.');
      ux.remove = { pending: null, status: 'idle', error: null };
      loadIaMaxUrlExclusions();
    })
    .catch((err) => { ux.remove = { pending: rn, status: 'error', error: err.message || String(err) }; render(); });
}

const URLX_MODE_LABELS = { equals: 'Página exacta', contains: 'URL contiene', other: 'Otra regla' };

function renderIaMaxExcluirTab() {
  const s = state.iamax;
  const ux = s.urlx;
  const e = escapeHtml;

  if (ux.status === 'loading' || ux.status === 'idle') {
    return `<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo las exclusiones de página de la cuenta…</p></div>`;
  }
  if (ux.status === 'error') {
    return `<div class="error-panel"><strong>No se pudieron traer las exclusiones.</strong> ${e(ux.error)}</div>
      <button class="btn-outline" data-action="iamax-urlx-reload" style="margin-top:10px">Reintentar</button>`;
  }

  const eligible = (ux.campaigns || []).filter((c) => c.eligible);
  const notEligible = (ux.campaigns || []).filter((c) => !c.eligible);
  const flow = ux.flow;
  const busy = flow.status === 'previewing' || flow.status === 'applying';

  const intro = `
    <div class="card" style="padding:18px 22px;margin-bottom:18px">
      <h3 class="section-title" style="margin:0 0 8px">Excluir páginas que AI Max no debe usar</h3>
      <p class="footnote" style="margin:0">Con la expansión de URL, Google puede mandar el tráfico a otras páginas de tu sitio. Aquí marcas las que no quieres (fotos, contacto, políticas…) y se envían a Google Ads como <strong>exclusión de página</strong> de esa campaña. Antes de aplicar hay siempre una <strong>vista previa</strong> que Google valida sin escribir nada.
      Solo funciona en campañas con AI Max, textos automáticos y expansión de URL prendidos. Google <strong>no deja excluir la página de destino del anuncio</strong>, y puede tardar unas horas en aplicarse. Una exclusión no se edita: se quita y se vuelve a crear.</p>
    </div>`;

  const eligibilityNote = !eligible.length
    ? `<div class="error-panel" style="margin-bottom:18px"><strong>Ninguna campaña de esta cuenta acepta exclusiones de página todavía.</strong> ${notEligible.length ? notEligible.slice(0, 5).map((c) => `${e(c.campaign_name)}: ${e(c.reason)}`).join('; ') + (notEligible.length > 5 ? '…' : '') : 'No hay campañas Search activas.'} Prende AI Max, los textos automáticos y la expansión de URL en Google Ads para poder usarlas.</div>`
    : '';

  const addPanel = `
    <div class="card control-panel align-end" style="flex-wrap:wrap;gap:14px 20px;margin-bottom:18px">
      <div class="field">
        <label>Campaña donde aplicar</label>
        <select id="iamax-urlx-campaign" style="width:340px" ${eligible.length ? '' : 'disabled'}>
          ${eligible.map((c) => `<option value="${e(c.campaign_id)}" ${ux.pasteCampaign === c.campaign_id ? 'selected' : ''}>${e(c.campaign_name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Páginas (una por línea)</label>
        <textarea id="iamax-urlx-paste" rows="4" style="width:420px" placeholder="https://www.mihotel.com/es/fotos/&#10;/contacto/&#10;politica-de-cookies" ${eligible.length ? '' : 'disabled'}>${e(ux.pasteText)}</textarea>
        <span class="field-hint">Con http:// o https:// se excluye esa página exacta. Sin dirección completa se excluye todo lo que <em>contenga</em> ese texto (por ejemplo /fotos/). Puedes cambiarlo en cada fila.</span>
      </div>
      <div class="field">
        <label>…o sube un archivo (txt, csv o Excel)</label>
        <input type="file" id="iamax-urlx-file" accept=".txt,.csv,.xlsx,.xls" ${eligible.length ? '' : 'disabled'} />
      </div>
      <button class="btn-accent" data-action="iamax-urlx-add-paste" ${eligible.length ? '' : 'disabled'}>Agregar a la lista</button>
      ${ux.pasteNote ? `<p class="footnote" style="width:100%;margin:0">${e(ux.pasteNote)}</p>` : ''}
    </div>`;

  let draftPanel = '';
  if (ux.draft.length) {
    const rowsHtml = ux.draft.map((d, i) => `
      <tr>
        <td>${e(d.campaign_name)}</td>
        <td><select data-iamax-draft-mode="${i}" ${busy ? 'disabled' : ''}>
          <option value="equals" ${d.mode === 'equals' ? 'selected' : ''}>Página exacta</option>
          <option value="contains" ${d.mode === 'contains' ? 'selected' : ''}>URL contiene</option>
        </select></td>
        <td style="word-break:break-all">${e(d.value)}</td>
        <td><button class="btn-link" data-iamax-draft-remove="${i}" ${busy ? 'disabled' : ''}>Quitar de la lista</button></td>
      </tr>`).join('');

    let flowHtml = '';
    if (flow.status === 'error') {
      flowHtml = `<div class="error-panel" style="margin-top:14px"><strong>No se pudo continuar.</strong> ${e(flow.error)}${(flow.invalid || []).length ? `<ul style="margin:8px 0 0 18px">${flow.invalid.map((x) => `<li><code>${e(x.value)}</code>: ${e(x.error)}</li>`).join('')}</ul>` : ''}</div>`;
    } else if (flow.status === 'preview_ready' && flow.preview) {
      const pv = flow.preview;
      flowHtml = `
        <div class="ok-panel" style="margin-top:14px">
          <strong>Vista previa validada por Google, sin cambios en la cuenta${pv.simulated ? ' (modo simulado)' : ''}:</strong>
          se crearían <strong>${pv.created}</strong> ${pv.created === 1 ? 'exclusión' : 'exclusiones'}${(pv.skipped_duplicates || []).length ? `; ${pv.skipped_duplicates.length} ya existía${pv.skipped_duplicates.length === 1 ? '' : 'n'} y se omiten` : ''}${(pv.failed || []).length ? `; <strong>${pv.failed.length} con problema</strong>` : ''}.
          ${(pv.failed || []).length ? `<ul style="margin:8px 0 0 18px">${pv.failed.map((f) => `<li>${e(f)}</li>`).join('')}</ul>` : ''}
          <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn-accent" data-action="iamax-urlx-apply">Confirmar y aplicar en Google Ads</button>
            <button class="btn-outline" data-action="iamax-urlx-flow-reset">Cancelar</button>
          </div>
          <p class="footnote" style="margin:8px 0 0">Aplicar escribe de verdad en la cuenta: AI Max dejará de mandar tráfico a esas páginas desde esa campaña.</p>
        </div>`;
    } else if (flow.status === 'previewing' || flow.status === 'applying') {
      flowHtml = `<div class="card state-panel loading" style="margin-top:14px"><div class="spinner"></div><p>${flow.status === 'previewing' ? 'Pidiéndole a Google que valide la lista…' : 'Aplicando las exclusiones en Google Ads…'}</p></div>`;
    }

    draftPanel = `
      <div class="card table-panel" style="margin-bottom:18px">
        <div class="table-panel-head"><h3>Lista para excluir (${ux.draft.length})</h3>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn-accent sm" data-action="iamax-urlx-preview" ${busy ? 'disabled' : ''}>Vista previa</button>
            <button class="btn-outline sm" data-action="iamax-urlx-clear-draft" ${busy ? 'disabled' : ''}>Vaciar lista</button>
          </div>
        </div>
        <div class="table-scroll"><table>
          <thead><tr><th>Campaña</th><th>Tipo</th><th>Página o texto</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table></div>
        ${flowHtml}
      </div>`;
  } else if (flow.status === 'done' && flow.result) {
    const r = flow.result;
    draftPanel = `<div class="ok-panel" style="margin-bottom:18px"><strong>Listo: se aplicaron ${r.created} ${r.created === 1 ? 'exclusión' : 'exclusiones'} en Google Ads${r.simulated ? ' (modo simulado)' : ''}.</strong>${(r.skipped_duplicates || []).length ? ` ${r.skipped_duplicates.length} ya existía${r.skipped_duplicates.length === 1 ? '' : 'n'}.` : ''}${(r.failed || []).length ? `<ul style="margin:8px 0 0 18px">${r.failed.map((f) => `<li>${e(f)}</li>`).join('')}</ul>` : ''} Pueden tardar unas horas en notarse; abajo aparecen en la lista de exclusiones de la cuenta.</div>`;
  }

  const existing = ux.rows || [];
  const rm = ux.remove;
  const existingRows = existing.map((r) => {
    const pending = rm.pending === r.resource_name;
    return `<tr>
      <td>${e(r.campaign_name)}</td>
      <td>${e(URLX_MODE_LABELS[r.mode] || r.mode)}</td>
      <td style="word-break:break-all">${e(r.value || r.name)}</td>
      <td>${pending
        ? (rm.status === 'removing'
            ? '<span class="footnote">Quitando…</span>'
            : `<button class="btn-accent xs" data-action="iamax-urlx-remove-confirm">Confirmar: quitar</button> <button class="btn-link" data-action="iamax-urlx-remove-cancel">Cancelar</button>${rm.error ? `<div class="footnote" style="color:var(--danger)">${e(rm.error)}</div>` : ''}`)
        : `<button class="btn-outline xs" data-iamax-urlx-remove="${e(r.resource_name)}">Quitar</button>`}</td>
    </tr>`;
  }).join('');
  const existingPanel = `
    <div class="card table-panel">
      <div class="table-panel-head"><h3>Exclusiones de página que ya tiene la cuenta (${existing.length})</h3>
        <button class="btn-outline sm" data-action="iamax-urlx-reload">Actualizar</button></div>
      ${existing.length ? `<div class="table-scroll"><table>
        <thead><tr><th>Campaña</th><th>Tipo</th><th>Página o texto</th><th></th></tr></thead>
        <tbody>${existingRows}</tbody></table></div>` : '<p class="footnote" style="margin:0">Esta cuenta todavía no tiene exclusiones de página.</p>'}
      <p class="footnote" style="margin-top:14px">Incluye todas las reglas de página negativas de la cuenta, también las que se crearon en Google Ads o con otras herramientas. Quitar una exclusión escribe en la cuenta y deja que AI Max vuelva a usar esa página.</p>
    </div>`;

  return `${intro}${eligibilityNote}${addPanel}${draftPanel}${existingPanel}`;
}

function renderIaMaxCruceTab() {
  const s = state.iamax;
  const sv = s.served;

  if (sv.status === 'idle') {
    return `
      <div class="card state-panel idle">
        ${icon('shield-alert', 30)}
        <p>Trae primero lo que sirvió AI Max (pestaña anterior) — acá se cruza contra los negativos que ya están escritos de verdad en la cuenta.</p>
      </div>`;
  }
  if (sv.status === 'loading') {
    return `<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo…</p></div>`;
  }
  if (sv.status === 'error') {
    return `<div class="error-panel"><strong>No se pudo traer el reporte.</strong> ${escapeHtml(sv.error)}</div>`;
  }

  const conflicts = (sv.rows || []).filter((r) => r.conflict);
  if (!conflicts.length) {
    return `<div class="ok-panel">Ningún término servido por AI Max coincide con un negativo ya escrito en la cuenta (${(sv.negatives || []).length} negativos revisados).</div>`;
  }
  const rowsHtml = conflicts.map((r) => `
    <tr>
      <td>${escapeHtml(r.campaign_name)}</td>
      <td>${escapeHtml(r.search_term)}</td>
      <td>${escapeHtml(r.conflict_term)}</td>
    </tr>`).join('');

  return `
    <div class="error-panel" style="margin-bottom:14px">
      <strong>${conflicts.length} término${conflicts.length === 1 ? '' : 's'} servido${conflicts.length === 1 ? '' : 's'} por AI Max choca${conflicts.length === 1 ? '' : 'n'} con un negativo ya escrito en la misma campaña.</strong>
      AI Max amplía la concordancia por su cuenta — puede estar sirviendo búsquedas que el equipo ya decidió evitar en Negativización.
    </div>
    <div class="card table-panel">
      <div class="table-scroll">
        <table>
          <thead><tr><th>Campaña</th><th>Término servido por AI Max</th><th>Negativo que coincide</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="footnote" style="margin-top:14px">
        Coincidencia por texto contenido (heurística simple, no simula los tipos de concordancia de Google) — es una señal para revisar a mano, no una certeza. Para actuar, ve a Negativización o ajusta el negativo directo en Google Ads.
      </p>
    </div>`;
}

function renderIaMaxPage() {
  return withMoneyCurrency(state.iamax.currency, () => renderIaMaxPageBody());
}

function renderIaMaxPageBody() {
  const s = state.iamax;
  ensureIaMaxGoogleAdsStatusLoaded();

  const controlPanel = renderIaMaxApiPanel();
  const conflictCount = (s.served.rows || []).filter((r) => r.conflict).length;

  const tabs = `
    <div class="seg-control" style="margin-bottom:20px">
      <button class="seg-btn ${s.tab === 'estado' ? 'active' : ''}" data-action="iamax-tab-estado">Estado</button>
      <button class="seg-btn ${s.tab === 'servido' ? 'active' : ''}" data-action="iamax-tab-servido">Qué sirvió</button>
      <button class="seg-btn ${s.tab === 'creado' ? 'active' : ''}" data-action="iamax-tab-creado">Qué creó IA Max</button>
      <button class="seg-btn ${s.tab === 'excluir' ? 'active' : ''}" data-action="iamax-tab-excluir">Excluir páginas${s.urlx.draft.length ? ` (${s.urlx.draft.length})` : ''}</button>
      <button class="seg-btn ${s.tab === 'cruce' ? 'active' : ''}" data-action="iamax-tab-cruce">Cruce con negativos${conflictCount ? ` (${conflictCount})` : ''}</button>
    </div>`;

  let body = '';
  if (s.tab === 'estado') body = renderIaMaxEstadoTab();
  else if (s.tab === 'servido') body = renderIaMaxServidoTab();
  else if (s.tab === 'creado') body = renderIaMaxCreadoTab();
  else if (s.tab === 'excluir') body = renderIaMaxExcluirTab();
  else body = renderIaMaxCruceTab();

  return `${controlPanel}${tabs}${body}`;
}

// ---------------------------------------------------------------------------
// Página — Hoteles (modificadores de oferta de campañas de hotel)
//
// Los modificadores (ventana de reserva, estancia, día de entrada, fechas
// elegidas por el usuario) viven por grupo de anuncios; acá se editan POR
// CAMPAÑA: el mismo valor en cada tramo para todos los grupos de la campaña.
// Mismo patrón de escritura que ROAS e IA Max: vista previa validada por
// Google y solo después "Confirmar y aplicar". En las cuentas con plantilla
// externa de modificadores la sección es de solo lectura (el servidor
// también lo rechaza, no depende de esta pantalla).
// ---------------------------------------------------------------------------

const HOTEL_TYPE_ORDER = ['ventana', 'estancia', 'dia', 'fechas_usuario', 'rango_fechas'];
const HOTEL_TYPE_META = {
  ventana: { label: 'Ventana de reserva', help: 'Días entre la búsqueda y la entrada al hotel.', min: 0.1, max: 10, zeroOk: true, editable: true },
  estancia: { label: 'Duración de la estancia', help: 'Noches de la estancia buscada.', min: 0.1, max: 10, zeroOk: true, editable: true },
  dia: { label: 'Día de entrada', help: 'Día de la semana en que empieza la estancia.', min: 0.1, max: 10, zeroOk: true, editable: true },
  fechas_usuario: { label: 'Fechas elegidas por el usuario', help: 'Si quien busca eligió fechas o Google usó unas por defecto.', min: 0.5, max: 2, zeroOk: false, editable: true },
  rango_fechas: { label: 'Rango de fechas de entrada', help: 'Temporadas o fechas concretas. Solo lectura en esta versión.', min: 0.1, max: 10, zeroOk: true, editable: false },
};
const HOTEL_RENDER_LIMIT = 200;
// Interruptor de la sección Hoteles en el menú. false = oculta para todos.
const HOTEL_SECTION_VISIBLE = true;

function hotelMoney(n, currency) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'N/D';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', currencyDisplay: 'code', maximumFractionDigits: 2 }).format(n);
  } catch (err) {
    return n.toFixed(2) + (currency ? ' ' + currency : '');
  }
}

function hotelDefaultDates() {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const to = new Date(); to.setDate(to.getDate() - 1);
  const from = new Date(to); from.setDate(from.getDate() - 29);
  return { from: iso(from), to: iso(to) };
}

function resetHotelAccountData() {
  const s = state.hotel;
  s.list = { status: 'idle', error: null, campaigns: [], currency: '', templateLocked: false, filter: s.list ? s.list.filter : '' };
  s.detail = { status: 'idle', error: null, data: null, campaignId: null, edits: {}, flow: { status: 'idle', preview: null, result: null, error: null } };
}

function hotelRefocus(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.focus();
  const len = el.value.length;
  try { el.setSelectionRange(len, len); } catch (err) { /* algunos tipos de input no lo permiten */ }
}

function fetchHotelCampaigns() {
  const s = state.hotel;
  const a = s.api;
  const customerId = hotelCustomerId();
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }
  if (!a.dateFrom || !a.dateTo) { a.error = 'Elige el rango de fechas.'; render(); return; }
  a.error = null;
  s.list.status = 'loading'; s.list.error = null;
  s.detail = { status: 'idle', error: null, data: null, campaignId: null, edits: {}, flow: { status: 'idle', preview: null, result: null, error: null } };
  render();

  const params = new URLSearchParams({ customer_id: customerId || '', date_from: a.dateFrom, date_to: a.dateTo });
  fetch(`/api/google-ads/hotel-campaigns?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.simulated = !!data.simulated;
      s.list.campaigns = data.campaigns || [];
      s.list.currency = data.currency || '';
      s.list.templateLocked = !!data.template_locked;
      s.list.status = 'ready';
      render();
    })
    .catch((err) => {
      a.error = err.message || String(err);
      s.list.status = 'idle';
      render();
    });
}

// keepFlow=true: se vuelve a leer la campaña después de aplicar, sin borrar el aviso de "Listo".
function openHotelCampaign(campaignId, keepFlow) {
  const s = state.hotel;
  const a = s.api;
  const d = s.detail;
  d.campaignId = campaignId; d.status = 'loading'; d.error = null;
  if (!keepFlow) { d.edits = {}; d.ai = null; d.note = null; d.flow = { status: 'idle', preview: null, result: null, error: null }; }
  render();

  const params = new URLSearchParams({ customer_id: hotelCustomerId() || '', campaign_id: campaignId, date_from: a.dateFrom, date_to: a.dateTo });
  if (!keepFlow || !d.price || d.price.campaignId !== campaignId) loadHotelPrice(campaignId);
  fetch(`/api/google-ads/hotel-modifiers?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      d.data = data; d.status = 'ready';
      if (data.template_locked) s.list.templateLocked = true;
      render();
    })
    .catch((err) => { d.status = 'error'; d.error = err.message || String(err); render(); });
}

// Precio frente a la competencia (solo lectura): se trae aparte de los modificadores para que un fallo
// de esta consulta no impida ver ni editar los tramos.
function loadHotelPrice(campaignId) {
  const s = state.hotel;
  const a = s.api;
  const d = s.detail;
  d.price = { status: 'loading', error: null, data: null, campaignId };
  const params = new URLSearchParams({ customer_id: hotelCustomerId() || '', campaign_id: campaignId, date_from: a.dateFrom, date_to: a.dateTo });
  fetch(`/api/google-ads/hotel-price?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (d.campaignId !== campaignId) return; // el usuario ya abrió otra campaña
      d.price = { status: 'ready', error: null, data, campaignId };
      render();
    })
    .catch((err) => {
      if (d.campaignId !== campaignId) return;
      d.price = { status: 'error', error: err.message || String(err), data: null, campaignId };
      render();
    });
}

function hotelPct(f, digits = 1) {
  if (f === null || f === undefined || Number.isNaN(f)) return 'N/D';
  const v = f * 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)} %`;
}

// Línea diaria de la diferencia de precio, con la línea del 0 % (mismo precio que el competidor más barato).
function hotelPriceChartSvg(daily) {
  const pts = daily.filter((x) => x.price_diff !== null && x.price_diff !== undefined);
  if (pts.length < 2) return '<p class="footnote">Hay muy pocos días con precio comparable para dibujar la evolución.</p>';
  const W = 640; const H = 170; const L = 46; const R = 10; const T = 12; const B = 26;
  const vals = pts.map((x) => x.price_diff * 100);
  let lo = Math.min(0, ...vals); let hi = Math.max(0, ...vals);
  if (hi - lo < 4) { hi += 2; lo -= 2; }
  const x = (i) => L + (i / (pts.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.price_diff * 100).toFixed(1)}`).join(' ');
  const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.price_diff * 100).toFixed(1)}" r="2.6" fill="${p.price_diff > 0 ? 'var(--danger)' : 'var(--ok-text)'}"><title>${escapeHtml(p.date)}: ${hotelPct(p.price_diff)}</title></circle>`).join('');
  const tick = (v) => `<text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--color-text-muted)">${v > 0 ? '+' : ''}${Math.round(v)} %</text>`;
  return `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Diferencia de precio diaria frente a la competencia" style="width:100%;height:auto;max-height:220px">
      <line x1="${L}" x2="${W - R}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="var(--color-border)" stroke-dasharray="4 4" />
      ${Math.abs(y(hi) - y(0)) > 14 ? tick(hi) : ''}${tick(0)}${Math.abs(y(lo) - y(0)) > 14 ? tick(lo) : ''}
      <path d="${line}" fill="none" stroke="var(--navy-700, #14213d)" stroke-width="1.8" />
      ${dots}
      <text x="${L}" y="${H - 6}" font-size="11" fill="var(--color-text-muted)">${escapeHtml(pts[0].date)}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--color-text-muted)">${escapeHtml(pts[pts.length - 1].date)}</text>
    </svg>`;
}

function renderHotelPrice() {
  const pr = state.hotel.detail.price;
  if (!pr) return '';
  const head = (inner) => `
    <div class="card table-panel" style="margin-bottom:16px">
      <div class="table-panel-head"><h3>Precio frente a la competencia</h3><span class="footnote">Lo que Google compara entre tu hotel y los otros anunciantes · solo lectura</span></div>
      ${inner}
    </div>`;
  if (pr.status === 'loading') return head('<div class="state-panel loading" style="padding:12px 0"><div class="spinner"></div><p>Trayendo el precio frente a la competencia…</p></div>');
  if (pr.status === 'error') return head(`<p class="footnote">No se pudo traer esta comparación de precio: ${escapeHtml(pr.error)}</p>`);
  const data = pr.data || {};
  const sm = data.summary;
  if (!sm && !data.buckets && !data.daily) return head('<p class="footnote">Google no entregó la comparación de precio de esta campaña.</p>');
  if (sm && !sm.impressions) return head('<p class="footnote">La campaña no tuvo impresiones en este periodo, así que Google no tiene precios que comparar.</p>');

  let verdict = '';
  if (sm) {
    const diff = sm.price_diff;
    const share = sm.eligible ? Math.min(100, (sm.impressions / sm.eligible) * 100) : null;
    let msg;
    let cls = 'ok-panel';
    if (diff === null || diff === undefined) {
      msg = 'Google no devolvió una diferencia de precio en este periodo.';
      cls = '';
    } else if (diff > 0.05) {
      msg = `<strong>Tu hotel salió en promedio ${hotelPct(diff)} más caro</strong> que el anunciante más barato. Con un precio así, subir la puja no recupera esas reservas: conviene revisar las tarifas que se envían a Google.`;
      cls = 'error-panel';
    } else if (diff > 0.02) {
      msg = `<strong>Tu hotel salió ${hotelPct(diff)} más caro</strong> que el anunciante más barato. Es una diferencia pequeña pero pesa en la comparación de precios.`;
      cls = 'error-panel';
    } else if (diff > -0.005) {
      msg = `<strong>Tu hotel quedó prácticamente al mismo precio</strong> que el más barato (${hotelPct(diff)}).`;
    } else {
      msg = `<strong>Tu hotel salió ${hotelPct(diff)}</strong>, es decir, más barato que el competidor más barato.`;
    }
    verdict = `
      ${cls ? `<div class="${cls}" style="margin-bottom:14px">${msg}</div>` : `<p style="margin:0 0 14px">${msg}</p>`}
      <div class="stat-grid" style="margin-bottom:14px">
        <div class="card stat-card"><div class="stat-label">Diferencia de precio</div><div class="stat-value lg">${hotelPct(diff)}</div><div class="stat-sub">promedio ponderado por impresiones</div></div>
        <div class="card stat-card"><div class="stat-label">Impresiones</div><div class="stat-value lg">${fmtInt(sm.impressions)}</div><div class="stat-sub">${fmtInt(sm.clicks)} clics</div></div>
        <div class="card stat-card"><div class="stat-label">Impresiones elegibles</div><div class="stat-value lg">${sm.eligible ? fmtInt(sm.eligible) : 'N/D'}</div><div class="stat-sub">${share !== null ? `se mostró en el ${share.toFixed(0)} %` : ''}</div></div>
      </div>`;
  }

  let buckets = '';
  if (data.buckets && data.buckets.length) {
    const total = data.buckets.reduce((acc, b) => acc + b.impressions, 0) || 1;
    buckets = `
      <h4 style="margin:6px 0 8px">En qué posición de precio quedó cada impresión</h4>
      <div class="table-scroll"><table>
        <thead><tr><th>Posición de precio</th><th>Impresiones</th><th>% del total</th><th>Clics</th><th title="Frente al competidor más barato; negativo = más barato">Diferencia de precio</th></tr></thead>
        <tbody>${data.buckets.map((b) => `
          <tr>
            <td>${escapeHtml(b.label)}</td>
            <td>${fmtInt(b.impressions)}</td>
            <td><div style="display:flex;align-items:center;gap:8px"><div style="width:90px;height:8px;background:var(--gray-100);border-radius:4px;overflow:hidden"><div style="width:${((b.impressions / total) * 100).toFixed(1)}%;height:100%;background:${b.bucket === 'NOT_LOWEST' ? 'var(--danger)' : 'var(--ok-text)'}"></div></div>${((b.impressions / total) * 100).toFixed(1)} %</div></td>
            <td>${fmtInt(b.clicks)}</td>
            <td>${b.price_diff === null || b.price_diff === undefined ? '<span class="footnote">—</span>' : `<span class="delta-badge ${b.price_diff > 0.005 ? 'bad' : (b.price_diff < -0.005 ? 'good' : 'neutral')}">${hotelPct(b.price_diff)}</span>`}</td>
          </tr>`).join('')}</tbody>
      </table></div>`;
  } else if (data.buckets === null) {
    buckets = '<p class="footnote">No se pudo traer el reparto por posición de precio.</p>';
  }

  let daily = '';
  if (data.daily && data.daily.length) {
    daily = `<h4 style="margin:16px 0 6px">Evolución diaria de la diferencia de precio</h4>
      <p class="footnote" style="margin:0 0 6px">Por encima de la línea punteada el hotel estuvo más caro que el competidor más barato; por debajo, más barato.</p>
      ${hotelPriceChartSvg(data.daily)}`;
  } else if (data.daily === null) {
    daily = '<p class="footnote">No se pudo traer la evolución diaria.</p>';
  }
  return head(`${verdict}${buckets}${daily}${renderHotelNote(data)}
    <p class="footnote" style="margin:12px 0 0">Los precios que se comparan son los del feed de tarifas de Google Hotel Ads. Si el hotel no cambia sus tarifas, la puja y los modificadores de abajo no modifican esta posición de precio.</p>`);
}

// Nota para el revenue manager del hotel: se ofrece cuando el precio sale caro. El servidor arma los datos y revisa
// que cada cifra del texto salga de ellos; la persona edita y envía la nota por su cuenta (la plataforma no envía nada).
function hotelPriceNeedsNote(price) {
  const sm = price && price.summary;
  if (!sm || !sm.impressions || sm.price_diff === null || sm.price_diff === undefined) return false;
  const bs = price.buckets || [];
  const total = bs.reduce((acc, b) => acc + b.impressions, 0);
  const notLowest = total ? (bs.filter((b) => b.bucket === 'NOT_LOWEST').reduce((acc, b) => acc + b.impressions, 0) / total) * 100 : 0;
  return sm.price_diff > 0.02 || notLowest >= 30;
}

function runHotelNote() {
  const s = state.hotel;
  const a = s.api;
  const d = s.detail;
  const campaignId = d.campaignId;
  d.note = { status: 'loading', error: null, data: null, copied: false, campaignId };
  render();
  fetch('/api/ai/nota-hotel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: hotelCustomerId(), campaign_id: campaignId, campaign_name: (d.data && d.data.campaign_name) || '', date_from: a.dateFrom, date_to: a.dateTo }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (d.campaignId !== campaignId) return;
      d.note = { status: 'ready', error: null, data, copied: false, campaignId };
      render();
    })
    .catch((err) => {
      if (d.campaignId !== campaignId) return;
      d.note = { status: 'error', error: err.message || String(err), data: null, copied: false, campaignId };
      render();
    });
}

function copyHotelNote() {
  const d = state.hotel.detail;
  if (!d.note || !d.note.data) return;
  const text = `Asunto: ${d.note.data.asunto}\n\n${d.note.data.mensaje}`;
  const done = () => { d.note.copied = true; render(); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => {});
  else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } finally { document.body.removeChild(ta); }
  }
}

function renderHotelNote(price) {
  const d = state.hotel.detail;
  const note = d.note && d.note.campaignId === d.campaignId ? d.note : null;
  if (!note && !hotelPriceNeedsNote(price)) return '';
  const small = 'font-size:11.5px;color:var(--color-text-muted)';
  let inner;
  if (!note) {
    inner = `<p style="margin:0 0 10px;${small}">Cuando el hotel sale más caro, la palanca está en las tarifas que el hotel envía a Google. Claude redacta un borrador con estas cifras para que se lo mandes a su revenue manager; tú lo revisas y lo envías.</p>
      <button class="btn-outline" data-action="hotel-note-run">Redactar nota para el revenue manager</button>`;
  } else if (note.status === 'loading') {
    inner = '<div class="state-panel loading" style="padding:12px 0"><div class="spinner"></div><p>Redactando la nota…</p></div>';
  } else if (note.status === 'error') {
    inner = `<div class="error-panel">${escapeHtml(note.error)}</div><div style="margin-top:10px"><button class="btn-outline" data-action="hotel-note-run">Reintentar</button></div>`;
  } else {
    const r = note.data;
    const warn = r.cifras_no_verificadas && r.cifras_no_verificadas.length
      ? `<div class="error-panel" style="margin-bottom:10px"><strong>Revisa estas cifras antes de enviar:</strong> ${r.cifras_no_verificadas.map(escapeHtml).join(', ')} no salen de los datos de esta pantalla.</div>` : '';
    inner = `
      ${warn}
      <label style="${small}">Asunto</label>
      <input type="text" data-hotel-note-subject value="${escapeHtml(r.asunto)}" style="width:100%;margin:2px 0 10px" />
      <label style="${small}">Mensaje (puedes editarlo)</label>
      <textarea data-hotel-note-text rows="11" style="width:100%;margin-top:2px;font:inherit;line-height:1.45">${escapeHtml(r.mensaje)}</textarea>
      <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn-accent" data-action="hotel-note-copy">${note.copied ? 'Copiado ✓' : 'Copiar nota'}</button>
        <button class="btn-outline sm" data-action="hotel-note-run">Redactar de nuevo</button>
        <span style="${small}">Borrador generado por IA: la plataforma no envía nada. Las cifras salen de la comparación de precio de arriba.</span>
      </div>`;
  }
  return `<h4 style="margin:16px 0 8px">Nota para el revenue manager del hotel</h4>${inner}`;
}

// Análisis con IA de la campaña: diagnóstico y propuesta de modificadores. Solo propone: el servidor valida cada
// propuesta (datos mínimos, rangos, alzas con precio caro) y aplicar sigue siendo el editor de tramos de abajo.
function runHotelAi() {
  const s = state.hotel;
  const a = s.api;
  const d = s.detail;
  const campaignId = d.campaignId;
  d.ai = { status: 'loading', error: null, data: null, campaignId };
  render();
  fetch('/api/ai/analizar-hotel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: hotelCustomerId(), campaign_id: campaignId, date_from: a.dateFrom, date_to: a.dateTo, moneda: s.list.currency || '' }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (d.campaignId !== campaignId) return;
      d.ai = { status: 'ready', error: null, data, campaignId };
      render();
    })
    .catch((err) => {
      if (d.campaignId !== campaignId) return;
      d.ai = { status: 'error', error: err.message || String(err), data: null, campaignId };
      render();
    });
}

// Copia las propuestas a la columna "Nuevo modificador": de ahí siguen el camino de siempre (vista previa de Google y confirmar).
function hotelAiToEditor() {
  const d = state.hotel.detail;
  if (!d.ai || !d.ai.data) return;
  d.ai.data.propuestas.forEach((p) => { d.edits[`${p.type}|${p.label}`] = String(p.nuevo); });
  d.ai.used = true;
  d.flow = { status: 'idle', preview: null, result: null, error: null };
  render();
  setTimeout(() => {
    const first = document.querySelector('[data-hotel-edit][style*="border-color"]');
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 0);
}

function renderHotelAi() {
  const d = state.hotel.detail;
  const ai = d.ai;
  const currency = state.hotel.list.currency;
  const head = (inner) => `
    <div class="card table-panel" style="margin-bottom:16px">
      <div class="table-panel-head"><h3>Análisis con IA</h3><span class="footnote">Lee el precio y el rendimiento de cada tramo · solo propone, no cambia nada en Google Ads</span></div>
      ${inner}
    </div>`;
  const runBtn = (label) => `<button class="btn-accent" data-action="hotel-ai-run">${label}</button>`;
  if (!ai || ai.campaignId !== d.campaignId) {
    return head(`
      <p class="footnote" style="margin:0 0 12px">Claude explica qué dicen el precio y los tramos y propone nuevos modificadores. El sistema descarta lo que no cumple sus reglas (tramos con pocos datos, saltos de más de 30 %, alzas cuando el hotel sale más de 5 % más caro). Cada análisis queda registrado en el consumo de la IA.</p>
      ${runBtn('Analizar con IA')}`);
  }
  if (ai.status === 'loading') return head('<div class="state-panel loading" style="padding:12px 0"><div class="spinner"></div><p>Claude está analizando la campaña…</p></div>');
  if (ai.status === 'error') return head(`<div class="error-panel">${escapeHtml(ai.error)}</div><div style="margin-top:10px">${runBtn('Reintentar')}</div>`);

  const r = ai.data;
  const diag = r.diagnostico.length ? r.diagnostico.map((p) => `<p style="margin:0 0 10px">${escapeHtml(p)}</p>`).join('') : '';
  let proposals;
  if (r.bloqueada) {
    proposals = '<p class="footnote">Esta cuenta es de solo lectura (plantilla externa de modificadores), así que no se proponen cambios.</p>';
  } else if (!r.propuestas.length) {
    proposals = `<p class="footnote"><strong>Sin cambios propuestos.</strong> ${escapeHtml(r.sin_cambios || 'Ningún tramo tiene datos suficientes para justificar un ajuste.')}</p>`;
  } else {
    const rows = r.propuestas.map((p) => {
      const up = p.nuevo > p.actual;
      const cpaTxt = p.cpa !== null ? `${hotelMoney(p.cpa, currency)}${p.cpa_vs_campana_pct !== null ? ` (${p.cpa_vs_campana_pct > 0 ? '+' : ''}${p.cpa_vs_campana_pct}%)` : ''}` : 'sin conv.';
      return `
        <tr>
          <td>${escapeHtml(p.tipo_label)} · ${escapeHtml(p.text)}</td>
          <td>${p.actual}</td>
          <td><span class="delta-badge ${up ? 'warn' : 'neutral'}">${p.nuevo}</span>${p.limitado ? '<div title="La IA propuso un salto mayor; el sistema lo limitó a ±30 % por paso" style="font-size:11.5px;color:var(--color-text-muted)">limitado a ±30 %</div>' : ''}</td>
          <td>${fmtInt(p.clicks)} clics · ${p.conversions} conv.<div style="font-size:11.5px;color:var(--color-text-muted)">CPA ${cpaTxt}</div></td>
          <td>${escapeHtml(p.razon)}</td>
        </tr>`;
    }).join('');
    proposals = `
      <h4 style="margin:14px 0 8px">Cambios propuestos</h4>
      <div class="table-scroll"><table>
        <thead><tr><th>Tramo</th><th>Actual (×)</th><th>Propuesto (×)</th><th>Rendimiento</th><th>Por qué</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn-accent" data-action="hotel-ai-use">Pasar al editor de tramos</button>
        <span style="font-size:11.5px;color:var(--color-text-muted)">${ai.used ? 'Ya están en la columna "Nuevo modificador": revísalos y usa Vista previa más abajo.' : 'No se aplica nada: se copian a la columna "Nuevo modificador" para que los revises y pidas la vista previa.'}</span>
      </div>`;
  }
  const untouched = r.propuestas.length && r.sin_cambios ? `<p class="footnote" style="margin-top:12px"><strong>Lo que no se toca:</strong> ${escapeHtml(r.sin_cambios)}</p>` : '';
  const dropped = r.descartadas.length ? `
    <details style="margin-top:12px"><summary class="footnote" style="cursor:pointer">${r.descartadas.length} propuesta${r.descartadas.length === 1 ? '' : 's'} de la IA descartada${r.descartadas.length === 1 ? '' : 's'} por el sistema</summary>
      <ul class="footnote" style="margin:6px 0 0 18px">${r.descartadas.map((x) => `<li><strong>${escapeHtml(x.tramo)}:</strong> ${escapeHtml(x.motivo)}</li>`).join('')}</ul>
    </details>` : '';
  return head(`
    ${diag}
    ${proposals}
    ${untouched}
    ${dropped}
    <p class="footnote" style="margin-top:12px">Texto generado por IA a partir de los datos de esta pantalla; las cifras de las tablas salen de Google Ads. ${runBtn('Volver a analizar').replace('btn-accent', 'btn-outline sm')}</p>`);
}

function hotelTramoKey(t) { return `${t.type}|${t.label}`; }

// Cambios que el usuario escribió y difieren de lo vigente. `invalid` junta lo que no cumple los límites.
function hotelPendingChanges() {
  const d = state.hotel.detail;
  const changes = []; const invalid = [];
  if (!d.data) return { changes, invalid };
  d.data.tramos.forEach((t) => {
    const raw = d.edits[hotelTramoKey(t)];
    if (raw === undefined || String(raw).trim() === '') return;
    const meta = HOTEL_TYPE_META[t.type];
    if (!meta || !meta.editable) return;
    const value = Number(String(raw).replace(',', '.'));
    if (Number.isNaN(value)) { invalid.push(`${t.text}: "${raw}" no es un número.`); return; }
    const rounded = Math.round(value * 100) / 100;
    if (rounded === 0 && !meta.zeroOk) { invalid.push(`${meta.label} · ${t.text}: no admite 0.`); return; }
    if (rounded !== 0 && (rounded < meta.min || rounded > meta.max)) { invalid.push(`${meta.label} · ${t.text}: debe estar entre ${meta.min} y ${meta.max}${meta.zeroOk ? ' (o 0 para no servir)' : ''}.`); return; }
    if (!t.mixed && t.value !== null && Math.abs(t.value - rounded) < 0.005) return; // igual a lo vigente
    changes.push({ type: t.type, label: t.label, text: t.text, value: rounded, previous: t.mixed ? null : t.value });
  });
  return { changes, invalid };
}

function submitHotelModifiers(preview) {
  const s = state.hotel;
  const d = s.detail;
  const f = d.flow;
  const { changes, invalid } = hotelPendingChanges();
  if (invalid.length) { f.status = 'error'; f.error = invalid.join(' '); render(); return; }
  if (!changes.length) { f.status = 'error'; f.error = 'No hay cambios: escribe un valor distinto al actual en algún tramo.'; render(); return; }

  f.status = preview ? 'previewing' : 'applying'; f.error = null;
  render();
  fetch('/api/google-ads/hotel-modifiers-apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: hotelCustomerId(),
      campaign_id: d.campaignId,
      changes: changes.map((c) => ({ type: c.type, label: c.label, value: c.value })),
      validate_only: preview,
    }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) {
        if (data.template_locked) s.list.templateLocked = true;
        throw new Error(data.error || 'Error desconocido.');
      }
      if (preview) {
        f.status = 'preview_ready'; f.preview = data;
        render();
      } else {
        f.status = 'done'; f.result = data;
        d.edits = {}; d.ai = null; // la propuesta ya no corresponde a los valores vigentes
        openHotelCampaign(d.campaignId, true); // vuelve a leer lo vigente en Google
      }
    })
    .catch((err) => { f.status = 'error'; f.error = err.message || String(err); render(); });
}

function hotelPerfCells(t, totals, currency) {
  const p = t.perf;
  if (!p) return '<td colspan="5" class="footnote">Sin desglose disponible</td>';
  const cpc = p.clicks ? p.cost / p.clicks : null;
  const cpa = p.conversions ? p.cost / p.conversions : null;
  const convRate = p.clicks ? (p.conversions / p.clicks) * 100 : null;
  let vsAvg = '<span class="footnote">—</span>';
  const avgCpa = totals.conversions ? totals.cost / totals.conversions : null;
  if (cpa !== null && avgCpa && p.conversions >= 3) {
    const diff = (cpa / avgCpa - 1) * 100;
    const good = diff <= -10; const bad = diff >= 10;
    vsAvg = `<span style="font-weight:600;color:${good ? 'var(--color-success, #1a7f4b)' : bad ? 'var(--color-danger, #b3261e)' : 'inherit'}">${diff > 0 ? '+' : ''}${diff.toFixed(0)}%</span>`;
  } else if (p.conversions > 0 && p.conversions < 3) {
    vsAvg = '<span class="footnote" title="Menos de 3 conversiones: no es concluyente">pocos datos</span>';
  }
  return `
    <td>${fmtInt(p.clicks)}</td>
    <td>${cpc !== null ? hotelMoney(cpc, currency) : 'N/D'}</td>
    <td>${p.conversions ? p.conversions.toFixed(p.conversions % 1 ? 1 : 0) : '0'}</td>
    <td>${cpa !== null ? hotelMoney(cpa, currency) : 'N/D'}${convRate !== null && p.conversions ? `<div style="margin:2px 0 0;font-size:11.5px;color:var(--color-text-muted)">${convRate.toFixed(1)}% conv/clic</div>` : ''}</td>
    <td>${vsAvg}</td>`;
}

function renderHotelTramoRow(t, totals, currency, locked) {
  const d = state.hotel.detail;
  const meta = HOTEL_TYPE_META[t.type];
  const key = hotelTramoKey(t);
  const edited = d.edits[key] !== undefined && String(d.edits[key]).trim() !== '';
  const current = t.mixed
    ? `<span title="Los grupos de anuncios tienen valores distintos en este tramo">variado ${t.min_value !== null ? t.min_value + '–' + t.max_value : ''}</span>`
    : (t.value !== null ? `<strong>${t.value}</strong>` : 'sin valor');
  const missing = t.ad_groups_missing > 0
    ? `<div class="footnote" style="color:var(--color-warning, #8a5a00)">falta en ${t.ad_groups_missing} grupo${t.ad_groups_missing === 1 ? '' : 's'}: se creará al guardar</div>` : '';
  let input;
  if (locked) input = '<span class="footnote">solo lectura</span>';
  else if (!meta.editable) input = '<span class="footnote">solo lectura</span>';
  else input = `<input type="text" inputmode="decimal" data-hotel-edit="${escapeHtml(key)}" value="${escapeHtml(edited ? d.edits[key] : '')}" placeholder="${t.mixed || t.value === null ? 'nuevo' : t.value}" style="width:84px${edited ? ';border-color:var(--color-accent, #0b57d0)' : ''}" />`;
  return `
    <tr>
      <td>${escapeHtml(t.text)}${missing}</td>
      <td>${current}</td>
      ${hotelPerfCells(t, totals, currency)}
      <td>${input}</td>
    </tr>`;
}

function renderHotelDetail() {
  const s = state.hotel;
  const d = s.detail;
  const currency = s.list.currency;

  if (d.status === 'loading') {
    return `<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo los modificadores de la campaña…</p></div>`;
  }
  if (d.status === 'error') {
    return `<div class="error-panel"><strong>No se pudieron traer los modificadores.</strong> ${escapeHtml(d.error)}
      <div style="margin-top:8px"><button class="btn-outline sm" data-action="hotel-back">Volver a las campañas</button></div></div>`;
  }
  const data = d.data;
  if (!data) return '';
  const locked = !!(data.template_locked || s.list.templateLocked);
  const f = d.flow;
  const busy = f.status === 'previewing' || f.status === 'applying';
  const { changes, invalid } = hotelPendingChanges();

  const lockBanner = locked ? `
    <div class="error-panel" style="margin-bottom:16px">
      <strong>Solo lectura en esta cuenta.</strong> Los modificadores de esta cuenta siguen una plantilla externa que se aplica de forma masiva (la misma en muchas cuentas).
      Si se cambian aquí, el siguiente ciclo de esa herramienta los vuelve a pisar. Puedes ver los valores y el rendimiento de cada tramo, pero no editarlos desde la plataforma.
    </div>` : '';

  const groups = HOTEL_TYPE_ORDER.map((type) => {
    const tramos = data.tramos.filter((t) => t.type === type);
    if (!tramos.length) return '';
    const meta = HOTEL_TYPE_META[type];
    const perfNote = type !== 'rango_fechas' && data.perf_available && data.perf_available[type] === false
      ? '<p class="footnote">No se pudo traer el desglose de rendimiento de este tipo.</p>' : '';
    return `
      <div class="card table-panel" style="margin-bottom:16px">
        <div class="table-panel-head"><h3>${escapeHtml(meta.label)}</h3><span class="footnote">${escapeHtml(meta.help)}</span></div>
        ${perfNote}
        <div class="table-scroll">
          <table>
            <thead><tr><th>Tramo</th><th title="Multiplicador que Google aplica sobre la puja base en este tramo">Modificador actual (×)</th><th>Clics</th><th title="CPC real pagado en el periodo, no la puja">CPC pagado</th><th>Conv.</th><th>CPA</th><th title="CPA del tramo frente al CPA promedio de la campaña (solo con 3+ conversiones)">CPA vs. campaña</th><th>Nuevo modificador (×)</th></tr></thead>
            <tbody>${tramos.map((t) => renderHotelTramoRow(t, data.totals, currency, locked)).join('')}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  let flowHtml = '';
  if (!locked) {
    if (busy) {
      flowHtml = `<p class="footnote">${f.status === 'previewing' ? 'Validando con Google Ads (vista previa, no aplica nada todavía)…' : 'Aplicando los cambios en Google Ads…'}</p>`;
    } else if (f.status === 'preview_ready' && f.preview) {
      const p = f.preview;
      const rows = (p.changes || []).map((c) => `
        <tr><td>${escapeHtml(HOTEL_TYPE_META[c.type] ? HOTEL_TYPE_META[c.type].label : c.type)} · ${escapeHtml(c.text)}</td>
        <td>${c.previous_values.length ? escapeHtml(c.previous_values.join(', ')) : '—'}</td>
        <td><strong>${c.new_value}</strong>${c.new_value === 0 ? ' <span class="footnote">(no servirá en este tramo)</span>' : ''}</td>
        <td>${c.ad_groups_updated} actualiz. · ${c.ad_groups_created} nuevos · ${c.ad_groups_unchanged} sin cambio</td></tr>`).join('');
      flowHtml = `
        <div class="ok-panel" style="margin-top:14px">
          <strong>Vista previa lista.</strong> Google validó el cambio sin aplicar nada: se actualizar${p.updated === 1 ? 'á' : 'án'} <strong>${p.updated}</strong> modificador${p.updated === 1 ? '' : 'es'} y se crear${p.created === 1 ? 'á' : 'án'} <strong>${p.created}</strong>
          en los ${data.ad_groups} grupo${data.ad_groups === 1 ? '' : 's'} de anuncios de "${escapeHtml(data.campaign_name)}"${p.simulated ? ' (modo simulado)' : ''}.
          ${p.failed_count ? `<div class="error-panel" style="margin-top:8px"><strong>${p.failed_count} con problema:</strong><ul style="margin:6px 0 0 18px">${(p.failed || []).map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul></div>` : ''}
          <div class="table-scroll" style="margin-top:10px"><table>
            <thead><tr><th>Tramo</th><th>Antes</th><th>Después</th><th>Grupos</th></tr></thead><tbody>${rows}</tbody></table></div>
          <p class="footnote" style="margin-top:10px">Esto cambia de verdad cuánto puja Google en esos tramos, en producción y desde ya.</p>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="btn-accent" data-action="hotel-confirm">Confirmar y aplicar</button>
            <button class="btn-outline" data-action="hotel-cancel">Cancelar</button>
          </div>
        </div>`;
    } else {
      const done = f.status === 'done' && f.result ? `
        <div class="ok-panel" style="margin-top:14px"><strong>Listo.</strong> Se actualiz${f.result.updated === 1 ? 'ó' : 'aron'} ${f.result.updated} modificador${f.result.updated === 1 ? '' : 'es'} y se cre${f.result.created === 1 ? 'ó' : 'aron'} ${f.result.created}${f.result.simulated ? ' (modo simulado)' : ''}.
          ${f.result.failed_count ? `<div class="error-panel" style="margin-top:8px"><strong>${f.result.failed_count} con problema:</strong><ul style="margin:6px 0 0 18px">${(f.result.failed || []).map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul></div>` : ''}
          Los valores de arriba ya son los leídos de nuevo desde Google Ads.</div>` : '';
      flowHtml = `
        <div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn-accent" data-action="hotel-preview" ${changes.length ? '' : 'disabled'}>Vista previa${changes.length ? ` (${changes.length} tramo${changes.length === 1 ? '' : 's'})` : ''}</button>
          ${changes.length ? '<button class="btn-outline" data-action="hotel-cancel">Descartar cambios</button>' : '<span class="footnote">Escribe un valor nuevo en los tramos que quieras cambiar.</span>'}
        </div>
        ${invalid.length ? `<div class="error-panel" style="margin-top:8px">${invalid.map(escapeHtml).join('<br>')}</div>` : ''}
        ${f.status === 'error' ? `<div class="error-panel" style="margin-top:8px">${escapeHtml(f.error)}</div>` : ''}
        ${done}`;
    }
  }

  const t = data.totals;
  return `
    <div style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn-outline sm" data-action="hotel-back">← Campañas</button>
      <h3 style="margin:0">${escapeHtml(data.campaign_name)}</h3>
      <span class="footnote">${escapeHtml(BID_STRATEGY_LABELS_ES[data.bidding_strategy_type] || data.bidding_strategy_type || '')} · ${data.ad_groups} grupo${data.ad_groups === 1 ? '' : 's'} de anuncios · ${fmtInt(t.clicks)} clics · ${hotelMoney(t.cost, currency)} · ${t.conversions ? t.conversions.toFixed(1) : 0} conv.</span>
    </div>
    <p class="footnote" style="margin:0 0 14px">Un <strong>modificador</strong> es un multiplicador que Google aplica sobre la puja base de la campaña en ese tramo: 1 = sin ajuste, 0,8 = pujar un 20 % menos, 1,3 = un 30 % más, 0 = no servir. El <strong>CPC pagado</strong> es lo que costó cada clic en el periodo, no la puja.</p>
    ${lockBanner}
    ${renderHotelPrice()}
    ${renderHotelAi()}
    ${data.tramos.length ? groups : '<div class="error-panel">Esta campaña no tiene modificadores de hotel en sus grupos de anuncios.</div>'}
    <p class="footnote">El cambio se aplica por campaña: el mismo valor en el tramo para todos sus grupos de anuncios (si algún grupo no tiene el tramo, se crea). Valores entre 0,1 y 10 (fechas elegidas: 0,5 a 2); 1 = sin ajuste; 0 = no servir en ese tramo. El CPA de cada tramo es el del periodo elegido; con pocas conversiones no es concluyente.</p>
    ${flowHtml}`;
}

function renderHotelCampaignList() {
  const s = state.hotel;
  const l = s.list;
  const currency = l.currency;
  const q = (l.filter || '').trim().toLowerCase();
  const all = l.campaigns || [];
  const filtered = q ? all.filter((c) => c.campaign_name.toLowerCase().includes(q) || c.campaign_id.includes(q)) : all;
  const shown = filtered.slice(0, HOTEL_RENDER_LIMIT);
  const rows = shown.map((c) => `
    <tr>
      <td>${escapeHtml(c.campaign_name)}</td>
      <td>${c.status === 'ENABLED' ? 'Activa' : 'Pausada'}</td>
      <td>${escapeHtml(BID_STRATEGY_LABELS_ES[c.bidding_strategy_type] || c.bidding_strategy_type || '')}</td>
      <td>${fmtInt(c.clicks)}</td>
      <td>${hotelMoney(c.cost, currency)}</td>
      <td>${c.conversions ? c.conversions.toFixed(c.conversions % 1 ? 1 : 0) : '0'}</td>
      <td>${c.conversions ? hotelMoney(c.cost / c.conversions, currency) : 'N/D'}</td>
      <td><button class="btn-outline sm" data-hotel-open="${escapeHtml(c.campaign_id)}">${l.templateLocked ? 'Ver' : 'Ver y editar'}</button></td>
    </tr>`).join('');
  const lockBanner = l.templateLocked ? `
    <div class="error-panel" style="margin-bottom:16px">
      <strong>Cuenta en solo lectura.</strong> Sus modificadores de oferta siguen una plantilla externa aplicada de forma masiva; editarlos aquí se perdería con su siguiente ciclo.
      Puedes ver cada campaña y el rendimiento por tramo.
    </div>` : '';
  return `
    ${lockBanner}
    <div class="card table-panel">
      <div class="table-panel-head">
        <h3>Campañas de hotel (${fmtInt(all.length)})</h3>
        <input type="text" id="hotel-campaign-filter" placeholder="Buscar por nombre o ID…" value="${escapeHtml(l.filter)}" style="width:280px" />
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Campaña</th><th>Estado</th><th>Estrategia de puja</th><th>Clics</th><th>Coste</th><th>Conv.</th><th>CPA</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8" class="footnote">Ninguna campaña coincide con la búsqueda.</td></tr>'}</tbody>
        </table>
      </div>
      ${filtered.length > shown.length ? `<p class="footnote" style="margin-top:10px">Mostrando ${shown.length} de ${fmtInt(filtered.length)} (ordenadas por coste). Usa el buscador para llegar a una campaña concreta.</p>` : ''}
    </div>`;
}

function renderHotelApiPanel() {
  const a = state.hotel.api;

  if (!a.statusChecked) {
    return `<div class="field"><p class="footnote">Consultando la conexión con Google Ads…</p></div>`;
  }
  const simulatedNotice = a.simulated ? `
    <div class="ok-panel" style="margin:10px 0">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor
      — estos son datos de ejemplo, no de una cuenta real.
    </div>` : '';

  if (a.accountsStatus === 'idle') {
    return `
      <div class="card control-panel align-end">
        <div class="field">
          <p class="footnote">${a.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.'}</p>
          <button class="btn-outline" data-action="hotel-api-load-accounts">Ver cuentas disponibles</button>
        </div>
      </div>`;
  }
  if (a.accountsStatus === 'loading') {
    return `<div class="card control-panel align-end"><div class="field"><p class="footnote">Cargando cuentas…</p></div></div>`;
  }
  if (a.accountsStatus === 'error') {
    return `<div class="error-panel"><strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(a.error)}</div>`;
  }

  const mccFilterActive = a.mcc.selectedId && a.mcc.accountIds;
  const visibleAccounts = mccFilterActive ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
  const accountOptions = ['<option value="">Elige una cuenta…</option>']
    .concat(visibleAccounts.map((acc) => `<option value="${escapeHtml(acc.id)}" ${a.accountId === acc.id ? 'selected' : ''}>${escapeHtml(acc.name)} (${escapeHtml(acc.id)})</option>`))
    .join('');

  return `
    <div class="card control-panel align-end">
      ${simulatedNotice}
      ${renderHotelMccFilterPanel()}
      <div class="field">
        <label>Cuenta${mccFilterActive ? ` (${visibleAccounts.length} en "${escapeHtml(a.mcc.selectedName)}")` : ''}</label>
        <select id="hotel-api-account" style="width:320px">${accountOptions}</select>
      </div>
      <div class="field">
        <label>...o escribe el ID de la cuenta</label>
        <input type="text" id="hotel-api-account-manual" value="${escapeHtml(a.accountIdManual)}" placeholder="ej. 6862893390" style="width:160px" />
      </div>
      <div style="display:flex;gap:24px;flex-wrap:nowrap">
        <div class="field">
          <label>Desde</label>
          <input type="date" id="hotel-api-date-from" value="${escapeHtml(a.dateFrom)}" />
        </div>
        <div class="field">
          <label>Hasta</label>
          <input type="date" id="hotel-api-date-to" value="${escapeHtml(a.dateTo)}" />
        </div>
      </div>
      <button class="btn-accent" data-action="hotel-api-fetch">Traer campañas de hotel</button>
      ${a.error ? `<div class="error-panel" style="margin-top:10px"><strong>No se pudo traer los datos.</strong> ${escapeHtml(a.error)}</div>` : ''}
    </div>`;
}

function renderHotelPage() {
  const s = state.hotel;
  if (!currentUser.isSuperAdmin) {
    return `<div class="card state-panel idle"><p>Esta sección todavía no está disponible para tu usuario.</p></div>`;
  }
  ensureHotelGoogleAdsStatusLoaded();
  const controlPanel = renderHotelApiPanel();

  let body = '';
  if (s.list.status === 'idle') {
    body = `
      <div class="card state-panel idle">
        ${icon('bed-double', 30)}
        <p>Elige una cuenta con campañas de hotel y trae el rango de fechas para ver los modificadores de oferta de cada campaña y cómo rinde cada tramo.</p>
      </div>`;
  } else if (s.list.status === 'loading') {
    body = `<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo las campañas de hotel…</p></div>`;
  } else if (s.detail.campaignId) {
    body = renderHotelDetail();
  } else if (!(s.list.campaigns || []).length) {
    body = `<div class="error-panel">Esta cuenta no tiene campañas de hotel (tipo "Hotel"). Si usa Performance Max o IA Max para viajes, esos tipos no llevan estos modificadores.</div>`;
  } else {
    body = renderHotelCampaignList();
  }
  return `${controlPanel}${body}`;
}

function ensureHotelGoogleAdsStatusLoaded() {
  const a = state.hotel.api;
  if (a.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { a.statusChecked = true; a.configured = !!data.configured; render(); })
    .catch(() => { a.statusChecked = true; a.configured = false; render(); });
}

function loadHotelGoogleAdsAccounts() {
  const a = state.hotel.api;
  a.accountsStatus = 'loading'; a.error = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.accounts = data.accounts || [];
      a.simulated = !!data.simulated;
      a.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.accountsStatus = 'error'; a.error = err.message || String(err);
      render();
    });
}

function hotelCustomerId() {
  const a = state.hotel.api;
  const manualId = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  return manualId || a.accountId;
}

function loadHotelMccGroups() {
  const m = state.hotel.api.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => { m.status = 'error'; m.error = err.message || String(err); render(); });
}

function applyHotelMccFilter(groupId, groupName) {
  const a = state.hotel.api;
  const m = a.mcc;
  m.selectedId = groupId; m.selectedName = groupName;
  m.accountIdsStatus = 'loading'; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(groupId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.accountIds = new Set((data.accounts || []).map((acc) => acc.id));
      m.accountIdsStatus = 'ready';
      if (a.accountId && !m.accountIds.has(a.accountId)) a.accountId = '';
      render();
    })
    .catch((err) => { m.accountIdsStatus = 'error'; m.error = err.message || String(err); render(); });
}

function clearHotelMccFilter() {
  const m = state.hotel.api.mcc;
  m.selectedId = ''; m.selectedName = ''; m.accountIds = null; m.accountIdsStatus = 'idle'; m.filter = '';
  render();
}

function renderHotelMccFilterPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.hotel.api.mcc;

  if (m.selectedId) {
    const countLabel = m.accountIdsStatus === 'loading' ? 'cargando…'
      : m.accountIdsStatus === 'ready' ? `${m.accountIds.size} cuenta(s)`
      : 'error';
    return `
      <div class="field">
        <label>Filtrando por MCC</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="delta-badge neutral">${escapeHtml(m.selectedName)} — ${countLabel}</span>
          <button class="btn-link" data-action="hotel-mcc-clear">Quitar filtro</button>
        </div>
      </div>`;
  }

  if (m.status === 'idle') {
    return `<div class="field"><button class="btn-outline sm" data-action="hotel-mcc-load">Filtrar por MCC (ej. una cadena de hoteles)</button></div>`;
  }
  if (m.status === 'loading') {
    return `<div class="field"><p class="footnote">Cargando agrupaciones del MCC…</p></div>`;
  }
  if (m.status === 'error') {
    return `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  }

  const filter = (m.filter || '').trim().toLowerCase();
  let matches = [];
  if (filter.length >= 2) {
    matches = m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25);
  }
  const matchesHtml = matches.length
    ? `<div class="table-scroll" style="max-height:200px;margin-top:8px">
        <table><tbody>
          ${matches.map((g) => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
              <td><button class="btn-outline xs" data-hotel-mcc-pick="${escapeHtml(g.id)}" data-hotel-mcc-pick-name="${escapeHtml(g.name)}">Usar</button></td>
            </tr>`).join('')}
        </tbody></table>
      </div>`
    : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');

  return `
    <div class="field">
      <label>Filtrar por MCC</label>
      <input type="text" id="hotel-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:320px" />
      ${matchesHtml}
    </div>`;
}

// ---------------------------------------------------------------------------
// Página — Exclusiones de contenido (CustomerNegativeCriterion, a nivel de
// cuenta). Espejo en el cliente de CONTENT_LABEL_TYPES/CONTENT_LABEL_LABELS
// en google_ads_client.py — se necesita acá para el picker de "agregar",
// que debe mostrar las 26 categorías reales aunque la cuenta no tenga
// ninguna excluida todavía.
// ---------------------------------------------------------------------------

const CONTENT_LABEL_CATALOG = [
  { type: 'SEXUALLY_SUGGESTIVE', label: 'Contenido sexualmente sugestivo' },
  { type: 'BELOW_THE_FOLD', label: 'Ubicación "bajo el pliegue" (below the fold)' },
  { type: 'PARKED_DOMAIN', label: 'Dominio estacionado (parked domain)' },
  { type: 'JUVENILE', label: 'Contenido juvenil, grotesco o bizarro' },
  { type: 'PROFANITY', label: 'Lenguaje profano o vulgar' },
  { type: 'TRAGEDY', label: 'Muerte y tragedia' },
  { type: 'VIDEO', label: 'Contenido de video (en general)' },
  { type: 'VIDEO_RATING_DV_G', label: 'Video — clasificación G' },
  { type: 'VIDEO_RATING_DV_PG', label: 'Video — clasificación PG' },
  { type: 'VIDEO_RATING_DV_T', label: 'Video — clasificación T' },
  { type: 'VIDEO_RATING_DV_MA', label: 'Video — clasificación MA' },
  { type: 'VIDEO_NOT_YET_RATED', label: 'Video sin clasificar todavía' },
  { type: 'EMBEDDED_VIDEO', label: 'Video incrustado' },
  { type: 'LIVE_STREAMING_VIDEO', label: 'Video en vivo (streaming)' },
  { type: 'SOCIAL_ISSUES', label: 'Temas sociales sensibles' },
  { type: 'BRAND_SUITABILITY_CONTENT_FOR_FAMILIES', label: 'Contenido apto para familias (incl. "Hecho para niños" de YouTube)' },
  { type: 'BRAND_SUITABILITY_GAMES_FIGHTING', label: 'Videojuegos de combate o pelea' },
  { type: 'BRAND_SUITABILITY_GAMES_MATURE', label: 'Videojuegos con contenido maduro' },
  { type: 'BRAND_SUITABILITY_HEALTH_SENSITIVE', label: 'Contenido de salud sensible' },
  { type: 'BRAND_SUITABILITY_HEALTH_SOURCE_UNDETERMINED', label: 'Salud, de fuentes poco verificadas' },
  { type: 'BRAND_SUITABILITY_NEWS_RECENT', label: 'Noticias recién anunciadas' },
  { type: 'BRAND_SUITABILITY_NEWS_SENSITIVE', label: 'Noticias sensibles (crímenes, accidentes, controversia)' },
  { type: 'BRAND_SUITABILITY_NEWS_SOURCE_NOT_FEATURED', label: 'Noticias de fuentes no destacadas por Google/YouTube' },
  { type: 'BRAND_SUITABILITY_POLITICS', label: 'Política, elecciones y eventos políticos' },
  { type: 'BRAND_SUITABILITY_RELIGION', label: 'Temas religiosos' },
];

function resetContentExclusionsAccountData() {
  const s = state.contentExclusions;
  s.status = 'idle'; s.error = null;
  s.contentLabels = null; s.appCategories = null; s.appCategoriesCatalog = null;
  s.addLabels = { selected: new Set(), status: 'idle', error: null, preview: null, result: null };
  s.addApp = { filter: '', selected: new Set(), status: 'idle', error: null, preview: null, result: null };
  s.remove = { resourceName: null, status: 'idle', error: null, preview: null, result: null };
}

function ensureContentExclusionsGoogleAdsStatusLoaded() {
  const a = state.contentExclusions.api;
  if (a.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { a.statusChecked = true; a.configured = !!data.configured; render(); })
    .catch(() => { a.statusChecked = true; a.configured = false; render(); });
}

function loadContentExclusionsGoogleAdsAccounts() {
  const a = state.contentExclusions.api;
  a.accountsStatus = 'loading'; a.error = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.accounts = data.accounts || [];
      a.simulated = !!data.simulated;
      a.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.accountsStatus = 'error'; a.error = err.message || String(err);
      render();
    });
}

function contentExclusionsCustomerId() {
  const a = state.contentExclusions.api;
  const manualId = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  return manualId || a.accountId;
}

function fetchContentExclusions() {
  const s = state.contentExclusions;
  const a = s.api;
  const customerId = contentExclusionsCustomerId();
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }

  a.error = null;
  s.status = 'loading'; s.error = null;
  render();

  const params = new URLSearchParams({ customer_id: customerId || '' });
  fetch(`/api/google-ads/content-exclusions?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.simulated = !!data.simulated;
      s.contentLabels = data.content_labels || [];
      s.appCategories = data.app_categories || [];
      s.appCategoriesCatalog = data.app_categories_catalog || [];
      s.status = 'ready';
      s.addLabels = { selected: new Set(), status: 'idle', error: null, preview: null, result: null };
      s.addApp = { filter: '', selected: new Set(), status: 'idle', error: null, preview: null, result: null };
      s.remove = { resourceName: null, status: 'idle', error: null, preview: null, result: null };
      render();
    })
    .catch((err) => {
      a.error = err.message || String(err);
      s.status = 'idle';
      render();
    });
}

// preview=true valida sin aplicar; preview=false escribe de verdad en la
// cuenta. Igual que ROAS/Negativización: nunca un solo clic entre decidir y
// escribir.
function addContentLabelExclusions(preview) {
  const s = state.contentExclusions;
  const p = s.addLabels;
  const customerId = contentExclusionsCustomerId();
  const types = [...p.selected];
  if (!types.length) { p.error = 'Selecciona al menos una categoría.'; render(); return; }

  p.status = preview ? 'previewing' : 'applying';
  p.error = null;
  render();

  fetch('/api/google-ads/content-exclusions/add-labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId, content_label_types: types, validate_only: preview }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (preview) {
        p.status = 'preview_ready';
        p.preview = { ...data, types };
      } else {
        p.status = 'done';
        p.result = data;
        p.selected = new Set();
        fetchContentExclusions();
      }
      render();
    })
    .catch((err) => {
      p.status = 'error';
      p.error = err.message || String(err);
      render();
    });
}

function addAppCategoryExclusions(preview) {
  const s = state.contentExclusions;
  const p = s.addApp;
  const customerId = contentExclusionsCustomerId();
  const resourceNames = [...p.selected];
  if (!resourceNames.length) { p.error = 'Elige al menos una categoría de apps primero.'; render(); return; }

  p.status = preview ? 'previewing' : 'applying';
  p.error = null;
  render();

  fetch('/api/google-ads/content-exclusions/add-app-category', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId, category_resource_names: resourceNames, validate_only: preview }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (preview) {
        p.status = 'preview_ready';
        p.preview = { ...data, resourceNames };
      } else {
        p.status = 'done';
        p.result = data;
        p.selected = new Set();
        fetchContentExclusions();
      }
      render();
    })
    .catch((err) => {
      p.status = 'error';
      p.error = err.message || String(err);
      render();
    });
}

function removeContentExclusion(preview) {
  const s = state.contentExclusions;
  const p = s.remove;
  const customerId = contentExclusionsCustomerId();
  if (!p.resourceName) return;

  p.status = preview ? 'previewing' : 'applying';
  p.error = null;
  render();

  fetch('/api/google-ads/content-exclusions/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId, resource_name: p.resourceName, validate_only: preview }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (preview) {
        p.status = 'preview_ready';
        p.preview = { ...data };
      } else {
        p.status = 'done';
        p.result = data;
        fetchContentExclusions();
      }
      render();
    })
    .catch((err) => {
      p.status = 'error';
      p.error = err.message || String(err);
      render();
    });
}

function loadExclusionesMccGroups() {
  const m = state.contentExclusions.api.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => { m.status = 'error'; m.error = err.message || String(err); render(); });
}

function applyExclusionesMccFilter(groupId, groupName) {
  const a = state.contentExclusions.api;
  const m = a.mcc;
  m.selectedId = groupId; m.selectedName = groupName;
  m.accountIdsStatus = 'loading'; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(groupId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.accountIds = new Set((data.accounts || []).map((acc) => acc.id));
      m.accountIdsStatus = 'ready';
      if (a.accountId && !m.accountIds.has(a.accountId)) a.accountId = '';
      render();
    })
    .catch((err) => { m.accountIdsStatus = 'error'; m.error = err.message || String(err); render(); });
}

function clearExclusionesMccFilter() {
  const m = state.contentExclusions.api.mcc;
  m.selectedId = ''; m.selectedName = ''; m.accountIds = null; m.accountIdsStatus = 'idle'; m.filter = '';
  render();
}

function renderExclusionesMccFilterPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.contentExclusions.api.mcc;

  if (m.selectedId) {
    const countLabel = m.accountIdsStatus === 'loading' ? 'cargando…'
      : m.accountIdsStatus === 'ready' ? `${m.accountIds.size} cuenta(s)`
      : 'error';
    return `
      <div class="field">
        <label>Filtrando por MCC</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="delta-badge neutral">${escapeHtml(m.selectedName)} — ${countLabel}</span>
          <button class="btn-link" data-action="exclusiones-mcc-clear">Quitar filtro</button>
        </div>
      </div>`;
  }

  if (m.status === 'idle') {
    return `<div class="field"><button class="btn-outline sm" data-action="exclusiones-mcc-load">Filtrar por MCC (ej. una cadena de hoteles)</button></div>`;
  }
  if (m.status === 'loading') {
    return `<div class="field"><p class="footnote">Cargando agrupaciones del MCC…</p></div>`;
  }
  if (m.status === 'error') {
    return `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  }

  const filter = (m.filter || '').trim().toLowerCase();
  let matches = [];
  if (filter.length >= 2) {
    matches = m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25);
  }
  const matchesHtml = matches.length
    ? `<div class="table-scroll" style="max-height:200px;margin-top:8px">
        <table><tbody>
          ${matches.map((g) => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
              <td><button class="btn-outline xs" data-exclusiones-mcc-pick="${escapeHtml(g.id)}" data-exclusiones-mcc-pick-name="${escapeHtml(g.name)}">Usar</button></td>
            </tr>`).join('')}
        </tbody></table>
      </div>`
    : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');

  return `
    <div class="field">
      <label>Filtrar por MCC</label>
      <input type="text" id="exclusiones-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:320px" />
      ${matchesHtml}
    </div>`;
}

function renderContentExclusionsApiPanel() {
  const a = state.contentExclusions.api;

  if (!a.statusChecked) {
    return `<div class="field"><p class="footnote">Consultando la conexión con Google Ads…</p></div>`;
  }

  const simulatedNotice = a.simulated ? `
    <div class="ok-panel" style="margin:10px 0">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor
      (falta la aprobación del developer token de Google) — estos son datos de ejemplo, no de una cuenta real.
    </div>` : '';

  if (a.accountsStatus === 'idle') {
    return `
      <div class="card control-panel align-end">
        <div class="field">
          <p class="footnote">${a.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.'}</p>
          <button class="btn-outline" data-action="exclusiones-api-load-accounts">Ver cuentas disponibles</button>
        </div>
      </div>`;
  }
  if (a.accountsStatus === 'loading') {
    return `<div class="card control-panel align-end"><div class="field"><p class="footnote">Cargando cuentas…</p></div></div>`;
  }
  if (a.accountsStatus === 'error') {
    return `<div class="error-panel"><strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(a.error)}</div>`;
  }

  const mccFilterActive = a.mcc.selectedId && a.mcc.accountIds;
  const visibleAccounts = mccFilterActive ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
  const accountOptions = ['<option value="">Elige una cuenta…</option>']
    .concat(visibleAccounts.map((acc) => `<option value="${escapeHtml(acc.id)}" ${a.accountId === acc.id ? 'selected' : ''}>${escapeHtml(acc.name)} (${escapeHtml(acc.id)})</option>`))
    .join('');

  return `
    <div class="card control-panel align-end">
      ${simulatedNotice}
      ${renderExclusionesMccFilterPanel()}
      <div class="field">
        <label>Cuenta${mccFilterActive ? ` (${visibleAccounts.length} en "${escapeHtml(a.mcc.selectedName)}")` : ''}</label>
        <select id="exclusiones-api-account" style="width:320px">${accountOptions}</select>
      </div>
      <div class="field">
        <label>...o escribe el ID de la cuenta</label>
        <input type="text" id="exclusiones-api-account-manual" value="${escapeHtml(a.accountIdManual)}" placeholder="ej. 6862893390" style="width:160px" />
      </div>
      <button class="btn-accent" data-action="exclusiones-api-fetch">Traer exclusiones</button>
      ${a.error ? `<div class="error-panel" style="margin-top:10px"><strong>No se pudo traer los datos.</strong> ${escapeHtml(a.error)}</div>` : ''}
    </div>`;
}

function renderContentExclusionsRemoveCell(resourceName) {
  const s = state.contentExclusions;
  const r = s.remove;
  const isEditing = r.resourceName === resourceName;

  if (!isEditing) {
    return `<button class="btn-outline sm" data-action="exclusiones-remove-start" data-resource="${escapeHtml(resourceName)}">Quitar</button>`;
  }

  const busy = r.status === 'previewing' || r.status === 'applying';

  if (r.status === 'idle' || r.status === 'error') {
    return `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn-accent sm" data-action="exclusiones-remove-preview" ${busy ? 'disabled' : ''}>Vista previa</button>
        <button class="btn-outline sm" data-action="exclusiones-remove-cancel">Cancelar</button>
      </div>
      ${r.error ? `<div class="error-panel" style="margin-top:6px;font-size:12px">${escapeHtml(r.error)}</div>` : ''}`;
  }

  if (busy) {
    return `<p class="footnote">${r.status === 'previewing' ? 'Validando…' : 'Aplicando…'}</p>`;
  }

  if (r.status === 'preview_ready') {
    return `
      <div class="ok-panel" style="margin:6px 0;padding:8px 10px;font-size:12.5px">
        <strong>Vista previa lista.</strong> Esto quita la exclusión de verdad en la cuenta.
        <div style="margin-top:8px;display:flex;gap:8px">
          <button class="btn-accent sm" data-action="exclusiones-remove-confirm">Confirmar</button>
          <button class="btn-outline sm" data-action="exclusiones-remove-cancel">Cancelar</button>
        </div>
      </div>`;
  }

  if (r.status === 'done') {
    return `<span class="footnote">Quitada.</span>`;
  }

  return '';
}

function renderContentExclusionsListPanel() {
  const s = state.contentExclusions;
  const labels = s.contentLabels || [];
  const apps = s.appCategories || [];

  if (!labels.length && !apps.length) {
    return `<div class="ok-panel">Esta cuenta no tiene categorías de contenido ni de apps excluidas todavía.</div>`;
  }

  const labelsRows = labels.map((l) => `
    <tr>
      <td>${escapeHtml(l.label)}</td>
      <td>${renderContentExclusionsRemoveCell(l.resource_name)}</td>
    </tr>`).join('');
  const appsRows = apps.map((c) => `
    <tr>
      <td>${escapeHtml(c.name || c.category_constant)}</td>
      <td>${renderContentExclusionsRemoveCell(c.resource_name)}</td>
    </tr>`).join('');

  return `
    <div class="card table-panel" style="margin-bottom:20px">
      <div class="table-panel-head"><h3>Categorías de contenido excluidas (${labels.length})</h3></div>
      ${labels.length ? `
        <div class="table-scroll">
          <table>
            <thead><tr><th>Categoría</th><th>Acción</th></tr></thead>
            <tbody>${labelsRows}</tbody>
          </table>
        </div>` : `<p class="footnote">Ninguna categoría de contenido excluida.</p>`}
    </div>
    <div class="card table-panel" style="margin-bottom:20px">
      <div class="table-panel-head"><h3>Categorías de apps excluidas (${apps.length})</h3></div>
      ${apps.length ? `
        <div class="table-scroll">
          <table>
            <thead><tr><th>Categoría de apps</th><th>Acción</th></tr></thead>
            <tbody>${appsRows}</tbody>
          </table>
        </div>` : `<p class="footnote">Ninguna categoría de apps excluida.</p>`}
    </div>`;
}

function renderContentExclusionsAddLabelsPanel() {
  const s = state.contentExclusions;
  const p = s.addLabels;
  const excludedTypes = new Set((s.contentLabels || []).map((l) => l.type));
  const available = CONTENT_LABEL_CATALOG.filter((c) => !excludedTypes.has(c.type));
  const busy = p.status === 'previewing' || p.status === 'applying';

  if (!available.length) {
    return `
      <div class="card table-panel" style="margin-bottom:20px">
        <h3 class="dense-chart-title">Excluir categorías de contenido</h3>
        <p class="footnote">Ya están excluidas todas las categorías disponibles.</p>
      </div>`;
  }

  const checkboxesHtml = available.map((c) => `
    <label style="display:flex;align-items:center;gap:8px;font-weight:400;padding:4px 0">
      <input type="checkbox" class="exclusiones-label-check" value="${escapeHtml(c.type)}" ${p.selected.has(c.type) ? 'checked' : ''} />
      ${escapeHtml(c.label)}
    </label>`).join('');

  return `
    <div class="card table-panel" style="margin-bottom:20px">
      <h3 class="dense-chart-title">Excluir categorías de contenido</h3>
      <p style="margin:0 0 12px;font-size:12.5px;color:var(--color-text-muted)">Marca las categorías a excluir de TODA la cuenta — aplica a Performance Max, Demand Gen, Display y Video (Search casi no usa esto). La vista previa valida contra Google Ads sin aplicar nada; solo al confirmar queda escrito de verdad.</p>
      <div style="max-height:260px;overflow-y:auto;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:6px 12px;margin-bottom:12px">
        ${checkboxesHtml}
      </div>

      ${p.status === 'idle' || p.status === 'error' ? `
        <button class="btn-accent" data-action="exclusiones-labels-preview" ${p.selected.size === 0 || busy ? 'disabled' : ''}>Vista previa</button>
        ${p.error ? `<div class="error-panel" style="margin-top:10px">${escapeHtml(p.error)}</div>` : ''}
      ` : ''}

      ${busy ? `<p class="footnote">${p.status === 'previewing' ? 'Validando con Google Ads (vista previa, no aplica nada todavía)…' : 'Aplicando en Google Ads…'}</p>` : ''}

      ${p.status === 'preview_ready' && p.preview ? `
        <div class="ok-panel" style="margin:10px 0">
          <strong>Vista previa lista.</strong> Google Ads validó ${p.preview.created} de ${p.preview.types.length} sin problema — nada se aplicó todavía.
          ${p.preview.failed && p.preview.failed.length ? `<div style="margin-top:6px"><strong>${p.preview.failed.length} no pasaron la validación:</strong><br>${p.preview.failed.map((m) => escapeHtml(m)).join('<br>')}</div>` : ''}
        </div>
        <button class="btn-accent" data-action="exclusiones-labels-confirm">Confirmar y aplicar</button>
        <button class="btn-outline" data-action="exclusiones-labels-cancel">Cancelar</button>
      ` : ''}

      ${p.status === 'done' && p.result ? `
        <div class="ok-panel" style="margin:10px 0"><strong>Listo.</strong> Se excluyeron ${p.result.created} categorías.</div>
      ` : ''}
    </div>`;
}

function renderContentExclusionsAddAppPanel() {
  const s = state.contentExclusions;
  const p = s.addApp;
  const excludedResources = new Set((s.appCategories || []).map((a) => a.category_constant));
  const catalog = s.appCategoriesCatalog || [];
  const filterLower = (p.filter || '').toLowerCase();
  const available = catalog.filter((c) => !excludedResources.has(c.resource_name) && (!filterLower || c.name.toLowerCase().includes(filterLower)));
  const busy = p.status === 'previewing' || p.status === 'applying';

  const checkboxesHtml = available.map((c) => `
    <label style="display:flex;align-items:center;gap:8px;font-weight:400;padding:4px 0">
      <input type="checkbox" class="exclusiones-app-check" value="${escapeHtml(c.resource_name)}" ${p.selected.has(c.resource_name) ? 'checked' : ''} />
      ${escapeHtml(c.name)}
    </label>`).join('');

  return `
    <div class="card table-panel" style="margin-bottom:20px">
      <h3 class="dense-chart-title">Excluir categorías de apps</h3>
      <p style="margin:0 0 12px;font-size:12.5px;color:var(--color-text-muted)">Excluye una o más categorías completas de apps (ej. juegos, apps de citas) de toda la cuenta — aplica sobre todo a Display y Demand Gen. La vista previa valida sin aplicar nada.</p>
      <div class="field" style="margin-bottom:10px">
        <label>Buscar categoría</label>
        <input type="text" id="exclusiones-app-filter" value="${escapeHtml(p.filter)}" placeholder="ej. juegos" style="width:280px" />
      </div>

      ${available.length ? `
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
          <button class="btn-outline sm" data-action="exclusiones-app-select-all">Seleccionar las ${available.length} mostradas</button>
          <button class="btn-outline sm" data-action="exclusiones-app-select-none">Deseleccionar todas</button>
          <span style="font-size:12.5px;color:var(--color-text-muted)">${p.selected.size} seleccionada${p.selected.size === 1 ? '' : 's'}</span>
        </div>
        <div style="max-height:260px;overflow-y:auto;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:6px 12px;margin-bottom:12px">
          ${checkboxesHtml}
        </div>` : `<p class="footnote">Ninguna categoría disponible para excluir con este filtro.</p>`}

      ${p.status === 'idle' || p.status === 'error' ? `
        <button class="btn-accent" data-action="exclusiones-app-preview" ${p.selected.size === 0 || busy ? 'disabled' : ''}>Vista previa</button>
        ${p.error ? `<div class="error-panel" style="margin-top:10px">${escapeHtml(p.error)}</div>` : ''}
      ` : ''}

      ${busy ? `<p class="footnote">${p.status === 'previewing' ? 'Validando con Google Ads (vista previa, no aplica nada todavía)…' : 'Aplicando en Google Ads…'}</p>` : ''}

      ${p.status === 'preview_ready' && p.preview ? `
        <div class="ok-panel" style="margin:10px 0">
          <strong>Vista previa lista.</strong> Google Ads validó ${p.preview.created} de ${p.preview.resourceNames.length} sin problema — nada se aplicó todavía.
          ${p.preview.failed && p.preview.failed.length ? `<div style="margin-top:6px"><strong>${p.preview.failed.length} no pasaron la validación:</strong><br>${p.preview.failed.map((m) => escapeHtml(m)).join('<br>')}</div>` : ''}
        </div>
        <button class="btn-accent" data-action="exclusiones-app-confirm">Confirmar y aplicar</button>
        <button class="btn-outline" data-action="exclusiones-app-cancel">Cancelar</button>
      ` : ''}

      ${p.status === 'done' && p.result ? `
        <div class="ok-panel" style="margin:10px 0"><strong>Listo.</strong> Se excluyeron ${p.result.created} categorías de apps.</div>
      ` : ''}
    </div>`;
}

function renderContentExclusionsPage() {
  const s = state.contentExclusions;
  ensureContentExclusionsGoogleAdsStatusLoaded();

  const controlPanel = renderContentExclusionsApiPanel();

  if (s.status === 'idle') {
    return `
      ${controlPanel}
      <div class="card state-panel idle">
        ${icon('shield-off', 30)}
        <p>Conecta una cuenta de Google Ads para ver qué categorías de contenido y de apps ya están excluidas de toda la cuenta.</p>
      </div>`;
  }
  if (s.status === 'loading') {
    return `${controlPanel}<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo exclusiones…</p></div>`;
  }
  if (s.status === 'error') {
    return `${controlPanel}<div class="error-panel"><strong>No se pudo traer las exclusiones.</strong> ${escapeHtml(s.error)}</div>`;
  }

  return `
    ${controlPanel}
    ${renderContentExclusionsListPanel()}
    ${renderContentExclusionsAddLabelsPanel()}
    ${renderContentExclusionsAddAppPanel()}`;
}

// ---------------------------------------------------------------------------
// Página — Planificador de palabras clave (Ideas, Histórico, Pronóstico)
// ---------------------------------------------------------------------------

function kwpParseKeywords(text) {
  return [...new Set((text || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

const KWP_COMPETITION_LABELS = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta' };
function kwpCompetitionBadge(raw) {
  const label = KWP_COMPETITION_LABELS[raw] || 'N/D';
  const tone = raw === 'HIGH' ? 'bad' : raw === 'LOW' ? 'good' : 'neutral';
  return `<span class="delta-badge ${tone}">${label}</span>`;
}
function fmtMoneyFromMicros(micros) {
  if (micros === null || micros === undefined) return 'N/D';
  return fmtMoney(micros / 1_000_000);
}
// A diferencia de fmtInt (que muestra "0" para null), acá null significa
// "Google no estima esta métrica con esta estrategia de puja" — confirmado
// contra una cuenta real: CPC manual/maximizar clics trae clics pero no
// conversiones, maximizar conversiones trae conversiones pero no clics.
// Mostrar "0" sería engañoso (parece que no va a traer nada, no que la
// métrica no aplica).
function fmtIntOrNA(n) {
  return (n === null || n === undefined) ? 'N/D' : fmtInt(n);
}
const KWP_MONTH_LABELS = {
  JANUARY: 'Ene', FEBRUARY: 'Feb', MARCH: 'Mar', APRIL: 'Abr', MAY: 'May', JUNE: 'Jun',
  JULY: 'Jul', AUGUST: 'Ago', SEPTEMBER: 'Sep', OCTOBER: 'Oct', NOVEMBER: 'Nov', DECEMBER: 'Dic',
};
// Mini gráfica de barras con Chart.js (sparkline) con la tendencia mensual
// de una keyword — una instancia chiquita por fila, sin ejes ni leyenda,
// con tooltip al pasar el mouse en vez del title="" de antes.
function mountSparklineChart(canvasId, volumes) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !window.Chart || !volumes || !volumes.length) return;
  const ctx = canvas.getContext('2d');
  const chart = new window.Chart(ctx, {
    type: 'bar',
    data: {
      labels: volumes.map((v) => (KWP_MONTH_LABELS[v.month] || v.month).slice(0, 1)),
      datasets: [{
        data: volumes.map((v) => v.monthly_searches || 0),
        backgroundColor: resolveChartColor('var(--navy-800)'),
        borderRadius: 2,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 350 },
      layout: { padding: 2 },
      scales: {
        y: { display: false, grid: { display: false } },
        x: { grid: { display: false }, ticks: { font: { size: 8.5 }, color: cssVar('--color-text-muted') || '#666' } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar('--navy-900') || '#0f172a',
          padding: 8,
          cornerRadius: 6,
          displayColors: false,
          callbacks: {
            title: (items) => {
              const v = volumes[items[0].dataIndex];
              return `${KWP_MONTH_LABELS[v.month] || v.month} ${v.year}`;
            },
            label: (item) => fmtInt(item.parsed.y) + ' búsquedas',
          },
        },
      },
    },
  });
  chartRegistry[canvasId] = chart;
}

// Barra horizontal con Chart.js (mismo patrón que Rendimiento/ROAS — ver
// mountHorizontalBarChart) con el top de keywords por volumen de búsqueda,
// para ver de un vistazo las de más oportunidad sin leer toda la tabla. El
// color de la barra es el mismo de la competencia (rojo=alta, verde=baja).
const KWP_COMPETITION_BAR_COLOR = { HIGH: 'var(--danger)', MEDIUM: 'var(--navy-800)', LOW: 'var(--ok-text)' };
function getKeywordPlannerTop10(rows) {
  return [...rows].sort((a, b) => (b.avg_monthly_searches || 0) - (a.avg_monthly_searches || 0)).slice(0, 10);
}
function renderKeywordPlannerVolumeChart(rows, title, canvasId) {
  if (!rows.length) return '';
  const top = getKeywordPlannerTop10(rows);
  return `
    <div class="card table-panel" style="margin-bottom:20px">
      <h3 class="dense-chart-title">${escapeHtml(title)}</h3>
      <div style="height:${Math.max(240, top.length * 34)}px"><canvas id="${canvasId}"></canvas></div>
    </div>`;
}

// Solo limpia RESULTADOS ya traídos de la cuenta anterior (para no
// mostrarlos pegados a la cuenta nueva, el mismo bug que ya se corrigió en
// IA Max) — no toca lo que el usuario ya escribió (keywords, fechas,
// presupuesto), que sigue siendo válido sin importar qué cuenta elija.
function resetKeywordPlannerAccountData() {
  const s = state.keywordPlanner;
  s.languages = { status: 'idle', list: [], selectedResourceName: '', error: null };
  s.ideas.status = 'idle'; s.ideas.error = null; s.ideas.rows = null; s.ideas.totalSize = 0;
  s.historico.status = 'idle'; s.historico.error = null; s.historico.rows = null; s.historico.modalKeyword = null;
  s.pronostico.status = 'idle'; s.pronostico.error = null; s.pronostico.result = null;
}

function ensureKeywordPlannerStatusLoaded() {
  const a = state.keywordPlanner.api;
  if (a.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { a.statusChecked = true; a.configured = !!data.configured; render(); })
    .catch(() => { a.statusChecked = true; a.configured = false; render(); });
}

function loadKeywordPlannerAccounts() {
  const a = state.keywordPlanner.api;
  a.accountsStatus = 'loading'; a.error = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.accounts = data.accounts || [];
      a.simulated = !!data.simulated;
      a.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.accountsStatus = 'error'; a.error = err.message || String(err);
      render();
    });
}

function keywordPlannerCustomerId() {
  const a = state.keywordPlanner.api;
  const manualId = (a.accountIdManual || '').replace(/[^0-9]/g, '');
  return manualId || a.accountId;
}

function ensureKeywordPlannerLanguagesLoaded() {
  const s = state.keywordPlanner;
  const customerId = keywordPlannerCustomerId();
  if (s.languages.status !== 'idle') return;
  if (!s.api.statusChecked) return; // esperar a saber si la API real está configurada
  // Si la API real está configurada, hace falta elegir cuenta primero; si
  // no, el servidor siempre responde con datos simulados sin importar el
  // customer_id, así que no hay que esperar a que s.api.simulated se ponga
  // en true reactivamente (todavía no pasó ninguna llamada que lo confirme).
  if (!customerId && s.api.configured) return;
  s.languages.status = 'loading';
  const params = new URLSearchParams({ customer_id: customerId || '' });
  fetch(`/api/google-ads/keyword-planner/languages?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      s.languages.list = data.languages || [];
      s.languages.status = 'ready';
      if (!s.languages.selectedResourceName && s.languages.list.length) {
        const es = s.languages.list.find((l) => l.code === 'es');
        s.languages.selectedResourceName = (es || s.languages.list[0]).resource_name;
      }
      render();
    })
    .catch((err) => {
      s.languages.status = 'error'; s.languages.error = err.message || String(err);
      render();
    });
}

function searchKeywordPlannerGeo() {
  const g = state.keywordPlanner.geo;
  if (!g.query.trim()) { g.results = []; render(); return; }
  g.status = 'loading'; g.error = null;
  render();
  const params = new URLSearchParams({ q: g.query.trim() });
  fetch(`/api/google-ads/keyword-planner/geo-search?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      g.results = data.results || [];
      g.status = 'ready';
      render();
    })
    .catch((err) => {
      g.status = 'error'; g.error = err.message || String(err);
      render();
    });
}

function addKeywordPlannerGeo(resourceName, name, canonicalName) {
  const g = state.keywordPlanner.geo;
  if (g.selected.some((x) => x.resource_name === resourceName)) return;
  g.selected.push({ resource_name: resourceName, name, canonical_name: canonicalName });
  render();
}
function removeKeywordPlannerGeo(resourceName) {
  const g = state.keywordPlanner.geo;
  g.selected = g.selected.filter((x) => x.resource_name !== resourceName);
  render();
}

function fetchKeywordIdeas() {
  const s = state.keywordPlanner;
  const i = s.ideas;
  const customerId = keywordPlannerCustomerId();
  const seedKeywords = kwpParseKeywords(i.seedKeywords);
  const seedUrl = i.seedUrl.trim();
  if (!seedKeywords.length && !seedUrl) { i.error = 'Escribe al menos una keyword semilla o una URL.'; render(); return; }
  if (!customerId && !s.api.simulated) { i.error = 'Elige una cuenta primero.'; render(); return; }

  i.status = 'loading'; i.error = null;
  render();
  fetch('/api/google-ads/keyword-planner/ideas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: customerId,
      seed_keywords: seedKeywords,
      seed_url: seedUrl || null,
      geo_resource_names: s.geo.selected.map((g) => g.resource_name),
      language_resource_name: s.languages.selectedResourceName || null,
      network: s.network,
    }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      s.api.simulated = !!data.simulated;
      s.currency = data.currency || '';
      i.rows = data.rows || [];
      i.totalSize = data.total_size || i.rows.length;
      i.status = 'ready';
      render();
    })
    .catch((err) => {
      i.status = 'error'; i.error = err.message || String(err);
      render();
    });
}

const KWP_IDEAS_SORT_KEYS = {
  text: (r) => r.text.toLowerCase(),
  avg_monthly_searches: (r) => r.avg_monthly_searches || 0,
  competition_index: (r) => r.competition_index || 0,
  low_bid: (r) => r.low_top_of_page_bid_micros || 0,
  high_bid: (r) => r.high_top_of_page_bid_micros || 0,
};
function getKeywordIdeasSorted() {
  const i = state.keywordPlanner.ideas;
  const rows = [...(i.rows || [])];
  const keyFn = KWP_IDEAS_SORT_KEYS[i.sortBy] || KWP_IDEAS_SORT_KEYS.avg_monthly_searches;
  const dir = i.sortDir === 'desc' ? -1 : 1;
  if (i.sortBy === 'text') {
    rows.sort((a, b) => dir * keyFn(a).localeCompare(keyFn(b)));
  } else {
    rows.sort((a, b) => dir * (keyFn(a) - keyFn(b)));
  }
  return rows;
}
function kwpIdeasSortTh(label, key) {
  const i = state.keywordPlanner.ideas;
  const active = i.sortBy === key;
  const arrow = active ? (i.sortDir === 'desc' ? ' ▼' : ' ▲') : '';
  return `<th data-kwp-ideas-sort="${key}" style="cursor:pointer;user-select:none${active ? ';color:var(--color-text-heading)' : ''}">${escapeHtml(label)}${arrow}</th>`;
}

const KWP_HISTORICO_SORT_KEYS = {
  text: (r) => r.text.toLowerCase(),
  avg_monthly_searches: (r) => r.avg_monthly_searches || 0,
  low_bid: (r) => r.low_top_of_page_bid_micros || 0,
  high_bid: (r) => r.high_top_of_page_bid_micros || 0,
};
function getKeywordHistoricoSorted() {
  const h = state.keywordPlanner.historico;
  const rows = [...(h.rows || [])];
  const keyFn = KWP_HISTORICO_SORT_KEYS[h.sortBy] || KWP_HISTORICO_SORT_KEYS.avg_monthly_searches;
  const dir = h.sortDir === 'desc' ? -1 : 1;
  if (h.sortBy === 'text') {
    rows.sort((a, b) => dir * keyFn(a).localeCompare(keyFn(b)));
  } else {
    rows.sort((a, b) => dir * (keyFn(a) - keyFn(b)));
  }
  return rows;
}
function kwpHistoricoSortTh(label, key) {
  const h = state.keywordPlanner.historico;
  const active = h.sortBy === key;
  const arrow = active ? (h.sortDir === 'desc' ? ' ▼' : ' ▲') : '';
  return `<th data-kwp-historico-sort="${key}" style="cursor:pointer;user-select:none${active ? ';color:var(--color-text-heading)' : ''}">${escapeHtml(label)}${arrow}</th>`;
}

function fetchKeywordHistorical() {
  const s = state.keywordPlanner;
  const h = s.historico;
  const customerId = keywordPlannerCustomerId();
  const keywords = kwpParseKeywords(h.keywordsText);
  if (!keywords.length) { h.error = 'Escribe al menos una keyword.'; render(); return; }
  if (!customerId && !s.api.simulated) { h.error = 'Elige una cuenta primero.'; render(); return; }

  h.status = 'loading'; h.error = null;
  render();
  fetch('/api/google-ads/keyword-planner/historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: customerId,
      keywords,
      geo_resource_names: s.geo.selected.map((g) => g.resource_name),
      language_resource_name: s.languages.selectedResourceName || null,
      network: s.network,
    }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      s.api.simulated = !!data.simulated;
      s.currency = data.currency || '';
      h.rows = data.rows || [];
      h.status = 'ready';
      h.modalKeyword = null;
      render();
    })
    .catch((err) => {
      h.status = 'error'; h.error = err.message || String(err);
      render();
    });
}

function fetchKeywordForecast() {
  const s = state.keywordPlanner;
  const p = s.pronostico;
  const customerId = keywordPlannerCustomerId();
  const keywords = kwpParseKeywords(p.keywordsText);
  if (!keywords.length) { p.error = 'Escribe al menos una keyword.'; render(); return; }
  if (!p.startDate || !p.endDate) { p.error = 'Elige el rango de fechas del pronóstico.'; render(); return; }
  if (p.biddingMode === 'MANUAL_CPC' && !p.maxCpcBid) { p.error = 'Falta la puja máxima de CPC.'; render(); return; }
  if (p.biddingMode !== 'MANUAL_CPC' && !p.dailyTargetSpend) { p.error = 'Falta el gasto objetivo diario.'; render(); return; }
  if (!customerId && !s.api.simulated) { p.error = 'Elige una cuenta primero.'; render(); return; }

  p.status = 'loading'; p.error = null;
  render();
  fetch('/api/google-ads/keyword-planner/forecast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: customerId,
      keywords,
      match_type: p.matchType,
      geo_resource_names: s.geo.selected.map((g) => g.resource_name),
      language_resource_names: s.languages.selectedResourceName ? [s.languages.selectedResourceName] : [],
      bidding_mode: p.biddingMode,
      start_date: p.startDate,
      end_date: p.endDate,
      daily_budget: p.dailyBudget || null,
      max_cpc_bid: p.maxCpcBid || null,
      daily_target_spend: p.dailyTargetSpend || null,
      max_cpc_bid_ceiling: p.maxCpcBidCeiling || null,
      currency_code: p.currencyCode || null,
    }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      s.api.simulated = !!data.simulated;
      p.result = data;
      p.status = 'ready';
      render();
    })
    .catch((err) => {
      p.status = 'error'; p.error = err.message || String(err);
      render();
    });
}

function loadKwpMccGroups() {
  const m = state.keywordPlanner.api.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => { m.status = 'error'; m.error = err.message || String(err); render(); });
}

function applyKwpMccFilter(groupId, groupName) {
  const a = state.keywordPlanner.api;
  const m = a.mcc;
  m.selectedId = groupId; m.selectedName = groupName;
  m.accountIdsStatus = 'loading'; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(groupId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.accountIds = new Set((data.accounts || []).map((acc) => acc.id));
      m.accountIdsStatus = 'ready';
      if (a.accountId && !m.accountIds.has(a.accountId)) a.accountId = '';
      render();
    })
    .catch((err) => { m.accountIdsStatus = 'error'; m.error = err.message || String(err); render(); });
}

function clearKwpMccFilter() {
  const m = state.keywordPlanner.api.mcc;
  m.selectedId = ''; m.selectedName = ''; m.accountIds = null; m.accountIdsStatus = 'idle'; m.filter = '';
  render();
}

function renderKwpMccFilterPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.keywordPlanner.api.mcc;

  if (m.selectedId) {
    const countLabel = m.accountIdsStatus === 'loading' ? 'cargando…'
      : m.accountIdsStatus === 'ready' ? `${m.accountIds.size} cuenta(s)`
      : 'error';
    return `
      <div class="field">
        <label>Filtrando por MCC</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="delta-badge neutral">${escapeHtml(m.selectedName)} — ${countLabel}</span>
          <button class="btn-link" data-action="kwp-mcc-clear">Quitar filtro</button>
        </div>
      </div>`;
  }

  if (m.status === 'idle') {
    return `<div class="field"><button class="btn-outline sm" data-action="kwp-mcc-load">Filtrar por MCC (ej. una cadena de hoteles)</button></div>`;
  }
  if (m.status === 'loading') {
    return `<div class="field"><p class="footnote">Cargando agrupaciones del MCC…</p></div>`;
  }
  if (m.status === 'error') {
    return `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  }

  const filter = (m.filter || '').trim().toLowerCase();
  let matches = [];
  if (filter.length >= 2) {
    matches = m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25);
  }
  const matchesHtml = matches.length
    ? `<div class="table-scroll" style="max-height:200px;margin-top:8px">
        <table><tbody>
          ${matches.map((g) => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
              <td><button class="btn-outline xs" data-kwp-mcc-pick="${escapeHtml(g.id)}" data-kwp-mcc-pick-name="${escapeHtml(g.name)}">Usar</button></td>
            </tr>`).join('')}
        </tbody></table>
      </div>`
    : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');

  return `
    <div class="field">
      <label>Filtrar por MCC</label>
      <input type="text" id="kwp-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:320px" />
      ${matchesHtml}
    </div>`;
}

function renderKeywordPlannerApiPanel() {
  const a = state.keywordPlanner.api;

  if (!a.statusChecked) {
    return `<div class="field"><p class="footnote">Consultando la conexión con Google Ads…</p></div>`;
  }

  const simulatedNotice = a.simulated ? `
    <div class="ok-panel" style="margin:10px 0">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor
      (falta la aprobación del developer token de Google) — estos son datos de ejemplo, no de una cuenta real.
    </div>` : '';

  if (a.accountsStatus === 'idle') {
    return `
      <div class="card control-panel align-end">
        <div class="field">
          <p class="footnote">${a.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.'}</p>
          <button class="btn-outline" data-action="kwp-api-load-accounts">Ver cuentas disponibles</button>
        </div>
      </div>`;
  }
  if (a.accountsStatus === 'loading') {
    return `<div class="card control-panel align-end"><div class="field"><p class="footnote">Cargando cuentas…</p></div></div>`;
  }
  if (a.accountsStatus === 'error') {
    return `<div class="error-panel"><strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(a.error)}</div>`;
  }

  const mccFilterActive = a.mcc.selectedId && a.mcc.accountIds;
  const visibleAccounts = mccFilterActive ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
  const accountOptions = ['<option value="">Elige una cuenta…</option>']
    .concat(visibleAccounts.map((acc) => `<option value="${escapeHtml(acc.id)}" ${a.accountId === acc.id ? 'selected' : ''}>${escapeHtml(acc.name)} (${escapeHtml(acc.id)})</option>`))
    .join('');

  return `
    <div class="card control-panel align-end">
      ${simulatedNotice}
      ${renderKwpMccFilterPanel()}
      <div class="field">
        <label>Cuenta${mccFilterActive ? ` (${visibleAccounts.length} en "${escapeHtml(a.mcc.selectedName)}")` : ''}</label>
        <select id="kwp-api-account" style="width:320px">${accountOptions}</select>
      </div>
      <div class="field">
        <label>...o escribe el ID de la cuenta</label>
        <input type="text" id="kwp-api-account-manual" value="${escapeHtml(a.accountIdManual)}" placeholder="ej. 6862893390" style="width:160px" />
      </div>
      ${a.error ? `<div class="error-panel" style="margin-top:10px">${escapeHtml(a.error)}</div>` : ''}
    </div>`;
}

function renderKeywordPlannerGeoLangPanel() {
  const s = state.keywordPlanner;
  const g = s.geo;
  ensureKeywordPlannerLanguagesLoaded();

  const geoResultsHtml = g.results.length ? `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
      ${g.results.map((r) => `<button class="btn-outline xs" data-kwp-geo-add="${escapeHtml(r.resource_name)}" data-kwp-geo-name="${escapeHtml(r.name)}" data-kwp-geo-canonical="${escapeHtml(r.canonical_name || r.name)}">+ ${escapeHtml(r.canonical_name || r.name)}</button>`).join('')}
    </div>` : (g.status === 'ready' ? '<p class="footnote">Sin resultados para esa búsqueda.</p>' : '');

  const selectedHtml = g.selected.length ? `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      ${g.selected.map((sel) => `<span class="delta-badge good" style="display:inline-flex;align-items:center;gap:6px">${escapeHtml(sel.canonical_name || sel.name)} <button data-kwp-geo-remove="${escapeHtml(sel.resource_name)}" style="border:none;background:none;cursor:pointer;color:inherit;font-weight:700">×</button></span>`).join('')}
    </div>` : `<p class="footnote" style="margin-top:8px">Sin geo-segmentación — Google usará su alcance por defecto (todo el mundo).</p>`;

  const languageOptions = ['<option value="">(automático)</option>']
    .concat((s.languages.list || []).map((l) => `<option value="${escapeHtml(l.resource_name)}" ${s.languages.selectedResourceName === l.resource_name ? 'selected' : ''}>${escapeHtml(l.name)}</option>`))
    .join('');

  return `
    <div class="card control-panel" style="margin-bottom:20px">
      <div class="field">
        <label>Buscar geo-segmentación (país, ciudad, región)</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="kwp-geo-query" value="${escapeHtml(g.query)}" placeholder="ej. Colombia, Bogotá" style="width:260px" />
          <button class="btn-outline sm" data-action="kwp-geo-search" ${g.status === 'loading' ? 'disabled' : ''}>Buscar</button>
        </div>
        ${g.error ? `<div class="error-panel" style="margin-top:8px">${escapeHtml(g.error)}</div>` : ''}
        ${geoResultsHtml}
        ${selectedHtml}
      </div>
      <div class="field" style="margin-top:14px">
        <label>Idioma</label>
        <select id="kwp-language-select" style="width:260px">${languageOptions}</select>
      </div>
      <div class="field" style="margin-top:14px">
        <label>Red</label>
        <div class="seg-control">
          <button class="seg-btn ${s.network === 'GOOGLE_SEARCH' ? 'active' : ''}" data-action="kwp-network-search">Solo Google Search</button>
          <button class="seg-btn ${s.network === 'GOOGLE_SEARCH_AND_PARTNERS' ? 'active' : ''}" data-action="kwp-network-partners">Search + Partners</button>
        </div>
      </div>
    </div>`;
}

function renderKeywordPlannerIdeasTab() {
  const i = state.keywordPlanner.ideas;
  return `
    <div class="card table-panel" style="margin-bottom:20px">
      <h3 class="dense-chart-title">Descubre nuevas palabras clave</h3>
      <p style="margin:0 0 12px;font-size:12.5px;color:var(--color-text-muted)">Escribe keywords semilla (una por línea), una URL, o ambas — Google sugiere ideas relacionadas con volumen de búsqueda y competencia.</p>
      <div class="field" style="margin-bottom:10px">
        <label>Keywords semilla (una por línea)</label>
        <textarea id="kwp-ideas-seed-keywords" rows="4" style="width:100%;font-family:inherit" placeholder="hotel en cartagena&#10;hoteles todo incluido">${escapeHtml(i.seedKeywords)}</textarea>
      </div>
      <div class="field" style="margin-bottom:12px">
        <label>...o una URL (landing, sitio del cliente)</label>
        <input type="text" id="kwp-ideas-seed-url" value="${escapeHtml(i.seedUrl)}" placeholder="https://..." style="width:100%" />
      </div>
      <button class="btn-accent" data-action="kwp-ideas-fetch" ${i.status === 'loading' ? 'disabled' : ''}>Buscar ideas</button>
      ${i.error ? `<div class="error-panel" style="margin-top:10px">${escapeHtml(i.error)}</div>` : ''}
    </div>
    ${renderKeywordPlannerIdeasResults()}`;
}

function renderKeywordPlannerIdeasResults() {
  const i = state.keywordPlanner.ideas;
  if (i.status === 'loading') {
    return `<div class="card state-panel loading"><div class="spinner"></div><p>Buscando ideas…</p></div>`;
  }
  if (i.rows === null) return '';
  if (!i.rows.length) {
    return `<div class="ok-panel">Sin resultados para esta búsqueda.</div>`;
  }
  const rows = getKeywordIdeasSorted();
  const rowsHtml = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.text)}</td>
      <td>${fmtInt(r.avg_monthly_searches)}</td>
      <td>${kwpCompetitionBadge(r.competition)}</td>
      <td>${r.competition_index !== null && r.competition_index !== undefined ? r.competition_index : 'N/D'}</td>
      <td>${fmtMoneyFromMicros(r.low_top_of_page_bid_micros)}</td>
      <td>${fmtMoneyFromMicros(r.high_top_of_page_bid_micros)}</td>
    </tr>`).join('');
  return `
    ${renderKeywordPlannerVolumeChart(rows, 'Top 10 por volumen de búsqueda', 'kwp-chart-volume')}
    <div class="card table-panel">
      <div class="table-panel-head">
        <h3>Ideas (${rows.length}${i.totalSize > rows.length ? ` de ${fmtInt(i.totalSize)}` : ''})</h3>
        <button class="btn-outline sm" data-action="download-kwp-ideas">Descargar CSV</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr>
            ${kwpIdeasSortTh('Keyword', 'text')}
            ${kwpIdeasSortTh('Búsquedas prom./mes', 'avg_monthly_searches')}
            <th>Competencia</th>
            ${kwpIdeasSortTh('Índice', 'competition_index')}
            ${kwpIdeasSortTh('Puja baja', 'low_bid')}
            ${kwpIdeasSortTh('Puja alta', 'high_bid')}
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="footnote" style="margin-top:14px">Puja baja/alta = rango estimado para aparecer arriba de la página de resultados, no lo que vas a pagar necesariamente.</p>
    </div>`;
}

function renderKeywordPlannerHistoricoTab() {
  const h = state.keywordPlanner.historico;
  let resultsHtml = '';
  if (h.status === 'loading') {
    resultsHtml = `<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo histórico…</p></div>`;
  } else if (h.rows !== null) {
    if (!h.rows.length) {
      resultsHtml = `<div class="ok-panel">Sin datos históricos para estas keywords.</div>`;
    } else {
      const sortedRows = getKeywordHistoricoSorted();
      const rowsHtml = sortedRows.map((r, idx) => `
        <tr>
          <td><button class="btn-link" data-kwp-historico-open="${escapeHtml(r.text)}">${escapeHtml(r.text)}</button></td>
          <td>${fmtInt(r.avg_monthly_searches)}</td>
          <td>${kwpCompetitionBadge(r.competition)}</td>
          <td>${fmtMoneyFromMicros(r.low_top_of_page_bid_micros)}</td>
          <td>${fmtMoneyFromMicros(r.high_top_of_page_bid_micros)}</td>
          <td><div style="width:110px;height:40px"><canvas id="kwp-trend-${idx}"></canvas></div></td>
        </tr>`).join('');
      resultsHtml = `
        <div class="card table-panel">
          <div class="table-panel-head">
            <h3>Histórico (${h.rows.length})</h3>
            <button class="btn-outline sm" data-action="download-kwp-historico">Descargar CSV</button>
          </div>
          <div class="table-scroll">
            <table>
              <thead><tr>
                ${kwpHistoricoSortTh('Keyword', 'text')}
                ${kwpHistoricoSortTh('Búsquedas prom./mes', 'avg_monthly_searches')}
                <th>Competencia</th>
                ${kwpHistoricoSortTh('Puja baja', 'low_bid')}
                ${kwpHistoricoSortTh('Puja alta', 'high_bid')}
                <th>Tendencia mensual</th>
              </tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>`;
    }
  }
  return `
    <div class="card table-panel" style="margin-bottom:20px">
      <h3 class="dense-chart-title">Métricas históricas</h3>
      <p style="margin:0 0 12px;font-size:12.5px;color:var(--color-text-muted)">Pega las keywords que ya tienes (una por línea) para ver su volumen de búsqueda mes a mes de los últimos 12 meses.</p>
      <div class="field" style="margin-bottom:12px">
        <label>Keywords (una por línea)</label>
        <textarea id="kwp-historico-keywords" rows="5" style="width:100%;font-family:inherit" placeholder="hotel en cartagena&#10;hoteles todo incluido cartagena">${escapeHtml(h.keywordsText)}</textarea>
      </div>
      <button class="btn-accent" data-action="kwp-historico-fetch" ${h.status === 'loading' ? 'disabled' : ''}>Traer histórico</button>
      ${h.error ? `<div class="error-panel" style="margin-top:10px">${escapeHtml(h.error)}</div>` : ''}
    </div>
    ${resultsHtml}
    ${renderKeywordHistoricoModal()}`;
}

// Ventana flotante con el detalle completo de una keyword del histórico —
// se abre al hacer click sobre la keyword en la tabla. Reutiliza la misma
// keyword (texto) como llave en vez del índice de fila para que sobreviva
// a un resort de la tabla mientras está abierta.
function renderKeywordHistoricoModal() {
  const h = state.keywordPlanner.historico;
  if (!h.modalKeyword || !h.rows) return '';
  const row = h.rows.find((r) => r.text === h.modalKeyword);
  if (!row) return '';
  return `
    <div class="modal-overlay">
      <div class="modal-box card" data-modal-stop-propagation>
        <button class="modal-close" data-action="kwp-historico-close" aria-label="Cerrar">${icon('x', 18)}</button>
        <h3 class="dense-chart-title" style="margin:0 0 16px;padding-right:28px">${escapeHtml(row.text)}</h3>
        <div class="stat-grid">
          <div class="card stat-card"><div class="stat-label">Búsquedas prom./mes</div><div class="stat-value">${fmtInt(row.avg_monthly_searches)}</div></div>
          <div class="card stat-card"><div class="stat-label">Competencia</div><div class="stat-value" style="font-size:18px">${kwpCompetitionBadge(row.competition)}</div></div>
          <div class="card stat-card"><div class="stat-label">Índice de competencia</div><div class="stat-value">${fmtIntOrNA(row.competition_index)}</div></div>
          <div class="card stat-card"><div class="stat-label">Puja baja</div><div class="stat-value">${fmtMoneyFromMicros(row.low_top_of_page_bid_micros)}</div></div>
          <div class="card stat-card"><div class="stat-label">Puja alta</div><div class="stat-value">${fmtMoneyFromMicros(row.high_top_of_page_bid_micros)}</div></div>
        </div>
        <h4 style="margin:0 0 10px;font-size:12.5px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.04em">Tendencia mensual (últimos 12 meses)</h4>
        <div style="height:260px"><canvas id="kwp-modal-trend-chart"></canvas></div>
      </div>
    </div>`;
}

// Versión grande (con ejes, meses completos y datalabels) del mismo gráfico
// de tendencia que la sparkline de la tabla — ver mountSparklineChart.
function mountKeywordHistoricoModalChart() {
  const h = state.keywordPlanner.historico;
  if (!h.modalKeyword || !h.rows) return;
  const row = h.rows.find((r) => r.text === h.modalKeyword);
  const canvas = document.getElementById('kwp-modal-trend-chart');
  if (!row || !canvas || !window.Chart || !row.monthly_search_volumes || !row.monthly_search_volumes.length) return;
  const volumes = row.monthly_search_volumes;
  const chart = new window.Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: volumes.map((v) => `${KWP_MONTH_LABELS[v.month] || v.month} ${String(v.year).slice(2)}`),
      datasets: [{
        data: volumes.map((v) => v.monthly_searches || 0),
        backgroundColor: resolveChartColor('var(--navy-800)'),
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 350 },
      layout: { padding: { top: 24 } },
      scales: {
        y: { display: false, grid: { display: false } },
        x: { grid: { display: false }, ticks: { font: { size: 11 }, color: cssVar('--color-text-muted') || '#666' } },
      },
      plugins: {
        legend: { display: false },
        datalabels: {
          anchor: 'end', align: 'top', color: cssVar('--color-text-heading') || '#14213d',
          font: { size: 10.5, weight: '600' },
          formatter: (v) => fmtInt(v),
        },
        tooltip: {
          backgroundColor: cssVar('--navy-900') || '#0f172a',
          padding: 8,
          cornerRadius: 6,
          displayColors: false,
          callbacks: { label: (item) => fmtInt(item.parsed.y) + ' búsquedas' },
        },
      },
    },
    plugins: window.ChartDataLabels ? [window.ChartDataLabels] : [],
  });
  chartRegistry['kwp-modal-trend-chart'] = chart;
}

function renderKeywordPlannerPronosticoTab() {
  const p = state.keywordPlanner.pronostico;
  const biddingFieldsHtml = p.biddingMode === 'MANUAL_CPC' ? `
      <div class="field">
        <label>Presupuesto diario (opcional)</label>
        <input type="number" id="kwp-pronostico-daily-budget" value="${escapeHtml(p.dailyBudget)}" placeholder="ej. 50000" style="width:160px" />
      </div>
      <div class="field">
        <label>Puja máxima de CPC</label>
        <input type="number" id="kwp-pronostico-max-cpc" value="${escapeHtml(p.maxCpcBid)}" placeholder="ej. 1500" style="width:160px" />
      </div>` : `
      <div class="field">
        <label>Gasto objetivo diario</label>
        <input type="number" id="kwp-pronostico-daily-target" value="${escapeHtml(p.dailyTargetSpend)}" placeholder="ej. 50000" style="width:160px" />
      </div>
      ${p.biddingMode === 'MAXIMIZE_CLICKS' ? `
      <div class="field">
        <label>Techo de puja CPC (opcional)</label>
        <input type="number" id="kwp-pronostico-max-cpc-ceiling" value="${escapeHtml(p.maxCpcBidCeiling)}" placeholder="ej. 1500" style="width:160px" />
      </div>` : ''}`;

  let resultHtml = '';
  if (p.status === 'loading') {
    resultHtml = `<div class="card state-panel loading"><div class="spinner"></div><p>Generando pronóstico…</p></div>`;
  } else if (p.status === 'ready' && p.result) {
    const r = p.result;
    resultHtml = `
      <div class="card table-panel">
        <div class="table-panel-head">
          <h3>Pronóstico estimado</h3>
          <button class="btn-outline sm" data-action="download-kwp-pronostico">Descargar CSV</button>
        </div>
        <div class="stat-grid">
          <div class="card stat-card"><div class="stat-label">Clics</div><div class="stat-value">${fmtIntOrNA(r.clicks)}</div></div>
          <div class="card stat-card"><div class="stat-label">Costo</div><div class="stat-value">${fmtMoneyFromMicros(r.cost_micros)}</div></div>
          <div class="card stat-card"><div class="stat-label">Conversiones</div><div class="stat-value">${fmtIntOrNA(r.conversions)}</div></div>
          <div class="card stat-card"><div class="stat-label">CPC promedio</div><div class="stat-value">${fmtMoneyFromMicros(r.average_cpc_micros)}</div></div>
          <div class="card stat-card"><div class="stat-label">CPA promedio</div><div class="stat-value">${fmtMoneyFromMicros(r.average_cpa_micros)}</div></div>
        </div>
        <p class="footnote" style="margin-top:14px">Estimado para ESTA combinación puntual de keywords, geo, presupuesto y estrategia — no es una curva ni una optimización automática (Performance Planner no tiene API pública). "N/D" = Google no estima esa métrica con la estrategia de puja elegida (ej. "Maximizar conversiones" no estima clics, "CPC manual" no estima conversiones).</p>
      </div>`;
  }

  return `
    <div class="card table-panel" style="margin-bottom:20px">
      <h3 class="dense-chart-title">Pronóstico</h3>
      <p style="margin:0 0 12px;font-size:12.5px;color:var(--color-text-muted)">Arma una campaña hipotética con estas keywords y una estrategia de puja, y estima clics/costo/conversiones para el rango de fechas elegido.</p>
      <div class="field" style="margin-bottom:12px">
        <label>Keywords (una por línea)</label>
        <textarea id="kwp-pronostico-keywords" rows="4" style="width:100%;font-family:inherit" placeholder="hotel en cartagena&#10;hoteles todo incluido cartagena">${escapeHtml(p.keywordsText)}</textarea>
      </div>
      <div class="control-panel align-end" style="margin-bottom:12px;padding:0">
        <div class="field">
          <label>Concordancia</label>
          <select id="kwp-pronostico-match-type" style="width:160px">
            <option value="BROAD" ${p.matchType === 'BROAD' ? 'selected' : ''}>Amplia</option>
            <option value="PHRASE" ${p.matchType === 'PHRASE' ? 'selected' : ''}>Frase</option>
            <option value="EXACT" ${p.matchType === 'EXACT' ? 'selected' : ''}>Exacta</option>
          </select>
        </div>
        <div class="field">
          <label>Estrategia de puja</label>
          <select id="kwp-pronostico-bidding-mode" style="width:220px">
            <option value="MAXIMIZE_CONVERSIONS" ${p.biddingMode === 'MAXIMIZE_CONVERSIONS' ? 'selected' : ''}>Maximizar conversiones</option>
            <option value="MAXIMIZE_CLICKS" ${p.biddingMode === 'MAXIMIZE_CLICKS' ? 'selected' : ''}>Maximizar clics</option>
            <option value="MANUAL_CPC" ${p.biddingMode === 'MANUAL_CPC' ? 'selected' : ''}>CPC manual</option>
          </select>
        </div>
        ${biddingFieldsHtml}
        <div class="field">
          <label>Desde</label>
          <input type="date" id="kwp-pronostico-start-date" value="${escapeHtml(p.startDate)}" style="width:160px" />
        </div>
        <div class="field">
          <label>Hasta</label>
          <input type="date" id="kwp-pronostico-end-date" value="${escapeHtml(p.endDate)}" style="width:160px" />
        </div>
        <div class="field">
          <label>Moneda (opcional)</label>
          <input type="text" id="kwp-pronostico-currency" value="${escapeHtml(p.currencyCode)}" placeholder="ej. COP" style="width:100px" />
        </div>
      </div>
      <button class="btn-accent" data-action="kwp-pronostico-fetch" ${p.status === 'loading' ? 'disabled' : ''}>Generar pronóstico</button>
      ${p.error ? `<div class="error-panel" style="margin-top:10px">${escapeHtml(p.error)}</div>` : ''}
    </div>
    ${resultHtml}`;
}

function renderKeywordPlannerPage() {
  return withMoneyCurrency(state.keywordPlanner.tab === 'pronostico' ? state.keywordPlanner.pronostico.currencyCode : state.keywordPlanner.currency, () => renderKeywordPlannerPageBody());
}

function renderKeywordPlannerPageBody() {
  const s = state.keywordPlanner;
  ensureKeywordPlannerStatusLoaded();

  if (!s.pronostico.startDate) {
    const today = new Date();
    const in30 = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    s.pronostico.startDate = today.toISOString().slice(0, 10);
    s.pronostico.endDate = in30.toISOString().slice(0, 10);
  }

  const controlPanel = renderKeywordPlannerApiPanel();
  const geoLangPanel = renderKeywordPlannerGeoLangPanel();

  const tabs = `
    <div class="seg-control" style="margin-bottom:20px">
      <button class="seg-btn ${s.tab === 'ideas' ? 'active' : ''}" data-action="kwp-tab-ideas">Descubre keywords</button>
      <button class="seg-btn ${s.tab === 'historico' ? 'active' : ''}" data-action="kwp-tab-historico">Histórico</button>
      <button class="seg-btn ${s.tab === 'pronostico' ? 'active' : ''}" data-action="kwp-tab-pronostico">Pronóstico</button>
    </div>`;

  let body = '';
  if (s.tab === 'ideas') body = renderKeywordPlannerIdeasTab();
  else if (s.tab === 'historico') body = renderKeywordPlannerHistoricoTab();
  else body = renderKeywordPlannerPronosticoTab();

  return `${controlPanel}${geoLangPanel}${tabs}${body}`;
}

// ---------------------------------------------------------------------------
// Página — Administración (solo is_admin)
// ---------------------------------------------------------------------------

function fmtDateTime(epochSeconds) {
  if (!epochSeconds) return 'N/D';
  return new Date(epochSeconds * 1000).toLocaleString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ensureAdminDataLoaded() {
  if (currentUser.isSuperAdmin && state.admin.usage.status === 'idle') loadAdminAiUsage();
  if (state.admin.usersStatus === 'idle') loadAdminUsers();
  if (state.admin.accessStatus === 'idle') loadAdminAccess();
}

function loadAdminAiUsage() {
  const u = state.admin.usage;
  u.status = 'loading'; u.error = null;
  render();
  fetch(`/api/admin/ai-usage?days=${u.days}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      u.rows = data.rows || []; u.meta = data; u.status = 'ready';
      render();
    })
    .catch((err) => { u.status = 'error'; u.error = err.message || String(err); render(); });
}

const AI_FEATURE_LABELS = { negativizacion: 'Negativización', auditoria: 'Auditoría', rendimiento: 'Rendimiento', copys: 'Copys', hoteles: 'Hoteles' };

// Consumo de la IA por día, por usuario y por función. El costo es una estimación con los precios de lista
// del modelo (el servidor manda los precios), no lo que factura Anthropic.
function renderAdminAiUsage() {
  const u = state.admin.usage;
  const usd = (n) => '$' + (n < 1 && n > 0 ? n.toFixed(3) : n.toFixed(2));
  const periodButtons = [7, 30, 90].map((d) => `<button class="seg-btn ${u.days === d ? 'active' : ''}" data-action="admin-ai-usage-${d}">${d} días</button>`).join('');
  const head = `
    <div class="table-panel-head">
      <h3>Uso de la IA</h3>
      <div class="seg-control">${periodButtons}</div>
    </div>`;
  if (u.status === 'loading' || u.status === 'idle') {
    return `<div class="card table-panel" style="margin-bottom:16px">${head}<div class="state-panel loading"><div class="spinner"></div><p>Cargando el consumo…</p></div></div>`;
  }
  if (u.status === 'error') {
    return `<div class="card table-panel" style="margin-bottom:16px">${head}<div class="error-panel">${escapeHtml(u.error)}</div></div>`;
  }

  const rows = u.rows || [];
  const sum = (list, key) => list.reduce((t, r) => t + (r[key] || 0), 0);
  const group = (keyFn) => {
    const m = new Map();
    rows.forEach((r) => {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, { key: k, calls: 0, input: 0, output: 0, cost: 0 });
      const g = m.get(k);
      g.calls += r.calls; g.input += r.input_tokens; g.output += r.output_tokens; g.cost += r.cost_usd;
    });
    return [...m.values()];
  };
  const total = { calls: sum(rows, 'calls'), input: sum(rows, 'input_tokens'), output: sum(rows, 'output_tokens'), cost: sum(rows, 'cost_usd') };
  const byDay = group((r) => r.day).sort((x, y) => (x.key < y.key ? 1 : -1));
  const byUser = group((r) => r.username).sort((x, y) => y.cost - x.cost);
  const byFeature = group((r) => r.feature).sort((x, y) => y.cost - x.cost);
  const activeDays = byDay.length;
  const avgDay = activeDays ? total.cost / activeDays : 0;
  const tokensCell = (g) => `${fmtInt(g.input)} / ${fmtInt(g.output)}`;
  const tableRows = (list, label) => list.map((g) => `<tr><td>${escapeHtml(label ? label(g.key) : g.key)}</td><td>${fmtInt(g.calls)}</td><td>${tokensCell(g)}</td><td>${usd(g.cost)}</td></tr>`).join('');
  const meta = u.meta || {};

  if (!rows.length) {
    return `<div class="card table-panel" style="margin-bottom:16px">${head}<p class="footnote">Todavía no hay consumo registrado en los últimos ${u.days} días. Se empieza a registrar con el primer análisis con IA después de este cambio.</p></div>`;
  }
  return `
    <div class="card table-panel" style="margin-bottom:16px">
      ${head}
      <div class="stat-grid" style="margin-bottom:14px">
        <div class="card stat-card"><div class="stat-label">Llamados</div><div class="stat-value lg">${fmtInt(total.calls)}</div><div class="stat-sub">${fmtInt(total.input)} tokens de entrada · ${fmtInt(total.output)} de salida</div></div>
        <div class="card stat-card accent"><div class="stat-label">Costo estimado</div><div class="stat-value lg">${usd(total.cost)}</div><div class="stat-sub">${total.calls ? usd(total.cost / total.calls) + ' por llamado' : ''}</div></div>
        <div class="card stat-card"><div class="stat-label">Promedio por día con uso</div><div class="stat-value lg">${usd(avgDay)}</div><div class="stat-sub">${fmtInt(activeDays)} día${activeDays === 1 ? '' : 's'} con uso · ≈ ${usd(avgDay * 22)} por 22 días laborables</div></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
        <div><h4 style="margin:0 0 6px">Por usuario</h4><div class="table-scroll" style="max-height:260px"><table>
          <thead><tr><th>Usuario</th><th>Llamados</th><th>Tokens (entr. / sal.)</th><th>Costo</th></tr></thead><tbody>${tableRows(byUser)}</tbody></table></div></div>
        <div><h4 style="margin:0 0 6px">Por función</h4><div class="table-scroll" style="max-height:260px"><table>
          <thead><tr><th>Función</th><th>Llamados</th><th>Tokens (entr. / sal.)</th><th>Costo</th></tr></thead><tbody>${tableRows(byFeature, (k) => AI_FEATURE_LABELS[k] || k)}</tbody></table></div></div>
        <div><h4 style="margin:0 0 6px">Por día</h4><div class="table-scroll" style="max-height:260px"><table>
          <thead><tr><th>Día</th><th>Llamados</th><th>Tokens (entr. / sal.)</th><th>Costo</th></tr></thead><tbody>${tableRows(byDay)}</tbody></table></div></div>
      </div>
      <p class="footnote" style="margin-top:12px">Costo estimado con los precios de lista de ${escapeHtml(meta.model || 'Claude')} (${usd(meta.price_input_per_million || 0)} por millón de tokens de entrada y ${usd(meta.price_output_per_million || 0)} de salida); no es lo que factura Anthropic. Los días son hora de Colombia. Cuenta también los llamados que terminaron en error, porque esos tokens se cobran igual.</p>
    </div>`;
}

function loadAdminUsers() {
  const a = state.admin;
  a.usersStatus = 'loading'; a.usersError = null;
  render();
  fetch('/api/admin/users')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.users = data.users || [];
      a.usersStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.usersStatus = 'error'; a.usersError = err.message || String(err);
      render();
    });
}

function loadAdminAccess() {
  const a = state.admin;
  a.accessStatus = 'loading'; a.accessError = null;
  render();
  fetch('/api/admin/access')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.access = data.access || [];
      a.mccAccess = data.mcc_access || [];
      a.accessStatus = 'ready';
      render();
    })
    .catch((err) => {
      a.accessStatus = 'error'; a.accessError = err.message || String(err);
      render();
    });
}

function deleteAdminUser(username) {
  if (!window.confirm(`¿Borrar la cuenta "${username}"? Esto también cierra cualquier sesión activa de inmediato. No se puede deshacer.`)) return;
  const a = state.admin;
  a.deleteStatus = 'loading'; a.deleteError = null;
  render();
  fetch('/api/admin/users/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.deleteStatus = 'idle';
      loadAdminUsers();
      loadAdminAccess();
    })
    .catch((err) => {
      a.deleteStatus = 'error'; a.deleteError = err.message || String(err);
      render();
    });
}

function setAdminRole(userId, username, makeAdmin) {
  const confirmMsg = makeAdmin
    ? `¿Hacer administrador a "${username}"? Va a poder ver y tocar todas las cuentas de Google Ads sin restricción, y usar el panel de administración.`
    : `¿Quitarle el permiso de administrador a "${username}"? Va a perder acceso a todas las cuentas salvo las que tenga asignadas explícitamente abajo.`;
  if (!window.confirm(confirmMsg)) return;
  const a = state.admin;
  a.setAdminStatus = 'loading'; a.setAdminError = null;
  render();
  fetch('/api/admin/users/set-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, is_admin: makeAdmin }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.setAdminStatus = 'idle';
      loadAdminUsers();
    })
    .catch((err) => {
      a.setAdminStatus = 'error'; a.setAdminError = err.message || String(err);
      render();
    });
}

function resetUserPassword(userId, username) {
  if (!window.confirm(`¿Restablecer la contraseña de "${username}"? Se genera una temporal, se cierra cualquier sesión que tenga abierta, y deberá definir una contraseña propia al volver a entrar.`)) return;
  const a = state.admin;
  a.resetPassword = { status: 'resetting', error: null, result: null };
  render();
  fetch('/api/admin/users/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.resetPassword = { status: 'idle', error: null, result: { username: data.username, temp_password: data.temp_password } };
      render();
    })
    .catch((err) => {
      a.resetPassword = { status: 'error', error: err.message || String(err), result: null };
      render();
    });
}

function loadAdminGrantAccounts() {
  const g = state.admin.grant;
  g.accountsStatus = 'loading'; g.accountsError = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      g.accounts = data.accounts || [];
      g.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      g.accountsStatus = 'error'; g.accountsError = err.message || String(err);
      render();
    });
}

function pickAdminGrantAccount(id, name) {
  const g = state.admin.grant;
  g.customerId = id;
  g.accountName = name;
  render();
}

function grantAdminAccess() {
  const g = state.admin.grant;
  const customerId = (g.customerId || '').replace(/[^0-9]/g, '');
  if (!g.userId) { g.error = 'Elige a qué usuario le vas a dar acceso.'; render(); return; }
  if (!customerId) { g.error = 'Escribe o elige el customer_id de la cuenta (solo números).'; render(); return; }

  g.status = 'granting'; g.error = null;
  render();
  fetch('/api/admin/access/grant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(g.userId), customer_id: customerId, account_name: g.accountName || null }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      g.status = 'idle';
      g.customerId = ''; g.accountName = '';
      loadAdminAccess();
    })
    .catch((err) => {
      g.status = 'error'; g.error = err.message || String(err);
      render();
    });
}

function loadAdminMccGroups() {
  const m = state.admin.mccGrant;
  m.groupsStatus = 'loading'; m.groupsError = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.groupsStatus = 'ready';
      render();
    })
    .catch((err) => {
      m.groupsStatus = 'error'; m.groupsError = err.message || String(err);
      render();
    });
}

// Elegir un MCC también cuenta cuántas cuentas tiene hoy — es la "vista
// previa" de lo que se va a otorgar antes de confirmar.
function pickAdminMcc(id, name) {
  const m = state.admin.mccGrant;
  m.pickedId = id; m.pickedName = name;
  m.countStatus = 'loading'; m.count = null; m.countError = null; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(id)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (m.pickedId !== id) return; // eligió otro MCC mientras cargaba
      m.count = (data.accounts || []).length;
      m.countStatus = 'ready';
      render();
    })
    .catch((err) => {
      if (m.pickedId !== id) return;
      m.countStatus = 'error'; m.countError = err.message || String(err);
      render();
    });
}

function grantAdminMcc() {
  const m = state.admin.mccGrant;
  if (!m.userId) { m.error = 'Elige a qué usuario le vas a dar acceso.'; render(); return; }
  if (!m.pickedId) { m.error = 'Busca y elige el MCC.'; render(); return; }
  if (!window.confirm(`¿Dar acceso a "${m.pickedName}" completo? El usuario podrá ver y modificar las ${m.count} cuentas que tiene hoy y las que se agreguen después a ese MCC.`)) return;
  m.status = 'granting'; m.error = null;
  render();
  fetch('/api/admin/access/grant-mcc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: Number(m.userId), mcc_customer_id: m.pickedId, mcc_name: m.pickedName || null }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.status = 'idle';
      m.pickedId = ''; m.pickedName = ''; m.count = null; m.countStatus = 'idle'; m.filter = '';
      loadAdminAccess();
    })
    .catch((err) => {
      m.status = 'error'; m.error = err.message || String(err);
      render();
    });
}

function revokeAdminMcc(userId, mccId) {
  if (!window.confirm('¿Quitarle el acceso a este MCC? Pierde el acceso a todas sus cuentas (salvo las que tenga asignadas una por una).')) return;
  const a = state.admin;
  a.revokeStatus = 'loading'; a.revokeError = null;
  render();
  fetch('/api/admin/access/revoke-mcc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, mcc_customer_id: mccId }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.revokeStatus = 'idle';
      loadAdminAccess();
    })
    .catch((err) => {
      a.revokeStatus = 'error'; a.revokeError = err.message || String(err);
      render();
    });
}

function revokeAdminAccess(userId, customerId) {
  if (!window.confirm('¿Quitarle el acceso a esta cuenta de Google Ads?')) return;
  const a = state.admin;
  a.revokeStatus = 'loading'; a.revokeError = null;
  render();
  fetch('/api/admin/access/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, customer_id: customerId }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.revokeStatus = 'idle';
      loadAdminAccess();
    })
    .catch((err) => {
      a.revokeStatus = 'error'; a.revokeError = err.message || String(err);
      render();
    });
}

// ---------------------------------------------------------------------------
// Página — Auditoría de cuenta
// ---------------------------------------------------------------------------
// Solo lectura. El servidor trae los datos de la cuenta con ~12 consultas y
// corre las reglas (account_audit.py); acá solo se pide, se muestra y se
// arma el informe descargable (HTML autocontenido y Markdown).

const AUDIT_SEVERITY_LABELS = { critico: 'Crítico', advertencia: 'Advertencia', info: 'Info' };
const AUDIT_FEED = { nose: 'No sé', si: 'Sí, uso feed de Hotel Center', no: 'No' };
const AUDIT_GOALS = { roas: 'ROAS objetivo (%)', cpa: 'CPA objetivo', volumen: 'Volumen de reservas' };

function auditMoney(v, cur) {
  if (v == null || Number.isNaN(v)) return 'N/D';
  return `${cur ? cur + ' ' : ''}${Math.round(v).toLocaleString('en-US')}`;
}

function ensureAuditStatusLoaded() {
  const a = state.audit.api;
  if (a.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { a.statusChecked = true; a.configured = !!data.configured; render(); })
    .catch(() => { a.statusChecked = true; a.configured = false; render(); });
}

function loadAuditAccounts() {
  const a = state.audit.api;
  a.accountsStatus = 'loading'; a.error = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.accounts = data.accounts || [];
      a.simulated = !!data.simulated;
      a.accountsStatus = 'ready';
      render();
    })
    .catch((err) => { a.accountsStatus = 'error'; a.error = err.message || String(err); render(); });
}

function loadAuditMccGroups() {
  const m = state.audit.api.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => { m.status = 'error'; m.error = err.message || String(err); render(); });
}

function applyAuditMccFilter(groupId, groupName) {
  const a = state.audit.api;
  const m = a.mcc;
  m.selectedId = groupId; m.selectedName = groupName;
  m.accountIdsStatus = 'loading'; m.error = null;
  render();
  fetch(`/api/google-ads/mcc-group-accounts?group_customer_id=${encodeURIComponent(groupId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.accountIds = new Set((data.accounts || []).map((acc) => acc.id));
      m.accountIdsStatus = 'ready';
      if (a.accountId && !m.accountIds.has(a.accountId)) a.accountId = '';
      render();
    })
    .catch((err) => { m.accountIdsStatus = 'error'; m.error = err.message || String(err); render(); });
}

function clearAuditMccFilter() {
  const m = state.audit.api.mcc;
  m.selectedId = ''; m.selectedName = ''; m.accountIds = null; m.accountIdsStatus = 'idle'; m.filter = '';
  render();
}

function renderAuditMccFilterPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.audit.api.mcc;
  if (m.selectedId) {
    const countLabel = m.accountIdsStatus === 'loading' ? 'cargando…' : m.accountIdsStatus === 'ready' ? `${m.accountIds.size} cuenta(s)` : 'error';
    return `
      <div class="field">
        <label>Filtrando por MCC</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="delta-badge neutral">${escapeHtml(m.selectedName)} — ${countLabel}</span>
          <button class="btn-link" data-action="audit-mcc-clear">Quitar filtro</button>
        </div>
      </div>`;
  }
  if (m.status === 'idle') return `<div class="field"><button class="btn-outline sm" data-action="audit-mcc-load">Filtrar por MCC (ej. una cadena de hoteles)</button></div>`;
  if (m.status === 'loading') return `<div class="field"><p class="footnote">Cargando agrupaciones del MCC…</p></div>`;
  if (m.status === 'error') return `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  const filter = (m.filter || '').trim().toLowerCase();
  const matches = filter.length >= 2 ? m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25) : [];
  const matchesHtml = matches.length
    ? `<div class="table-scroll" style="max-height:200px;margin-top:8px"><table><tbody>
        ${matches.map((g) => `<tr><td>${escapeHtml(g.name)}</td><td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
          <td><button class="btn-outline xs" data-audit-mcc-pick="${escapeHtml(g.id)}" data-audit-mcc-pick-name="${escapeHtml(g.name)}">Usar</button></td></tr>`).join('')}
      </tbody></table></div>`
    : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');
  return `<div class="field"><label>Filtrar por MCC</label>
    <input type="text" id="audit-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:320px" />
    ${matchesHtml}</div>`;
}

function auditCustomerId() {
  const a = state.audit.api;
  return (a.accountIdManual || '').replace(/[^0-9]/g, '') || a.accountId;
}

function runAudit() {
  const s = state.audit;
  const a = s.api;
  const customerId = auditCustomerId();
  if (!customerId && !a.simulated) { a.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }
  a.error = null;
  s.history = { status: 'idle', rows: null, error: null, customerId: '' };
  s.status = 'loading'; s.error = null; s.ai = { status: 'idle', narrativa: null, error: null };
  render();
  fetch('/api/google-ads/audit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId || '', days: Number(a.days), context: s.ctx }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      a.simulated = !!data.simulated;
      s.report = data.report;
      s.reportAccountName = (a.accounts.find((acc) => acc.id === customerId) || {}).name || data.report.meta.account_name || '';
      s.status = 'ready';
      render();
    })
    .catch((err) => { a.error = err.message || String(err); s.status = s.report ? 'ready' : 'idle'; render(); });
}

function runAuditAi() {
  const s = state.audit;
  const r = s.report;
  s.ai = { status: 'loading', narrativa: null, error: null };
  render();
  fetch('/api/ai/analizar-auditoria', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resumen: { puntaje: r.score, totales: r.summary },
      findings: r.findings.map((f) => ({ id: f.id, area: f.area, severidad: f.severity, titulo: f.title, detalle: f.detail, accion: f.action, evidencia: f.evidence, tipo: f.kind || '' })),
      no_verificables: r.not_verifiable,
      contexto: r.meta.context,
    }),
  })
    .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      s.ai = { status: 'ready', narrativa: data.narrativa, error: null };
      render();
    })
    .catch((err) => { s.ai = { status: 'error', narrativa: null, error: err.message || String(err) }; render(); });
}

function auditReportTitle() {
  const s = state.audit;
  return (s.report.meta.context.hotel_name || s.reportAccountName || `Cuenta ${s.report.meta.customer_id || ''}`).trim();
}

function auditFileName(ext) {
  const slug = auditReportTitle().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cuenta';
  return `auditoria-${slug}-${state.audit.report.meta.generated_at.slice(0, 10)}.${ext}`;
}

function downloadTextFile(content, filename, mime) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildAuditMarkdown() {
  const s = state.audit;
  const r = s.report;
  const cur = r.summary.currency;
  const m = r.meta;
  const lines = [];
  lines.push(`# Auditoría de cuenta — ${auditReportTitle()}`, '');
  lines.push(`- Cuenta: ${m.customer_id || 'N/D'}${m.account_name ? ` (${m.account_name})` : ''}`);
  lines.push(`- Periodo analizado: ${m.date_from} a ${m.date_to} (${r.summary.days} días)`);
  lines.push(`- Generada: ${m.generated_at.replace('T', ' ')}`);
  if (s.api.simulated) lines.push('- **Datos de ejemplo (modo simulado), no son de una cuenta real.**');
  lines.push('', `## Puntaje de salud: ${r.score.total}/100 — ${r.score.label}`, '');
  lines.push(`${r.score.critical} crítico(s), ${r.score.warnings} advertencia(s), ${r.score.info} informativo(s).`, '');
  lines.push('| Área | Puntaje | Críticos | Advertencias |', '|---|---|---|---|');
  Object.entries(r.score.by_area).forEach(([area, v]) => lines.push(`| ${area} | ${v.score} | ${v.critical} | ${v.warnings} |`));
  lines.push('', '## Cifras del periodo', '');
  lines.push(`- Gasto: ${auditMoney(r.summary.cost, cur)}`);
  lines.push(`- Conversiones: ${Math.round(r.summary.conversions)}`);
  lines.push(`- ROAS: ${r.summary.roas != null ? Math.round(r.summary.roas * 100) + '%' : 'N/D'}`);
  lines.push(`- CPA %: ${r.summary.cpa_pct != null ? `${(r.summary.cpa_pct * 100).toFixed(1)}%` : 'N/D'}`);
  lines.push(`- Campañas activas: ${r.summary.campaigns_enabled} de ${r.summary.campaigns_total}`);
  if (r.history && r.history.length) {
    const h = r.history, hp = h.length > 1 ? h[h.length - 2] : null;
    lines.push('', '## Evolución del puntaje', '');
    lines.push(hp ? `El puntaje ${h[h.length - 1].score - hp.score >= 0 ? (h[h.length - 1].score - hp.score === 0 ? 'se mantuvo igual' : `subió ${h[h.length - 1].score - hp.score}`) : `bajó ${hp.score - h[h.length - 1].score}`} frente a la auditoría del ${String(hp.at).slice(0, 16).replace('T', ' ')} (${hp.score} → ${h[h.length - 1].score}).` : 'Primera auditoría guardada de esta cuenta.');
    if (h.length > 1) { lines.push('', '| Fecha | Puntaje | Críticos | Advertencias |', '|---|---|---|---|'); [...h].reverse().slice(0, 8).forEach((x) => lines.push(`| ${String(x.at).slice(0, 16).replace('T', ' ')} | ${x.score} | ${x.critical} | ${x.warnings} |`)); }
  }
  if (s.ai.status === 'ready' && s.ai.narrativa) lines.push('', '## Lectura priorizada', '', s.ai.narrativa);
  ['critico', 'advertencia', 'info'].forEach((sev) => {
    const items = r.findings.filter((f) => f.severity === sev);
    if (!items.length) return;
    lines.push('', `## ${AUDIT_SEVERITY_LABELS[sev]}${sev === 'info' ? '' : 's'} (${items.length})`.replace('Críticos', 'Críticos').replace('Advertencias', 'Advertencias'));
    items.forEach((f) => {
      lines.push('', `### ${f.id} · ${f.title}`, '', `**Área:** ${f.area}${f.kind === 'oportunidad' ? ' · **Oportunidad**' : ''}`, '', f.detail, '', `**Qué hacer:** ${f.action}`);
      if (f.table) {
        lines.push('', `| ${f.table.columns.join(' | ')} |`, `|${f.table.columns.map(() => ' --- ').join('|')}|`, ...f.table.rows.map((r) => `| ${r.join(' | ')} |`));
      } else if (f.evidence.length) { lines.push('', ...f.evidence.map((e) => `- ${e}`)); }
    });
  });
  if (r.not_verifiable.length) {
    lines.push('', '## Revisiones que no se pudieron verificar', '');
    r.not_verifiable.forEach((n) => lines.push(`- **${n.id} · ${n.title}:** ${n.reason}`));
  }
  const ctx = m.context;
  lines.push('', '## Contexto indicado en el cuestionario', '');
  lines.push(`- Meta: ${AUDIT_GOALS[ctx.goal] || 'N/D'}${ctx.target ? ` — ${ctx.target}` : ''}`);
  lines.push('', '---', 'Informe generado con Paid Media Helper a partir de datos de Google Ads. Los umbrales son heurísticos y no reemplazan el criterio del estratega de cuenta.');
  return lines.join('\n');
}

// Diseño del informe — mismo estilo del "Checkin Scan" de Checkin Ads: donut
// de puntaje, barras por área, tarjetas de métricas, barra de distribución y
// tarjetas de oportunidades con prioridad. Una sola fuente de estilos: se
// inyecta en la pantalla y se incrusta tal cual en el HTML descargable.
const AUDIT_REPORT_CSS_CURRENT = `
.ar{font-family:'Plus Jakarta Sans','Inter',system-ui,-apple-system,sans-serif;color:#14213d;max-width:820px;margin:0 auto;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.ar *{box-sizing:border-box}
.ar-eyebrow{color:#d9a400;font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
.ar-title{font-size:38px;font-weight:800;line-height:1.1;margin:6px 0 4px;color:#14213d}
.ar-sub{color:#6b7280;font-size:14px;margin-bottom:22px}
.ar-card{background:#fff;border:1px solid #e3e6ec;border-radius:18px;padding:26px 28px}
.ar-score{display:flex;gap:30px;align-items:center;flex-wrap:wrap}
.ar-donut{position:relative;width:180px;height:180px;flex:none}
.ar-donut-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ar-donut-n{font-size:56px;font-weight:800;line-height:1}
.ar-donut-d{font-size:14px;color:#9aa1ad;margin-top:2px}
.ar-verdict{flex:1;min-width:240px}
.ar-verdict-k{display:flex;align-items:center;gap:8px;color:#d9a400;font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
.ar-verdict-i{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:2px solid currentColor;font-size:11px;line-height:1}
.ar-verdict-t{font-size:20px;font-weight:700;line-height:1.35;margin-top:8px}
.ar-verdict-s{font-size:14px;color:#8a919d;margin-top:8px}
.ar-bars{margin-top:26px;display:grid;gap:14px}
.ar-bar-row{display:flex;justify-content:space-between;font-size:14px;color:#8a919d}
.ar-bar-row strong{color:#14213d}
.ar-track{height:6px;border-radius:99px;background:#eef0f4;margin-top:6px;overflow:hidden}
.ar-fill{height:100%;border-radius:99px;background:#14213d}
.ar-h2{font-size:22px;font-weight:800;margin:34px 0 14px;color:#14213d;break-after:avoid;page-break-after:avoid}
.ar-block{break-inside:avoid;page-break-inside:avoid}
.ar-h2 small{font-size:14px;font-weight:500;color:#8a919d;margin-left:8px}
.ar-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.ar-metric{background:#fff;border:1px solid #e3e6ec;border-radius:16px;padding:20px 22px}
.ar-metric-l{font-size:14px;color:#8a919d}
.ar-metric-v{font-size:34px;font-weight:800;margin-top:6px;line-height:1.1}
.ar-metric-v.warn{color:#b98d00}
.ar-stack{display:flex;gap:3px;height:16px}
.ar-seg{border-radius:99px;min-width:6px}
.ar-legend{display:flex;gap:6px 20px;flex-wrap:wrap;margin-top:14px;font-size:14px;color:#8a919d}
.ar-legend strong{color:#14213d;margin-left:4px}
.ar-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.ar-opp{background:#fff;border:1px solid #e3e6ec;border-left:5px solid var(--c);border-radius:16px;padding:22px 24px;margin-bottom:14px;break-inside:avoid;page-break-inside:avoid}
.ar-pill{display:inline-block;padding:5px 12px;border-radius:8px;font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
.ar-opp-id{font-size:12px;color:#9aa1ad;margin-left:10px}
.ar-opp h3{font-size:20px;font-weight:800;margin:14px 0 6px;color:#14213d}
.ar-opp-d{color:#8a919d;font-size:16px;line-height:1.5;margin:0}
.ar-rec{background:#f4f5f8;border-radius:12px;padding:14px 16px;margin-top:14px;font-size:16px;line-height:1.5}
.ar-ev{margin:10px 0 0 18px;padding:0;color:#6b7280;font-size:14px;line-height:1.5}
.ar-tw{margin-top:12px;overflow-x:auto}
.ar-tbl{width:100%;border-collapse:collapse;font-size:14px;line-height:1.4}
.ar-tbl th{text-align:right;color:#6b7280;font-weight:700;padding:7px 10px;border-bottom:2px solid #e3e6ec;white-space:nowrap}
.ar-tbl td{text-align:right;padding:7px 10px;border-bottom:1px solid #eef0f4;color:#14213d;white-space:nowrap}
.ar-tbl th:first-child,.ar-tbl td:first-child{text-align:left;white-space:normal}
.ar-tbl td:first-child{font-weight:600}
.ar-tbl tr:last-child td{border-bottom:none}
.ar-ai{white-space:pre-wrap;font-size:16px;line-height:1.65}
.ar-nv{margin:0 0 0 18px;padding:0;color:#6b7280;font-size:14px;line-height:1.6}
.ar-note{background:#fdf3d9;border:1px solid #f2c419;border-radius:12px;padding:12px 16px;margin-bottom:18px;font-size:14px}
.ar-foot{text-align:center;color:#9aa1ad;font-size:13px;margin:34px 0 8px}
@media (max-width:640px){.ar-grid{grid-template-columns:1fr}.ar-title{font-size:30px}}
@media print{.ar{max-width:none;padding:0 3px}}
`;

const AUDIT_REPORT_CSS_ROIBACK = `
.ar{--ar-ink:#10222f;--ar-muted:#5f5c5d;--ar-soft:#7d797a;--ar-line:#e4e4e4;--ar-subtle:#f8f8f8;--ar-track:#f2f2f2;--ar-accent:#03a694;--ar-accent-strong:#098e7f;--ar-warn:#e6a219;--ar-danger:#d5455f;font-family:'Lato','Segoe UI',system-ui,sans-serif;color:var(--ar-ink);max-width:820px;margin:0 auto;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.ar *{box-sizing:border-box}
.ar-eyebrow{color:var(--ar-accent-strong);font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
.ar-title{font-size:34px;font-weight:800;line-height:1.1;margin:6px 0 4px;text-transform:uppercase;color:var(--ar-ink)}
.ar-sub{color:var(--ar-muted);font-size:14px;margin-bottom:22px}
.ar-card{background:#fff;border:1px solid var(--ar-line);border-radius:24px;padding:26px 28px}
.ar-score{display:flex;gap:30px;align-items:center;flex-wrap:wrap}
.ar-donut{position:relative;width:180px;height:180px;flex:none}
.ar-donut-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ar-donut-n{font-size:56px;font-weight:800;line-height:1}
.ar-donut-d{font-size:14px;color:var(--ar-soft);margin-top:2px}
.ar-verdict{flex:1;min-width:240px}
.ar-verdict-k{display:flex;align-items:center;gap:8px;color:var(--ar-accent-strong);font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
.ar-verdict-i{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:2px solid currentColor;font-size:11px;line-height:1}
.ar-verdict-t{font-size:20px;font-weight:700;line-height:1.35;margin-top:8px}
.ar-verdict-s{font-size:14px;color:var(--ar-muted);margin-top:8px}
.ar-bars{margin-top:26px;display:grid;gap:14px}
.ar-bar-row{display:flex;justify-content:space-between;font-size:14px;color:var(--ar-muted)}
.ar-bar-row strong{color:var(--ar-ink)}
.ar-track{height:6px;border-radius:99px;background:var(--ar-track);margin-top:6px;overflow:hidden}
.ar-fill{height:100%;border-radius:99px;background:var(--ar-ink)}
.ar-h2{font-size:22px;font-weight:800;margin:34px 0 14px;color:var(--ar-ink);break-after:avoid;page-break-after:avoid}
.ar-block{break-inside:avoid;page-break-inside:avoid}
.ar-h2 small{font-size:14px;font-weight:500;color:var(--ar-muted);margin-left:8px}
.ar-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.ar-metric{background:#fff;border:1px solid var(--ar-line);border-radius:16px;padding:20px 22px}
.ar-metric-l{font-size:14px;color:var(--ar-muted)}
.ar-metric-v{font-size:34px;font-weight:800;margin-top:6px;line-height:1.1}
.ar-metric-v.warn{color:#b87300}
.ar-stack{display:flex;gap:3px;height:16px}
.ar-seg{border-radius:99px;min-width:6px}
.ar-legend{display:flex;gap:6px 20px;flex-wrap:wrap;margin-top:14px;font-size:14px;color:var(--ar-muted)}
.ar-legend strong{color:var(--ar-ink);margin-left:4px}
.ar-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.ar-opp{background:#fff;border:1px solid var(--ar-line);border-left:5px solid var(--c);border-radius:16px;padding:22px 24px;margin-bottom:14px;break-inside:avoid;page-break-inside:avoid}
.ar-pill{display:inline-block;padding:5px 12px;border-radius:8px;font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
.ar-opp-id{font-size:12px;color:var(--ar-soft);margin-left:10px}
.ar-opp h3{font-size:20px;font-weight:800;margin:14px 0 6px;color:var(--ar-ink)}
.ar-opp-d{color:var(--ar-muted);font-size:16px;line-height:1.5;margin:0}
.ar-rec{background:var(--ar-subtle);border-radius:12px;padding:14px 16px;margin-top:14px;font-size:16px;line-height:1.5}
.ar-ev{margin:10px 0 0 18px;padding:0;color:var(--ar-muted);font-size:14px;line-height:1.5}
.ar-tw{margin-top:12px;overflow-x:auto}
.ar-tbl{width:100%;border-collapse:collapse;font-size:14px;line-height:1.4}
.ar-tbl th{text-align:right;color:var(--ar-muted);font-weight:700;padding:7px 10px;border-bottom:2px solid var(--ar-line);white-space:nowrap}
.ar-tbl td{text-align:right;padding:7px 10px;border-bottom:1px solid var(--ar-track);color:var(--ar-ink);white-space:nowrap}
.ar-tbl th:first-child,.ar-tbl td:first-child{text-align:left;white-space:normal}
.ar-tbl td:first-child{font-weight:600}
.ar-tbl tr:last-child td{border-bottom:none}
.ar-ai{white-space:pre-wrap;font-size:16px;line-height:1.65}
.ar-nv{margin:0 0 0 18px;padding:0;color:var(--ar-muted);font-size:14px;line-height:1.6}
.ar-note{background:#fdf1d8;border:1px solid var(--ar-warn);border-radius:12px;padding:12px 16px;margin-bottom:18px;font-size:14px}
.ar-title,.ar-h2,.ar-opp h3,.ar-metric-v,.ar-donut-n,.ar-verdict-t,.ar-pill,.ar-eyebrow,.ar-verdict-k{font-family:'Montserrat','Segoe UI',sans-serif}
.ar-foot{text-align:center;color:var(--ar-soft);font-size:13px;margin:34px 0 8px}
@media (max-width:640px){.ar-grid{grid-template-columns:1fr}.ar-title{font-size:30px}}
@media print{.ar{max-width:none;padding:0 3px}}
`;

let AUDIT_REPORT_CSS = AUDIT_REPORT_CSS_ROIBACK;

const AUDIT_PRIORITY_THEMES = {
  current: {
  critico: { label: 'Prioridad alta', color: '#d23c3c', bg: '#fbe3e1', fg: '#a8231f' },
  advertencia: { label: 'Prioridad media', color: '#f2c419', bg: '#f6e8bd', fg: '#a77a00' },
  info: { label: 'Informativo', color: '#9fb0cf', bg: '#e8edf5', fg: '#31456b' },
  oportunidad: { label: 'Oportunidad', color: '#2e9b5f', bg: '#dff3e8', fg: '#1d6b41' },
},
  roiback: {
  critico: { label: 'Prioridad alta', color: '#d5455f', bg: '#fbe4e8', fg: '#a82a42' },
  advertencia: { label: 'Prioridad media', color: '#e6a219', bg: '#fdf1d8', fg: '#8a5d00' },
  info: { label: 'Informativo', color: '#7f93b3', bg: '#eef1f6', fg: '#1f3155' },
  oportunidad: { label: 'Oportunidad', color: '#03a694', bg: '#dff5f2', fg: '#02665b' },
},
};
const AUDIT_STACK_COLORS_THEMES = {
  current: ['#14213d', '#f2c419', '#5f7aa8', '#c5c9d3', '#2e9b5f', '#d23c3c'],
  roiback: ['#10222f', '#03a694', '#ff9800', '#7ad2c7', '#d18da3', '#9b9b9b'],
};
let AUDIT_PRIORITY = AUDIT_PRIORITY_THEMES.roiback;
let AUDIT_STACK_COLORS = AUDIT_STACK_COLORS_THEMES.roiback;

// Evolución del puntaje de una cuenta: `rows` viene del servidor, de la auditoría más vieja a la más
// nueva (la última es la actual). Se usa dentro del informe (pantalla, HTML y Markdown) y en la vista
// "Ver historial". Los colores usan las variables del informe con un valor de respaldo.
function auditHistoryHtml(rows) {
  if (!rows || !rows.length) return '';
  const e = escapeHtml;
  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  const day = (iso) => String(iso).slice(0, 10);
  const stamp = (iso) => `${String(iso).slice(0, 10)} ${String(iso).slice(11, 16)}`;
  const sevOf = (sev) => AUDIT_PRIORITY[sev] || AUDIT_PRIORITY.info;
  const pill = (sev) => { const p = sevOf(sev); return `<span class="ar-pill" style="background:${p.bg};color:${p.fg}">${e(p.label)}</span>`; };

  let headline;
  if (!prev) {
    headline = `Es la primera auditoría guardada de esta cuenta (${e(stamp(last.at))}). Desde la próxima verás aquí cómo cambia el puntaje.`;
  } else {
    const d = last.score - prev.score;
    const verb = d > 0 ? `subió ${d} punto${d === 1 ? '' : 's'}` : d < 0 ? `bajó ${-d} punto${d === -1 ? '' : 's'}` : 'se mantuvo igual';
    headline = `El puntaje ${verb} frente a la auditoría del ${e(stamp(prev.at))} (${prev.score} → ${last.score}).`;
  }

  const notes = [];
  if (prev) {
    if (prev.rules_version !== last.rules_version) notes.push('Las reglas de la auditoría cambiaron entre estas dos auditorías: parte de la diferencia puede venir de las reglas y no de la cuenta.');
    if (prev.days !== last.days) notes.push(`Se auditaron periodos de distinta duración (${prev.days} y ${last.days} días), así que las cifras no son del todo comparables.`);
    if (prev.goal !== last.goal || Number(prev.target || 0) !== Number(last.target || 0)) notes.push('La meta del cuestionario cambió entre las dos auditorías.');
  }

  // Gráfica de línea: un punto por auditoría (hasta las últimas 20), separados por igual.
  let chart = '';
  const pts = rows.slice(-20);
  if (pts.length >= 2) {
    const W = 680, H = 210, ML = 40, MR = 18, MT = 20, MB = 30;
    const pw = W - ML - MR, ph = H - MT - MB;
    const x = (i) => ML + (i / (pts.length - 1)) * pw;
    const y = (v) => MT + ph - (Math.max(0, Math.min(100, v)) / 100) * ph;
    const grid = [0, 25, 50, 75, 100].map((g) => `<line x1="${ML}" y1="${y(g).toFixed(1)}" x2="${W - MR}" y2="${y(g).toFixed(1)}" stroke="var(--ar-line,#e3e6ec)" stroke-width="1" /><text x="${ML - 6}" y="${(y(g) + 3).toFixed(1)}" font-size="10" fill="var(--ar-muted,#6b7280)" text-anchor="end">${g}</text>`).join('');
    const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
    const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.score).toFixed(1)}" r="${i === pts.length - 1 ? 5 : 3.5}" fill="var(--ar-ink,#14213d)"><title>${e(stamp(p.at))}: ${p.score} puntos</title></circle><text x="${x(i).toFixed(1)}" y="${(y(p.score) - 9).toFixed(1)}" font-size="10.5" font-weight="700" fill="var(--ar-ink,#14213d)" text-anchor="middle">${p.score}</text>`).join('');
    const every = Math.max(1, Math.ceil(pts.length / 7));
    const sameDay = new Set(pts.map((p) => day(p.at))).size < pts.length;
    const labels = pts.map((p, i) => ({ p, i })).filter(({ i }) => i % every === 0 || i === pts.length - 1).map(({ p, i }) => `<text x="${(i === pts.length - 1 ? x(i) + 14 : x(i)).toFixed(1)}" y="${H - 8}" font-size="10" fill="var(--ar-muted,#6b7280)" text-anchor="${i === pts.length - 1 ? 'end' : 'middle'}">${e(sameDay ? `${day(p.at).slice(5)} ${String(p.at).slice(11, 16)}` : day(p.at).slice(5))}</text>`).join('');
    chart = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;margin-top:6px" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Evolución del puntaje de la cuenta">${grid}<path d="${path}" fill="none" stroke="var(--ar-ink,#14213d)" stroke-width="2.5" />${dots}${labels}</svg>`;
  }

  // Qué cambió respecto a la auditoría anterior (solo críticos y advertencias, para no llenarlo de ruido).
  let changes = '';
  if (prev) {
    const relevant = (f) => f.severity === 'critico' || f.severity === 'advertencia';
    const prevIds = new Set(prev.findings.map((f) => f.id));
    const lastIds = new Set(last.findings.map((f) => f.id));
    const added = last.findings.filter((f) => relevant(f) && !prevIds.has(f.id));
    const gone = prev.findings.filter((f) => relevant(f) && !lastIds.has(f.id));
    const list = (title, items) => `<div style="flex:1;min-width:240px"><div style="font-weight:700;margin-bottom:6px">${e(title)} (${items.length})</div>${items.length
      ? `<ul class="ar-ev" style="margin:0 0 0 16px">${items.map((f) => `<li>${pill(f.severity)} ${e(f.id)} · ${e(f.title)}</li>`).join('')}</ul>` : '<div style="color:var(--ar-muted,#6b7280);font-size:14px">Ninguno</div>'}</div>`;
    changes = `<div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:18px">${list('Resueltos desde la anterior', gone)}${list('Nuevos desde la anterior', added)}</div>`;
  }

  const recent = [...rows].reverse().slice(0, 8);
  const table = `<div class="ar-tw"><table class="ar-tbl"><thead><tr><th>Fecha</th><th>Puntaje</th><th>Críticos</th><th>Advertencias</th><th>Cambio</th></tr></thead><tbody>${recent.map((r, i) => {
    const before = rows[rows.length - 1 - i - 1];
    const d = before ? r.score - before.score : null;
    return `<tr><td>${e(stamp(r.at))}</td><td>${r.score}</td><td>${r.critical}</td><td>${r.warnings}</td><td>${d == null ? '—' : d > 0 ? `+${d}` : String(d)}</td></tr>`;
  }).join('')}</tbody></table></div>`;

  return `
    <div class="ar-block"><h2 class="ar-h2">Evolución del puntaje<small>${rows.length} auditoría${rows.length === 1 ? '' : 's'} guardada${rows.length === 1 ? '' : 's'} de esta cuenta</small></h2>
    <div class="ar-card"><p style="margin:0 0 4px;font-size:16px;font-weight:600">${headline}</p>
      ${notes.map((n) => `<p class="ar-opp-d" style="margin:6px 0 0;font-size:14px">${e(n)}</p>`).join('')}
      ${chart}${changes}
      ${rows.length > 1 ? `<div style="margin-top:18px">${table}</div>` : ''}
    </div></div>`;
}

// Vista "Ver historial": la tendencia de la cuenta elegida sin volver a auditar (no gasta cuota de Google).
function loadAuditHistoryOnly() {
  const s = state.audit;
  const customerId = auditCustomerId();
  if (!customerId && !s.api.simulated) { s.api.error = 'Elige una cuenta o escribe su ID primero.'; render(); return; }
  s.api.error = null;
  s.history = { status: 'loading', rows: null, error: null, customerId: customerId || '' };
  render();
  fetch(`/api/google-ads/audit-history?customer_id=${encodeURIComponent(customerId || '')}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      s.history = { status: 'ready', rows: data.history || [], error: null, customerId: customerId || '' };
      render();
    })
    .catch((err) => { s.history = { status: 'error', rows: null, error: err.message || String(err), customerId: customerId || '' }; render(); });
}

function auditReportBodyHtml() {
  const s = state.audit;
  const r = s.report;
  const e = escapeHtml;
  const cur = r.summary.currency;
  const m = r.meta;
  const sc = r.score;
  const ring = themed(sc.label === 'Sana' ? '#2e9b5f' : sc.label === 'Mejorable' ? '#e0a800' : '#d23c3c', sc.label === 'Sana' ? '#1f9d55' : sc.label === 'Mejorable' ? '#e6a219' : '#d5455f');
  const R = 82;
  const C = 2 * Math.PI * R;
  const dash = (C * sc.total) / 100;
  const donut = `
    <div class="ar-donut">
      <svg viewBox="0 0 200 200" width="180" height="180" aria-hidden="true">
        <circle cx="100" cy="100" r="${R}" fill="none" stroke="${themed('#e8eaf0', '#e4e4e4')}" stroke-width="22"></circle>
        <circle cx="100" cy="100" r="${R}" fill="none" stroke="${ring}" stroke-width="22" stroke-dasharray="${dash.toFixed(1)} ${(C - dash).toFixed(1)}" transform="rotate(-90 100 100)"></circle>
      </svg>
      <div class="ar-donut-c"><div class="ar-donut-n">${sc.total}</div><div class="ar-donut-d">/ 100</div></div>
    </div>`;

  let verdict;
  if (sc.critical > 0) verdict = `Tu cuenta tiene ${sc.critical} problema${sc.critical === 1 ? '' : 's'} crítico${sc.critical === 1 ? '' : 's'} de configuración que conviene corregir primero.`;
  else if (sc.warnings > 0) verdict = `Tu cuenta está bien configurada, con ${sc.warnings} punto${sc.warnings === 1 ? '' : 's'} por mejorar.`;
  else verdict = 'Tu cuenta no tiene hallazgos con las reglas actuales.';

  const bars = Object.entries(sc.by_area).map(([area, v]) => `
    <div><div class="ar-bar-row"><span>${e(area)}</span><strong>${v.score} / 100</strong></div>
    <div class="ar-track"><div class="ar-fill" style="width:${v.score}%"></div></div></div>`).join('');

  const sm = r.summary;
  const hasGoalFinding = r.findings.some((f) => f.id === 'G1');
  const ctx = m.context;
  const goalText = ctx.goal === 'roas' && ctx.target ? `ROAS ${e(String(ctx.target))}%` : ctx.goal === 'cpa' && ctx.target ? `CPA ${e(auditMoney(Number(ctx.target), cur))}` : 'Volumen de reservas';
  const metric = (label, value, warn) => `<div class="ar-metric"><div class="ar-metric-l">${label}</div><div class="ar-metric-v${warn ? ' warn' : ''}">${value}</div></div>`;
  const metrics = [
    metric('Gasto del periodo', e(auditMoney(sm.cost, cur))),
    metric('Conversiones', Math.round(sm.conversions)),
    metric('ROAS logrado', sm.roas != null ? `${Math.round(sm.roas * 100)}%` : 'N/D', hasGoalFinding && ctx.goal === 'roas'),
    metric('CPA %', sm.cpa_pct != null ? `${(sm.cpa_pct * 100).toFixed(1)}%` : 'N/D'),
    metric('Campañas activas', `${sm.campaigns_enabled} de ${sm.campaigns_total}`),
    metric('Meta indicada', goalText),
  ].join('');

  const spend = sm.spend_by_type || [];
  const stack = spend.length ? `
    <div class="ar-block"><h2 class="ar-h2">Distribución del gasto</h2>
    <div class="ar-card">
      <div class="ar-stack">${spend.map((t, i) => `<div class="ar-seg" style="flex:${Math.max(t.share, 0.01)};background:${AUDIT_STACK_COLORS[i % AUDIT_STACK_COLORS.length]}"></div>`).join('')}</div>
      <div class="ar-legend">${spend.map((t, i) => `<span><span class="ar-dot" style="background:${AUDIT_STACK_COLORS[i % AUDIT_STACK_COLORS.length]}"></span>${e(t.label)}<strong>${Math.round(t.share * 100)}%</strong></span>`).join('')}</div>
    </div></div>` : '';

  const ai = s.ai.status === 'ready' && s.ai.narrativa
    ? `<h2 class="ar-h2">Lectura priorizada</h2><div class="ar-card ar-ai">${e(s.ai.narrativa)}</div>` : '';

  const opp = (f) => {
    const p = f.kind === 'oportunidad' ? AUDIT_PRIORITY.oportunidad : AUDIT_PRIORITY[f.severity];
    return `
      <div class="ar-opp" style="--c:${p.color}">
        <div><span class="ar-pill" style="background:${p.bg};color:${p.fg}">${p.label}</span><span class="ar-opp-id">${e(f.id)} · ${e(f.area)}</span></div>
        <h3>${e(f.title)}</h3>
        <p class="ar-opp-d">${e(f.detail)}</p>
        <div class="ar-rec"><strong>Recomendación:</strong> ${e(f.action)}</div>
        ${f.table ? `<div class="ar-tw"><table class="ar-tbl"><thead><tr>${f.table.columns.map((c) => `<th>${e(c)}</th>`).join('')}</tr></thead><tbody>${f.table.rows.map((r) => `<tr>${r.map((c) => `<td>${e(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
          : f.evidence.length ? `<ul class="ar-ev">${f.evidence.map((x) => `<li>${e(x)}</li>`).join('')}</ul>` : ''}
      </div>`;
  };
  const opps = r.findings.length
    ? `<h2 class="ar-h2">Oportunidades<small>${sc.critical} críticas · ${sc.warnings} advertencias · ${sc.info} informativas</small></h2>${r.findings.map(opp).join('')}`
    : `<h2 class="ar-h2">Oportunidades</h2><div class="ar-card">No se encontraron hallazgos con las reglas actuales.</div>`;

  const nv = r.not_verifiable.length
    ? `<h2 class="ar-h2">Revisiones que no se pudieron verificar</h2><div class="ar-card"><ul class="ar-nv">${r.not_verifiable.map((n) => `<li><strong>${e(n.id)} · ${e(n.title)}:</strong> ${e(n.reason)}</li>`).join('')}</ul></div>` : '';

  return `
    <div class="ar">
      <div class="ar-eyebrow">Auditoría de cuenta</div>
      <div class="ar-title">${e(auditReportTitle())}</div>
      <div class="ar-sub">Cuenta ${e(m.customer_id || 'N/D')}${m.account_name ? ` (${e(m.account_name)})` : ''} · ${e(m.date_from)} a ${e(m.date_to)} (${sm.days} días) · Generada ${e(m.generated_at.slice(0, 10))}</div>
      ${s.api.simulated ? '<div class="ar-note"><strong>Datos de ejemplo (modo simulado).</strong> No son de una cuenta real.</div>' : ''}
      <div class="ar-card">
        <div class="ar-score">
          ${donut}
          <div class="ar-verdict">
            <div class="ar-verdict-k" style="color:${ring}"><span class="ar-verdict-i">!</span>Puntaje de salud · ${e(sc.label)}</div>
            <div class="ar-verdict-t">${e(verdict)}</div>
            <div class="ar-verdict-s">Cada crítico resta ${sc.weights.critico} puntos y cada advertencia ${sc.weights.advertencia}.</div>
          </div>
        </div>
        <div class="ar-bars">${bars}</div>
      </div>
      <div class="ar-block"><h2 class="ar-h2">Métricas principales</h2>
      <div class="ar-grid">${metrics}</div>
      ${r.booking_conversion ? `<div class="ar-sub" style="margin:10px 0 0">Conversión tomada como reserva: <strong>${e(r.booking_conversion)}</strong>. Si no es la correcta, las reglas de conversiones (A1 a A8) se evalúan sobre otra acción: valídalo.</div>` : ''}</div>
      ${stack}
      ${ai}
      ${auditHistoryHtml(r.history)}
      ${opps}
      ${nv}
      <div class="ar-foot">Generado con Paid Media Helper a partir de datos de Google Ads. Los umbrales son heurísticos y no reemplazan el criterio del estratega de cuenta.</div>
    </div>`;
}

function buildAuditHtml() {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auditoría de cuenta — ${escapeHtml(auditReportTitle())}</title>
${themedFontsLink(PLUS_JAKARTA_HREF)}
<style>body{margin:0;padding:40px 20px;background:#f4f5f8}@media print{body{background:#fff;padding:0}@page{margin:14mm}}${AUDIT_REPORT_CSS}</style>
</head><body>${auditReportBodyHtml()}</body></html>`;
}

function renderAuditForm() {
  const s = state.audit;
  const a = s.api;
  const c = s.ctx;
  if (!a.statusChecked) return `<div class="card control-panel"><p class="footnote">Consultando la conexión con Google Ads…</p></div>`;
  const simulatedNotice = a.simulated ? `
    <div class="ok-panel" style="margin:10px 0;width:100%">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor — la auditoría usa una cuenta de hotel de ejemplo con problemas sembrados.
    </div>` : '';

  let accountBlock = '';
  if (a.accountsStatus === 'idle') {
    accountBlock = `<div class="field"><p class="footnote">${a.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.'}</p>
      <button class="btn-outline" data-action="audit-load-accounts">Ver cuentas disponibles</button></div>`;
  } else if (a.accountsStatus === 'loading') {
    accountBlock = `<div class="field"><p class="footnote">Cargando cuentas…</p></div>`;
  } else if (a.accountsStatus === 'error') {
    accountBlock = `<div class="error-panel"><strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(a.error)}</div>`;
  } else {
    const mccFilterActive = a.mcc.selectedId && a.mcc.accountIds;
    const visible = mccFilterActive ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
    const options = ['<option value="">Elige una cuenta…</option>']
      .concat(visible.map((acc) => `<option value="${escapeHtml(acc.id)}" ${a.accountId === acc.id ? 'selected' : ''}>${escapeHtml(acc.name)} (${escapeHtml(acc.id)})</option>`)).join('');
    accountBlock = `
      ${simulatedNotice}
      ${renderAuditMccFilterPanel()}
      <div class="field"><label>Cuenta${mccFilterActive ? ` (${visible.length} en "${escapeHtml(a.mcc.selectedName)}")` : ''}</label>
        <select id="audit-account" style="width:320px">${options}</select></div>
      <div class="field"><label>...o escribe el ID de la cuenta</label>
        <input type="text" id="audit-account-manual" value="${escapeHtml(a.accountIdManual)}" placeholder="ej. 6862893390" style="width:160px" /></div>
      <div class="field"><label>Periodo</label>
        <select id="audit-days"><option value="30" ${a.days == 30 ? 'selected' : ''}>Últimos 30 días</option><option value="60" ${a.days == 60 ? 'selected' : ''}>Últimos 60 días</option><option value="90" ${a.days == 90 ? 'selected' : ''}>Últimos 90 días</option></select></div>`;
  }

  const sel = (field, opts) => `<select data-audit-ctx="${field}">${Object.entries(opts).map(([k, v]) => `<option value="${k}" ${c[field] === k ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select>`;
  const txt = (field, ph, w = 260) => `<input type="text" data-audit-ctx="${field}" value="${escapeHtml(c[field])}" placeholder="${escapeHtml(ph)}" style="width:${w}px" />`;

  return `
    <div class="card control-panel align-end" style="flex-wrap:wrap;gap:16px 24px">
      ${accountBlock}
    </div>
    <div class="card control-panel align-end" style="flex-wrap:wrap;gap:16px 24px">
      <h3 class="section-title" style="margin:0;width:100%">Cuestionario del hotel</h3>
      <div class="field"><label>Nombre del hotel (para el informe)</label>${txt('hotel_name', 'ej. Hotel Estelar Cartagena')}</div>
      <div class="field"><label>Términos de marca en las búsquedas</label>${txt('brand_terms', 'ej. estelar, hotel estelar', 220)}</div>
      <div class="field"><label>Palabras que marcan una campaña de marca</label>${txt('brand_campaign_words', 'marca, brand, branded, brnd', 220)}</div>
      ${s.report && s.report.score.by_area['Performance Max'] ? `<div class="field"><label>¿Usas feed de Hotel Center con PMax?</label>${sel('hotel_feed', AUDIT_FEED)}
        <span class="field-hint">Con feed, las revisiones de imágenes, video y calidad de recursos (P3, P5, P6) pasan a informativas.</span></div>` : ''}
      <div class="field"><label>Meta principal</label>${sel('goal', AUDIT_GOALS)}</div>
      ${c.goal !== 'volumen' ? `<div class="field"><label>${c.goal === 'roas' ? 'ROAS objetivo (ej. 450 = 450%)' : 'CPA objetivo'}</label>${txt('target', c.goal === 'roas' ? '450' : '25', 110)}</div>` : ''}
      <button class="btn-accent" data-action="audit-run" ${s.status === 'loading' ? 'disabled' : ''}>${s.report ? 'Auditar de nuevo' : 'Auditar cuenta'}</button>
      <button class="btn-outline" data-action="audit-history" ${s.history.status === 'loading' ? 'disabled' : ''} title="Muestra cómo ha cambiado el puntaje de esta cuenta, sin volver a consultar Google Ads">Ver historial de la cuenta</button>
      ${a.error ? `<div class="error-panel" style="width:100%"><strong>No se pudo auditar.</strong> ${escapeHtml(a.error)}</div>` : ''}
    </div>`;
}

function renderAuditResults() {
  const s = state.audit;
  const aiBlock = `
    <div class="card" style="margin:16px 0;max-width:820px;margin-left:auto;margin-right:auto">
      <h3 class="section-title" style="margin:0 0 8px">Lectura priorizada con IA <span class="footnote" style="font-weight:400">· hasta 10 por hora por persona. Si la generas, se incluye en el informe descargable.</span></h3>
      ${s.ai.status === 'idle' ? `<button class="btn-outline" data-action="audit-ai">Analizar con IA</button>` : ''}
      ${s.ai.status === 'loading' ? `<p class="footnote">Analizando la auditoría…</p>` : ''}
      ${s.ai.status === 'error' ? `<div class="error-panel">${escapeHtml(s.ai.error)}</div><button class="btn-outline" data-action="audit-ai" style="margin-top:8px">Reintentar</button>` : ''}
      ${s.ai.status === 'ready' ? `<p class="footnote" style="margin:0">Listo: aparece abajo, en el informe.</p>` : ''}
    </div>`;
  return `
    <style>${AUDIT_REPORT_CSS}</style>
    <div class="audit-toolbar">
      <button class="btn-accent" data-action="audit-download-html">Descargar informe (HTML)</button>
      <button class="btn-outline" data-action="audit-download-md">Descargar Markdown</button>
      <span class="footnote">El HTML se abre en cualquier navegador y se guarda como PDF con Ctrl+P (Cmd+P en Mac).</span>
    </div>
    ${aiBlock}
    ${auditReportBodyHtml()}`;
}

function renderAuditPage() {
  const s = state.audit;
  ensureAuditStatusLoaded();
  let body = '';
  if (s.status === 'loading') {
    body = `<div class="card state-panel loading"><div class="spinner"></div><p>Auditando la cuenta (unas 22 consultas a Google Ads)…</p></div>`;
  } else if (s.report) {
    body = renderAuditResults();
  } else {
    body = `<div class="card state-panel idle">${icon('clipboard-check', 30)}<p>Elige una cuenta, llena el cuestionario del hotel y audita: la plataforma revisa conversiones, redes, estructura, palabras clave y activos, y entrega un informe descargable.</p></div>`;
  }
  const h = s.history;
  let historyBlock = '';
  if (h.status === 'loading') historyBlock = `<div class="card state-panel loading"><div class="spinner"></div><p>Cargando el historial…</p></div>`;
  else if (h.status === 'error') historyBlock = `<div class="error-panel"><strong>No se pudo cargar el historial.</strong> ${escapeHtml(h.error)}</div>`;
  else if (h.status === 'ready') {
    historyBlock = h.rows.length
      ? `<style>${AUDIT_REPORT_CSS}</style><div class="ar" style="margin-bottom:20px">${auditHistoryHtml(h.rows)}</div>`
      : `<div class="card state-panel idle"><p>Esta cuenta todavía no tiene auditorías guardadas. Corre la primera con "Auditar cuenta" y desde ahí quedará su historial.</p></div>`;
  }
  return `${renderAuditForm()}${historyBlock}${body}`;
}

// ---------------------------------------------------------------------------
// Página — Ritmo de consumo
// ---------------------------------------------------------------------------

function pacingPeriodNote(p) {
  const single = p.monthFrom === p.monthTo;
  const label = single ? escapeHtml(p.monthFrom) : `${escapeHtml(p.monthFrom)} a ${escapeHtml(p.monthTo)}`;
  const includesCurrent = p.monthTo >= currentMonthValue();
  if (single) return `Mes cerrado (${label}): gastado vs. el objetivo completo del mes — no hay ritmo esperado ni inversión diaria que recomendar.`;
  return `Periodo ${label}: se suman los objetivos de Billing y el gasto de cada mes. Solo entran a la comparación los meses que tienen objetivo configurado${includesCurrent ? '; el mes en curso cuenta su objetivo completo pero su esperado se prorratea hasta ayer' : ''}. No hay inversión diaria que recomendar para un periodo de varios meses.`;
}

function currentMonthValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const PACING_TOLERANCE = 0.10; // ±10% del ritmo esperado se considera "en ritmo"

function ensurePacingStatusLoaded() {
  const p = state.pacing;
  if (p.statusChecked) return;
  fetch('/api/google-ads/status')
    .then((r) => r.json())
    .then((data) => { p.statusChecked = true; p.configured = !!data.configured; render(); })
    .catch(() => { p.statusChecked = true; p.configured = false; render(); });
}

function loadPacingAccounts() {
  const p = state.pacing;
  p.accountsStatus = 'loading'; p.accountsError = null;
  render();
  fetch('/api/google-ads/accounts')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      p.accounts = data.accounts || [];
      p.accountsStatus = 'ready';
      render();
    })
    .catch((err) => {
      p.accountsStatus = 'error'; p.accountsError = err.message || String(err);
      render();
    });
}

function loadPacingWatchlist() {
  const p = state.pacing;
  p.watchlistStatus = 'loading'; p.error = null;
  render();
  fetch('/api/google-ads/pacing/watchlist')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      p.watchlist = data.watchlist || [];
      p.watchlistStatus = 'ready';
      render();
      if (p.watchlist.length) loadPacingRows();
      else { p.rows = []; p.rowsStatus = 'ready'; }
    })
    .catch((err) => {
      p.watchlistStatus = 'error'; p.error = err.message || String(err);
      render();
    });
}

function loadPacingRows() {
  const p = state.pacing;
  p.rowsStatus = 'loading';
  render();
  fetch(`/api/google-ads/pacing${p.monthFrom ? `?month_from=${encodeURIComponent(p.monthFrom)}&month_to=${encodeURIComponent(p.monthTo)}` : ''}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      p.rows = data.rows || [];
      p.simulated = !!data.simulated;
      p.rowsStatus = 'ready';
      render();
    })
    .catch((err) => {
      p.rowsStatus = 'error'; p.error = err.message || String(err);
      render();
    });
}

function addPacingWatchlistAccount() {
  const p = state.pacing;
  if (!p.accountToAdd) return;
  const account = p.accounts.find((a) => a.id === p.accountToAdd);
  p.error = null;
  fetch('/api/google-ads/pacing/watchlist/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: p.accountToAdd, account_name: account ? account.name : null }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      p.accountToAdd = '';
      loadPacingWatchlist();
    })
    .catch((err) => { p.error = err.message || String(err); render(); });
}

function removePacingWatchlistAccount(customerId) {
  const p = state.pacing;
  p.error = null;
  fetch('/api/google-ads/pacing/watchlist/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      loadPacingWatchlist();
    })
    .catch((err) => { p.error = err.message || String(err); render(); });
}

function clearPacingWatchlist() {
  const p = state.pacing;
  const count = (p.watchlist || []).length;
  if (!count) return;
  if (!window.confirm(`¿Quitar las ${count} cuenta(s) vigiladas? No borra nada en Google Ads, solo deja de mostrarlas acá — puedes volver a agregarlas cuando quieras.`)) return;
  p.error = null;
  fetch('/api/google-ads/pacing/watchlist/clear', { method: 'POST' })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      loadPacingWatchlist();
    })
    .catch((err) => { p.error = err.message || String(err); render(); });
}

function loadPacingMccGroups() {
  const m = state.pacing.mcc;
  m.status = 'loading'; m.error = null;
  render();
  fetch('/api/google-ads/mcc-groups')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.groups = data.groups || [];
      m.status = 'ready';
      render();
    })
    .catch((err) => {
      m.status = 'error'; m.error = err.message || String(err);
      render();
    });
}

function addPacingMccGroup(groupCustomerId, groupName) {
  const m = state.pacing.mcc;
  m.addStatus = 'loading'; m.addError = null; m.addResult = null;
  render();
  fetch('/api/google-ads/pacing/watchlist/add-mcc-group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_customer_id: groupCustomerId }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      m.addStatus = 'idle';
      m.addResult = { name: groupName, found: data.found, added: data.added };
      loadPacingWatchlist();
    })
    .catch((err) => {
      m.addStatus = 'error'; m.addError = err.message || String(err);
      render();
    });
}

function renderPacingMccPanel() {
  if (!currentUser.isAdmin) return '';
  const m = state.pacing.mcc;

  let body = '';
  if (m.status === 'idle') {
    body = `<button class="btn-outline sm" data-action="pacing-mcc-load">Buscar un MCC completo (ej. una cadena de hoteles)</button>`;
  } else if (m.status === 'loading') {
    body = `<p class="footnote">Cargando las agrupaciones del MCC…</p>`;
  } else if (m.status === 'error') {
    body = `<div class="error-panel">${escapeHtml(m.error)}</div>`;
  } else if (m.status === 'ready') {
    if (!m.groups.length) {
      body = `<p class="footnote">No hay sub-MCCs disponibles en modo simulado.</p>`;
    } else {
      const filter = (m.filter || '').trim().toLowerCase();
      let matches = [];
      if (filter.length >= 2) {
        matches = m.groups.filter((g) => g.id.includes(filter) || (g.name || '').toLowerCase().includes(filter)).slice(0, 25);
      }
      const matchesHtml = matches.length
        ? `<div class="table-scroll" style="max-height:220px;margin-top:8px">
            <table>
              <tbody>
                ${matches.map((g) => `
                  <tr>
                    <td>${escapeHtml(g.name)}</td>
                    <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(g.id)}</td>
                    <td><button class="btn-outline xs" data-pacing-mcc-pick="${escapeHtml(g.id)}" data-pacing-mcc-pick-name="${escapeHtml(g.name)}" ${m.addStatus === 'loading' ? 'disabled' : ''}>Agregar sus cuentas</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`
        : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');
      body = `
        <input type="text" id="pacing-mcc-filter" placeholder="Busca por nombre o ID del MCC (${m.groups.length} agrupaciones)…" value="${escapeHtml(m.filter)}" style="width:100%" />
        ${matchesHtml}
        ${m.addStatus === 'loading' ? '<p class="footnote" style="margin-top:8px">Agregando sus cuentas…</p>' : ''}
        ${m.addError ? `<div class="error-panel" style="margin-top:8px">${escapeHtml(m.addError)}</div>` : ''}
        ${m.addResult ? `<div class="ok-panel" style="margin-top:8px">"${escapeHtml(m.addResult.name)}" — ${m.addResult.found} cuenta(s) encontradas, ${m.addResult.added} nueva(s) agregada(s) a vigilar.</div>` : ''}`;
    }
  }

  return `
    <div class="card control-panel" style="flex-direction:column;align-items:stretch;gap:10px;margin-bottom:20px">
      <label style="font-weight:600">Agregar un MCC completo</label>
      <p class="footnote" style="margin:0">Para hoteles con muchas cuentas (40 o más) — agrega de un jalón todas las cuentas que cuelgan de un sub-MCC, en vez de elegirlas una por una.</p>
      ${body}
    </div>`;
}

function renderPacingAddPanel() {
  const p = state.pacing;
  const watchedIds = new Set((p.watchlist || []).map((w) => w.customer_id));

  if (p.accountsStatus === 'idle') {
    return `
      <div class="card control-panel align-end" style="margin-bottom:20px">
        <div class="field">
          <p class="footnote">${!p.statusChecked ? 'Consultando la conexión con Google Ads…' : (p.configured ? 'Conectado a la API de Google Ads.' : 'La API de Google Ads aún no está configurada — se usarán datos simulados para probar el flujo.')}</p>
          <button class="btn-outline" data-action="pacing-load-accounts" ${p.statusChecked ? '' : 'disabled'}>Ver cuentas disponibles</button>
        </div>
      </div>`;
  }
  if (p.accountsStatus === 'loading') {
    return `<div class="card control-panel align-end" style="margin-bottom:20px"><div class="field"><p class="footnote">Cargando cuentas…</p></div></div>`;
  }
  if (p.accountsStatus === 'error') {
    return `<div class="error-panel" style="margin-bottom:20px"><strong>No se pudieron cargar las cuentas.</strong> ${escapeHtml(p.accountsError)}</div>`;
  }

  const available = p.accounts.filter((a) => !watchedIds.has(a.id));
  const options = ['<option value="">Elige una cuenta…</option>']
    .concat(available.map((a) => `<option value="${escapeHtml(a.id)}" ${p.accountToAdd === a.id ? 'selected' : ''}>${escapeHtml(a.name)} (${escapeHtml(a.id)})</option>`))
    .join('');

  return `
    <div class="card control-panel align-end" style="margin-bottom:20px">
      <div class="field">
        <label>Agregar cuenta a vigilar</label>
        <select id="pacing-account-select" style="width:320px">${options}</select>
      </div>
      <button class="btn-accent" data-action="pacing-add-account" ${p.accountToAdd ? '' : 'disabled'}>Agregar</button>
    </div>`;
}

function pacingStatusBadge(deviationPct, isComplete) {
  if (isComplete) {
    if (deviationPct > PACING_TOLERANCE) return '<span class="delta-badge bad">Superó el objetivo</span>';
    if (deviationPct < -PACING_TOLERANCE) return '<span class="delta-badge warn">Quedó por debajo</span>';
    return '<span class="delta-badge good">Cumplió el objetivo</span>';
  }
  if (deviationPct > PACING_TOLERANCE) return '<span class="delta-badge bad">Por arriba del ritmo</span>';
  if (deviationPct < -PACING_TOLERANCE) return '<span class="delta-badge warn">Por abajo del ritmo</span>';
  return '<span class="delta-badge good">En ritmo</span>';
}

function pacingDeviationLabel(deviationPct) {
  const arrow = deviationPct > 0 ? '▲' : (deviationPct < 0 ? '▼' : '—');
  return `${arrow} ${Math.abs(deviationPct * 100).toFixed(0)}%`;
}

// Mismo criterio que pacingStatusBadge (±PACING_TOLERANCE del ritmo
// esperado), pero como color de texto en vez de badge — para poder
// pintar el número de "% consumido" directo, sin repetir la columna
// "Estado" al lado.
function pacingSemaforoColor(deviationPct) {
  if (deviationPct > PACING_TOLERANCE) return 'var(--danger)';
  if (deviationPct < -PACING_TOLERANCE) return 'var(--warn-strong)';
  return 'var(--ok-text)';
}

// El esperado (y todo lo derivado de él) se calcula hasta AYER, no hasta
// hoy — el gasto de hoy en Google Ads normalmente todavía no está
// cerrado/completo, así que comparar un día a medias contra el
// presupuesto de un día completo sesga el ritmo hacia "por debajo" sin
// que sea real todavía. Centralizado acá para que la tabla y el orden
// por columna usen exactamente los mismos números.
function pacingComputed(r) {
  const hasTarget = r.monthly_target !== null && r.monthly_target !== undefined && r.monthly_target > 0;
  if (!hasTarget) {
    return {
      hasTarget: false, expected: null, expectedPct: null, consumedPct: null, deviationPct: null,
      recommendedDaily: null, budgetExceeded: false, isComplete: !!r.is_complete,
    };
  }
  // Periodo de uno o varios meses (viene expected_total del servidor): el
  // objetivo ya es la suma de los meses con objetivo, y el esperado es esa
  // suma (con el mes en curso, si entra, prorrateado hasta ayer). No hay
  // días por repartir entre meses, así que no hay inversión diaria.
  if (r.expected_total != null) {
    const consumedPct = r.spend_mtd / r.monthly_target;
    const deviationPct = r.expected_total > 0 ? (r.spend_mtd - r.expected_total) / r.expected_total : 0;
    return {
      hasTarget: true, expected: r.expected_total, expectedPct: r.expected_total / r.monthly_target, consumedPct,
      deviationPct, recommendedDaily: null, budgetExceeded: false, isComplete: !!r.is_complete,
    };
  }
  const daysElapsed = Math.max((r.days_elapsed || 0) - 1, 0);
  const expectedPct = daysElapsed / r.days_in_month;
  const expected = r.monthly_target * expectedPct;
  const consumedPct = r.spend_mtd / r.monthly_target;
  const deviationPct = expected > 0 ? (r.spend_mtd - expected) / expected : 0;
  // Cuánto invertir por día de HOY en adelante (incluido) para terminar el
  // mes justo en el objetivo: lo que queda del objetivo ÷ los días que
  // quedan, incluyendo hoy (días del mes - días transcurridos + 1). Si ya
  // se gastó más del objetivo, no hay nada que "repartir" — queda en 0 y
  // se marca budgetExceeded para que la interfaz avise en vez de mostrar
  // un negativo sin sentido.
  const daysRemaining = Math.max((r.days_in_month || 0) - (r.days_elapsed || 0) + 1, 1);
  const remainingBudget = r.monthly_target - r.spend_mtd;
  const recommendedDaily = Math.max(remainingBudget, 0) / daysRemaining;
  return { hasTarget: true, expected, expectedPct, consumedPct, deviationPct, recommendedDaily, budgetExceeded: remainingBudget <= 0, isComplete: false };
}

const PACING_SORT_KEYS = {
  account_name: (r) => (r.account_name || '').toLowerCase(),
  monthly_target: (r) => (r.monthly_target ?? -Infinity),
  spend_mtd: (r) => (r.spend_mtd ?? -Infinity),
  consumed_pct: (r) => { const c = pacingComputed(r); return c.hasTarget ? c.consumedPct : -Infinity; },
  expected: (r) => { const c = pacingComputed(r); return c.hasTarget ? c.expected : -Infinity; },
  expected_pct: (r) => { const c = pacingComputed(r); return c.hasTarget ? c.expectedPct : -Infinity; },
  deviation_pct: (r) => { const c = pacingComputed(r); return c.hasTarget ? c.deviationPct : -Infinity; },
  recommended_daily: (r) => { const c = pacingComputed(r); return c.hasTarget && c.recommendedDaily != null ? c.recommendedDaily : -Infinity; },
};
function getPacingRowsSorted() {
  const p = state.pacing;
  const rows = (p.rows || []).filter((r) => !p.hotelFilter.length || p.hotelFilter.includes(r.customer_id));
  const keyFn = PACING_SORT_KEYS[p.sortBy] || PACING_SORT_KEYS.account_name;
  const dir = p.sortDir === 'desc' ? -1 : 1;
  if (p.sortBy === 'account_name') {
    rows.sort((a, b) => dir * keyFn(a).localeCompare(keyFn(b)));
  } else {
    rows.sort((a, b) => dir * (keyFn(a) - keyFn(b)));
  }
  return rows;
}
function pacingSortTh(label, key) {
  const p = state.pacing;
  const active = p.sortBy === key;
  const arrow = active ? (p.sortDir === 'desc' ? ' ▼' : ' ▲') : '';
  return `<th data-pacing-sort="${key}" style="cursor:pointer;user-select:none${active ? ';color:var(--color-text-heading)' : ''}">${escapeHtml(label)}${arrow}</th>`;
}

// Barra de avance del objetivo: el relleno es lo consumido (tope visual en
// 100%, el número de al lado dice si se pasó) con el color del semáforo, y la
// línea vertical marca dónde debería ir según el ritmo esperado. En un mes
// ya cerrado el esperado es 100%, así que la línea se omite.
function pacingProgressBar(c) {
  const fill = Math.min(Math.max(c.consumedPct, 0), 1) * 100;
  const marker = Math.min(Math.max(c.expectedPct, 0), 1) * 100;
  const color = pacingSemaforoColor(c.deviationPct);
  return `<div class="pacing-bar" title="Consumido ${fmtPct0(c.consumedPct)} · esperado ${fmtPct0(c.expectedPct)}">
    <div class="pacing-bar-fill" style="width:${fill.toFixed(1)}%;background:${color}"></div>
    ${marker < 100 ? `<div class="pacing-bar-marker" style="left:${marker.toFixed(1)}%"></div>` : ''}
  </div>`;
}

function pacingRowHtml(r) {
  return withMoneyCurrency(r.currency, () => pacingRowHtmlBody(r));
}

function pacingRowHtmlBody(r) {
  if (r.error) {
    return `
      <tr>
        <td>${escapeHtml(r.account_name)}<div class="footnote">${escapeHtml(r.customer_id)}</div></td>
        <td colspan="8"><span class="delta-badge bad">${escapeHtml(r.error)}</span></td>
        <td><button class="btn-link" data-pacing-remove="${escapeHtml(r.customer_id)}">Quitar</button></td>
      </tr>`;
  }
  const c = pacingComputed(r);
  return `
    <tr>
      <td><button class="btn-link" data-pacing-campaigns-open="${escapeHtml(r.customer_id)}" data-pacing-campaigns-open-name="${escapeHtml(r.account_name)}">${escapeHtml(r.account_name)}</button><div class="footnote">${escapeHtml(r.customer_id)}</div></td>
      <td>${c.hasTarget ? fmtMoney(r.monthly_target) : 'N/D'}${r.months_total > 1 && r.months_with_target < r.months_total ? `<div class="footnote">objetivo de ${r.months_with_target} de ${r.months_total} meses</div>` : ''}</td>
      <td>${fmtMoney(r.spend_mtd)}${r.spend_total != null && Math.abs(r.spend_total - r.spend_mtd) > 0.005 && c.hasTarget ? `<div class="footnote">total del periodo ${fmtMoney(r.spend_total)}</div>` : ''}</td>
      <td>${c.hasTarget ? `<strong style="color:${pacingSemaforoColor(c.deviationPct)}">${fmtPct0(c.consumedPct)}</strong>${pacingProgressBar(c)}` : 'N/D'}</td>
      <td>${c.hasTarget ? fmtMoney(c.expected) : 'N/D'}</td>
      <td>${c.hasTarget ? `<span class="pacing-expected-pill">${fmtPct0(c.expectedPct)}</span>` : 'N/D'}</td>
      <td>${c.hasTarget ? pacingDeviationLabel(c.deviationPct) : 'N/D'}</td>
      <td>${c.hasTarget ? (c.recommendedDaily == null ? '—' : c.budgetExceeded ? `${fmtMoney(0)} <span class="delta-badge bad">objetivo superado</span>` : fmtMoney(c.recommendedDaily)) : 'N/D'}</td>
      <td>${c.hasTarget ? pacingStatusBadge(c.deviationPct, c.isComplete) : '<span class="delta-badge neutral">Sin objetivo en Billing</span>'}</td>
      <td><button class="btn-link" data-pacing-remove="${escapeHtml(r.customer_id)}">Quitar</button></td>
    </tr>`;
}

function renderPacingTable() {
  const p = state.pacing;
  if (p.watchlistStatus === 'loading' || p.rowsStatus === 'loading') {
    return `<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo ritmo de consumo…</p></div>`;
  }
  if (!p.watchlist || !p.watchlist.length) {
    return `<div class="ok-panel">Todavía no estás vigilando ninguna cuenta — agrégala arriba para empezar.</div>`;
  }
  // Los hoteles marcados que ya no están en la lista (se quitaron) salen del filtro.
  p.hotelFilter = p.hotelFilter.filter((id) => p.watchlist.some((w) => w.customer_id === id));
  const rowsHtml = getPacingRowsSorted().map((r) => pacingRowHtml(r)).join('');
  const hotelItems = [...p.watchlist]
    .sort((a, b) => String(a.account_name || a.customer_id).localeCompare(String(b.account_name || b.customer_id)))
    .map((w) => `<label style="display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:13px;cursor:pointer;white-space:nowrap"><input type="checkbox" data-pacing-hotel="${escapeHtml(w.customer_id)}" ${p.hotelFilter.includes(w.customer_id) ? 'checked' : ''} /> ${escapeHtml(w.account_name || w.customer_id)}</label>`)
    .join('');
  const hotelLabel = !p.hotelFilter.length ? 'Todos los hoteles'
    : p.hotelFilter.length === 1 ? ((p.watchlist.find((w) => w.customer_id === p.hotelFilter[0]) || {}).account_name || p.hotelFilter[0])
    : `${p.hotelFilter.length} hoteles`;
  const hotelSelect = p.watchlist.length > 1 ? `
          <div class="pacing-hotel-menu" style="position:relative;display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--color-text-muted)">
            Hotel
            <button type="button" id="pacing-hotel-toggle" class="btn-outline sm" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" aria-haspopup="true" aria-expanded="${p.hotelMenuOpen}">${escapeHtml(hotelLabel)} ▾</button>
            ${p.hotelMenuOpen ? `<div style="position:absolute;top:100%;right:0;z-index:20;margin-top:4px;min-width:240px;max-height:320px;overflow:auto;background:var(--color-surface,#fff);border:1px solid var(--color-border,#d9dde5);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:6px 0">
              <label style="display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:13px;cursor:pointer;font-weight:600"><input type="checkbox" data-pacing-hotel-all ${!p.hotelFilter.length ? 'checked' : ''} /> Todos los hoteles</label>
              <div style="border-top:1px solid var(--color-border,#e3e6ec);margin:4px 0"></div>
              ${hotelItems}
            </div>` : ''}
          </div>` : '';
  return `
    <div class="card table-panel">
      <div class="table-panel-head">
        <h3>Cuentas vigiladas (${p.hotelFilter.length ? `${p.hotelFilter.length} de ${p.watchlist.length}` : p.watchlist.length})</h3>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          ${hotelSelect}
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--color-text-muted)">
            Desde
            <input type="month" id="pacing-month-from" value="${escapeHtml(p.monthFrom || currentMonthValue())}" max="${currentMonthValue()}" />
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--color-text-muted)">
            Hasta
            <input type="month" id="pacing-month-to" value="${escapeHtml(p.monthTo || currentMonthValue())}" max="${currentMonthValue()}" />
          </label>
          ${p.monthFrom ? '<button class="btn-link" data-action="pacing-month-current">Volver al mes en curso</button>' : ''}
          <button class="btn-outline sm" data-action="pacing-clear-watchlist">Quitar todas</button>
        </div>
      </div>
      ${p.monthFrom ? `<p class="footnote" style="margin:0 0 10px">${pacingPeriodNote(p)}</p>` : ''}
      <div class="table-scroll sticky-head">
        <table>
          <thead><tr>
            ${pacingSortTh('Cuenta', 'account_name')}
            ${pacingSortTh(p.monthFrom && p.monthFrom !== p.monthTo ? 'Objetivo del periodo' : 'Objetivo mensual', 'monthly_target')}
            ${pacingSortTh(p.monthFrom ? 'Gastado (periodo)' : 'Gastado (mes a la fecha)', 'spend_mtd')}
            ${pacingSortTh('% consumido', 'consumed_pct')}
            ${pacingSortTh(p.monthFrom ? 'Esperado (periodo)' : 'Esperado (hasta ayer)', 'expected')}
            ${pacingSortTh('% esperado', 'expected_pct')}
            ${pacingSortTh('Desviación', 'deviation_pct')}
            ${pacingSortTh('Inversión diaria recomendada', 'recommended_daily')}
            <th>Estado</th>
            <th></th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="footnote" style="margin-top:14px">El objetivo mensual sale del presupuesto de cuenta activo en Billing (Google Ads); cuentas sin uno configurado (pago automático sin límite) se muestran solo con el gasto del mes. "Esperado" y "% esperado" se calculan hasta AYER (no hoy) porque el gasto del día en curso en Google Ads normalmente todavía no está completo. "En ritmo" = dentro de ±${(PACING_TOLERANCE * 100).toFixed(0)}% de lo esperado. La barra bajo "% consumido" muestra cuánto del objetivo se ha gastado; la línea vertical marca dónde debería ir según el ritmo esperado. "Inversión diaria recomendada" = lo que queda del objetivo mensual ÷ los días que quedan del mes (incluido hoy), para terminar el mes justo en el objetivo.</p>
    </div>`;
}

function openPacingCampaignsModal(customerId, accountName, highlightId) {
  const cm = state.pacing.campaignsModal;
  cm.customerId = customerId; cm.accountName = accountName; cm.highlightId = highlightId || null;
  cm.status = 'loading'; cm.rows = null; cm.error = null;
  cm.adjust = { budgetResourceName: null, newBudget: '', status: 'idle', preview: null, result: null, error: null };
  cm.revealedRoasIds = new Set();
  render();
  fetch(`/api/google-ads/pacing/account-campaigns?customer_id=${encodeURIComponent(customerId)}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      cm.rows = data.rows || [];
      cm.simulated = !!data.simulated;
      cm.currency = data.currency || '';
      cm.status = 'ready';
      render();
      scrollToFocusRow('pacing-focus-row');
    })
    .catch((err) => {
      cm.status = 'error'; cm.error = err.message || String(err);
      render();
    });
}

function closePacingCampaignsModal() {
  const cm = state.pacing.campaignsModal;
  cm.customerId = null; cm.accountName = null; cm.highlightId = null; cm.status = 'idle'; cm.rows = null; cm.error = null;
  render();
}

function startPacingBudgetEdit(budgetResourceName) {
  const cm = state.pacing.campaignsModal;
  cm.adjust = { budgetResourceName, newBudget: '', status: 'idle', preview: null, result: null, error: null };
  render();
}

function cancelPacingBudgetEdit() {
  const cm = state.pacing.campaignsModal;
  cm.adjust = { budgetResourceName: null, newBudget: '', status: 'idle', preview: null, result: null, error: null };
  render();
}

function adjustPacingCampaignBudget(preview) {
  const cm = state.pacing.campaignsModal;
  const adj = cm.adjust;
  const row = (cm.rows || []).find((r) => r.budget_resource_name === adj.budgetResourceName);
  if (!row) { adj.error = 'No se encontró la campaña.'; render(); return; }

  const newBudget = parseFloat(adj.newBudget);
  if (Number.isNaN(newBudget) || newBudget <= 0) {
    adj.error = 'Escribe un presupuesto diario válido, mayor que cero.';
    render();
    return;
  }

  adj.status = preview ? 'previewing' : 'applying';
  adj.error = null;
  render();

  fetch('/api/google-ads/pacing/campaign-budget-adjust', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: cm.customerId,
      budget_resource_name: row.budget_resource_name,
      new_daily_budget: newBudget,
      validate_only: preview,
    }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (preview) {
        adj.status = 'preview_ready';
        adj.preview = { newBudget, campaignName: row.campaign_name };
      } else {
        adj.status = 'done';
        adj.result = { newBudget, campaignName: row.campaign_name };
        row.daily_budget = newBudget; // refleja el nuevo valor en la tabla sin tener que volver a traer todo
      }
      render();
    })
    .catch((err) => {
      adj.status = 'error';
      adj.error = err.message || String(err);
      render();
    });
}

function pacingBudgetAdjustCell(row) {
  const cm = state.pacing.campaignsModal;
  const adj = cm.adjust;
  const isEditing = adj.budgetResourceName === row.budget_resource_name;

  if (!isEditing) {
    if (row.is_shared) {
      return `<span class="footnote" title="Esta campaña usa un presupuesto compartido con otras campañas — ajustarlo desde acá afectaría a todas, así que se deja en solo lectura.">Compartido — solo lectura</span>`;
    }
    return `<button class="btn-outline xs" data-action="pacing-budget-edit-start" data-budget="${escapeHtml(row.budget_resource_name)}">Ajustar</button>`;
  }

  const busy = adj.status === 'previewing' || adj.status === 'applying';

  if (adj.status === 'idle' || adj.status === 'error') {
    return `
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <input type="text" id="pacing-budget-adjust-input" value="${escapeHtml(adj.newBudget)}" placeholder="ej. 50" style="width:70px" />
        <button class="btn-accent xs" data-action="pacing-budget-edit-preview" ${busy ? 'disabled' : ''}>Vista previa</button>
        <button class="btn-outline xs" data-action="pacing-budget-edit-cancel">Cancelar</button>
      </div>
      ${adj.error ? `<div class="error-panel" style="margin-top:6px;font-size:11.5px">${escapeHtml(adj.error)}</div>` : ''}`;
  }

  if (busy) {
    return `<p class="footnote">${adj.status === 'previewing' ? 'Validando…' : 'Aplicando…'}</p>`;
  }

  if (adj.status === 'preview_ready' && adj.preview) {
    return `
      <div class="ok-panel" style="margin:4px 0;padding:8px 10px;font-size:11.5px">
        <strong>Vista previa lista.</strong> Presupuesto diario de "${escapeHtml(adj.preview.campaignName)}" a ${fmtMoney(adj.preview.newBudget)} — cambia el gasto real en producción.
        <div style="margin-top:6px;display:flex;gap:6px">
          <button class="btn-accent xs" data-action="pacing-budget-edit-confirm">Confirmar y aplicar</button>
          <button class="btn-outline xs" data-action="pacing-budget-edit-cancel">Cancelar</button>
        </div>
      </div>`;
  }

  if (adj.status === 'done' && adj.result) {
    return `<div class="ok-panel" style="margin:4px 0;padding:6px 10px;font-size:11.5px"><strong>Listo.</strong> Presupuesto actualizado a ${fmtMoney(adj.result.newBudget)}.</div>`;
  }

  return '';
}

function togglePacingRoasReveal(campaignId) {
  const ids = state.pacing.campaignsModal.revealedRoasIds;
  if (ids.has(campaignId)) ids.delete(campaignId);
  else ids.add(campaignId);
  render();
}

function pacingStrategyCell(row) {
  const label = BID_STRATEGY_LABELS_ES[row.bidding_strategy_type] || row.bidding_strategy_type;
  if (row.target_roas == null) return escapeHtml(label);
  const revealed = state.pacing.campaignsModal.revealedRoasIds.has(row.campaign_id);
  const text = revealed ? `${escapeHtml(label)} — ${(row.target_roas * 100).toFixed(0)}%` : escapeHtml(label);
  return `<button class="btn-link" data-pacing-roas-toggle="${escapeHtml(row.campaign_id)}" title="Click para ${revealed ? 'ocultar' : 'ver'} el ROAS objetivo">${text}</button>`;
}

// CPA %: gasto ÷ valor de conversión (la misma métrica de Rendimiento y Comparar periodos); N/D si no hay valor de conversión.
function pacingCpaPct(cost, convValue) {
  return convValue > 0 ? `${((cost / convValue) * 100).toFixed(1)}%` : 'N/D';
}

function pacingCampaignRowHtml(row) {
  const focus = state.pacing.campaignsModal.highlightId === row.campaign_id;
  return `
    <tr${focus ? ' id="pacing-focus-row" style="background:var(--gold-100,#fdf1d8)"' : ''}>
      <td>${escapeHtml(row.campaign_name)}</td>
      <td>${pacingStrategyCell(row)}</td>
      <td>${fmtInt(row.impressions)}</td>
      <td>${fmtInt(row.clicks)}</td>
      <td>${row.ctr != null ? (row.ctr * 100).toFixed(2) + '%' : 'N/D'}</td>
      <td>${fmtMoney(row.cost)}</td>
      <td>${fmtInt(row.conversions)}</td>
      <td>${row.cost_per_conv != null ? fmtMoney(row.cost_per_conv) : 'N/D'}</td>
      <td>${pacingCpaPct(row.cost, row.conv_value)}</td>
      <td>${row.daily_budget != null ? fmtMoney(row.daily_budget) : 'N/D'}</td>
      <td>${pacingBudgetAdjustCell(row)}</td>
    </tr>`;
}

function renderPacingCampaignsModal() {
  return withMoneyCurrency(state.pacing.campaignsModal.currency, () => renderPacingCampaignsModalBody());
}

function renderPacingCampaignsModalBody() {
  const cm = state.pacing.campaignsModal;
  if (!cm.customerId) return '';

  let body = '';
  if (cm.status === 'loading') {
    body = `<div class="state-panel loading"><div class="spinner"></div><p>Trayendo campañas…</p></div>`;
  } else if (cm.status === 'error') {
    body = `<div class="error-panel">${escapeHtml(cm.error)}</div>`;
  } else if (cm.status === 'ready') {
    if (!cm.rows || !cm.rows.length) {
      body = `<div class="ok-panel">Sin campañas activas para esta cuenta.</div>`;
    } else {
      const rowsHtml = cm.rows.map((r) => pacingCampaignRowHtml(r)).join('');
      // Totales de la cuenta. El CTR, el costo/conv y el CPA % se recalculan con los totales (no se promedian) y el
      // presupuesto diario suma cada presupuesto una sola vez, porque varias campañas pueden compartir uno.
      const tot = { impressions: 0, clicks: 0, cost: 0, conversions: 0, convValue: 0, budget: 0 };
      const seenBudgets = new Set();
      cm.rows.forEach((r) => {
        tot.impressions += r.impressions || 0;
        tot.clicks += r.clicks || 0;
        tot.cost += r.cost || 0;
        tot.conversions += r.conversions || 0;
        tot.convValue += r.conv_value || 0;
        const key = r.budget_resource_name || `c${r.campaign_id}`;
        if (r.daily_budget != null && !seenBudgets.has(key)) { seenBudgets.add(key); tot.budget += r.daily_budget; }
      });
      const totalHtml = `<tr class="pacing-total-row" style="font-weight:700;border-top:2px solid var(--color-text-heading);background:var(--gray-50)">
        <td>Total (${cm.rows.length} campaña${cm.rows.length === 1 ? '' : 's'})</td>
        <td></td>
        <td>${fmtInt(tot.impressions)}</td>
        <td>${fmtInt(tot.clicks)}</td>
        <td>${tot.impressions > 0 ? (tot.clicks / tot.impressions * 100).toFixed(2) + '%' : 'N/D'}</td>
        <td>${fmtMoney(tot.cost)}</td>
        <td>${fmtInt(tot.conversions)}</td>
        <td>${tot.conversions > 0 ? fmtMoney(tot.cost / tot.conversions) : 'N/D'}</td>
        <td>${pacingCpaPct(tot.cost, tot.convValue)}</td>
        <td>${seenBudgets.size ? fmtMoney(tot.budget) : 'N/D'}</td>
        <td></td>
      </tr>`;
      body = `
        ${cm.simulated ? `<div class="ok-panel" style="margin-bottom:12px"><strong>Modo simulado.</strong> Datos de ejemplo, no de una cuenta real.</div>` : ''}
        ${cm.highlightId && !cm.rows.some((r) => r.campaign_id === cm.highlightId) ? `<div class="error-panel" style="margin-bottom:12px">La campaña que venías viendo no aparece aquí: esta lista solo trae campañas activas.</div>` : (cm.highlightId ? `<p class="field-hint" style="margin:0 0 12px">La campaña que venías viendo está resaltada.</p>` : '')}
        <div class="table-scroll sticky-head" style="max-height:calc(85vh - 190px);min-height:0">
          <table>
            <thead><tr>
              <th>Campaña</th>
              <th>Estrategia de puja</th>
              <th>Impresiones</th>
              <th>Clics</th>
              <th>CTR</th>
              <th>Costo (mes)</th>
              <th>Conversiones</th>
              <th>Costo/conv</th>
              <th>CPA %</th>
              <th>Presupuesto diario</th>
              <th></th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot>${totalHtml}</tfoot>
          </table>
        </div>
        <p class="footnote" style="margin-top:12px">Solo campañas con status ENABLED. La fila Total suma las campañas de la lista (el presupuesto diario cuenta una sola vez los presupuestos compartidos). KPIs del mes en curso (mismo rango que el resto de Ritmo de consumo). CPA % = gasto ÷ valor de conversión (N/D si la campaña no tiene valor de conversión). Ajustar el presupuesto diario escribe de inmediato en la cuenta real de Google Ads — siempre pasa por vista previa antes de aplicar.</p>`;
    }
  }

  return `
    <div class="modal-overlay pacing-campaigns-overlay">
      <div class="modal-box card" data-modal-stop-propagation style="max-width:1240px">
        <button class="modal-close" data-action="pacing-campaigns-close" aria-label="Cerrar">${icon('x', 18)}</button>
        <h3 class="dense-chart-title" style="margin:0 0 16px;padding-right:28px">${escapeHtml(cm.accountName)}</h3>
        ${body}
      </div>
    </div>`;
}

function renderPacingPage() {
  const p = state.pacing;
  ensurePacingStatusLoaded();
  if (p.watchlistStatus === 'idle') loadPacingWatchlist();

  const simulatedNotice = p.simulated ? `
    <div class="ok-panel" style="margin-bottom:16px">
      <strong>Modo simulado.</strong> La API de Google Ads todavía no está configurada en el servidor
      (falta la aprobación del developer token de Google) — estos son datos de ejemplo, no de una cuenta real.
    </div>` : '';

  return `
    ${simulatedNotice}
    ${renderPacingMccPanel()}
    ${renderPacingAddPanel()}
    ${renderPacingTable()}
    ${p.error ? `<div class="error-panel" style="margin-top:12px">${escapeHtml(p.error)}</div>` : ''}
    ${renderPacingCampaignsModal()}
  `;
}

function renderAdminPage() {
  if (!currentUser.isAdmin) {
    return `<div class="error-panel">Esta sección requiere permisos de administrador.</div>`;
  }
  ensureAdminDataLoaded();
  const a = state.admin;

  // Panel de usuarios ---------------------------------------------------
  let usersBody = '';
  if (a.usersStatus === 'loading') {
    usersBody = `<div class="card state-panel loading"><div class="spinner"></div><p>Cargando usuarios…</p></div>`;
  } else if (a.usersStatus === 'error') {
    usersBody = `<div class="error-panel">${escapeHtml(a.usersError)}</div>`;
  } else if (a.usersStatus === 'ready') {
    const meIsSuperAdmin = a.users.some((x) => x.username === currentUser.username && x.is_super_admin);
    const rows = a.users.map((u) => {
      const isSelf = u.username === currentUser.username;
      const deleteCell = isSelf
        ? '<span class="footnote">Tu cuenta</span>'
        : u.is_super_admin
          ? '<span class="footnote">No se puede borrar</span>'
          : `<button class="btn-outline xs" data-admin-delete-user="${escapeHtml(u.username)}">Eliminar</button>`;
      const resetCell = isSelf
        ? ''
        : (u.is_super_admin && !meIsSuperAdmin)
          ? '<span class="footnote">Requiere super admin</span>'
          : `<button class="btn-outline xs" data-admin-reset-password="${u.id}" data-admin-reset-username="${escapeHtml(u.username)}">Restablecer contraseña</button>`;
      const adminCell = u.is_super_admin
        ? '<span class="footnote">Siempre administrador</span>'
        : isSelf
          ? '<span class="footnote">No puedes quitarte el tuyo</span>'
          : u.is_admin
            ? `<button class="btn-outline xs" data-admin-set-admin="${u.id}" data-admin-set-admin-value="0" data-admin-set-admin-username="${escapeHtml(u.username)}">Quitar admin</button>`
            : `<button class="btn-outline xs" data-admin-set-admin="${u.id}" data-admin-set-admin-value="1" data-admin-set-admin-username="${escapeHtml(u.username)}">Hacer admin</button>`;
      return `
      <tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${u.is_super_admin ? '<span class="delta-badge good">Super admin</span>' : (u.is_admin ? '<span class="delta-badge good">Administrador</span>' : '<span class="delta-badge neutral">Usuario</span>')}</td>
        <td>${fmtDateTime(u.created_at)}</td>
        <td>${fmtDateTime(u.last_login_at)}</td>
        <td>${adminCell}</td>
        <td>${deleteCell}</td>
        <td>${resetCell}</td>
      </tr>`;
    }).join('');
    const setAdminErrorHtml = a.setAdminError ? `<div class="error-panel" style="margin-bottom:14px">${escapeHtml(a.setAdminError)}</div>` : '';
    let resetResultHtml = '';
    if (a.resetPassword.result) {
      const rp = a.resetPassword.result;
      resetResultHtml = `
        <div class="ok-panel" style="margin-bottom:14px">
          <strong>Contraseña temporal para ${escapeHtml(rp.username)}:</strong>
          <code style="font-family:ui-monospace,monospace;background:var(--gray-100);padding:2px 6px;border-radius:4px;font-size:14px;user-select:all">${escapeHtml(rp.temp_password)}</code>
          <p class="footnote" style="margin-top:6px">
            Pásasela por fuera de la plataforma (Slack, en persona, etc.) — no vuelve a mostrarse. Al iniciar sesión con ella, se le pedirá definir una contraseña propia antes de continuar. Cualquier sesión que tuviera abierta esa cuenta quedó cerrada.
          </p>
          <button class="btn-outline xs" data-action="admin-reset-password-dismiss" style="margin-top:8px">Ya la copié, ocultar</button>
        </div>`;
    } else if (a.resetPassword.status === 'error') {
      resetResultHtml = `<div class="error-panel" style="margin-bottom:14px">${escapeHtml(a.resetPassword.error)}</div>`;
    }
    usersBody = `
      <div class="card table-panel">
        <div class="table-panel-head"><h3>Usuarios registrados (${a.users.length})</h3></div>
        ${resetResultHtml}
        ${setAdminErrorHtml}
        <div class="table-scroll">
          <table>
            <thead><tr><th>Usuario</th><th>Rol</th><th>Creada</th><th>Último ingreso</th><th></th><th></th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="footnote" style="margin-top:14px">
          Los administradores tienen acceso a todas las cuentas de Google Ads sin restricción y pueden entrar al panel de administración — dalos y quítalos con el botón de cada fila. El resto de usuarios solo pueden tocar las cuentas que les asignes abajo.
        </p>
      </div>`;
  } else {
    usersBody = '';
  }

  // Panel de otorgar acceso ---------------------------------------------
  const g = a.grant;
  const nonAdminUsers = (a.users || []).filter((u) => !u.is_admin);
  const userOptions = nonAdminUsers.map((u) => `<option value="${u.id}" ${String(u.id) === String(g.userId) ? 'selected' : ''}>${escapeHtml(u.username)}</option>`).join('');

  let accountPicker = '';
  if (g.accountsStatus === 'idle') {
    accountPicker = `<button class="btn-outline sm" data-action="admin-grant-load-accounts">Buscar en las cuentas del MCC</button>`;
  } else if (g.accountsStatus === 'loading') {
    accountPicker = `<p class="footnote">Cargando cuentas del MCC…</p>`;
  } else if (g.accountsStatus === 'error') {
    accountPicker = `<div class="error-panel">${escapeHtml(g.accountsError)}</div>`;
  } else if (g.accountsStatus === 'ready') {
    const filter = (g.accountFilter || '').trim().toLowerCase();
    let matches = [];
    if (filter.length >= 2) {
      matches = g.accounts.filter((acc) => acc.id.includes(filter) || (acc.name || '').toLowerCase().includes(filter)).slice(0, 25);
    }
    const matchesHtml = matches.length
      ? `<div class="table-scroll" style="max-height:220px;margin-top:8px">
          <table>
            <tbody>
              ${matches.map((acc) => `
                <tr>
                  <td>${escapeHtml(acc.name)}</td>
                  <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(acc.id)}</td>
                  <td><button class="btn-outline xs" data-admin-pick-account="${escapeHtml(acc.id)}" data-admin-pick-name="${escapeHtml(acc.name)}">Elegir</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`
      : (filter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(filter)}".</p>` : '');
    accountPicker = `
      <input type="text" id="admin-grant-account-filter" placeholder="Busca por nombre o ID de cuenta (${g.accounts.length} cuentas)…" value="${escapeHtml(g.accountFilter)}" style="width:100%" />
      ${matchesHtml}`;
  }

  const grantForm = `
    <div class="card control-panel" style="flex-direction:column;align-items:stretch;gap:16px">
      <h3 class="section-title" style="margin:0">Otorgar acceso a una cuenta</h3>
      ${nonAdminUsers.length === 0 ? '<p class="footnote">No hay usuarios no-administradores registrados todavía.</p>' : `
      <div class="field">
        <label>Usuario</label>
        <select id="admin-grant-user">
          <option value="">Elige un usuario…</option>
          ${userOptions}
        </select>
      </div>
      <div class="field">
        <label>Cuenta de Google Ads</label>
        ${accountPicker}
      </div>
      <div class="field">
        <label>customer_id (solo números)</label>
        <input type="text" id="admin-grant-customer-id" placeholder="ej. 1234567890" value="${escapeHtml(g.customerId)}" style="max-width:220px" />
      </div>
      <div class="field">
        <label>Nombre de la cuenta (opcional, solo para mostrar en la lista)</label>
        <input type="text" id="admin-grant-account-name" value="${escapeHtml(g.accountName)}" style="max-width:400px" />
      </div>
      ${g.error ? `<div class="error-panel">${escapeHtml(g.error)}</div>` : ''}
      <div>
        <button class="btn-accent" data-action="admin-grant-submit" ${g.status === 'granting' ? 'disabled' : ''}>
          ${g.status === 'granting' ? 'Otorgando…' : 'Otorgar acceso'}
        </button>
      </div>`}
    </div>`;

  // Panel de acceso por MCC ----------------------------------------------
  const mg = a.mccGrant;
  const mccUserOptions = nonAdminUsers.map((u) => `<option value="${u.id}" ${String(u.id) === String(mg.userId) ? 'selected' : ''}>${escapeHtml(u.username)}</option>`).join('');
  let mccPicker = '';
  if (mg.groupsStatus === 'idle') {
    mccPicker = `<button class="btn-outline sm" data-action="admin-mcc-load-groups">Buscar un MCC (ej. una cadena de hoteles)</button>`;
  } else if (mg.groupsStatus === 'loading') {
    mccPicker = `<p class="footnote">Cargando MCCs…</p>`;
  } else if (mg.groupsStatus === 'error') {
    mccPicker = `<div class="error-panel">${escapeHtml(mg.groupsError)}</div>`;
  } else if (!mg.groups.length) {
    mccPicker = `<p class="footnote">No hay MCCs para elegir — la API de Google Ads no está configurada o la cuenta administradora no tiene sub-MCCs.</p>`;
  } else {
    const mccFilter = (mg.filter || '').trim().toLowerCase();
    const mccMatches = mccFilter.length >= 2
      ? mg.groups.filter((gr) => gr.id.includes(mccFilter) || (gr.name || '').toLowerCase().includes(mccFilter)).slice(0, 25)
      : [];
    const mccMatchesHtml = mccMatches.length
      ? `<div class="table-scroll" style="max-height:220px;margin-top:8px"><table><tbody>
          ${mccMatches.map((gr) => `
            <tr>
              <td>${escapeHtml(gr.name)}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(gr.id)}</td>
              <td><button class="btn-outline xs" data-admin-mcc-pick="${escapeHtml(gr.id)}" data-admin-mcc-pick-name="${escapeHtml(gr.name)}">Elegir</button></td>
            </tr>`).join('')}
        </tbody></table></div>`
      : (mccFilter.length >= 2 ? `<p class="footnote" style="margin-top:8px">Sin resultados para "${escapeHtml(mccFilter)}".</p>` : '');
    mccPicker = `
      <input type="text" id="admin-mcc-filter" placeholder="Busca por nombre o ID de MCC (${mg.groups.length} MCCs)…" value="${escapeHtml(mg.filter)}" style="width:100%" />
      ${mccMatchesHtml}`;
  }
  let mccPreview = '';
  if (mg.pickedId) {
    const countText = mg.countStatus === 'loading' ? 'Contando sus cuentas…'
      : mg.countStatus === 'error' ? `No se pudo contar las cuentas: ${escapeHtml(mg.countError)}`
      : `Tiene ${mg.count} cuenta${mg.count === 1 ? '' : 's'} hoy. El usuario verá también las que se agreguen después.`;
    mccPreview = `<p class="footnote" style="font-weight:600;color:var(--color-text-heading)">MCC elegido: ${escapeHtml(mg.pickedName)} (${escapeHtml(mg.pickedId)}) — ${countText}</p>`;
  }
  const mccGrantForm = `
    <div class="card control-panel" style="flex-direction:column;align-items:stretch;gap:16px">
      <h3 class="section-title" style="margin:0">Otorgar acceso a un MCC completo</h3>
      <p class="footnote" style="margin:0">El usuario queda ligado al MCC: ve y puede modificar todas sus cuentas, incluidas las que se abran después (la lista se actualiza cada ~10 minutos). Es solo para sub-MCCs, nunca para el MCC raíz.</p>
      ${nonAdminUsers.length === 0 ? '<p class="footnote">No hay usuarios no-administradores registrados todavía.</p>' : `
      <div class="field">
        <label>Usuario</label>
        <select id="admin-mcc-grant-user">
          <option value="">Elige un usuario…</option>
          ${mccUserOptions}
        </select>
      </div>
      <div class="field">
        <label>MCC</label>
        ${mccPicker}
      </div>
      ${mccPreview}
      ${mg.error ? `<div class="error-panel">${escapeHtml(mg.error)}</div>` : ''}
      <div>
        <button class="btn-accent" data-action="admin-mcc-grant-submit" ${(mg.status === 'granting' || mg.countStatus !== 'ready') ? 'disabled' : ''}>
          ${mg.status === 'granting' ? 'Otorgando…' : 'Otorgar acceso al MCC'}
        </button>
      </div>`}
    </div>`;

  // Panel de accesos otorgados -------------------------------------------
  let accessBody = '';
  if (a.accessStatus === 'loading') {
    accessBody = `<div class="card state-panel loading"><div class="spinner"></div><p>Cargando accesos…</p></div>`;
  } else if (a.accessStatus === 'error') {
    accessBody = `<div class="error-panel">${escapeHtml(a.accessError)}</div>`;
  } else if (a.accessStatus === 'ready') {
    const rows = a.access.map((row) => `
      <tr>
        <td>${escapeHtml(row.username)}</td>
        <td>${escapeHtml(row.account_name || 'N/D')}</td>
        <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(row.customer_id)}</td>
        <td>${fmtDateTime(row.created_at)}</td>
        <td><button class="btn-outline xs" data-admin-revoke-user="${row.user_id}" data-admin-revoke-customer="${escapeHtml(row.customer_id)}">Revocar</button></td>
      </tr>`).join('');
    const mccRows = (a.mccAccess || []).map((row) => `
      <tr>
        <td>${escapeHtml(row.username)}</td>
        <td>${escapeHtml(row.mcc_name || 'N/D')}</td>
        <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(row.mcc_customer_id)}</td>
        <td>${fmtDateTime(row.created_at)}</td>
        <td><button class="btn-outline xs" data-admin-mcc-revoke-user="${row.user_id}" data-admin-mcc-revoke-id="${escapeHtml(row.mcc_customer_id)}">Revocar</button></td>
      </tr>`).join('');
    const mccAccessBody = `
      <div class="card table-panel" style="margin-bottom:16px">
        <div class="table-panel-head"><h3>Accesos por MCC (${(a.mccAccess || []).length})</h3></div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Usuario</th><th>MCC</th><th>customer_id</th><th>Otorgado</th><th></th></tr></thead>
            <tbody>${mccRows.length ? mccRows : '<tr><td colspan="5" class="footnote">Todavía no ligaste a nadie a un MCC.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
    accessBody = `${mccAccessBody}
      <div class="card table-panel">
        <div class="table-panel-head"><h3>Accesos otorgados (${a.access.length})</h3></div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Usuario</th><th>Cuenta</th><th>customer_id</th><th>Otorgado</th><th></th></tr></thead>
            <tbody>${rows.length ? rows : '<tr><td colspan="5" class="footnote">Todavía no le diste acceso a ninguna cuenta a nadie.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }

  // El consumo y costo de la IA solo lo ve el super admin.
  return `${usersBody}${currentUser.isSuperAdmin ? renderAdminAiUsage() : ''}${mccGrantForm}${grantForm}${accessBody}`;
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

// ---- Campañas: listado de las campañas de tus cuentas vigiladas, con KPIs y pausar/activar ----
const CAMPANAS_RENDER_LIMIT = 400;
const CAMPAIGN_CHANNEL_LABELS = {
  SEARCH: 'Search', PERFORMANCE_MAX: 'Performance Max', DISPLAY: 'Display', DEMAND_GEN: 'Demand Gen', DISCOVERY: 'Demand Gen',
  VIDEO: 'YouTube', SHOPPING: 'Shopping', HOTEL: 'Hotel', TRAVEL: 'Viajes', MULTI_CHANNEL: 'App', SMART: 'Smart',
  LOCAL: 'Local', LOCAL_SERVICES: 'Servicios locales',
};

function campanasTypeLabel(t) { return CAMPAIGN_CHANNEL_LABELS[t] || (t ? t.toLowerCase().replace(/_/g, ' ') : 'Otro'); }

function campanasHotelOf(r) {
  return state.campanas.hotelBy === 'nombre' ? deriveHotelName(r.campaign_name) : r.account_name;
}

function campanasMoney(v, currency) { return withMoneyCurrency(currency, () => fmtMoney(v)); }

// Cuota de impresiones y similares llegan como fracción 0-1; si Google no las da para el tipo de campaña, son null.
// Google devuelve ~0.0999 para "menos del 10%" (Performance Max).
function campanasShare(v) { return v == null ? 'N/D' : (Math.abs(v - 0.0999) < 0.0002 ? '< 10%' : (v * 100).toFixed(1) + '%'); }

// Estrategia de puja como la nombra Google Ads: con objetivo configurado se llama "ROAS objetivo" o "CPA objetivo".
function campanasStrategy(r) {
  let label = BID_STRATEGY_LABELS_ES[r.bidding_strategy_type] || r.bidding_strategy_type || 'N/D';
  let target = '';
  if (r.bidding_strategy_type === 'MAXIMIZE_CONVERSION_VALUE' && r.target_roas != null) label = 'ROAS objetivo';
  if (r.bidding_strategy_type === 'MAXIMIZE_CONVERSIONS' && r.target_cpa != null) label = 'CPA objetivo';
  if (r.target_roas != null && (r.bidding_strategy_type === 'TARGET_ROAS' || label === 'ROAS objetivo')) target = `${r.target_roas.toFixed(2)}×`;
  else if (r.target_cpa != null && (r.bidding_strategy_type === 'TARGET_CPA' || label === 'CPA objetivo')) target = campanasMoney(r.target_cpa, r.currency);
  return { label, target };
}

// Se llama desde el dibujado de la página: solo arranca la carga la primera vez que se entra.
function ensureCampanasLoaded() {
  const c = state.campanas;
  if (c.watchlistStatus !== 'idle' || !currentUser.isSuperAdmin) return;
  c.watchlistStatus = 'loading';
  setTimeout(loadCampanas, 0);
}

// Lee la lista de cuentas de Ritmo de consumo y trae las campañas de cada una.
function loadCampanas() {
  const c = state.campanas;
  if (!c.dateFrom || !c.dateTo || c.dateFrom > c.dateTo) { c.error = 'Elige un rango de fechas válido (desde no puede ser posterior a hasta).'; render(); return; }
  const token = ++c.loadToken;
  c.loadedFrom = c.dateFrom; c.loadedTo = c.dateTo;
  c.detail = emptyCampanaDetail(c.detail.token + 1);
  c.watchlistStatus = 'loading'; c.status = 'loading'; c.error = null; c.partial = []; c.confirm = null; c.notice = null;
  render();
  fetch('/api/google-ads/pacing/watchlist')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      c.watchlist = data.watchlist || [];
      c.watchlistStatus = 'ready';
      if (!c.watchlist.length) { if (token === c.loadToken) { c.rows = []; c.status = 'ready'; render(); } return null; }
      return oppMapPool(c.watchlist, 4, (acc) => {
        const params = new URLSearchParams({ customer_id: acc.customer_id, date_from: c.dateFrom, date_to: c.dateTo });
        return fetch(`/api/google-ads/campaigns-overview?${params.toString()}`)
          .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
          .then(({ ok: good, d }) => { if (!good) throw new Error(d.error || 'Error desconocido.'); return { acc, d }; })
          .catch((err) => ({ acc, error: err.message || String(err) }));
      });
    })
    .then((results) => {
      if (!results || token !== c.loadToken) return;
      const nameOf = (acc) => acc.account_name || acc.customer_id;
      c.rows = results.filter((x) => !x.error).flatMap(({ acc, d }) => (d.campaigns || []).map((camp) => ({
        ...camp, key: `${acc.customer_id}:${camp.campaign_id}`, customer_id: acc.customer_id,
        account_name: nameOf(acc), currency: d.currency || '',
      })));
      c.partial = results.filter((x) => x.error).map((x) => `${nameOf(x.acc)}: ${x.error}`);
      c.simulated = results.some((x) => x.d && x.d.simulated);
      c.hotelFilter = 'all'; c.typeFilter = 'all';
      c.status = 'ready';
      render();
    })
    .catch((err) => {
      if (token !== c.loadToken) return;
      c.watchlistStatus = 'error'; c.status = 'error'; c.error = err.message || String(err);
      render();
    });
}

// Pausa o activa una campaña. Escribe de verdad en Google Ads; la confirmación ya se pidió en la propia fila.
function setCampanaStatus(key, newStatus) {
  const c = state.campanas;
  const row = c.rows.find((r) => r.key === key);
  if (!row || c.busy[key]) return;
  c.busy[key] = true; c.confirm = null; c.notice = null;
  render();
  fetch('/api/google-ads/campaign-status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: row.customer_id, campaign_id: row.campaign_id, campaign_name: row.campaign_name,
      old_status: row.status, status: newStatus, validate_only: false,
    }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      row.status = newStatus;
      c.notice = { kind: 'ok', text: `${newStatus === 'PAUSED' ? 'Pausada' : 'Activada'}: ${row.campaign_name} (${row.account_name}).` };
    })
    .catch((err) => { c.notice = { kind: 'error', text: `No se pudo cambiar "${row.campaign_name}": ${err.message || err}` }; })
    .finally(() => { delete c.busy[key]; render(); });
}

function campanasFilteredRows() {
  const c = state.campanas;
  const q = (c.search || '').trim().toLowerCase();
  let rows = c.rows.filter((r) => {
    if (c.statusFilter !== 'all' && r.status !== c.statusFilter) return false;
    if (c.hotelFilter !== 'all' && campanasHotelOf(r) !== c.hotelFilter) return false;
    if (c.typeFilter !== 'all' && r.channel_type !== c.typeFilter) return false;
    if (q && !r.campaign_name.toLowerCase().includes(q) && !r.account_name.toLowerCase().includes(q)) return false;
    return true;
  });
  const by = c.sortBy;
  rows = rows.slice().sort((a, b) => {
    if (by === 'name') return a.campaign_name.localeCompare(b.campaign_name);
    if (by === 'hotel') return campanasHotelOf(a).localeCompare(campanasHotelOf(b)) || b.cost - a.cost;
    return (b[by] || 0) - (a[by] || 0);
  });
  return rows;
}

function campanasTotalsHtml(rows) {
  // Cada moneda se suma por separado: euros y pesos no se pueden mezclar.
  const byCur = new Map();
  rows.forEach((r) => {
    const t = byCur.get(r.currency) || { cost: 0, impressions: 0, clicks: 0, conversions: 0, conv_value: 0, n: 0 };
    t.cost += r.cost; t.impressions += r.impressions; t.clicks += r.clicks; t.conversions += r.conversions; t.conv_value += r.conv_value; t.n += 1;
    byCur.set(r.currency, t);
  });
  const multi = byCur.size > 1;
  return [...byCur.entries()].map(([cur, t]) => `
    ${multi ? `<p class="field-hint" style="margin:0 0 6px"><strong>${escapeHtml(cur || 'Sin moneda')}</strong> · ${fmtInt(t.n)} campañas</p>` : ''}
    <div class="stat-grid">
      <div class="card stat-card"><div class="stat-label">Gasto</div><div class="stat-value">${campanasMoney(t.cost, cur)}</div></div>
      <div class="card stat-card"><div class="stat-label">Clics</div><div class="stat-value">${fmtInt(t.clicks)}</div><div class="stat-sub">CTR ${t.impressions ? ((t.clicks / t.impressions) * 100).toFixed(2) + '%' : 'N/D'}</div></div>
      <div class="card stat-card"><div class="stat-label">Conversiones</div><div class="stat-value">${fmtInt(t.conversions)}</div><div class="stat-sub">CPA ${t.conversions ? campanasMoney(t.cost / t.conversions, cur) : 'N/D'}</div></div>
      <div class="card stat-card"><div class="stat-label">ROAS</div><div class="stat-value">${t.cost > 0 && t.conv_value > 0 ? (t.conv_value / t.cost).toFixed(2) + '×' : 'N/D'}</div><div class="stat-sub">Valor ${campanasMoney(t.conv_value, cur)}</div></div>
    </div>`).join('');
}

const CAMPANAS_TABLE_HEAD = '<thead><tr><th style="min-width:240px">Campaña</th><th>Estado</th><th>Tipo</th><th>Estrategia de puja</th><th>Presupuesto/día</th><th>Gasto</th><th>Impr.</th><th>Clics</th><th>CTR</th><th>CPC</th><th>Conv.</th><th>CPA</th><th>ROAS</th><th>Cuota de impr.</th><th>Cuota de impr. superior</th><th>Cuota perdida (presupuesto)</th><th>Cuota perdida (ranking)</th></tr></thead>';

function renderCampanasRow(r, plain) {
  const c = state.campanas;
  const active = r.status === 'ENABLED';
  const busy = !!c.busy[r.key];
  const target = active ? 'PAUSED' : 'ENABLED';
  let actionCell;
  if (plain) actionCell = '';
  else if (busy) actionCell = '<span class="field-hint">Aplicando…</span>';
  else if (c.confirm === r.key) {
    actionCell = `
      <span class="field-hint" style="margin-right:6px;display:inline">¿${active ? 'Pausar' : 'Activar'}?</span>
      <button class="btn-accent xs" data-camp-do="${escapeHtml(r.key)}" data-camp-status="${target}">Sí, ${active ? 'pausar' : 'activar'}</button>
      <button class="btn-outline xs" data-camp-cancel="1">Cancelar</button>`;
  } else {
    actionCell = `<button class="btn-outline xs" data-camp-ask="${escapeHtml(r.key)}">${active ? 'Pausar' : 'Activar'}</button>`;
  }
  const cur = r.currency;
  const strat = campanasStrategy(r);
  return `
    <tr>
      <td data-camp-open="${escapeHtml(r.key)}" style="cursor:pointer" title="Ver las gráficas de esta campaña"><strong style="text-decoration:underline;text-decoration-color:var(--color-border);text-underline-offset:3px">${escapeHtml(r.campaign_name)}</strong><div class="field-hint">${escapeHtml(campanasHotelOf(r))}</div></td>
      <td style="min-width:150px"><div style="margin-bottom:4px"><strong>${active ? 'Activa' : 'Pausada'}</strong></div>${actionCell}</td>
      <td>${escapeHtml(campanasTypeLabel(r.channel_type))}</td>
      <td>${escapeHtml(strat.label)}${strat.target ? `<div class="field-hint">${escapeHtml(strat.target)}</div>` : ''}</td>
      <td>${r.budget == null ? 'N/D' : campanasMoney(r.budget, cur)}</td>
      <td>${campanasMoney(r.cost, cur)}</td>
      <td>${fmtInt(r.impressions)}</td>
      <td>${fmtInt(r.clicks)}</td>
      <td>${r.impressions ? ((r.clicks / r.impressions) * 100).toFixed(2) + '%' : 'N/D'}</td>
      <td>${r.clicks ? campanasMoney(r.cost / r.clicks, cur) : 'N/D'}</td>
      <td>${r.conversions ? r.conversions.toFixed(r.conversions % 1 ? 1 : 0) : '0'}</td>
      <td>${r.conversions ? campanasMoney(r.cost / r.conversions, cur) : 'N/D'}</td>
      <td>${r.cost > 0 && r.conv_value > 0 ? (r.conv_value / r.cost).toFixed(2) + '×' : 'N/D'}</td>
      <td>${campanasShare(r.impr_share)}</td>
      <td>${campanasShare(r.top_impr_share)}</td>
      <td>${campanasShare(r.lost_is_budget)}</td>
      <td>${campanasShare(r.lost_is_rank)}</td>
    </tr>`;
}

function renderCampanasPage() {
  const c = state.campanas;
  if (!currentUser.isSuperAdmin) {
    return `<div class="card state-panel idle"><p>Esta sección todavía no está disponible para tu usuario.</p></div>`;
  }
  ensureCampanasLoaded();

  const controls = `
    <div class="card control-panel align-end">
      <div class="field"><label>Desde</label><input type="date" id="camp-date-from" value="${escapeHtml(c.dateFrom)}" /></div>
      <div class="field"><label>Hasta</label><input type="date" id="camp-date-to" value="${escapeHtml(c.dateTo)}" /></div>
      <button class="btn-outline" data-action="camp-refresh">Actualizar</button>
      <p class="field-hint" style="max-width:380px">Se muestran las campañas de las cuentas de tu lista de <strong>Ritmo de consumo</strong>${c.watchlistStatus === 'ready' ? ` (${fmtInt(c.watchlist.length)})` : ''}. Los KPIs son del rango elegido; el estado es el actual.</p>
    </div>`;

  const notice = c.notice ? `<div class="${c.notice.kind === 'ok' ? 'ok-panel' : 'error-panel'}" style="margin-bottom:16px">${escapeHtml(c.notice.text)}</div>` : '';
  const errorHtml = c.error ? `<div class="error-panel">${escapeHtml(c.error)}</div>` : '';

  if (c.status === 'idle' || c.status === 'loading') {
    return `${controls}${errorHtml}<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo las campañas de tus cuentas…</p></div>`;
  }
  if (c.status === 'error') return `${controls}${errorHtml}`;
  if (!c.watchlist.length) {
    return `${controls}
      <div class="card state-panel idle">
        ${icon('list-checks', 30)}
        <p>Tu lista de Ritmo de consumo está vacía. Agrega ahí las cuentas que quieras ver y vuelve a esta sección.</p>
        <button class="btn-outline" data-action="camp-go-pacing">Ir a Ritmo de consumo</button>
      </div>`;
  }

  const hotels = [...new Set(c.rows.map(campanasHotelOf))].sort((a, b) => a.localeCompare(b));
  const types = [...new Set(c.rows.map((r) => r.channel_type))].sort((a, b) => campanasTypeLabel(a).localeCompare(campanasTypeLabel(b)));
  const opt = (value, label, current) => `<option value="${escapeHtml(value)}" ${current === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  const filters = `
    <div class="card control-panel align-end">
      <div class="field"><label>Hotel según</label>
        <select id="camp-hotel-by" style="width:200px">${opt('cuenta', 'La cuenta', c.hotelBy)}${opt('nombre', 'El nombre de la campaña', c.hotelBy)}</select>
      </div>
      <div class="field"><label>Hotel</label>
        <select id="camp-hotel-filter" style="width:240px">${opt('all', 'Todos los hoteles', c.hotelFilter)}${hotels.map((h) => opt(h, h, c.hotelFilter)).join('')}</select>
      </div>
      <div class="field"><label>Tipo de campaña</label>
        <select id="camp-type-filter" style="width:200px">${opt('all', 'Todos los tipos', c.typeFilter)}${types.map((t) => opt(t, campanasTypeLabel(t), c.typeFilter)).join('')}</select>
      </div>
      <div class="field"><label>Estado</label>
        <select id="camp-status-filter" style="width:150px">${opt('ENABLED', 'Activas', c.statusFilter)}${opt('PAUSED', 'Pausadas', c.statusFilter)}${opt('all', 'Todas', c.statusFilter)}</select>
      </div>
      <div class="field"><label>Ordenar por</label>
        <select id="camp-sort" style="width:150px">${opt('cost', 'Gasto', c.sortBy)}${opt('conversions', 'Conversiones', c.sortBy)}${opt('clicks', 'Clics', c.sortBy)}${opt('hotel', 'Hotel', c.sortBy)}${opt('name', 'Nombre', c.sortBy)}</select>
      </div>
      <div class="field"><label>Buscar</label><input type="text" id="camp-search" placeholder="Campaña u hotel…" value="${escapeHtml(c.search)}" style="width:220px" /></div>
    </div>`;

  const partial = c.partial.length ? `<div class="error-panel" style="margin-bottom:16px"><strong>No se pudieron leer ${c.partial.length} cuenta(s):</strong><br>${c.partial.map(escapeHtml).join('<br>')}</div>` : '';
  const sim = c.simulated ? `<div class="ok-panel" style="margin:10px 0"><strong>Modo simulado.</strong> La API de Google Ads no está configurada en el servidor: son datos de ejemplo y pausar o activar no escribe en ninguna cuenta.</div>` : '';

  const rows = campanasFilteredRows();
  const shown = rows.slice(0, CAMPANAS_RENDER_LIMIT);
  const nActive = rows.filter((r) => r.status === 'ENABLED').length;
  const table = `
    <div class="card table-panel">
      <div class="table-panel-head"><h3>Campañas (${fmtInt(rows.length)}) · ${fmtInt(nActive)} activas <span class="field-hint" style="font-weight:400">· haz clic en una campaña para ver sus gráficas</span></h3>
        <button class="btn-outline xs" data-action="camp-html" ${rows.length ? '' : 'disabled'}>Descargar HTML</button></div>
      <div class="table-scroll sticky-head">
        <table>
          ${CAMPANAS_TABLE_HEAD}
          <tbody>${shown.map((r) => renderCampanasRow(r)).join('') || '<tr><td colspan="17" class="footnote">Ninguna campaña coincide con los filtros.</td></tr>'}</tbody>
        </table>
      </div>
      <p class="footnote" style="margin-top:10px">Las cuatro cuotas de impresiones son del rango elegido; Google no las da para todos los tipos de campaña (p. ej. Display), y ahí aparece N/D. "Cuota de impr. superior" es la parte de impresiones que salió en las posiciones de arriba.</p>
      ${rows.length > shown.length ? `<p class="footnote" style="margin-top:10px">Mostrando ${shown.length} de ${fmtInt(rows.length)}. Usa los filtros para acotar.</p>` : ''}
    </div>`;

  return `${controls}${sim}${partial}${notice}${filters}${rows.length ? campanasTotalsHtml(rows) : ''}${table}${renderCampanaDetailModal()}`;
}

// ---- Campañas: ventana de detalle de una campaña, con pestañas ----
// Mientras se arma el HTML descargable, las pestañas se dibujan sin la parte de Cambios (aviso del Resumen, bloque de
// acciones y líneas rojas de las gráficas). La pantalla normal no cambia.
let campanaExportMode = false;

const CAMPANA_TABS = [
  ['resumen', 'Resumen'], ['graficas', 'Gráficas'], ['grupos', 'Grupos y regiones'], ['segmentos', 'Segmentos'],
  ['palabras', 'Palabras clave'], ['posicion', 'Posición en la subasta'], ['cambios', 'Cambios'],
];

function emptyCampanaPart() { return { status: 'idle', error: null, data: null }; }

// `daily` (gráficas) guarda status/error/days; el resto de pestañas, una "parte" cada una.
function emptyCampanaDetail(token) {
  return {
    key: null, token, tab: 'resumen', exporting: false, exportError: null,
    status: 'idle', error: null, days: [], currency: '', simulated: false,
    breakdown: emptyCampanaPart(), ctx: emptyCampanaPart(), seg: emptyCampanaPart(), kw: emptyCampanaPart(), pos: emptyCampanaPart(),
  };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Periodo anterior de la misma duración, justo antes del rango con el que se trajo la tabla.
function campanasPrevRange() {
  const c = state.campanas;
  const from = Date.parse(`${c.loadedFrom}T00:00:00Z`);
  const to = Date.parse(`${c.loadedTo}T00:00:00Z`);
  const days = Math.round((to - from) / 86400000) + 1;
  const prevTo = from - 86400000;
  return { from: isoDay(prevTo - (days - 1) * 86400000), to: isoDay(prevTo) };
}

function campanaDetailRow() {
  const c = state.campanas;
  return c.detail.key ? c.rows.find((r) => r.key === c.detail.key) : null;
}

function campanaApi(path, extra) {
  const c = state.campanas;
  const row = campanaDetailRow();
  const prev = campanasPrevRange();
  const params = new URLSearchParams({
    customer_id: row.customer_id, campaign_id: row.campaign_id, date_from: c.loadedFrom, date_to: c.loadedTo,
    prev_from: prev.from, prev_to: prev.to, ...extra,
  });
  return fetch(`${path}?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => { if (!ok) throw new Error(data.error || 'Error desconocido.'); return data; });
}

// Trae una parte del detalle (solo la primera vez que se necesita) y vuelve a dibujar al terminar.
function loadCampanaPart(part, path, extra) {
  const c = state.campanas;
  const d = c.detail;
  if (!d.key || d[part].status !== 'idle') return;
  const token = d.token;
  d[part] = { status: 'loading', error: null, data: null };
  campanaApi(path, extra)
    .then((data) => {
      if (token !== c.detail.token) return;
      // El breakdown viene plano; el resto trae todo dentro de `data`.
      c.detail[part] = { status: 'ready', error: null, data: part === 'breakdown' ? data : data.data };
      if (data.currency) c.detail.currency = data.currency;
      if (data.simulated) c.detail.simulated = true;
      render();
    })
    .catch((err) => {
      if (token !== c.detail.token) return;
      c.detail[part] = { status: 'error', error: err.message || String(err), data: null };
      render();
    });
}

function loadCampanaDaily() {
  const c = state.campanas;
  const d = c.detail;
  const row = campanaDetailRow();
  if (!row || d.status !== 'idle') return;
  const token = d.token;
  d.status = 'loading';
  const params = new URLSearchParams({ customer_id: row.customer_id, campaign_id: row.campaign_id, date_from: c.loadedFrom, date_to: c.loadedTo });
  fetch(`/api/google-ads/campaign-daily?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (token !== c.detail.token) return;
      c.detail.days = data.days || [];
      c.detail.currency = data.currency || row.currency;
      if (data.simulated) c.detail.simulated = true;
      c.detail.status = 'ready';
      render();
    })
    .catch((err) => {
      if (token !== c.detail.token) return;
      c.detail.status = 'error'; c.detail.error = err.message || String(err);
      render();
    });
}

// Carga lo que necesita la pestaña; cada pestaña pide sus datos solo cuando se abre.
function ensureCampanaTab(tab) {
  const row = campanaDetailRow();
  if (!row) return;
  if (tab === 'resumen' || tab === 'cambios') loadCampanaPart('ctx', '/api/google-ads/campaign-insight', { view: 'context' });
  else if (tab === 'graficas') { loadCampanaDaily(); loadCampanaPart('ctx', '/api/google-ads/campaign-insight', { view: 'context' }); }
  else if (tab === 'grupos') loadCampanaPart('breakdown', '/api/google-ads/campaign-breakdown', { channel_type: row.channel_type });
  else if (tab === 'segmentos') loadCampanaPart('seg', '/api/google-ads/campaign-insight', { view: 'segments' });
  else if (tab === 'palabras' && row.channel_type === 'SEARCH') loadCampanaPart('kw', '/api/google-ads/campaign-insight', { view: 'keywords' });
  else if (tab === 'posicion') loadCampanaPart('pos', '/api/google-ads/campaign-insight', { view: 'position' });
}

function openCampanaDetail(key) {
  const c = state.campanas;
  const row = c.rows.find((r) => r.key === key);
  if (!row) return;
  c.detail = { ...emptyCampanaDetail(c.detail.token + 1), key, currency: row.currency };
  ensureCampanaTab('resumen');
  render();
}

function setCampanaTab(tab) {
  const c = state.campanas;
  if (!c.detail.key || c.detail.tab === tab) return;
  c.detail.tab = tab;
  ensureCampanaTab(tab);
  render();
}

// Lleva a la sección donde se hace el cambio, con la cuenta y la campaña del detalle ya elegidas. El cambio se
// hace allá con su propia vista previa y confirmación; esta ventana no escribe nada.
function scrollToFocusRow(id) {
  setTimeout(() => { const el = document.getElementById(id); if (el) el.scrollIntoView({ block: 'center' }); }, 60);
}

function campanaGoTo(target) {
  const c = state.campanas;
  const row = campanaDetailRow();
  if (!row) return;
  c.detail = emptyCampanaDetail(c.detail.token + 1);
  if (target === 'budget') {
    state.page = 'pacing';
    openPacingCampaignsModal(row.customer_id, row.account_name, row.campaign_id);
  } else if (target === 'roas') {
    const a = state.roas.api;
    state.page = 'roas';
    a.accountIdManual = row.customer_id; a.accountId = '';
    a.dateFrom = c.loadedFrom; a.dateTo = c.loadedTo; a.onlyActive = false;
    fetchRoasByCampaign(row.campaign_id);
  } else if (target === 'recs') {
    state.page = 'recomendaciones';
    state.recs.api.accountIdManual = row.customer_id; state.recs.api.accountId = '';
    fetchRecommendations(row.campaign_name);
  }
}

function closeCampanaDetail() {
  const c = state.campanas;
  if (!c.detail.key) return;
  c.detail = emptyCampanaDetail(c.detail.token + 1);
  render();
}

// Una entrada por día del rango, también los que Google no devolvió (sin datos), para que el eje sea continuo.
function campanaDaySeries(days, from, to) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out = [];
  let lastBudget = null;
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    const date = isoDay(t);
    const d = byDate.get(date);
    if (d && d.budget != null) lastBudget = d.budget;
    out.push(d || { date, impressions: 0, clicks: 0, cost: 0, conversions: 0, conv_value: 0, budget: lastBudget, impr_share: null, top_impr_share: null, lost_is_budget: null, lost_is_rank: null });
  }
  return out;
}

// ---- piezas comunes de las pestañas ----
function campanaPartHtml(part, label, renderFn) {
  if (part.status === 'idle' || part.status === 'loading') return `<div class="state-panel loading" style="padding:24px"><div class="spinner"></div><p>Trayendo ${label}…</p></div>`;
  if (part.status === 'error') return `<div class="error-panel">${escapeHtml(part.error)}</div>`;
  return renderFn(part.data);
}

function campanaSection(title, inner, hint) {
  return `
    <div class="card table-panel" style="margin:0 0 16px;padding:16px 18px">
      <div class="table-panel-head" style="margin-bottom:8px"><h3>${title}</h3></div>
      ${hint ? `<p class="field-hint" style="margin:0 0 8px">${hint}</p>` : ''}
      ${inner}
    </div>`;
}

function campanaErrorPanel(msg) { return `<div class="error-panel" style="margin:0">${escapeHtml(msg)}</div>`; }

// Variación en texto chico (para celdas de tabla): fracción respecto al periodo anterior.
function campanaDeltaSmall(cur, prev, mode) {
  if (prev == null || !prev) return '<div class="field-hint">—</div>';
  const pct = (cur - prev) / prev;
  const up = pct > 0, down = pct < 0;
  let color = '#6b7280';
  if (mode === 'good_up') color = up ? '#1d6b41' : (down ? '#b3261e' : color);
  else if (mode === 'good_down') color = down ? '#1d6b41' : (up ? '#b3261e' : color);
  return `<div class="field-hint" style="color:${color}">${up ? '▲' : (down ? '▼' : '—')} ${Math.abs(pct * 100).toFixed(0)}%</div>`;
}

function campanaKpiCells(x, cur, prev) {
  const cpa = (m) => (m && m.conversions ? m.cost / m.conversions : null);
  const showDelta = prev !== undefined;
  const p = prev || null;
  return `
    <td>${campanasMoney(x.cost, cur)}${showDelta ? campanaDeltaSmall(x.cost, p && p.cost, 'neutral') : ''}</td>
    <td>${fmtInt(x.impressions)}</td>
    <td>${fmtInt(x.clicks)}</td>
    <td>${x.impressions ? ((x.clicks / x.impressions) * 100).toFixed(2) + '%' : 'N/D'}</td>
    <td>${x.clicks ? campanasMoney(x.cost / x.clicks, cur) : 'N/D'}</td>
    <td>${x.conversions ? x.conversions.toFixed(x.conversions % 1 ? 1 : 0) : '0'}${showDelta ? campanaDeltaSmall(x.conversions, p && p.conversions, 'good_up') : ''}</td>
    <td>${x.conversions ? campanasMoney(x.cost / x.conversions, cur) : 'N/D'}${showDelta ? campanaDeltaSmall(x.conversions ? x.cost / x.conversions : null, cpa(p), 'good_down') : ''}</td>
    <td>${x.cost > 0 && x.conv_value > 0 ? (x.conv_value / x.cost).toFixed(2) + '×' : 'N/D'}</td>`;
}

const CAMPANA_KPI_HEAD = '<th>Gasto</th><th>Impr.</th><th>Clics</th><th>CTR</th><th>CPC</th><th>Conv.</th><th>CPA</th><th>ROAS</th>';

function campanaTable(head, rowsHtml, empty, cols = 11) {
  return `
    <div class="table-scroll" style="max-height:300px">
      <table><thead><tr>${head}</tr></thead><tbody>${rowsHtml || `<tr><td colspan="${cols}" class="footnote">${empty}</td></tr>`}</tbody></table>
    </div>`;
}

// ---- Resumen ----
const CAMPANA_PRIMARY_STATUS_ES = {
  ELIGIBLE: 'Activa y publicándose', LIMITED: 'Activa, pero limitada', PAUSED: 'Pausada', ENDED: 'Terminada', PENDING: 'Pendiente de iniciar',
  REMOVED: 'Eliminada', NOT_ELIGIBLE: 'No puede publicarse', MISCONFIGURED: 'Mal configurada',
};
const CAMPANA_STATUS_REASON_ES = {
  BUDGET_CONSTRAINED: 'El presupuesto limita las impresiones', BUDGET_CONSTRAINED_OR_BIDDING_STRATEGY_LEARNING: 'El presupuesto o el aprendizaje de la puja limitan las impresiones',
  BIDDING_STRATEGY_LEARNING: 'La estrategia de puja está en aprendizaje', BIDDING_STRATEGY_CONSTRAINED: 'La estrategia de puja está limitada',
  BIDDING_STRATEGY_MISCONFIGURED: 'La estrategia de puja está mal configurada', CAMPAIGN_PAUSED: 'La campaña está pausada',
  CAMPAIGN_ENDED: 'La campaña terminó', CAMPAIGN_PENDING: 'La campaña aún no empieza', AD_GROUPS_PAUSED: 'Todos los grupos de anuncios están pausados',
  NO_ACTIVE_AD_GROUPS: 'No hay grupos de anuncios activos', NO_ACTIVE_AD_GROUP_ADS: 'No hay anuncios activos', HAS_ADS_DISAPPROVED: 'Hay anuncios rechazados',
  HAS_ADS_LIMITED_BY_POLICY: 'Hay anuncios limitados por política', MOST_ADS_UNDER_REVIEW: 'La mayoría de los anuncios están en revisión',
  NO_ACTIVE_KEYWORDS: 'No hay palabras clave activas', PENDING_ACCOUNT_BUDGET: 'Falta el presupuesto de la cuenta',
};
const CAMPANA_BID_SYSTEM_STATUS_ES = {
  LEARNING_NEW: 'Aprendiendo (estrategia nueva)', LEARNING_SETTING_CHANGE: 'Aprendiendo (cambio de configuración)',
  LEARNING_BUDGET_CHANGE: 'Aprendiendo (cambio de presupuesto)', LEARNING_COMPOSITION_CHANGE: 'Aprendiendo (cambio de composición)',
  LEARNING_CONVERSION_TYPE_CHANGE: 'Aprendiendo (cambio de tipo de conversión)', LEARNING_CONVERSION_SETTING_CHANGE: 'Aprendiendo (cambio de conversiones)',
  LIMITED_BY_CPC_BID_CEILING: 'Limitada por el tope de CPC', LIMITED_BY_CPC_BID_FLOOR: 'Limitada por el piso de CPC',
  LIMITED_BY_DATA: 'Limitada por falta de datos', LIMITED_BY_BUDGET: 'Limitada por presupuesto', LIMITED_BY_LOW_PRIORITY_SPEND: 'Limitada por gasto de baja prioridad',
  LIMITED_BY_LOW_QUALITY: 'Limitada por baja calidad', LIMITED_BY_INVENTORY: 'Limitada por inventario',
  MISCONFIGURED_SHARED_STRATEGY: 'Estrategia compartida mal configurada', MISCONFIGURED_STRATEGY_TYPE: 'Tipo de estrategia mal configurado',
  PAUSED: 'Pausada', UNAVAILABLE: 'No disponible', MULTIPLE_LEARNING: 'Varios aprendizajes', MULTIPLE_LIMITED: 'Varias limitaciones', MULTIPLE_MISCONFIGURED: 'Varias configuraciones erróneas', MULTIPLE: 'Varios estados',
};
const campanaEnumText = (v) => (v ? v.toLowerCase().replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase()) : '');

// Punto porcentual: para las cuotas de impresiones, que ya son porcentajes.
function campanaPpBadge(cur, prev, mode) {
  if (cur == null || prev == null) return '<span class="delta-badge neutral">—</span>';
  const pp = (cur - prev) * 100;
  const flat = Math.abs(pp) < 0.05;
  let cls = 'neutral';
  if (!flat && mode === 'good_up') cls = pp > 0 ? 'good' : 'bad';
  else if (!flat && mode === 'good_down') cls = pp < 0 ? 'good' : 'bad';
  return `<span class="delta-badge ${cls}">${flat ? '—' : (pp > 0 ? '▲' : '▼')} ${Math.abs(pp).toFixed(1)} pp</span>`;
}

function renderCampanaSummaryTab(row, cur) {
  const part = state.campanas.detail.ctx;
  return campanaPartHtml(part, 'el resumen y la comparación', (data) => {
    const c = data.current, p = data.previous;
    const prev = campanasPrevRange();
    const ratio = (n, dnm) => (dnm ? n / dnm : null);
    const m = (x) => (x ? {
      cost: x.cost, impressions: x.impressions, clicks: x.clicks, conversions: x.conversions,
      ctr: ratio(x.clicks, x.impressions), cpc: ratio(x.cost, x.clicks), cpa: ratio(x.cost, x.conversions), roas: x.cost > 0 && x.conv_value > 0 ? x.conv_value / x.cost : null,
    } : {});
    const mc = m(c), mp = m(p);
    const delta = (k, mode) => deltaBadge(mp[k] != null && mc[k] != null && mp[k] !== 0 ? (mc[k] - mp[k]) / mp[k] : null, mode);
    const card = (label, value, deltaHtml, prevText) => `
      <div class="card stat-card" style="min-width:150px;padding:14px 16px">
        <div class="stat-label">${label}</div>
        <div class="stat-value" style="font-size:18px">${value}</div>
        <div class="stat-sub">${deltaHtml}${prevText ? ` <span>antes ${prevText}</span>` : ''}</div>
      </div>`;
    const money = (v) => (v == null ? 'N/D' : campanasMoney(v, cur));
    const pctTxt = (v) => (v == null ? 'N/D' : (v * 100).toFixed(2) + '%');
    const x2 = (v) => (v == null ? 'N/D' : v.toFixed(2) + '×');
    const num = (v) => (v == null ? 'N/D' : (v % 1 ? v.toFixed(1) : fmtInt(v)));
    const cards = [
      card('Gasto', money(mc.cost), delta('cost', 'neutral'), p ? money(mp.cost) : ''),
      card('Impresiones', fmtInt(mc.impressions), delta('impressions', 'good_up'), p ? fmtInt(mp.impressions) : ''),
      card('Clics', fmtInt(mc.clicks), delta('clicks', 'good_up'), p ? fmtInt(mp.clicks) : ''),
      card('CTR', pctTxt(mc.ctr), delta('ctr', 'good_up'), p ? pctTxt(mp.ctr) : ''),
      card('CPC', money(mc.cpc), delta('cpc', 'good_down'), p ? money(mp.cpc) : ''),
      card('Conversiones', num(mc.conversions), delta('conversions', 'good_up'), p ? num(mp.conversions) : ''),
      card('CPA', money(mc.cpa), delta('cpa', 'good_down'), p ? money(mp.cpa) : ''),
      card('ROAS', x2(mc.roas), delta('roas', 'good_up'), p ? x2(mp.roas) : ''),
      card('Cuota de impresiones', campanasShare(c.impr_share), p ? campanaPpBadge(c.impr_share, p.impr_share, 'good_up') : '', p ? campanasShare(p.impr_share) : ''),
      card('Perdida (presupuesto)', campanasShare(c.lost_is_budget), p ? campanaPpBadge(c.lost_is_budget, p.lost_is_budget, 'good_down') : '', p ? campanasShare(p.lost_is_budget) : ''),
      card('Perdida (ranking)', campanasShare(c.lost_is_rank), p ? campanaPpBadge(c.lost_is_rank, p.lost_is_rank, 'good_down') : '', p ? campanasShare(p.lost_is_rank) : ''),
    ].join('');

    // Estado en Google y por qué está limitada.
    let statusHtml = '';
    if (data.status) {
      const st = data.status;
      const reasons = (st.reasons || []).map((r) => CAMPANA_STATUS_REASON_ES[r] || campanaEnumText(r));
      const learn = st.bidding_system_status && !['ENABLED', 'UNKNOWN', 'UNSPECIFIED'].includes(st.bidding_system_status)
        ? (CAMPANA_BID_SYSTEM_STATUS_ES[st.bidding_system_status] || campanaEnumText(st.bidding_system_status)) : '';
      const good = st.primary_status === 'ELIGIBLE' && !reasons.length && !learn;
      const budgetLine = st.budget != null
        ? `Presupuesto diario: <strong>${campanasMoney(st.budget, cur)}</strong>${st.shared_budget ? ' (compartido con otras campañas)' : ''}${st.recommended_budget != null ? ` · Google recomienda <strong>${campanasMoney(st.recommended_budget, cur)}</strong>${st.budget ? ` (${(st.recommended_budget / st.budget).toFixed(1)}× el actual)` : ''}` : ''}`
        : '';
      statusHtml = `
        <div class="${good ? 'ok-panel' : ''}" style="${good ? '' : 'background:var(--rb-warning-100,#fdf1d8);border:1px solid var(--rb-warning-500,#e6a219);border-radius:10px;padding:12px 16px;'}margin:0 0 16px">
          <strong>Estado en Google: ${escapeHtml(CAMPANA_PRIMARY_STATUS_ES[st.primary_status] || campanaEnumText(st.primary_status) || 'N/D')}</strong>
          ${reasons.length ? `<ul style="margin:6px 0 0 18px;padding:0">${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
          ${learn ? `<div style="margin-top:6px">Estrategia de puja: ${escapeHtml(learn)}</div>` : ''}
          ${budgetLine ? `<div style="margin-top:6px">${budgetLine}</div>` : ''}
        </div>`;
    } else if (data.errors && data.errors.status) statusHtml = campanaErrorPanel(data.errors.status);

    // Los cambios se hacen en su propia sección, con vista previa y confirmación; aquí solo se abre con esta campaña elegida.
    const budgetLimited = (c.lost_is_budget || 0) >= 0.1 || (data.status && (data.status.reasons || []).some((r) => /BUDGET/.test(r)));
    const roasOk = ['TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE'].includes(row.bidding_strategy_type);
    const goBtn = (go, label, why, accent) => `
      <div style="flex:1;min-width:220px">
        <button class="${accent ? 'btn-accent' : 'btn-outline'} sm" data-camp-go="${go}">${label}</button>
        <div class="field-hint" style="margin-top:4px">${why}</div>
      </div>`;
    const goButtons = [
      row.status === 'ENABLED'
        ? goBtn('budget', 'Ajustar presupuesto', `Abre Ritmo de consumo con esta campaña resaltada.${budgetLimited ? ' <strong>Hoy el presupuesto la limita.</strong>' : ''}`, budgetLimited)
        : '',
      roasOk ? goBtn('roas', 'Ajustar ROAS objetivo', 'Abre la sección ROAS con el editor de esta campaña listo.', false) : '',
      goBtn('recs', 'Ver recomendaciones de Google', 'Abre Recomendaciones filtrado por esta campaña.', false),
    ].filter(Boolean).join('');
    const actionsHtml = `
      <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--color-border)">
        <strong style="font-size:13px">Cambiar algo en esta campaña</strong>
        <p class="field-hint" style="margin:2px 0 10px">Los cambios se hacen en su propia sección, con vista previa y confirmación antes de escribir en Google Ads.${row.status === 'ENABLED' ? '' : ' La campaña está pausada: para ajustar su presupuesto primero actívala desde la tabla.'}</p>
        <div style="display:flex;gap:16px;flex-wrap:wrap">${goButtons}</div>
      </div>`;

    const nChanges = (data.changes || []).length;
    const changesNote = campanaExportMode ? '' : data.changes
      ? `<p class="field-hint" style="margin:12px 0 0">${nChanges ? `Hay <strong>${nChanges}</strong> cambio${nChanges === 1 ? '' : 's'} en esta campaña en los últimos 30 días (pestaña <em>Cambios</em>).` : 'No hay cambios registrados en esta campaña en los últimos 30 días.'}</p>`
      : (data.errors && data.errors.changes ? campanaErrorPanel(data.errors.changes) : '');
    return `
      ${statusHtml}
      <div class="stat-grid" style="margin-bottom:0">${cards}</div>
      <p class="field-hint" style="margin:10px 0 0">${p ? `Comparado con el periodo anterior de la misma duración (del ${escapeHtml(prev.from)} al ${escapeHtml(prev.to)}). Verde = mejora, rojo = empeora.` : ''}</p>
      ${changesNote}
      ${campanaExportMode ? '' : actionsHtml}`;
  });
}

// ---- Gráficas ----
function renderCampanaChartsTab(row, cur) {
  const c = state.campanas;
  const d = c.detail;
  if (d.status === 'idle' || d.status === 'loading') return `<div class="state-panel loading"><div class="spinner"></div><p>Trayendo la evolución día a día…</p></div>`;
  if (d.status === 'error') return `<div class="error-panel">${escapeHtml(d.error)}</div>`;
  const series = campanaDaySeries(d.days, c.loadedFrom, c.loadedTo);
  const hasShare = series.some((x) => x.impr_share != null);
  const hasData = series.some((x) => x.impressions > 0);
  const budget = series.find((x) => x.budget != null);
  const nearLimit = budget ? series.filter((x) => x.budget > 0 && x.cost >= x.budget * 0.95).length : 0;
  const changeDays = campanaChangeDates(series);
  const chartCard = (id, title, hint, extra, ok, emptyMsg) => `
    <div class="card" style="padding:16px 18px">
      <h4 style="margin:0 0 4px;font-size:12.5px;color:var(--color-text-heading);text-transform:uppercase;letter-spacing:.04em">${title}</h4>
      <p class="field-hint" style="margin:0 0 10px">${hint}${extra ? ` <strong>${extra}</strong>` : ''}</p>
      ${ok ? `<div style="height:230px"><canvas id="${id}"></canvas></div>` : `<p class="field-hint" style="padding:40px 0;text-align:center">${emptyMsg}</p>`}
    </div>`;
  const noShare = 'Google no da la cuota de impresiones para este tipo de campaña o para este rango.';
  const noData = 'La campaña no tuvo actividad en este rango.';
  const markerNote = changeDays.size
    ? `<p class="field-hint" style="margin:0 0 12px"><span style="color:var(--rb-danger-500,#d5455f)">┆</span> Las líneas rojas punteadas marcan días con cambios en la campaña (${changeDays.size}); el detalle está en la pestaña <em>Cambios</em>.</p>` : '';
  return `
    ${markerNote}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));gap:16px">
      ${chartCard('camp-chart-is', 'Cuota de impresiones', 'Qué parte de las búsquedas posibles mostró tus anuncios y qué parte salió arriba del todo. Una caída sostenida es visibilidad perdida.', '', hasShare, noShare)}
      ${chartCard('camp-chart-lost', 'Dónde se pierde la cuota', 'De lo que no mostraste, cuánto fue por presupuesto y cuánto por ranking. Mucho por presupuesto: el límite diario te frena. Mucho por ranking: puja o calidad del anuncio.', '', hasShare, noShare)}
      ${chartCard('camp-chart-spend', 'Gasto diario y presupuesto', 'Gasto de cada día frente al presupuesto diario actual. Los días pegados a la línea son días en que el presupuesto se agota.', budget ? `${nearLimit} de ${series.length} días con gasto ≥ 95% del presupuesto.` : '', hasData, noData)}
      ${chartCard('camp-chart-clicks', 'Clics y CTR', 'Si los clics suben con el CTR plano, es más volumen; si el CTR cae, el anuncio pierde relevancia.', '', hasData, noData)}
      ${chartCard('camp-chart-conv', 'Conversiones y CPA', 'Conversiones por día y lo que costó cada una (el CPA queda vacío los días sin conversiones).', '', hasData, noData)}
      ${chartCard('camp-chart-cpc', 'CPC medio y ROAS', 'Un CPC que sube sin que suba el ROAS (valor de conversión ÷ gasto) es puja más cara sin retorno.', '', hasData, noData)}
    </div>
    <p class="field-hint" style="margin-top:12px">El presupuesto de la gráfica de gasto es el actual de la campaña, no el de cada día. Los días sin datos de Google se muestran vacíos.</p>`;
}

// Días del rango que tuvieron algún cambio en la campaña (Google solo guarda 30 días de cambios).
function campanaChangeDates(series) {
  const ctx = state.campanas.detail.ctx;
  if (campanaExportMode || ctx.status !== 'ready' || !ctx.data.changes) return new Set();
  const inRange = new Set(series.map((x) => x.date));
  return new Set(ctx.data.changes.map((ch) => ch.date).filter((dt) => inRange.has(dt)));
}

// ---- Grupos y regiones ----
const CAMPANA_GEO_TYPE_ES = { Country: 'País', Region: 'Región', State: 'Estado', Province: 'Provincia', City: 'Ciudad', 'Postal Code': 'Código postal', Neighborhood: 'Barrio', County: 'Condado', Department: 'Departamento', Metro: 'Área metropolitana', 'DMA Region': 'Área de mercado', District: 'Distrito', Municipality: 'Municipio', Airport: 'Aeropuerto', 'Autonomous Community': 'Comunidad autónoma' };
const CAMPANA_GEO_SETTING_ES = {
  PRESENCE_OR_INTEREST: 'Personas en esas ubicaciones o que muestran interés en ellas',
  PRESENCE: 'Solo personas que están en esas ubicaciones',
};

function renderCampanaBreakdown(row, cur) {
  return campanaPartHtml(state.campanas.detail.breakdown, 'los grupos activos y las regiones', (data) => {
    const err = (name) => (data.errors && data.errors[name] ? campanaErrorPanel(data.errors[name]) : '');
    const prevNote = data.prev_groups !== undefined ? '<p class="field-hint" style="margin:0 0 12px">Las flechas comparan con el periodo anterior de la misma duración.</p>' : '';

    let groupsHtml;
    if (data.groups) {
      const isAsset = data.groups.kind === 'asset_group';
      const list = data.groups.groups || [];
      const rows = list.slice(0, 200).map((g) => `<tr><td style="min-width:200px"><strong>${escapeHtml(g.name)}</strong></td>${campanaKpiCells(g, cur, data.prev_groups === undefined ? undefined : (data.prev_groups[g.id] || null))}</tr>`).join('');
      groupsHtml = campanaSection(
        `${isAsset ? 'Grupos de recursos activos' : 'Grupos de anuncios activos'} (${fmtInt(list.length)})`,
        campanaTable(`<th>${isAsset ? 'Grupo de recursos' : 'Grupo de anuncios'}</th>${CAMPANA_KPI_HEAD}`, rows, `La campaña no tiene ${isAsset ? 'grupos de recursos' : 'grupos de anuncios'} activos.`),
        isAsset ? 'Performance Max no tiene grupos de anuncios: sus equivalentes son los grupos de recursos.' : '',
      );
    } else groupsHtml = campanaSection('Grupos activos', err('groups'));

    let geoHtml;
    if (data.targeting) {
      const t = data.targeting;
      const included = t.locations.filter((l) => !l.excluded);
      const excluded = t.locations.filter((l) => l.excluded);
      const locRows = t.locations.slice(0, 300).map((l) => `
        <tr>
          <td style="min-width:200px"><strong>${escapeHtml(l.name)}</strong>${l.canonical && l.canonical !== l.name ? `<div class="field-hint">${escapeHtml(l.canonical.split(',').join(', '))}</div>` : ''}</td>
          <td>${escapeHtml(CAMPANA_GEO_TYPE_ES[l.target_type] || l.target_type || '')}</td>
          <td>${l.excluded ? '<span style="color:var(--rb-danger-500,#d5455f);font-weight:600">Excluida</span>' : 'Incluida'}</td>
          ${l.excluded ? '<td colspan="8" class="field-hint">—</td>' : campanaKpiCells(l, cur, data.prev_locations === undefined ? undefined : (data.prev_locations[l.resource] || null))}
        </tr>`).join('');
      const chips = (items) => items.map((x) => `<span class="field-hint" style="display:inline-block;border:1px solid var(--color-border);border-radius:999px;padding:2px 10px;margin:0 6px 6px 0;font-size:12px">${escapeHtml(x)}</span>`).join('');
      const meta = [];
      if (t.languages.length) meta.push(`<p class="field-hint" style="margin:0 0 8px"><strong>Idiomas:</strong> ${t.languages.map(escapeHtml).join(', ')}</p>`);
      if (t.geo_target_type && CAMPANA_GEO_SETTING_ES[t.geo_target_type]) meta.push(`<p class="field-hint" style="margin:0 0 8px"><strong>Se muestra a:</strong> ${escapeHtml(CAMPANA_GEO_SETTING_ES[t.geo_target_type])}</p>`);
      if (t.radii.length) meta.push(`<p class="field-hint" style="margin:0 0 8px"><strong>Radios:</strong></p>${chips(t.radii.map((r) => `${r.name}${r.excluded ? ' (excluido)' : ''}`))}`);
      const noKpiNote = included.length && included.every((l) => !l.impressions && !l.clicks && !l.cost)
        ? '<p class="field-hint" style="margin:8px 0 0">Google no devolvió datos por ubicación para este rango (o la campaña no tuvo actividad): los KPIs salen en cero.</p>' : '';
      geoHtml = campanaSection(
        `Mercados y regiones a los que se dirige (${fmtInt(included.length)} incluidas${excluded.length ? `, ${fmtInt(excluded.length)} excluidas` : ''})`,
        `${meta.join('')}${campanaTable(`<th>Ubicación</th><th>Tipo</th><th>Estado</th>${CAMPANA_KPI_HEAD}`, locRows, 'La campaña no tiene ubicaciones configuradas (se muestra en todas partes).')}${noKpiNote}`,
      );
    } else geoHtml = campanaSection('Mercados y regiones', err('targeting'));
    return `${prevNote}${groupsHtml}${geoHtml}`;
  });
}

// ---- Segmentos ----
const CAMPANA_DEVICE_ES = { MOBILE: 'Móvil', DESKTOP: 'Escritorio', TABLET: 'Tablet', CONNECTED_TV: 'TV conectada', OTHER: 'Otros', UNKNOWN: 'Desconocido' };
const CAMPANA_WEEKDAYS = [['MONDAY', 'Lunes'], ['TUESDAY', 'Martes'], ['WEDNESDAY', 'Miércoles'], ['THURSDAY', 'Jueves'], ['FRIDAY', 'Viernes'], ['SATURDAY', 'Sábado'], ['SUNDAY', 'Domingo']];
const CAMPANA_CONV_CATEGORY_ES = {
  PURCHASE: 'Compra / reserva', DEFAULT: 'Otra', PAGE_VIEW: 'Vista de página', ADD_TO_CART: 'Añadir al carrito', BEGIN_CHECKOUT: 'Inicio de compra',
  SUBSCRIBE_PAID: 'Suscripción de pago', PHONE_CALL_LEAD: 'Llamada', IMPORTED_LEAD: 'Contacto importado', SUBMIT_LEAD_FORM: 'Formulario enviado',
  BOOK_APPOINTMENT: 'Cita', REQUEST_QUOTE: 'Solicitud de cotización', GET_DIRECTIONS: 'Cómo llegar', OUTBOUND_CLICK: 'Clic saliente',
  CONTACT: 'Contacto', ENGAGEMENT: 'Interacción', STORE_VISIT: 'Visita a tienda', STORE_SALE: 'Venta en tienda', QUALIFIED_LEAD: 'Contacto calificado', CONVERTED_LEAD: 'Contacto convertido',
};

function renderCampanaSegmentsTab(row, cur) {
  return campanaPartHtml(state.campanas.detail.seg, 'los segmentos', (data) => {
    const err = (name) => (data.errors && data.errors[name] ? campanaErrorPanel(data.errors[name]) : null);
    const totalCost = (list) => (list || []).reduce((a, x) => a + x.cost, 0);
    const shareCell = (v, total) => `<td>${total > 0 ? ((v / total) * 100).toFixed(0) + '%' : 'N/D'}</td>`;
    const kpiTable = (labelHead, list, labelFn, hint) => {
      const total = totalCost(list);
      const rows = list.map((x) => `<tr><td style="min-width:130px"><strong>${escapeHtml(labelFn(x))}</strong></td>${shareCell(x.cost, total)}${campanaKpiCells(x, cur)}</tr>`).join('');
      return campanaTable(`<th>${labelHead}</th><th>% del gasto</th>${CAMPANA_KPI_HEAD}`, rows, 'Sin datos en este rango.', 10) + (hint ? `<p class="field-hint" style="margin:8px 0 0">${hint}</p>` : '');
    };
    const sections = [];
    sections.push(campanaSection('Por dispositivo', err('device') || kpiTable('Dispositivo', [...(data.device || [])].sort((a, b) => b.cost - a.cost), (x) => CAMPANA_DEVICE_ES[x.key] || campanaEnumText(x.key)),
      'Compara el CPA y el ROAS entre móvil y escritorio: si uno rinde mucho peor, es candidato a un ajuste de puja por dispositivo.'));
    const byDay = new Map((data.weekday || []).map((x) => [x.key, x]));
    const weekdayList = CAMPANA_WEEKDAYS.filter(([k]) => byDay.has(k)).map(([k, label]) => ({ ...byDay.get(k), label }));
    sections.push(campanaSection('Por día de la semana', err('weekday') || kpiTable('Día', weekdayList, (x) => x.label),
      'Busca los días en que el gasto y las conversiones no van parejos: ahí puede haber espacio para una programación de anuncios o ajustes de puja por día.'));
    if (data.conversions || (data.errors && data.errors.conversions)) {
      const convs = data.conversions || [];
      const totalConv = convs.reduce((a, x) => a + x.conversions, 0);
      const rows = convs.map((x) => `
        <tr>
          <td style="min-width:200px"><strong>${escapeHtml(x.name)}</strong></td>
          <td>${escapeHtml(CAMPANA_CONV_CATEGORY_ES[x.category] || campanaEnumText(x.category))}</td>
          <td>${x.conversions ? x.conversions.toFixed(x.conversions % 1 ? 1 : 0) : '0'}</td>
          <td>${totalConv > 0 ? ((x.conversions / totalConv) * 100).toFixed(0) + '%' : 'N/D'}</td>
          <td>${campanasMoney(x.conv_value, cur)}</td>
          <td>${x.conversions ? campanasMoney(x.conv_value / x.conversions, cur) : 'N/D'}</td>
        </tr>`).join('');
      sections.push(campanaSection('Conversiones por acción',
        err('conversions') || campanaTable('<th>Acción de conversión</th><th>Categoría</th><th>Conv.</th><th>% de las conv.</th><th>Valor</th><th>Valor por conv.</th>', rows, 'La campaña no registró conversiones en este rango.', 6),
        'Separa las reservas de otras acciones (llamadas, formularios, clics a contacto). Si el CPA mezcla acciones de poco valor con reservas, engaña.'));
    }
    const countries = data.countries || [];
    sections.push(campanaSection('Países desde los que se ve la campaña',
      err('countries') || (() => {
        const total = totalCost(countries);
        const rows = countries.slice(0, 30).map((x) => `<tr><td style="min-width:160px"><strong>${escapeHtml(x.name)}</strong></td>${shareCell(x.cost, total)}${campanaKpiCells(x, cur)}</tr>`).join('');
        return campanaTable(`<th>País</th><th>% del gasto</th>${CAMPANA_KPI_HEAD}`, rows, 'Sin datos en este rango.', 10);
      })(),
      'Dónde estaban físicamente las personas que vieron los anuncios. Un país que no es tu mercado con gasto relevante indica que la segmentación deja pasar tráfico de otro lugar.'));
    return sections.join('');
  });
}

// ---- Palabras clave ----
const CAMPANA_MATCH_ES = { BROAD: 'Amplia', PHRASE: 'Frase', EXACT: 'Exacta' };
const CAMPANA_QUALITY_ES = { BELOW_AVERAGE: 'Inferior a la media', AVERAGE: 'Media', ABOVE_AVERAGE: 'Superior a la media' };

function renderCampanaKeywordsTab(row, cur) {
  if (row.channel_type !== 'SEARCH') {
    return `<div class="card state-panel idle"><p>Las palabras clave solo existen en campañas de Search. Esta es una campaña de ${escapeHtml(campanasTypeLabel(row.channel_type))}.</p></div>`;
  }
  return campanaPartHtml(state.campanas.detail.kw, 'las palabras clave', (list) => {
    const kws = (list || []).filter((k) => k.impressions > 0 || k.cost > 0);
    const total = kws.reduce((a, k) => a + k.cost, 0);
    const wasted = kws.filter((k) => k.cost > 0 && k.conversions === 0);
    const wastedCost = wasted.reduce((a, k) => a + k.cost, 0);
    const qsCell = (q) => {
      if (q == null) return '<td>—</td>';
      const color = q >= 7 ? '#1d6b41' : (q >= 5 ? '#a86a00' : '#b3261e');
      return `<td style="font-weight:700;color:${color}">${q}/10</td>`;
    };
    const qual = (v) => `<td>${escapeHtml(CAMPANA_QUALITY_ES[v] || '—')}</td>`;
    const rows = kws.map((k) => `
      <tr>
        <td style="min-width:200px"><strong>${escapeHtml(k.text)}</strong><div class="field-hint">${escapeHtml(k.ad_group)}</div></td>
        <td>${escapeHtml(CAMPANA_MATCH_ES[k.match_type] || campanaEnumText(k.match_type))}</td>
        ${qsCell(k.quality_score)}${qual(k.expected_ctr)}${qual(k.ad_relevance)}${qual(k.landing_page)}
        ${campanaKpiCells(k, cur)}
      </tr>`).join('');
    const summary = kws.length
      ? `<p class="field-hint" style="margin:0 0 10px">Las ${fmtInt(kws.length)} palabras clave de mayor gasto (hasta 60). ${wasted.length ? `<strong>${fmtInt(wasted.length)} gastan sin convertir (${campanasMoney(wastedCost, cur)}, ${total > 0 ? ((wastedCost / total) * 100).toFixed(0) : 0}% de lo listado)</strong>: revísalas antes de subir presupuesto.` : 'Todas las listadas con gasto convirtieron.'}</p>` : '';
    return campanaSection(`Palabras clave (${fmtInt(kws.length)})`,
      `${summary}${campanaTable(`<th>Palabra clave</th><th>Concordancia</th><th>Nivel de calidad</th><th>CTR esperado</th><th>Relevancia del anuncio</th><th>Página de destino</th>${CAMPANA_KPI_HEAD}`, rows, 'No hay palabras clave con actividad en este rango.', 14)}`,
      'El Nivel de calidad (1-10) y sus tres componentes los calcula Google: 7 o más es sano; por debajo de 5 sube el costo por clic. El componente "Inferior a la media" te dice qué arreglar: anuncio, página o CTR.');
  });
}

// ---- Posición en la subasta ----
const CAMPANA_POSITION_ROWS = [
  ['impr_share', 'Cuota de impresiones', 'good_up', 'Impresiones que obtuviste sobre las que podías obtener.'],
  ['top_impr_share', 'Cuota de impresiones superior', 'good_up', 'Impresiones que salieron arriba de los resultados de búsqueda.'],
  ['abs_top_impr_share', 'Cuota de impresiones superior absoluta', 'good_up', 'Impresiones que salieron en la primera posición de todas.'],
  ['lost_is_budget', 'Perdida por presupuesto', 'good_down', 'Impresiones que no obtuviste porque el presupuesto se agotó.'],
  ['lost_is_rank', 'Perdida por ranking', 'good_down', 'Impresiones que no obtuviste por una puja o un Ranking de anuncio bajos.'],
  ['lost_top_budget', 'Posición superior perdida por presupuesto', 'good_down', 'Veces que no saliste arriba por falta de presupuesto.'],
  ['lost_top_rank', 'Posición superior perdida por ranking', 'good_down', 'Veces que no saliste arriba por ranking bajo.'],
  ['lost_abs_top_budget', 'Primera posición perdida por presupuesto', 'good_down', 'Veces que no saliste primero por falta de presupuesto.'],
  ['lost_abs_top_rank', 'Primera posición perdida por ranking', 'good_down', 'Veces que no saliste primero por ranking bajo.'],
  ['click_share', 'Cuota de clics', 'good_up', 'Clics que obtuviste sobre los que podías obtener.'],
  ['exact_impr_share', 'Cuota de impresiones en coincidencia exacta', 'good_up', 'Cuota solo contando las búsquedas que coinciden exactamente con tus palabras clave.'],
];

function renderCampanaPositionTab(row, cur) {
  return campanaPartHtml(state.campanas.detail.pos, 'la posición en la subasta', (data) => {
    const c = data.current, p = data.previous;
    const allNull = Object.values(c).every((v) => v == null);
    const rows = CAMPANA_POSITION_ROWS.map(([k, label, mode, desc]) => `
      <tr>
        <td style="min-width:240px"><strong>${label}</strong><div class="field-hint">${desc}</div></td>
        <td>${campanasShare(c[k])}</td>
        <td>${p ? campanasShare(p[k]) : 'N/D'}</td>
        <td>${p ? campanaPpBadge(c[k], p[k], mode) : '—'}</td>
      </tr>`).join('');
    const table = allNull
      ? '<p class="field-hint" style="padding:20px 0;text-align:center">Google no da estas cuotas para este tipo de campaña o para este rango.</p>'
      : campanaTable('<th>Métrica</th><th>Este periodo</th><th>Periodo anterior</th><th>Variación</th>', rows, '', 4);
    const competitors = `
      <div style="background:var(--rb-info-100,#e3ebfd);border-radius:10px;padding:12px 16px;margin-top:4px">
        <strong>Competidores (Información de subastas)</strong>
        <div style="margin-top:4px">Google no entrega por API los datos de competidores (qué dominios compiten contigo, su cuota y cuántas veces te superan) a esta plataforma: es un acceso restringido a desarrolladores autorizados por Google. Se ven en Google Ads: <em>Informes → Información de subastas</em>.</div>
      </div>`;
    return campanaSection('Posición en la subasta', `${table}${competitors}`,
      'Estas cuotas explican por qué no apareces más arriba o más veces. Lo perdido por presupuesto se arregla con dinero; lo perdido por ranking, con puja, calidad del anuncio o de la página.');
  });
}

// ---- Cambios ----
const CAMPANA_CLIENT_ES = {
  GOOGLE_ADS_WEB_CLIENT: 'Google Ads (web)', GOOGLE_ADS_API: 'API / herramientas', GOOGLE_ADS_SCRIPTS: 'Script', GOOGLE_ADS_EDITOR: 'Google Ads Editor',
  GOOGLE_ADS_MOBILE_CLIENT: 'App móvil', INTERNAL_TOOL: 'Google (automático)', OTHER: 'Otro', UNKNOWN: 'Desconocido', GOOGLE_ADS_RECOMMENDATIONS: 'Recomendación aplicada',
  GOOGLE_ADS_AUTOMATED_RULE: 'Regla automatizada', GOOGLE_ADS_CAMPAIGN_ASSISTANT: 'Asistente de campañas',
};

function renderCampanaChangesTab(row, cur) {
  return campanaPartHtml(state.campanas.detail.ctx, 'los cambios', (data) => {
    if (!data.changes) return campanaErrorPanel((data.errors && data.errors.changes) || 'No se pudieron leer los cambios.');
    const rows = data.changes.map((ch) => {
      const detail = changeDetailHtml(ch, state.campanas.detail.currency);
      return `
        <tr>
          <td style="white-space:nowrap">${escapeHtml(ch.when.slice(0, 16))}</td>
          <td>${escapeHtml(ch.user || '—')}<div class="field-hint">${escapeHtml(changeClientText(ch.client))}</div></td>
          <td>${escapeHtml(ch.operation_label)} · ${escapeHtml(ch.resource_label)}</td>
          <td style="min-width:240px">${detail}</td>
        </tr>`;
    }).join('');
    return campanaSection(`Cambios de los últimos 30 días (${fmtInt(data.changes.length)})`,
      campanaTable('<th>Fecha</th><th>Quién</th><th>Qué</th><th>Detalle</th>', rows, 'No hay cambios registrados en los últimos 30 días.', 4),
      'Google solo guarda 30 días de cambios, así que esta lista no depende del rango de fechas. Los cambios hechos desde esta plataforma (presupuesto, ROAS, estado) salen como "API / herramientas". Si una gráfica cambia de tendencia un día con cambio, ese cambio es el primer sospechoso.');
  });
}

// ---- Ventana ----
const CAMPANA_TAB_RENDERERS = {
  resumen: renderCampanaSummaryTab, graficas: renderCampanaChartsTab, grupos: renderCampanaBreakdown, segmentos: renderCampanaSegmentsTab,
  palabras: renderCampanaKeywordsTab, posicion: renderCampanaPositionTab, cambios: renderCampanaChangesTab,
};

function renderCampanaDetailModal() {
  const c = state.campanas;
  const d = c.detail;
  if (!d.key) return '';
  const row = c.rows.find((r) => r.key === d.key);
  if (!row) return '';
  const cur = d.currency || row.currency;
  const strat = campanasStrategy(row);
  const head = `
    <button class="modal-close" data-action="camp-detail-close" aria-label="Cerrar">${icon('x', 18)}</button>
    <h3 class="dense-chart-title" style="margin:0 0 4px;padding-right:28px">${escapeHtml(row.campaign_name)}</h3>
    <p class="field-hint" style="margin:0 0 14px">${escapeHtml(campanasHotelOf(row))} · ${escapeHtml(campanasTypeLabel(row.channel_type))} · ${escapeHtml(strat.label)}${strat.target ? ` (${escapeHtml(strat.target)})` : ''} · ${row.status === 'ENABLED' ? 'Activa' : 'Pausada'} · del ${escapeHtml(c.loadedFrom)} al ${escapeHtml(c.loadedTo)}</p>
    <div style="margin:0 0 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn-outline xs" data-action="camp-detail-html" ${d.exporting ? 'disabled' : ''}>${d.exporting ? 'Preparando el HTML…' : 'Descargar HTML de esta campaña'}</button>
      <span class="field-hint" style="margin:0">Incluye todas las pestañas menos Cambios.</span>
      ${d.exportError ? `<span class="field-hint" style="margin:0;color:#b3261e">${escapeHtml(d.exportError)}</span>` : ''}
    </div>
    <div class="seg-control" style="flex-wrap:wrap;margin-bottom:16px">
      ${CAMPANA_TABS.map(([k, label]) => `<button class="seg-btn ${d.tab === k ? 'active' : ''}" data-camp-tab="${k}">${label}</button>`).join('')}
    </div>
    ${d.simulated ? '<div class="ok-panel" style="margin:0 0 12px"><strong>Modo simulado.</strong> Datos de ejemplo.</div>' : ''}`;
  return `
    <div class="modal-overlay camp-detail-overlay">
      <div class="modal-box card" data-modal-stop-propagation style="max-width:1100px">
        ${head}
        ${CAMPANA_TAB_RENDERERS[d.tab](row, cur)}
      </div>
    </div>`;
}

function mountCampanaCharts() {
  const c = state.campanas;
  if (!c.detail.key || c.detail.tab !== 'graficas' || c.detail.status !== 'ready' || !window.Chart) return;
  const cur = c.detail.currency;
  const series = campanaDaySeries(c.detail.days, c.loadedFrom, c.loadedTo);
  const labels = series.map((x) => x.date.slice(5));
  const changeLabels = new Set([...campanaChangeDates(series)].map((dt) => dt.slice(5)));
  const col = {
    teal: cssVar('--rb-teal-500') || '#03a694', navy: cssVar('--rb-navy-500') || '#2f4468',
    orange: cssVar('--rb-orange-500') || '#ff9800', red: cssVar('--rb-danger-500') || '#d5455f',
    grid: cssVar('--color-border') || '#e5e7eb', muted: cssVar('--color-text-muted') || '#666',
  };
  // Línea roja punteada vertical en los días con cambios en la campaña.
  const changeMarkers = {
    id: 'changeMarkers',
    afterDatasetsDraw(chart) {
      if (!changeLabels.size) return;
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.strokeStyle = col.red; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      chart.data.labels.forEach((lab, i) => {
        if (!changeLabels.has(lab)) return;
        const px = scales.x.getPixelForValue(i);
        ctx.beginPath(); ctx.moveTo(px, chartArea.top); ctx.lineTo(px, chartArea.bottom); ctx.stroke();
      });
      ctx.restore();
    },
  };
  const pct = (v) => Math.round(v * 100) + '%';
  const pct1 = (v) => (v * 100).toFixed(1) + '%';
  const tick = (fmt) => ({ callback: fmt, color: col.muted, font: { size: 11 } });
  const base = () => ({
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
      tooltip: { backgroundColor: cssVar('--navy-900') || '#0f172a', padding: 8, cornerRadius: 6 },
    },
    scales: { x: { grid: { display: false }, ticks: { color: col.muted, font: { size: 10 }, maxTicksLimit: 12 } } },
  });
  const mount = (id, config) => {
    const canvas = document.getElementById(id);
    if (canvas) chartRegistry[id] = new window.Chart(canvas.getContext('2d'), { ...config, plugins: [changeMarkers] });
  };
  const line = (label, data, color, extra = {}) => ({ type: 'line', label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 2, tension: 0.25, spanGaps: false, ...extra });
  const tip = (fmts) => ({ callbacks: { label: (item) => `${item.dataset.label}: ${fmts[item.datasetIndex] ? fmts[item.datasetIndex](item.parsed.y) : item.parsed.y}` } });
  const money = (v) => campanasMoney(v, cur);
  // Los ejes van sin moneda para no recargarlos; la moneda sale en el detalle al pasar el cursor.
  const axisMoney = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1) + 'k' : v.toFixed(Math.abs(v) < 10 ? 2 : 0));

  // 1) Cuota de impresiones y cuota superior
  let o = base();
  o.scales.y = { min: 0, max: 1, grid: { color: col.grid }, ticks: tick(pct) };
  o.plugins.tooltip = { ...o.plugins.tooltip, ...tip([pct1, pct1]) };
  mount('camp-chart-is', { type: 'line', data: { labels, datasets: [
    line('Cuota de impresiones', series.map((x) => x.impr_share), col.teal),
    line('Cuota de impresiones superior', series.map((x) => x.top_impr_share), col.navy, { borderDash: [5, 4] }),
  ] }, options: o });

  // 2) Lo obtenido y lo perdido (por presupuesto y por ranking), apilado al 100%
  o = base();
  o.scales.x.stacked = true;
  o.scales.y = { stacked: true, min: 0, max: 1, grid: { color: col.grid }, ticks: tick(pct) };
  o.plugins.tooltip = { ...o.plugins.tooltip, ...tip([pct1, pct1, pct1]) };
  const bar = (label, data, color) => ({ type: 'bar', label, data, backgroundColor: color, borderWidth: 0, barPercentage: 0.9, categoryPercentage: 0.95 });
  mount('camp-chart-lost', { type: 'bar', data: { labels, datasets: [
    bar('Cuota obtenida', series.map((x) => x.impr_share), col.teal),
    bar('Perdida por presupuesto', series.map((x) => x.lost_is_budget), col.orange),
    bar('Perdida por ranking', series.map((x) => x.lost_is_rank), col.red),
  ] }, options: o });

  // 3) Gasto diario frente al presupuesto
  o = base();
  o.scales.y = { beginAtZero: true, grid: { color: col.grid }, ticks: tick(axisMoney) };
  o.plugins.tooltip = { ...o.plugins.tooltip, ...tip([money, money]) };
  mount('camp-chart-spend', { type: 'bar', data: { labels, datasets: [
    { type: 'bar', label: 'Gasto', data: series.map((x) => x.cost), backgroundColor: col.navy, borderRadius: 3, order: 2 },
    line('Presupuesto diario actual', series.map((x) => x.budget), col.orange, { borderDash: [6, 4], pointRadius: 0, order: 1 }),
  ] }, options: o });

  // 4) Clics (barras) y CTR (línea, eje derecho)
  o = base();
  o.scales.y = { beginAtZero: true, grid: { color: col.grid }, ticks: tick((v) => fmtInt(v)) };
  o.scales.y1 = { position: 'right', beginAtZero: true, grid: { display: false }, ticks: tick((v) => v.toFixed(1) + '%') };
  o.plugins.tooltip = { ...o.plugins.tooltip, ...tip([fmtInt, (v) => v.toFixed(2) + '%']) };
  mount('camp-chart-clicks', { type: 'bar', data: { labels, datasets: [
    { type: 'bar', label: 'Clics', data: series.map((x) => x.clicks), backgroundColor: col.teal, borderRadius: 3, yAxisID: 'y', order: 2 },
    line('CTR', series.map((x) => (x.impressions ? (x.clicks / x.impressions) * 100 : null)), col.navy, { yAxisID: 'y1', order: 1 }),
  ] }, options: o });

  // 5) Conversiones (barras) y CPA (línea, eje derecho)
  o = base();
  o.scales.y = { beginAtZero: true, grid: { color: col.grid }, ticks: tick((v) => (Number.isInteger(v) ? v : v.toFixed(1))) };
  o.scales.y1 = { position: 'right', beginAtZero: true, grid: { display: false }, ticks: tick(axisMoney) };
  o.plugins.tooltip = { ...o.plugins.tooltip, ...tip([(v) => (Number.isInteger(v) ? v : v.toFixed(1)), money]) };
  mount('camp-chart-conv', { type: 'bar', data: { labels, datasets: [
    { type: 'bar', label: 'Conversiones', data: series.map((x) => x.conversions), backgroundColor: col.teal, borderRadius: 3, yAxisID: 'y', order: 2 },
    line('CPA', series.map((x) => (x.conversions > 0 ? x.cost / x.conversions : null)), col.orange, { yAxisID: 'y1', order: 1 }),
  ] }, options: o });

  // 6) CPC medio y ROAS, cada uno con su eje
  o = base();
  o.scales.y = { beginAtZero: true, grid: { color: col.grid }, ticks: tick(axisMoney) };
  o.scales.y1 = { position: 'right', beginAtZero: true, grid: { display: false }, ticks: tick((v) => v.toFixed(1) + '×') };
  o.plugins.tooltip = { ...o.plugins.tooltip, ...tip([money, (v) => v.toFixed(2) + '×']) };
  mount('camp-chart-cpc', { type: 'line', data: { labels, datasets: [
    line('CPC medio', series.map((x) => (x.clicks ? x.cost / x.clicks : null)), col.navy, { yAxisID: 'y' }),
    line('ROAS', series.map((x) => (x.cost > 0 && x.conv_value > 0 ? x.conv_value / x.cost : null)), col.teal, { yAxisID: 'y1' }),
  ] }, options: o });
}

// ---- Campañas: descargas en HTML ----
// El archivo sale autocontenido (estilos de la plataforma incrustados, gráficas como imágenes y sin botones) para
// mandarlo por correo o guardarlo como PDF con Ctrl+P. Nunca lleva la parte de Cambios (ver campanaExportMode).
let appCssCache = null;
function appCssText() {
  if (!appCssCache) {
    const hrefs = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href);
    appCssCache = Promise.all(hrefs.map((h) => fetch(h).then((r) => (r.ok ? r.text() : '')).catch(() => ''))).then((parts) => parts.join('\n'));
  }
  return appCssCache;
}

const CAMPANAS_EXPORT_CSS = `
  body { margin: 0; background: #fff; }
  .camp-export { max-width: 1200px; margin: 0 auto; padding: 28px 20px 40px; }
  .camp-export h1 { font-size: 22px; margin: 0 0 6px; }
  .camp-export h2 { font-size: 16px; margin: 30px 0 12px; padding-bottom: 6px; border-bottom: 2px solid var(--color-border, #e5e7eb); }
  .camp-export p.meta { color: #6b7280; font-size: 13px; margin: 0 0 4px; }
  .camp-export.wide { max-width: none; }
  .camp-export .table-scroll { max-height: none !important; overflow-x: auto !important; overflow-y: visible !important; }
  .camp-export.wide table { font-size: 11.5px; }
  .camp-export.wide th, .camp-export.wide td { padding-left: 5px; padding-right: 5px; }
  .camp-export.wide th:first-child { min-width: 170px !important; }
  .camp-export.wide .card { padding-left: 14px; padding-right: 14px; }
  .camp-export thead th { position: static !important; }
  .camp-export img.camp-chart { width: 100%; height: auto; display: block; }
  @page { size: landscape; margin: 10mm; }
  @media print { .camp-export { padding: 0; } .camp-export.wide { zoom: .68; } .camp-export .table-scroll { overflow: visible !important; } .camp-export h2 { break-after: avoid; } .camp-export tr { break-inside: avoid; } }
`;

// Convierte el HTML de la pantalla en HTML estático: sin botones y con las gráficas como imágenes.
function campanasStaticHtml(inner, charts = {}) {
  const box = document.createElement('div');
  box.innerHTML = inner;
  box.querySelectorAll('button, .modal-close').forEach((el) => el.remove());
  box.querySelectorAll('[data-camp-open]').forEach((el) => { el.removeAttribute('data-camp-open'); el.style.cursor = ''; el.removeAttribute('title'); });
  box.querySelectorAll('canvas').forEach((cv) => {
    const src = charts[cv.id.replace('camp-chart-', '')];
    if (!src) { cv.remove(); return; }
    const img = document.createElement('img');
    img.className = 'camp-chart'; img.alt = ''; img.src = src;
    cv.parentElement.style.height = 'auto';
    cv.replaceWith(img);
  });
  return box.innerHTML;
}

async function campanasHtmlDocument(title, bodyHtml, wide) {
  const css = await appCssText();
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
<style>${CAMPANAS_EXPORT_CSS}</style></head><body><main class="camp-export${wide ? ' wide' : ''}">${bodyHtml}</main></body></html>`;
}

function campanasFilterSummary() {
  const c = state.campanas;
  const sortLabels = { cost: 'gasto', conversions: 'conversiones', clicks: 'clics', hotel: 'hotel', name: 'nombre' };
  const out = [`Estado: ${({ ENABLED: 'activas', PAUSED: 'pausadas', all: 'todas' })[c.statusFilter] || c.statusFilter}`];
  if (c.hotelFilter !== 'all') out.push(`Hotel (según ${c.hotelBy === 'nombre' ? 'el nombre de la campaña' : 'la cuenta'}): ${c.hotelFilter}`);
  if (c.typeFilter !== 'all') out.push(`Tipo: ${campanasTypeLabel(c.typeFilter)}`);
  if ((c.search || '').trim()) out.push(`Búsqueda: "${c.search.trim()}"`);
  out.push(`Orden: ${sortLabels[c.sortBy] || c.sortBy}`);
  return out;
}

// La tabla de campañas con los filtros y el orden de la pantalla, sin el tope de filas que tiene la pantalla.
async function downloadCampanasHtml() {
  const c = state.campanas;
  const rows = campanasFilteredRows();
  if (!rows.length) return;
  const today = new Date().toISOString().slice(0, 10);
  const nAccounts = c.watchlist.length;
  const body = `
    <h1>Campañas</h1>
    <p class="meta">${fmtInt(nAccounts)} cuenta${nAccounts === 1 ? '' : 's'} de la lista de Ritmo de consumo · del ${escapeHtml(c.loadedFrom)} al ${escapeHtml(c.loadedTo)} · ${fmtInt(rows.length)} campaña${rows.length === 1 ? '' : 's'} · generado el ${today}</p>
    <p class="meta">${campanasFilterSummary().map(escapeHtml).join(' · ')}</p>
    ${c.simulated ? '<p class="meta"><strong>Datos de ejemplo (modo simulado).</strong></p>' : ''}
    ${c.partial.length ? `<p class="meta"><strong>No se pudieron leer ${c.partial.length} cuenta(s):</strong> ${c.partial.map(escapeHtml).join('; ')}</p>` : ''}
    <div style="margin-top:14px">${campanasTotalsHtml(rows)}</div>
    <div class="card table-panel" style="margin-top:16px">
      <div class="table-scroll"><table>${CAMPANAS_TABLE_HEAD}<tbody>${rows.map((r) => renderCampanasRow(r, true)).join('')}</tbody></table></div>
      <p class="footnote" style="margin-top:10px">Las cuotas de impresiones son del rango elegido; Google no las da para todos los tipos de campaña (p. ej. Display) y ahí aparece N/D.</p>
    </div>`;
  downloadTextFile(await campanasHtmlDocument('Campañas', campanasStaticHtml(body), true), `campanas_${today}.html`, 'text/html');
}

const CAMPANA_EXPORT_TABS = ['resumen', 'graficas', 'grupos', 'segmentos', 'palabras', 'posicion']; // todas menos Cambios

// Pide todas las pestañas del detalle (cada una trae sus datos solo al abrirse) y espera a que terminen.
function campanaLoadAllParts(token) {
  const c = state.campanas;
  const row = campanaDetailRow();
  CAMPANA_EXPORT_TABS.forEach(ensureCampanaTab);
  const statuses = () => {
    const d = c.detail;
    return [d.status, d.ctx.status, d.breakdown.status, d.seg.status, d.pos.status, ...(row.channel_type === 'SEARCH' ? [d.kw.status] : [])];
  };
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (c.detail.token !== token) { clearInterval(timer); reject(new Error('Se cerró el detalle antes de terminar.')); return; }
      if (statuses().every((st) => st === 'ready' || st === 'error')) { clearInterval(timer); resolve(); return; }
      if (Date.now() - t0 > 90000) { clearInterval(timer); reject(new Error('Google Ads tardó demasiado en responder.')); }
    }, 250);
  });
}

// Las gráficas son canvas: se muestra un momento la pestaña Gráficas (sin las líneas de cambios) y se guardan como imágenes.
function campanaChartImages(token) {
  const c = state.campanas;
  const d = c.detail;
  const prevTab = d.tab;
  d.tab = 'graficas';
  render();
  return new Promise((resolve) => setTimeout(() => {
    const out = {};
    ['is', 'lost', 'spend', 'clicks', 'conv', 'cpc'].forEach((k) => {
      const cv = document.getElementById(`camp-chart-${k}`);
      if (!cv) return;
      const flat = document.createElement('canvas');
      flat.width = cv.width; flat.height = cv.height;
      const g = flat.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, flat.width, flat.height); g.drawImage(cv, 0, 0);
      out[k] = flat.toDataURL('image/png');
    });
    if (c.detail.token === token) { c.detail.tab = prevTab; render(); }
    resolve(out);
  }, 900));
}

// El detalle completo de una campaña: todas las pestañas menos Cambios.
async function downloadCampanaDetailHtml() {
  const c = state.campanas;
  const row = campanaDetailRow();
  if (!row || c.detail.exporting) return;
  const token = c.detail.token;
  c.detail.exporting = true; c.detail.exportError = null;
  render();
  campanaExportMode = true;
  try {
    await campanaLoadAllParts(token);
    const charts = await campanaChartImages(token);
    const d = c.detail;
    const cur = d.currency || row.currency;
    const strat = campanasStrategy(row);
    const prev = campanasPrevRange();
    const today = new Date().toISOString().slice(0, 10);
    const tabs = CAMPANA_TABS.filter(([k]) => CAMPANA_EXPORT_TABS.includes(k) && (k !== 'palabras' || row.channel_type === 'SEARCH'));
    const sections = tabs.map(([k, label]) => `<section><h2>${escapeHtml(label)}</h2>${CAMPANA_TAB_RENDERERS[k](row, cur)}</section>`).join('');
    const body = `
      <h1>${escapeHtml(row.campaign_name)}</h1>
      <p class="meta">${escapeHtml(campanasHotelOf(row))} · ${escapeHtml(campanasTypeLabel(row.channel_type))} · ${escapeHtml(strat.label)}${strat.target ? ` (${escapeHtml(strat.target)})` : ''} · ${row.status === 'ENABLED' ? 'Activa' : 'Pausada'} · Presupuesto/día ${row.budget == null ? 'N/D' : campanasMoney(row.budget, row.currency)}</p>
      <p class="meta">Cuenta ${escapeHtml(row.account_name)} (${escapeHtml(row.customer_id)}) · del ${escapeHtml(c.loadedFrom)} al ${escapeHtml(c.loadedTo)}, comparado con el periodo anterior del ${escapeHtml(prev.from)} al ${escapeHtml(prev.to)} · generado el ${today}</p>
      ${d.simulated ? '<p class="meta"><strong>Datos de ejemplo (modo simulado).</strong></p>' : ''}
      ${sections}`;
    const html = await campanasHtmlDocument(row.campaign_name, campanasStaticHtml(body, charts));
    downloadTextFile(html, `campana_${cambiosSlug(row.campaign_name)}_${today}.html`, 'text/html');
  } catch (err) {
    if (c.detail.token === token) c.detail.exportError = err.message || String(err);
  } finally {
    campanaExportMode = false;
    if (c.detail.token === token) { c.detail.exporting = false; render(); }
  }
}

// ---- Historial de cambios de la cuenta ----
const CAMBIOS_PAGE_SIZE = 100;
const CAMBIOS_OPERATIONS = [['CREATE', 'Creó'], ['UPDATE', 'Cambió'], ['REMOVE', 'Eliminó']];

function emptyCambiosFilters() { return { user: 'all', client: 'all', resource: 'all', operation: 'all', campaign: 'all', search: '' }; }

// Valor de un cambio en texto; `currency` es el código de moneda de la cuenta.
function changeValueText(item, v, currency) {
  if (v == null) return null;
  if (item.kind === 'money') return campanasMoney(v, currency);
  if (item.kind === 'roas') return `${Number(v).toFixed(2)}×`;
  if (item.kind === 'status') return ({ ENABLED: 'Activa', PAUSED: 'Pausada', REMOVED: 'Eliminada' })[v] || v;
  if (item.kind === 'bid_strategy') return BID_STRATEGY_LABELS_ES[v] || v;
  return String(v);
}

// Detalle de un cambio como texto plano (una línea por dato): para el CSV y la búsqueda.
function changeDetailLines(ch, currency) {
  if (!ch.items.length) return ch.text ? [ch.text] : [];
  return ch.items.map((it) => {
    const o = changeValueText(it, it.old, currency), n = changeValueText(it, it.new, currency);
    return o != null || n != null ? `${it.label}: ${o != null ? `${o} → ` : ''}${n != null ? n : '—'}` : it.label;
  });
}

function changeDetailHtml(ch, currency) {
  if (!ch.items.length) return ch.text ? escapeHtml(ch.text) : '<span class="field-hint">—</span>';
  return ch.items.map((it) => {
    const o = changeValueText(it, it.old, currency), n = changeValueText(it, it.new, currency);
    return `<div>${escapeHtml(it.label)}${o != null || n != null ? `: ${o != null ? `<span style="text-decoration:line-through;opacity:.7">${escapeHtml(o)}</span> → ` : ''}<strong>${n != null ? escapeHtml(n) : '—'}</strong>` : ''}</div>`;
  }).join('');
}

const changeClientText = (client) => CAMPANA_CLIENT_ES[client] || campanaEnumText(client);
const changeUserText = (ch) => ch.user || 'Google (sin usuario)';

function ensureCambiosLoaded() {
  const s = state.cambios;
  if (s.watchlistStatus !== 'idle' || !currentUser.isSuperAdmin) return;
  s.watchlistStatus = 'loading';
  fetch('/api/google-ads/pacing/watchlist')
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      s.watchlist = data.watchlist || [];
      s.watchlistStatus = 'ready';
      if (!s.accountId && s.watchlist.length) s.accountId = s.watchlist[0].customer_id;
      if (s.accountId) loadCambios(); else render();
    })
    .catch((err) => { s.watchlistStatus = 'error'; s.error = err.message || String(err); render(); });
}

function loadCambios() {
  const s = state.cambios;
  if (!s.accountId) { s.error = 'Elige una cuenta primero.'; render(); return; }
  const token = ++s.loadToken;
  const acc = s.watchlist.find((a) => a.customer_id === s.accountId);
  s.status = 'loading'; s.error = null;
  render();
  const params = new URLSearchParams({ customer_id: s.accountId, days: String(s.days) });
  fetch(`/api/google-ads/account-changes?${params.toString()}`)
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.error || 'Error desconocido.');
      if (token !== s.loadToken) return;
      s.rows = data.changes || [];
      s.truncated = !!data.truncated;
      s.warnings = data.errors || {};
      s.simulated = !!data.simulated;
      s.currency = data.currency || '';
      s.loaded = { accountId: s.accountId, accountName: (acc && acc.account_name) || s.accountId, days: s.days };
      s.filters = emptyCambiosFilters();
      s.limit = CAMBIOS_PAGE_SIZE;
      s.status = 'ready';
      render();
    })
    .catch((err) => {
      if (token !== s.loadToken) return;
      s.status = 'error'; s.error = err.message || String(err);
      render();
    });
}

function cambiosFilteredRows() {
  const s = state.cambios;
  const f = s.filters;
  const q = f.search.trim().toLowerCase();
  return s.rows.filter((ch) => {
    if (f.user !== 'all' && changeUserText(ch) !== f.user) return false;
    if (f.client !== 'all' && ch.client !== f.client) return false;
    if (f.resource !== 'all' && ch.resource !== f.resource) return false;
    if (f.operation !== 'all' && ch.operation !== f.operation) return false;
    if (f.campaign !== 'all' && ch.campaign_id !== f.campaign) return false;
    if (q) {
      const hay = [ch.campaign_name, ch.ad_group_name, changeUserText(ch), ch.resource_label, ...changeDetailLines(ch, s.currency)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function cambiosFilterSummary() {
  const s = state.cambios;
  const f = s.filters;
  const parts = [];
  if (f.user !== 'all') parts.push(`Persona: ${f.user}`);
  if (f.client !== 'all') parts.push(`Origen: ${changeClientText(f.client)}`);
  if (f.resource !== 'all') parts.push(`Qué: ${(s.rows.find((r) => r.resource === f.resource) || {}).resource_label || f.resource}`);
  if (f.operation !== 'all') parts.push(`Operación: ${(CAMBIOS_OPERATIONS.find((o) => o[0] === f.operation) || [])[1] || f.operation}`);
  if (f.campaign !== 'all') parts.push(`Campaña: ${(s.rows.find((r) => r.campaign_id === f.campaign) || {}).campaign_name || f.campaign}`);
  if (f.search.trim()) parts.push(`Texto: «${f.search.trim()}»`);
  return parts;
}

const cambiosSlug = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cuenta';

function downloadCambiosCsv() {
  const s = state.cambios;
  if (!s.loaded) return;
  const rows = [['Fecha y hora (hora de la cuenta)', 'Persona', 'Origen', 'Campaña', 'Grupo de anuncios', 'Operación', 'Qué', 'Detalle']];
  cambiosFilteredRows().forEach((ch) => rows.push([ch.when, changeUserText(ch), changeClientText(ch.client), ch.campaign_name, ch.ad_group_name, ch.operation_label, ch.resource_label, changeDetailLines(ch, s.currency).join(' | ')]));
  engine.downloadCsv(`historial_cambios_${cambiosSlug(s.loaded.accountName)}_${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

function downloadCambiosHtml() {
  const s = state.cambios;
  if (!s.loaded) return;
  const list = cambiosFilteredRows();
  const filters = cambiosFilterSummary();
  const body = list.map((ch) => `
      <tr>
        <td class="nw">${escapeHtml(ch.when.slice(0, 16))}</td>
        <td>${escapeHtml(changeUserText(ch))}<div class="sub">${escapeHtml(changeClientText(ch.client))}</div></td>
        <td>${escapeHtml(ch.campaign_name || '—')}${ch.ad_group_name ? `<div class="sub">${escapeHtml(ch.ad_group_name)}</div>` : ''}</td>
        <td>${escapeHtml(ch.operation_label)} · ${escapeHtml(ch.resource_label)}</td>
        <td>${changeDetailHtml(ch, s.currency)}</td>
      </tr>`).join('');
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Historial de cambios — ${escapeHtml(s.loaded.accountName)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; margin: 32px auto; max-width: 1100px; padding: 0 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; } p.meta { color: #6b7280; font-size: 13px; margin: 0 0 4px; }
  table { border-collapse: collapse; width: 100%; margin-top: 18px; font-size: 13px; }
  th { text-align: left; background: #f3f4f6; padding: 8px 10px; border-bottom: 2px solid #d1d5db; }
  td { padding: 8px 10px; border-bottom: 1px solid #e5e7eb; vertical-align: top; } .nw { white-space: nowrap; } .sub { color: #6b7280; font-size: 12px; }
  s { opacity: .7; }
</style></head><body>
<h1>Historial de cambios — ${escapeHtml(s.loaded.accountName)}</h1>
<p class="meta">Cuenta ${escapeHtml(s.loaded.accountId)} · últimos ${s.loaded.days} días · ${list.length} cambio${list.length === 1 ? '' : 's'} · generado el ${escapeHtml(new Date().toISOString().slice(0, 10))}</p>
${filters.length ? `<p class="meta">Filtros: ${filters.map(escapeHtml).join(' · ')}</p>` : ''}
<p class="meta">Las horas son las de la cuenta. Google Ads guarda 30 días de cambios.</p>
<table><thead><tr><th>Fecha</th><th>Quién</th><th>Campaña</th><th>Qué</th><th>Detalle</th></tr></thead><tbody>${body || '<tr><td colspan="5">Sin cambios.</td></tr>'}</tbody></table>
</body></html>`.replace(/<span style="text-decoration:line-through;opacity:.7">/g, '<s>').replace(/<\/span> →/g, '</s> →');
  downloadTextFile(html, `historial_cambios_${cambiosSlug(s.loaded.accountName)}_${new Date().toISOString().slice(0, 10)}.html`, 'text/html');
}

function renderCambiosPage() {
  const s = state.cambios;
  if (!currentUser.isSuperAdmin) {
    return `<div class="card state-panel idle"><p>Esta sección todavía no está disponible para tu usuario.</p></div>`;
  }
  ensureCambiosLoaded();

  const opt = (value, label, current) => `<option value="${escapeHtml(value)}" ${current === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  const controls = `
    <div class="card control-panel align-end">
      <div class="field"><label>Cuenta</label>
        <select id="cam-account" style="width:300px">${s.watchlist.map((a) => opt(a.customer_id, `${a.account_name || a.customer_id} (${a.customer_id})`, s.accountId)).join('')}</select>
      </div>
      <div class="field"><label>Periodo</label>
        <select id="cam-days" style="width:160px">${[7, 14, 30].map((d) => opt(String(d), `Últimos ${d} días`, String(s.days))).join('')}</select>
      </div>
      <button class="btn-accent" data-action="cambios-load" ${s.status === 'loading' ? 'disabled' : ''}>Consultar</button>
      <p class="field-hint" style="max-width:380px">Cuentas de tu lista de <strong>Ritmo de consumo</strong>. Google Ads solo guarda 30 días de cambios, y un cambio puede tardar unos minutos en aparecer.</p>
    </div>`;

  const errorHtml = s.error ? `<div class="error-panel" style="margin-bottom:16px">${escapeHtml(s.error)}</div>` : '';
  if (s.watchlistStatus === 'idle' || s.watchlistStatus === 'loading') {
    return `${controls}<div class="card state-panel loading"><div class="spinner"></div><p>Leyendo tus cuentas…</p></div>`;
  }
  if (s.watchlistStatus === 'error') return `${controls}${errorHtml}`;
  if (!s.watchlist.length) {
    return `${controls}
      <div class="card state-panel idle">
        ${icon('history', 30)}
        <p>Tu lista de Ritmo de consumo está vacía. Agrega ahí las cuentas que quieras ver y vuelve a esta sección.</p>
        <button class="btn-outline" data-action="camp-go-pacing">Ir a Ritmo de consumo</button>
      </div>`;
  }
  if (s.status === 'loading') return `${controls}<div class="card state-panel loading"><div class="spinner"></div><p>Trayendo el historial de cambios…</p></div>`;
  if (s.status === 'error') return `${controls}${errorHtml}`;
  if (s.status !== 'ready') return `${controls}<div class="card state-panel idle">${icon('history', 30)}<p>Elige una cuenta y pulsa Consultar.</p></div>`;

  const sim = s.simulated ? `<div class="ok-panel" style="margin:10px 0"><strong>Modo simulado.</strong> La API de Google Ads no está configurada en el servidor: son cambios de ejemplo.</div>` : '';
  const warn = Object.keys(s.warnings || {}).length
    ? `<div class="error-panel" style="margin-bottom:16px">Algunos nombres no se pudieron resolver (${Object.keys(s.warnings).map((k) => ({ campaigns: 'campañas', ad_groups: 'grupos de anuncios' })[k] || k).join(', ')}); se muestra el id en su lugar.</div>` : '';
  const trunc = s.truncated
    ? `<div class="error-panel" style="margin-bottom:16px">La cuenta tiene más cambios de los que se pueden traer de una vez; se muestran los más recientes. Elige un periodo más corto para ver los anteriores.</div>` : '';

  // Opciones de filtro: salen de lo que realmente trae la consulta.
  const uniq = (fn) => [...new Set(s.rows.map(fn))].filter(Boolean);
  const users = uniq(changeUserText).sort((a, b) => a.localeCompare(b));
  const clients = uniq((ch) => ch.client).sort((a, b) => changeClientText(a).localeCompare(changeClientText(b)));
  const resources = [...new Map(s.rows.map((ch) => [ch.resource, ch.resource_label])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const campaigns = [...new Map(s.rows.filter((ch) => ch.campaign_id).map((ch) => [ch.campaign_id, ch.campaign_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const f = s.filters;
  const filters = `
    <div class="card control-panel align-end">
      <div class="field"><label>Persona</label>
        <select id="cf-user" style="width:220px">${opt('all', 'Todas', f.user)}${users.map((u) => opt(u, u, f.user)).join('')}</select>
      </div>
      <div class="field"><label>Origen</label>
        <select id="cf-client" style="width:200px">${opt('all', 'Todos', f.client)}${clients.map((c) => opt(c, changeClientText(c), f.client)).join('')}</select>
      </div>
      <div class="field"><label>Qué cambió</label>
        <select id="cf-resource" style="width:220px">${opt('all', 'Todo', f.resource)}${resources.map(([k, label]) => opt(k, label, f.resource)).join('')}</select>
      </div>
      <div class="field"><label>Operación</label>
        <select id="cf-operation" style="width:130px">${opt('all', 'Todas', f.operation)}${CAMBIOS_OPERATIONS.map(([k, label]) => opt(k, label, f.operation)).join('')}</select>
      </div>
      <div class="field"><label>Campaña</label>
        <select id="cf-campaign" style="width:260px">${opt('all', 'Todas', f.campaign)}${campaigns.map(([k, name]) => opt(k, name, f.campaign)).join('')}</select>
      </div>
      <div class="field"><label>Buscar</label><input type="text" id="cf-search" placeholder="Texto, campaña, persona…" value="${escapeHtml(f.search)}" style="width:220px" /></div>
    </div>`;

  const list = cambiosFilteredRows();
  const shown = list.slice(0, s.limit);
  const people = new Set(list.map(changeUserText));
  const camps = new Set(list.filter((ch) => ch.campaign_id).map((ch) => ch.campaign_id));
  const card = (label, value, sub) => `<div class="card stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;
  const cards = `
    <div class="stat-grid">
      ${card('Cambios', fmtInt(list.length), list.length === s.rows.length ? `en los últimos ${s.loaded.days} días` : `de ${fmtInt(s.rows.length)} en total`)}
      ${card('Personas', fmtInt(people.size), 'que hicieron cambios')}
      ${card('Campañas tocadas', fmtInt(camps.size), '')}
      ${card('Último cambio', list.length ? escapeHtml(list[0].when.slice(0, 10)) : 'N/D', list.length ? escapeHtml(list[0].when.slice(11, 16)) : '')}
    </div>`;

  const rowsHtml = shown.map((ch) => `
    <tr>
      <td style="white-space:nowrap">${escapeHtml(ch.when.slice(0, 16))}</td>
      <td>${escapeHtml(changeUserText(ch))}<div class="field-hint">${escapeHtml(changeClientText(ch.client))}</div></td>
      <td style="min-width:200px">${escapeHtml(ch.campaign_name || '—')}${ch.ad_group_name ? `<div class="field-hint">${escapeHtml(ch.ad_group_name)}</div>` : ''}</td>
      <td>${escapeHtml(ch.operation_label)} · ${escapeHtml(ch.resource_label)}</td>
      <td style="min-width:240px">${changeDetailHtml(ch, s.currency)}</td>
    </tr>`).join('');
  const table = `
    <div class="card table-panel">
      <div class="table-panel-head" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <h3>${escapeHtml(s.loaded.accountName)} · cambios (${fmtInt(list.length)})</h3>
        <div style="display:flex;gap:8px">
          <button class="btn-outline xs" data-action="cambios-csv" ${list.length ? '' : 'disabled'}>Descargar CSV</button>
          <button class="btn-outline xs" data-action="cambios-html" ${list.length ? '' : 'disabled'}>Descargar HTML</button>
        </div>
      </div>
      <div class="table-scroll" style="max-height:620px">
        <table>
          <thead><tr><th>Fecha</th><th>Quién</th><th>Campaña</th><th>Qué</th><th>Detalle</th></tr></thead>
          <tbody>${rowsHtml || '<tr><td colspan="5" class="footnote">Ningún cambio coincide con los filtros.</td></tr>'}</tbody>
        </table>
      </div>
      ${list.length > shown.length ? `<p class="footnote" style="margin-top:10px">Mostrando ${fmtInt(shown.length)} de ${fmtInt(list.length)}. <button class="btn-outline xs" data-action="cambios-more">Mostrar ${fmtInt(Math.min(CAMBIOS_PAGE_SIZE, list.length - shown.length))} más</button> Las descargas incluyen todos.</p>` : ''}
      <p class="footnote" style="margin-top:10px">Las horas son las de la cuenta. "API / herramientas" incluye los cambios hechos desde esta plataforma. Los cambios sin usuario los hace Google (recomendaciones automáticas, ajustes de puja). En los anuncios solo se avisa de que cambió el texto, sin detallarlo.</p>
    </div>`;

  return `${controls}${sim}${warn}${trunc}${filters}${cards}${table}`;
}

function bindEvents() {
  // Campañas
  document.querySelectorAll('[data-camp-open]').forEach((el) => el.addEventListener('click', () => openCampanaDetail(el.dataset.campOpen)));
  document.querySelectorAll('[data-camp-tab]').forEach((el) => el.addEventListener('click', () => setCampanaTab(el.dataset.campTab)));
  document.querySelectorAll('[data-camp-go]').forEach((el) => el.addEventListener('click', () => campanaGoTo(el.dataset.campGo)));
  const campDetailOverlay = document.querySelector('.camp-detail-overlay');
  if (campDetailOverlay) campDetailOverlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-modal-stop-propagation]')) return;
    closeCampanaDetail();
  });
  const campOn = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  campOn('camp-date-from', 'change', (e) => { state.campanas.dateFrom = e.target.value; });
  campOn('camp-date-to', 'change', (e) => { state.campanas.dateTo = e.target.value; });
  campOn('camp-hotel-by', 'change', (e) => { state.campanas.hotelBy = e.target.value; state.campanas.hotelFilter = 'all'; render(); });
  campOn('camp-hotel-filter', 'change', (e) => { state.campanas.hotelFilter = e.target.value; render(); });
  campOn('camp-type-filter', 'change', (e) => { state.campanas.typeFilter = e.target.value; render(); });
  campOn('camp-status-filter', 'change', (e) => { state.campanas.statusFilter = e.target.value; render(); });
  campOn('camp-sort', 'change', (e) => { state.campanas.sortBy = e.target.value; render(); });
  campOn('camp-search', 'input', (e) => { state.campanas.search = e.target.value; render(); hotelRefocus('camp-search'); });
  document.querySelectorAll('[data-camp-ask]').forEach((btn) => btn.addEventListener('click', () => { state.campanas.confirm = btn.dataset.campAsk; render(); }));
  document.querySelectorAll('[data-camp-cancel]').forEach((btn) => btn.addEventListener('click', () => { state.campanas.confirm = null; render(); }));
  document.querySelectorAll('[data-camp-do]').forEach((btn) => btn.addEventListener('click', () => setCampanaStatus(btn.dataset.campDo, btn.dataset.campStatus)));

  // Historial de cambios
  const camOn = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  camOn('cam-account', 'change', (e) => { state.cambios.accountId = e.target.value; });
  camOn('cam-days', 'change', (e) => { state.cambios.days = Number(e.target.value); });
  [['cf-user', 'user'], ['cf-client', 'client'], ['cf-resource', 'resource'], ['cf-operation', 'operation'], ['cf-campaign', 'campaign']].forEach(([id, key]) => {
    camOn(id, 'change', (e) => { state.cambios.filters[key] = e.target.value; state.cambios.limit = CAMBIOS_PAGE_SIZE; render(); });
  });
  camOn('cf-search', 'input', (e) => { state.cambios.filters.search = e.target.value; state.cambios.limit = CAMBIOS_PAGE_SIZE; render(); hotelRefocus('cf-search'); });

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

  const rendCampaignFilter = document.getElementById('rend-campaign-filter');
  if (rendCampaignFilter) rendCampaignFilter.addEventListener('change', (e) => {
    state.rend.campaignFilter = e.target.value;
    render();
  });

  const rendApiAccount = document.getElementById('rend-api-account');
  if (rendApiAccount) rendApiAccount.addEventListener('change', (e) => { state.rend.api.accountId = e.target.value; });
  const rendApiAccountManual = document.getElementById('rend-api-account-manual');
  if (rendApiAccountManual) rendApiAccountManual.addEventListener('input', (e) => { state.rend.api.accountIdManual = e.target.value; });
  const rendApiDateFrom = document.getElementById('rend-api-date-from');
  if (rendApiDateFrom) rendApiDateFrom.addEventListener('change', (e) => { state.rend.api.dateFrom = e.target.value; });
  const rendApiDateTo = document.getElementById('rend-api-date-to');
  if (rendApiDateTo) rendApiDateTo.addEventListener('change', (e) => { state.rend.api.dateTo = e.target.value; });
  const rendApiOnlyActive = document.getElementById('rend-api-only-active');
  if (rendApiOnlyActive) rendApiOnlyActive.addEventListener('change', (e) => { state.rend.api.onlyActive = e.target.checked; });
  const rendMccFilter = document.getElementById('rend-mcc-filter');
  if (rendMccFilter) rendMccFilter.addEventListener('input', (e) => { state.rend.api.mcc.filter = e.target.value; render(); });
  document.querySelectorAll('[data-rend-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => applyRendMccFilter(btn.dataset.rendMccPick, btn.dataset.rendMccPickName));
  });

  document.querySelectorAll('[data-rend-tab]').forEach((btn) => {
    btn.addEventListener('click', () => { state.rend.chartTab = btn.dataset.rendTab; render(); });
  });

  // Comparativa de periodos
  const compareCurrentFile = document.getElementById('compare-current-file');
  if (compareCurrentFile) compareCurrentFile.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    state.compare.current.status = 'loading'; state.compare.current.error = null; state.compare.current.fileName = file.name;
    render();
    readFileAsCsvText(file).then((text) => runCompareAnalysis('current', text, file.name))
      .catch((err) => { state.compare.current.status = 'error'; state.compare.current.error = err.message || String(err); render(); });
  });
  const comparePreviousFile = document.getElementById('compare-previous-file');
  if (comparePreviousFile) comparePreviousFile.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    state.compare.previous.status = 'loading'; state.compare.previous.error = null; state.compare.previous.fileName = file.name;
    render();
    readFileAsCsvText(file).then((text) => runCompareAnalysis('previous', text, file.name))
      .catch((err) => { state.compare.previous.status = 'error'; state.compare.previous.error = err.message || String(err); render(); });
  });
  const compareHotelBy = document.getElementById('compare-hotel-by');
  if (compareHotelBy) compareHotelBy.addEventListener('change', (e) => {
    state.compare.hotelBy = e.target.value;
    state.compare.hotelFilter = 'all'; // los nombres de hotel cambian con el corte
    state.compare.campaignFilter = 'all';
    render();
  });
  const compareHotelFilter = document.getElementById('compare-hotel-filter');
  if (compareHotelFilter) compareHotelFilter.addEventListener('change', (e) => {
    state.compare.hotelFilter = e.target.value;
    state.compare.campaignFilter = 'all'; // la campaña elegida puede ser de otro hotel
    render();
  });
  const compareCampaignFilter = document.getElementById('compare-campaign-filter');
  if (compareCampaignFilter) compareCampaignFilter.addEventListener('change', (e) => {
    state.compare.campaignFilter = e.target.value;
    render();
  });
  const compareCampaignTypeFilter = document.getElementById('compare-campaign-type-filter');
  if (compareCampaignTypeFilter) compareCampaignTypeFilter.addEventListener('change', (e) => {
    state.compare.campaignTypeFilter = e.target.value;
    render();
  });
  const compareBrandInput = document.getElementById('compare-brand-keywords');
  if (compareBrandInput) compareBrandInput.addEventListener('input', (e) => { state.compare.brandKeywords = e.target.value; });

  const compareAcctSearch = document.getElementById('compare-api-account-search');
  if (compareAcctSearch) compareAcctSearch.addEventListener('input', (e) => { state.compare.api.accountSearch = e.target.value; render(); hotelRefocus('compare-api-account-search'); });
  document.querySelectorAll('[data-cmp-acct]').forEach((box) => {
    box.addEventListener('change', (e) => {
      const api = state.compare.api;
      const id = e.target.dataset.cmpAcct;
      api.accountIds = e.target.checked ? [...new Set([...api.accountIds, id])] : api.accountIds.filter((x) => x !== id);
      render();
    });
  });
  const compareApiAccountManual = document.getElementById('compare-api-account-manual');
  if (compareApiAccountManual) compareApiAccountManual.addEventListener('input', (e) => { state.compare.api.accountIdManual = e.target.value; });
  const compareMccFilter = document.getElementById('compare-mcc-filter');
  if (compareMccFilter) compareMccFilter.addEventListener('input', (e) => { state.compare.api.mcc.filter = e.target.value; render(); });
  document.querySelectorAll('[data-compare-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => applyCompareMccFilter(btn.dataset.compareMccPick, btn.dataset.compareMccPickName));
  });
  const compareApiCurrentDateFrom = document.getElementById('compare-api-current-date-from');
  if (compareApiCurrentDateFrom) compareApiCurrentDateFrom.addEventListener('change', (e) => { state.compare.api.current.dateFrom = e.target.value; });
  const compareApiCurrentDateTo = document.getElementById('compare-api-current-date-to');
  if (compareApiCurrentDateTo) compareApiCurrentDateTo.addEventListener('change', (e) => { state.compare.api.current.dateTo = e.target.value; });
  const compareApiPreviousDateFrom = document.getElementById('compare-api-previous-date-from');
  if (compareApiPreviousDateFrom) compareApiPreviousDateFrom.addEventListener('change', (e) => { state.compare.api.previous.dateFrom = e.target.value; });
  const compareApiPreviousDateTo = document.getElementById('compare-api-previous-date-to');
  if (compareApiPreviousDateTo) compareApiPreviousDateTo.addEventListener('change', (e) => { state.compare.api.previous.dateTo = e.target.value; });
  const compareApiOnlyActive = document.getElementById('compare-api-only-active');
  if (compareApiOnlyActive) compareApiOnlyActive.addEventListener('change', (e) => { state.compare.api.onlyActive = e.target.checked; });

  // Oportunidad de ingresos
  const oppBrandInput = document.getElementById('opp-brand-keywords');
  if (oppBrandInput) oppBrandInput.addEventListener('input', (e) => { state.opportunity.brandKeywords = e.target.value; });

  const oppFileInput = document.getElementById('opp-file');
  if (oppFileInput) oppFileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    state.opportunity.status = 'loading'; state.opportunity.error = null; state.opportunity.fileName = file.name;
    render();
    readFileAsCsvText(file).then((text) => runOpportunityAnalysis(text, file.name))
      .catch((err) => { state.opportunity.status = 'error'; state.opportunity.error = err.message || String(err); render(); });
  });

  const oppExcludeBrand = document.getElementById('opp-exclude-brand');
  if (oppExcludeBrand) oppExcludeBrand.addEventListener('change', (e) => {
    state.opportunity.excludeBrand = e.target.checked;
    state.opportunity.campaignFilter = 'all';
    render();
  });

  const oppHotelFilter = document.getElementById('opp-hotel-filter');
  if (oppHotelFilter) oppHotelFilter.addEventListener('change', (e) => {
    state.opportunity.hotelFilter = e.target.value;
    state.opportunity.campaignFilter = 'all';
    render();
  });

  document.querySelectorAll('[data-opp-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = state.opportunity;
      const t = btn.dataset.oppType;
      if (t === '__all') s.typeFilter = [];
      else s.typeFilter = s.typeFilter.includes(t) ? s.typeFilter.filter((x) => x !== t) : [...s.typeFilter, t];
      s.campaignFilter = 'all';
      render();
    });
  });

  const oppCampaignFilter = document.getElementById('opp-campaign-filter');
  if (oppCampaignFilter) oppCampaignFilter.addEventListener('change', (e) => {
    state.opportunity.campaignFilter = e.target.value;
    render();
  });

  const oppAcctSearch = document.getElementById('opp-api-account-search');
  if (oppAcctSearch) oppAcctSearch.addEventListener('input', (e) => { state.opportunity.api.accountSearch = e.target.value; render(); });
  document.querySelectorAll('[data-opp-acct]').forEach((box) => {
    box.addEventListener('change', (e) => {
      const a = state.opportunity.api;
      const id = e.target.dataset.oppAcct;
      a.accountIds = e.target.checked ? [...new Set([...a.accountIds, id])] : a.accountIds.filter((x) => x !== id);
      render();
    });
  });
  const oppApiAccountManual = document.getElementById('opp-api-account-manual');
  if (oppApiAccountManual) oppApiAccountManual.addEventListener('input', (e) => { state.opportunity.api.accountIdManual = e.target.value; });
  const oppMccFilter = document.getElementById('opp-mcc-filter');
  if (oppMccFilter) oppMccFilter.addEventListener('input', (e) => { state.opportunity.api.mcc.filter = e.target.value; render(); });
  document.querySelectorAll('[data-opp-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => applyOppMccFilter(btn.dataset.oppMccPick, btn.dataset.oppMccPickName));
  });
  const oppApiDateFrom = document.getElementById('opp-api-date-from');
  if (oppApiDateFrom) oppApiDateFrom.addEventListener('change', (e) => { state.opportunity.api.dateFrom = e.target.value; });
  const oppApiDateTo = document.getElementById('opp-api-date-to');
  if (oppApiDateTo) oppApiDateTo.addEventListener('change', (e) => { state.opportunity.api.dateTo = e.target.value; });
  const oppApiOnlyActive = document.getElementById('opp-api-only-active');
  if (oppApiOnlyActive) oppApiOnlyActive.addEventListener('change', (e) => { state.opportunity.api.onlyActive = e.target.checked; });

  // ROAS
  const roasApiAccount = document.getElementById('roas-api-account');
  if (roasApiAccount) roasApiAccount.addEventListener('change', (e) => { state.roas.api.accountId = e.target.value; });
  const roasApiAccountManual = document.getElementById('roas-api-account-manual');
  if (roasApiAccountManual) roasApiAccountManual.addEventListener('input', (e) => { state.roas.api.accountIdManual = e.target.value; });
  const roasApiDateFrom = document.getElementById('roas-api-date-from');
  if (roasApiDateFrom) roasApiDateFrom.addEventListener('change', (e) => { state.roas.api.dateFrom = e.target.value; });
  const roasApiDateTo = document.getElementById('roas-api-date-to');
  if (roasApiDateTo) roasApiDateTo.addEventListener('change', (e) => { state.roas.api.dateTo = e.target.value; });
  const roasApiOnlyActive = document.getElementById('roas-api-only-active');
  if (roasApiOnlyActive) roasApiOnlyActive.addEventListener('change', (e) => { state.roas.api.onlyActive = e.target.checked; });
  const roasMccFilter = document.getElementById('roas-mcc-filter');
  if (roasMccFilter) roasMccFilter.addEventListener('input', (e) => { state.roas.api.mcc.filter = e.target.value; render(); });
  document.querySelectorAll('[data-roas-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => applyRoasMccFilter(btn.dataset.roasMccPick, btn.dataset.roasMccPickName));
  });
  const roasAdjustInput = document.getElementById('roas-adjust-input');
  if (roasAdjustInput) roasAdjustInput.addEventListener('input', (e) => { state.roas.adjust.newTargetRoas = e.target.value; });
  document.querySelectorAll('[data-action="roas-edit-start"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.roas.adjust = { campaignId: btn.dataset.campaign, newTargetRoas: '', status: 'idle', preview: null, result: null, error: null };
      render();
    });
  });

  // Recomendaciones de Google
  const recsApiAccount = document.getElementById('recs-api-account');
  if (recsApiAccount) recsApiAccount.addEventListener('change', (e) => { state.recs.api.accountId = e.target.value; });
  const recsApiAccountManual = document.getElementById('recs-api-account-manual');
  if (recsApiAccountManual) recsApiAccountManual.addEventListener('input', (e) => { state.recs.api.accountIdManual = e.target.value; });
  const recsMccFilter = document.getElementById('recs-mcc-filter');
  if (recsMccFilter) recsMccFilter.addEventListener('input', (e) => { state.recs.api.mcc.filter = e.target.value; render(); });
  document.querySelectorAll('[data-recs-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => applyRecsMccFilter(btn.dataset.recsMccPick, btn.dataset.recsMccPickName));
  });
  const recsCampaignFilter = document.getElementById('recs-campaign-filter');
  if (recsCampaignFilter) recsCampaignFilter.addEventListener('change', (e) => {
    state.recs.campaignFilter = e.target.value;
    render();
  });
  document.querySelectorAll('[data-rec-apply]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = (state.recs.rows || []).find((r) => r.resource_name === btn.dataset.recApply);
      if (row) applyRecommendation(row);
    });
  });
  document.querySelectorAll('[data-rec-dismiss]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = (state.recs.rows || []).find((r) => r.resource_name === btn.dataset.recDismiss);
      if (row) dismissRecommendation(row);
    });
  });

  // Hoteles
  const hotelApiAccount = document.getElementById('hotel-api-account');
  if (hotelApiAccount) hotelApiAccount.addEventListener('change', (e) => {
    state.hotel.api.accountId = e.target.value;
    resetHotelAccountData();
  });
  const hotelApiAccountManual = document.getElementById('hotel-api-account-manual');
  if (hotelApiAccountManual) hotelApiAccountManual.addEventListener('input', (e) => {
    state.hotel.api.accountIdManual = e.target.value;
    resetHotelAccountData();
  });
  const hotelApiDateFrom = document.getElementById('hotel-api-date-from');
  if (hotelApiDateFrom) hotelApiDateFrom.addEventListener('change', (e) => { state.hotel.api.dateFrom = e.target.value; });
  const hotelApiDateTo = document.getElementById('hotel-api-date-to');
  if (hotelApiDateTo) hotelApiDateTo.addEventListener('change', (e) => { state.hotel.api.dateTo = e.target.value; });
  const hotelMccFilter = document.getElementById('hotel-mcc-filter');
  if (hotelMccFilter) hotelMccFilter.addEventListener('input', (e) => { state.hotel.api.mcc.filter = e.target.value; render(); hotelRefocus('hotel-mcc-filter'); });
  document.querySelectorAll('[data-hotel-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => applyHotelMccFilter(btn.dataset.hotelMccPick, btn.dataset.hotelMccPickName));
  });
  const hotelCampaignFilter = document.getElementById('hotel-campaign-filter');
  if (hotelCampaignFilter) hotelCampaignFilter.addEventListener('input', (e) => { state.hotel.list.filter = e.target.value; render(); hotelRefocus('hotel-campaign-filter'); });
  document.querySelectorAll('[data-hotel-open]').forEach((btn) => {
    btn.addEventListener('click', () => openHotelCampaign(btn.dataset.hotelOpen, false));
  });
  // La nota se puede editar: se guarda al escribir (sin redibujar) para que otro render no la pise.
  document.querySelectorAll('[data-hotel-note-text]').forEach((el) => {
    el.addEventListener('input', () => { const n = state.hotel.detail.note; if (n && n.data) { n.data.mensaje = el.value; n.copied = false; } });
  });
  document.querySelectorAll('[data-hotel-note-subject]').forEach((el) => {
    el.addEventListener('input', () => { const n = state.hotel.detail.note; if (n && n.data) { n.data.asunto = el.value; n.copied = false; } });
  });
  document.querySelectorAll('[data-hotel-edit]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const d = state.hotel.detail;
      d.edits[input.dataset.hotelEdit] = e.target.value;
      if (d.flow.status === 'preview_ready' || d.flow.status === 'error' || d.flow.status === 'done') d.flow = { status: 'idle', preview: null, result: null, error: null };
      render();
    });
  });

  // IA Max
  const iamaxApiAccount = document.getElementById('iamax-api-account');
  if (iamaxApiAccount) iamaxApiAccount.addEventListener('change', (e) => {
    state.iamax.api.accountId = e.target.value;
    resetIaMaxAccountData();
  });
  const iamaxApiAccountManual = document.getElementById('iamax-api-account-manual');
  if (iamaxApiAccountManual) iamaxApiAccountManual.addEventListener('input', (e) => {
    state.iamax.api.accountIdManual = e.target.value;
    resetIaMaxAccountData();
  });
  const iamaxApiOnlyActive = document.getElementById('iamax-api-only-active');
  if (iamaxApiOnlyActive) iamaxApiOnlyActive.addEventListener('change', (e) => { state.iamax.api.onlyActive = e.target.checked; });
  const iamaxMccFilter = document.getElementById('iamax-mcc-filter');
  if (iamaxMccFilter) iamaxMccFilter.addEventListener('input', (e) => { state.iamax.api.mcc.filter = e.target.value; render(); });
  document.querySelectorAll('[data-iamax-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => applyIaMaxMccFilter(btn.dataset.iamaxMccPick, btn.dataset.iamaxMccPickName));
  });
  const iamaxServedCampaignFilter = document.getElementById('iamax-served-campaign-filter');
  if (iamaxServedCampaignFilter) iamaxServedCampaignFilter.addEventListener('change', (e) => {
    state.iamax.served.campaignFilter = e.target.value;
    render();
  });
  // Casillas de la tabla de páginas: se actualiza solo el contador del botón, sin repintar toda la tabla.
  document.querySelectorAll('[data-iamax-page-check]').forEach((box) => {
    box.addEventListener('change', () => {
      const cr = state.iamax.created;
      const key = box.dataset.iamaxPageCheck;
      if (box.checked) {
        const [campaignId, ...rest] = key.split('|');
        const row = ((cr.data || {}).pages || []).find((r) => r.campaign_id === campaignId && r.page === rest.join('|'));
        if (row) cr.selected[key] = { campaign_id: row.campaign_id, campaign_name: row.campaign_name, page: row.page };
      } else {
        delete cr.selected[key];
      }
      const btn = document.getElementById('iamax-pages-exclude-btn');
      const n = Object.keys(cr.selected).length;
      if (btn) { btn.disabled = n === 0; btn.textContent = `Excluir las seleccionadas (${n})`; }
    });
  });
  document.querySelectorAll('[data-iamax-draft-mode]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const ux = state.iamax.urlx;
      const item = ux.draft[Number(sel.dataset.iamaxDraftMode)];
      if (item) { item.mode = sel.value; resetIaMaxUrlxFlow(); render(); }
    });
  });
  document.querySelectorAll('[data-iamax-draft-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.iamax.urlx.draft.splice(Number(btn.dataset.iamaxDraftRemove), 1);
      resetIaMaxUrlxFlow(); render();
    });
  });
  document.querySelectorAll('[data-iamax-urlx-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.iamax.urlx.remove = { pending: btn.dataset.iamaxUrlxRemove, status: 'idle', error: null };
      render();
    });
  });
  const iamaxUrlxText = document.getElementById('iamax-urlx-paste');
  if (iamaxUrlxText) iamaxUrlxText.addEventListener('input', (e) => { state.iamax.urlx.pasteText = e.target.value; });
  const iamaxUrlxCampaign = document.getElementById('iamax-urlx-campaign');
  if (iamaxUrlxCampaign) iamaxUrlxCampaign.addEventListener('change', (e) => { state.iamax.urlx.pasteCampaign = e.target.value; });
  const iamaxUrlxFile = document.getElementById('iamax-urlx-file');
  if (iamaxUrlxFile) iamaxUrlxFile.addEventListener('change', (e) => { if (e.target.files[0]) loadIaMaxUrlxFile(e.target.files[0]); });
  document.querySelectorAll('[data-iamax-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const cr = state.iamax.created;
      const key = th.dataset.iamaxSort;
      const cur = cr.sort[cr.sub];
      if (cur && cur.key === key) cr.sort[cr.sub] = { key, dir: cur.dir === 'desc' ? 'asc' : 'desc' };
      else cr.sort[cr.sub] = { key, dir: IAMAX_TEXT_SORT_KEYS.has(key) ? 'asc' : 'desc' };
      render();
    });
  });
  const iamaxCreatedDays = document.getElementById('iamax-created-days');
  if (iamaxCreatedDays) iamaxCreatedDays.addEventListener('change', (e) => {
    state.iamax.created.days = Number(e.target.value) || 30;
    fetchIaMaxCreated();
  });
  const iamaxCreatedCampaign = document.getElementById('iamax-created-campaign');
  if (iamaxCreatedCampaign) iamaxCreatedCampaign.addEventListener('change', (e) => {
    state.iamax.created.campaignFilter = e.target.value;
    render();
  });
  document.querySelectorAll('[data-action="iamax-toggle-start"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.iamax.toggle = {
        campaignId: btn.dataset.campaign,
        status: 'idle',
        newEnable: btn.dataset.enable === '1',
        preview: null, result: null, error: null,
      };
      render();
    });
  });

  // Exclusiones de contenido
  const exclusionesApiAccount = document.getElementById('exclusiones-api-account');
  if (exclusionesApiAccount) exclusionesApiAccount.addEventListener('change', (e) => {
    state.contentExclusions.api.accountId = e.target.value;
    resetContentExclusionsAccountData();
  });
  const exclusionesApiAccountManual = document.getElementById('exclusiones-api-account-manual');
  if (exclusionesApiAccountManual) exclusionesApiAccountManual.addEventListener('input', (e) => {
    state.contentExclusions.api.accountIdManual = e.target.value;
    resetContentExclusionsAccountData();
  });
  const exclusionesMccFilter = document.getElementById('exclusiones-mcc-filter');
  if (exclusionesMccFilter) exclusionesMccFilter.addEventListener('input', (e) => { state.contentExclusions.api.mcc.filter = e.target.value; render(); });
  document.querySelectorAll('[data-exclusiones-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => applyExclusionesMccFilter(btn.dataset.exclusionesMccPick, btn.dataset.exclusionesMccPickName));
  });
  document.querySelectorAll('.exclusiones-label-check').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const p = state.contentExclusions.addLabels;
      if (e.target.checked) p.selected.add(e.target.value);
      else p.selected.delete(e.target.value);
      render();
    });
  });
  const exclusionesAppFilter = document.getElementById('exclusiones-app-filter');
  if (exclusionesAppFilter) exclusionesAppFilter.addEventListener('input', (e) => {
    state.contentExclusions.addApp.filter = e.target.value;
    render();
  });
  document.querySelectorAll('.exclusiones-app-check').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const p = state.contentExclusions.addApp;
      if (e.target.checked) p.selected.add(e.target.value);
      else p.selected.delete(e.target.value);
      render();
    });
  });
  document.querySelectorAll('[data-action="exclusiones-remove-start"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.contentExclusions.remove = {
        resourceName: btn.dataset.resource,
        status: 'idle', error: null, preview: null, result: null,
      };
      render();
    });
  });

  // Planificador de palabras clave
  const kwpApiAccount = document.getElementById('kwp-api-account');
  if (kwpApiAccount) kwpApiAccount.addEventListener('change', (e) => {
    state.keywordPlanner.api.accountId = e.target.value;
    resetKeywordPlannerAccountData();
    render();
  });
  const kwpApiAccountManual = document.getElementById('kwp-api-account-manual');
  if (kwpApiAccountManual) kwpApiAccountManual.addEventListener('input', (e) => {
    state.keywordPlanner.api.accountIdManual = e.target.value;
    resetKeywordPlannerAccountData();
  });
  const kwpMccFilter = document.getElementById('kwp-mcc-filter');
  if (kwpMccFilter) kwpMccFilter.addEventListener('input', (e) => { state.keywordPlanner.api.mcc.filter = e.target.value; render(); });
  document.querySelectorAll('[data-kwp-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => applyKwpMccFilter(btn.dataset.kwpMccPick, btn.dataset.kwpMccPickName));
  });
  const kwpGeoQuery = document.getElementById('kwp-geo-query');
  if (kwpGeoQuery) kwpGeoQuery.addEventListener('input', (e) => { state.keywordPlanner.geo.query = e.target.value; });
  document.querySelectorAll('[data-kwp-geo-add]').forEach((btn) => {
    btn.addEventListener('click', () => addKeywordPlannerGeo(btn.dataset.kwpGeoAdd, btn.dataset.kwpGeoName, btn.dataset.kwpGeoCanonical));
  });
  document.querySelectorAll('[data-kwp-geo-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeKeywordPlannerGeo(btn.dataset.kwpGeoRemove));
  });
  const kwpLanguageSelect = document.getElementById('kwp-language-select');
  if (kwpLanguageSelect) kwpLanguageSelect.addEventListener('change', (e) => {
    state.keywordPlanner.languages.selectedResourceName = e.target.value;
  });
  const kwpIdeasSeedKeywords = document.getElementById('kwp-ideas-seed-keywords');
  if (kwpIdeasSeedKeywords) kwpIdeasSeedKeywords.addEventListener('input', (e) => { state.keywordPlanner.ideas.seedKeywords = e.target.value; });
  const kwpIdeasSeedUrl = document.getElementById('kwp-ideas-seed-url');
  if (kwpIdeasSeedUrl) kwpIdeasSeedUrl.addEventListener('input', (e) => { state.keywordPlanner.ideas.seedUrl = e.target.value; });
  document.querySelectorAll('[data-kwp-ideas-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.kwpIdeasSort;
      const i = state.keywordPlanner.ideas;
      if (i.sortBy === key) i.sortDir = i.sortDir === 'desc' ? 'asc' : 'desc';
      else { i.sortBy = key; i.sortDir = 'desc'; }
      render();
    });
  });
  document.querySelectorAll('[data-kwp-historico-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.kwpHistoricoSort;
      const h = state.keywordPlanner.historico;
      if (h.sortBy === key) h.sortDir = h.sortDir === 'desc' ? 'asc' : 'desc';
      else { h.sortBy = key; h.sortDir = 'desc'; }
      render();
    });
  });
  document.querySelectorAll('[data-kwp-historico-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.keywordPlanner.historico.modalKeyword = btn.dataset.kwpHistoricoOpen;
      render();
    });
  });
  const kwpHistoricoModalOverlay = document.querySelector('.modal-overlay');
  if (kwpHistoricoModalOverlay) kwpHistoricoModalOverlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-modal-stop-propagation]')) return;
    state.keywordPlanner.historico.modalKeyword = null;
    render();
  });
  const kwpHistoricoKeywords = document.getElementById('kwp-historico-keywords');
  if (kwpHistoricoKeywords) kwpHistoricoKeywords.addEventListener('input', (e) => { state.keywordPlanner.historico.keywordsText = e.target.value; });
  const kwpPronosticoKeywords = document.getElementById('kwp-pronostico-keywords');
  if (kwpPronosticoKeywords) kwpPronosticoKeywords.addEventListener('input', (e) => { state.keywordPlanner.pronostico.keywordsText = e.target.value; });
  const kwpPronosticoMatchType = document.getElementById('kwp-pronostico-match-type');
  if (kwpPronosticoMatchType) kwpPronosticoMatchType.addEventListener('change', (e) => { state.keywordPlanner.pronostico.matchType = e.target.value; });
  const kwpPronosticoBiddingMode = document.getElementById('kwp-pronostico-bidding-mode');
  if (kwpPronosticoBiddingMode) kwpPronosticoBiddingMode.addEventListener('change', (e) => {
    state.keywordPlanner.pronostico.biddingMode = e.target.value;
    render();
  });
  const kwpPronosticoDailyBudget = document.getElementById('kwp-pronostico-daily-budget');
  if (kwpPronosticoDailyBudget) kwpPronosticoDailyBudget.addEventListener('input', (e) => { state.keywordPlanner.pronostico.dailyBudget = e.target.value; });
  const kwpPronosticoMaxCpc = document.getElementById('kwp-pronostico-max-cpc');
  if (kwpPronosticoMaxCpc) kwpPronosticoMaxCpc.addEventListener('input', (e) => { state.keywordPlanner.pronostico.maxCpcBid = e.target.value; });
  const kwpPronosticoDailyTarget = document.getElementById('kwp-pronostico-daily-target');
  if (kwpPronosticoDailyTarget) kwpPronosticoDailyTarget.addEventListener('input', (e) => { state.keywordPlanner.pronostico.dailyTargetSpend = e.target.value; });
  const kwpPronosticoMaxCpcCeiling = document.getElementById('kwp-pronostico-max-cpc-ceiling');
  if (kwpPronosticoMaxCpcCeiling) kwpPronosticoMaxCpcCeiling.addEventListener('input', (e) => { state.keywordPlanner.pronostico.maxCpcBidCeiling = e.target.value; });
  const kwpPronosticoStartDate = document.getElementById('kwp-pronostico-start-date');
  if (kwpPronosticoStartDate) kwpPronosticoStartDate.addEventListener('input', (e) => { state.keywordPlanner.pronostico.startDate = e.target.value; });
  const kwpPronosticoEndDate = document.getElementById('kwp-pronostico-end-date');
  if (kwpPronosticoEndDate) kwpPronosticoEndDate.addEventListener('input', (e) => { state.keywordPlanner.pronostico.endDate = e.target.value; });
  const kwpPronosticoCurrency = document.getElementById('kwp-pronostico-currency');
  if (kwpPronosticoCurrency) kwpPronosticoCurrency.addEventListener('input', (e) => { state.keywordPlanner.pronostico.currencyCode = e.target.value.toUpperCase(); });

  document.querySelectorAll('[data-opp-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.oppSort;
      const s = state.opportunity;
      if (s.sortBy === key) s.sortDir = s.sortDir === 'desc' ? 'asc' : 'desc';
      else { s.sortBy = key; s.sortDir = 'desc'; }
      render();
    });
  });

  document.querySelectorAll('[data-neg-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.negSort;
      const s = state.neg;
      if (s.sortBy === key) s.sortDir = s.sortDir === 'desc' ? 'asc' : 'desc';
      else { s.sortBy = key; s.sortDir = key === 'term' ? 'asc' : 'desc'; }
      render();
    });
  });

  // Proyección de ventas
  const forecastFileInput = document.getElementById('forecast-file');
  if (forecastFileInput) forecastFileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    state.forecast.status = 'loading'; state.forecast.error = null; state.forecast.fileName = file.name;
    render();
    readFileAsCsvText(file).then((text) => runForecastAnalysis(text, file.name))
      .catch((err) => { state.forecast.status = 'error'; state.forecast.error = err.message || String(err); render(); });
  });

  const forecastHotelFilter = document.getElementById('forecast-hotel-filter');
  if (forecastHotelFilter) forecastHotelFilter.addEventListener('change', (e) => {
    state.forecast.hotelFilter = e.target.value;
    state.forecast.excludedPeriods = [];
    render();
  });

  document.querySelectorAll('[data-forecast-details]').forEach((d) => d.addEventListener('toggle', () => {
    state.forecast.open[d.dataset.forecastDetails] = d.open;
  }));
  document.querySelectorAll('[data-forecast-exclude]').forEach((btn) => btn.addEventListener('click', () => {
    const p = btn.dataset.forecastExclude;
    if (!state.forecast.excludedPeriods.includes(p)) state.forecast.excludedPeriods = [...state.forecast.excludedPeriods, p];
    render();
  }));
  document.querySelectorAll('[data-forecast-restore]').forEach((btn) => btn.addEventListener('click', () => {
    state.forecast.excludedPeriods = state.forecast.excludedPeriods.filter((p) => p !== btn.dataset.forecastRestore);
    render();
  }));
  document.querySelectorAll('[data-forecast-restore-all]').forEach((btn) => btn.addEventListener('click', () => {
    state.forecast.excludedPeriods = [];
    render();
  }));

  const forecastGrowthGoal = document.getElementById('forecast-growth-goal');
  // 'change' (no 'input') a propósito: re-renderizar en cada tecla reconstruye
  // el DOM y le hace perder el foco al campo mientras se escribe. Con
  // 'change' el recálculo pasa al salir del campo (blur, tab, o flechas).
  if (forecastGrowthGoal) forecastGrowthGoal.addEventListener('change', (e) => {
    state.forecast.growthGoalPct = e.target.value;
    render();
  });

  const forecastInvestmentFileInput = document.getElementById('forecast-investment-file');
  if (forecastInvestmentFileInput) forecastInvestmentFileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    readFileAsCsvText(file).then((text) => runForecastInvestmentAnalysis(text, file.name))
      .catch((err) => { state.forecast.investmentError = err.message || String(err); render(); });
  });

  // Tooltips del gráfico de Proyección de ventas — hover muestra los datos
  // de ese mes (real/ajuste, o proyección/rango/inversión/meta según el mes).
  document.querySelectorAll('.forecast-hover-col').forEach((col) => {
    const chartWrap = col.closest('div');
    const svg = col.closest('svg');
    const tooltip = chartWrap ? chartWrap.querySelector('.forecast-tooltip') : null;
    const guide = svg ? svg.querySelector('.forecast-hover-guide') : null;
    if (!tooltip || !guide) return;
    col.addEventListener('mouseenter', () => {
      tooltip.textContent = col.dataset.tooltip;
      tooltip.style.display = 'block';
      const svgRect = svg.getBoundingClientRect();
      const svgX = parseFloat(col.dataset.x);
      const leftPx = (svgX / svg.viewBox.baseVal.width) * svgRect.width;
      tooltip.style.left = `${leftPx}px`;
      guide.setAttribute('x1', col.dataset.x);
      guide.setAttribute('x2', col.dataset.x);
      guide.style.opacity = '1';
    });
    col.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
      guide.style.opacity = '0';
    });
  });

  // Negativización — pestaña "Con IA"
  ['marca', 'destino', 'ofrece', 'no_ofrece'].forEach((key) => {
    const el = document.getElementById(`neg-ai-${key}`);
    if (el) el.addEventListener('input', (e) => { state.neg.ai.ctx[key] = e.target.value; });
  });
  const negAiIncludePmax = document.getElementById('neg-ai-include-pmax');
  if (negAiIncludePmax) negAiIncludePmax.addEventListener('change', (e) => { state.neg.ai.includePmax = e.target.checked; });
  const negAiFile = document.getElementById('neg-ai-file');
  if (negAiFile) negAiFile.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    state.neg.ai.rowsStatus = 'loading'; state.neg.ai.rowsError = null;
    render();
    const reader = new FileReader();
    reader.onload = () => {
      try { negAiSetRows(engine.loadSearchTerms(decodeFileText(reader.result)), file.name, ''); state.neg.ai.currency = ''; }
      catch (err) { state.neg.ai.rowsStatus = 'idle'; state.neg.ai.rowsError = (err && err.message) || 'No se pudo leer el archivo.'; render(); }
    };
    reader.onerror = () => { state.neg.ai.rowsStatus = 'idle'; state.neg.ai.rowsError = 'No se pudo leer el archivo.'; render(); };
    reader.readAsArrayBuffer(file);
  });
  document.querySelectorAll('[data-neg-ai-hist-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.negAiHistOpen);
      const open = state.neg.ai.hist.open;
      if (open.has(id)) open.delete(id); else open.add(id);
      render();
    });
  });
  document.querySelectorAll('[data-neg-ai-undo]').forEach((btn) => {
    btn.addEventListener('click', () => undoNegAiUpload(Number(btn.dataset.negAiUndo), true));
  });
  document.querySelectorAll('[data-neg-ai-undo-confirm]').forEach((btn) => {
    btn.addEventListener('click', () => undoNegAiUpload(Number(btn.dataset.negAiUndoConfirm), false));
  });
  document.querySelectorAll('[data-neg-ai-group]').forEach((box) => {
    box.indeterminate = box.dataset.state === 'some';
    box.addEventListener('change', () => {
      const ai = state.neg.ai;
      const [kind, idx] = box.dataset.negAiGroup.split(':');
      const g = negAiTermGroups(kind, ai.result, !!ai.customerId)[Number(idx)];
      if (!g) return;
      // Si ya estaban todos marcados se quitan; en cualquier otro caso se marcan los seguros del grupo.
      const allMarked = g.seguros.length > 0 && g.seguros.every((t) => ai.selected.has(`${kind}:${t.key}`));
      g.seguros.forEach((t) => { if (allMarked) ai.selected.delete(`${kind}:${t.key}`); else ai.selected.add(`${kind}:${t.key}`); });
      if (ai.push.status !== 'idle') ai.push = { status: 'idle', preview: null, result: null, error: null };
      render();
    });
  });
  document.querySelectorAll('[data-neg-ai-sel]').forEach((box) => {
    box.addEventListener('change', () => {
      const ai = state.neg.ai;
      if (box.checked) ai.selected.add(box.dataset.negAiSel); else ai.selected.delete(box.dataset.negAiSel);
      if (ai.push.status !== 'idle') ai.push = { status: 'idle', preview: null, result: null, error: null };
      render();
    });
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

  const negApiAccount = document.getElementById('neg-api-account');
  if (negApiAccount) negApiAccount.addEventListener('change', (e) => { state.neg.api.accountId = e.target.value; });
  const negApiAccountManual = document.getElementById('neg-api-account-manual');
  if (negApiAccountManual) negApiAccountManual.addEventListener('input', (e) => { state.neg.api.accountIdManual = e.target.value; });
  const negMccFilter = document.getElementById('neg-mcc-filter');
  if (negMccFilter) negMccFilter.addEventListener('input', (e) => { state.neg.api.mcc.filter = e.target.value; render(); });
  document.querySelectorAll('[data-neg-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => applyNegMccFilter(btn.dataset.negMccPick, btn.dataset.negMccPickName));
  });
  const negApiPeriod = document.getElementById('neg-api-period');
  if (negApiPeriod) negApiPeriod.addEventListener('change', (e) => {
    negApplyPeriod(e.target.value);
    render();
  });
  const negApiDateFrom = document.getElementById('neg-api-date-from');
  if (negApiDateFrom) negApiDateFrom.addEventListener('change', (e) => { state.neg.api.dateFrom = e.target.value; });
  const negApiDateTo = document.getElementById('neg-api-date-to');
  if (negApiDateTo) negApiDateTo.addEventListener('change', (e) => { state.neg.api.dateTo = e.target.value; });

  const negCampaignFilter = document.getElementById('neg-campaign-filter');
  if (negCampaignFilter) negCampaignFilter.addEventListener('change', (e) => {
    state.neg.campaignFilter = e.target.value;
    // La selección y el estado de subida (idle/preview_ready/done/...) son
    // de la campaña anterior — sin este reset, después de subir negativos
    // en una campaña y cambiar a otra, el botón "Vista previa" se quedaba
    // oculto porque el estado seguía en "done" en vez de volver a "idle".
    state.neg.push.selected = new Set();
    state.neg.push.status = 'idle';
    state.neg.push.preview = null;
    state.neg.push.result = null;
    state.neg.push.error = null;
    render();
  });

  document.querySelectorAll('.neg-push-checkbox').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const key = e.target.dataset.key;
      if (e.target.checked) state.neg.push.selected.add(key);
      else state.neg.push.selected.delete(key);
      render();
    });
  });

  // Generador de copys
  const copyUrlInput = document.getElementById('copy-url');
  if (copyUrlInput) copyUrlInput.addEventListener('input', (e) => { state.copy.url = e.target.value; });
  const copyHtmlPasteInput = document.getElementById('copy-html-paste');
  if (copyHtmlPasteInput) copyHtmlPasteInput.addEventListener('input', (e) => { state.copy.htmlPaste = e.target.value; });
  const copyAiLang = document.getElementById('copy-ai-lang');
  if (copyAiLang) copyAiLang.addEventListener('change', (e) => { state.copy.ai.lang = e.target.value; });
  const copyAiKeywords = document.getElementById('copy-ai-keywords');
  if (copyAiKeywords) copyAiKeywords.addEventListener('input', (e) => { state.copy.ai.keywords = e.target.value; });
  document.querySelectorAll('[data-copy-ai-copy]').forEach((b) => b.addEventListener('click', () => copyAiCopy(b.dataset.copyAiCopy)));
  document.querySelectorAll('[data-copy-ai-csv]').forEach((b) => b.addEventListener('click', () => copyAiCsv(b.dataset.copyAiCsv)));

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

  ['current', 'previous'].forEach((which) => {
    const input = document.getElementById(`book-compare-${which}-file`);
    if (!input) return;
    input.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const slot = state.book.compare[which];
      slot.status = 'loading'; slot.error = null; slot.fileName = file.name;
      render();
      const isExcel = /\.(xlsx|xls)$/i.test(file.name);
      const onError = (err) => { slot.status = 'error'; slot.error = err.message || String(err); render(); };
      if (isExcel) {
        readExcelRows(file).then((rows2D) => runBookCompareAnalysisFromRows(which, rows2D, file.name)).catch(onError);
      } else {
        readFileAsCsvText(file).then((text) => runBookCompareAnalysisFromText(which, text, file.name)).catch(onError);
      }
    });
  });
  const bookCompareMarketFilter = document.getElementById('book-compare-market-filter');
  if (bookCompareMarketFilter) bookCompareMarketFilter.addEventListener('change', (e) => {
    state.book.compare.marketFilter = e.target.value;
    render();
  });
  const bookCompareHotelFilter = document.getElementById('book-compare-hotel-filter');
  if (bookCompareHotelFilter) bookCompareHotelFilter.addEventListener('change', (e) => {
    state.book.compare.hotelFilter = e.target.value;
    render();
  });
  // Ritmo de consumo
  const pacingAccountSelect = document.getElementById('pacing-account-select');
  if (pacingAccountSelect) pacingAccountSelect.addEventListener('change', (e) => {
    state.pacing.accountToAdd = e.target.value;
    render();
  });
  const pacingHotelToggle = document.getElementById('pacing-hotel-toggle');
  if (pacingHotelToggle) pacingHotelToggle.addEventListener('click', () => {
    state.pacing.hotelMenuOpen = !state.pacing.hotelMenuOpen;
    render();
  });
  document.querySelectorAll('[data-pacing-hotel]').forEach((box) => {
    box.addEventListener('change', () => {
      const f = state.pacing.hotelFilter;
      const id = box.dataset.pacingHotel;
      state.pacing.hotelFilter = box.checked ? [...f, id] : f.filter((x) => x !== id);
      render();
    });
  });
  const pacingHotelAll = document.querySelector('[data-pacing-hotel-all]');
  if (pacingHotelAll) pacingHotelAll.addEventListener('change', () => {
    state.pacing.hotelFilter = [];
    render();
  });
  document.querySelectorAll('[data-pacing-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removePacingWatchlistAccount(btn.dataset.pacingRemove));
  });
  const applyPacingMonths = () => {
    const cur = currentMonthValue();
    const fromEl = document.getElementById('pacing-month-from');
    const toEl = document.getElementById('pacing-month-to');
    let from = fromEl.value || cur;
    let to = toEl.value || cur;
    if (from > to) { if (document.activeElement === toEl) from = to; else to = from; }
    state.pacing.monthFrom = (from === cur && to === cur) ? '' : from;
    state.pacing.monthTo = (from === cur && to === cur) ? '' : to;
    loadPacingRows();
  };
  ['pacing-month-from', 'pacing-month-to'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', applyPacingMonths);
  });
  document.querySelectorAll('[data-pacing-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.pacingSort;
      const p = state.pacing;
      if (p.sortBy === key) p.sortDir = p.sortDir === 'desc' ? 'asc' : 'desc';
      else { p.sortBy = key; p.sortDir = 'desc'; }
      render();
    });
  });
  const pacingMccFilter = document.getElementById('pacing-mcc-filter');
  if (pacingMccFilter) pacingMccFilter.addEventListener('input', (e) => {
    state.pacing.mcc.filter = e.target.value;
    render();
  });
  document.querySelectorAll('[data-pacing-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => addPacingMccGroup(btn.dataset.pacingMccPick, btn.dataset.pacingMccPickName));
  });
  document.querySelectorAll('[data-pacing-campaigns-open]').forEach((btn) => {
    btn.addEventListener('click', () => openPacingCampaignsModal(btn.dataset.pacingCampaignsOpen, btn.dataset.pacingCampaignsOpenName));
  });
  const pacingCampaignsOverlay = document.querySelector('.pacing-campaigns-overlay');
  if (pacingCampaignsOverlay) pacingCampaignsOverlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-modal-stop-propagation]')) return;
    closePacingCampaignsModal();
  });
  const pacingBudgetAdjustInput = document.getElementById('pacing-budget-adjust-input');
  if (pacingBudgetAdjustInput) pacingBudgetAdjustInput.addEventListener('input', (e) => {
    state.pacing.campaignsModal.adjust.newBudget = e.target.value;
  });
  document.querySelectorAll('[data-action="pacing-budget-edit-start"]').forEach((btn) => {
    btn.addEventListener('click', () => startPacingBudgetEdit(btn.dataset.budget));
  });
  document.querySelectorAll('[data-pacing-roas-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => togglePacingRoasReveal(btn.dataset.pacingRoasToggle));
  });
  // Auditoría de cuenta
  const auditAccount = document.getElementById('audit-account');
  if (auditAccount) auditAccount.addEventListener('change', (e) => { state.audit.api.accountId = e.target.value; });
  const auditAccountManual = document.getElementById('audit-account-manual');
  if (auditAccountManual) auditAccountManual.addEventListener('input', (e) => { state.audit.api.accountIdManual = e.target.value; });
  const auditDays = document.getElementById('audit-days');
  if (auditDays) auditDays.addEventListener('change', (e) => { state.audit.api.days = Number(e.target.value); });
  const auditMccFilter = document.getElementById('audit-mcc-filter');
  if (auditMccFilter) auditMccFilter.addEventListener('input', (e) => { state.audit.api.mcc.filter = e.target.value; render(); });
  document.querySelectorAll('[data-audit-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => applyAuditMccFilter(btn.dataset.auditMccPick, btn.dataset.auditMccPickName));
  });
  document.querySelectorAll('[data-audit-ctx]').forEach((el) => {
    const field = el.dataset.auditCtx;
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', (e) => {
      state.audit.ctx[field] = e.target.value;
      if (field === 'goal') render(); // cambia la etiqueta y si hay campo de meta
    });
  });
  // Administración
  const adminGrantUser = document.getElementById('admin-grant-user');
  if (adminGrantUser) adminGrantUser.addEventListener('change', (e) => { state.admin.grant.userId = e.target.value; });
  const adminGrantAccountFilter = document.getElementById('admin-grant-account-filter');
  if (adminGrantAccountFilter) adminGrantAccountFilter.addEventListener('input', (e) => {
    state.admin.grant.accountFilter = e.target.value;
    render();
  });
  const adminGrantCustomerId = document.getElementById('admin-grant-customer-id');
  if (adminGrantCustomerId) adminGrantCustomerId.addEventListener('input', (e) => { state.admin.grant.customerId = e.target.value; });
  const adminGrantAccountName = document.getElementById('admin-grant-account-name');
  if (adminGrantAccountName) adminGrantAccountName.addEventListener('input', (e) => { state.admin.grant.accountName = e.target.value; });

  const adminMccGrantUser = document.getElementById('admin-mcc-grant-user');
  if (adminMccGrantUser) adminMccGrantUser.addEventListener('change', (e) => { state.admin.mccGrant.userId = e.target.value; });
  const adminMccFilter = document.getElementById('admin-mcc-filter');
  if (adminMccFilter) adminMccFilter.addEventListener('input', (e) => {
    state.admin.mccGrant.filter = e.target.value;
    render();
  });
  document.querySelectorAll('[data-admin-mcc-pick]').forEach((btn) => {
    btn.addEventListener('click', () => pickAdminMcc(btn.dataset.adminMccPick, btn.dataset.adminMccPickName));
  });
  document.querySelectorAll('[data-admin-mcc-revoke-user]').forEach((btn) => {
    btn.addEventListener('click', () => revokeAdminMcc(Number(btn.dataset.adminMccRevokeUser), btn.dataset.adminMccRevokeId));
  });
  document.querySelectorAll('[data-admin-pick-account]').forEach((btn) => {
    btn.addEventListener('click', () => pickAdminGrantAccount(btn.dataset.adminPickAccount, btn.dataset.adminPickName));
  });
  document.querySelectorAll('[data-admin-delete-user]').forEach((btn) => {
    btn.addEventListener('click', () => deleteAdminUser(btn.dataset.adminDeleteUser));
  });
  document.querySelectorAll('[data-admin-reset-password]').forEach((btn) => {
    btn.addEventListener('click', () => resetUserPassword(Number(btn.dataset.adminResetPassword), btn.dataset.adminResetUsername));
  });
  document.querySelectorAll('[data-admin-set-admin]').forEach((btn) => {
    btn.addEventListener('click', () => setAdminRole(Number(btn.dataset.adminSetAdmin), btn.dataset.adminSetAdminUsername, btn.dataset.adminSetAdminValue === '1'));
  });
  document.querySelectorAll('[data-admin-revoke-user]').forEach((btn) => {
    btn.addEventListener('click', () => revokeAdminAccess(Number(btn.dataset.adminRevokeUser), btn.dataset.adminRevokeCustomer));
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

    case 'camp-refresh': loadCampanas(); break;
    case 'camp-detail-close': closeCampanaDetail(); break;
    case 'camp-html': downloadCampanasHtml(); break;
    case 'camp-detail-html': downloadCampanaDetailHtml(); break;
    case 'camp-go-pacing': state.page = 'pacing'; render(); break;
    case 'cambios-load': loadCambios(); break;
    case 'cambios-more': state.cambios.limit += CAMBIOS_PAGE_SIZE; render(); break;
    case 'cambios-csv': downloadCambiosCsv(); break;
    case 'cambios-html': downloadCambiosHtml(); break;
    case 'rend-source-file': state.rend.source = 'file'; render(); break;
    case 'rend-source-api': {
      state.rend.source = 'api';
      ensureGoogleAdsStatusLoaded();
      render();
      break;
    }
    case 'rend-api-load-accounts': loadGoogleAdsAccounts(); break;
    case 'rend-mcc-load': loadRendMccGroups(); break;
    case 'rend-mcc-clear': clearRendMccFilter(); break;
    case 'rend-api-fetch': fetchGoogleAdsCampaigns(); break;
    case 'rend-ai-analizar': runAiAnalysis(); break;
    case 'pwchange-submit': submitPasswordChange(); break;
    case 'admin-reset-password-dismiss': state.admin.resetPassword = { status: 'idle', error: null, result: null }; render(); break;

    case 'compare-demo': {
      state.compare.current.status = 'loading'; state.compare.current.error = null; state.compare.current.fileName = 'sample_data_actual.csv';
      state.compare.previous.status = 'loading'; state.compare.previous.error = null; state.compare.previous.fileName = 'sample_data_anterior.csv';
      render();
      setTimeout(() => {
        runCompareAnalysis('current', engine.SAMPLE_CAMPAIGN_CSV, 'sample_data_actual.csv');
        runCompareAnalysis('previous', engine.SAMPLE_CAMPAIGN_CSV_PREVIOUS, 'sample_data_anterior.csv');
      }, 250);
      break;
    }
    case 'compare-source-file': state.compare.source = 'file'; render(); break;
    case 'compare-source-api': {
      state.compare.source = 'api';
      ensureCompareGoogleAdsStatusLoaded();
      render();
      break;
    }
    case 'compare-api-load-accounts': loadCompareGoogleAdsAccounts(); break;
    case 'compare-mcc-load': loadCompareMccGroups(); break;
    case 'compare-mcc-clear': clearCompareMccFilter(); break;
    case 'compare-api-fetch': fetchCompareGoogleAdsCampaigns(); break;

    case 'opp-demo': {
      state.opportunity.status = 'loading'; state.opportunity.error = null; state.opportunity.fileName = 'sample_data_oportunidad.csv';
      render();
      setTimeout(() => runOpportunityAnalysis(engine.SAMPLE_CAMPAIGN_CSV_OPPORTUNITY, 'sample_data_oportunidad.csv'), 250);
      break;
    }
    case 'opp-source-file': state.opportunity.source = 'file'; render(); break;
    case 'opp-source-api': {
      state.opportunity.source = 'api';
      ensureOpportunityGoogleAdsStatusLoaded();
      render();
      break;
    }
    case 'opp-api-load-accounts': loadOpportunityGoogleAdsAccounts(); break;
    case 'opp-mcc-load': loadOppMccGroups(); break;
    case 'opp-mcc-clear': clearOppMccFilter(); break;
    case 'opp-api-fetch': fetchOpportunityGoogleAdsCampaigns(); break;
    case 'opp-acct-all': {
      const a = state.opportunity.api;
      const mccOn = a.mcc.selectedId && a.mcc.accountIds;
      const pool = mccOn ? a.accounts.filter((acc) => a.mcc.accountIds.has(acc.id)) : a.accounts;
      const q = (a.accountSearch || '').trim().toLowerCase();
      const vis = q ? pool.filter((acc) => `${acc.name} ${acc.id}`.toLowerCase().includes(q)) : pool;
      if (vis.length && vis.length <= OPP_MAX_ACCOUNTS) a.accountIds = [...new Set([...a.accountIds, ...vis.map((acc) => acc.id)])].slice(0, OPP_MAX_ACCOUNTS);
      render();
      break;
    }
    case 'opp-acct-none': state.opportunity.api.accountIds = []; render(); break;
    case 'cmp-acct-all': {
      const api = state.compare.api;
      const mccOn = api.mcc.selectedId && api.mcc.accountIds;
      const pool = mccOn ? api.accounts.filter((acc) => api.mcc.accountIds.has(acc.id)) : api.accounts;
      const q = (api.accountSearch || '').trim().toLowerCase();
      const vis = q ? pool.filter((acc) => `${acc.name} ${acc.id}`.toLowerCase().includes(q)) : pool;
      if (vis.length && vis.length <= OPP_MAX_ACCOUNTS) api.accountIds = [...new Set([...api.accountIds, ...vis.map((acc) => acc.id)])].slice(0, OPP_MAX_ACCOUNTS);
      render();
      break;
    }
    case 'cmp-acct-none': state.compare.api.accountIds = []; render(); break;
    case 'opp-download': downloadOpportunityResult(); break;
    case 'opp-download-html': downloadOpportunityHtml(); break;

    case 'roas-api-load-accounts': loadRoasGoogleAdsAccounts(); break;
    case 'roas-mcc-load': loadRoasMccGroups(); break;
    case 'roas-mcc-clear': clearRoasMccFilter(); break;
    case 'roas-api-fetch': fetchRoasByCampaign(); break;
    case 'roas-edit-cancel': {
      state.roas.adjust = { campaignId: null, newTargetRoas: '', status: 'idle', preview: null, result: null, error: null };
      render();
      break;
    }
    case 'roas-edit-preview': adjustRoasTarget(true); break;
    case 'roas-edit-confirm': adjustRoasTarget(false); break;

    case 'recs-api-load-accounts': loadRecsGoogleAdsAccounts(); break;
    case 'recs-mcc-load': loadRecsMccGroups(); break;
    case 'recs-mcc-clear': clearRecsMccFilter(); break;
    case 'recs-api-fetch': fetchRecommendations(); break;

    case 'iamax-api-load-accounts': loadIaMaxGoogleAdsAccounts(); break;
    case 'iamax-mcc-load': loadIaMaxMccGroups(); break;
    case 'iamax-mcc-clear': clearIaMaxMccFilter(); break;
    case 'iamax-api-fetch': fetchIaMaxStatus(); break;
    case 'iamax-toggle-cancel': {
      state.iamax.toggle = { campaignId: null, status: 'idle', newEnable: null, preview: null, result: null, error: null };
      render();
      break;
    }
    case 'iamax-toggle-preview': toggleAiMax(true); break;
    case 'iamax-toggle-confirm': toggleAiMax(false); break;
    case 'iamax-served-fetch': fetchIaMaxServed(); break;
    case 'iamax-tab-estado': state.iamax.tab = 'estado'; render(); break;
    case 'iamax-tab-servido': state.iamax.tab = 'servido'; render(); break;
    case 'iamax-tab-creado': state.iamax.tab = 'creado'; render(); break;
    case 'iamax-tab-excluir': openIaMaxExcluirTab(); break;
    case 'iamax-urlx-reload': loadIaMaxUrlExclusions(); break;
    case 'iamax-urlx-add-paste': addIaMaxPasteToDraft(); break;
    case 'iamax-urlx-clear-draft': state.iamax.urlx.draft = []; resetIaMaxUrlxFlow(); render(); break;
    case 'iamax-urlx-preview': submitIaMaxUrlExclusions(true); break;
    case 'iamax-urlx-apply': submitIaMaxUrlExclusions(false); break;
    case 'iamax-urlx-flow-reset': resetIaMaxUrlxFlow(); render(); break;
    case 'iamax-urlx-remove-confirm': confirmIaMaxUrlxRemove(); break;
    case 'iamax-urlx-remove-cancel': state.iamax.urlx.remove = { pending: null, status: 'idle', error: null }; render(); break;
    case 'iamax-pages-exclude': sendSelectedPagesToExclude(); break;
    case 'iamax-created-fetch': fetchIaMaxCreated(); break;
    case 'iamax-created-sub-assets': state.iamax.created.sub = 'assets'; render(); break;
    case 'iamax-created-sub-combinations': state.iamax.created.sub = 'combinations'; render(); break;
    case 'iamax-created-sub-pages': state.iamax.created.sub = 'pages'; render(); break;
    case 'iamax-created-csv': downloadIaMaxCreatedCsv(); break;
    case 'iamax-tab-cruce': state.iamax.tab = 'cruce'; render(); break;
    case 'hotel-api-load-accounts': loadHotelGoogleAdsAccounts(); break;
    case 'hotel-mcc-load': loadHotelMccGroups(); break;
    case 'hotel-mcc-clear': clearHotelMccFilter(); break;
    case 'hotel-api-fetch': fetchHotelCampaigns(); break;
    case 'hotel-back': {
      const d = state.hotel.detail;
      d.campaignId = null; d.status = 'idle'; d.data = null; d.edits = {}; d.ai = null; d.note = null;
      d.flow = { status: 'idle', preview: null, result: null, error: null };
      render();
      break;
    }
    case 'hotel-note-run': runHotelNote(); break;
    case 'hotel-note-copy': copyHotelNote(); break;
    case 'hotel-ai-run': runHotelAi(); break;
    case 'hotel-ai-use': hotelAiToEditor(); break;
    case 'hotel-preview': submitHotelModifiers(true); break;
    case 'hotel-confirm': submitHotelModifiers(false); break;
    case 'hotel-cancel': {
      const d = state.hotel.detail;
      d.edits = {};
      d.flow = { status: 'idle', preview: null, result: null, error: null };
      render();
      break;
    }

    case 'exclusiones-api-load-accounts': loadContentExclusionsGoogleAdsAccounts(); break;
    case 'exclusiones-mcc-load': loadExclusionesMccGroups(); break;
    case 'exclusiones-mcc-clear': clearExclusionesMccFilter(); break;
    case 'exclusiones-api-fetch': fetchContentExclusions(); break;

    case 'exclusiones-labels-preview': addContentLabelExclusions(true); break;
    case 'exclusiones-labels-confirm': addContentLabelExclusions(false); break;
    case 'exclusiones-labels-cancel': {
      state.contentExclusions.addLabels.status = 'idle';
      state.contentExclusions.addLabels.preview = null;
      state.contentExclusions.addLabels.error = null;
      render();
      break;
    }

    case 'exclusiones-app-select-all': {
      const s = state.contentExclusions;
      const p = s.addApp;
      const excludedResources = new Set((s.appCategories || []).map((a) => a.category_constant));
      const filterLower = (p.filter || '').toLowerCase();
      const available = (s.appCategoriesCatalog || []).filter((c) => !excludedResources.has(c.resource_name) && (!filterLower || c.name.toLowerCase().includes(filterLower)));
      p.selected = new Set(available.map((c) => c.resource_name));
      render();
      break;
    }
    case 'exclusiones-app-select-none': state.contentExclusions.addApp.selected = new Set(); render(); break;
    case 'exclusiones-app-preview': addAppCategoryExclusions(true); break;
    case 'exclusiones-app-confirm': addAppCategoryExclusions(false); break;
    case 'exclusiones-app-cancel': {
      state.contentExclusions.addApp.status = 'idle';
      state.contentExclusions.addApp.preview = null;
      state.contentExclusions.addApp.error = null;
      render();
      break;
    }

    case 'exclusiones-remove-preview': removeContentExclusion(true); break;
    case 'exclusiones-remove-confirm': removeContentExclusion(false); break;
    case 'exclusiones-remove-cancel': {
      state.contentExclusions.remove = { resourceName: null, status: 'idle', error: null, preview: null, result: null };
      render();
      break;
    }

    case 'kwp-api-load-accounts': loadKeywordPlannerAccounts(); break;
    case 'kwp-mcc-load': loadKwpMccGroups(); break;
    case 'kwp-mcc-clear': clearKwpMccFilter(); break;

    case 'pacing-load-accounts': loadPacingAccounts(); break;
    case 'pacing-mcc-load': loadPacingMccGroups(); break;
    case 'pacing-clear-watchlist': clearPacingWatchlist(); break;
    case 'pacing-month-current': state.pacing.monthFrom = ''; state.pacing.monthTo = ''; loadPacingRows(); break;
    case 'pacing-campaigns-close': closePacingCampaignsModal(); break;
    case 'pacing-budget-edit-preview': adjustPacingCampaignBudget(true); break;
    case 'pacing-budget-edit-confirm': adjustPacingCampaignBudget(false); break;
    case 'pacing-budget-edit-cancel': cancelPacingBudgetEdit(); break;
    case 'pacing-add-account': addPacingWatchlistAccount(); break;
    case 'kwp-geo-search': searchKeywordPlannerGeo(); break;
    case 'kwp-network-search': state.keywordPlanner.network = 'GOOGLE_SEARCH'; render(); break;
    case 'kwp-network-partners': state.keywordPlanner.network = 'GOOGLE_SEARCH_AND_PARTNERS'; render(); break;
    case 'kwp-tab-ideas': state.keywordPlanner.tab = 'ideas'; render(); break;
    case 'kwp-tab-historico': state.keywordPlanner.tab = 'historico'; render(); break;
    case 'kwp-tab-pronostico': state.keywordPlanner.tab = 'pronostico'; render(); break;
    case 'kwp-ideas-fetch': fetchKeywordIdeas(); break;
    case 'kwp-historico-fetch': fetchKeywordHistorical(); break;
    case 'kwp-historico-close': state.keywordPlanner.historico.modalKeyword = null; render(); break;
    case 'kwp-pronostico-fetch': fetchKeywordForecast(); break;

    case 'download-kwp-ideas': {
      const rows = getKeywordIdeasSorted();
      const header = ['Keyword', 'Búsquedas prom./mes', 'Competencia', 'Índice', 'Puja baja', 'Puja alta'];
      const data = [header, ...rows.map((r) => [
        r.text, r.avg_monthly_searches || 0, KWP_COMPETITION_LABELS[r.competition] || 'N/D',
        r.competition_index ?? 'N/D',
        r.low_top_of_page_bid_micros !== null && r.low_top_of_page_bid_micros !== undefined ? (r.low_top_of_page_bid_micros / 1_000_000).toFixed(2) : 'N/D',
        r.high_top_of_page_bid_micros !== null && r.high_top_of_page_bid_micros !== undefined ? (r.high_top_of_page_bid_micros / 1_000_000).toFixed(2) : 'N/D',
      ])];
      engine.downloadCsv('keyword_planner_ideas.csv', data);
      break;
    }
    case 'download-kwp-historico': {
      const rows = getKeywordHistoricoSorted();
      const months = (rows[0] && rows[0].monthly_search_volumes) || [];
      const monthHeaders = months.map((v) => `${KWP_MONTH_LABELS[v.month] || v.month} ${v.year}`);
      const header = ['Keyword', 'Búsquedas prom./mes', 'Competencia', 'Puja baja', 'Puja alta', ...monthHeaders];
      const data = [header, ...rows.map((r) => [
        r.text, r.avg_monthly_searches || 0, KWP_COMPETITION_LABELS[r.competition] || 'N/D',
        r.low_top_of_page_bid_micros !== null && r.low_top_of_page_bid_micros !== undefined ? (r.low_top_of_page_bid_micros / 1_000_000).toFixed(2) : 'N/D',
        r.high_top_of_page_bid_micros !== null && r.high_top_of_page_bid_micros !== undefined ? (r.high_top_of_page_bid_micros / 1_000_000).toFixed(2) : 'N/D',
        ...(r.monthly_search_volumes || []).map((v) => v.monthly_searches ?? 0),
      ])];
      engine.downloadCsv('keyword_planner_historico.csv', data);
      break;
    }
    case 'download-kwp-pronostico': {
      const p = state.keywordPlanner.pronostico;
      const r = p.result;
      if (!r) break;
      const header = ['Métrica', 'Valor'];
      const moneyOrNA = (micros) => (micros === null || micros === undefined) ? 'N/D' : (micros / 1_000_000).toFixed(2);
      const data = [
        header,
        ['Keywords', kwpParseKeywords(p.keywordsText).join(' | ')],
        ['Concordancia', p.matchType],
        ['Estrategia de puja', p.biddingMode],
        ['Desde', p.startDate],
        ['Hasta', p.endDate],
        ['Clics', r.clicks ?? 'N/D'],
        ['Costo', moneyOrNA(r.cost_micros)],
        ['Conversiones', r.conversions ?? 'N/D'],
        ['CPC promedio', moneyOrNA(r.average_cpc_micros)],
        ['CPA promedio', moneyOrNA(r.average_cpa_micros)],
      ];
      engine.downloadCsv('keyword_planner_pronostico.csv', data);
      break;
    }

    case 'forecast-demo': {
      state.forecast.status = 'loading'; state.forecast.error = null; state.forecast.fileName = 'ingresos_ejemplo.csv';
      render();
      setTimeout(() => runForecastAnalysis(engine.SAMPLE_REVENUE_CSV, 'ingresos_ejemplo.csv'), 250);
      break;
    }
    case 'forecast-horizon-3': state.forecast.monthsAhead = 3; render(); break;
    case 'forecast-horizon-6': state.forecast.monthsAhead = 6; render(); break;
    case 'forecast-horizon-12': state.forecast.monthsAhead = 12; render(); break;
    case 'forecast-roas-recent': state.forecast.roasWindow = 'recent'; render(); break;
    case 'forecast-roas-all': state.forecast.roasWindow = 'all'; render(); break;
    case 'forecast-investment-demo': runForecastInvestmentAnalysis(engine.SAMPLE_INVESTMENT_CSV, 'inversion_ejemplo.csv'); break;
    case 'download-forecast-html': downloadForecastHtml(); break;
    case 'download-forecast': {
      let model;
      try { model = buildForecastModel(); } catch (err) { break; }
      const { result, investment, investmentByPeriod, goal, goalByPeriod, gapByPeriod, goalVsPriorByPeriod, goalInvestmentByPeriod } = model;
      const header = ['Mes', 'Proyección', 'Rango bajo', 'Rango alto', 'Mismo mes año pasado', 'Var. % vs. año pasado'];
      if (investment) header.push('Inversión necesaria');
      if (goal) header.push('Meta', 'Meta vs. año pasado', 'Brecha vs. proyección');
      if (goalInvestmentByPeriod) header.push('Inversión para la meta');
      const data = [header, ...result.forecast.map((f) => {
        const row = [f.period, f.value.toFixed(2), f.low.toFixed(2), f.high.toFixed(2),
          f.prior !== null ? f.prior.toFixed(2) : '', f.yoyPct !== null ? (f.yoyPct * 100).toFixed(1) + '%' : ''];
        if (investment) row.push((investmentByPeriod.get(f.period) || 0).toFixed(2));
        if (goal) {
          row.push(goalByPeriod.get(f.period) != null ? goalByPeriod.get(f.period).toFixed(2) : '');
          row.push(goalVsPriorByPeriod.get(f.period) != null ? (goalVsPriorByPeriod.get(f.period) * 100).toFixed(1) + '%' : '');
          row.push(gapByPeriod.get(f.period) != null ? gapByPeriod.get(f.period).toFixed(2) : '');
        }
        if (goalInvestmentByPeriod) row.push(goalInvestmentByPeriod.get(f.period) != null ? goalInvestmentByPeriod.get(f.period).toFixed(2) : '');
        return row;
      })];
      engine.downloadCsv('proyeccion_ventas.csv', data);
      break;
    }

    case 'neg-demo': {
      state.neg.status = 'loading'; state.neg.error = null; state.neg.fileName = 'negativos_ejemplo.csv';
      // Los cuadros de términos núcleo/excepciones empiezan en blanco (para
      // no arrastrar los de Estelar a otras cuentas) — el botón de ejemplo
      // los rellena con los términos que corresponden a ese dataset de ejemplo.
      if (!state.neg.core.trim()) state.neg.core = 'estelar\nmanzanillo';
      if (!state.neg.exceptions.trim()) state.neg.exceptions = 'manzanillo del mar';
      render();
      setTimeout(() => runNegAnalysis(engine.SAMPLE_SEARCH_TERMS_CSV, 'negativos_ejemplo.csv'), 250);
      break;
    }

    case 'neg-source-file': state.neg.source = 'file'; render(); break;
    case 'neg-source-api': {
      state.neg.source = 'api';
      ensureNegGoogleAdsStatusLoaded();
      render();
      break;
    }
    case 'neg-api-load-accounts': loadNegGoogleAdsAccounts(); break;
    case 'neg-mcc-load': loadNegMccGroups(); break;
    case 'neg-mcc-clear': clearNegMccFilter(); break;
    case 'neg-api-fetch': fetchGoogleAdsSearchTerms(); break;
    case 'neg-tab-reglas': state.neg.tab = 'reglas'; render(); break;
    case 'compare-download-html': downloadTextFile(buildCompareHtml(), compareFileName('html'), 'text/html'); break;
    case 'compare-download-md': downloadTextFile(buildCompareMarkdown(), compareFileName('md'), 'text/markdown'); break;
    case 'admin-ai-usage-7': state.admin.usage.days = 7; loadAdminAiUsage(); break;
    case 'admin-ai-usage-30': state.admin.usage.days = 30; loadAdminAiUsage(); break;
    case 'admin-ai-usage-90': state.admin.usage.days = 90; loadAdminAiUsage(); break;
    case 'neg-tab-ia': state.neg.tab = 'ia'; render(); break;
    case 'neg-ai-fetch': fetchNegAiTerms(); break;
    case 'neg-ai-run': runNegAiAnalysis(); break;
    case 'neg-ai-select-safe': {
      const ai = state.neg.ai;
      ai.selected = new Set();
      negAiAllTemas().forEach((t) => t.negativas.forEach((n) => { if (negAiIsSafeDefault(n)) ai.selected.add(`n:${n.id}`); }));
      ai.push = { status: 'idle', preview: null, result: null, error: null };
      render();
      break;
    }
    case 'neg-ai-select-none': {
      const ai = state.neg.ai;
      ai.selected = new Set(); ai.push = { status: 'idle', preview: null, result: null, error: null };
      render();
      break;
    }
    case 'neg-ai-csv': downloadNegAiCsv(); break;
    case 'neg-ai-view-ia': state.neg.ai.view = 'ia'; render(); break;
    case 'neg-ai-view-palabras': state.neg.ai.view = 'palabras'; render(); break;
    case 'neg-ai-words-run': runNegAiWords(); break;
    case 'neg-ai-hist-reload': {
      const h = state.neg.ai.hist;
      h.undo = { uploadId: null, status: 'idle', preview: null, result: null, error: null };
      loadNegAiHistory(h.customer || negAiCustomerId() || 'simulada');
      break;
    }
    case 'neg-ai-undo-cancel': state.neg.ai.hist.undo = { uploadId: null, status: 'idle', preview: null, result: null, error: null }; render(); break;
    case 'neg-ai-review-select-nonconv': {
      const ai = state.neg.ai;
      ((ai.result && ai.result.revisar) || []).forEach((r) => {
        if (r.conversions === 0 && !r.es_marca && !r.kw_conflicto && (r.campanias.length || !ai.customerId)) ai.selected.add(`r:${r.key}`);
      });
      ai.push = { status: 'idle', preview: null, result: null, error: null };
      render();
      break;
    }
    case 'neg-ai-review-select-none': {
      const ai = state.neg.ai;
      [...ai.selected].filter((k) => k.startsWith('r:')).forEach((k) => ai.selected.delete(k));
      ai.push = { status: 'idle', preview: null, result: null, error: null };
      render();
      break;
    }
    case 'neg-ai-push-preview': pushNegAi(true); break;
    case 'neg-ai-push-confirm': pushNegAi(false); break;
    case 'neg-ai-push-cancel': state.neg.ai.push = { status: 'idle', preview: null, result: null, error: null }; render(); break;

    case 'neg-push-select-all': {
      const candidates = getNegFilteredRows().filter((r) => r.clasificacion === 'negativizar');
      state.neg.push.selected = new Set(candidates.map((r) => `${r.term}::${r.campaign_id}`));
      render();
      break;
    }
    case 'neg-push-select-none': state.neg.push.selected = new Set(); render(); break;
    case 'neg-push-preview': pushNegativeKeywords(true); break;
    case 'neg-push-confirm': pushNegativeKeywords(false); break;
    case 'neg-push-cancel': {
      state.neg.push.status = 'idle'; state.neg.push.preview = null; state.neg.push.error = null;
      render();
      break;
    }
    case 'download-neg-candidatos': {
      const hasCampaign = state.neg.source === 'api';
      const rows = getNegFilteredRows().filter((r) => r.clasificacion === 'negativizar').sort((a, b) => b.cost - a.cost);
      const header = ['Término', ...(hasCampaign ? ['Campaña'] : []), 'Clics', 'Impresiones', 'Costo', 'Conversiones'];
      const data = [header, ...rows.map((r) => [r.term, ...(hasCampaign ? [r.campaign_name || 'N/D'] : []), r.clicks, r.impr, r.cost_na ? 'N/D' : r.cost.toFixed(2), r.conversions || 0])];
      engine.downloadCsv('negativos_candidatos.csv', data);
      break;
    }
    case 'download-neg-revisar': {
      const hasCampaign = state.neg.source === 'api';
      const rows = getNegFilteredRows().filter((r) => r.clasificacion === 'revisar').sort((a, b) => b.cost - a.cost);
      const header = ['Término', ...(hasCampaign ? ['Campaña'] : []), 'Clics', 'Impresiones', 'Costo', 'Conversiones'];
      const data = [header, ...rows.map((r) => [r.term, ...(hasCampaign ? [r.campaign_name || 'N/D'] : []), r.clicks, r.impr, r.cost_na ? 'N/D' : r.cost.toFixed(2), r.conversions || 0])];
      engine.downloadCsv('negativos_revisar.csv', data);
      break;
    }

    case 'copy-analyze-url': onCopyAnalyzeUrl(); break;
    case 'copy-ai-search': generateCopyAi('search'); break;
    case 'copy-ai-pmax': generateCopyAi('pmax'); break;
    case 'copy-ai-dgen': generateCopyAi('dgen'); break;
    case 'copy-ai-youtube': generateCopyAi('youtube'); break;
    case 'copy-ai-meta': generateCopyAi('meta'); break;
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

    case 'book-mode-single': state.book.mode = 'single'; render(); break;
    case 'book-mode-compare': state.book.mode = 'compare'; render(); break;

    case 'book-compare-download-markets-html':
      downloadTextFile(buildBookCompareMarketsHtml(), `bookings_mercados_comparativo_${new Date().toISOString().slice(0, 10)}.html`, 'text/html');
      break;

    case 'book-compare-demo': {
      state.book.compare.current.status = 'loading'; state.book.compare.current.error = null; state.book.compare.current.fileName = 'reservas_actual.csv';
      state.book.compare.previous.status = 'loading'; state.book.compare.previous.error = null; state.book.compare.previous.fileName = 'reservas_anterior.csv';
      render();
      setTimeout(() => {
        runBookCompareAnalysisFromText('current', engine.SAMPLE_BOOKINGS_CSV, 'reservas_actual.csv');
        runBookCompareAnalysisFromText('previous', engine.SAMPLE_BOOKINGS_CSV_PREVIOUS, 'reservas_anterior.csv');
      }, 250);
      break;
    }

    case 'admin-grant-load-accounts': loadAdminGrantAccounts(); break;
    case 'admin-grant-submit': grantAdminAccess(); break;
    case 'audit-load-accounts': loadAuditAccounts(); break;
    case 'audit-run': runAudit(); break;
    case 'audit-history': loadAuditHistoryOnly(); break;
    case 'audit-ai': runAuditAi(); break;
    case 'audit-mcc-load': loadAuditMccGroups(); break;
    case 'audit-mcc-clear': clearAuditMccFilter(); break;
    case 'audit-download-html': downloadTextFile(buildAuditHtml(), auditFileName('html'), 'text/html'); break;
    case 'audit-download-md': downloadTextFile(buildAuditMarkdown(), auditFileName('md'), 'text/markdown'); break;
    case 'admin-mcc-load-groups': loadAdminMccGroups(); break;
    case 'admin-mcc-grant-submit': grantAdminMcc(); break;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.page === 'campanas') closeCampanaDetail();
});

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => { state.page = btn.dataset.nav; render(); });
});

// El servidor ya redirige a /login si no hay sesión al pedir esta página,
// pero esto también cubre el caso de que la sesión expire a mitad de uso.
fetch('/api/me').then((r) => r.json()).then((data) => {
  if (!data.authenticated) { window.location.href = '/login'; return; }
  const el = document.getElementById('sidebar-username');
  if (el) el.textContent = data.username;
  currentUser.username = data.username;
  currentUser.isAdmin = !!data.is_admin;
  currentUser.isSuperAdmin = !!data.is_super_admin;
  const navAdmin = document.getElementById('nav-admin');
  if (navAdmin && currentUser.isAdmin) navAdmin.style.display = '';
  const navCopys = document.getElementById('nav-copys');
  if (navCopys && currentUser.isAdmin) navCopys.style.display = '';
  // Hoteles está en afinado: oculto para todos (también para el super admin) hasta
  // que se ponga HOTEL_SECTION_VISIBLE en true; cuando se muestre, solo super admin
  // (el servidor también lo exige).
  const navCampanas = document.getElementById('nav-campanas');
  if (navCampanas && currentUser.isSuperAdmin) navCampanas.style.display = '';
  const navCambios = document.getElementById('nav-cambios');
  if (navCambios && currentUser.isSuperAdmin) navCambios.style.display = '';
  const navHoteles = document.getElementById('nav-hoteles');
  if (navHoteles && HOTEL_SECTION_VISIBLE && currentUser.isSuperAdmin) navHoteles.style.display = '';
  if (data.must_change_password) {
    forcePasswordChange = true;
    render();
  }
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

// Cerrar la ventana flotante del histórico de keywords, o la de campañas
// de Ritmo de consumo, con Escape.
// Cerrar el menú de hoteles de Ritmo de consumo al hacer clic fuera de él.
document.addEventListener('click', (e) => {
  if (state.pacing.hotelMenuOpen && !e.target.closest('.pacing-hotel-menu')) {
    state.pacing.hotelMenuOpen = false;
    render();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.pacing.hotelMenuOpen) {
    state.pacing.hotelMenuOpen = false;
    render();
  } else if (state.keywordPlanner.historico.modalKeyword) {
    state.keywordPlanner.historico.modalKeyword = null;
    render();
  } else if (state.pacing.campaignsModal.customerId) {
    closePacingCampaignsModal();
  }
});

render();
