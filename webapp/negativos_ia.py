"""Negativización con IA — la parte que NO es IA.

Claude propone qué negativizar, qué dejar y qué revisar; este módulo
prepara lo que se le manda y, sobre todo, VALIDA lo que devuelve antes de
mostrarlo, con código y no con confianza en el modelo:

  * Ningún término con conversiones queda como "negativizar" (pasa a revisar).
  * Ningún término que contenga el nombre del hotel o la marca se negativiza.
  * Cada palabra negativa propuesta se prueba contra TODOS los términos de la
    cuenta (no solo los que vio la IA): se calcula qué bloquearía de verdad,
    cuánto gasto ahorra y con qué términos que convierten o de marca choca.
  * Se descartan negativas demasiado genéricas ("hotel", "reserva"…) o que
    sean solo el nombre del hotel o el destino.
  * Se omiten las que ya existen en la campaña.

Solo stdlib, igual que el resto del servidor. Las funciones son puras, para
poder probarlas sin llamar a Claude ni a Google Ads.
"""

import re
import unicodedata

MAX_TERMS_TO_AI = 300          # términos con más gasto que se mandan a la IA
MAX_EXTRA_CONVERTING = 60      # además, los que convierten aunque no entren por gasto
MAX_ROWS_ACCEPTED = 20000      # filas máximas que acepta el servidor

# Palabras que no sirven como negativo porque cortan búsquedas buenas de hotel.
GENERIC_WORDS = {
    "hotel", "hoteles", "hostal", "hostales", "resort", "resorts", "reserva", "reservas", "reservar",
    "precio", "precios", "tarifa", "tarifas", "oferta", "ofertas", "cerca", "barato", "baratos", "barata",
    "baratas", "habitacion", "habitaciones", "alojamiento", "hospedaje", "noche", "noches", "disponibilidad",
    "en", "de", "del", "la", "el", "los", "las", "y", "a", "con", "para", "por", "un", "una", "al", "the",
    "in", "of", "and", "for", "hotels", "room", "rooms", "book", "booking", "best", "near",
}

MATCH_LABEL = {"FRASE": "PHRASE", "EXACTA": "EXACT"}


def norm(text):
    """Minúsculas, sin tildes, solo letras y números separados por un espacio."""
    text = unicodedata.normalize("NFKD", str(text or "").lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9ñ]+", " ", text).strip()


def _tokens(text):
    return norm(text).split()


def _contains_phrase(tokens, phrase):
    """True si `phrase` (lista de palabras) aparece seguida y en orden dentro de `tokens`."""
    n = len(phrase)
    if n == 0 or n > len(tokens):
        return False
    return any(tokens[i:i + n] == phrase for i in range(len(tokens) - n + 1))


def _phrases(lines):
    """Líneas de texto -> lista de listas de palabras normalizadas, sin vacías ni repetidas."""
    out, seen = [], set()
    for line in lines:
        t = _tokens(line)
        if t and tuple(t) not in seen:
            seen.add(tuple(t))
            out.append(t)
    return out


def split_lines(value):
    return [p.strip() for p in re.split(r"[\n,;]+", str(value or "")) if p.strip()]


def _blocked_by(tokens, negatives):
    """¿Alguna negativa (tokens, concordancia) bloquea esta búsqueda? Mismas reglas que Google, sin variantes
    cercanas (las negativas no las cubren): exacta = igual; frase = las palabras seguidas y en orden; amplia =
    todas las palabras, en cualquier orden."""
    for ntoks, match in negatives:
        if match == "EXACT" and tokens == ntoks:
            return True
        if match == "PHRASE" and _contains_phrase(tokens, ntoks):
            return True
        if match == "BROAD" and all(w in tokens for w in ntoks):
            return True
    return False


def drop_blocked(rows, existing_negatives):
    """Separa las filas (término, campaña) que YA bloquea una negativa existente de su campaña — puesta en la
    propia campaña, en una lista compartida enlazada a ella o en una lista de la cuenta: no tiene sentido volver
    a negativizarlas ni gastarle tokens a la IA con ellas. En Search Google ya las marca como excluidas y la
    consulta las descarta; en Performance Max la vista no trae estado y reaparecen dentro del periodo. Las filas
    sin campaña (CSV) se conservan. Devuelve (conservadas, descartadas)."""
    existing = as_existing(existing_negatives)
    kept, dropped = [], []
    for r in rows or []:
        cid = r.get("campaign_id") if isinstance(r, dict) else None
        if cid not in (None, "") and existing.blocks(cid, _tokens(r.get("term"))):
            dropped.append(r)
        else:
            kept.append(r)
    return kept, dropped


def summarize_dropped(dropped):
    """Cuántos términos únicos y cuánto gasto se dejaron fuera por estar ya bloqueados."""
    terms = {norm(r.get("term")) for r in dropped if not r.get("is_category")}
    cost = sum(float(r.get("cost") or 0) for r in dropped if not r.get("is_category"))
    return {"terminos": len(terms), "costo": round(cost, 2)}


def aggregate_terms(rows):
    """Une las filas por término normalizado (un mismo término puede venir de
    varias campañas). Descarta categorías de Performance Max y vacíos."""
    by = {}
    for r in rows or []:
        if not isinstance(r, dict) or r.get("is_category"):
            continue
        term = str(r.get("term") or "").strip()
        key = norm(term)
        if not key:
            continue
        a = by.setdefault(key, {
            "term": term, "key": key, "tokens": key.split(),
            "clicks": 0, "impr": 0, "cost": 0.0, "conversions": 0.0, "campaigns": {},
        })
        a["clicks"] += int(float(r.get("clicks") or 0))
        a["impr"] += int(float(r.get("impr") or 0))
        a["cost"] += float(r.get("cost") or 0)
        a["conversions"] += float(r.get("conversions") or 0)
        cid = r.get("campaign_id")
        if cid not in (None, ""):
            a["campaigns"][str(cid)] = r.get("campaign_name") or str(cid)
            if r.get("pmax"):
                a.setdefault("pmax_campaigns", set()).add(str(cid))
        if r.get("pmax"):
            a["pmax"] = True
    return list(by.values())


def select_for_ai(terms, limit=MAX_TERMS_TO_AI):
    """Los términos que se le mandan a la IA: los de más gasto y, además, los
    que convierten (para que nunca los pase por alto). Devuelve la lista con
    un `id` entero asignado (1..n)."""
    ordered = sorted(terms, key=lambda t: (-t["cost"], -t["clicks"], -t["impr"], t["key"]))
    chosen = ordered[:limit]
    ids = {t["key"] for t in chosen}
    extra = [t for t in ordered[limit:] if t["conversions"] > 0 and t["key"] not in ids][:MAX_EXTRA_CONVERTING]
    chosen = chosen + extra
    for i, t in enumerate(chosen, start=1):
        t["id"] = i
    return chosen


def build_user_content(ctx, chosen, existing_texts):
    """El mensaje de usuario para la IA, como JSON."""
    import json
    payload = {
        "contexto": {
            "hotel_o_marca": split_lines(ctx.get("marca")),
            "destino": split_lines(ctx.get("destino")),
            "ofrece": str(ctx.get("ofrece") or "")[:600],
            "no_ofrece_o_no_quiere_atraer": str(ctx.get("no_ofrece") or "")[:600],
        },
        "negativas_ya_existentes_en_la_cuenta": existing_texts[:150],
        "terminos": [
            {"id": t["id"], "termino": t["term"], "clics": t["clicks"], "impresiones": t["impr"],
             "costo": round(t["cost"], 2), "conversiones": round(t["conversions"], 2)}
            for t in chosen
        ],
    }
    return json.dumps(payload, ensure_ascii=False)


def _empty_metrics():
    return {"terminos": 0, "clics": 0, "costo": 0.0, "conversiones": 0.0}


def _add_metrics(m, t):
    m["terminos"] += 1
    m["clics"] += t["clicks"]
    m["costo"] += t["cost"]
    m["conversiones"] += t["conversions"]


def _round_metrics(m):
    return {"terminos": m["terminos"], "clics": m["clics"], "costo": round(m["costo"], 2), "conversiones": round(m["conversiones"], 2)}


def _term_view(t):
    return {
        "term": t["term"], "clicks": t["clicks"], "impr": t["impr"], "cost": round(t["cost"], 2),
        "conversions": round(t["conversions"], 2), "pmax": bool(t.get("pmax")),
        "campaigns": [{"id": cid, "name": name} for cid, name in t["campaigns"].items()],
    }


class NegIndex:
    """Conjunto de negativas indexado para preguntar rápido "¿alguna bloquea esta búsqueda?" aunque haya miles.
    Exacta: conjunto de tuplas. Frase: conjunto de tuplas, probando las subfrases de la búsqueda. Amplia: se
    indexa por una de sus palabras y se comprueba que estén todas."""

    def __init__(self):
        self.exact, self.phrase = set(), set()
        self.broad_by_word, self.broad_all = {}, set()
        self.phrase_max = 0

    def add(self, tokens, match):
        toks = tuple(tokens)
        if not toks:
            return
        if match == "EXACT":
            self.exact.add(toks)
        elif match == "PHRASE":
            self.phrase.add(toks)
            self.phrase_max = max(self.phrase_max, len(toks))
        elif match == "BROAD":
            key = frozenset(toks)
            if key not in self.broad_all:
                self.broad_all.add(key)
                self.broad_by_word.setdefault(min(key), []).append(key)

    def blocks(self, tokens):
        tup = tuple(tokens)
        if tup in self.exact:
            return True
        if self.phrase:
            n = len(tup)
            for i in range(n):
                for j in range(i + 1, min(n, i + self.phrase_max) + 1):
                    if tup[i:j] in self.phrase:
                        return True
        if self.broad_by_word:
            words = set(tup)
            for w in words:
                for neg in self.broad_by_word.get(w, ()):
                    if neg <= words:
                        return True
        return False

    def has_same(self, tokens, match):
        """¿Ya hay una igual (mismo texto y concordancia, o la misma palabra en amplia)?"""
        tup = tuple(tokens)
        if frozenset(tup) in self.broad_all:  # una amplia con las mismas palabras ya cubre a la exacta y a la de frase
            return True
        return (match == "EXACT" and tup in self.exact) or (match == "PHRASE" and tup in self.phrase)


class ExistingNegatives:
    """Las negativas que ya tiene la cuenta, de todos los orígenes: de campaña, listas compartidas enlazadas a
    campañas y listas enlazadas a la cuenta (aplican a todas las campañas)."""

    def __init__(self):
        self.campaign = {}      # campaign_id -> NegIndex
        self.lists = {}         # list_id -> NegIndex
        self.list_names = {}
        self.campaign_lists = {}  # campaign_id -> [list_id]
        self.account_lists = []
        self.counts = {"campania": 0, "palabras_listas": 0, "listas": 0, "listas_cuenta": 0}
        self._texts = []

    @classmethod
    def from_rows(cls, rows):
        """Solo negativas de campaña: [{campaign_id, text, match_type}]."""
        return cls.from_sources({"campaign": rows or [], "lists": []})

    @classmethod
    def from_sources(cls, sources):
        ex = cls()
        seen = set()
        for e in (sources or {}).get("campaign", []):
            toks = _tokens(e.get("text"))
            if not toks:
                continue
            ex.campaign.setdefault(str(e.get("campaign_id")), NegIndex()).add(toks, str(e.get("match_type") or "").upper())
            ex.counts["campania"] += 1
            if e["text"] not in seen:
                seen.add(e["text"]); ex._texts.append(e["text"])
        for lst in (sources or {}).get("lists", []):
            idx = NegIndex()
            for kw in lst.get("keywords", []):
                toks = _tokens(kw.get("text"))
                if toks:
                    idx.add(toks, str(kw.get("match_type") or "").upper())
                    ex.counts["palabras_listas"] += 1
                    if kw["text"] not in seen:
                        seen.add(kw["text"]); ex._texts.append(kw["text"])
            lid = str(lst.get("id"))
            ex.lists[lid] = idx
            ex.list_names[lid] = lst.get("name") or lid
            ex.counts["listas"] += 1
            for cid in lst.get("campaign_ids", []):
                ex.campaign_lists.setdefault(str(cid), []).append(lid)
            if lst.get("account"):
                ex.account_lists.append(lid)
                ex.counts["listas_cuenta"] += 1
        return ex

    def _indexes(self, campaign_id):
        cid = str(campaign_id)
        if cid in self.campaign:
            yield self.campaign[cid]
        for lid in self.campaign_lists.get(cid, ()):
            yield self.lists[lid]
        for lid in self.account_lists:
            yield self.lists[lid]

    def blocks(self, campaign_id, tokens):
        return any(idx.blocks(tokens) for idx in self._indexes(campaign_id))

    def has_same(self, campaign_id, tokens, match):
        return any(idx.has_same(tokens, match) for idx in self._indexes(campaign_id))

    def texts(self, limit=150):
        return self._texts[:limit]

    def total(self):
        return self.counts["campania"] + self.counts["palabras_listas"]


def as_existing(existing_negatives):
    if isinstance(existing_negatives, ExistingNegatives):
        return existing_negatives
    return ExistingNegatives.from_rows(existing_negatives)


def _existing_covers(existing, tokens, match, campaign_id):
    """¿Ya hay en esta campaña (propia, lista compartida o lista de la cuenta) una negativa igual?"""
    return existing.has_same(campaign_id, tokens, match)


def _as_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def build_result(ai, all_terms, chosen, ctx, existing_negatives):
    """Convierte lo que dijo la IA en el resultado final validado.

    ai: dict ya parseado {"temas": [...], "mantener": [...], "revisar": [...]}.
    all_terms: TODOS los términos agregados (para medir qué bloquearía cada negativa).
    chosen: los que se le mandaron a la IA (con `id`)."""
    avisos = []
    by_id = {t["id"]: t for t in chosen}
    marca = _phrases(split_lines(ctx.get("marca")))
    destino = _phrases(split_lines(ctx.get("destino")))
    protegidas = marca + destino
    existing = as_existing(existing_negatives)
    pmax_ids = {cid for t in all_terms for cid in t.get("pmax_campaigns", ())}

    def camp(cid, name):
        # `pmax`: en Performance Max las negativas de frase no están probadas; la pantalla lo avisa.
        return {"id": cid, "name": name, "pmax": cid in pmax_ids}

    def has_brand(t):
        return any(_contains_phrase(t["tokens"], p) for p in marca)

    def selectable_view(t):
        """Un término que la persona puede marcar para negativizar (en "revisar" o en "dejar"): se manda la
        clave, si lleva la marca (para avisar) y las campañas donde aún no existe esa negativa exacta."""
        return {
            **_term_view(t), "key": t["key"], "es_marca": has_brand(t),
            "campanias": [camp(cid, name) for cid, name in t["campaigns"].items()
                          if not _existing_covers(existing, t["tokens"], "EXACT", cid)],
        }

    # 1) Un término, un solo grupo: lo que diga la IA, con las reglas duras encima.
    bucket = {}       # id -> ("neg", idx_tema) | ("keep", idx_grupo) | ("review", pregunta)
    seen_ids = {}

    def claim(tid, where):
        if tid in seen_ids:
            bucket[tid] = ("review", "La IA lo puso en más de un grupo; decide tú.")
            return
        seen_ids[tid] = True
        bucket[tid] = where

    ai_temas = ai.get("temas") if isinstance(ai.get("temas"), list) else []
    ai_keep = ai.get("mantener") if isinstance(ai.get("mantener"), list) else []
    ai_review = ai.get("revisar") if isinstance(ai.get("revisar"), list) else []

    for i, tema in enumerate(ai_temas):
        for raw in (tema.get("terminos") or []) if isinstance(tema, dict) else []:
            tid = _as_int(raw)
            if tid in by_id:
                claim(tid, ("neg", i))
    for i, grupo in enumerate(ai_keep):
        for raw in (grupo.get("terminos") or []) if isinstance(grupo, dict) else []:
            tid = _as_int(raw)
            if tid in by_id:
                claim(tid, ("keep", i))
    for item in ai_review:
        if not isinstance(item, dict):
            continue
        question = str(item.get("pregunta") or "Sin pregunta concreta.")[:300]
        # Forma agrupada ({"pregunta", "terminos": [ids]}) y, por compatibilidad, la de un solo término ({"id"}).
        raw_ids = item.get("terminos") if isinstance(item.get("terminos"), list) else [item.get("id")]
        for raw in raw_ids:
            tid = _as_int(raw)
            if tid in by_id:
                claim(tid, ("review", question))

    moved_conv = moved_brand = 0
    for tid, where in list(bucket.items()):
        if where[0] != "neg":
            continue
        t = by_id[tid]
        if t["conversions"] > 0:
            bucket[tid] = ("review", f"Tiene {round(t['conversions'], 1)} conversión(es): no se recomienda negativizar un término que convierte.")
            moved_conv += 1
        elif has_brand(t):
            bucket[tid] = ("review", "Contiene el nombre del hotel o la marca: confirma antes de bloquearlo.")
            moved_brand += 1
    for t in chosen:
        if t["id"] not in bucket:
            bucket[t["id"]] = ("review", "La IA no lo clasificó.")
    if moved_conv:
        avisos.append(f"{moved_conv} término(s) con conversiones que la IA quería negativizar pasaron a \"revisar\".")
    if moved_brand:
        avisos.append(f"{moved_brand} término(s) con el nombre del hotel o la marca pasaron a \"revisar\".")

    bucket_by_key = {t["key"]: bucket[t["id"]] for t in chosen}

    # 2) Temas a negativizar, con sus palabras negativas medidas contra TODA la cuenta.
    temas_out = []
    total_neg = _empty_metrics()
    for i, tema in enumerate(ai_temas):
        if not isinstance(tema, dict):
            continue
        own = [by_id[tid] for tid, w in bucket.items() if w == ("neg", i)]
        negativas = []
        for j, neg in enumerate(tema.get("negativas") or []):
            if not isinstance(neg, dict):
                continue
            text = str(neg.get("texto") or "").strip()
            match = "EXACTA" if str(neg.get("concordancia") or "").upper().startswith("EXACT") else "FRASE"
            ntoks = _tokens(text)
            if not ntoks:
                continue
            if all(w in GENERIC_WORDS for w in ntoks):
                avisos.append(f"Se descartó la negativa \"{text}\": es una palabra genérica de hotel que cortaría búsquedas buenas.")
                continue
            if any(ntoks == p for p in protegidas) or any(_contains_phrase(ntoks, p) for p in marca):
                avisos.append(f"Se descartó la negativa \"{text}\": coincide con el nombre del hotel, la marca o el destino.")
                continue
            blocked = []
            for t in all_terms:
                hit = (t["tokens"] == ntoks) if match == "EXACTA" else _contains_phrase(t["tokens"], ntoks)
                if hit:
                    blocked.append(t)
            if not blocked:
                avisos.append(f"La negativa \"{text}\" no coincide con ningún término de este reporte; se omitió.")
                continue
            metrics = _empty_metrics()
            for t in blocked:
                _add_metrics(metrics, t)
            own_keys = {t["key"] for t in own}
            choques = []
            for t in blocked:
                if t["conversions"] > 0:
                    choques.append({"term": t["term"], "motivo": "convierte", "cost": round(t["cost"], 2), "conversions": round(t["conversions"], 2)})
                elif has_brand(t):
                    choques.append({"term": t["term"], "motivo": "marca", "cost": round(t["cost"], 2), "conversions": 0})
                elif t["key"] in own_keys:
                    continue
                elif bucket_by_key.get(t["key"], ("",))[0] == "keep":
                    choques.append({"term": t["term"], "motivo": "dejar", "cost": round(t["cost"], 2), "conversions": 0})
            risk = "alto" if any(c["motivo"] in ("convierte", "marca") for c in choques) else ("medio" if choques else "bajo")
            extra = [t for t in blocked if t["key"] not in own_keys and t["conversions"] == 0 and not has_brand(t)
                     and not any(c["term"] == t["term"] for c in choques)]
            campaigns = {}
            for t in blocked:
                for cid, cname in t["campaigns"].items():
                    if not _existing_covers(existing, ntoks, MATCH_LABEL[match], cid):
                        campaigns[cid] = cname
            ya_existe = bool(blocked) and not campaigns and any(t["campaigns"] for t in blocked)
            negativas.append({
                "id": f"n{i}_{j}", "texto": text, "concordancia": match,
                "bloquea": _round_metrics(metrics),
                # Para que la pantalla sume el ahorro SIN contar dos veces un término que bloquean varias
                # negativas (por ejemplo "sultan" y "sultán"): clave normalizada, costo y conversiones.
                "bloqueados": [[t["key"], round(t["cost"], 2), round(t["conversions"], 2)]
                               for t in sorted(blocked, key=lambda x: -x["cost"])[:400]],
                "choques": choques[:8], "choques_total": len(choques), "riesgo": risk,
                "extra": {"terminos": len(extra), "costo": round(sum(t["cost"] for t in extra), 2),
                          "ejemplos": [t["term"] for t in sorted(extra, key=lambda x: -x["cost"])[:5]]},
                "campanias": [camp(cid, name) for cid, name in campaigns.items()],
                "ya_existe": ya_existe,
            })
        negativas.sort(key=lambda x: -x["bloquea"]["costo"])
        # Alternativa segura: los términos del tema sin conversiones, como exactas.
        exactas = []
        for t in own:
            if t["conversions"] > 0 or has_brand(t):
                continue
            camps = {cid: cname for cid, cname in t["campaigns"].items()
                     if not _existing_covers(existing, t["tokens"], "EXACT", cid)}
            if camps:
                exactas.append({"term": t["term"], "key": t["key"], "cost": round(t["cost"], 2), "clicks": t["clicks"],
                                "campanias": [camp(cid, name) for cid, name in camps.items()]})
        own_metrics = _empty_metrics()
        for t in own:
            _add_metrics(own_metrics, t)
            _add_metrics(total_neg, t)
        if not own and not negativas:
            continue
        temas_out.append({
            "id": f"t{i}", "tema": str(tema.get("tema") or "Sin nombre")[:120], "razon": str(tema.get("razon") or "")[:400],
            "negativas": negativas, "exactas": exactas,
            "terminos": [_term_view(t) for t in sorted(own, key=lambda x: -x["cost"])],
            "total": _round_metrics(own_metrics),
        })
    temas_out.sort(key=lambda x: -x["total"]["costo"])

    # 3) Lo que se deja y lo que se revisa.
    keep_out = []
    total_keep = _empty_metrics()
    for i, grupo in enumerate(ai_keep):
        if not isinstance(grupo, dict):
            continue
        own = [by_id[tid] for tid, w in bucket.items() if w == ("keep", i)]
        if not own:
            continue
        m = _empty_metrics()
        for t in own:
            _add_metrics(m, t)
            _add_metrics(total_keep, t)
        keep_out.append({
            "grupo": str(grupo.get("grupo") or "Sin nombre")[:120], "razon": str(grupo.get("razon") or "")[:400],
            "terminos": [selectable_view(t) for t in sorted(own, key=lambda x: -x["cost"])], "total": _round_metrics(m),
        })
    keep_out.sort(key=lambda x: -x["total"]["costo"])

    review_out = []
    total_review = _empty_metrics()
    for tid, w in bucket.items():
        if w[0] != "review":
            continue
        t = by_id[tid]
        _add_metrics(total_review, t)
        # Cada término a revisar se puede marcar para subirlo como negativa exacta: se manda la clave, si lleva
        # la marca (para avisar) y las campañas donde aún no existe esa exacta.
        review_out.append({**selectable_view(t), "pregunta": w[1]})
    review_out.sort(key=lambda x: -x["cost"])

    analyzed = {t["key"] for t in chosen}
    not_analyzed = [t for t in all_terms if t["key"] not in analyzed]
    return {
        "resumen": {
            "terminos_total": len(all_terms), "analizados": len(chosen), "no_analizados": len(not_analyzed),
            "costo_no_analizado": round(sum(t["cost"] for t in not_analyzed), 2),
            "negativizar": _round_metrics(total_neg), "mantener": _round_metrics(total_keep), "revisar": _round_metrics(total_review),
        },
        "temas": temas_out, "mantener": keep_out, "revisar": review_out, "avisos": avisos,
    }
