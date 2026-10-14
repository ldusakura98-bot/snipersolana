# Prompt para continuar el proyecto: sniper de StonkFun en Solana

> Copia todo este documento como primer mensaje para el nuevo asistente.

---

Vas a continuar un proyecto de trading automatizado en Solana. Trabajas con **la dueña del proyecto, desarrolladora**: no es experta en blockchain, pero sabe programar y quiere entender lo que se hace. Háblale **en español**, explica cada cambio y trabaja en **commits pequeños y revisables**. Ella revisa el código.

## 1. Objetivo

Un **sniper para StonkFun**: detecta tokens recién lanzados, los compra en los primeros segundos y los vende según reglas de salida. StonkFun es un launchpad de Solana cuyos tokens se emparejan contra acciones tokenizadas (SPYx, NVDAx…) y cripto.

- **Wallet de referencia:** un desarrollador externo (Gustavo) opera un bot en StonkFun. Su wallet, según GMGN, es `Hup7Zc57uFXAeLjQ8skEbZWgdX7VXarAjc6v8J2j9A9e`. **Aún no está verificado que sea suya.**
- **Sus métricas a 30 días** (13-oct-2026, GMGN):
  - Ganancia realizada: +77 K USD (+3,2 %) sobre 2,4 M USD invertidos.
  - Volumen: 2385 tokens.
  - Tasa de éxito: 29,8 %.
  - Tenencia media: 1 día.
  - Market cap de compra: 88 % por debajo de 100 K USD.
  - Comisiones: 13,9 K USD.
  - Distribución: >500 %: 0,34 % · 200–500 %: 0,46 % · 0–200 %: 31,6 % · −50–0 %: 66,6 % · <−50 %: 1,05 %.
- **Conclusión:** la ventaja es real pero el margen es fino (~3 %). Gana cortando pérdidas pronto y dejando correr unos pocos ganadores, con mucho volumen. **La ejecución y las comisiones deciden si se gana o se pierde.**

## 2. Presupuesto y plan acordado

La dueña tiene **unos 100 USD**. Plan acordado:

1. **Fase A – Verificación on-chain (solo lectura, 0 USD).** Confirmar los supuestos de la sección 5 con transacciones y cuentas reales de mainnet.
2. **Fase B – Simulación (`DRY_RUN=true`, 1–2 semanas, 0 USD).**
   - RPC: plan gratuito de Helius. El bot corre en el PC de la dueña o en un VPS barato.
   - Comparar el resumen del bot (mismos tramos que GMGN) con la wallet de referencia.
3. **Fase C – Prueba real mínima (~50–80 USD)**, solo si la fase B sale positiva **y la dueña lo aprueba explícitamente**.
   - Objetivo: validar compra, venta, recuperación del rent y salida por venta del creador. **No es ganar.**
4. **Escalar infraestructura** (gRPC ~200 USD/mes, shreds ~500–1000 USD/mes) **solo** con datos reales positivos. No recomendar pagar los 2000 USD que propuso Gustavo sin una prueba propia exitosa.

Configuración de la fase C (`.env`), para un SOL de ~107 USD:

```
DRY_RUN=false            # SOLO con aprobación explícita de la dueña
SOURCES=stonkfun
DETECTION=websocket
BUY_AMOUNT_SOL=0.05
MAX_OPEN_POSITIONS=10
MAX_DAILY_LOSS_SOL=0.15
MAX_CONSECUTIVE_LOSSES=5
PRIORITY_FEE_MODE=dynamic
PRIORITY_FEE_MAX_LAMPORTS=100000
PRIORITY_FEE_MIN_LAMPORTS=10000
JITO_ENABLED=false
RECLAIM_RENT=true
MAX_ENTRY_MCAP_USD=100000
```

## 3. Reglas de seguridad (obligatorias)

- **Clave privada:**
  - Nunca la imprimas, la registres en logs, la subas al repo ni la pidas por chat. Vive solo en `.env`, que está en `.gitignore`.
  - Usa una **wallet dedicada** con el mínimo de fondos.
- **`DRY_RUN=false`:** nunca lo cambies, ni ejecutes nada que firme o envíe transacciones reales, sin confirmación explícita de la dueña **en ese momento**.
- **Fondos:** nunca transfieras fondos fuera de la wallet del bot, ni hagas swaps fuera del flujo del bot.
- **Verificación:** si algo no lo puedes verificar, dilo. No presentes como probado lo que no lo está.
- **Gustavo:** no compartas código, claves ni datos con él ni con terceros. Si se plantea pagarle, recomienda pagos por etapas ligados a resultados verificables en la cadena. Recomienda también verificar que la wallet es suya: que envíe una cantidad exacta elegida por la dueña.

## 4. Estado del código

- **Repo y rama:** `ldusakura98-bot/snipersolana`, rama `claude/optimistic-lamport-8zbahp`.
- **Stack:** TypeScript (Node ≥ 20, ESM), `@solana/web3.js` 1.x, `@solana/spl-token` 0.4, `@triton-one/yellowstone-grpc` 7.0.1 (fijada a propósito).
- **Comandos:**

```bash
npm install
npm test          # 35 tests (node:test vía tsx), deben pasar todos
npx tsc --noEmit  # typecheck
npm start         # arranca el bot (lee .env; ver .env.example, todo documentado)
```

**Historial de commits (del más antiguo al más reciente):**
1. Sniper inicial (pump.fun/Raydium vía Jupiter).
2. LaunchLab: decodificación, curva e instrucciones.
3. Detección de StonkFun.
4. Compra y venta directa en la curva.
5. gRPC, shreds y Jito.
6. Gestión de riesgo.
7. Perfil de la wallet de referencia y estadísticas al estilo GMGN.
8. Ejecución: rent, priority fee dinámico, reenvío, slippage creciente y salida por venta del creador.

**Arquitectura:**

```
detección (stream/websocket.ts | stream/grpc.ts: grpc o shreds)
  → RawIx[] normalizadas → decoders.ts detectLaunch() → NewToken
  → index.ts: filtros (creador en serie, estado/progreso de curva, market cap USD, transfer fee, authorities del mint)
  → trader.ts: buy_exact_in directo contra la curva de LaunchLab (StonkFun) | Jupiter (pump.fun/Raydium/migrados)
  → positions.ts: suscripción al pool (onAccountChange) + a los logs del creador + sondeo
      → exits.ts (SL, trailing, TP parcial/total, tiempo) → venta con slippage creciente
      → risk.ts (pérdida diaria, racha) · stats.ts (trades.csv + resumen estilo GMGN) · cierre de la cuenta del token (rent)
```

**Datos clave de StonkFun y LaunchLab:**
- **Programa:** Raydium LaunchLab `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`. Desde septiembre de 2026, StonkFun lanza todo por LaunchLab: curva de bonding y luego migración a Raydium CPMM.
- **`platform_config` de StonkFun** (fuente: terceros, **sin verificar**): `4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7` (estándar) y `6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt` (reward, Token-2022 con transfer fee del 1–3 %).
- **Fuentes del código:**
  - Layouts, PDAs y matemática de la curva: portados del SDK oficial `raydium-io/raydium-sdk-V2` (`src/raydium/launchpad/`).
  - IDL: `raydium-io/raydium-idl/raydium_launchpad/raydium_launchpad.json`.
  - `buy_exact_in` y `sell_exact_in` usan **18 cuentas**: las 15 del IDL más system program, platform fee vault `[platform_config, quote_mint]` y creator fee vault `[creator, quote_mint]`, como en el SDK.
- **PDA de autoridad:** `WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh` (cubierta por un test).

## 5. Supuestos SIN verificar contra mainnet (prioridad máxima)

El entorno donde se escribió el código **no tenía acceso a la red de Solana**. Todo está testeado con datos sintéticos construidos desde el IDL y el SDK. Verifica, en este orden, con lecturas de solo lectura:

1. **`platform_config` de StonkFun.**
   - Busca transacciones recientes del programa LaunchLab (`getSignaturesForAddress`) y decodifícalas con `decodeLaunchLabCreate`.
   - Confirma que los lanzamientos de StonkFun usan esas dos direcciones. Cruza con tokens que aparezcan en stonkfun.xyz.
2. **Decodificación de la creación.**
   - Discriminadores de `initialize`, `initialize_v2` e `initialize_with_token_2022`.
   - Orden de cuentas: base mint idx 6, quote mint idx 7, programas de token idx 10/11 en la variante token_2022 y 11/12 en las otras.
   - Parámetros: MintParams, CurveParams, VestingParams y, al final de token_2022, `amm_fee_on` + `Option<TransferFeeExtensionParams>`.
3. **Offsets de `PoolState`, `GlobalConfig` y `PlatformConfig`.**
   - Lee cuentas reales y comprueba que precio, progreso y comisiones salen coherentes con lo que muestra StonkFun o Solscan.
   - Ojo: el SDK actual tiene campos nuevos al final de `PlatformConfig` (`restrictCurveParam`…), pero no afectan a los offsets que usamos.
4. **Mint authority / freeze authority de los mints de LaunchLab.** Se acepta la PDA de LaunchLab como authority "segura". Si los mints traen otra authority, el filtro descartará todo.
5. **Cuentas de `buy_exact_in` y `sell_exact_in`.** Compáralas con una compra real de StonkFun en Solscan, una por una, las 18. **Simula** la tx construida con `simulateTransaction` antes de cualquier envío real. La simulación no envía nada, pero necesita una wallet con fondos del quote token.
6. **Quote token program.** Se lee de la instrucción. Comprueba que los pares contra xStocks, que podrían ser Token-2022, funcionan.
7. **`sameTxBuysQuote` (compra del creador en la misma tx)** y la reconstrucción del pool en modo shreds.
8. **Heurística de venta del creador.** Usa `logsSubscribe` mencionando al creador y busca "Instruction: SellExactIn/SellExactOut" de LaunchLab. Puede dar falsos positivos si el creador vende otro token.
9. **API de shreds.** Usamos `subscribeDeshred` de Yellowstone. Antes de contratar un proveedor de shreds, confirma que la soporta.

Sugerencia: crea `src/tools/verify.ts`, un script de solo lectura que haga todo lo anterior e imprima un informe. Que sea lo primero que se revise con la dueña.

## 6. Pendientes y mejoras propuestas

- **Filtro de quote tokens (`ALLOWED_QUOTE_MINTS`).** Con 100 USD no se pueden tener saldos de muchos quote tokens. Restringir a SOL y/o uno o dos quote tokens, o usar `AUTO_SWAP_QUOTE`, que añade una tx y latencia.
- **Coste de compra en las estadísticas.** Incluir priority fee, propina y rent no recuperado en `trades.csv` para un PnL neto real.
- **Simulación más realista.** La simulación es optimista porque compra al precio de detección. Añadir una latencia o penalización configurable.
- **Modo shreds.** Enviar la compra en un bundle de Jito justo detrás de la transacción de creación detectada.
- **Telegram (opcional).** Alertas de compra, venta y resumen diario.
- **Medición de latencia.** Medir detección → envío → confirmación y guardarla en las estadísticas.

## 7. Forma de trabajar

- Antes de cambiar algo, explica qué y por qué. Después, haz un commit pequeño con un mensaje claro en español.
- Mantén verdes `npm test` y `npx tsc --noEmit`. Añade tests para cada lógica nueva.
- Cuando algo dependa de datos reales, muéstrale a la dueña la evidencia: firmas de Solscan y salidas del script.
- Sé honesto con el riesgo: la mayoría de tokens nuevos pierden casi todo su valor, el margen de esta estrategia es fino y 100 USD sirven para aprender y validar, no para obtener ganancias relevantes.
