# Sniper Solana

Bot que detecta tokens nuevos en Solana y los compra automáticamente, con filtros de seguridad y salida por take-profit / stop-loss.

## Cómo funciona

```
pump.fun / Raydium ──(WebSocket logs)──► listener ──► filtros ──► compra (Jupiter) ──► gestor de posiciones ──► venta
```

| Módulo | Qué hace |
|---|---|
| `src/listener.ts` | Se suscribe a los logs de pump.fun (`create` / `create_v2`) y Raydium AMM v4 (`initialize2`) y extrae el mint del token nuevo. |
| `src/filters.ts` | Rechaza tokens con *mint authority* o *freeze authority* activas. |
| `src/jupiter.ts` | Quotes y transacciones de swap vía la API de Jupiter (enruta por pump.fun, PumpSwap, Raydium, Meteora…). |
| `src/trader.ts` | Firma, envía y confirma los swaps. En `DRY_RUN` no envía nada. |
| `src/positions.ts` | Revisa el valor de cada posición cada `PRICE_CHECK_INTERVAL_MS` y vende por TP, SL o tiempo máximo. |
| `src/index.ts` | Orquesta todo y respeta `MAX_OPEN_POSITIONS`. |

## Puesta en marcha

```bash
npm install
cp .env.example .env     # edita los valores
npm start
```

Por defecto arranca en **`DRY_RUN=true`**: usa quotes reales de Jupiter pero no envía transacciones, así puedes medir resultados sin gastar SOL.

### Para operar en real

1. Crea una **wallet dedicada** solo para el bot y fóndeala con poco SOL.
2. Pon su clave en `PRIVATE_KEY` (base58 o array JSON). Nunca subas `.env` al repo (ya está en `.gitignore`).
3. Usa un **RPC privado** (Helius, Triton, QuickNode…) en `RPC_URL` / `WS_URL`. Con el RPC público la detección llega tarde y te limitan peticiones.
4. Cambia `DRY_RUN=false`.

## Configuración

Todas las opciones están documentadas en [`.env.example`](.env.example). Las más importantes:

- `BUY_AMOUNT_SOL` — SOL por compra.
- `SLIPPAGE_BPS` — slippage en puntos básicos (1500 = 15 %). Los tokens recién lanzados se mueven mucho.
- `PRIORITY_FEE_MAX_LAMPORTS` — tope de priority fee por transacción.
- `TAKE_PROFIT_PCT`, `STOP_LOSS_PCT`, `MAX_HOLD_SECONDS` — reglas de salida.
- `SOURCES` — `pumpfun`, `raydium` o ambos.

## Riesgos

- La gran mayoría de tokens nuevos son rug pulls o pierden casi todo su valor en minutos. Los filtros reducen el riesgo, no lo eliminan.
- Las posiciones solo se guardan en memoria: si paras el bot, las posiciones abiertas se listan en consola pero **no se venden solas**.
- Opera solo con dinero que puedas perder.

## Próximos pasos posibles

- Envío por **Jito bundles** o swaps directos contra la bonding curve de pump.fun (sin pasar por Jupiter) para bajar latencia.
- Más filtros: concentración de holders, liquidez mínima, metadatos/redes sociales, creador en lista negra.
- Persistencia de posiciones (archivo/SQLite) y notificaciones por Telegram.
- Trailing stop y ventas parciales.
