# MASP — Sistema de Monitoramento de Climatização

Dashboard para acompanhamento de temperatura e umidade relativa dos espaços do MASP, com avaliação de conformidade pelos padrões IBRAM, MASP e Bizot.

---

## Sumário

- [Visão Geral](#visão-geral)
- [Tecnologias](#tecnologias)
- [Estrutura do Projeto](#estrutura-do-projeto)
- [Instalação e Uso Local](#instalação-e-uso-local)
- [Variáveis de Ambiente](#variáveis-de-ambiente)
- [Importando Dados](#importando-dados)
- [Padrões de Conformidade](#padrões-de-conformidade)
- [Schema do Banco de Dados](#schema-do-banco-de-dados)
- [Endpoints da API](#endpoints-da-api)
- [Deploy](#deploy)
- [Funcionalidades Principais](#funcionalidades-principais)

---

## Visão Geral

O MASP Dashboard é uma aplicação web que consolida leituras de sensores de temperatura e umidade relativa (UR) espalhados pelo museu, calcula conformidade com três padrões internacionais de conservação e apresenta os dados em gráficos interativos.

**Casos de uso:**
- Acompanhar condições climáticas por ponto/sala em tempo real
- Verificar conformidade durante e fora de períodos expositivos
- Gerar relatórios de desvio por sensor e padrão
- Registrar e consultar alertas de variação brusca de umidade
- Gerenciar exposições, sensores, aliases e ocorrências (manutenções)

---

## Tecnologias

| Camada | Tecnologia |
|--------|-----------|
| Backend | Python 3.11 + Flask 3.0.3 |
| Servidor WSGI | Gunicorn 22.0.0 |
| Banco de dados | SQLite 3 (arquivo local) |
| Frontend | HTML5 + CSS3 + JavaScript (ES2020, sem framework) |
| Gráficos | Chart.js 4.4.0 |
| Tipografia | Space Grotesk, IBM Plex Mono, DM Mono |

---

## Estrutura do Projeto

```
masp-dashboard/
├── app.py                              # Servidor Flask — API e lógica de negócio
├── conformidade.py                     # Motor de cálculo de conformidade
├── desvios.py                          # Módulo de rastreamento de desvios
├── import_dados.py                     # Utilitários de importação de dados
├── atualizar_expos.py                  # Script de atualização de exposições
├── requirements.txt                    # Dependências Python
├── static/
│   ├── index.html                      # SPA do dashboard (frontend)
│   └── api.js                          # Camada de dados — conecta UI à API
├── climatizacao_museu.db               # Banco SQLite (gerado automaticamente)
└── expos_masp_2017_2026 - Página1.csv  # Dados históricos de exposições
```

---

## Instalação e Uso Local

```bash
# 1. Instalar dependências
pip install -r requirements.txt

# 2. Subir o servidor (banco criado automaticamente na primeira execução)
python app.py

# 3. Acessar no navegador
# http://localhost:5000
```

O banco `climatizacao_museu.db` é criado automaticamente com todas as tabelas e migrações necessárias. **Não versione este arquivo.**

---

## Variáveis de Ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `DB_PATH` | `climatizacao_museu.db` | Caminho para o banco SQLite |
| `ACCESS_TOKEN` | *(vazio)* | Senha de acesso à API (opcional) |
| `FLASK_ENV` | `development` | Use `production` em produção |
| `PORT` | `5000` | Porta do servidor |

### Proteção por senha

Se `ACCESS_TOKEN` estiver definido, todas as requisições à API devem incluir o header:

```
X-Access-Token: sua_senha_secreta_aqui
```

---

## Importando Dados

### Upload pelo dashboard

Arraste um arquivo JSON na aba **Gerenciar → Importações**. Os dados são enviados para `/api/upload`, sensores novos são criados automaticamente e duplicatas são ignoradas.

**Formato esperado do JSON:**
```json
[
  {
    "ponto": "1º Andar - Frente",
    "data_hora": "2024-03-15 14:30:00",
    "temperatura": 21.5,
    "umidade_relativa": 53.2
  }
]
```

### Via script — banco SQLite existente

```bash
python import_dados.py --origem /caminho/para/seu_banco.db --tabela nome_da_tabela
```

### Via script — arquivo JSON

```bash
python import_dados.py --json /caminho/para/dados.json
```

### Via script — planilha Excel

```bash
pip install openpyxl
python import_dados.py --xlsx /caminho/para/planilha.xlsx
```

### Importar exposições

```bash
python import_dados.py --exposicoes /caminho/para/exposicoes.json
```

### Agendamento automático (cron)

```bash
# Toda segunda-feira às 8h
0 8 * * 1 cd /caminho/projeto && python import_dados.py --xlsx /dados/semana.xlsx
```

---

## Padrões de Conformidade

O sistema avalia cada medição contra três padrões:

| Padrão | Temperatura | Umidade Relativa | Rigidez |
|--------|-------------|-----------------|---------|
| **IBRAM** | 18–22°C | 50–60% | Estrito (linha UNESCO) |
| **MASP** | 18–23°C | 45–55% | Médio |
| **Bizot** | 15–25°C | 40–60% | Flexível |

### Lógica híbrida

- Sensores do **1º andar** usam o padrão **MASP** por padrão
- Demais andares usam o padrão **Bizot**
- Cada medição armazena flags de conformidade independentes para cada padrão

### Cálculo de ponto de orvalho

A série temporal de ponto de orvalho (Td) é calculada pela fórmula de Magnus-Tetens, disponível em `/api/orvalho_serie`.

---

## Schema do Banco de Dados

### `sensores`
```sql
CREATE TABLE sensores (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    nome             TEXT NOT NULL UNIQUE,
    andar            TEXT,
    predio           TEXT,       -- "Pietro" ou "Lina"
    ativo            INTEGER DEFAULT 1,
    localizacao      TEXT,
    descricao        TEXT,
    data_instalacao  DATE
);
```

### `sensores_aliases`
```sql
CREATE TABLE sensores_aliases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sensor_id  INTEGER REFERENCES sensores(id),
    alias      TEXT NOT NULL,
    criado_em  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `medicoes`
```sql
CREATE TABLE medicoes (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    sensor_id               INTEGER REFERENCES sensores(id),
    data_hora               DATETIME NOT NULL,
    temperatura             REAL,
    umidade                 REAL,
    periodo_expositivo      INTEGER DEFAULT 0,
    periodo_expositivo_nome TEXT,
    -- flags de conformidade por padrão
    conf_temp_ibram         INTEGER,
    conf_umid_ibram         INTEGER,
    conf_total_ibram        INTEGER,
    conf_temp_masp          INTEGER,
    conf_umid_masp          INTEGER,
    conf_total_masp         INTEGER,
    conf_temp_bizot         INTEGER,
    conf_umid_bizot         INTEGER,
    conf_total_bizot        INTEGER,
    conf_total_hibrido      INTEGER,
    UNIQUE(sensor_id, data_hora)
);
```

### `exposicoes`
```sql
CREATE TABLE exposicoes (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    nome                  TEXT NOT NULL,
    ano                   INTEGER,
    inicio                DATE,
    termino               DATE,
    inicio_preparacao     DATE,
    termino_desmontagem   DATE,
    espacos               TEXT    -- JSON com lista de espaços
);
```

### `alertas_variacao_umidade`
```sql
CREATE TABLE alertas_variacao_umidade (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    sensor_id            INTEGER REFERENCES sensores(id),
    data_inicial         DATETIME,
    data_final           DATETIME,
    umidade_inicial      REAL,
    umidade_final        REAL,
    variacao_percentual  REAL,
    periodo_expositivo   INTEGER DEFAULT 0
);
```

### `ocorrencias`
```sql
CREATE TABLE ocorrencias (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    data_inicio       DATETIME,
    data_fim          DATETIME,
    predio            TEXT,
    tipo              TEXT,       -- ex: "manutenção", "falha"
    fonte             TEXT,
    descricao         TEXT,
    responsavel       TEXT,
    justificativa     TEXT,
    afeta_predio_todo INTEGER DEFAULT 0
);
```

### `ocorrencias_sensores`
```sql
CREATE TABLE ocorrencias_sensores (
    ocorrencia_id  INTEGER REFERENCES ocorrencias(id),
    sensor_id      INTEGER REFERENCES sensores(id),
    PRIMARY KEY (ocorrencia_id, sensor_id)
);
```

### `importacoes`
```sql
CREATE TABLE importacoes (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    arquivo_nome         TEXT,
    data_importacao      DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_medicoes       INTEGER,
    medicoes_importadas  INTEGER,
    medicoes_duplicadas  INTEGER,
    sensores_novos       INTEGER,
    periodo_inicio       DATETIME,
    periodo_fim          DATETIME,
    status               TEXT,
    observacoes          TEXT
);
```

---

## Endpoints da API

### Métricas e análise

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/metricas` | Conformidade geral (todos os padrões) |
| GET | `/api/pontos` | Conformidade por sensor |
| GET | `/api/agregado` | Evolução temporal (hora/dia/mês/ano) |
| GET | `/api/mensal` | Alias para `/api/agregado` |
| GET | `/api/diario` | Médias diárias por sensor |
| GET | `/api/serie` | Série temporal bruta (até 50 mil pontos) |
| GET | `/api/dispersao` | Dados para gráfico T×UR (heatmap) |
| GET | `/api/horario` | Distribuição de não-conformidade por hora |
| GET | `/api/amplitude` | Estatísticas de amplitude diária |
| GET | `/api/orvalho_serie` | Série temporal de ponto de orvalho (Td) |
| GET | `/api/meta` | Metadados (sensores, anos, detecção de sensores externos) |

### Exposições e alertas

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/exposicoes` | Metadados das exposições |
| GET | `/api/alertas` | Alertas de variação de UR > 10 p.p. |
| GET | `/api/alertas/calcular` | Calcula alertas sob demanda |

### Relatórios

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/desvios` | Estatísticas de desvio para um sensor |
| GET | `/api/desvios-preview` | Tabela de desvios multi-sensor |

### Upload

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/upload` | Importa arquivo JSON com medições |

### Admin — Sensores

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/admin/sensores` | Lista todos os sensores |
| POST | `/api/admin/sensores` | Cria sensor |
| PUT | `/api/admin/sensores/<id>` | Atualiza sensor |
| DELETE | `/api/admin/sensores/<id>` | Remove sensor |
| POST | `/api/admin/sensores/merge` | Mescla dois sensores |
| GET | `/api/admin/sensores/<id>/aliases` | Lista aliases |
| POST | `/api/admin/sensores/<id>/aliases` | Adiciona alias |
| DELETE | `/api/admin/sensores/<id>/aliases/<alias_id>` | Remove alias |

### Admin — Exposições

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/admin/exposicoes` | Lista exposições |
| POST | `/api/admin/exposicoes` | Cria exposição |
| PUT | `/api/admin/exposicoes/<id>` | Atualiza exposição |
| DELETE | `/api/admin/exposicoes/<id>` | Remove exposição |
| POST | `/api/admin/recalcular_periodo` | Recalcula períodos expositivos das medições |

### Admin — Ocorrências

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/ocorrencias` | Lista ocorrências |
| POST | `/api/ocorrencias` | Cria ocorrência |
| PUT | `/api/ocorrencias/<id>` | Atualiza ocorrência |
| DELETE | `/api/ocorrencias/<id>` | Remove ocorrência |

### Admin — Importações

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/admin/importacoes` | Histórico de importações |

### Filtros disponíveis (query params)

Todos os endpoints de leitura aceitam os seguintes parâmetros:

| Parâmetro | Exemplo | Descrição |
|-----------|---------|-----------|
| `ponto` | `1+andar+-+Frente` | Nome do sensor |
| `data_ini` | `2024-01-01` | Data inicial |
| `data_fim` | `2024-12-31` | Data final |
| `ano` | `2024` | Filtro por ano |
| `mes` | `03` | Filtro por mês |
| `periodo_expositivo` | `1` | `1` = exposição, `0` = fora |
| `periodo_expositivo_nome` | `Nome+Expo` | Exposição específica |
| `granularidade` | `dia` | `hora`, `dia`, `mes`, `ano` |

---

## Deploy

### Railway (recomendado — volume persistente)

1. Crie uma conta em [railway.app](https://railway.app)
2. Instale o CLI: `npm i -g @railway/cli`
3. No diretório do projeto:
   ```bash
   railway login
   railway init
   railway volume add       # anote o mount path
   railway up
   ```
4. Em **Settings → Variables**, adicione:
   ```
   DB_PATH=/var/data/climatizacao_museu.db
   ```
5. Para enviar o banco inicial:
   ```bash
   railway run python import_dados.py --origem seu_banco_local.db
   ```

### PythonAnywhere (sem CLI)

1. Crie conta gratuita em [pythonanywhere.com](https://www.pythonanywhere.com)
2. **Files** → faça upload de todos os arquivos
3. **Web** → Add a new web app → Flask → Python 3.11
4. Configure o WSGI para apontar para `app.py`
5. No console Bash:
   ```bash
   pip install flask gunicorn --user
   python import_dados.py --origem seu_banco.db
   ```
6. Clique em **Reload**

**Limitação:** plano gratuito limita CPU e permite apenas 1 aplicação.

### Render

1. Crie conta em [render.com](https://render.com)
2. Conecte seu repositório GitHub
3. Novo serviço → Web Service → Python
4. Adicione um **Disk** (volume persistente) em `/var/data`
5. Variáveis de ambiente:
   ```
   DB_PATH=/var/data/climatizacao_museu.db
   ```
6. Build command: `pip install -r requirements.txt`
7. Start command: `gunicorn app:app --bind 0.0.0.0:$PORT`

---

## Funcionalidades Principais

### Dashboard (aba principal)
- Cartões de KPI: conformidade total, MASP, Bizot e IBRAM
- Tabela de conformidade por sensor com breakout por padrão
- Gráfico de dispersão T×UR com zonas de conformidade sobrepostas

### Aba Mensal
- Gráfico de linha com evolução temporal de conformidade
- Seletor de padrão (IBRAM / MASP / Bizot / Todos)
- Seletor de granularidade (Hora / Dia / Mês / Ano)
- Sobreposição visual de períodos expositivos
- Exportação em PNG (2400px) com cabeçalho de metadados

### Aba Relatório
- Wizard em 4 etapas: padrão → sensores → limiares → desvios
- Tabela de desvios com campo de justificativa editável
- Resumo dos 10 maiores desvios

### Aba Alertas
- Caixas colapsáveis por alerta de variação > 10 p.p. de UR
- Badges de severidade por cor

### Aba Gerenciar
- **Sensores:** CRUD completo, mesclagem de duplicatas, gestão de aliases
- **Exposições:** CRUD, recálculo de períodos expositivos nas medições
- **Ocorrências:** Registro de manutenções e incidentes por sensor/prédio
- **Importações:** Histórico de uploads com estatísticas

### Motor de detecção de picos

Após cada importação, o sistema aplica detecção automática de anomalias:
- Variações de UR > 10 p.p. em janela de 24 horas
- Desvios sustentados por ≥ 4 leituras consecutivas

### Resolução fuzzy de sensores

Ao importar dados, o sistema resolve o nome do sensor em 5 camadas:
1. Cache em memória
2. Correspondência exata
3. Correspondência fuzzy (normalização de acentos, pontuação e caixa)
4. Aliases cadastrados
5. Criação automática do sensor

### Cache de respostas

Endpoints GET são cacheados em memória com TTL de 5 minutos, invalidados automaticamente após operações de escrita.
