# Bollinger Mean-Reversion Bot — btc-race-24h-20261117-0603

[![btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/cryptocollectorid/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/cryptocollectorid/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

A bot that trades Coinbase Wrapped BTC (CBBTC) on 1-minute on-chain bars from
its Orca Whirlpool on Solana, for the [btc-race-24h-20261117-0603](https://make.fun/bounty/btc-race-24h-20261117-0603)
bounty on make.fun: $250 to the 10 highest net PnLs on the 24-hour race
window, starting with $1,000 of paper money. Nothing is traded for real.

## Strategy

Bollinger band mean reversion on a 4-hour lookback, long only, at most one
open position:

- **Buy** 100% of cash when the close drops below the **lower** Bollinger
  band (240 bars, k = 2.25): the market has stretched too far down on a
  4-hour view and the band is the reversion target.
- **Sell** the whole position when the close reaches the **upper** band:
  the full lower-to-upper swing is the trade. Exiting at the midline was
  tested on the dev window and loses money.
- **Stop-loss** at 0.8% below the entry close, then no re-entry for 120
  bars (a waterfall is not a dip).
- **Circuit breaker:** if equity falls 3% below its running peak, flatten
  and stop trading for the rest of the window.
- **Late probe:** if no trade has happened by scored bar 1080 (18h in) and
  the bot is flat, buy 50% of cash at market once, so the entry always
  meets the competition's minimum-1-trade guardrail even in a steady
  grind-up or flat window where the lower band is never touched.

No clock, no environment, no randomness: every value comes from the bar
stream, so two runs on the same data give the same orders.

## Why this shape

On the published 24-hour dev window (BTC +0.49%, range-bound, 1-minute
returns nearly unpredictable) every trend-following variant tested — EMA
cross, Donchian, SMA+momentum, breakout with trailing stop — lost money:
breakouts reverse within minutes and each round trip costs ~35 bps
(4 bps fee + 2 bps slippage + ~12 bps impact per leg on ~$850k depth).
The Bollinger lower-to-upper swing is positive across the whole parameter
plateau (n = 180–300, k = 1.75–2.5 all made money on the dev window),
both halves of the dev window contributed, and max drawdown stayed around
1%. The parameters sit in the middle of that plateau (n = 240, k = 2.25),
not at a tuned peak.

## Dev-window grade (local, `--driver process`)

| | |
|---|---|
| Net PnL | **+$8.19** |
| Trades | 4 (2 round trips) |
| Fees | $1.61 |
| Max drawdown | −0.90% |
| 1st half (bars 0–720) | +$6.93 |
| 2nd half (bars 720–1440) | +$1.27 |

For comparison on the same window, the kit's house baselines graded:
buy-and-hold +$1.07, momentum +$2.45, ema-cross −$106.21.

Stress checks (synthetic windows): mirrored dev returns (a downtrend)
−$2.75 with max drawdown −1.31% — the stop and breaker cap the loss;
a steady −2% grind −$8.48 on one stopped trade; a flat market and a
steady +2% grind make 0 trades, which is what the late probe is for.

## Files

- `main.ts` — the bot (Node 22, standard library only; reads the
  bars-replay/v1 protocol from stdin, answers one reply per bar).
- `vendor/makefun-bars.ts` — the kit's bot shim, copied byte-for-byte.
- `LICENSE` — MIT.

## Run it locally

```sh
node cli/makefun.mjs grade-local --kit <path-to-kit> --bot . --driver process
```

## Referral

Built for make.fun — try a bounty yourself: https://make.fun/r/4pc5tnqn
