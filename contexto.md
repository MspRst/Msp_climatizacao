# Contexto do Projeto — MASP Dashboard

> Documento de contexto para quem (pessoa ou agente) vai retomar o trabalho neste repositório.
> Complementa o `README.md` (o que o sistema faz: schema, API, deploy) e o `ANALISE-TECNICA.md`
> (dívida técnica catalogada — dead code, duplicações, recomendações). Este arquivo é sobre
> **como o código está organizado hoje e por que**.

Última atualização: 2026-09-18 · Branch: `main` — ver §3 para o histórico de commits recente

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
| `import_dados.py` | ~416 | CLI de importação (BD SQLite externo, JSON, XLSX genérico, exposições) — **não** entende o formato XLSX do Pietro, só o dashboard entende (ver §5) |
| `atualizar_expos.py` | — | Script de atualização de exposições a partir do CSV |
| `templates/index.html` | ~960 | Casca da SPA — abas, filtros, canvases, formulário do relatório |
| `templates/modals.html` | ~348 | Todos os modais, incluído via `{% include %}` |
| `static/css/style.css` | ~1780 | Estilo completo, tokens em CSS custom properties |
| `static/api.js` | ~180 | Camada de dados: objeto `API`, `getFilters()`, `loadTab()`, `loadAll()`, boot |
| `static/ui.js` | ~345 | Abas, filtros (agrupados por **prédio + andar**, ver §4), chips de sensores, toasts |
| `static/charts.js` | ~1820 | Todos os gráficos do dashboard (mensal, sazonal, horário, alertas, orvalho, heatmap) |
| `static/admin.js` | ~3625 | Aba Gerenciar + Relatório: CRUD, importação CSV/XLSX, geração do relatório completo |

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

Sessão de 2026-09-18 (ajustes na emissão de relatórios, ver §9 "Resolvido em 2026-09-18"):
`255af58` (conserto do checkbox de desvios + opções de sumário/térreo/gráficos mensais +
tradução), `a8affbf` (filtro de período expositivo), e um commit seguinte com as anotações
automáticas de início/fim de exposição — confirmar o hash mais recente com `git log --oneline
-5` se precisar apontar pra um específico.

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

### Armadilha real encontrada: vírgula decimal virando data no Excel
Em exports antigos do Pietro (antes da padronização de 2026 — ver "Histórico pré-2026" logo
abaixo), quando a planilha original usava vírgula como separador decimal (`"21,8"`) e alguém
abriu/salvou o arquivo no Excel com autodetecção de tipo ligada, valores de temperatura que
"pareciam" uma data válida (dia ≤31, "mês" ≤9, ou seja só 1 casa decimal) foram silenciosamente
convertidos em células de data (`21,8` → 21/8, dia=21 mês=8). Valores que não formam data válida
(ex. `22,0`, mês=0 inválido) permaneceram texto normal — então dentro do MESMO arquivo, a coluna
de temperatura mistura `datetime` corrompido e string normal linha a linha. Reversível com
`temp = data.day + data.month/10` (confirmado reconstruindo uma série de 24h e checando que fica
suave/fisicamente plausível — nenhum mês > 9 apareceu em nenhum arquivo, confirmando 1 casa
decimal). Umidade nunca é afetada (valores ≥37 nunca formam dia/mês válido). Se aparecer outro
lote de planilhas antigas do Pietro com esse sintoma (coluna de temperatura com tipo `datetime`
inesperado no openpyxl), é o mesmo bug.

### Histórico pré-2026 do Pietro (importado em 2026-09-17)
`graficos_pra_alterar/` (na raiz, agora no `.gitignore` — dados operacionais reais) tinha ~22
arquivos brutos dos 5 andares do Pietro cobrindo fev/2025–jan/2026, com formatos inconsistentes
(CSV vs. XLSX single-andar vs. XLSX multi-andar) e MUITA sobreposição de período entre arquivos
(inclusive 3 cópias idênticas de `Pietro_jun24-jul25.xlsx`). Consolidei por andar aplicando uma
cadeia de prioridade cronológica (arquivo mais recente/mais confiável vence em caso de conflito
de timestamp) e apliquei o fix de vírgula-decimal acima nos XLSX afetados. Descartei
`PIETRO_*ANDAR.xlsx`/`_out25.xlsx` inteiros por serem 100% redundantes com os CSVs
`{andar}_pietro_Gráfico...csv` (que cobrem jun/2025–jan/2026 de forma limpa, sem o bug).
Resultado: série contínua por andar sem duplicatas, sem sobreposição com os dados já no banco
(que começam em fev/2026 para os andares 3–6 e jul/2026 para o 2º Andar — sem gap coberto por
nenhum dos dois, jan–fev/2026 continua sem dado). Gerados 54 arquivos `.xlsx` em
`graficos_pra_alterar/organizado_para_upload/` (`PIETRO_{andar}ANDAR_{ano}-{mês}.xlsx`), um por
andar×mês, já no formato exato que `/api/upload_xlsx` espera (colunas `Time stamp`,
`Temperatura Ambiente`, `Umidade Ambiente`) — faltando só o upload manual pela tela
Gerenciar → Sensores (o *guess* de sensor pelo nome do arquivo deve sugerir certo, mas confirme
antes de enviar).

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
- **Idioma PT/EN** via `I18N` (`getReportContentSettings().lang`). Ver "Tradução" abaixo —
  não é só trocar `I18N[lang]`, tem gente-de-fora do dicionário (datas, tooltips, canvas).
- **Filtro de período expositivo** (`repExpoFiltro`, seletor de 3 estados): `todos` (padrão) |
  `expo` (só em exposição) | `nao_expo` (só sem exposição). Ver "Filtro de período expositivo"
  abaixo — **não é cosmético**, filtra a série de cada sensor na origem (`sensorsData` map em
  `openReportWindow`) e cascateia pra tudo: gráfico, % conformidade, médias, desvios, mensal.
- Checkboxes independentes por seção: capa, guia, **sumário/índice** (`includeIndex` —
  criado nesta sessão; antes existia no código mas não tinha controle na tela, ficava sempre
  incluído), tabela comparativa geral, "Tendência de Conformidade Comparativa" (página global,
  canvas `canvas_global_monthly`), páginas de sensor, gráficos, **— incluir linha do Térreo**
  (`includeTerreo`, sub-item de "Gráficos"), **— dividir gráficos por mês**
  (`splitChartsByMonth`, sub-item de "Gráficos" — ver "Gráficos mês a mês" abaixo),
  **— marcar início/fim de cada exposição** (`markExpoBoundaries`, sub-item de "Gráficos",
  ligado por padrão — ver "Anotações verticais" abaixo), ocorrências, tabela de evolução
  mensal *por sensor*, **análise de desvios** (`includeDeviations` — existia desde antes mas
  não fazia nada; o valor era lido em `getReportContentSettings()` só nunca chegava a ser
  aplicado em `openReportWindow()`, corrigido nesta sessão).

### Anotações verticais no gráfico
Duas fontes, mesmo mecanismo de desenho (`customEventPlugin`, dentro de `mkChart`) — os itens
de `_zm.customMarkers` só precisam de `{date, label}` (mais `color` opcional, padrão roxo
`#8b5cf6`):
- **Manuais**: `addCustomMarkerRow()`/`repCustomMarkersWrap` no formulário — o usuário digita
  data+descrição livre. Viram `contentSettings.customMarkers`.
- **Automáticas de início/fim de exposição** (`markExpoBoundaries`, criado nesta sessão):
  `buildExpoBoundaryMarkers()` (dentro do `<script>` embutido do relatório) percorre
  `periodoExpo`/`periodoExpoNomes` — a MESMA varredura de trechos contínuos que o
  `expoShadingPlugin` já fazia pra desenhar a faixa vermelha — e gera um marcador "INÍCIO —
  NOME"/"FIM — NOME" (cor vermelha `#E30613`, pra diferenciar das manuais) nas bordas de cada
  trecho "em exposição". Concatenados com as manuais antes de montar `_zm.customMarkers`, então
  aparecem juntos no mesmo gráfico sem conflito.
  **Não marca a borda quando ela é só um limite dos DADOS, não um limite real da exposição** —
  `buildExpoBoundaryMarkers()` só emite "INÍCIO" se `s > 0` (tinha um ponto "sem exposição"
  logo antes, dentro do próprio período mostrado) e só emite "FIM" se `endIdx <
  periodoExpo.length - 1` (idem, logo depois). Sem essa checagem, uma exposição que já estava
  em curso no primeiro dado do período, ou que continuava depois do último dado do período,
  ganhava uma marcação de "início"/"fim" falsa bem na borda do gráfico — foi o bug reportado
  com o relatório de maio/2025 (exposição que seguia além de maio aparecia como se tivesse
  "terminado" no fim do mês). O `expoShadingPlugin` (faixa vermelha de fundo) não tem esse
  problema porque não afirma nada sobre início/fim, só sombreia o trecho que é "em exposição"
  dentro do que existe de dado.
- **Bug corrigido nesta sessão**: `customEventPlugin` descartava silenciosamente qualquer
  marcador com data ANTERIOR ao primeiro ponto do gráfico daquele sensor específico (sem aviso
  nenhum) — só marcadores com data POSTERIOR ao último ponto eram "grampeados" na borda. Isso é
  exatamente o caso comum de marcar o **início** de uma exposição que começou antes do período
  selecionado no relatório. Agora os dois lados grampeiam na borda mais próxima em vez de um
  lado sumir. Se voltar a acontecer de "só uma anotação aparecer", primeiro suspeitar disso de
  novo: comparar a data do marcador com o intervalo de dados daquele sensor específico (cada
  sensor pode ter uma primeira/última leitura diferente dentro do mesmo período de relatório).

### Gráficos de sensor — rótulo de período expositivo
`expoShadingPlugin` (dentro de `mkChart`, dentro do HTML gerado) desenha, para cada trecho
contínuo do eixo X, **"EM EXPOSIÇÃO"** (+ nome da exposição, se couber) ou
**"SEM EXPOSIÇÃO"** — com fundo clarinho atrás do texto para legibilidade. O rótulo fica
colado na base do gráfico (acima da faixa vermelha, entre as curvas de dados e a legenda
que vem logo abaixo do canvas) — não no topo, onde atrapalhava a leitura das curvas. Só
rastreia transição 0/1 (em exposição ou não), não troca de nome dentro do mesmo trecho — se
duas exposições diferentes forem consecutivas sem gap, viram um único trecho sombreado (mesma
limitação vale pras anotações automáticas de início/fim, que usam a mesma varredura).

### Gráficos mês a mês (`splitChartsByMonth`, criado nesta sessão)
Desligado por padrão. Ligado, cada sensor passa a ter uma seção de Temperatura e uma de
Umidade com **um gráfico por mês** (tamanho normal, não miniatura) em vez de um gráfico único
comprimindo o período inteiro em `MAX_PTS` (800) pontos — cada mês subamostra
independentemente, então ganha resolução própria. Implementado em duas frentes:
- **Geração** (`sensorsData` map): agrupa `serie` por `YYYY-MM`, gera `monthlySeries`
  (subamostra + alinha Térreo por mês).
- **Payload/render** (`chartPayload` → `monthlyCharts`, `DATA.forEach` no script embutido):
  quando `d.monthlyCharts.length` existe, chama `mkChart` uma vez por mês (canvas
  `${safeId}_T_${mesKey}`/`_R_${mesKey}`) em vez de uma vez pro período inteiro. Ocorrências e
  marcadores manuais são filtrados por mês (`substring(0,7) === mc.mes`) pra não vazar um
  evento de um mês pro gráfico de outro.

### Filtro de período expositivo (`expoFiltro`, criado nesta sessão)
Seletor de 3 estados (`todos` | `expo` | `nao_expo`). Aplicado no **início** do `sensorsData`
map, antes de qualquer cálculo — filtra `serie` (renomeada `rawSerie` no destructuring) por
`periodo_expositivo`, e essa `serie` filtrada é usada daí pra frente em tudo: `serieSub`,
`monthlySeries`, conformidade, tabela mensal, análise de desvios. Duas armadilhas resolvidas:
- `stats` vem **pré-calculado pelo backend pro período inteiro sem filtro** — com o filtro
  ativo, força recálculo client-side (`avgOf()` pra T/UR média, `confPadrao`/`confT`/`confUR`
  em vez dos `stats.conf_total_*` prontos) — senão os números do relatório continuariam do
  período inteiro mesmo com o gráfico filtrado.
- `monthly` (tabela de evolução mensal) tem o mesmo problema com `mensalAPI` — força
  `calcMonthly(serie, ...)` (client-side, já filtrado) em vez do array pronto da API quando
  `expoFiltroAtivo`.
- Independente do modo mês a mês — combina com os dois ligados ao mesmo tempo.
- Se um sensor não tiver NENHUM dado que bata com o filtro no período (ex.: filtrar "Só Em
  Exposição" num sensor que nunca teve exposição), a página dele no relatório ainda aparece,
  só que com estatísticas em branco (`–`) e gráfico vazio — não é omitida automaticamente.

### Tradução (PT/EN) — pontos fáceis de esquecer
`I18N.pt`/`I18N.en` (mesmas chaves nos dois, conferido) cobre a maior parte, mas várias coisas
no relatório **não passam pelo dicionário** porque são geradas dentro do `<script>` embutido
(roda no navegador de quem abre o relatório, não no `admin.js` que gera a string) ou usam
`.toLocaleString('pt-BR')` fixo. Corrigido nesta sessão, mas se acrescentar texto novo no
relatório, lembrar de checar isso de novo:
- **Formatação de data/número**: usar a const `dateLocale` (`'pt-BR'`/`'en-US'`, definida no
  topo de `openReportWindow`), nunca `'pt-BR'` direto.
- **Dentro do `<script>` embutido** (`mkChart`, `expoShadingPlugin`, `customEventPlugin`,
  `zonaPlugin`, tooltip do Chart.js, `fmtMonth` — SIM, existem DUAS funções `fmtMonth`, uma no
  escopo externo (usada pra gerar o HTML) e outra dentro do `<script>` embutido (usada pelo
  gráfico global mensal) — as duas precisam do mesmo tratamento de idioma): como esse bloco é
  só texto dentro de um template literal, qualquer rótulo fixo tem que virar uma constante
  `var L_XXX = ${JSON.stringify(lang === 'pt' ? '...' : '...')};` calculada na geração (idioma
  fica fixo pro relatório inteiro, não muda em runtime) — todas as constantes `L_*` ficam juntas
  logo depois do `var DATA = JSON.parse(...)`, no topo do `<script>`.

---

## 9. Pendências e problemas conhecidos

Ver `ANALISE-TECNICA.md` para a lista completa com prioridade. Resumo do que **ainda não**
foi feito (o que já foi resolvido nesta sessão não está mais aqui — checkbox de evolução
mensal, linha do térreo, cache-busting, exposições com espaço duplo/caractere errado,
recalcular_periodo (era stub), espaco_expositivo, multi-prédio, `/api/sazonal` ausente,
página de tendência em branco, cards melhor/pior desempenho, tabela `desvios` morta, regra
do Híbrido triplicada, faixas de conformidade hardcoded no JS — tudo isso está corrigido):

| # | Item | Detalhe |
|---|---|---|
| 1 | `admin.js` com ~3625 linhas | CRUD + parsing de CSV/XLSX + análise de não-conformidades + geração inteira do relatório. Candidato a quebra em módulos. |

### Resolvido em 2026-09-18
Pedido da Yasmin: ajustes na emissão de relatórios, um tópico de cada vez, do mais simples ao
mais complexo. Ver §8 para o detalhe técnico de cada item; resumo aqui:
- **Checkbox "Análise de Desvios" consertado** — `getReportContentSettings()` já lia o valor
  (`includeDeviations`) mas `openReportWindow()` nunca aplicava; a seção sempre aparecia
  independente do checkbox. Agora `content.includeDeviations` gateia a seção de verdade.
- **Checkbox de Sumário/Índice** (`includeIndex`) — a página já existia no código
  (`indexPage`, rotulada "SUMÁRIO"/"TABLE OF CONTENTS") mas não tinha controle nenhum na tela,
  sempre incluída. Adicionado o checkbox que faltava.
- **Checkbox pra remover a linha do Térreo dos gráficos** (`includeTerreo`) — antes era tudo
  ou nada, automático sempre que havia dado de Térreo no período. Agora dá pra desligar; a
  flag cascateia por `temTerreo` pra legenda, estatísticas e o dado passado pro gráfico.
- **Vazamentos de português corrigidos no relatório em inglês** — ver §8 "Tradução (PT/EN)".
  Incluía: data de geração da capa, "Térreo" no dataset do gráfico, tooltip inteiro do
  Chart.js, rótulos "EM/SEM EXPOSIÇÃO" desenhados no canvas, "Máx:"/"Mín:" das zonas, nomes de
  mês abreviados no gráfico de tendência global (havia uma segunda cópia de `fmtMonth`
  só-PT dentro do `<script>` embutido), separador de milhar (`toLocaleString`), atributo
  `lang` do `<html>`.
- **Gráficos mês a mês** (`splitChartsByMonth`) — nova opção, desligada por padrão. Ver §8.
- **Filtro de período expositivo** (`expoFiltro`: todos/expo/nao_expo) — nova opção, afeta
  gráficos E estatísticas (recalcula tudo em cima só dos dados filtrados). Ver §8.
- **Anotações automáticas de início/fim de exposição** (`markExpoBoundaries`, ligado por
  padrão) — usa o mesmo mecanismo de desenho das anotações manuais (`customEventPlugin`),
  gerando marcadores a partir de `periodoExpo`/`periodoExpoNomes`. Ver §8 "Anotações
  verticais".
- **Bug real corrigido: anotação manual "sumia" quando a data era anterior ao início dos
  dados daquele sensor específico** — `customEventPlugin` descartava silenciosamente esse
  caso (só grampeava na borda quando a data era POSTERIOR ao fim); reportado pela Yasmin como
  "adicionei duas anotações, só uma apareceu". Corrigido pra grampear nos dois lados.
- **Deploy em produção mapeado** (ver novo §12) — a pasta de trabalho
  (`\\192.168.0.215\masp-dashboard\`) é um compartilhamento de rede pra dentro da PRÓPRIA
  máquina que roda o serviço `MASPDashboard` (NSSM, Windows Service) — os arquivos editados
  aqui já são os arquivos de produção, sem passo de deploy. `git push` é só backup/histórico,
  não aciona nada. Mudanças em `templates/*.html` só valem depois de reiniciar o serviço
  (Jinja com `auto_reload` desligado em produção não relê `.html` sozinho); mudanças em
  `static/*.js` já valem no próximo request (servidas direto do disco, hash de cache-busting
  recalculado a cada request).

### Resolvido em 2026-09-15
- **Faixas de conformidade centralizadas no backend** — `padroes_conformidade` (via
  `conformidade.get_padroes()`, já usada pelos cálculos) agora também alimenta a exibição:
  `app.py` ganhou `_padroes_para_frontend()` (formata pra `{tMin,tMax,urMin,urMax,tMinFmt,
  urMinFmt,...,label,desc}`), exposto em `/api/meta` (`padroes`) e passado pro
  `render_template` do `index.html`. `api.js` ganhou `getPadraoConformidade(chave)`, que lê
  `window._padroes` (preenchido por `populateFilters()` no boot) com um fallback local
  idêntico ao banco só pro instante antes do boot responder. Isso eliminou pelo menos 8
  cópias hardcoded dos números (18–22/45–55/etc.) espalhadas por `admin.js` (`PADROES_NORMA`,
  `PADROES` da análise de não-conformidades), `charts.js` (zonas do Scatter, legenda do
  Mensal, `_horarioLabels`, `PADRAO_DESC` do export PNG, faixas do Sazonal, zona do gráfico
  de Alertas) e texto estático em `index.html`/`modals.html` — mais lugares do que os ~5
  catalogados originalmente em `ANALISE-TECNICA.md` §2.4. Verificado com Playwright contra o
  servidor de dev: zero erros de console, valores corretos em todas as telas afetadas
  (métricas, Scatter, Mensal, Sazonal, Alertas, modal de sensor), sem regressão visual.
- **Bug real: legenda do MASP no gráfico Mensal mostrava a faixa errada de temperatura** —
  `normaFaixas.masp.tLabel` (`charts.js`, gráfico "Evolução Mensal") dizia **"T: 18–22°C"**
  (a faixa do IBRAM) em vez de **"T: 18–23°C"** (MASP: 18–23°C · 45–55% UR, confirmado
  contra `padroes_conformidade` no banco). Os cálculos de conformidade em si estavam certos
  (usam `conf_total_masp`, já calculado certo no backend) — só a legenda do gráfico exibia
  o número errado. Encontrado ao auditar as cópias hardcoded das faixas de conformidade no
  JS (`ANALISE-TECNICA.md` §2.4) — nenhuma outra cópia tinha esse tipo de mixup.
- **Regra do padrão Híbrido centralizada** — nova coluna `sensores.padrao_hibrido`
  (`'masp'` | `'bizot'`, default `'bizot'`), editável em Gerenciar → Sensores (mesmo padrão
  de `espaco_expositivo`). Substituiu as 3 reimplementações da regra "só 1º Andar
  Frente/Fundo usa MASP": o `CASE WHEN` por `LIKE` em `/api/metricas` e `/api/pontos`
  (`app.py`) virou `WHEN s.padrao_hibrido = 'masp'`, e o `isMaspSensor` por regex de nome em
  `admin.js` (geração do relatório) virou leitura de `padrao_hibrido` via `/api/meta`
  (`generateReport()` monta um mapa nome→padrão, `openReportWindow()` usa `PADROES_NORMA.masp`/
  `.bizot` em vez de duplicar os números 18–23/45–55 e 15–25/40–60 outra vez). Migração faz
  backfill automático (uma vez, dentro do próprio `try` do `ALTER TABLE ADD COLUMN`) marcando
  `'masp'` só nos sensores que já bateriam com a regra antiga — comportamento observável não
  muda. Testado manualmente: `/api/meta`, `/api/metricas`, `/api/pontos` e o CRUD
  (`/api/admin/sensores` GET/PUT) com o servidor de dev rodando.
- **Tabela `desvios` + `/api/desvios` removidos** — feature morta (ANALISE-TECNICA §2.2):
  tabela sempre tinha 0 linhas, as funções que gravariam nela (`desvios.py`) nunca eram
  chamadas, e nenhuma tela chamava o endpoint (só `/api/desvios-preview`, que é
  autocontido em `app.py` e não depende de nada disso). Deletei `desvios.py` inteiro, removi
  a rota `/api/desvios` e o import correspondente em `app.py`, e dropei a tabela `desvios`
  (0 linhas, confirmado antes do drop) do `climatizacao_museu.db`. Nada mais referenciava o
  módulo ou o endpoint (confirmado por busca em todo o repo).
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

Variáveis: `DB_PATH`, `ACCESS_TOKEN`, `FLASK_ENV`, `PORT`. Há um `Procfile` (Gunicorn) no
repo, mas **não é o que roda em produção hoje** — ver §12.

---

## 12. Deploy em produção (descoberto/confirmado em 2026-09-18)

O dashboard "de verdade" (o que a equipe acessa) **não** é implantado via Gunicorn/Procfile —
roda como **serviço do Windows** numa VM do TI do MASP:

- **Máquina**: Windows Server, IP `192.168.0.215`. Passo a passo de acesso/manutenção em
  `PASSO-A-PASSO-DEPLOY.txt` (na raiz) — RDP com usuário Administrador, diretório
  `C:\inetpub\www\masp-dashboard`.
- **A pasta de trabalho deste projeto (`\\192.168.0.215\masp-dashboard\`) é um
  compartilhamento de rede APONTANDO PRA ESSA MESMA MÁQUINA** — ou seja, editar arquivos aqui
  edita os arquivos de produção diretamente, sem precisar copiar/publicar nada.
- **Serviço**: `MASPDashboard` (nome de exibição "MASP Dashboard - Monitoramento
  Climatização"), gerenciado via **NSSM**. Comandos (rodar no servidor, PowerShell como
  Administrador): `nssm restart|stop|start MASPDashboard`. Dá pra checar/reiniciar
  remotamente sem RDP com `Get-Service -ComputerName 192.168.0.215 -Name MASPDashboard` /
  `(Get-Service -ComputerName 192.168.0.215 -Name MASPDashboard).Stop()` +`.Start()` — só
  funciona se a conta do Windows atual tiver permissão de admin remota na VM; `Restart-Service`
  **não aceita** `-ComputerName` (usar o objeto `ServiceController` + `.Stop()`/`.Start()`, ou
  `sc.exe \\192.168.0.215 ...`).
- **Acesso**: `http://climatizacao.masp.org.br:5000` (ou porta 80), `http://192.168.0.215:5000`,
  `http://localhost:5000` (na própria VM).

### `git push` NÃO faz deploy
Não existe pipeline/CI configurado (`.github/` no repo só tem instruções de extensão VS Code,
nada de deploy). Dar push manda só um backup/histórico pro GitHub — o serviço continua rodando
os arquivos que já estavam no disco da VM. Como esses arquivos são os mesmos que este projeto
edita diretamente (ver acima), isso normalmente não importa — mas **não confundir "dei push"
com "está no ar"**.

### Templates Jinja exigem reiniciar o serviço; JS não
- `templates/*.html` (`index.html`, `modals.html`): Flask/Jinja cacheia o template compilado em
  memória; em produção (`debug=False`) o `auto_reload` fica desligado por padrão, então o
  processo **não percebe sozinho** que o `.html` mudou no disco — só relê no próximo restart.
  Sintoma: usuária reclama que deu Ctrl+F5 e nada mudou — não é cache do navegador, é cache do
  processo no servidor.
- `static/*.js` (`api.js`/`ui.js`/`charts.js`/`admin.js`): servidos direto do disco a cada
  request (rota `/static/api.js` tem handler próprio com ETag; os outros pelo `static_folder`
  padrão do Flask), e o hash de cache-busting (`_combined_hash` em `app.py`, injetado em
  `index()`) é recalculado a cada request — mudança nesses arquivos já vale no próximo load da
  página, **sem precisar reiniciar o serviço**. (Mas se a mudança também mexeu em
  `templates/index.html` — ex.: um checkbox novo — precisa reiniciar mesmo assim pra esse HTML
  aparecer.)
- **Regra prática**: depois de editar `templates/*.html`, sempre reiniciar o serviço antes de
  pedir pra alguém testar. Depois de editar só `static/*.js`, só pedir refresh normal já deve
  bastar — mas reiniciar não faz mal nenhum e elimina a dúvida.

---

## 13. Onde olhar primeiro

| Quero… | Vá para |
|---|---|
| Mudar faixa de temperatura/UR de um padrão | Tabela `padroes_conformidade` no banco (lida por `conformidade.get_padroes`) — o frontend inteiro lê dali via `/api/meta` (`getPadraoConformidade()` em `api.js`), não precisa editar nada no JS |
| Adicionar um prédio/andar novo | `_ANDAR_KEYWORDS` em `app.py` (§4), criar sensor via UI ou API com `predio` certo |
| Entender por que uma exposição não está sendo reconhecida | `_expositivo_para`/`_normalizar_texto` em `app.py` — checar espaço duplo, `º` vs `°`, `predio` da exposição |
| Adicionar um gráfico no dashboard | `charts.js` + canvas no `templates/index.html` |
| Adicionar um formato de importação novo | Ver §5 — decidir se cabe no parser CSV existente ou merece endpoint próprio como `/api/upload_xlsx` |
| Mexer no relatório (conteúdo, seções, interno/externo, filtros, gráficos mês a mês, anotações) | `admin.js` → `openReportWindow()`, `getReportContentSettings()`, `mkChart()`; checkboxes/seletores em `templates/index.html`; ver §8 |
| Mexer em filtros | `ui.js` → `populateFilters()`; `api.js` → `getFilters()`; `app.py` → `build_filtros()` |
| Entender conformidade | `conformidade.py` |
| Entender desvios | `/api/desvios-preview` em `app.py` (cálculo on-the-fly, é o único caminho real — `desvios.py`/`/api/desvios` foram removidos por serem código morto) |
| Testar uma mudança e não sabe por que não aparece no site | §12 — provavelmente falta reiniciar o serviço `MASPDashboard` |
