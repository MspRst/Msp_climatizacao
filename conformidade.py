"""
conformidade.py — Fonte única de verdade para cálculo de conformidade climática.

Padrões suportados:
  IBRAM  — lido do BD
  MASP   — lido do BD
  Bizot  — lido do BD

Uso:
    from conformidade import calcular_conformidade

    ct, cu, ctot, ctm, cum, ctotm, ctb, cub, ctotb = calcular_conformidade(21.5, 54.0)

Retorno (tupla de 9 inteiros, sempre 0 ou 1):
    conf_temp        — temperatura conforme padrão ativo
    conf_umid        — umidade conforme padrão ativo
    conf_total       — total conforme padrão ativo

    conf_temp_masp   — temperatura conforme MASP
    conf_umid_masp   — umidade conforme MASP
    conf_total_masp  — total conforme MASP

    conf_temp_bizot  — temperatura conforme Bizot
    conf_umid_bizot  — umidade conforme Bizot
    conf_total_bizot — total conforme Bizot
"""

import math
import sqlite3
import os
import time

# ── CONFIGURAÇÃO ──────────────────────────────────────────
DB_PATH = os.environ.get("DB_PATH", "climatizacao_museu.db")

# Cache em memória (para evitar ler BD a cada cálculo)
_PADROES_CACHE = None
_CACHE_TIMESTAMP = None
_CACHE_TTL_SECONDS = 300  # Recarrega a cada 5 minutos


# ── CARREGAR PADRÕES DO BD ────────────────────────────────

def carregar_padroes_do_bd():
    """
    Carrega padrões de conformidade da tabela padroes_conformidade.
    Retorna dict: {id: {temp_min, temp_max, umid_min, umid_max, nome}}
    """
    try:
        con = sqlite3.connect(DB_PATH)
        con.row_factory = sqlite3.Row
        
        padroes = {}
        for row in con.execute(
            "SELECT id, nome, temp_minima, temp_maxima, umidade_minima, umidade_maxima "
            "FROM padroes_conformidade WHERE ativo = 1"
        ):
            padroes[row['id']] = {
                'nome': row['nome'],
                'temp_min': row['temp_minima'],
                'temp_max': row['temp_maxima'],
                'umid_min': row['umidade_minima'],
                'umid_max': row['umidade_maxima'],
            }
        
        con.close()
        return padroes
    
    except (sqlite3.OperationalError, FileNotFoundError) as e:
        # Se BD não existir ou houver erro, retorna valores padrão (fallback)
        print(f"⚠️  Aviso: Não consegui carregar padrões do BD ({e}). Usando valores padrão.")
        return {
            1: {'nome': 'IBRAM',  'temp_min': 18.0, 'temp_max': 22.0, 'umid_min': 50.0, 'umid_max': 60.0},
            2: {'nome': 'MASP',   'temp_min': 18.0, 'temp_max': 23.0, 'umid_min': 45.0, 'umid_max': 55.0},
            3: {'nome': 'BIZOT',  'temp_min': 15.0, 'temp_max': 25.0, 'umid_min': 40.0, 'umid_max': 60.0},
        }


def get_padroes(recarregar=False):
    """
    Retorna cache de padrões. Recarrega do BD se passou 5 minutos.
    """
    global _PADROES_CACHE, _CACHE_TIMESTAMP
    
    agora = time.time()
    
    # Se cache vazio OU passou TTL OU forçar recarrega
    if (recarregar or 
        _PADROES_CACHE is None or 
        _CACHE_TIMESTAMP is None or
        (agora - _CACHE_TIMESTAMP) > _CACHE_TTL_SECONDS):
        
        _PADROES_CACHE = carregar_padroes_do_bd()
        _CACHE_TIMESTAMP = agora
    
    return _PADROES_CACHE

# ── FUNÇÃO PRINCIPAL ──────────────────────────────────────

def calcular_conformidade(temp, umid, padrao_id=1):
    """
    Calcula flags de conformidade para os três padrões museológicos.

    Parâmetros
    ----------
    temp : float | int | str | None
        Temperatura em graus Celsius.
    umid : float | int | str | None
        Umidade relativa em percentual.
    padrao_id : int (opcional, padrão 1)
        ID do padrão principal (1=IBRAM, 2=MASP, 3=BIZOT).
        Não afeta os outros padrões (sempre calcula todos 3).

    Retorno
    -------
    tuple[int, ...] — tupla de 9 inteiros (0 ou 1) na ordem:
        (conf_temp, conf_umid, conf_total,
         conf_temp_masp, conf_umid_masp, conf_total_masp,
         conf_temp_bizot, conf_umid_bizot, conf_total_bizot)

    Quando temp ou umid não puderem ser convertidos para float,
    todos os flags retornam 0 sem lançar exceção.
    """
    try:
        t = float(temp) if temp is not None else None
        u = float(umid)  if umid  is not None else None
    except (TypeError, ValueError):
        return 0, 0, 0, 0, 0, 0, 0, 0, 0

    # Carregar padrões do cache/BD
    padroes = get_padroes()

    # ── IBRAM (padrao_id=1) ──────────────────────────────
    p_ibram = padroes.get(1, {})
    conf_temp = int(t is not None and 
                    p_ibram.get('temp_min', 18.0) <= t <= p_ibram.get('temp_max', 22.0))
    conf_umid = int(u is not None and 
                    p_ibram.get('umid_min', 50.0) <= u <= p_ibram.get('umid_max', 60.0))
    conf_total = int(conf_temp and conf_umid)

    # ── MASP (padrao_id=2) ───────────────────────────────
    p_masp = padroes.get(2, {})
    conf_temp_masp = conf_temp  # temperatura idêntica ao IBRAM
    conf_umid_masp = int(u is not None and 
                         p_masp.get('umid_min', 45.0) <= u <= p_masp.get('umid_max', 55.0))
    conf_total_masp = int(conf_temp_masp and conf_umid_masp)

    # ── BIZOT (padrao_id=3) ──────────────────────────────
    p_bizot = padroes.get(3, {})
    conf_temp_bizot = int(t is not None and 
                          p_bizot.get('temp_min', 15.0) <= t <= p_bizot.get('temp_max', 25.0))
    conf_umid_bizot = int(u is not None and 
                          p_bizot.get('umid_min', 40.0) <= u <= p_bizot.get('umid_max', 60.0))
    conf_total_bizot = int(conf_temp_bizot and conf_umid_bizot)

    return (
        conf_temp,       conf_umid,       conf_total,
        conf_temp_masp,  conf_umid_masp,  conf_total_masp,
        conf_temp_bizot, conf_umid_bizot, conf_total_bizot,
    )

# ── PONTO DE ORVALHO ─────────────────────────────────────

# Constantes de Magnus-Tetens
_MAGNUS_A = 17.625
_MAGNUS_B = 243.04  # °C

# Limiares de risco (IPI — Image Permanence Institute)
ORVALHO_SEGURO_MAX    = 10.0   # Td ≤ 10°C  → zona segura
ORVALHO_ATENCAO_MAX   = 15.0   # 10 < Td ≤ 15°C → atenção
# Td > 15°C → risco de mofo
ORVALHO_CONDENSACAO_MARGEM = 2.0   # Td ≥ T − 2°C → risco de condensação


def calcular_ponto_orvalho(temp, umid):
    """
    Calcula o ponto de orvalho (Td) pela fórmula de Magnus-Tetens.

    Parâmetros
    ----------
    temp : float | None  — Temperatura em °C
    umid : float | None  — Umidade relativa em %

    Retorno
    -------
    float | None — Ponto de orvalho em °C, ou None se entrada inválida.

    Exemplos
    --------
    >>> calcular_ponto_orvalho(20.0, 55.0)
    10.49
    >>> calcular_ponto_orvalho(20.0, 100.0)
    20.0   # Td == T quando UR == 100%
    """
    try:
        t = float(temp)
        u = float(umid)
        if u <= 0 or u > 100 or t == -99:
            return None
        alpha = math.log(u / 100.0) + (_MAGNUS_A * t) / (_MAGNUS_B + t)
        td = (_MAGNUS_B * alpha) / (_MAGNUS_A - alpha)
        return round(td, 2)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def classificar_risco_orvalho(td, temp=None):
    """
    Classifica o risco baseado no ponto de orvalho.

    Retorna uma string: 'seguro' | 'atencao' | 'mold' | 'condensacao'
    A classificação 'condensacao' tem prioridade sobre 'mold'.
    """
    if td is None:
        return None
    if temp is not None:
        try:
            t = float(temp)
            if td >= t - ORVALHO_CONDENSACAO_MARGEM:
                return 'condensacao'
        except (TypeError, ValueError):
            pass
    if td > ORVALHO_ATENCAO_MAX:
        return 'mold'
    if td > ORVALHO_SEGURO_MAX:
        return 'atencao'
    return 'seguro'


# ── UTILITÁRIO: NOMES DOS CAMPOS (para INSERT parametrizado) ──

CAMPOS_CONFORMIDADE = (
    "conforme_temperatura",
    "conforme_umidade",
    "conforme_total",
    "conf_temp_masp",
    "conf_umid_masp",
    "conf_total_masp",
    "conf_temp_bizot",
    "conf_umid_bizot",
    "conf_total_bizot",
)


# ── TESTES RÁPIDOS (python conformidade.py) ───────────────

if __name__ == "__main__":
    # Carregar padrões (para teste)
    print("Padrões carregados:")
    padroes = get_padroes()
    for id, p in sorted(padroes.items()):
        print(f"  {id}. {p['nome']}: T[{p['temp_min']}, {p['temp_max']}], U[{p['umid_min']}, {p['umid_max']}]")
    
    print("\nTestando calcular_conformidade():\n")
    
    casos = [
        # (temp,  umid,   desc)
        (20.0,  55.0,  "Centro IBRAM/MASP/Bizot — tudo conforme"),
        (20.0,  52.0,  "Dentro IBRAM e Bizot, fora MASP (UR baixa)"),
        (20.0,  58.0,  "Dentro IBRAM e Bizot, fora MASP (UR alta)"),
        (23.0,  50.0,  "Fora IBRAM/MASP temp, dentro Bizot"),
        (26.0,  50.0,  "Fora todos (temp alta)"),
        (20.0,  38.0,  "Fora todos (UR baixa)"),
        (20.0,  None,  "Umidade ausente"),
        (None,  55.0,  "Temperatura ausente"),
        (None,  None,  "Ambos ausentes"),
        ("abc", 55.0,  "Temperatura inválida"),
        (0.0,   0.0,   "Zeros explícitos — não devem ser descartados"),
    ]

    header = f"{'Temp':>6}  {'UR':>6}  {'IB':>3}  {'MS':>3}  {'BZ':>3}  Descrição"
    print(header)
    print("─" * len(header))

    for temp, umid, desc in casos:
        r = calcular_conformidade(temp, umid)
        conf_ibram = r[2]   # conf_total
        conf_masp  = r[5]   # conf_total_masp
        conf_bizot = r[8]   # conf_total_bizot
        t_str = f"{temp:>6.1f}" if isinstance(temp, (int, float)) else f"{'–':>6}"
        u_str = f"{umid:>6.1f}" if isinstance(umid, (int, float)) else f"{'–':>6}"
        ib = "✓" if conf_ibram else "✗"
        ms = "✓" if conf_masp  else "✗"
        bz = "✓" if conf_bizot else "✗"
        print(f"{t_str}  {u_str}  {ib:>3}  {ms:>3}  {bz:>3}  {desc}")
