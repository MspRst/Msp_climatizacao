import sqlite3
import csv
import os
from datetime import datetime

# ==========================================
# CONFIGURAÇÕES
# ==========================================
DB_PATH = "climatizacao_museu.db"
CSV_PATH = "expos_masp_2017_2026 - Página1.csv"
# ==========================================

def converter_data(data_str):
    """Converte datas de DD/MM/YYYY para YYYY-MM-DD para o SQLite"""
    if not data_str:
        return None
    data_str = data_str.strip()
    for formato in ('%d/%m/%Y', '%d/%m/%y'):
        try:
            return datetime.strptime(data_str, formato).strftime('%Y-%m-%d')
        except ValueError:
            continue
    return data_str # Retorna o original se já estiver no formato correto ou falhar

def atualizar_banco():
    if not os.path.exists(DB_PATH):
        print(f"❌ Banco de dados não encontrado em: {DB_PATH}")
        return
    
    if not os.path.exists(CSV_PATH):
        print(f"❌ Arquivo CSV não encontrado em: {CSV_PATH}")
        return

    con = sqlite3.connect(DB_PATH)
    cursor = con.cursor()
    
    inseridas = 0
    atualizadas = 0
    puladas = 0

    try:
        with open(CSV_PATH, mode='r', encoding='utf-8-sig') as f:
            # O DictReader vai ler exatamente os cabeçalhos que vimos na imagem
            reader = csv.DictReader(f)
            
            for row in reader:
                # Puxa os dados usando os nomes exatos das colunas da imagem
                nome = row.get("Nome da Exposição")
                ano = row.get("Ano")
                inicio_raw = row.get("Início")
                termino_raw = row.get("Fim")
                espacos = row.get("Espaço Expositivo")
                
                # Validação básica para ignorar linhas totalmente vazias da planilha
                if not nome or not inicio_raw or not termino_raw:
                    puladas += 1
                    continue
                
                # Trata strings e faz a conversão de formato de data exigida pelo SQLite
                nome = nome.strip()
                ano = int(ano.strip()) if str(ano).strip().isdigit() else None
                inicio = converter_data(inicio_raw)
                termino = converter_data(termino_raw)
                if espacos: espacos = espacos.strip()

                # Verifica se essa exposição já está gravada no banco (pelo nome e ano)
                cursor.execute("SELECT id FROM exposicoes WHERE nome = ? AND ano = ?", (nome, ano))
                registro = cursor.fetchone()
                
                if registro:
                    # Se já existe, atualiza as informações de data e local
                    cursor.execute("""
                        UPDATE exposicoes 
                        SET inicio = ?, termino = ?, espacos = ?
                        WHERE id = ?
                    """, (inicio, termino, espacos, registro[0]))
                    atualizadas += 1
                else:
                    # Se for uma exposição nova, faz a inserção
                    cursor.execute("""
                        INSERT INTO exposicoes (ano, nome, inicio, termino, espacos)
                        VALUES (?, ?, ?, ?, ?)
                    """, (ano, nome, inicio, termino, espacos))
                    inseridas += 1

        con.commit()
        print("\n📊 --- RELATÓRIO DE IMPORTAÇÃO ---")
        print(f"✅ Novas exposições inseridas: {inseridas}")
        print(f"🔄 Exposições atualizadas: {atualizadas}")
        print(f"⏭️  Linhas vazias/ignoradas: {puladas}")
        print("----------------------------------\n")
        
    except Exception as e:
        con.rollback()
        print(f"❌ Erro crítico ao processar o arquivo CSV: {e}")
    finally:
        con.close()

if __name__ == "__main__":
    atualizar_banco()