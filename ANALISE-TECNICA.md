# Análise Técnica — MASP Dashboard

> Levantamento profundo do estado atual do sistema: o que está morto, duplicado,
> lento ou quebrado, e o que já foi corrigido nesta sessão vs. o que fica como
> recomendação para uma próxima passada. Complementa o `contexto.md` (arquitetura
> geral) — este documento é sobre **dívida técnica e correção**, não sobre "como o
> sistema funciona".

Data: 2026-09-11 · Banco analisado: `climatizacao_museu.db` (2.901.038 medições)

---

## 1. Já corrigido nesta sessão

| # | Problema | Causa raiz | Correção |
|---|---|---|---|
| 1 | Checkbox "Tabela de Evolução Mensal" no relatório não escondia nada | `content.includeMonthly` nunca era propagado do `contentSettings`; a tabela por sensor estava amarrada a `content.includeCharts` por engano | `admin.js`: propaga o flag certo e reamarra a tabela a ele |
| 2 | Linha tracejada do "Térreo" nos gráficos virava pontos soltos | `alignTerreo` casava a série do sensor (subamostrada) contra o térreo *também* subamostrado, com intervalos diferentes — quase nada batia | Casa contra a série completa do térreo + `spanGaps:true` |
| 3 | `/static/*.js` não invalidava cache ao editar `ui.js`/`charts.js`/`admin.js` | hash de cache-busting (`?v=`) calculado só a partir de `api.js` | Hash combinado dos 4 arquivos |
| 4 | Exposição "Carolina Caycedo" não marcava período expositivo no 1º andar | Campo `espacos` da exposição com espaço duplo ("1º **⎵⎵**Andar") quebrando o match por substring | Normalização colapsa espaços múltiplos |
| 5 | Exposição "Damián Ortega" (e mais 7 de 101) não marcava período expositivo | Campo `espacos` usava `°` (grau) em vez de `º` (ordinal) — caracteres Unicode diferentes | Normalização trata `º`/`°` como iguais |
| 6 | Botão "Recalcular Período Expositivo" não fazia nada | `/api/admin/recalcular_periodo` era um **stub**: sempre retornava zeros sem tocar o banco | Implementado de verdade (UPDATE em lote por andar×exposição) |
| 7 | Ateliê de Restauro / Reservas Técnicas / CP entravam como "em exposição" | Cruzamento era por **andar inteiro**, sem distinguir sala expositiva de sala técnica no mesmo andar | Nova coluna `sensores.espaco_expositivo`, editável na UI |
| 8 | Sistema não distinguia prédio (Lina vs. Pietro) no cruzamento andar↔exposição | `_ANDAR_KEYWORDS` e o caso especial do 2º andar (acervo permanente) eram só por texto de andar, sem `predio` | `exposicoes.predio` + matching agora é (prédio, andar) |
| 9 | Chips de filtro e checkboxes do relatório agrupavam só por `andar` | Um "2º Andar" do Pietro se misturaria com o "2º Andar" do Lina | Agrupamento agora é por `predio + andar` |
| 10 | Gráfico Sazonal sempre vazio (404 em `/api/sazonal`) | Endpoint nunca foi implementado — só existia a chamada no frontend | Implementado (percentis por estação × interno/externo), cacheado 1h |

---

## 2. Achados que ficam para decisão/próxima passada

### 2.1 — Tabelas mortas no banco (⚠️ ação recomendada, não executada)

Nenhum destas é referenciada por `app.py`, `conformidade.py`,
`import_dados.py` ou `atualizar_expos.py` — confirmado por busca no código inteiro:

| Tabela | Linhas | O que parece ser |
|---|---|---|
| **`medicoes_nova`** | **2.677.584** | Cópia quase completa de `medicoes` (mesmas colunas, quase o mesmo volume) — sobra de uma migração antiga que nunca foi finalizada/removida (o padrão `_new` → rename → drop existe em `_run_migrations` para `ocorrencias_sensores`, mas para `medicoes` ficou pela metade). **Ocupa quase metade do arquivo de 1 GB.** |
| `dados_diarios` | 8.024 | Agregado diário pré-calculado — de um design anterior, antes de `/api/agregado` calcular tudo ao vivo |
| `dados_mensais` | 276 | Mesma ideia, agregado mensal pré-calculado |
| `pontos_de_medicao` | 0 | Rascunho de schema anterior a `sensores` |

**Recomendação:** dropar as 4. Ganho estimado: o arquivo `.db` pode cair de ~1 GB para
algo perto de ~500-600 MB (a maior parte é `medicoes_nova`). **Não fiz isso ainda** —
é uma operação destrutiva em dados reais e prefiro sua confirmação explícita antes,
mesmo com backup feito.

### 2.2 — Feature morta: `desvios` (tabela) + `/api/desvios` (endpoint) — ✅ resolvido em 2026-09-15

- A tabela `desvios` tem **0 linhas**.
- As únicas funções que gravariam nela (`calcular_desvios_serie` + `armazenar_desvios`,
  em `desvios.py`) **nunca são chamadas** em `app.py`.
- `/api/desvios` (distinto de `/api/desvios-preview`, que É usado) lê dessa tabela
  sempre vazia — ou seja, **sempre retorna zero desvios**, não importa o sensor ou
  período pedido.
- Nenhum arquivo `.js` chama `/api/desvios` (só o `-preview`, que tem implementação
  própria e funciona).

Isso é uma funcionalidade que foi desenhada (tem até `associar_desvios_a_ocorrencias`
para juntar desvios a manutenções) mas nunca foi ligada ao resto do sistema — o
relatório de desvios real usa outro caminho (`/api/desvios-preview`, cálculo direto
sobre `medicoes`).

**Resolvido**: `desvios.py` foi deletado por inteiro (nada mais o importava — nem a
`-preview`, que é autocontida em `app.py`), a rota `/api/desvios` e seu import foram
removidos de `app.py`, e a tabela `desvios` (0 linhas, confirmado antes do drop) foi
dropada do `climatizacao_museu.db`.

### 2.3 — Regra do padrão Híbrido duplicada em 3 lugares — ✅ resolvido em 2026-09-15

"Quais sensores usam MASP vs. Bizot" estava reimplementada, à mão, em:

1. `app.py` → `/api/metricas` (SQL, `LIKE '%1%andar%frente%'...`)
2. `app.py` → `/api/pontos` (mesmo SQL, copiado)
3. `static/admin.js` → geração do relatório (`isMaspSensor`, mesma regra em JS)

Isso já tinha causado um bug real: quando a regra mudou (de "todo 1º andar" para
"só Frente/Fundo"), foi preciso lembrar de editar os 3 lugares — e é fácil esquecer um.

**Resolvido**: nova coluna `sensores.padrao_hibrido` (`'masp'` | `'bizot'`, default
`'bizot'`), editável na UI igual `espaco_expositivo`. As 3 implementações viraram uma
simples leitura da coluna (`WHEN s.padrao_hibrido = 'masp'` no SQL; `padraoHibrido ===
'masp'` no JS, lido de `/api/meta`). Migração faz backfill automático (uma vez, dentro do
`try` do `ALTER TABLE ADD COLUMN`) marcando `'masp'` só nos 2 sensores que já bateriam com
a regra antiga (1º andar Frente/Fundo) — comportamento observável não mudou, confirmado
comparando `/api/metricas` e `/api/pontos` antes/depois no servidor de dev.

### 2.4 — Faixas de conformidade (18–22°C, 45–55% etc.) hardcoded em ~5 lugares do JS

O backend já tem uma tabela própria (`padroes_conformidade`) e um módulo dedicado
(`conformidade.py`) descrito como "fonte única de verdade". O frontend ignora isso e
repete os mesmos números em:

- `static/admin.js:48` (`PADROES_NORMA`)
- `static/admin.js:254` e `:267` (fallbacks de threshold)
- `static/admin.js:1642` (outra cópia, para outro fim)
- `static/charts.js:1174` (faixas do gráfico Sazonal — que eu segui ao implementar o
  endpoint novo, por consistência com o que já existia)

A lista acima não é exaustiva — há pelo menos mais duas cópias em `static/charts.js`
(`normaFaixas` na legenda do gráfico Mensal, `~L332`; rótulos do gráfico de Alertas,
`~L969`). Uma delas já tinha o bug que essa duplicação existe pra causar: a legenda do
MASP no gráfico Mensal mostrava **"T: 18–22°C"** (a faixa do IBRAM) em vez de 18–23°C —
corrigido em 2026-09-15, ver `contexto.md` §9.

Se um padrão mudar (acontece — conservação revisa faixas de tempos em tempos), dá pra
esquecer uma das 5 cópias e os gráficos mostrarem uma faixa diferente da que
`/api/metricas` está realmente calculando. Recomendo expor os padrões via
`/api/meta` (ou endpoint próprio) e os 5 pontos do JS lerem dali.

### 2.5 — Performance

- Índices em `medicoes` estão bons para os padrões de consulta atuais
  (`sensor_id+data_hora`, `data_hora`, `periodo_expositivo`, várias combinações de
  conformidade). Não achei query sem índice de suporte.
- `/api/sazonal` (novo) varre a tabela inteira (~2,9M linhas): primeira chamada ~7s
  (já otimizada de ~29s), cacheada por 1h — acabei de implementar, ver §1.
- Sem outros N+1 ou consultas custosas óbvias no restante das rotas.

### 2.6 — Estrutura do frontend

`static/admin.js` tem 3.297 linhas fazendo CRUD de sensores/exposições/ocorrências,
parsing de CSV (2 formatos), análise de não-conformidades E toda a geração do
relatório (incluindo ~850 linhas de HTML/JS montado em string). Já sinalizado em
`contexto.md` como candidato a quebra em módulos menores — mantenho a recomendação,
não fiz esse split agora (risco alto de regressão num arquivo tão grande, sem testes
automatizados para validar).

---

## 3. Resumo de prioridade

| Prioridade | Item |
|---|---|
| Alta (destrutivo, precisa de OK seu) | Dropar `medicoes_nova`, `dados_diarios`, `dados_mensais`, `pontos_de_medicao` |
| ~~Média~~ | ~~Remover ou reativar a trilha morta de `desvios`~~ — feito em 2026-09-15 |
| ~~Média~~ | ~~Centralizar regra Híbrido (`padrao_hibrido` por sensor)~~ — feito em 2026-09-15 |
| Média | Centralizar faixas de conformidade (ler do backend, não hardcode) |
| Baixa | Quebrar `admin.js` em módulos menores |
