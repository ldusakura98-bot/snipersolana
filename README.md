# Sniper Solana

Bot que detecta lanzamientos nuevos en Solana, con foco en **StonkFun** (tokens emparejados contra acciones tokenizadas como SPYx o NVDAx), y los compra en el momento en que salen, con filtros de seguridad y salida automática.

## Cómo funciona

```
 detección                 decodificación          filtros              compra                   gestión
 ─────────                 ──────────────          ───────              ──────                   ───────
 websocket ─┐                                                       ┌─ curva LaunchLab ─┐
 gRPC      ─┼─► RawIx[] ─► detectLaunch() ─► NewToken ─► filtros ─┤  (StonkFun)        ├─► TP / SL / tiempo ─► venta
 shreds    ─┘                                                       └─ Jupiter ─────────┘    (positions.json)
                                                                       (pump.fun/Raydium)
```

1. **Detección** (`src/stream/`): los tres modos producen la misma estructura, una lista de instrucciones normalizadas (`RawIx`). El resto del bot no sabe de dónde vienen.
2. **Decodificación** (`src/decoders.ts`, `src/launchlab/layout.ts`): reconoce la instrucción de creación por su discriminador Anchor y extrae el mint, el par, los vaults y el `platform_config`. Ese `platform_config` es lo que distingue StonkFun de otras plataformas que usan LaunchLab.
3. **Filtros** (`src/index.ts`, `src/filters.ts`): estado de la curva, progreso máximo, comisión de transferencia de Token-2022 y authorities del mint.
4. **Compra** (`src/trader.ts`):
   - **StonkFun / LaunchLab:** instrucción `buy_exact_in` directa contra la curva (`src/launchlab/instructions.ts`), sin pasar por Jupiter.
   - **pump.fun / Raydium:** vía Jupiter.
5. **Gestión** (`src/positions.ts`): calcula el valor con la matemática de la curva (`src/launchlab/curve.ts`). Cuando el token migra a Raydium, pasa a operar vía Jupiter. Las posiciones se guardan en `positions.json`.

## StonkFun en detalle

StonkFun lanza todos sus tokens en **Raydium LaunchLab** (programa `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`):

- Cada token empieza en una **bonding curve** contra un *quote token* (SPYx, NVDAx, SOL…). Al llenarse, migra a un pool de Raydium.
- Los mints son **Token-2022**. La config "reward" de StonkFun les pone una comisión de transferencia (transfer fee) del 1–3 %, que el bot tiene en cuenta en los cálculos.
- Se identifican por su `platform_config`: `4E876qZT…` (estándar) y `6BwHHDg3…` (reward). Estas direcciones vienen de fuentes de terceros, conviene confirmarlas en Solscan.
- **Para comprar contra SPYx necesitas tener SPYx en la wallet.** Pon el importe por quote token en `QUOTE_BUY_AMOUNTS`, o deja que el bot use el equivalente de `BUY_AMOUNT_SOL`. `AUTO_SWAP_QUOTE=true` compra el quote token con SOL si falta, a costa de una transacción extra.

## Puesta en marcha

```bash
npm install
cp .env.example .env     # edita los valores
npm test                 # tests de decodificación, curva y transacciones
npm start
```

Arranca en **`DRY_RUN=true`**: calcula compras y ventas con la curva real y con quotes de Jupiter, pero **no envía transacciones**. Así se mide el rendimiento sin gastar nada.

### Para operar en real

1. **Wallet dedicada.** Crea una solo para el bot, con poco saldo, y pon su clave en `PRIVATE_KEY` dentro de `.env`. El `.env` está en `.gitignore`.
2. **RPC privado.** Ponlo en `RPC_URL` / `WS_URL`: Helius, Triton, QuickNode u otro.
3. **Quote tokens.** Fondea la wallet con SOL y con los quote tokens que vayas a usar (SPYx, etc.).
4. **Prueba con muy poco.** Cambia `DRY_RUN=false` y empieza con importes mínimos. **Primero valida una compra y una venta reales pequeñas.**

## Infraestructura y velocidad

| Pieza | Variable | Qué gana |
|---|---|---|
| RPC privado | `RPC_URL`, `WS_URL` | Menos límites de peticiones y menos latencia en lecturas y envíos. |
| gRPC (Yellowstone) | `DETECTION=grpc`, `GRPC_URL`, `GRPC_TOKEN` | La tx llega completa al ejecutarse, sin `getParsedTransaction`: ahorra uno o varios viajes al RPC. |
| Shreds | `DETECTION=shreds` | Ve la tx **antes** de que se ejecute. El pool se reconstruye desde la instrucción porque aún no existe on-chain. |
| Jito | `JITO_ENABLED=true` | Nuestras txs de LaunchLab llegan directas al líder con propina. |
| VPS | — | Ponlo cerca del proveedor de gRPC/RPC (misma región). |

**Riesgo del modo shreds:** detectamos la creación antes de que se ejecute. Si nuestra compra llega al líder antes que la creación, falla y solo se pierde la comisión. Si la creación falla, también. El siguiente paso para afinarlo sería enviar ambas en un *bundle* de Jito.

## Configuración

Todas las opciones están documentadas en [`.env.example`](.env.example).

## Estructura

```
src/
  index.ts              orquestación: detección → filtros → compra → posiciones
  config.ts             variables de entorno
  decoders.ts           detección unificada (pump.fun, Raydium, LaunchLab/StonkFun)
  stream/websocket.ts   detección por logsSubscribe
  stream/grpc.ts        detección por Yellowstone gRPC y shreds
  launchlab/
    borsh.ts            lector Borsh
    layout.ts           discriminadores y decodificación de cuentas/instrucciones
    curve.ts            matemática de la curva y comisiones (portada del SDK de Raydium)
    instructions.ts     buy_exact_in / sell_exact_in y PDAs
    client.ts           lectura de pools/configs con caché
  trader.ts             compra/venta (LaunchLab directo o Jupiter)
  positions.ts          seguimiento en tiempo real, ventas, PnL y persistencia
  exits.ts              reglas de salida (SL, trailing, parcial, TP, tiempo)
  risk.ts               límite de pérdida diaria y pausa por racha
  stats.ts              trades.csv y resúmenes con los tramos de GMGN
  filters.ts            authorities del mint y transfer fee
  tx.ts                 compute budget, blockhash cacheado, Jito
  jupiter.ts            cliente de la API de Jupiter
test/                   tests (node:test)
```

## Gestión del riesgo

| Protección | Variables | Qué hace |
|---|---|---|
| Stop-loss | `STOP_LOSS_PCT` | Vende si la posición cae un X %. |
| Trailing stop | `TRAILING_STOP_PCT`, `TRAILING_ACTIVATION_PCT` | Cuando ya se ha ganado lo suficiente, vende si cae un X % desde el máximo. |
| Venta parcial | `PARTIAL_TP_PCT`, `PARTIAL_TP_SELL_PCT` | Vende parte al alcanzar un objetivo (p. ej. 50 % al doblar = recuperas lo invertido). |
| Take-profit / tiempo | `TAKE_PROFIT_PCT`, `MAX_HOLD_SECONDS` | Cierra el resto. |
| Pérdida diaria máxima | `MAX_DAILY_LOSS_SOL` | Deja de comprar hasta el día siguiente (UTC). |
| Racha de pérdidas | `MAX_CONSECUTIVE_LOSSES`, `COOLDOWN_MINUTES` | Pausa tras N pérdidas seguidas. |

Las posiciones en la curva de StonkFun se evalúan **en cada cambio del pool** (suscripción a la cuenta), no solo cada pocos segundos. Aun así, el stop-loss **no protege de un rug pull**: si el precio cae un 90 % en una sola transacción, se vende a ese precio.

Al arrancar, el bot avisa si las comisiones fijas (priority fee + propina, de ida y vuelta) superan el 5 % de `BUY_AMOUNT_SOL`.

## Ejecución: cada décima de margen cuenta

Con márgenes del ~3 % por operación, lo que decide si se gana o se pierde son los detalles de ejecución:

| Mejora | Variables | Por qué importa |
|---|---|---|
| Recuperar rent | `RECLAIM_RENT` | Cada cuenta de token cuesta ~0.002 SOL. Tras vender todo se cierra (con *harvest* previo de las transfer fees retenidas de Token-2022) y se recupera. |
| Priority fee dinámico | `PRIORITY_FEE_MODE`, `…_MIN/MAX_LAMPORTS`, `…_PERCENTILE` | Paga lo que pide la red en cada momento, no siempre el máximo. |
| Reenvío de txs | `REBROADCAST_INTERVAL_MS` | Los RPC descartan txs en congestión; reenviar la misma firma aumenta la tasa de entrada sin coste. |
| Slippage de venta creciente | `SELL_SLIPPAGE_BPS`, `URGENT_SELL_SLIPPAGE_BPS` | Una venta que falla por slippage se reintenta con el doble; el stop-loss empieza ya con slippage alto. |
| Salida si el creador vende | `EXIT_ON_DEV_SELL` | Suscripción a los logs del creador: si vende en LaunchLab, se sale al instante. |
| Creadores en serie | `MAX_CREATOR_LAUNCHES_24H` | Quien lanza muchos tokens al día suele estar haciendo rugs. |
| Venta sin RPC | — | La venta usa el estado del pool que ya llegó por la suscripción y el saldo guardado: sin consultas en el momento crítico. |

## Medir y comparar (estilo GMGN)

Cada token cerrado se añade a `trades.csv`. Al arrancar y cada `STATS_SUMMARY_MINUTES`, el bot muestra un resumen con los mismos tramos que la pestaña "Distribución" de GMGN:

```
Resumen 7D: 412 tokens | tasa de éxito 28.4% | PnL +0.8312 SOL | tenencia media 540 min
    >500%          5 (1.21%)
    200%~500%      2 (0.49%)
    0%~200%      110 (26.70%)
    -50%~0%      290 (70.39%)
    <-50%          5 (1.21%)
```

Así se compara directamente con una wallet de referencia en GMGN. Ejecútalo en `DRY_RUN` el mismo periodo y compara la tasa de éxito, el reparto y el PnL.

## Riesgos

- La gran mayoría de tokens nuevos pierden casi todo su valor en minutos. Los filtros reducen el riesgo, no lo eliminan.
- El bot **no se ha probado todavía contra mainnet**. Valida primero en `DRY_RUN` y luego con importes mínimos.
- Opera solo con dinero que puedas perder.
