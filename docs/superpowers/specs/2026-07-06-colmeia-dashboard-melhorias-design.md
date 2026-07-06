# Colmeia 4.0 — Melhorias no dashboard (design)

Data: 2026-07-06
Escopo: `colmeia-api` (frontend estático em `src/public/` + rota `src/routes/audio.js`).

## Objetivo

Limpar informação inútil do dashboard, dar sentido físico aos sensores
(interna vs externa), corrigir o descompasso de fuso horário do áudio,
transformar o acelerômetro num status de "posição da colmeia" e adicionar
uma seção de **termorregulação** com indicadores de longo prazo.

Convenção de sensores (definida pelo usuário):
- **T2 / U2 = dentro da colmeia** (interna)
- **T1 / U1 = fora** (ambiente)

Isso é só rotulagem no frontend — o firmware não muda. Fisicamente, o DHT2
(pino 16) precisa ser o sensor instalado dentro da colmeia.

## Itens

### 1. Limpeza de informação inútil

**Header** (`index.html`): remover `eyebrow` ("Colmeia 4.0"), `h1`
("Observabilidade da colmeia") e `subtitle` ("Sensores, audio, aceleracao e
espectro em uma interface unica."). Substituir por um título único:
`<h1>Monitoramento da Colmeia</h1>`. Mantém os seletores de dispositivo/período
e o indicador de última atualização.

**Seção hero**: remover a `<section class="hero">` **inteira** (linhas ~44–75
do `index.html` atual) — tanto o texto "Uma leitura viva da colmeia, do campo
ao espectro." quanto o painel lateral (Última leitura / Sessões de audio /
Janela ativa). A tela passa a começar direto nos cards de status.

Consequência em `app.js`: `renderOverview()` referencia
`hero-device-chip`, `dashboard-last-reading`, `dashboard-audio-count`,
`dashboard-window`. Esses blocos saem; remover o código que os popula
(guardas `if (el)` já existem, mas removemos o código morto). CSS do hero
em `style.css` também sai.

### 2. Cards de temperatura/umidade → interna vs externa

Os cards de "média" perdem sentido. Redesenho na seção `.cards`:

- **Card Temperatura**
  - label: `Temperatura interna`
  - valor: **T2** (`temperatura_2`), unidade `°C`
  - sub: `externa T1 xx.x°C · Δ +x.x°C` (Δ = T2 − T1)
- **Card Umidade**
  - label: `Umidade interna`
  - valor: **U2** (`umidade_2`), unidade `%`
  - sub: `externa U1 xx.x% · Δ +x.x`

`renderOverview()` deixa de usar `avg([t1,t2])` / `avg([u1,u2])`.

### 3. Peso: `raw` → `kg`

O firmware foi atualizado para enviar **`peso_kg` (float, com casas decimais)**
em vez de `peso_raw` (`long`). O backend já suporta: o schema Zod tem
`peso_kg: z.number().optional()` e a coluna `peso_kg REAL` já existe — sem
mudança no servidor.

Mudanças (frontend apenas):
- `pesoInfo(reading)` passa a ler `peso_kg` com **2 casas decimais**, unidade
  `kg`. Fallback: leituras antigas só têm `peso_raw` (kg inteiro) —
  `const kg = reading.peso_kg != null ? reading.peso_kg : reading.peso_raw`.
- Card Peso: unidade → `kg`; sub usa `stats.peso_kg` (com fallback
  `stats.peso_raw`) para min/max.
- Gráfico "Peso bruto (HX711)" → título "Peso (kg)"; série passa a plotar
  `peso_kg` com fallback para `peso_raw`.
- Tabela: cabeçalho "Peso raw" → "Peso (kg)"; célula formata `peso_kg`
  (fallback `peso_raw`) com 2 decimais.

### 4. Acelerômetro → card "Posição da colmeia"

Remover o card de aceleração (magnitude m/s²) e colocar no lugar um card de
**posição/estabilidade**. O gráfico X/Y/Z **permanece**.

Valores de repouso medidos: X≈0.02–0.07, Y≈2.8–2.89, Z≈8.6–8.7
(magnitude ≈ 9.1 m/s²).

Algoritmo (imune à magnitude não ser 9.81, pois normaliza):
- Constante de referência (direção da gravidade em repouso, normalizada):
  `ACCEL_REF ≈ { x: 0.006, y: 0.313, z: 0.950 }` (de normalizar (0.05, 2.85, 8.65)).
- Por leitura: normalizar `(accel_x, accel_y, accel_z)`; `cos = dot(atual, ref)`;
  `tilt = acos(clamp(cos, -1, 1)) * 180/π`.
- Faixas de status:
  - `tilt < 15°` → **No lugar** (verde)
  - `15° ≤ tilt < 45°` → **Inclinada** (amarelo)
  - `tilt ≥ 45°` → **Derrubada** (vermelho)
- Se `accel_x/y/z` ausentes → "—".

Card:
- label: `Posição`
- valor: texto do status (No lugar / Inclinada / Derrubada) com cor
- sub: `inclinação N°`

`ACCEL_REF` e os limiares ficam como constantes no topo do `app.js`, com
comentário explicando como recalibrar (basta capturar uma leitura em repouso
e normalizar).

### 5. Seção nova "Termorregulação" (insights de longo prazo)

Nova `<section>` entre os cards e os gráficos. Responde "quanto a colmeia
segura temperatura/umidade apesar da variação do dia" e "se está num nível
ideal".

Fonte de dados: `/api/stats?hours=<janela>` já devolve `temperatura.t1/t2`
e `umidade.u1/u2` com `{ min, max, avg }`; a série de até 1000 pontos
(`state.lastSeries`) permite o "% do tempo na faixa".

**Faixa ideal de temperatura interna: 28–32°C.**
**Umidade: sem faixa ideal** (decisão do usuário) — só amortecimento e Δ.

Tiles de **temperatura** (4):
1. **Interna média** = `stats.temperatura.t2.avg`, com status vs faixa 28–32°C
   (dentro = verde; fora = amarelo/vermelho). Legenda: `faixa 28–32°C`.
2. **Amortecimento** = `1 − (amp_t2 / amp_t1)` em %, onde
   `amp = max − min`. Legenda: `ext oscilou X°C`. (Se `amp_t1 ≤ 0` ou dados
   insuficientes → "—".)
3. **ΔT interna−externa** = `t2.avg − t1.avg`, com rótulo `aquecendo`/`resfriando`.
4. **% na faixa** = fração das leituras de `temperatura_2` na série dentro de
   [28, 32], em %.

Tiles de **umidade** (2):
5. **Amortecimento umidade** = `1 − (amp_u2 / amp_u1)` em %.
6. **ΔU interna−externa** = `u2.avg − u1.avg`.

**Gráfico interna vs externa** (temperatura): linha de T2 (interna) e T1
(externa) na janela ativa, com a **faixa 28–32°C sombreada** ao fundo.
Reusa `state.lastSeries`. A faixa sombreada é desenhada por um plugin
Chart.js leve e inline (preenche o retângulo entre y=28 e y=32 na área do
gráfico) — sem dependência externa nova.

Funções novas em `app.js`: `renderThermoregulation(stats, series)` e helpers
`amplitude(stat)`, `pctInBand(series, key, lo, hi)`.

### 6. Bug do áudio +3h (fuso horário)

Causa: em `audio.js`, `listar()` monta `quando` com
`new Date(st.mtimeMs).toISOString()` → **sempre UTC**; o front imprime a
string crua. Os sensores usam `toLocaleString('pt-BR')` (fuso do navegador,
UTC−3). Diferença = +3h no áudio.

Correção (backend + frontend):
- `audio.js` `listar()`: adicionar campo numérico `timestamp` (Unix em
  **segundos**), extraído da **sessão do nome do arquivo**
  (`${device}_${session}_${trigger}.wav` → `session` é o Unix do ESP).
  - Parsear `session` do nome; se `> 1e12` tratar como ms e dividir por 1000.
  - Fallback: `Math.floor(st.mtimeMs / 1000)`.
  - Manter `quando` por compatibilidade é opcional; o front deixa de usá-lo.
- `app.js` `renderAudioLibrary()`: exibir `formatDateTime(file.timestamp)`
  em vez de `file.quando`. Assim áudio e sensores compartilham o mesmo
  relógio e a mesma localização.

## Arquivos afetados

- `colmeia-api/src/routes/audio.js` — campo `timestamp` no `listar()`.
- `colmeia-api/src/public/index.html` — header, remoção do hero, cards,
  nova seção termorregulação, títulos de peso.
- `colmeia-api/src/public/app.js` — cards interna/externa, peso kg, posição
  (tilt), termorregulação, formatação de data do áudio, remoção do código do hero.
- `colmeia-api/src/public/style.css` — remoção do CSS do hero; estilos dos
  novos tiles de termorregulação e do card de posição (verde/amarelo/vermelho).

Sem mudanças no schema do banco, no firmware ou em outras rotas.

## Constantes novas (topo do `app.js`)

```js
const IDEAL_TEMP = { min: 28, max: 32 };          // faixa ideal interna (°C)
const ACCEL_REF  = { x: 0.006, y: 0.313, z: 0.950 }; // gravidade em repouso, normalizada
const TILT_OK_DEG = 15;   // < 15° = no lugar
const TILT_WARN_DEG = 45; // 15–45° = inclinada; > 45° = derrubada
```

## Fora de escopo

- Resolução decimal do peso (exige firmware + schema).
- Faixa ideal de umidade.
- Detecção de impacto/movimento súbito no acelerômetro (só orientação estável).
- Autenticação nos endpoints (já anotado como TODO no código existente).

## Verificação

- Áudio: um WAV cujo timestamp de sessão é conhecido deve exibir a mesma
  hora local dos sensores (sem +3h).
- Posição: com os valores de repouso, o card mostra "No lugar" e ângulo ~0–3°;
  trocar sinais de eixos (simular tombo) leva a "Derrubada".
- Termorregulação: com dados reais de 24h, amortecimento entre 0–100% e
  "% na faixa" coerente com a série.
- Peso: card, gráfico e tabela mostram `kg`.
