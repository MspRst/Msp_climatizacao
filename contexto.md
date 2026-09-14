# Contexto do Projeto — MASP Dashboard

> Documento de contexto para quem (pessoa ou agente) vai retomar o trabalho neste repositório.
> Complementa o `README.md` (o que o sistema faz: schema, API, deploy) e o `ANALISE-TECNICA.md`
> (dívida técnica catalogada — dead code, duplicações, recomendações). Este arquivo é sobre
> **como o código está organizado hoje e por que**.

Última atualização: 2026-09-14 · Branch: `main` — ver §3 para o histórico de commits recente

---

## 1. O que é

Aplicação web interna do MASP para monitorar temperatura e umidade relativa (UR) dos espaços
do museu — **dois prédios, Lina e Pietro** (ver §4). Consolida leituras de sensores, calcula
conformidade contra três padrões de conservação (IBRAM, MASP, Bizot), cruza com o calendário
de exposições, e apresenta tudo em um dashboard de abas com gráficos interativos, além de um
módulo de geração de relatório imprimível com versão para uso interno e para uso externo
(emprestadores/seguradoras).

Público: equipe de acervo/conservação do MASP. Uso: rede interna, deploy próprio.

---

## 2. Arquitetura em uma página

```
Navegador (SPA sem framework)
   │  fetch /api/*
   ▼
Flask (app.py, ~2420 linhas)  ──►  conformidade.py   (motor de conformidade)
   │                          ──►  desvios.py        (relatório de desvios — parcialmente morto, ver ANALISE-TECNICA §2.2)
   │  cache em memória (TTL 300s por padrão, por-endpoint via @cached_endpoint(ttl=...))
   ▼
SQLite (climatizacao_museu.db, ~700 MB, 2,9M medições, 27 sensores, 101 exposições)
```

Sem framework de frontend, sem build step, sem bundler — arquivos JS servidos diretos,
carregados por `<script>` na ordem, comunicando por funções/variáveis globais em `window`.
Ver §6 para as armadilhas disso.

### Camadas

| Arquivo | Linhas | Papel |
|---|---|---|
| `app.py` | ~2420 | Servidor Flask: rotas `/api/*`, migrações de schema, cache, upload/ingestão (JSON e XLSX) |
| `conformidade.py` | ~285 | Fonte única de verdade do cálculo de conformidade e ponto de orvalho (Magnus-Tetens). Padrões lidos do BD (tabela `padroes_conformidade`) |
| `desvios.py` | ~302 | Cálculo de desvios — **parcialmente morto**, ver `ANALISE-TECNICA.md` §2.2 |
| `import_dados.py` | ~416 | CLI de importação (BD SQLite externo, JSON, XLSX genérico, exposições) — **não** entende o formato XLSX do Pietro, só o dashboard entende (ver §5) |
| `atualizar_expos.py` | — | Script de atualização de exposições a partir do CSV |
| `templates/index.html` | ~960 | Casca da SPA — abas, filtros, canvases, formulário do relatório |
| `templates/modals.html` | ~348 | Todos os modais, incluído via `{% include %}` |
| `static/css/style.css` | ~1780 | Estilo completo, tokens em CSS custom properties |
| `static/api.js` | ~180 | Camada de dados: objeto `API`, `getFilters()`, `loadTab()`, `loadAll()`, boot |
| `static/ui.js` | ~345 | Abas, filtros (agrupados por **prédio + andar**, ver §4), chips de sensores, toasts |
| `static/charts.js` | ~1820 | Todos os gráficos do dashboard (mensal, sazonal, horário, alertas, orvalho, heatmap) |
| `static/admin.js` | ~3440 | Aba Gerenciar + Relatório: CRUD, importação CSV/XLSX, geração do relatório completo |

---

## 3. Histórico de commits

Até 2026-09-14 a árvore de trabalho acumulava meses de mudanças não commitadas (a refatoração
de UI + multi-prédio + relatório interno/externo + import XLSX, tudo misturado num único
`git diff`). Foi finalmente commitado em 3 partes, do mais antigo/genérico para o mais
recente/específico:

1. **`refactor: divide UI monolítica em templates Jinja + módulos JS; ...`** — o bloco grande
   histórico: index.html monolítico → `templates/index.html` + `templates/modals.html` +
   `static/{api,ui,charts,admin}.js` + `static/css/style.css`; suporte a Lina/Pietro; import
   de XLSX; relatório interno/externo. Não foi possível separar esse bloco em commits menores
   por tema (refatoração vs. multi-prédio vs. relatório) porque os arquivos novos (`admin.js`,
   `charts.js`, `ui.js`) nunca tinham sido commitados antes — não existe histórico para
   recortar diffs parciais entre esses temas.
2. **`fix: guess de sensor no upload XLSX passa a considerar aliases; ...`** — itens 5–7 da
   pendência (ver §9), primeira tarefa da sessão de 2026-09-14.
3. **`fix: ocorrências vazavam entre prédios no relatório; adiciona exposições/ocorrências do
   Pietro`** — segunda tarefa da mesma sessão, ver §9 "Resolvido em 2026-09-14".

Dali em diante, o hábito passa a ser: **commitar ao final de cada tarefa**, não deixar acumular.

---

## 4. Multi-prédio: Lina + Pietro

O MASP tem dois prédios monitorados pelo sistema — **Lina** (original, andares nomeados
"1º Andar", "1º Subsolo" etc., climatização própria) e **Pietro** (adicionado nesta sessão,
5 andares expositivos numerados 2º–6º, dataloggers de outro fabricante — ver §5).

**Por que isso importa para o código:** os dois prédios têm andares de **mesmo número**
(o "2º Andar" existe nos dois). Todo o cruzamento sensor↔exposição em `app.py` é por
`(predio, andar)`, nunca só por andar — do contrário uma exposição no 2º Andar do Pietro
marcaria também o 2º Andar do Lina.

- `sensores.predio` — `'Lina'` ou `'Pietro'`. Já existia; agora é ativamente usado no cruzamento.
- `exposicoes.predio` — `'Lina'` (default, migração histórica) | `'Pietro'` | `'Ambos'`.
  Selecionável no modal de exposição.
- `_ANDAR_KEYWORDS` (`app.py`) é um dict aninhado `{predio: {andar: [palavras-chave]}}`.
  Lina tem grupos especiais (1º subsolo com sinônimos "exposição"/"mezanino", 2º subsolo);
  Pietro é gerado programaticamente para os andares 2–6 (`_andar_keywords_padrao(n)`).
- `_eh_acervo_permanente(predio, andar)` — só o **2º Andar do Lina** é a coleção permanente
  "Acervo em Transformação" (sempre marcado como expositivo, independe da tabela de
  exposições). O 2º Andar do Pietro **não** tem esse tratamento especial — é uma galeria
  normal, cruzada com exposições como qualquer outra.
- `sensores.espaco_expositivo` (0/1, editável na UI) — nem todo sensor de um andar de galeria
  é espaço expositivo (Ateliê de Restauro e Reservas Técnicas ficam no mesmo "1º Andar" do
  Lina que as galerias, mas não são expositivos). Filtra o cruzamento antes mesmo de olhar
  a tabela de exposições.
- Toda essa lógica está centralizada em `_expositivo_para()` (usada tanto no upload quanto
  em `/api/admin/recalcular_periodo`, que faz o recálculo em lote quando uma exposição é
  cadastrada/editada depois que os dados já foram importados).
- **Agrupamento na UI**: `populateFilters()` (`ui.js`) agrupa os chips de filtro e os
  checkboxes do relatório por `predio + andar` (ex.: `"Pietro · 2º Andar"`), não só por
  andar — senão os dois "2º Andar" apareceriam misturados na tela.

### Sensores do Pietro (criados nesta sessão)

Um sensor por andar, nome incluindo o prédio para ficar inequívoco em qualquer lista/relatório
(o campo `andar` interno continua só o número, ex. `"2º Andar"` — é ele que a lógica de
cruzamento usa; o nome de exibição é só cosmético):

| Nome | `andar` | `predio` | Alias (nome antigo) |
|---|---|---|---|
| Segundo Andar Pietro | 2º Andar | Pietro | 2º Andar |
| Terceiro Andar Pietro | 3º Andar | Pietro | 3º Andar |
| Quarto Andar Pietro | 4º Andar | Pietro | 4º Andar |
| Quinto Andar Pietro | 5º Andar | Pietro | 5º Andar |
| Sexto Andar Pietro | 6º Andar | Pietro | 6º Andar |

Os aliases existem porque o *guess* automático de sensor no upload de XLSX (ver §5) casa pelo
nome do arquivo contra o nome ATUAL do sensor — um arquivo `2andar.xlsx` não bate mais
exatamente com "Segundo Andar Pietro", então o alias serve de rede de segurança para
resolução no backend (`resolve_sensor`), ainda que o *guess* no frontend não use aliases hoje
(só teria acesso a `nome` via `/api/meta`) — se isso incomodar, dá pra melhorar depois.

Segundo Andar Pietro já tem dados reais importados (arquivo de exemplo `2andar.xlsx`,
6.977 leituras, jul–set/2026).

---

## 5. Formatos de importação

Três caminhos, cada um resolvendo o sensor de um jeito diferente:

| Formato | Onde | Como resolve o sensor | Observação |
|---|---|---|---|
| **JSON** | drag&drop → `/api/upload`, ou `import_dados.py --json` | Campo `ponto`/`sensor` em cada linha | Formato "nativo" do sistema |
| **CSV Lina / Testo** | drag&drop → parseado no browser (`parseLinaCSV`/`parseTestoCSV` em `admin.js`) → vira JSON → `/api/upload` | Nome do sensor está no próprio CSV (Lina) ou é multi-sensor (Testo) | Detecção automática de formato por heurística nas primeiras linhas |
| **XLSX Pietro** | drag&drop → `/api/upload_xlsx` (parsing no servidor, com `openpyxl`) | **Não vem no arquivo** — é perguntado ao usuário num modal (`xlsxSensorModal`), com sugestão automática pelo nome do arquivo | Colunas `Time stamp` (`DD/MM/AAAA HH:MM:SS`), `Temperatura Ambiente`, `Umidade Ambiente`. Detecção de coluna é por substring no cabeçalho (`temp`, `umid`/`humid`, `time`/`data`/`hora`), tolera variação de acento/idioma |

O parsing do XLSX é **inteiramente server-side** (não hesitar em usar `openpyxl` — já é
dependência do projeto, ver `requirements.txt`) — decisão deliberada para não precisar
carregar uma lib de parsing de planilha no navegador.

`guessSensorFromFilename()` (`admin.js`) faz o *slug* do nome do arquivo (remove extensão,
acentos, `º`/`°`, tudo que não é `[a-z0-9]`) e tenta achar um sensor cujo nome faça o mesmo
slug — exato primeiro, depois por substring. Só sugere quando há confiança razoável; do
contrário deixa em branco para o usuário escolher.

`import_dados.py --xlsx` (a CLI) **não** entende o formato do Pietro — seu parser espera
colunas `ponto`/`data_hora`/`temperatura`/`umidade` (formato genérico). Se um dia for preciso
importar Pietro em lote via CLI (em vez de pela tela), replicar a lógica de
`upload_xlsx()` (`app.py`) lá, ou apontar a CLI para chamar o mesmo endpoint.

---

## 6. Como o frontend funciona (armadilhas)

### Ordem de carregamento importa
```html
<script src="/static/api.js?v=…"></script>   <!-- API, getFilters, loadTab, boot -->
<script src="/static/ui.js?v=…"></script>    <!-- populateFilters, switchTab, toasts -->
<script src="/static/charts.js?v=…"></script>
<script src="/static/admin.js?v=…"></script>
{% include 'modals.html' %}
```
Tudo é global. O `?v=` é um hash **combinado dos 4 arquivos JS** (`_combined_hash` em
`app.py`) — mudar qualquer um deles já basta pra invalidar o cache do navegador em todos.
Não volte a fazer o hash depender só de `api.js`.

### Guard de dupla carga
`api.js` começa com um check `window.__masp_loaded`. Se detectar recarga, **reseta**
`window._charts` em vez de lançar exceção — um `throw` ali aborta o `DOMContentLoaded` e
trava o boot inteiro.

### Boot e cache de aba
1. `populateFilters()` chama `/api/meta` uma vez; datas padrão vêm de `meta.ultima_medicao`
   (não de hoje). `loadAll()` só carrega a aba inicial; `loadTab()` cacheia por aba em
   `window._tabLoaded`.
2. `loadSazonal()` roda depois de `loadPontos()` (depende de `window._sensorExterno`).

### Estado global relevante
`window._charts`, `window._tabLoaded`, `window._lastFilters`, `window._pontosCache`,
`window._ultimaMedicao`, `window._sensorExterno`.

---

## 7. Backend — o que saber

- **Cache**: `@cached_endpoint` (TTL padrão 300s) ou `@cached_endpoint(ttl=N)` para
  endpoints caros sobre o histórico completo (ex.: `/api/sazonal`, TTL 3600s — varre ~2,9M
  linhas, ~7s a frio). `cache_invalidate()` limpa tudo a cada upload, então um TTL longo não
  arrisca servir dado desatualizado por muito tempo além do próximo upload.
- **Auth**: `@optional_auth` — só exige `X-Access-Token` se `ACCESS_TOKEN` estiver setado.
- **Migrações**: `_run_migrations(con)`, rodadas no `get_db()`. Sem Alembic — só
  `ALTER TABLE ADD COLUMN` com `try/except` e um default. Cuidado: um `DEFAULT` numa
  migração dessas aplica retroativamente a TODAS as linhas existentes (foi assim que
  `espaco_expositivo` e `predio` de exposições foram populados) — bom quando o default é
  historicamente correto para os dados já existentes, perigoso se não for.
- **Resolução de sensores**: `resolve_sensor()` — 5 camadas (cache, exato, fuzzy sem
  acento/pontuação, alias exato, alias fuzzy), auto-cria se não achar.
- **Cruzamento sensor↔exposição**: `_normalizar_texto()`, `_andar_keywords_for()`,
  `_eh_acervo_permanente()`, `_expositivo_para()` — todas top-level, compartilhadas entre
  `/api/upload`, `/api/upload_xlsx` e `/api/admin/recalcular_periodo`. `_normalizar_texto`
  colapsa espaços múltiplos e trata `º`/`°` como iguais — os dois já causaram bugs reais de
  exposição não reconhecida por causa de dados digitados com espaço duplo ou o caractere
  errado (grau em vez de indicador ordinal).
- **Padrões de conformidade** ficam no banco (`padroes_conformidade`, lidos por
  `conformidade.get_padroes()`) — mas o **frontend não lê de lá**: os mesmos números
  (18–22°C/50–60%, etc.) estão hardcoded em ~5 lugares do JS. Ver `ANALISE-TECNICA.md` §2.4.
- **O `.db` tem ~700 MB** (caiu de ~1,1 GB depois de dropar 4 tabelas mortas — ver
  `ANALISE-TECNICA.md` §2.1) e está no `.gitignore`. Nunca versionar. Existem 2 backups
  soltos na raiz (`climatizacao_museu.backup-*.db`) de operações desta sessão — apagar
  quando não precisar mais deles.

---

## 8. O relatório (aba Relatório → gerar PDF)

Toda a geração é **client-side**: `admin.js` monta uma string HTML gigante
(`openReportWindow()`, função de ~1000 linhas) e abre como blob numa aba nova — sem backend
dedicado a "gerar relatório", só as APIs de leitura normais chamadas várias vezes
(`/api/serie`, `/api/pontos`, `/api/mensal`, `/api/desvios-preview`, `/api/ocorrencias`).

### Opções de conteúdo (Passo 4 do formulário)
- **Visibilidade**: 🔒 Interno (padrão) / 🌐 Externo — no Externo, a descrição em texto livre
  de cada ocorrência (`o.descricao`) não é renderizada; tipo, datas, sensores afetados e
  responsável continuam aparecendo. É a única diferença — decidida comparando byte a byte
  os PDFs de exemplo que a Yasmin forneceu.
- Checkboxes independentes por seção: capa, guia, tabela comparativa geral,
  **"Tendência de Conformidade Comparativa" (página global, canvas `canvas_global_monthly`)**,
  páginas de sensor, gráficos, ocorrências, tabela de evolução mensal *por sensor*, análise
  de desvios. As duas últimas eram controladas pelo MESMO checkbox até esta sessão — agora
  `includeGlobalTrend` (página global) e `includeMonthly` (tabela por sensor) são
  independentes.
- Idioma PT/EN via `I18N`.

### Gráficos de sensor — rótulo de período expositivo
`expoShadingPlugin` (dentro de `mkChart`, dentro do HTML gerado) desenha, para cada trecho
contínuo do eixo X, **"EM EXPOSIÇÃO"** (+ nome da exposição, se couber) ou
**"SEM EXPOSIÇÃO"** — com fundo clarinho atrás do texto para legibilidade. O rótulo fica
colado na base do gráfico (acima da faixa vermelha, entre as curvas de dados e a legenda
que vem logo abaixo do canvas) — não no topo, onde atrapalhava a leitura das curvas.

### Coisas fáceis de quebrar de novo aqui
- O payload embutido no relatório (`chartPayload` → `dataJSON` → `var DATA = JSON.parse(...)`
  dentro do `<script>` gerado) só leva os campos que forem explicitamente destructurados —
  **já aconteceu** de faltar `monthly` e `sensor` nesse payload e a página de tendência
  global ficar em branco silenciosamente (sem erro no console, só sem dados). Se adicionar
  um novo gráfico global que dependa de dado por sensor, confirme que o campo está no
  `chartPayload`.
- A regra "quem usa MASP vs. Bizot no padrão Híbrido" está reimplementada em 3 lugares
  (`/api/metricas`, `/api/pontos` em SQL, e `admin.js` em JS) — ver `ANALISE-TECNICA.md` §2.3.

---

## 9. Pendências e problemas conhecidos

Ver `ANALISE-TECNICA.md` para a lista completa com prioridade. Resumo do que **ainda não**
foi feito (o que já foi resolvido nesta sessão não está mais aqui — checkbox de evolução
mensal, linha do térreo, cache-busting, exposições com espaço duplo/caractere errado,
recalcular_periodo (era stub), espaco_expositivo, multi-prédio, `/api/sazonal` ausente,
página de tendência em branco, cards melhor/pior desempenho — tudo isso está corrigido):

| # | Item | Detalhe |
|---|---|---|
| 1 | Tabela `desvios` + `/api/desvios` mortos | Tabela sempre vazia, função que escreveria nela nunca é chamada, nenhuma tela chama o endpoint. `/api/desvios-preview` (usado de verdade) é outro caminho, não depende disso. |
| 2 | Regra do Híbrido triplicada | 2 cópias em SQL + 1 em JS, mesma lógica reescrita à mão 3x. Recomendação: coluna `sensores.padrao_hibrido`, editável na UI, igual `espaco_expositivo`. |
| 3 | Faixas de conformidade hardcoded no JS | ~5 lugares repetem os números que já existem em `padroes_conformidade` no banco. |
| 4 | `admin.js` com ~3440 linhas | CRUD + parsing de CSV/XLSX + análise de não-conformidades + geração inteira do relatório. Candidato a quebra em módulos. |
### Resolvido em 2026-09-14
- **Guess de sensor no XLSX usa aliases** — `/api/meta` agora anexa `aliases: [...]` a cada
  ponto (backend, `meta()` em `app.py`); `guessSensorFromFilename()` (`admin.js`) compara o
  slug do nome do arquivo contra nome atual **e** aliases de cada sensor, retornando sempre
  o nome atual quando dá match. Call site em `processXLSXFiles()` passa `meta.pontos` em vez
  da lista de nomes.
- **Backups soltos apagados** — `climatizacao_museu.backup-*.db` removidos da raiz.
- **`.gitignore` cobre dados operacionais reais** — `exemplos_relatorios/`,
  `exemplo_graficos_pietro/`, `teste_relatorios_gerados/`, `ocorrencias/` adicionados
  (continham nomes, ocorrências e planilha de sensor reais).
- **Bug real corrigido: ocorrências vazavam entre prédios no relatório e na análise de
  desvios.** `generateReport()` e `vincularDesviosComOcorrencias()` (`admin.js`) filtravam
  ocorrência↔sensor só por `afeta_predio_todo` OU sensor vinculado, **sem checar o prédio da
  ocorrência** — uma ocorrência do Lina com `afeta_predio_todo=1` aparecia também num
  relatório/análise só do Pietro (e vice-versa; 54 ocorrências do Lina estavam nessa
  condição). Corrigido buscando `/api/meta` para montar um mapa nome→predio e só considerar
  a ocorrência quando `o.predio` bate com o predio do sensor (ou é `'Ambos'`).
- **Dados do Pietro para o relatório de 2026** (pedido da Yasmin, planilha
  `ocorrencias/CLIMATIZACAO_Registro de eventos.xlsx` aba "2026" + CSV de exposições):
  - 5 exposições inseridas (`exposicoes`, ids 216–220), todas `predio='Pietro'`: *La Chola
    Poblete* (2º Andar, 06/03–02/08), *Claudia Alarcón & Silät* (3º Andar, 06/03–02/08),
    *Santiago Yahuarcani* (5º e 6º Andar, 02/04–02/08 — `espacos` escrito como "5º Andar, 6º
    Andar" para bater com as duas keywords separadamente), *Colectivo Acciones de Arte* (4º
    Andar, 07/04–02/08), *Histórias latino-americanas* (todos os 5 andares, 04/09–31/01/27 —
    `espacos` lista os 5 andares por extenso, já que "todos os andares" não bate com nenhuma
    keyword). "Histórias da ecologia" (2025-09-04–2026-02-01, Pietro) **não** foi inserida:
    termina antes do início dos dados dos sensores do Pietro (fev/2026), sem sobreposição.
  - 14 ocorrências inseridas (`ocorrencias`, ids 222–235) a partir das linhas ainda não
    importadas da planilha (a coluna "Registrado no Dash" está desatualizada — 3 linhas
    já estavam no banco apesar de marcadas `FALSE`; comparei por data+descrição, não pela
    coluna). Mapeamento tipo-livre→enum e fonte→enum seguiu o padrão já usado nas ~217
    ocorrências existentes (ex.: "Queda de energia"→`falha_equipamento`, "Outro"/
    "Manutenção..."→`manutencao`, "Montagem/Desmontagem"→`obra`, "Troca de
    datalogger"/deslocamento físico→`sensor_deslocado`). Eventos que afetaram os dois
    prédios (ex.: pico de energia de 24/03) foram gravados com `predio='Ambos'` (suportado
    nativamente pelo filtro de `/api/ocorrencias`) em vez de duas linhas duplicadas.
    Duas datas exigiram interpretação (confirmadas com a Yasmin): "04/08/0206" → 2026-08-04
    (typo no ano) e "08-09/02/2026" 00:00–12:00 → início 08/02 00:00, fim 09/02 12:00. Fonte
    "Conservação/restauro" (3 ocorrências, não existe no dropdown atual) foi gravada como
    `verbal`. Nome "Yasmin Bitenocuirt" (typo na planilha) normalizado para "Yasmin
    Bitencourt", como aparece no resto do banco.
  - Depois da inserção, rodei `/api/admin/recalcular_periodo` (confirmei no servidor de dev
    já em execução da Yasmin, na porta 5000, para invalidar o cache dele também) — as 5
    exposições nova cruzaram corretamente com as medições existentes de cada andar do
    Pietro (conferido por amostragem em `medicoes.periodo_expositivo_nome`).

---

## 10. Convenções

- **Idioma**: tudo em português — nomes de função, variáveis, comentários, UI (exceto o
  relatório, que tem toggle PT/EN). Manter.
- **Nomenclatura de sensor**: inclui o prédio quando poderia ser ambíguo (todos os do
  Pietro terminam em "Pietro"); o campo `andar` interno é só o descritor de andar, usado
  pela lógica de cruzamento — não precisa (e não deve) repetir o prédio.
- **Estilo JS**: funções globais nomeadas, `async/await`, sem classes, sem módulos ES.
- **Estilo Python**: comentários com cabeçalhos `# ── SEÇÃO ───`, docstrings em português.
- **Funções compartilhadas ficam no topo do módulo**: quando a mesma regra é usada por mais
  de uma rota (cruzamento de exposição, resolução de sensor), definir uma vez em nível de
  módulo — não duplicar dentro de cada função de rota. Já foi preciso desfazer duplicação
  assim mais de uma vez nesta sessão.
- **Cache-busting**: qualquer `<script>`/`<link>` novo precisa do `?v={{ api_version }}`
  (e `api_version` precisa continuar cobrindo o arquivo novo em `_combined_hash`).

---

## 11. Rodando

```bash
pip install -r requirements.txt   # agora inclui openpyxl
python app.py                     # http://localhost:5000 — cria/migra o banco sozinho
```

Variáveis: `DB_PATH`, `ACCESS_TOKEN`, `FLASK_ENV`, `PORT`. Produção via Gunicorn
(`Procfile`), volume persistente pro `.db`.

---

## 12. Onde olhar primeiro

| Quero… | Vá para |
|---|---|
| Mudar faixa de temperatura/UR de um padrão | Tabela `padroes_conformidade` no banco (lida por `conformidade.get_padroes`) — mas lembrar que o frontend tem cópias hardcoded, ver §9.3 |
| Adicionar um prédio/andar novo | `_ANDAR_KEYWORDS` em `app.py` (§4), criar sensor via UI ou API com `predio` certo |
| Entender por que uma exposição não está sendo reconhecida | `_expositivo_para`/`_normalizar_texto` em `app.py` — checar espaço duplo, `º` vs `°`, `predio` da exposição |
| Adicionar um gráfico no dashboard | `charts.js` + canvas no `templates/index.html` |
| Adicionar um formato de importação novo | Ver §5 — decidir se cabe no parser CSV existente ou merece endpoint próprio como `/api/upload_xlsx` |
| Mexer no relatório (conteúdo, seções, interno/externo) | `admin.js` → `openReportWindow()`, `getReportContentSettings()`; checkboxes em `templates/index.html` |
| Mexer em filtros | `ui.js` → `populateFilters()`; `api.js` → `getFilters()`; `app.py` → `build_filtros()` |
| Entender conformidade | `conformidade.py` |
| Entender desvios | `desvios.py` — mas ver §9.1 antes, parte é código morto |
