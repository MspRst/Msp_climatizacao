"""
Script auxiliar para importar dados para o banco MASP.

Uso:
  python import_dados.py --sqlite /caminho/para/origem.db
  python import_dados.py --sqlite /caminho/para/origem.db --tabela nome_tabela
  python import_dados.py --json   /caminho/para/export.json
  python import_dados.py --xlsx   /caminho/para/planilha.xlsx
  python import_dados.py --exposicoes /caminho/para/exposicoes.json

Variável de ambiente:
  DB_PATH  — caminho para o banco destino (padrão: climatizacao_museu.db)

Formato esperado para medições (JSON/XLSX/SQLite):
  Cada linha deve ter:
    - ponto ou sensor  → nome do sensor (obrigatório)
    - data_hora ou data → timestamp ISO (obrigatório)
    - temperatura       → número real
    - umidade ou umidade_relativa → número real
    - periodo_expositivo → 0 ou 1 (opcional, padrão 0)

Formato esperado para exposições (JSON):
  Lista de objetos com:
    - nome              → texto (obrigatório)
    - ano               → inteiro (obrigatório)
    - inicio            → data ISO YYYY-MM-DD (obrigatório)
    - termino           → data ISO YYYY-MM-DD (obrigatório)
    - inicio_preparacao → data ISO (opcional)
    - termino_desmontagem → data ISO (opcional)
    - espacos           → texto (opcional)
"""

import argparse
import sqlite3
import json
import os
import re
import sys
import unicodedata
from datetime import datetime
from conformidade import calcular_conformidade


# ── CONFIGURAÇÃO ──────────────────────────────────────────
DEST_DB = os.environ.get("DB_PATH", "climatizacao_museu.db")


# ── HELPERS ───────────────────────────────────────────────
def get_dest():
    con = sqlite3.connect(DEST_DB)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    return con


def normalize_name(s):
    """Remove acentos, pontuação e caixa para comparação fuzzy de nomes de sensores."""
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-z0-9]', '', s.lower())


def resolver_sensor(con, sensor_nome, cache, sensores_novos_count):
    """
    Resolve sensor_id pelo nome em 4 camadas:
      1. Cache em memória
      2. Match exato em sensores.nome
      3. Match fuzzy em sensores.nome (ignora acentos/pontuação/caixa)
      4. Match por alias (sensores_aliases) — exato e depois fuzzy
      5. Auto-criação se não encontrado
    Retorna (sensor_id, sensores_novos_count).
    """
    if sensor_nome in cache:
        return cache[sensor_nome], sensores_novos_count

    row = None

    # 1. Match exato
    row = con.execute("SELECT id FROM sensores WHERE nome = ?", (sensor_nome,)).fetchone()

    # 2. Match fuzzy em sensores.nome
    if not row:
        norm = normalize_name(sensor_nome)
        for s in con.execute("SELECT id, nome FROM sensores").fetchall():
            if normalize_name(s["nome"]) == norm:
                row = s
                break

    # 3. Alias — exato
    if not row:
        row = con.execute("""
            SELECT s.id FROM sensores_aliases a
            JOIN sensores s ON s.id = a.sensor_id
            WHERE a.alias = ?
        """, (sensor_nome,)).fetchone()

    # 4. Alias — fuzzy
    if not row:
        norm = normalize_name(sensor_nome)
        for a in con.execute("SELECT sensor_id, alias FROM sensores_aliases").fetchall():
            if normalize_name(a["alias"]) == norm:
                row = con.execute("SELECT id FROM sensores WHERE id = ?", (a["sensor_id"],)).fetchone()
                break

    # 5. Auto-criação
    if not row:
        predio = "Pietro" if "Pietro" in sensor_nome else "Lina"
        con.execute(
            "INSERT OR IGNORE INTO sensores (nome, ativo, predio) VALUES (?, 1, ?)",
            (sensor_nome, predio)
        )
        row = con.execute("SELECT id FROM sensores WHERE nome = ?", (sensor_nome,)).fetchone()
        sensores_novos_count += 1
        print(f"  ✦ Novo sensor criado: {sensor_nome}")

    sensor_id = row["id"] if row else None
    cache[sensor_nome] = sensor_id
    return sensor_id, sensores_novos_count


def inserir_medicao(con, sensor_id, data_hora, temp, umid, periodo):
    """Insere uma medição com conformidade calculada. Retorna 'inserted', 'duplicate' ou 'error'."""
    ct, cu, ctot, ctm, cum, ctotm, ctb, cub, ctotb = calcular_conformidade(temp, umid)
    try:
        con.execute("""
            INSERT OR IGNORE INTO medicoes
                (sensor_id, data_hora, temperatura, umidade, periodo_expositivo,
                 conforme_temperatura, conforme_umidade, conforme_total,
                 conf_temp_masp, conf_umid_masp, conf_total_masp,
                 conf_temp_bizot, conf_umid_bizot, conf_total_bizot)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (sensor_id, data_hora, temp, umid, int(periodo or 0),
              ct, cu, ctot, ctm, cum, ctotm, ctb, cub, ctotb))
        changed = con.execute("SELECT changes()").fetchone()[0]
        return "inserted" if changed else "duplicate"
    except Exception as e:
        return f"error: {e}"


def registrar_importacao(con, arquivo_nome, total, inserted, duplicates, sensores_novos,
                          periodo_inicio, periodo_fim, errors):
    obs = f"Importação via import_dados.py em {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}. Erros: {errors}"
    con.execute("""
        INSERT INTO importacoes
            (arquivo_nome, data_importacao, total_medicoes, medicoes_importadas,
             medicoes_duplicadas, sensores_novos, periodo_inicio, periodo_fim, status, observacoes)
        VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, 'SUCESSO', ?)
    """, (arquivo_nome, total, inserted, duplicates, sensores_novos,
          periodo_inicio, periodo_fim, obs))


def _primeiro(*chaves, d):
    """Retorna o primeiro valor não-None de d para as chaves dadas. Preserva 0 e 0.0."""
    for k in chaves:
        v = d.get(k)
        if v is not None:
            return v
    return None


def processar_linha(row):
    """Extrai campos padronizados de um dict com nomenclatura variável."""
    return {
        "sensor_nome":  row.get("ponto") or row.get("sensor") or row.get("nome"),
        "data_hora":    row.get("data_hora") or row.get("data"),
        "temperatura":  _primeiro("temperatura", "temp", d=row),
        "umidade":      _primeiro("umidade", "umidade_relativa", "ur", d=row),
        "periodo":      row.get("periodo_expositivo", 0),
    }


def importar_rows(rows, arquivo_nome, con):
    """Loop central de importação — usado por todas as fontes."""
    inserted = duplicates = errors = sensores_novos = 0
    periodo_inicio = periodo_fim = None
    cache = {}

    for row in rows:
        try:
            r = processar_linha(row)
            sensor_nome = r["sensor_nome"]
            data_hora   = r["data_hora"]

            if not sensor_nome or not data_hora:
                errors += 1
                continue

            sensor_id, sensores_novos = resolver_sensor(con, sensor_nome, cache, sensores_novos)
            if sensor_id is None:
                errors += 1
                continue

            resultado = inserir_medicao(con, sensor_id, data_hora,
                                        r["temperatura"], r["umidade"], r["periodo"])
            if resultado == "inserted":
                inserted += 1
                dh = str(data_hora)
                if periodo_inicio is None or dh < periodo_inicio:
                    periodo_inicio = dh
                if periodo_fim is None or dh > periodo_fim:
                    periodo_fim = dh
            elif resultado == "duplicate":
                duplicates += 1
            else:
                errors += 1

        except Exception as e:
            errors += 1
            print(f"  ⚠ Erro na linha: {e}")

    con.commit()
    registrar_importacao(con, arquivo_nome, len(rows), inserted, duplicates,
                         sensores_novos, periodo_inicio, periodo_fim, errors)
    con.commit()

    print(f"\n  ✓ {inserted:,} inseridas  |  {duplicates:,} duplicadas  |  {errors} erros  |  {sensores_novos} sensores novos")
    return inserted, duplicates, errors


# ── IMPORTAR DE OUTRO SQLITE ──────────────────────────────
def importar_sqlite(origem_path, tabela_origem="medicoes"):
    print(f"→ Banco origem: {origem_path}  (tabela: {tabela_origem})")
    origem = sqlite3.connect(origem_path)
    origem.row_factory = sqlite3.Row

    colunas = [r[1] for r in origem.execute(f"PRAGMA table_info({tabela_origem})").fetchall()]
    print(f"  Colunas: {colunas}")

    total = origem.execute(f"SELECT COUNT(*) FROM {tabela_origem}").fetchone()[0]
    print(f"  {total:,} registros")

    BATCH = 10_000
    dest = get_dest()
    inserted = duplicates = errors = sensores_novos = 0
    periodo_inicio = periodo_fim = None
    cache = {}

    # Registra importação como PENDENTE antes de começar — garante rastreabilidade
    # mesmo que o script seja interrompido no meio
    dest.execute("""
        INSERT INTO importacoes (arquivo_nome, status, observacoes)
        VALUES (?, 'PENDENTE', 'Importação iniciada via import_dados.py')
    """, (os.path.basename(origem_path),))
    importacao_id = dest.execute("SELECT last_insert_rowid()").fetchone()[0]
    dest.commit()

    for offset in range(0, total, BATCH):
        batch = origem.execute(
            f"SELECT * FROM {tabela_origem} LIMIT {BATCH} OFFSET {offset}"
        ).fetchall()

        for row in batch:
            try:
                r = processar_linha(dict(row))
                sensor_nome = r["sensor_nome"]
                data_hora   = r["data_hora"]

                if not sensor_nome or not data_hora:
                    errors += 1
                    continue

                sensor_id, sensores_novos = resolver_sensor(dest, sensor_nome, cache, sensores_novos)
                if sensor_id is None:
                    errors += 1
                    continue

                resultado = inserir_medicao(dest, sensor_id, data_hora,
                                            r["temperatura"], r["umidade"], r["periodo"])
                if resultado == "inserted":
                    inserted += 1
                    dh = str(data_hora)
                    if periodo_inicio is None or dh < periodo_inicio:
                        periodo_inicio = dh
                    if periodo_fim is None or dh > periodo_fim:
                        periodo_fim = dh
                elif resultado == "duplicate":
                    duplicates += 1
                else:
                    errors += 1
            except Exception as e:
                errors += 1
                print(f"  ⚠ Linha ignorada: {e}")

        dest.commit()
        pct = min((offset + BATCH) / total * 100, 100)
        print(f"  {pct:.0f}%  —  {inserted:,} inseridas, {duplicates:,} duplicadas", end="\r")

    # Atualiza registro para SUCESSO com os totais finais
    obs = f"Importação via import_dados.py em {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}. Erros: {errors}"
    dest.execute("""
        UPDATE importacoes SET
            status = 'SUCESSO', total_medicoes = ?, medicoes_importadas = ?,
            medicoes_duplicadas = ?, sensores_novos = ?,
            periodo_inicio = ?, periodo_fim = ?, observacoes = ?
        WHERE id = ?
    """, (total, inserted, duplicates, sensores_novos,
          periodo_inicio, periodo_fim, obs, importacao_id))
    dest.commit()

    print(f"\n  ✓ {inserted:,} inseridas  |  {duplicates:,} duplicadas  |  {errors} erros  |  {sensores_novos} sensores novos")
    origem.close()
    dest.close()


# ── IMPORTAR JSON ─────────────────────────────────────────
def importar_json(json_path):
    print(f"→ JSON: {json_path}")
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    rows = data if isinstance(data, list) else data.get("dados_brutos", [])
    print(f"  {len(rows):,} registros")

    dest = get_dest()
    importar_rows(rows, os.path.basename(json_path), dest)
    dest.close()


# ── IMPORTAR XLSX ─────────────────────────────────────────
def importar_xlsx(xlsx_path):
    try:
        import openpyxl
    except ImportError:
        print("Instale openpyxl:  pip install openpyxl")
        sys.exit(1)

    print(f"→ XLSX: {xlsx_path}")
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb.active

    headers = [str(c.value).lower().strip() if c.value else "" for c in next(ws.iter_rows(min_row=1, max_row=1))]
    print(f"  Colunas: {headers}")

    rows = [dict(zip(headers, row)) for row in ws.iter_rows(min_row=2, values_only=True)]
    print(f"  {len(rows):,} registros")

    dest = get_dest()
    importar_rows(rows, os.path.basename(xlsx_path), dest)
    dest.close()


# ── IMPORTAR EXPOSIÇÕES ───────────────────────────────────
def importar_exposicoes(json_path):
    """
    Importa exposições de um JSON.
    Formato: [{nome, ano, inicio, termino, inicio_preparacao?, termino_desmontagem?, espacos?}]
    """
    print(f"→ Exposições: {json_path}")
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    exposicoes = data if isinstance(data, list) else data.get("exposicoes", [])
    dest = get_dest()
    inserted = errors = 0

    for e in exposicoes:
        nome    = e.get("nome")
        ano     = e.get("ano")
        inicio  = e.get("inicio")
        termino = e.get("termino")

        if not all([nome, ano, inicio, termino]):
            print(f"  ⚠ Registro incompleto ignorado: {e}")
            errors += 1
            continue

        try:
            dest.execute("""
                INSERT OR IGNORE INTO exposicoes
                    (nome, ano, inicio, termino, inicio_preparacao, termino_desmontagem, espacos)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (nome, int(ano), inicio, termino,
                  e.get("inicio_preparacao"),
                  e.get("termino_desmontagem"),
                  e.get("espacos")))
            if dest.execute("SELECT changes()").fetchone()[0]:
                inserted += 1
                print(f"  + {nome} ({ano})")
            else:
                print(f"  · Duplicada ignorada: {nome} ({ano})")
        except Exception as ex:
            print(f"  ⚠ Erro: {ex}")
            errors += 1

    dest.commit()
    dest.close()
    print(f"\n  ✓ {inserted} exposições importadas  |  {errors} erros")


# ── MAIN ──────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Importador MASP — compatível com o schema atual de climatizacao_museu.db",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--sqlite",     help="Caminho para banco SQLite origem")
    parser.add_argument("--tabela",     default="medicoes", help="Nome da tabela no banco origem (padrão: medicoes)")
    parser.add_argument("--json",       help="Caminho para arquivo JSON")
    parser.add_argument("--xlsx",       help="Caminho para arquivo XLSX")
    parser.add_argument("--exposicoes", help="Caminho para JSON de exposições")
    args = parser.parse_args()

    print(f"Banco destino: {DEST_DB}\n")

    if args.sqlite:
        importar_sqlite(args.sqlite, args.tabela)
    elif args.json:
        importar_json(args.json)
    elif args.xlsx:
        importar_xlsx(args.xlsx)
    elif args.exposicoes:
        importar_exposicoes(args.exposicoes)
    else:
        parser.print_help()
