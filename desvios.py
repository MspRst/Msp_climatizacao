"""
desvios.py — Cálculo e rastreamento de desvios de conformidade climática.

Funções para:
  1. Calcular desvios em relação aos padrões
  2. Armazenar desvios na tabela desvios
  3. Associar desvios a ocorrências
  4. Gerar estatísticas para relatórios
"""

import sqlite3
import os
from datetime import datetime
from typing import List, Dict, Tuple
from conformidade import get_padroes

DB_PATH = os.environ.get("DB_PATH", "climatizacao_museu.db")


def calcular_desvios_serie(
    medicoes: List[Dict],
    sensor_id: int,
    sensor_nome: str,
    padrao_id: int = 2,  # MASP por padrão
) -> List[Dict]:
    """
    Calcula desvios para uma série de medições.
    
    Parâmetros
    ----------
    medicoes : List[Dict]
        Lista de dicts com chaves: id, data_hora, temperatura, umidade, periodo_expositivo
    sensor_id : int
        ID do sensor
    sensor_nome : str
        Nome do sensor
    padrao_id : int
        ID do padrão (1=IBRAM, 2=MASP, 3=BIZOT)
    
    Retorno
    -------
    List[Dict] — Lista de desvios, cada um com:
        {
            medicao_id, data_hora, temperatura, umidade,
            temp_acima, temp_abaixo, umid_acima, umid_abaixo,
            padrao_nome, temp_min, temp_max, umid_min, umid_max
        }
    """
    if not medicoes:
        return []
    
    padroes = get_padroes()
    padrao = padroes.get(padrao_id, {})
    
    if not padrao:
        return []
    
    temp_min = padrao.get('temp_min', 18.0)
    temp_max = padrao.get('temp_max', 23.0)
    umid_min = padrao.get('umid_min', 45.0)
    umid_max = padrao.get('umid_max', 55.0)
    padrao_nome = padrao.get('nome', 'MASP')
    
    desvios = []
    
    for med in medicoes:
        temp = med.get('temperatura')
        umid = med.get('umidade')
        
        # Ignora medições sem temperatura ou umidade
        if temp is None or umid is None:
            continue
        
        temp_acima = 1 if temp > temp_max else 0
        temp_abaixo = 1 if temp < temp_min else 0
        umid_acima = 1 if umid > umid_max else 0
        umid_abaixo = 1 if umid < umid_min else 0
        
        # Só adiciona se há algum desvio
        if temp_acima or temp_abaixo or umid_acima or umid_abaixo:
            desvios.append({
                'medicao_id': med.get('id'),
                'data_hora': med.get('data_hora'),
                'temperatura': temp,
                'umidade': umid,
                'sensor_id': sensor_id,
                'sensor_nome': sensor_nome,
                'padrao_id': padrao_id,
                'padrao_nome': padrao_nome,
                'temp_min': temp_min,
                'temp_max': temp_max,
                'umid_min': umid_min,
                'umid_max': umid_max,
                'temp_acima': temp_acima,
                'temp_abaixo': temp_abaixo,
                'umid_acima': umid_acima,
                'umid_abaixo': umid_abaixo,
            })
    
    return desvios


def armazenar_desvios(desvios: List[Dict]) -> int:
    """
    Armazena desvios na tabela desvios.
    
    Retorno
    -------
    int — Número de desvios inseridos
    """
    if not desvios:
        return 0
    
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    
    try:
        cursor = con.execute("SELECT COUNT(*) as cnt FROM desvios")
        existing = cursor.fetchone()['cnt']
        
        # Se já há muitos desvios, não insere (evita crescimento infinito)
        if existing > 1_000_000:
            print(f"⚠️  Tabela desvios já tem {existing} registros. Saindo...")
            return 0
        
        inserted = 0
        for dev in desvios:
            try:
                con.execute("""
                    INSERT INTO desvios (
                        medicao_id, sensor_id, data_hora, temperatura, umidade,
                        padrao_id, padrao_nome, temp_min, temp_max, umid_min, umid_max,
                        temp_acima, temp_abaixo, umid_acima, umid_abaixo
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    dev['medicao_id'],
                    dev['sensor_id'],
                    dev['data_hora'],
                    dev['temperatura'],
                    dev['umidade'],
                    dev['padrao_id'],
                    dev['padrao_nome'],
                    dev['temp_min'],
                    dev['temp_max'],
                    dev['umid_min'],
                    dev['umid_max'],
                    dev['temp_acima'],
                    dev['temp_abaixo'],
                    dev['umid_acima'],
                    dev['umid_abaixo'],
                ))
                inserted += 1
            except sqlite3.IntegrityError:
                # Já existe — ignora
                pass
        
        con.commit()
        return inserted
    
    finally:
        con.close()


def associar_desvios_a_ocorrencias():
    """
    Associa desvios a ocorrências com base em proximidade temporal.
    Busca ocorrências que ocorrem durante períodos de desvio (±2 minutos).
    """
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    
    try:
        # Busca desvios sem ocorrência associada
        desvios = con.execute("""
            SELECT DISTINCT dev.id, dev.data_hora, dev.sensor_id
            FROM desvios dev
            LEFT JOIN ocorrencias occ ON dev.ocorrencia_id = occ.id
            WHERE dev.ocorrencia_id IS NULL
            LIMIT 1000
        """).fetchall()
        
        updated = 0
        for dev in desvios:
            # Busca ocorrências próximas (dentro de ±5 minutos)
            ocorr = con.execute("""
                SELECT occ.id
                FROM ocorrencias occ
                JOIN ocorrencias_sensores os ON occ.id = os.ocorrencia_id
                WHERE os.sensor_id = ?
                  AND datetime(occ.data_inicio) <= datetime(?)
                  AND (occ.data_fim IS NULL OR datetime(occ.data_fim) >= datetime(?))
                LIMIT 1
            """, (dev['sensor_id'], dev['data_hora'], dev['data_hora'])).fetchone()
            
            if ocorr:
                con.execute("""
                    UPDATE desvios
                    SET ocorrencia_id = ?
                    WHERE id = ?
                """, (ocorr['id'], dev['id']))
                updated += 1
        
        con.commit()
        print(f"✅ {updated} desvios associados a ocorrências")
    
    finally:
        con.close()


def gerar_relatorio_desvios_sensor(
    sensor_id: int,
    data_ini: str,
    data_fim: str,
    padrao_id: int = 2,
) -> Dict:
    """
    Gera estatísticas de desvios para um sensor no período.
    
    Retorno
    -------
    {
        'total_medicoes': int,
        'total_desvios': int,
        'pct_desvios': float,
        'pct_acima': float,
        'pct_abaixo': float,
        'pct_conforme': float,
        'temp_acima_count': int,
        'temp_abaixo_count': int,
        'umid_acima_count': int,
        'umid_abaixo_count': int,
        'desvios_lista': List[Dict],  # com justificativas
    }
    """
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    
    try:
        # Total de medições neste período
        result = con.execute("""
            SELECT COUNT(*) as total
            FROM medicoes
            WHERE sensor_id = ? AND data_hora BETWEEN ? AND ?
        """, (sensor_id, data_ini, data_fim)).fetchone()
        
        total_medicoes = result['total'] if result else 0
        
        # Desvios
        desvios_rows = con.execute("""
            SELECT 
                d.data_hora,
                d.temperatura,
                d.umidade,
                d.temp_min,
                d.temp_max,
                d.umid_min,
                d.umid_max,
                d.temp_acima,
                d.temp_abaixo,
                d.umid_acima,
                d.umid_abaixo,
                COALESCE(occ.justificativa, '') as justificativa,
                occ.descricao as ocorrencia_desc
            FROM desvios d
            LEFT JOIN ocorrencias occ ON d.ocorrencia_id = occ.id
            WHERE d.sensor_id = ? 
              AND d.data_hora BETWEEN ? AND ?
              AND d.padrao_id = ?
            ORDER BY d.data_hora
        """, (sensor_id, data_ini, data_fim, padrao_id)).fetchall()
        
        desvios_lista = [dict(row) for row in desvios_rows]
        total_desvios = len(desvios_lista)
        
        # Contagens
        temp_acima_count = sum(1 for d in desvios_lista if d['temp_acima'])
        temp_abaixo_count = sum(1 for d in desvios_lista if d['temp_abaixo'])
        umid_acima_count = sum(1 for d in desvios_lista if d['umid_acima'])
        umid_abaixo_count = sum(1 for d in desvios_lista if d['umid_abaixo'])
        
        # Percentuais
        pct_desvios = (total_desvios / total_medicoes * 100) if total_medicoes > 0 else 0
        pct_conforme = 100 - pct_desvios
        pct_acima = (temp_acima_count + umid_acima_count) / total_medicoes * 100 if total_medicoes > 0 else 0
        pct_abaixo = (temp_abaixo_count + umid_abaixo_count) / total_medicoes * 100 if total_medicoes > 0 else 0
        
        return {
            'total_medicoes': total_medicoes,
            'total_desvios': total_desvios,
            'pct_desvios': round(pct_desvios, 1),
            'pct_acima': round(pct_acima, 1),
            'pct_abaixo': round(pct_abaixo, 1),
            'pct_conforme': round(pct_conforme, 1),
            'temp_acima_count': temp_acima_count,
            'temp_abaixo_count': temp_abaixo_count,
            'umid_acima_count': umid_acima_count,
            'umid_abaixo_count': umid_abaixo_count,
            'desvios_lista': desvios_lista[:50],  # Limita a 50 para não sobrecarregar o relatório
        }
    
    finally:
        con.close()
