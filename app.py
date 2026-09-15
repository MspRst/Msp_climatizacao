"""
MASP — Sistema de Monitoramento de Climatização
Backend Flask com SQLite
"""

import os
import re
import json
import time
import sqlite3
import unicodedata
from collections import defaultdict
from datetime import datetime as _dt, date as _date
from flask import Flask, jsonify, send_file, request, abort, render_template
from functools import wraps
from conformidade import calcular_conformidade, calcular_ponto_orvalho

# ── CACHE SIMPLES EM MEMÓRIA ──────────────────────────────
# Evita reprocessar queries pesadas enquanto os dados não mudam.
# TTL padrão: 300 segundos (5 min). Invalidado no upload.
_CACHE: dict = {}
_CACHE_TTL = 300  # segundos

def _cache_key(endpoint: str, params: dict) -> str:
    """Gera chave de cache a partir do endpoint e dos parâmetros."""
    items = sorted((k, str(v)) for k, v in params.items() if v not in ('', None))
    return endpoint + "|" + "&".join(f"{k}={v}" for k, v in items)

def cache_get(key: str):
    entry = _CACHE.get(key)
    if entry and (time.time() - entry["ts"]) < entry.get("ttl", _CACHE_TTL):
        return entry["data"]
    return None

def cache_set(key: str, data, ttl: int = None):
    """`ttl` (segundos) sobrepõe o TTL padrão para essa entrada — usado por endpoints
    caros sobre o histórico completo (ex.: /api/sazonal), que não ficam mais "quentes"
    de verdade com um TTL de 5 min: cache_invalidate() já limpa tudo a cada upload."""
    _CACHE[key] = {"ts": time.time(), "data": data, "ttl": ttl or _CACHE_TTL}

def cache_invalidate():
    """Chamado após upload — limpa todo o cache."""
    _CACHE.clear()


def normalize_name(s):
    """Remove acentos, pontuação e caixa para comparação fuzzy de nomes de sensores."""
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-z0-9]', '', s.lower())


# ── CRUZAMENTO SENSOR × EXPOSIÇÃO ─────────────────────────
# Compartilhado entre /api/upload (calcula na ingestão) e /api/admin/recalcular_periodo
# (recalcula o histórico quando uma exposição é cadastrada/editada depois dos dados já
# terem sido importados). Mantém as duas rotas sempre em sincronia com a mesma regra.
#
# O MASP tem dois prédios (Lina e Pietro) e ambos podem ter andares de MESMO número
# (ex.: "2º Andar" existe nos dois) — por isso todo o cruzamento é sempre feito por
# (prédio, andar), nunca só por andar. Sem isso, uma exposição no 2º Andar do Pietro
# marcaria também o 2º Andar do Lina (e vice-versa).

_ORDINAIS_EXTENSO = {1: "primeiro", 2: "segundo", 3: "terceiro", 4: "quarto",
                     5: "quinto", 6: "sexto"}


def _andar_keywords_padrao(n):
    """Variações textuais de "Nº andar" usadas para bater com o campo espacos das
    exposições: "2º andar", "2o andar", "2 andar", "segundo andar"."""
    kws = [f"{n}º andar", f"{n}o andar", f"{n} andar"]
    if n in _ORDINAIS_EXTENSO:
        kws.append(f"{_ORDINAIS_EXTENSO[n]} andar")
    return kws


# Mapeamento: (prédio, andar do sensor) → palavras-chave que devem aparecer no campo
# espacos da exposição para o cruzamento ser considerado válido.
_ANDAR_KEYWORDS = {
    "Lina": {
        "1º andar":   ["1º andar", "1o andar", "1 andar", "primeiro andar"],
        "1º subsolo": ["1º subsolo", "1o subsolo", "subsolo exposição", "subsolo mezanino",
                       "subsolo exposicao", "subsolo mezanino"],
        "2º subsolo": ["2º subsolo", "2o subsolo", "segundo subsolo"],
    },
    "Pietro": {
        f"{n}º andar": _andar_keywords_padrao(n) for n in range(2, 7)
    },
}


def _normalizar_texto(s):
    """Remove acentos e caixa, colapsa espaços múltiplos e trata º/° como iguais —
    para comparação fuzzy de textos.
    Sem o colapso de espaços, um espaço duplo digitado no campo "espaços" da exposição
    (ex.: "1º  Andar expositivo") já é suficiente pra quebrar o match por substring com
    a palavra-chave "1º andar". E sem tratar º (indicador ordinal, U+00BA) e ° (sinal de
    grau, U+00B0) como equivalentes, um "1° Andar" digitado com o caractere errado (comum
    em copiar/colar de outras fontes) também não bate com a palavra-chave "1º andar"."""
    s = unicodedata.normalize('NFD', (s or '').lower())
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = s.replace('º', 'o').replace('°', 'o')
    return re.sub(r'\s+', ' ', s).strip()


def _eh_acervo_permanente(predio, andar_sensor):
    """O 2º Andar do LINA é a coleção permanente "Acervo em Transformação" — sempre
    marcado como expositivo, independente da tabela de exposições. NÃO vale para o
    Pietro: lá, um andar homônimo (o próprio "2º Andar" do Pietro) recebe exposições
    temporárias normais, cruzadas com a tabela de exposições como qualquer outro andar."""
    if (predio or 'Lina') != 'Lina':
        return False
    return '2o andar' in _normalizar_texto(andar_sensor or '')


def _andar_keywords_for(predio, andar_sensor):
    """Retorna a lista de palavras-chave do grupo de (prédio, andar) do sensor, ou []
    se nenhum grupo bater."""
    andar_norm = _normalizar_texto(andar_sensor or '')
    grupos = _ANDAR_KEYWORDS.get(predio or 'Lina', {})
    for andar_key, kws in grupos.items():
        if _normalizar_texto(andar_key) in andar_norm:
            return kws
    return []


def _expositivo_para(data_hora_str, predio, andar_sensor, exposicoes, espaco_expositivo=1):
    """Retorna o NOME da exposição se data_hora cai dentro do período de uma exposição do
    MESMO prédio cujo espaço bate com o andar do sensor, senão None. `exposicoes` é uma
    lista de rows com nome/predio/inicio/termino/espacos. `espaco_expositivo` (flag do
    sensor, sensores.espaco_expositivo) corta o cruzamento de cara para sensores em
    espaços não-expositivos do mesmo andar de uma galeria — ex.: Ateliê de Restauro e
    Reservas Técnicas ficam no "1º Andar" junto com "1º andar frente/fundo", mas não são
    espaço de exibição."""
    if not data_hora_str or not espaco_expositivo:
        return None

    predio = predio or 'Lina'

    # 2º andar do Lina — acervo fixo permanente, independe da tabela de exposições
    if _eh_acervo_permanente(predio, andar_sensor):
        return "Acervo em Transformação"

    if not exposicoes:
        return None

    dh = data_hora_str[:10]
    keywords = _andar_keywords_for(predio, andar_sensor)
    if not keywords:
        return None

    for expo in exposicoes:
        # Exposição com prédio definido só cruza com sensores do mesmo prédio —
        # essencial agora que "2º Andar" (por exemplo) existe nos dois prédios.
        expo_predio = expo["predio"] if "predio" in expo.keys() else None
        if expo_predio and expo_predio not in (predio, 'Ambos'):
            continue
        if expo["inicio"][:10] <= dh <= expo["termino"][:10]:
            espacos_norm = _normalizar_texto(expo["espacos"] or '')
            if any(_normalizar_texto(kw) in espacos_norm for kw in keywords):
                return expo["nome"]  # Retorna o nome real!
    return None


def resolve_sensor(con, sensor_nome, cache, sensores_novos_lista):
    """
    Resolve sensor_id a partir de um nome, em 5 camadas:
      1. Cache em memória (evita re-consultas dentro do mesmo upload)
      2. Match exato em sensores.nome
      3. Match fuzzy — ignora acentos, pontuação e caixa
      4. Match por alias (sensores_aliases) — exato e depois fuzzy
      5. Auto-criação (predio inferido; registrado em sensores_novos_lista para revisão)

    sensores_novos_lista é uma lista mutável de dicts {id, nome, predio}
    acumulada ao longo de um upload — o frontend usa para abrir a tela de revisão.

    O cache recebe também '_all_sensores' e '_all_aliases' após o primeiro uso
    para evitar full scans repetidos durante uploads com muitas linhas.
    """
    if not sensor_nome:
        return None
    if sensor_nome in cache:
        return cache[sensor_nome]

    # Pré-carrega todos os sensores e aliases na primeira chamada do upload
    if "_all_sensores" not in cache:
        cache["_all_sensores"] = {
            r["nome"]: r["id"]
            for r in con.execute("SELECT id, nome FROM sensores").fetchall()
        }
        cache["_all_sensores_norm"] = {
            normalize_name(nome): sid
            for nome, sid in cache["_all_sensores"].items()
        }
        cache["_all_aliases"] = {
            r["alias"]: r["sensor_id"]
            for r in con.execute("SELECT alias, sensor_id FROM sensores_aliases").fetchall()
        }
        cache["_all_aliases_norm"] = {
            normalize_name(alias): sid
            for alias, sid in cache["_all_aliases"].items()
        }

    sensor_id = None

    # 1. Exato
    sensor_id = cache["_all_sensores"].get(sensor_nome)

    # 2. Fuzzy
    if sensor_id is None:
        sensor_id = cache["_all_sensores_norm"].get(normalize_name(sensor_nome))

    # 3. Alias — exato
    if sensor_id is None:
        sensor_id = cache["_all_aliases"].get(sensor_nome)

    # 4. Alias — fuzzy
    if sensor_id is None:
        sensor_id = cache["_all_aliases_norm"].get(normalize_name(sensor_nome))

    # 5. Auto-criação — registra na lista para revisão no frontend
    if sensor_id is None:
        predio = "Pietro" if "Pietro" in sensor_nome else "Lina"
        con.execute(
            "INSERT OR IGNORE INTO sensores (nome, ativo, predio) VALUES (?, 1, ?)",
            (sensor_nome, predio)
        )
        row = con.execute(
            "SELECT id FROM sensores WHERE nome = ?", (sensor_nome,)
        ).fetchone()
        if row:
            sensor_id = row["id"]
            sensores_novos_lista.append({"id": sensor_id, "nome": sensor_nome, "predio": predio})
            # Actualiza caches locais para o resto do upload
            cache["_all_sensores"][sensor_nome] = sensor_id
            cache["_all_sensores_norm"][normalize_name(sensor_nome)] = sensor_id

    cache[sensor_nome] = sensor_id
    return sensor_id

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__, static_folder=os.path.join(BASE_DIR, "static"))

# ── CONFIGURAÇÃO ──────────────────────────────────────────
DB_PATH = os.environ.get("DB_PATH") or os.path.join(BASE_DIR, "climatizacao_museu.db")

ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN", None)


# ── MIGRAÇÕES AUTOMÁTICAS ─────────────────────────────────
# Adiciona colunas que podem estar ausentes em bancos criados antes de certas
# migrações. Usa ADD COLUMN que é seguro de executar repetidamente (ignora
# o erro se a coluna já existir). Executado uma vez no startup.
def _run_migrations(con):
    """Garante que o schema está atualizado sem apagar dados existentes."""
    migrations = [
        ("sensores", "localizacao", "TEXT"),
        ("sensores", "descricao",   "TEXT"),
        ("sensores", "data_instalacao", "DATE"),
        ("sensores", "predio",      "TEXT"),
        ("medicoes", "conf_temp_masp",   "INTEGER DEFAULT 0"),
        ("medicoes", "conf_umid_masp",   "INTEGER DEFAULT 0"),
        ("medicoes", "conf_total_masp",  "INTEGER DEFAULT 0"),
        ("medicoes", "conf_temp_bizot",  "INTEGER DEFAULT 0"),
        ("medicoes", "conf_umid_bizot",  "INTEGER DEFAULT 0"),
        ("medicoes", "conf_total_bizot", "INTEGER DEFAULT 0"),
        ("medicoes", "conforme_temperatura", "INTEGER DEFAULT 0"),
        ("medicoes", "conforme_umidade",     "INTEGER DEFAULT 0"),
        ("medicoes", "conforme_total",       "INTEGER DEFAULT 0"),
        ("medicoes", "conf_total_hibrido",   "INTEGER DEFAULT 0"),
        ("medicoes", "periodo_expositivo_nome", "TEXT"),
        # Nem todo sensor de um andar fica em espaço expositivo (ex.: Ateliê de Restauro e
        # Reservas Técnicas ficam no mesmo andar de galerias, mas não são expositivos).
        # Default 1 preserva o comportamento anterior até o backfill por nome corrigir os
        # sensores técnicos conhecidos.
        ("sensores", "espaco_expositivo", "INTEGER DEFAULT 1"),
        # Prédio da exposição — necessário desde que o MASP passou a ter dois prédios
        # (Lina e Pietro) com andares de mesmo número (ex.: "2º Andar" existe nos dois).
        # Default 'Lina' porque as exposições já cadastradas são todas anteriores ao
        # cadastro do Pietro no sistema.
        ("exposicoes", "predio", "TEXT DEFAULT 'Lina'"),
    ]
    for tabela, coluna, tipo in migrations:
        try:
            con.execute(f"ALTER TABLE {tabela} ADD COLUMN {coluna} {tipo}")
        except Exception:
            pass  

    # SOLUÇÃO DEFINITIVA: Tabela corrigida (Executa uma única vez no startup)
    try:
        con.execute("CREATE TABLE IF NOT EXISTS ocorrencias_sensores_new (ocorrencia_id INTEGER, sensor_id INTEGER, PRIMARY KEY (ocorrencia_id, sensor_id), FOREIGN KEY(ocorrencia_id) REFERENCES ocorrencias(id) ON DELETE CASCADE, FOREIGN KEY(sensor_id) REFERENCES sensores(id) ON DELETE CASCADE)")
        con.execute("INSERT OR IGNORE INTO ocorrencias_sensores_new SELECT ocorrencia_id, sensor_id FROM ocorrencias_sensores")
        con.execute("DROP TABLE IF EXISTS ocorrencias_sensores")
        con.execute("ALTER TABLE ocorrencias_sensores_new RENAME TO ocorrencias_sensores")
        
        # Limpa o fantasma da "tabela v2" se ela tiver ficado para trás
        con.execute("DROP TABLE IF EXISTS ocorrencias_sensores_v2")
    except Exception:
        pass

_migrations_done = False

# ── UTILITÁRIOS ───────────────────────────────────────────
def get_db():
    global _migrations_done
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys = ON")
    if not _migrations_done:
        _run_migrations(con)
        con.commit()
        _migrations_done = True
    return con


def query(sql, params=()):
    con = get_db()
    try:
        rows = [dict(r) for r in con.execute(sql, params).fetchall()]
    finally:
        con.close()
    return rows


def optional_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if ACCESS_TOKEN:
            token = request.headers.get("X-Access-Token") or request.args.get("token")
            if token != ACCESS_TOKEN:
                abort(401, "Token inválido")
        return f(*args, **kwargs)
    return decorated


def cached_endpoint(f=None, *, ttl: int = None):
    """
    Decorator que armazena o resultado do endpoint em memória por _CACHE_TTL segundos
    (ou por `ttl`, se informado — ex.: @cached_endpoint(ttl=3600) para um endpoint caro
    sobre o histórico completo, que não fica mais "quente" de verdade em 5 min).
    A chave de cache inclui todos os query params. Usar apenas em endpoints de leitura (GET).
    Respostas vazias ([] ou {}) não são cacheadas — evita cachear resultados de queries
    sem dados que mascarariam dados reais em chamadas posteriores.
    """
    def _decorator(fn):
        @wraps(fn)
        def decorated(*args, **kwargs):
            key = _cache_key(request.path, dict(request.args))
            hit = cache_get(key)
            if hit is not None:
                resp = jsonify(hit)
                resp.headers["X-Cache"] = "HIT"
                return resp
            result = fn(*args, **kwargs)
            try:
                data = result.get_json()
                # Só cacheia se houver dados — evita persistir respostas vazias
                if data:
                    cache_set(key, data, ttl=ttl)
            except Exception:
                pass
            result.headers["X-Cache"] = "MISS"
            return result
        return decorated
    # Permite usar tanto @cached_endpoint quanto @cached_endpoint(ttl=...)
    return _decorator(f) if f is not None else _decorator


# ── ROTA PRINCIPAL ────────────────────────────────────────
# ── CACHE BUSTING ─────────────────────────────────────────
import hashlib as _hashlib

def _file_hash(path: str, length: int = 8) -> str:
    """Retorna os primeiros N hex chars do MD5 do arquivo, ou 'dev' se não existir."""
    try:
        with open(path, "rb") as fh:
            return _hashlib.md5(fh.read()).hexdigest()[:length]
    except Exception:
        return "dev"


def _combined_hash(paths: list, length: int = 8) -> str:
    """Hash combinado do conteúdo de vários arquivos — muda se QUALQUER um deles mudar.
    Usado para o cache-busting único (?v=) aplicado a api.js/ui.js/charts.js/admin.js:
    um hash baseado só em api.js não pegava mudanças nos outros três."""
    h = _hashlib.md5()
    for p in paths:
        try:
            with open(p, "rb") as fh:
                h.update(fh.read())
        except Exception:
            h.update(b"dev")
    return h.hexdigest()[:length]


@app.route("/static/api.js")
def serve_api_js():
    """
    Serve o api.js com ETag baseado no conteúdo do arquivo.
    O navegador revalida a cada request mas só baixa novamente se o arquivo mudou.
    Elimina o problema de 304 travado sem forçar download desnecessário.
    """
    from flask import make_response
    path = os.path.join(BASE_DIR, "static", "api.js")
    etag = _file_hash(path, length=16)
    if_none_match = request.headers.get("If-None-Match", "")
    if if_none_match == etag:
        return "", 304
    resp = make_response(send_file(path, mimetype="application/javascript"))
    resp.headers["ETag"] = etag
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/")
def index():
    """
    Serve o index.html injetando um hash combinado dos scripts na tag <script>.
    Isso garante que toda vez que api.js, ui.js, charts.js ou admin.js mudar, o
    navegador baixe a versão nova em vez de usar o cache — sem precisar de Ctrl+Shift+R manual.
    """
    from flask import make_response
    static_dir = os.path.join(BASE_DIR, "static")
    api_js_hash = _combined_hash([
        os.path.join(static_dir, "api.js"),
        os.path.join(static_dir, "ui.js"),
        os.path.join(static_dir, "charts.js"),
        os.path.join(static_dir, "admin.js"),
    ])
    html = render_template("index.html", api_version=api_js_hash)
    resp = make_response(html, 200)
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    return resp


# ── API: MÉTRICAS GERAIS ──────────────────────────────────
@app.route("/api/metricas")
@optional_auth
@cached_endpoint
def metricas():
    filtros, params = build_filtros()
    sql = f"""
        SELECT
            COUNT(*) as total,
            ROUND(100.0 * SUM(m.conforme_temperatura) / COUNT(*), 1) as conf_temp_ibram,
            ROUND(100.0 * SUM(m.conforme_umidade)     / COUNT(*), 1) as conf_ur_ibram,
            ROUND(100.0 * SUM(m.conforme_total)        / COUNT(*), 1) as conf_total_ibram,
            ROUND(100.0 * SUM(m.conf_temp_bizot)        / COUNT(*), 1) as conf_temp_bizot,
            ROUND(100.0 * SUM(m.conf_umid_bizot)        / COUNT(*), 1) as conf_ur_bizot,
            ROUND(100.0 * SUM(m.conf_total_bizot)       / COUNT(*), 1) as conf_bizot,
            ROUND(100.0 * SUM(m.conf_temp_masp)         / COUNT(*), 1) as conf_temp_masp,
            ROUND(100.0 * SUM(m.conf_umid_masp)         / COUNT(*), 1) as conf_ur_masp,
            ROUND(100.0 * SUM(m.conf_total_masp)        / COUNT(*), 1) as conf_masp,
            /* Cálculo da conformidade Híbrida Global */
            ROUND(100.0 * SUM(
                CASE 
                    WHEN (LOWER(s.nome) LIKE '%1%andar%frente%' OR LOWER(s.nome) LIKE '%primeiro%andar%frente%' OR LOWER(s.nome) LIKE '%1%andar%fundo%' OR LOWER(s.nome) LIKE '%primeiro%andar%fundo%') THEN m.conf_total_masp 
                    ELSE m.conf_total_bizot 
                END
            ) / COUNT(*), 1) as conf_hibrido
        FROM medicoes m
        JOIN sensores s ON m.sensor_id = s.id
        {filtros}
    """
    result = query(sql, params)
    return jsonify(result[0] if result else {})



# ── API: CONFORMIDADE POR PONTO ───────────────────────────
@app.route("/api/pontos")
@optional_auth
@cached_endpoint
def pontos():
    filtros, params = build_filtros()
    sql = f"""
        SELECT
            s.nome      as ponto,
            s.andar     as andar,
            COUNT(*)    as medicoes,
            ROUND(AVG(m.temperatura), 1) as temp_media,
            ROUND(AVG(m.umidade), 1)     as ur_media,
            ROUND(100.0 * SUM(m.conforme_total) / COUNT(*), 1) as conf_total_ibram,
            ROUND(100.0 * SUM(m.conf_total_masp) / COUNT(*), 1) as conf_total_masp,
            ROUND(100.0 * SUM(m.conf_total_bizot) / COUNT(*), 1) as conf_total_bizot,
            /* Cálculo dinâmico do Híbrido: apenas 1º Andar Frente e 1º Andar Fundo usam MASP */
            ROUND(100.0 * SUM(
                CASE 
                    WHEN (LOWER(s.nome) LIKE '%1%andar%frente%' OR LOWER(s.nome) LIKE '%primeiro%andar%frente%' OR LOWER(s.nome) LIKE '%1%andar%fundo%' OR LOWER(s.nome) LIKE '%primeiro%andar%fundo%') THEN m.conf_total_masp 
                    ELSE m.conf_total_bizot 
                END
            ) / COUNT(*), 1) as conf_total_hibrido
        FROM medicoes m
        JOIN sensores s ON m.sensor_id = s.id
        {filtros}
        GROUP BY s.id, s.nome, s.andar
        ORDER BY conf_total_hibrido DESC
    """
    rows = query(sql, params)
    return jsonify(rows)


# ── API: EVOLUÇÃO AGREGADA (hora/dia/mês/ano) ─────────────
@app.route("/api/agregado")
@optional_auth
@cached_endpoint
def agregado():
    """
    Retorna conformidade agregada por granularidade temporal.
    ?granularidade=hora|dia|mes|ano  (padrão: mes)

    O filtro periodo_expositivo NÃO é aplicado aqui intencionalmente:
    o gráfico de evolução temporal sempre mostra todos os dados para
    manter a continuidade das curvas. Em vez disso, retorna os campos
    n_expo e n_fora_expo por período para que o frontend possa desenhar
    faixas sombreadas e enriquecer o tooltip com contexto expositivo.

    Limita a 2000 pontos para proteger o frontend.
    """
    gran = request.args.get("granularidade", "mes").lower()
    fmt_map = {
        "hora": "strftime('%Y-%m-%d %H', m.data_hora)",
        "dia":  "strftime('%Y-%m-%d', m.data_hora)",
        "mes":  "strftime('%Y-%m', m.data_hora)",
        "ano":  "strftime('%Y', m.data_hora)",
    }
    if gran not in fmt_map:
        return jsonify({"erro": f"granularidade inválida: {gran}"}), 400

    fmt = fmt_map[gran]

    # Constrói filtros sem periodo_expositivo — preserva continuidade das curvas
    filtros, params = build_filtros(ignorar_periodo=True)

    # Determina quais exposições são relevantes para os sensores selecionados.
    #
    # Lógica:
    #   - Se nenhum ponto foi filtrado → retorna todas as exposições
    #   - Se pontos foram filtrados → busca os andares únicos desses sensores
    #   Abordagem data-driven: deriva os períodos expositivos diretamente do campo
    #   medicoes.periodo_expositivo, já calculado corretamente pelo recalcular_periodo.
    #   Isso elimina a dependência de correspondência de grafia do campo `andar` do sensor
    import re as _re, unicodedata as _uc

    def _norm2(s):
        """Normaliza string: minúscula, sem acentos, sem ordinais (º U+00BA)."""
        s = (s or "").lower().replace('\u00ba', 'o').replace('\u00aa', 'a')
        s = _uc.normalize("NFD", s)
        s = "".join(c for c in s if _uc.category(c) != "Mn")
        return _re.sub(r'[^\w\s]', ' ', s)

    def _is_2andar(texto):
        """Retorna True se o texto indica 2º andar — testa múltiplas grafias."""
        n = _norm2(texto)
        return bool(_re.search(r'2\s*(o|andar)', n) or
                    _re.search(r'segundo\s*andar', n))

    pontos_filtrados = request.args.getlist("ponto")
    where_expo = ("AND " + filtros[len("WHERE "):].lstrip()) if filtros.startswith("WHERE") else ""

    # Detecta 2º andar checando TANTO o campo `andar` QUANTO o nome do sensor.
    # Razão: dependendo do cadastro, um dos dois pode estar inconsistente.
    # "Acervo em Transformação" cobre o 2º andar desde 2017 (exposição permanente).
    EXPO_2ANDAR_INICIO = "2017-01-01"

    tem_2andar = False
    if pontos_filtrados:
        placeholders = ",".join("?" * len(pontos_filtrados))
        sensores_info = query(
            f"SELECT nome, andar FROM sensores WHERE nome IN ({placeholders})",
            pontos_filtrados
        )
        tem_2andar = any(
            _is_2andar(r["andar"] or "") or _is_2andar(r["nome"] or "")
            for r in sensores_info
        )
    else:
        # Sem filtro de pontos: aplica 2º andar se houver algum sensor ativo nesse andar
        sensores_todos = query("SELECT nome, andar FROM sensores WHERE ativo = 1")
        tem_2andar = any(
            _is_2andar(r["andar"] or "") or _is_2andar(r["nome"] or "")
            for r in sensores_todos
        )

    # Intervalo visível no gráfico (respeita filtros de data ativos)
    periodo = query(f"""
        SELECT MIN(DATE(m.data_hora)) AS ini, MAX(DATE(m.data_hora)) AS fim
        FROM medicoes m
        JOIN sensores s ON m.sensor_id = s.id
        WHERE m.data_hora IS NOT NULL {where_expo}
    """, params)

    ini_dados  = periodo[0]["ini"]  if periodo and periodo[0]["ini"]  else None
    fim_dados  = periodo[0]["fim"]  if periodo and periodo[0]["fim"]  else None
    ini_filtro = (request.args.get("data_ini") or ini_dados or EXPO_2ANDAR_INICIO)[:10]
    fim_filtro = (request.args.get("data_fim") or fim_dados or _date.today().isoformat())[:10]

    exposicoes_raw = []

    if tem_2andar:
        # Acervo em Transformação — permanente desde 2017
        # A faixa começa no máximo entre o início da exposição e o início dos dados visíveis
        inicio_real = max(EXPO_2ANDAR_INICIO, ini_filtro)
        exposicoes_raw = [{"inicio": inicio_real, "termino": fim_filtro}]
    elif ini_dados:
        # Outros sensores: constrói intervalos a partir de medicoes.periodo_expositivo
        dias_expo = query(f"""
            SELECT
                DATE(m.data_hora)         AS dia,
                MAX(m.periodo_expositivo) AS expo
            FROM medicoes m
            JOIN sensores s ON m.sensor_id = s.id
            WHERE m.data_hora IS NOT NULL {where_expo}
            GROUP BY DATE(m.data_hora)
            ORDER BY dia
        """, params)

        inicio_bloco = None
        dia_anterior = None
        for r in dias_expo:
            dia       = r["dia"]
            expo_flag = r["expo"]
            if expo_flag == 1:
                if inicio_bloco is None:
                    inicio_bloco = dia
            else:
                if inicio_bloco is not None:
                    exposicoes_raw.append({"inicio": inicio_bloco, "termino": dia_anterior})
                    inicio_bloco = None
            dia_anterior = dia
        if inicio_bloco is not None and dia_anterior is not None:
            exposicoes_raw.append({"inicio": inicio_bloco, "termino": dia_anterior})

    sql = f"""
        SELECT
            {fmt} as periodo,
            COUNT(*) as medicoes,
            0 as n_expo,
            0 as n_fora_expo,
            ROUND(AVG(m.temperatura), 1) as temp_media,
            ROUND(AVG(m.umidade), 1)     as ur_media,
            ROUND(100.0 * SUM(m.conforme_temperatura) / COUNT(*), 1) as conf_temp_ibram,
            ROUND(100.0 * SUM(m.conforme_umidade)     / COUNT(*), 1) as conf_ur_ibram,
            ROUND(100.0 * SUM(m.conforme_total)        / COUNT(*), 1) as conf_total_ibram,
            ROUND(100.0 * SUM(m.conf_temp_masp)        / COUNT(*), 1) as conf_temp_masp,
            ROUND(100.0 * SUM(m.conf_umid_masp)        / COUNT(*), 1) as conf_ur_masp,
            ROUND(100.0 * SUM(m.conf_total_masp)        / COUNT(*), 1) as conf_masp,
            ROUND(100.0 * SUM(m.conf_temp_bizot)        / COUNT(*), 1) as conf_temp_bizot,
            ROUND(100.0 * SUM(m.conf_umid_bizot)        / COUNT(*), 1) as conf_ur_bizot,
            ROUND(100.0 * SUM(m.conf_total_bizot)       / COUNT(*), 1) as conf_bizot
        FROM medicoes m
        JOIN sensores s ON m.sensor_id = s.id
        {filtros}
        GROUP BY periodo
        ORDER BY periodo
        LIMIT 2000
    """
    rows = query(sql, params)
    # Renomeia 'periodo' → 'mes' para compatibilidade com o frontend existente
    for r in rows:
        r["mes"] = r.pop("periodo")
        # Remove campos obsoletos (substituídos por exposicoes_periodos)
        r.pop("n_expo", None)
        r.pop("n_fora_expo", None)
    resp_payload = {
        "dados": rows,
        "exposicoes": [
            {"inicio": e["inicio"][:10], "termino": e["termino"][:10]}
            for e in exposicoes_raw
        ]
    }
    return jsonify(resp_payload)


# ── API: EVOLUÇÃO MENSAL ──────────────────────────────────
@app.route("/api/mensal")
@optional_auth
@cached_endpoint
def mensal():
    filtros, params = build_filtros()
    sql = f"""
        SELECT
            strftime('%Y-%m', m.data_hora) as mes,
            COUNT(*) as medicoes,
            ROUND(AVG(m.temperatura), 1) as temp_media,
            ROUND(AVG(m.umidade), 1)     as ur_media,
            ROUND(100.0 * SUM(m.conforme_temperatura) / COUNT(*), 1) as conf_temp_ibram,
            ROUND(100.0 * SUM(m.conforme_umidade)     / COUNT(*), 1) as conf_ur_ibram,
            ROUND(100.0 * SUM(m.conforme_total)        / COUNT(*), 1) as conf_total_ibram,
            ROUND(100.0 * SUM(m.conf_temp_masp)        / COUNT(*), 1) as conf_temp_masp,
            ROUND(100.0 * SUM(m.conf_umid_masp)        / COUNT(*), 1) as conf_ur_masp,
            ROUND(100.0 * SUM(m.conf_total_masp)        / COUNT(*), 1) as conf_masp,
            ROUND(100.0 * SUM(m.conf_temp_bizot)        / COUNT(*), 1) as conf_temp_bizot,
            ROUND(100.0 * SUM(m.conf_umid_bizot)        / COUNT(*), 1) as conf_ur_bizot,
            ROUND(100.0 * SUM(m.conf_total_bizot)       / COUNT(*), 1) as conf_bizot
        FROM medicoes m
        JOIN sensores s ON m.sensor_id = s.id
        {filtros}
        GROUP BY mes
        ORDER BY mes
    """
    return jsonify(query(sql, params))


# ── API: DADOS DIÁRIOS ────────────────────────────────────
@app.route("/api/diario")
@optional_auth
@cached_endpoint
def diario():
    filtros, params = build_filtros()
    sql = f"""
        SELECT
            DATE(m.data_hora)    as dia,
            s.nome               as ponto,
            ROUND(AVG(m.temperatura), 2) as temp_media,
            ROUND(AVG(m.umidade), 2)     as ur_media,
            COUNT(*) as medicoes
        FROM medicoes m
        JOIN sensores s ON m.sensor_id = s.id
        {filtros}
        GROUP BY dia, s.id
        ORDER BY dia
    """
    return jsonify(query(sql, params))


# ── API: EXPOSIÇÕES ───────────────────────────────────────
@app.route("/api/exposicoes")
@optional_auth
@cached_endpoint
def exposicoes():
    sql = """
        SELECT
            e.id,
            e.nome,
            e.inicio        as data_inicio,
            e.termino       as data_fim,
            e.espacos,
            COUNT(*)        as medicoes,
            ROUND(100.0 * SUM(CASE WHEN m.conforme_temperatura = 1 AND m.conforme_umidade = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as conf_total_ibram,
            ROUND(100.0 * SUM(CASE WHEN m.conforme_temperatura = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as conf_temp_ibram,
            ROUND(100.0 * SUM(CASE WHEN m.conforme_umidade = 1     THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as conf_ur_ibram,
            ROUND(100.0 * SUM(m.conf_temp_bizot)  / NULLIF(COUNT(*), 0), 1) as conf_temp_bizot,
            ROUND(100.0 * SUM(m.conf_umid_bizot)  / NULLIF(COUNT(*), 0), 1) as conf_ur_bizot,
            ROUND(100.0 * SUM(m.conf_total_bizot) / NULLIF(COUNT(*), 0), 1) as conf_bizot,
            ROUND(100.0 * SUM(m.conf_temp_masp)   / NULLIF(COUNT(*), 0), 1) as conf_temp_masp,
            ROUND(100.0 * SUM(m.conf_umid_masp)   / NULLIF(COUNT(*), 0), 1) as conf_ur_masp,
            ROUND(100.0 * SUM(m.conf_total_masp)  / NULLIF(COUNT(*), 0), 1) as conf_masp
        FROM exposicoes e
        LEFT JOIN medicoes m
            ON m.data_hora BETWEEN e.inicio AND e.termino
        GROUP BY e.id
        ORDER BY e.inicio DESC
    """
    return jsonify(query(sql))


# ── API: ALERTAS ──────────────────────────────────────────
@app.route("/api/alertas")
@optional_auth
@cached_endpoint
def alertas():
    filtros, params = build_filtros()
    # Mapeia filtros de medicoes para a tabela de alertas quando possível
    pontos   = request.args.getlist("ponto")
    data_ini = request.args.get("data_ini")
    data_fim = request.args.get("data_fim")
    clauses = []
    p = []
    if pontos:
        placeholders = ','.join('?' * len(pontos))
        clauses.append(f"s.nome IN ({placeholders})")
        p.extend(pontos)
    if data_ini:
        clauses.append("a.data_inicial >= ?")
        p.append(data_ini)
    if data_fim:
        clauses.append("a.data_inicial <= ?")
        p.append(data_fim + " 23:59:59")
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    sql = f"""
        SELECT
            a.id,
            s.nome              as ponto,
            s.andar             as andar,
            s.predio            as predio,
            a.data_inicial      as data_inicio,
            a.data_final        as data_fim,
            a.umidade_inicial   as ur_inicial,
            a.umidade_final     as ur_final,
            a.variacao_percentual as variacao,
            a.periodo_expositivo
        FROM alertas_variacao_umidade a
        JOIN sensores s ON a.sensor_id = s.id
        {where}
        ORDER BY a.data_inicial DESC
        LIMIT 500
    """
    return jsonify(query(sql, p))


# ── API: ALERTAS CALCULADOS ───────────────────────────────
@app.route("/api/alertas/calcular")
@optional_auth
@cached_endpoint
def calcular_alertas():
    """
    Calcula alertas de variação brusca de UR diretamente das medições.
    Usa CTE para evitar subconsultas correlacionadas — mais eficiente
    com grandes volumes de dados.
    """
    filtros, params = build_filtros()
    # where_inner: converte WHERE em AND para uso dentro do CTE
    where_inner = ("AND " + filtros[len("WHERE "):].lstrip()) if filtros.startswith("WHERE") else ""
    sql = f"""
        WITH diarios AS (
            SELECT
                m.sensor_id,
                DATE(m.data_hora)     AS dia,
                MIN(m.umidade)        AS ur_min,
                MAX(m.umidade)        AS ur_max,
                MAX(m.periodo_expositivo) AS periodo_expositivo
            FROM medicoes m
            JOIN sensores s ON m.sensor_id = s.id
            WHERE m.umidade IS NOT NULL
            {where_inner}
            GROUP BY m.sensor_id, DATE(m.data_hora)
            HAVING (MAX(m.umidade) - MIN(m.umidade)) > 10
        )
        SELECT
            s.nome   AS ponto,
            s.andar  AS andar,
            s.predio AS predio,
            d.dia,
            d.ur_min,
            d.ur_max,
            ROUND(d.ur_max - d.ur_min, 1) AS variacao,
            d.periodo_expositivo,
            (SELECT m2.data_hora FROM medicoes m2
             WHERE m2.sensor_id = d.sensor_id
               AND DATE(m2.data_hora) = d.dia
               AND m2.umidade = d.ur_min
             ORDER BY m2.data_hora LIMIT 1) AS data_inicio,
            (SELECT m2.data_hora FROM medicoes m2
             WHERE m2.sensor_id = d.sensor_id
               AND DATE(m2.data_hora) = d.dia
               AND m2.umidade = d.ur_max
             ORDER BY m2.data_hora LIMIT 1) AS data_fim
        FROM diarios d
        JOIN sensores s ON s.id = d.sensor_id
        ORDER BY variacao DESC
        LIMIT 500
    """
    return jsonify(query(sql, params))


# ── API: DESVIOS PREVIEW (para tabela interativa) ─────────────────────────
@app.route("/api/desvios-preview")
@optional_auth
def desvios_preview():
    """
    Retorna TODOS os desvios para múltiplos sensores (para visualização e justificativa).
    Calcula desvios on-the-fly comparando medicoes contra padrões de conformidade.
    
    Parâmetros:
      ?sensores=ponto1,ponto2,...  (separados por vírgula)
      ?data_ini=YYYY-MM-DD
      ?data_fim=YYYY-MM-DD
      ?padrao=1|2|3
    
    Retorno:
      [{
        sensor, data_hora, temperatura, umidade,
        desvio_tipos, temp_min, temp_max, umid_min, umid_max,
        justificativa (string vazia se não há)
      }, ...]
    """
    sensores_str = request.args.get("sensores", "").strip()
    data_ini = request.args.get("data_ini", "")
    data_fim = request.args.get("data_fim", "")
    padrao = int(request.args.get("padrao", "2"))
    
    if not sensores_str or not data_ini or not data_fim:
        return jsonify({"erro": "sensores, data_ini e data_fim são obrigatórios"}), 400
    
    sensores_lista = [s.strip() for s in sensores_str.split(",")]
    
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    
    # Busca padrões de conformidade
    padroes = con.execute(
        "SELECT id, temp_minima, temp_maxima, umidade_minima, umidade_maxima, nome FROM padroes_conformidade WHERE id = ?",
        (padrao,)
    ).fetchone()
    
    if not padroes:
        return jsonify([])
    
    temp_min = padroes['temp_minima']
    temp_max = padroes['temp_maxima']
    umid_min = padroes['umidade_minima']
    umid_max = padroes['umidade_maxima']
    
    try:
        desvios_todos = []
        
        for sensor_nome in sensores_lista:
            sensor = con.execute(
                "SELECT id FROM sensores WHERE nome = ?",
                (sensor_nome,)
            ).fetchone()
            
            if not sensor:
                continue
            
            sensor_id = sensor['id']
            
            # Busca TODAS as medições para este sensor no período
            medicoes = con.execute("""
                SELECT 
                    m.id,
                    m.data_hora,
                    m.temperatura,
                    m.umidade
                FROM medicoes m
                WHERE m.sensor_id = ? 
                  AND m.data_hora BETWEEN ? AND ?
                ORDER BY m.data_hora
            """, (sensor_id, data_ini + " 00:00:00", data_fim + " 23:59:59")).fetchall()
            
            # Calcula desvios on-the-fly para cada medição
            for med in medicoes:
                temperatura = med['temperatura']
                umidade = med['umidade']
                
                # Verifica conformidade
                temp_acima = 1 if temperatura > temp_max else 0
                temp_abaixo = 1 if temperatura < temp_min else 0
                umid_acima = 1 if umidade > umid_max else 0
                umid_abaixo = 1 if umidade < umid_min else 0
                
                # Se há algum desvio, adiciona à lista
                if temp_acima or temp_abaixo or umid_acima or umid_abaixo:
                    desvio_tipos = []
                    if temp_acima:
                        desvio_tipos.append('temp_acima')
                    if temp_abaixo:
                        desvio_tipos.append('temp_abaixo')
                    if umid_acima:
                        desvio_tipos.append('umid_acima')
                    if umid_abaixo:
                        desvio_tipos.append('umid_abaixo')
                    
                    desvios_todos.append({
                        'sensor': sensor_nome,
                        'data_hora': med['data_hora'],
                        'temperatura': temperatura,
                        'umidade': umidade,
                        'temp_min': temp_min,
                        'temp_max': temp_max,
                        'umid_min': umid_min,
                        'umid_max': umid_max,
                        'desvio_tipos': desvio_tipos,
                        'justificativa': '',
                    })
        
        return jsonify(desvios_todos)
    
    finally:
        con.close()


# ── API: META (filtros dinânicos) ─────────────────────────
@app.route("/api/meta")
@optional_auth
@cached_endpoint
def meta():
    pontos = query("""
        SELECT nome, COALESCE(andar, 'Sem andar') as andar, COALESCE(predio, 'Lina') as predio
        FROM sensores WHERE ativo = 1
        ORDER BY predio, andar NULLS LAST, nome
    """)
    # Aliases (nomes antigos) de cada sensor — usados pelo frontend para sugerir o sensor
    # certo ao importar um XLSX cujo nome de arquivo bate com um nome antigo (ex.: Pietro).
    aliases_por_nome = {}
    for r in query("""
        SELECT s.nome, a.alias FROM sensores_aliases a
        JOIN sensores s ON s.id = a.sensor_id WHERE s.ativo = 1
    """):
        aliases_por_nome.setdefault(r["nome"], []).append(r["alias"])
    for p in pontos:
        p["aliases"] = aliases_por_nome.get(p["nome"], [])

    anos = [r["ano"] for r in query(
        "SELECT DISTINCT strftime('%Y', data_hora) as ano FROM medicoes ORDER BY ano"
    )]

    # Detecta sensor externo: procura por nome/localizacao/andar contendo
    # variações de "terreo" (com ou sem acento, maiúsculas/minúsculas).
    # A coluna localizacao pode não existir em bancos criados antes da migração —
    # verificamos dinamicamente para evitar OperationalError.
    sensor_externo = None
    try:
        _cols = {r["name"] for r in query("PRAGMA table_info(sensores)")}
        _loc_clause = "OR localizacao LIKE '%rreo%'" if "localizacao" in _cols else ""
        candidatos = query(f"""
            SELECT nome FROM sensores WHERE ativo = 1
            AND (
                nome  LIKE '%rreo%'
                {_loc_clause}
                OR andar LIKE '%rreo%'
            )
            ORDER BY nome LIMIT 1
        """)
        if candidatos:
            sensor_externo = candidatos[0]["nome"]
    except Exception:
        pass

    # Data mais recente no banco — usada pelo frontend para definir o período padrão
    ultima = query("SELECT MAX(DATE(data_hora)) as ultima FROM medicoes")
    ultima_medicao = ultima[0]["ultima"] if ultima and ultima[0]["ultima"] else None

    return jsonify({
        "pontos": pontos,
        "anos": anos,
        "sensor_externo": sensor_externo,
        "ultima_medicao": ultima_medicao,
    })


_ESTACOES_ORDEM = ("Verão", "Outono", "Inverno", "Primavera")
_ESTACOES_MESES = {
    "Verão": (12, 1, 2), "Outono": (3, 4, 5), "Inverno": (6, 7, 8), "Primavera": (9, 10, 11),
}
# mês (1-12) → índice da estação em _ESTACOES_ORDEM — usado no laço quente do /api/sazonal
# (~3M linhas): indexar uma lista por inteiro é bem mais barato que 2 lookups de dict por
# string (estação, tipo) repetidos milhões de vezes.
_MES_PARA_ESTACAO_IDX = {
    mes: i for i, nome in enumerate(_ESTACOES_ORDEM) for mes in _ESTACOES_MESES[nome]
}


def _percentil(valores_ordenados, p):
    """Percentil por interpolação linear (mesmo método do padrão 'linear' do numpy/Excel).
    Espera uma lista JÁ ORDENADA."""
    n = len(valores_ordenados)
    if n == 0:
        return None
    if n == 1:
        return valores_ordenados[0]
    idx = (n - 1) * p
    lo = int(idx)
    hi = min(lo + 1, n - 1)
    frac = idx - lo
    return valores_ordenados[lo] + (valores_ordenados[hi] - valores_ordenados[lo]) * frac


# ── API: PERFIL SAZONAL (Verão/Outono/Inverno/Primavera) ──
@app.route("/api/sazonal")
@optional_auth
@cached_endpoint(ttl=3600)  # varre o histórico inteiro (~3M linhas) — caro demais pra TTL padrão de 5min
def sazonal():
    """
    Perfil sazonal de temperatura e UR: para cada estação do ano, compara a mediana e o
    IQR (p25–p75) do conjunto de sensores internos ("interno") contra o sensor externo de
    referência ("externo", ex.: Térreo). Usa o histórico completo — ignora ponto/data,
    porque precisa de múltiplos anos para um padrão sazonal representativo — e só respeita
    (opcionalmente) o filtro de periodo_expositivo.

    Parâmetros:
      ?externo=<nome do sensor de referência>  (padrão: Térreo, mesma heurística do /api/meta)
      ?periodo_expositivo=1|0                  (opcional)

    Retorno: lista de até 8 objetos (4 estações × interno/externo), cada um com
    temp_p25/p50/p75/min/max/media e ur_p25/p50/p75/min/max/media.
    """
    externo_nome = request.args.get("externo", "Térreo")
    periodo = request.args.get("periodo_expositivo")

    con = get_db()
    try:
        # Resolve o sensor externo — mesma heurística fuzzy do /api/meta (nome/andar com "rreo")
        externo_row = con.execute("SELECT id FROM sensores WHERE nome = ?", (externo_nome,)).fetchone()
        if not externo_row:
            externo_row = con.execute(
                "SELECT id FROM sensores WHERE nome LIKE '%rreo%' OR andar LIKE '%rreo%' LIMIT 1"
            ).fetchone()
        externo_id = externo_row["id"] if externo_row else None

        sql = """
            SELECT CAST(strftime('%m', data_hora) AS INTEGER) AS mes, sensor_id, temperatura, umidade
            FROM medicoes
            WHERE temperatura IS NOT NULL AND umidade IS NOT NULL
        """
        params = []
        if periodo in ("0", "1"):
            sql += " AND periodo_expositivo = ?"
            params.append(int(periodo))

        # Um único passe sobre a tabela — percentil exato via ORDER BY/OFFSET custaria um
        # sort inteiro por (estação × tipo × percentil), muito mais caro que isso.
        # Usa uma cursor à parte com row_factory=None (tuplas cruas): sqlite3.Row tem
        # overhead de construção por linha que pesa muito num laço de ~3M iterações, e
        # aqui só desempacotamos por posição mesmo, não por nome de coluna.
        # slot = estacao_idx*2 + (0=interno, 1=externo)
        temp_buckets = [[] for _ in range(8)]
        umid_buckets = [[] for _ in range(8)]
        cur = con.cursor()
        cur.row_factory = None
        for mes, sensor_id, temp, umid in cur.execute(sql, params):
            idx = _MES_PARA_ESTACAO_IDX.get(mes)
            if idx is None:
                continue
            slot = idx * 2 + (1 if sensor_id == externo_id else 0)
            temp_buckets[slot].append(temp)
            umid_buckets[slot].append(umid)

        resultado = []
        for i, estacao in enumerate(_ESTACOES_ORDEM):
            for j, tipo in enumerate(("interno", "externo")):
                temps = temp_buckets[i * 2 + j]
                umids = umid_buckets[i * 2 + j]
                if not temps:
                    continue
                temps.sort()
                umids.sort()
                resultado.append({
                    "estacao": estacao, "tipo": tipo,
                    "temp_p25": round(_percentil(temps, 0.25), 1),
                    "temp_p50": round(_percentil(temps, 0.50), 1),
                    "temp_p75": round(_percentil(temps, 0.75), 1),
                    "temp_min": round(temps[0], 1),
                    "temp_max": round(temps[-1], 1),
                    "temp_media": round(sum(temps) / len(temps), 1),
                    "ur_p25": round(_percentil(umids, 0.25), 1),
                    "ur_p50": round(_percentil(umids, 0.50), 1),
                    "ur_p75": round(_percentil(umids, 0.75), 1),
                    "ur_min": round(umids[0], 1),
                    "ur_max": round(umids[-1], 1),
                    "ur_media": round(sum(umids) / len(umids), 1),
                })
        return jsonify(resultado)
    finally:
        con.close()


# ── API: SÉRIE TEMPORAL (para relatórios) ─────────────────
@app.route("/api/serie")
@optional_auth
def serie():
    filtros, params = build_filtros()
    # Limite seguro: 50k pontos por request (~25MB JSON)
    # O frontend já faz subsample para 500 pontos nos gráficos
    LIMIT = 50000
    sql = f"""
        SELECT
            m.data_hora,
            s.nome  AS ponto,
            s.andar AS andar,
            m.temperatura,
            m.umidade,
            m.periodo_expositivo,
            m.periodo_expositivo_nome /* Incluído para o relatório */
        FROM medicoes m
        JOIN sensores s ON m.sensor_id = s.id
        {filtros}
        ORDER BY m.data_hora
        LIMIT {LIMIT + 1}
    """
    rows = query(sql, params)
    truncated = len(rows) > LIMIT
    if truncated:
        rows = rows[:LIMIT]
    resp = jsonify(rows)
    if truncated:
        resp.headers["X-Truncated"] = "true"
        resp.headers["X-Truncated-Limit"] = str(LIMIT)
    return resp



# ── API: SÉRIE PARA GRÁFICO DE PONTO DE ORVALHO ──────────
@app.route("/api/orvalho_serie")
@optional_auth
@cached_endpoint
def orvalho_serie():
    """
    Retorna série temporal de T, UR e Td agregados para o gráfico
    de dinâmica diária. Agrega automaticamente por hora ou por dia
    dependendo do período filtrado:
      ≤ 3 dias  → agrega por hora  (até ~72 pontos por sensor)
      > 3 dias  → agrega por dia   (até ~365 pontos por sensor)

    Parâmetros: ponto (obrigatório), data_ini, data_fim,
                periodo_expositivo (via build_filtros)

    Retorno por ponto no tempo:
      dt        — label formatado (YYYY-MM-DD HH ou YYYY-MM-DD)
      t_med     — mediana da temperatura
      ur_med    — mediana da umidade relativa
      td_med    — mediana do ponto de orvalho calculado
    """
    filtros, params = build_filtros()
    where_extra = ("AND " + filtros[len("WHERE "):].lstrip()) if filtros.startswith("WHERE") else ""

    if not request.args.get("ponto", "").strip():
        return jsonify({"erro": "ponto é obrigatório"}), 400

    # Determina granularidade pelo período filtrado
    data_ini = request.args.get("data_ini", "")
    data_fim = request.args.get("data_fim", "")
    por_hora = False
    if data_ini and data_fim:
        try:
            d0 = _date.fromisoformat(data_ini[:10])
            d1 = _date.fromisoformat(data_fim[:10])
            por_hora = (d1 - d0).days <= 3
        except Exception:
            pass

    fmt = "strftime('%Y-%m-%d %H', m.data_hora)" if por_hora \
          else "strftime('%Y-%m-%d', m.data_hora)"

    sql = f"""
        SELECT
            {fmt} AS dt,
            m.temperatura,
            m.umidade
        FROM medicoes m
        JOIN sensores s ON m.sensor_id = s.id
        WHERE m.temperatura IS NOT NULL
          AND m.umidade      IS NOT NULL
          AND m.temperatura != -99
          AND m.umidade > 0
        {where_extra}
        ORDER BY dt
    """
    rows = query(sql, params)
    if not rows:
        return jsonify([])

    # Agrega por bucket (mediana)
    def percentil50(lst):
        if not lst: return None
        s = sorted(lst)
        n = len(s)
        m = n // 2
        return round(s[m] if n % 2 else (s[m-1] + s[m]) / 2, 1)

    buckets = {}
    for r in rows:
        dt = r["dt"]
        if dt is None:
            continue
        if dt not in buckets:
            buckets[dt] = {"t": [], "ur": []}
        buckets[dt]["t"].append(r["temperatura"])
        buckets[dt]["ur"].append(r["umidade"])

    resultado = []
    for dt in sorted(buckets):
        t_med  = percentil50(buckets[dt]["t"])
        ur_med = percentil50(buckets[dt]["ur"])
        td_med = calcular_ponto_orvalho(t_med, ur_med) if t_med and ur_med else None
        resultado.append({
            "dt":     dt,
            "t_med":  t_med,
            "ur_med": ur_med,
            "td_med": td_med,
        })

    return jsonify(resultado)


# ── DETECÇÃO DE PICOS PÓS-UPLOAD ─────────────────────────
def _detectar_picos(periodo_inicio: str, periodo_fim: str) -> list:
    """
    Analisa os dados do período recém-importado e detecta desvios sustentados
    e variações bruscas, respeitando a lógica híbrida (andar do sensor).
    """
    con = get_db()
    try:
        # Busca leituras e a informação do andar para aplicar limites corretos
        rows = con.execute("""
            SELECT
                m.sensor_id,
                s.nome        AS sensor_nome,
                s.predio      AS predio,
                s.andar       AS andar,
                m.data_hora,
                m.temperatura,
                m.umidade
            FROM medicoes m
            JOIN sensores s ON s.id = m.sensor_id
            WHERE m.data_hora BETWEEN ? AND ?
              AND m.umidade      IS NOT NULL
              AND m.temperatura  IS NOT NULL
              AND m.temperatura  != -99
            ORDER BY m.sensor_id, m.data_hora
        """, (periodo_inicio, periodo_fim)).fetchall()
    finally:
        con.close()

    if not rows:
        return []

    por_sensor = defaultdict(list)
    for r in rows:
        por_sensor[r["sensor_id"]].append(dict(r))

    picos = []
    JANELA_24H = 86400 
    UR_VAR_THRESH = 10.0 # Variação brusca em p.p.
    CONSECUTIVAS = 4     # Número de leituras para considerar "sustentado"

    for sensor_id, leituras in por_sensor.items():
        sensor_nome = leituras[0]["sensor_nome"]
        predio      = leituras[0]["predio"] or "Lina"
        andar       = (leituras[0]["andar"] or "").lower()

        # Determina os limites dinâmicos para este sensor (Lógica Híbrida)
        if '1o andar' in andar or '1º andar' in andar or 'primeiro' in andar:
            t_min, t_max = 18.0, 23.0
            ur_min, ur_max = 45.0, 55.0
            padrao_nome = "MASP"
        else:
            t_min, t_max = 15.0, 25.0
            ur_min, ur_max = 40.0, 60.0
            padrao_nome = "Bizot"

        # ── 1. Variação brusca de UR (Súbita) ────────────────
        for i in range(len(leituras) - 1):
            a, b = leituras[i], leituras[i + 1]
            try:
                ta = _dt.fromisoformat(a["data_hora"].replace("Z", ""))
                tb = _dt.fromisoformat(b["data_hora"].replace("Z", ""))
                if abs((tb - ta).total_seconds()) > JANELA_24H: continue
            except: continue

            variacao = abs(float(b["umidade"]) - float(a["umidade"]))
            if variacao >= UR_VAR_THRESH:
                dir_symbol = "↑" if b["umidade"] > a["umidade"] else "↓"
                picos.append({
                    "sensor_id": sensor_id, "sensor_nome": sensor_nome, "predio": predio,
                    "tipo": "pico_automatico", "data_inicio": a["data_hora"], "data_fim": b["data_hora"],
                    "categoria": "variacao_ur", "variacao": round(variacao, 1),
                    "descricao": f"Variação brusca de UR: {dir_symbol} {variacao:.1f} p.p. ({a['umidade']:.1f}% → {b['umidade']:.1f}%) (Limites {padrao_nome})."
                })

        # ── 2. Desvios Sustentados (T e UR) ───────────────────
        def detectar_sustentado(campo, c_min, c_max, label_unidade):
            seq = []
            for l in leituras:
                val = float(l[campo])
                if val < c_min or val > c_max:
                    seq.append(l)
                else:
                    if len(seq) >= CONSECUTIVAS:
                        vals = [float(x[campo]) for x in seq]
                        tipo_erro = "baixa" if min(vals) < c_min else "alta"
                        extremo = min(vals) if tipo_erro == "baixa" else max(vals)
                        picos.append({
                            "sensor_id": sensor_id, "sensor_nome": sensor_nome, "predio": predio,
                            "tipo": "pico_automatico", "data_inicio": seq[0]["data_hora"], "data_fim": seq[-1]["data_hora"],
                            "categoria": campo,
                            "descricao": f"{campo.capitalize()} {tipo_erro} sustentada: {extremo:.1f}{label_unidade} por {len(seq)} leituras (Padrão {padrao_nome})."
                        })
                    seq = []
        
        detectar_sustentado('temperatura', t_min, t_max, '°C')
        detectar_sustentado('umidade', ur_min, ur_max, '%')

    picos.sort(key=lambda x: x.get("variacao", 0), reverse=True)
    return picos[:50]


# ── API: UPLOAD DE JSON ───────────────────────────────────
@app.route("/api/upload", methods=["POST"])
@optional_auth
def upload():
    if "file" not in request.files:
        return jsonify({"erro": "Nenhum arquivo enviado"}), 400

    f = request.files["file"]
    try:
        data = json.load(f)
    except Exception as e:
        return jsonify({"erro": f"JSON inválido: {e}"}), 400

    rows = data if isinstance(data, list) else data.get("dados_brutos", [])
    arquivo_nome = f.filename or "upload"
    periodo_inicio, periodo_fim = None, None

    con = get_db()

    # Pré-carrega exposições com seus espaços para cruzamento por andar/espaço do sensor
    # (lógica de cruzamento compartilhada com /api/admin/recalcular_periodo — ver _expositivo_para)
    _exposicoes = con.execute(
        "SELECT nome, predio, inicio, termino, espacos FROM exposicoes WHERE inicio IS NOT NULL AND termino IS NOT NULL"
    ).fetchall()

    # Pré-carrega prédio/andar/espaço-expositivo de cada sensor para evitar queries dentro do loop
    _sensor_info = {
        r["id"]: r
        for r in con.execute("SELECT id, predio, andar, espaco_expositivo FROM sensores").fetchall()
    }
    inserted = 0
    duplicates = 0
    errors = 0
    _sensor_cache = {}
    _sensores_novos_lista = []  # acumula sensores criados para revisão no frontend

    try:
        for row in rows:
            try:
                sensor_nome = row.get("ponto") or row.get("sensor")
                sensor_id = resolve_sensor(con, sensor_nome, _sensor_cache, _sensores_novos_lista)
                if not sensor_id:
                    errors += 1
                    continue

                data_hora = row.get("data_hora") or row.get("data")
                temp      = row.get("temperatura")
                umid      = row.get("umidade") or row.get("umidade_relativa")
                # Calcula periodo_expositivo cruzando com exposições do mesmo espaço/andar.
                # _expositivo_para devolve o NOME da exposição (ou None) — o flag 0/1 gravado em
                # periodo_expositivo é derivado dele; o nome vai para periodo_expositivo_nome.
                _info = _sensor_info.get(sensor_id)
                predio_sensor = _info["predio"] if _info else 'Lina'
                andar_sensor = _info["andar"] if _info else ''
                espaco_expositivo = _info["espaco_expositivo"] if _info else 1
                periodo_nome = _expositivo_para(data_hora, predio_sensor, andar_sensor, _exposicoes, espaco_expositivo)
                periodo_flag = 1 if periodo_nome else 0

                # Usa calcular_conformidade como fonte única de verdade — os limites
                # ficam centralizados em conformidade.py e não duplicados aqui.
                (conf_temp, conf_umid, conf_total,
                 conf_temp_masp, conf_umid_masp, conf_total_masp,
                 conf_temp_bizot, conf_umid_bizot, conf_total_bizot) = calcular_conformidade(temp, umid)

                con.execute("""
                    INSERT OR IGNORE INTO medicoes
                        (sensor_id, data_hora, temperatura, umidade, periodo_expositivo, periodo_expositivo_nome,
                         conforme_temperatura, conforme_umidade, conforme_total,
                         conf_temp_masp, conf_umid_masp, conf_total_masp,
                         conf_temp_bizot, conf_umid_bizot, conf_total_bizot)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    sensor_id, data_hora, temp, umid, periodo_flag, periodo_nome,
                    conf_temp, conf_umid, conf_total,
                    conf_temp_masp, conf_umid_masp, conf_total_masp,
                    conf_temp_bizot, conf_umid_bizot, conf_total_bizot,
                ))
                if con.execute("SELECT changes()").fetchone()[0]:
                    inserted += 1
                    if data_hora:
                        if periodo_inicio is None or data_hora < periodo_inicio:
                            periodo_inicio = data_hora
                        if periodo_fim is None or data_hora > periodo_fim:
                            periodo_fim = data_hora
                else:
                    duplicates += 1
            except Exception:
                errors += 1
                continue

        sensores_novos = len(_sensores_novos_lista)

        # Registra na tabela de importações
        obs = f"Importação realizada em {_dt.now().strftime('%Y-%m-%d %H:%M:%S')}. Erros: {errors}"
        con.execute("""
            INSERT INTO importacoes
                (arquivo_nome, data_importacao, total_medicoes, medicoes_importadas,
                 medicoes_duplicadas, sensores_novos, periodo_inicio, periodo_fim, status, observacoes)
            VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, 'SUCESSO', ?)
        """, (arquivo_nome, len(rows), inserted, duplicates, sensores_novos, periodo_inicio, periodo_fim, obs))

        con.commit()
    except Exception as e:
        con.rollback()
        return jsonify({"erro": f"Erro na importação: {e}"}), 500
    finally:
        con.close()

    # Dados novos no banco — invalida todo o cache de queries
    cache_invalidate()

    # ── Detecção de picos nos dados recém-importados ──────
    picos_sugeridos = []
    if inserted > 0 and periodo_inicio and periodo_fim:
        try:
            picos_sugeridos = _detectar_picos(periodo_inicio, periodo_fim)
        except Exception:
            pass  # detecção é best-effort — não bloqueia o upload

    return jsonify({
        "status": "ok",
        "lidas": len(rows),
        "importadas": inserted,
        "duplicadas": duplicates,
        "sensores_novos_lista": _sensores_novos_lista,
        "picos_sugeridos": picos_sugeridos,
    })


# ── API: UPLOAD DE XLSX (dataloggers do Pietro) ───────────
@app.route("/api/upload_xlsx", methods=["POST"])
@optional_auth
def upload_xlsx():
    """
    Importa uma planilha .xlsx no formato dos dataloggers do Pietro: colunas
    "Time stamp" (DD/MM/AAAA HH:MM:SS), "Temperatura Ambiente" e "Umidade Ambiente" —
    sem coluna de sensor, porque cada arquivo cobre um único ponto de medição.
    Por isso o sensor é informado à parte, no campo `sensor` do form (nome do sensor,
    resolvido com a mesma lógica fuzzy/alias do upload de JSON).
    """
    if "file" not in request.files:
        return jsonify({"erro": "Nenhum arquivo enviado"}), 400

    sensor_nome = (request.form.get("sensor") or "").strip()
    if not sensor_nome:
        return jsonify({"erro": "Selecione o sensor ao qual esses dados pertencem"}), 400

    try:
        import openpyxl
    except ImportError:
        return jsonify({"erro": "openpyxl não está instalado no servidor (pip install openpyxl)"}), 500

    f = request.files["file"]
    arquivo_nome = f.filename or "upload.xlsx"

    try:
        wb = openpyxl.load_workbook(f, read_only=True, data_only=True)
        ws = wb.active
        rows_iter = ws.iter_rows(values_only=True)
        header = next(rows_iter)
    except Exception as e:
        return jsonify({"erro": f"XLSX inválido: {e}"}), 400

    # Detecta qual coluna é qual pelo texto do cabeçalho — tolera variações de
    # acento/caixa/idioma (ex.: "Time stamp", "Data/Hora", "Temperatura Ambiente")
    col_data = col_temp = col_umid = None
    for idx, h in enumerate(header or []):
        hn = _normalizar_texto(str(h) if h is not None else '')
        if col_data is None and ('time' in hn or 'data' in hn or 'hora' in hn):
            col_data = idx
        elif col_temp is None and 'temp' in hn:
            col_temp = idx
        elif col_umid is None and ('umid' in hn or 'humid' in hn):
            col_umid = idx

    if col_data is None or col_temp is None or col_umid is None:
        return jsonify({
            "erro": f"Não reconheci as colunas da planilha (cabeçalho: {list(header or [])}). "
                    "Esperado algo como 'Time stamp', 'Temperatura Ambiente', 'Umidade Ambiente'."
        }), 400

    con = get_db()
    try:
        _sensor_cache = {}
        _sensores_novos_lista = []
        sensor_id = resolve_sensor(con, sensor_nome, _sensor_cache, _sensores_novos_lista)
        if not sensor_id:
            return jsonify({"erro": f"Não foi possível resolver o sensor '{sensor_nome}'"}), 400

        sensor_row = con.execute(
            "SELECT predio, andar, espaco_expositivo FROM sensores WHERE id = ?", (sensor_id,)
        ).fetchone()
        predio_sensor      = sensor_row["predio"] if sensor_row else 'Lina'
        andar_sensor       = sensor_row["andar"] if sensor_row else ''
        espaco_expositivo  = sensor_row["espaco_expositivo"] if sensor_row else 1

        _exposicoes = con.execute(
            "SELECT nome, predio, inicio, termino, espacos FROM exposicoes WHERE inicio IS NOT NULL AND termino IS NOT NULL"
        ).fetchall()

        inserted = duplicates = errors = 0
        periodo_inicio = periodo_fim = None

        for row in rows_iter:
            try:
                raw_data = row[col_data]
                temp     = row[col_temp]
                umid     = row[col_umid]
                if raw_data is None or temp is None or umid is None:
                    errors += 1
                    continue

                # A maioria dos exports vem como texto "DD/MM/AAAA HH:MM:SS"; se a célula
                # já vier tipada como data (openpyxl devolve datetime), usa direto.
                if isinstance(raw_data, str):
                    dt = _dt.strptime(raw_data.strip(), "%d/%m/%Y %H:%M:%S")
                elif hasattr(raw_data, "strftime"):
                    dt = raw_data
                else:
                    errors += 1
                    continue
                data_hora = dt.strftime("%Y-%m-%d %H:%M:%S")

                periodo_nome = _expositivo_para(data_hora, predio_sensor, andar_sensor, _exposicoes, espaco_expositivo)
                periodo_flag = 1 if periodo_nome else 0

                (conf_temp, conf_umid, conf_total,
                 conf_temp_masp, conf_umid_masp, conf_total_masp,
                 conf_temp_bizot, conf_umid_bizot, conf_total_bizot) = calcular_conformidade(float(temp), float(umid))

                con.execute("""
                    INSERT OR IGNORE INTO medicoes
                        (sensor_id, data_hora, temperatura, umidade, periodo_expositivo, periodo_expositivo_nome,
                         conforme_temperatura, conforme_umidade, conforme_total,
                         conf_temp_masp, conf_umid_masp, conf_total_masp,
                         conf_temp_bizot, conf_umid_bizot, conf_total_bizot)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    sensor_id, data_hora, float(temp), float(umid), periodo_flag, periodo_nome,
                    conf_temp, conf_umid, conf_total,
                    conf_temp_masp, conf_umid_masp, conf_total_masp,
                    conf_temp_bizot, conf_umid_bizot, conf_total_bizot,
                ))
                if con.execute("SELECT changes()").fetchone()[0]:
                    inserted += 1
                    if periodo_inicio is None or data_hora < periodo_inicio:
                        periodo_inicio = data_hora
                    if periodo_fim is None or data_hora > periodo_fim:
                        periodo_fim = data_hora
                else:
                    duplicates += 1
            except Exception:
                errors += 1
                continue

        total_lidas = inserted + duplicates + errors
        obs = (f"Importação XLSX (dataloggers Pietro) em {_dt.now().strftime('%Y-%m-%d %H:%M:%S')}. "
               f"Sensor: {sensor_nome}. Erros: {errors}")
        con.execute("""
            INSERT INTO importacoes
                (arquivo_nome, data_importacao, total_medicoes, medicoes_importadas,
                 medicoes_duplicadas, sensores_novos, periodo_inicio, periodo_fim, status, observacoes)
            VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, 'SUCESSO', ?)
        """, (arquivo_nome, total_lidas, inserted, duplicates, len(_sensores_novos_lista),
              periodo_inicio, periodo_fim, obs))
        con.commit()
    except Exception as e:
        con.rollback()
        return jsonify({"erro": f"Erro na importação: {e}"}), 500
    finally:
        con.close()

    cache_invalidate()

    picos_sugeridos = []
    if inserted > 0 and periodo_inicio and periodo_fim:
        try:
            picos_sugeridos = _detectar_picos(periodo_inicio, periodo_fim)
        except Exception:
            pass  # detecção é best-effort — não bloqueia o upload

    return jsonify({
        "status": "ok",
        "lidas": total_lidas,
        "importadas": inserted,
        "duplicadas": duplicates,
        "sensores_novos_lista": _sensores_novos_lista,
        "picos_sugeridos": picos_sugeridos,
    })


# ── HELPER: CONSTRUTOR DE FILTROS ─────────────────────────
def build_filtros(ignorar_periodo: bool = False):
    """
    Constrói cláusula WHERE e lista de parâmetros a partir dos query params da request.

    ignorar_periodo=True — omite o filtro de periodo_expositivo. Usado pelo endpoint
    /api/agregado para manter a continuidade das curvas do gráfico temporal: o frontend
    recebe n_expo/n_fora_expo por período e desenha as faixas de contexto por conta própria.
    """
    clauses = []
    params  = []

    pontos = request.args.getlist("ponto")
    if pontos:
        placeholders = ','.join('?' * len(pontos))
        clauses.append(f"s.nome IN ({placeholders})")
        params.extend(pontos)

    if not ignorar_periodo:
        periodo = request.args.get("periodo_expositivo")
        if periodo in ("0", "1"):
            clauses.append("m.periodo_expositivo = ?")
            params.append(int(periodo))

    data_ini = request.args.get("data_ini")
    if data_ini:
        clauses.append("m.data_hora >= ?")
        params.append(data_ini)

    data_fim = request.args.get("data_fim")
    if data_fim:
        clauses.append("m.data_hora <= ?")
        params.append(data_fim + " 23:59:59")

    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    return where, params




# ── API: DISTRIBUIÇÃO HORÁRIA DE NÃO-CONFORMIDADE ────────
@app.route("/api/horario")
@optional_auth
@cached_endpoint
def horario():
    """
    Retorna não-conformidade por hora do dia (00–23) usando os flags
    pré-calculados no banco. Aceita:
      ?padrao=ibram|masp|bizot  (padrão: ibram)
      ?ponto=<nome>             (filtra por sensor; acumulável)
    Demais filtros de build_filtros (data_ini, data_fim,
    periodo_expositivo) são aplicados normalmente.
    """
    padrao = request.args.get("padrao", "ibram").lower()

    # Mapeia padrão → campos de flag no banco
    campos = {
        "ibram": ("conforme_temperatura",  "conforme_umidade"),
        "masp":  ("conf_temp_masp",         "conf_umid_masp"),
        "bizot": ("conf_temp_bizot",        "conf_umid_bizot"),
    }
    if padrao not in campos:
        return jsonify({"erro": f"padrao inválido: {padrao}"}), 400

    col_temp, col_ur = campos[padrao]

    filtros, params = build_filtros()

    sql = f"""
        SELECT
            CAST(strftime('%H', m.data_hora) AS INTEGER) AS hora,
            ROUND(100.0 * SUM(CASE WHEN m.{col_temp} = 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS nc_temp,
            ROUND(100.0 * SUM(CASE WHEN m.{col_ur}   = 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS nc_ur,
            COUNT(*) AS n
        FROM medicoes m
        JOIN sensores s ON m.sensor_id = s.id
        {filtros}
        GROUP BY hora
        ORDER BY hora
    """
    rows = query(sql, params)
    return jsonify(rows)


# ── API: DISTRIBUIÇÃO T×UR (heatmap 2D) ──────────────────
@app.route("/api/dispersao")
@optional_auth
@cached_endpoint
def dispersao():
    filtros, params = build_filtros()
    # Adiciona o filtro de temperatura inválida junto com os outros filtros
    extra = "AND m.temperatura != -99 AND m.temperatura IS NOT NULL"
    if filtros:
        filtros_final = filtros + " " + extra
    else:
        filtros_final = "WHERE m.temperatura != -99 AND m.temperatura IS NOT NULL"
    sql = f"""
        SELECT
            ROUND(m.temperatura, 0) as t,
            ROUND(m.umidade,     0) as ur,
            COUNT(*) as n
        FROM medicoes m
        JOIN sensores s ON m.sensor_id = s.id
        {filtros_final}
        GROUP BY ROUND(m.temperatura,0), ROUND(m.umidade,0)
        ORDER BY n DESC
        LIMIT 2000
    """
    return jsonify(query(sql, params))


# ── API: AMPLITUDE DIÁRIA POR SENSOR ─────────────────────
@app.route("/api/amplitude")
@optional_auth
@cached_endpoint
def amplitude():
    filtros, params = build_filtros()
    # A condição de temperatura precisa estar no subquery
    where_inner = ("AND " + filtros[len("WHERE "):].lstrip()) if filtros.startswith("WHERE") else ""
    sql = f"""
        SELECT
            s.nome  AS ponto,
            s.andar AS andar,
            ROUND(AVG(diaria.amp_ur),  1) AS amp_ur_media,
            ROUND(MAX(diaria.amp_ur),  1) AS amp_ur_max,
            ROUND(AVG(diaria.amp_t),   1) AS amp_t_media,
            COUNT(diaria.dia)              AS n_dias
        FROM (
            SELECT m.sensor_id,
                   DATE(m.data_hora)            AS dia,
                   MAX(m.umidade)  - MIN(m.umidade)     AS amp_ur,
                   MAX(m.temperatura) - MIN(m.temperatura) AS amp_t
            FROM medicoes m
            WHERE m.temperatura != -99
            {where_inner}
            GROUP BY m.sensor_id, DATE(m.data_hora)
        ) diaria
        JOIN sensores s ON s.id = diaria.sensor_id
        GROUP BY s.id
        ORDER BY amp_ur_media DESC
    """
    try:
        return jsonify(query(sql, params))
    except Exception as e:
        # Loga o erro real em vez de engolir silenciosamente
        app.logger.warning(f"amplitude query failed ({e}), retrying without inner filters")
        fallback_sql = """
            SELECT s.nome AS ponto, s.andar AS andar,
                ROUND(AVG(d.amp_ur),1) AS amp_ur_media,
                ROUND(MAX(d.amp_ur),1) AS amp_ur_max,
                ROUND(AVG(d.amp_t),1)  AS amp_t_media,
                COUNT(d.dia)            AS n_dias
            FROM (
                SELECT sensor_id, DATE(data_hora) AS dia,
                    MAX(umidade)-MIN(umidade) AS amp_ur,
                    MAX(temperatura)-MIN(temperatura) AS amp_t
                FROM medicoes WHERE temperatura != -99
                GROUP BY sensor_id, DATE(data_hora)
            ) d JOIN sensores s ON s.id = d.sensor_id
            GROUP BY s.id ORDER BY amp_ur_media DESC
        """
        return jsonify(query(fallback_sql))


# ── API: ALERTAS MENSAIS (variação >10pp em 24h) ─────────
@app.route("/api/alertas/mensal")
@optional_auth
@cached_endpoint
def alertas_mensal():
    sql = """
        SELECT sub.mes, COUNT(*) AS n_alertas
        FROM (
            SELECT sensor_id,
                   strftime('%Y-%m', data_hora) AS mes,
                   DATE(data_hora)              AS dia,
                   MAX(umidade) - MIN(umidade)  AS variacao
            FROM medicoes
            GROUP BY sensor_id, DATE(data_hora)
            HAVING variacao > 10
        ) sub
        GROUP BY sub.mes
        ORDER BY sub.mes
    """
    return jsonify(query(sql))


# ── ADMIN: SENSORES ──────────────────────────────────────
@app.route("/api/admin/sensores", methods=["GET"])
@optional_auth
def admin_sensores_list():
    sensores = query("SELECT * FROM sensores ORDER BY predio, andar, nome")
    # Anexa aliases a cada sensor
    aliases_map = {}
    for a in query("SELECT sensor_id, id, alias FROM sensores_aliases ORDER BY alias"):
        aliases_map.setdefault(a["sensor_id"], []).append({"id": a["id"], "alias": a["alias"]})
    for s in sensores:
        s["aliases"] = aliases_map.get(s["id"], [])
    return jsonify(sensores)

@app.route("/api/admin/sensores", methods=["POST"])
@optional_auth
def admin_sensores_create():
    d = request.get_json()
    if not d or not d.get("nome"):
        return jsonify({"erro": "nome é obrigatório"}), 400
    predio = d.get("predio") or ("Pietro" if "Pietro" in d["nome"] else "Lina")
    con = get_db()
    try:
        con.execute(
            "INSERT INTO sensores (nome, localizacao, andar, descricao, ativo, data_instalacao, predio, espaco_expositivo) VALUES (?,?,?,?,?,?,?,?)",
            (d["nome"], d.get("localizacao"), d.get("andar"), d.get("descricao"),
             d.get("ativo", 1), d.get("data_instalacao"), predio, d.get("espaco_expositivo", 1))
        )
        new_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        con.commit()
        return jsonify({"status": "ok", "id": new_id}), 201
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 400
    finally:
        con.close()

@app.route("/api/admin/sensores/<int:sid>", methods=["PUT"])
@optional_auth
def admin_sensores_update(sid):
    d = request.get_json()
    if not d or not d.get("nome"):
        return jsonify({"erro": "nome é obrigatório"}), 400
    predio = d.get("predio") or ("Pietro" if "Pietro" in d["nome"] else "Lina")
    con = get_db()
    try:
        con.execute(
            "UPDATE sensores SET nome=?, localizacao=?, andar=?, descricao=?, ativo=?, data_instalacao=?, predio=?, espaco_expositivo=? WHERE id=?",
            (d["nome"], d.get("localizacao"), d.get("andar"), d.get("descricao"),
             d.get("ativo", 1), d.get("data_instalacao"), predio, d.get("espaco_expositivo", 1), sid)
        )
        con.commit()
        return jsonify({"status": "ok"})
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 400
    finally:
        con.close()

@app.route("/api/admin/sensores/<int:sid>", methods=["DELETE"])
@optional_auth
def admin_sensores_delete(sid):
    con = get_db()
    try:
        con.execute("DELETE FROM sensores WHERE id=?", (sid,))
        con.commit()
        return jsonify({"status": "ok"})
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 400
    finally:
        con.close()


# ── ADMIN: MERGE DE SENSORES ──────────────────────────────
@app.route("/api/admin/sensores/merge", methods=["POST"])
@optional_auth
def admin_sensores_merge():
    """
    Funde sensor_origem no sensor_destino:
      1. Reassina todas as medições de origem → destino
      2. Cria alias em sensor_destino com o nome de origem
      3. Migra aliases existentes de origem → destino
      4. Exclui o sensor origem
    Body JSON: { "origem_id": int, "destino_id": int }
    """
    d = request.get_json() or {}
    origem_id  = d.get("origem_id")
    destino_id = d.get("destino_id")
    if not origem_id or not destino_id:
        return jsonify({"erro": "origem_id e destino_id são obrigatórios"}), 400
    if origem_id == destino_id:
        return jsonify({"erro": "origem e destino não podem ser o mesmo sensor"}), 400

    con = get_db()
    try:
        origem = con.execute("SELECT nome FROM sensores WHERE id=?", (origem_id,)).fetchone()
        if not origem:
            con.close()
            return jsonify({"erro": "Sensor origem não encontrado"}), 404

        # 1. Reassina medições
        con.execute(
            "UPDATE medicoes SET sensor_id=? WHERE sensor_id=?",
            (destino_id, origem_id)
        )
        medicoes_migradas = con.execute("SELECT changes()").fetchone()[0]

        # 2. Cria alias com o nome original
        con.execute(
            "INSERT OR IGNORE INTO sensores_aliases (sensor_id, alias) VALUES (?,?)",
            (destino_id, origem["nome"])
        )

        # 3. Migra aliases existentes de origem para destino
        con.execute(
            "UPDATE OR IGNORE sensores_aliases SET sensor_id=? WHERE sensor_id=?",
            (destino_id, origem_id)
        )
        # Remove eventuais aliases de origem que colidiram (já existiam em destino)
        con.execute("DELETE FROM sensores_aliases WHERE sensor_id=?", (origem_id,))

        # 4. Exclui sensor origem
        con.execute("DELETE FROM sensores WHERE id=?", (origem_id,))

        con.commit()
        return jsonify({
            "status": "ok",
            "medicoes_migradas": medicoes_migradas,
            "alias_criado": origem["nome"],
        })
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 500
    finally:
        con.close()


# ── ADMIN: ALIASES ────────────────────────────────────────
@app.route("/api/admin/sensores/<int:sid>/aliases", methods=["GET"])
@optional_auth
def admin_aliases_list(sid):
    return jsonify(query(
        "SELECT id, alias, criado_em FROM sensores_aliases WHERE sensor_id = ? ORDER BY alias",
        [sid]
    ))

@app.route("/api/admin/sensores/<int:sid>/aliases", methods=["POST"])
@optional_auth
def admin_aliases_create(sid):
    d = request.get_json()
    alias = (d or {}).get("alias", "").strip()
    if not alias:
        return jsonify({"erro": "alias é obrigatório"}), 400
    con = get_db()
    try:
        con.execute(
            "INSERT INTO sensores_aliases (sensor_id, alias) VALUES (?, ?)", (sid, alias)
        )
        con.commit()
        new_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        return jsonify({"status": "ok", "id": new_id}), 201
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 400
    finally:
        con.close()

@app.route("/api/admin/aliases/<int:aid>", methods=["DELETE"])
@optional_auth
def admin_aliases_delete(aid):
    con = get_db()
    try:
        con.execute("DELETE FROM sensores_aliases WHERE id=?", (aid,))
        con.commit()
        return jsonify({"status": "ok"})
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 400
    finally:
        con.close()



# ── ADMIN: EXPOSIÇÕES ─────────────────────────────────────
@app.route("/api/admin/exposicoes", methods=["GET"])
@optional_auth
def admin_exposicoes_list():
    return jsonify(query("SELECT * FROM exposicoes ORDER BY inicio DESC"))

@app.route("/api/admin/exposicoes", methods=["POST"])
@optional_auth
def admin_exposicoes_create():
    d = request.get_json()
    if not d or not d.get("nome") or not d.get("inicio") or not d.get("termino"):
        return jsonify({"erro": "nome, inicio e termino são obrigatórios"}), 400
    con = get_db()
    try:
        con.execute(
            """INSERT INTO exposicoes (ano, nome, inicio_preparacao, inicio, termino, termino_desmontagem, espacos, predio)
               VALUES (?,?,?,?,?,?,?,?)""",
            (d.get("ano"), d["nome"], d.get("inicio_preparacao"),
             d["inicio"], d["termino"], d.get("termino_desmontagem"), d.get("espacos"), d.get("predio", "Lina"))
        )
        con.commit()
        new_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        return jsonify({"status": "ok", "id": new_id}), 201
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 400
    finally:
        con.close()

@app.route("/api/admin/exposicoes/<int:eid>", methods=["PUT"])
@optional_auth
def admin_exposicoes_update(eid):
    d = request.get_json()
    if not d or not d.get("nome") or not d.get("inicio") or not d.get("termino"):
        return jsonify({"erro": "nome, inicio e termino são obrigatórios"}), 400
    con = get_db()
    try:
        con.execute(
            """UPDATE exposicoes SET ano=?, nome=?, inicio_preparacao=?, inicio=?, termino=?,
               termino_desmontagem=?, espacos=?, predio=? WHERE id=?""",
            (d.get("ano"), d["nome"], d.get("inicio_preparacao"),
             d["inicio"], d["termino"], d.get("termino_desmontagem"), d.get("espacos"), d.get("predio", "Lina"), eid)
        )
        con.commit()
        return jsonify({"status": "ok"})
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 400
    finally:
        con.close()

@app.route("/api/admin/exposicoes/<int:eid>", methods=["DELETE"])
@optional_auth
def admin_exposicoes_delete(eid):
    con = get_db()
    try:
        con.execute("DELETE FROM exposicoes WHERE id=?", (eid,))
        con.commit()
        return jsonify({"status": "ok"})
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 400
    finally:
        con.close()

# ── ADMIN: IMPORTAÇÕES E RECÁLCULO ────────────────────────
@app.route("/api/admin/importacoes", methods=["GET"])
@optional_auth
def admin_importacoes_list():
    return jsonify(query("SELECT * FROM importacoes ORDER BY data_importacao DESC LIMIT 100"))

@app.route("/api/admin/recalcular_periodo", methods=["POST"])
@optional_auth
def admin_recalcular_periodo():
    """
    Recalcula periodo_expositivo/periodo_expositivo_nome de TODAS as medições já
    importadas, cruzando com o estado atual da tabela exposicoes.

    Necessário sempre que uma exposição é cadastrada ou editada DEPOIS que as medições
    do período já foram importadas — o /api/upload só calcula o cruzamento uma vez, no
    momento da importação, então dados já no banco não são atualizados sozinhos.

    Usa UPDATEs em lote por (grupo de andar × exposição) em vez de percorrer medição por
    medição em Python — o resultado é o mesmo de _expositivo_para, só que muito mais rápido
    em bancos grandes.
    """
    con = get_db()
    try:
        # 1. Zera tudo — recomeça do zero para não deixar nome/flag desatualizados de
        #    exposições que foram editadas ou removidas
        con.execute("UPDATE medicoes SET periodo_expositivo = 0, periodo_expositivo_nome = NULL")

        # Só considera sensores marcados como espaço expositivo — Ateliê de Restauro,
        # Reservas Técnicas, CP etc. ficam no mesmo andar de galerias mas não são expositivos
        sensores = [
            s for s in con.execute("SELECT id, predio, andar FROM sensores WHERE espaco_expositivo = 1").fetchall()
        ]
        exposicoes = con.execute(
            "SELECT nome, predio, inicio, termino, espacos FROM exposicoes WHERE inicio IS NOT NULL AND termino IS NOT NULL"
        ).fetchall()

        sensores_processados_ids = set()

        # 2. 2º andar do Lina — acervo fixo permanente, vale para todas as datas. NÃO se aplica
        #    ao 2º Andar do Pietro (mesmo número, prédio diferente, exposição temporária normal).
        acervo_permanente_ids = [s["id"] for s in sensores if _eh_acervo_permanente(s["predio"], s["andar"])]
        if acervo_permanente_ids:
            placeholders = ",".join("?" * len(acervo_permanente_ids))
            con.execute(
                f"UPDATE medicoes SET periodo_expositivo = 1, periodo_expositivo_nome = ? "
                f"WHERE sensor_id IN ({placeholders})",
                ["Acervo em Transformação"] + acervo_permanente_ids
            )
            sensores_processados_ids.update(acervo_permanente_ids)

        # 3. Demais andares — cruza cada exposição com os sensores do MESMO PRÉDIO cujo andar
        #    bate com o espaço correspondente. Aplica em ordem reversa à da lista de exposições:
        #    como _expositivo_para (usado no upload) retorna a PRIMEIRA exposição da lista que
        #    bate em caso de sobreposição de datas no mesmo espaço, aplicar de trás para frente
        #    faz o UPDATE dessa primeira exposição ser o último a rodar — e por isso prevalecer.
        exposicoes_usadas = 0
        for expo in reversed(exposicoes):
            expo_predio = expo["predio"] if "predio" in expo.keys() else None
            sensor_ids = [
                s["id"] for s in sensores
                if s["id"] not in acervo_permanente_ids
                and (not expo_predio or expo_predio in (s["predio"] or 'Lina', 'Ambos'))
                and _andar_keywords_for(s["predio"], s["andar"])
                and any(
                    _normalizar_texto(kw) in _normalizar_texto(expo["espacos"] or '')
                    for kw in _andar_keywords_for(s["predio"], s["andar"])
                )
            ]
            if not sensor_ids:
                continue
            placeholders = ",".join("?" * len(sensor_ids))
            con.execute(
                f"UPDATE medicoes SET periodo_expositivo = 1, periodo_expositivo_nome = ? "
                f"WHERE sensor_id IN ({placeholders}) AND date(data_hora) BETWEEN date(?) AND date(?)",
                [expo["nome"]] + sensor_ids + [expo["inicio"], expo["termino"]]
            )
            sensores_processados_ids.update(sensor_ids)
            exposicoes_usadas += 1

        # Conta o resultado final direto no banco — evita contagem duplicada quando duas
        # exposições sobrepõem datas no mesmo espaço (a mesma medição seria tocada 2x pelos UPDATEs acima)
        total = con.execute("SELECT COUNT(*) AS n FROM medicoes").fetchone()["n"]
        marcadas_expositivo = con.execute(
            "SELECT COUNT(*) AS n FROM medicoes WHERE periodo_expositivo = 1"
        ).fetchone()["n"]

        con.commit()
        cache_invalidate()
        return jsonify({
            "status": "ok",
            "marcadas_expositivo": marcadas_expositivo,
            "fora_expositivo": max(total - marcadas_expositivo, 0),
            "exposicoes_usadas": exposicoes_usadas,
            "sensores_processados": len(sensores_processados_ids),
        })
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 500
    finally:
        con.close()

# ── API: OCORRÊNCIAS (Leitura e Exclusão) ─────────────────
@app.route("/api/ocorrencias")
@optional_auth
def ocorrencias_list():
    sensor_id = request.args.get("sensor_id")
    predio    = request.args.get("predio")
    data_ini  = request.args.get("data_ini")
    data_fim  = request.args.get("data_fim")

    clauses = []
    params  = []

    if predio and predio != "Ambos":
        clauses.append("(o.predio = ? OR o.predio = 'Ambos')")
        params.append(predio)
    if data_ini:
        clauses.append("o.data_inicio >= ?")
        params.append(data_ini)
    if data_fim:
        clauses.append("o.data_inicio <= ?")
        params.append(data_fim + " 23:59:59")

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    if sensor_id:
        sql = f"""
            SELECT DISTINCT o.*
            FROM ocorrencias o
            LEFT JOIN ocorrencias_sensores os ON os.ocorrencia_id = o.id
            {where}
            {"AND" if where else "WHERE"} (
                o.afeta_predio_todo = 1
                OR os.sensor_id = ?
            )
            ORDER BY o.data_inicio DESC
        """
        params.append(sensor_id)
    else:
        sql = f"""
            SELECT o.*
            FROM ocorrencias o
            {where}
            ORDER BY o.data_inicio DESC
        """

    ocorrs = query(sql, params)

    if ocorrs:
        ids = [o["id"] for o in ocorrs]
        placeholders = ",".join("?" * len(ids))
        sensores_map = {}
        for row in query(f"""
            SELECT os.ocorrencia_id, s.id as sensor_id, s.nome, s.andar, s.predio
            FROM ocorrencias_sensores os
            JOIN sensores s ON s.id = os.sensor_id
            WHERE os.ocorrencia_id IN ({placeholders})
            ORDER BY s.nome
        """, ids):
            sensores_map.setdefault(row["ocorrencia_id"], []).append({
                "id": row["sensor_id"], "nome": row["nome"],
                "andar": row["andar"], "predio": row["predio"]
            })
        for o in ocorrs:
            o["sensores"] = sensores_map.get(o["id"], [])

    return jsonify(ocorrs)

@app.route("/api/admin/ocorrencias/<int:oid>", methods=["DELETE"])
@optional_auth
def admin_ocorrencias_delete(oid):
    con = get_db()
    try:
        # A exclusão aqui apaga automaticamente os vínculos graças ao ON DELETE CASCADE
        con.execute("DELETE FROM ocorrencias WHERE id = ?", (oid,))
        con.commit()
        return jsonify({"status": "ok"})
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 400
    finally:
        con.close()

@app.route("/api/admin/ocorrencias", methods=["POST"])
@optional_auth
def admin_ocorrencias_create():
    d = request.get_json() or {}
    con = get_db()

    campos_obrigatorios = ["data_inicio", "predio", "tipo", "fonte", "descricao"]
    for campo in campos_obrigatorios:
        if not d.get(campo):
            con.close()
            return jsonify({"erro": f"{campo} é obrigatório"}), 400

    try:
        afeta_predio_todo = 1 if d.get("afeta_predio_todo") else 0
        con.execute("""
            INSERT INTO ocorrencias
                (data_inicio, data_fim, predio, tipo, fonte,
                 descricao, responsavel, justificativa, afeta_predio_todo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            d["data_inicio"], d.get("data_fim"),
            d["predio"], d["tipo"], d["fonte"],
            d["descricao"], d.get("responsavel"), d.get("justificativa"), afeta_predio_todo
        ))
        new_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]

        # Aceita qualquer nome de variável e insere na tabela oficial
        sensores = d.get("sensores", d.get("sensor_ids", d.get("sensor", [])))
        if not afeta_predio_todo and isinstance(sensores, list):
            for sid in sensores:
                con.execute("INSERT OR IGNORE INTO ocorrencias_sensores (ocorrencia_id, sensor_id) VALUES (?, ?)", (new_id, int(sid)))

        con.commit()
        return jsonify({"status": "ok", "id": new_id}), 201
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 400
    finally:
        con.close()


@app.route("/api/admin/ocorrencias/<int:oid>", methods=["PUT"])
@optional_auth
def admin_ocorrencias_update(oid):
    d = request.get_json() or {}
    con = get_db()

    campos_obrigatorios = ["data_inicio", "predio", "tipo", "fonte", "descricao"]
    for campo in campos_obrigatorios:
        if not d.get(campo):
            con.close()
            return jsonify({"erro": f"{campo} é obrigatório"}), 400

    try:
        afeta_predio_todo = 1 if d.get("afeta_predio_todo") else 0
        con.execute("""
            UPDATE ocorrencias SET
                data_inicio = ?, data_fim = ?, predio = ?, tipo = ?, fonte = ?,
                descricao = ?, responsavel = ?, justificativa = ?, afeta_predio_todo = ?
            WHERE id = ?
        """, (
            d["data_inicio"], d.get("data_fim"),
            d["predio"], d["tipo"], d["fonte"],
            d["descricao"], d.get("responsavel"), d.get("justificativa"), afeta_predio_todo, oid
        ))

        con.execute("DELETE FROM ocorrencias_sensores WHERE ocorrencia_id = ?", (oid,))
        
        sensores = d.get("sensores", d.get("sensor_ids", d.get("sensor", [])))
        if not afeta_predio_todo and isinstance(sensores, list):
            for sid in sensores:
                con.execute("INSERT OR IGNORE INTO ocorrencias_sensores (ocorrencia_id, sensor_id) VALUES (?, ?)", (oid, int(sid)))

        con.commit()
        return jsonify({"status": "ok"})
    except Exception as e:
        con.rollback()
        return jsonify({"erro": str(e)}), 400
    finally:
        con.close()

if __name__ == "__main__":
    port  = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_ENV") != "production"
    print(f"✓ Servidor rodando em http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=debug)