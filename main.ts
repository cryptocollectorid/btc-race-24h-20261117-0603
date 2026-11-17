// Bollinger band mean-reversion bot for the make.fun competition
// btc-race-24h-20261117-0603: trade Coinbase Wrapped BTC (CBBTC) on 1-minute
// on-chain bars from its Orca Whirlpool, starting with $1,000 of paper money.
//
// STRATEGY (all decisions on the close of bar k, fills at bar k+1's open):
//   - Keep the last 240 closes (4 hours). Compute their mean and population
//     standard deviation: the Bollinger bands at k = 2.25.
//   - BUY (100% of cash) when the close drops below the LOWER band: the
//     market has stretched too far down on a 4h view and the band is the
//     reversion target. At most one open position, long only.
//   - SELL the whole position when the close reaches the UPPER band: the
//     full swing from lower to upper band is the trade, not half of it.
//     (Exiting at the midline was tested on the dev window and loses money.)
//   - STOP-LOSS: sell if the close falls 0.8% below the entry close, then
//     do not re-enter for 120 bars (a waterfall is not a dip).
//   - CIRCUIT BREAKER: if equity falls 3% below its running peak, flatten
//     and stop trading for the rest of the window.
//   - LATE PROBE: if no trade has happened by scored bar 1080 (18h in) and
//     the bot is flat, buy 50% of cash at market once. This guarantees the
//     competition's minimum-1-trade guardrail in a steady grind-up or flat
//     window, where the lower band is never touched; the probe uses the same
//     stop / upper-band exits and can lose at most ~0.8% of half the capital.
//
// WHY THIS SHAPE: on the published 24h dev window (BTC +0.49%, range-bound,
// 1-min returns nearly unpredictable) every trend-following variant tested
// (EMA cross, Donchian, SMA+momentum, breakout+trailing stop) lost money:
// breakouts reverse within minutes and each round trip costs ~35 bps
// (4 bps fee + 2 bps slippage + ~12 bps impact per leg on ~$850k depth).
// The Bollinger lower->upper swing is positive across the whole parameter
// plateau (n = 180..300, k = 1.75..2.5 all made money on the dev window),
// both halves of the dev window contributed, and max drawdown stayed
// around 1%. The parameters sit in the middle of that plateau (n = 240,
// k = 2.25), not at a tuned peak.
//
// DETERMINISM: no clock, no environment, no randomness. Every value comes
// from the bar stream; two runs on the same data give the same orders.
// Diagnostics go to stderr only; stdout carries replies, nothing else.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, OrderInput } from './vendor/makefun-bars.ts';

const N_BAND = 240; // 4 hours of 1-minute bars
const K_ENTRY = 2.25; // entry/exit band width in standard deviations
const K_PROBE = 1.5; // fallback band width once the late probe is armed
const PROBE_AFTER_BAR = 1080; // 18h into the scored window, flat, no trades yet
const STOP_FRACTION = 0.008; // 0.8% below the entry close
const BREAKER_NUM = 97n; // equity below 97% of its peak -> flatten and stop
const BREAKER_DEN = 100n;
const COOLDOWN_BARS = 120; // no re-entry this soon after a stop-loss
const MAX_SLIPPAGE_BPS = 200;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, the competition minimum

let symbol = 'CBBTC';
const closes: number[] = [];
let entryClose: number | null = null;
let peakEquity = 0n;
let stopped = false;
let lastStopSeq = -1_000_000_000;
let trades = 0;
let probeUsed = false;

interface Bands {
  mean: number;
  upper: number;
  lower: number;
  lowerProbe: number;
}

function bands(): Bands {
  const w = closes.slice(-N_BAND);
  let sum = 0;
  for (let i = 0; i < w.length; i++) sum += w[i];
  const mean = sum / w.length;
  let sq = 0;
  for (let i = 0; i < w.length; i++) {
    const d = w[i] - mean;
    sq += d * d;
  }
  const sd = Math.sqrt(sq / w.length);
  return {
    mean,
    upper: mean + K_ENTRY * sd,
    lower: mean - K_ENTRY * sd,
    lowerProbe: mean - K_PROBE * sd,
  };
}

await runBars({
  onHello(state: BarsState): void {
    symbol = state.hello.symbols[0].symbol;
    peakEquity = state.equity;
  },

  onBatch(state: BarsState): OrderInput[] {
    const closeBig = state.close(symbol);
    if (closeBig === null) return [];
    const c = Number(closeBig);
    closes.push(c);

    if (peakEquity === 0n) peakEquity = state.equity;
    if (state.equity > peakEquity) peakEquity = state.equity;
    if (stopped) return [];
    if (state.warmingUp) return [];

    const qty = state.positions.get(symbol)?.qty ?? 0n;

    // Circuit breaker: flatten once, then stay out.
    if (state.equity < (peakEquity * BREAKER_NUM) / BREAKER_DEN) {
      stopped = true;
      if (qty > 0n) {
        console.error(`breaker seq=${state.seq} equity=${state.equity} peak=${peakEquity}`);
        return [{ side: 'sell', symbol, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (closes.length < N_BAND) return [];
    const b = bands();
    const scoredSeq = state.seq - state.warmupBars;

    if (qty === 0n) {
      if (state.seq - lastStopSeq < COOLDOWN_BARS) return [];

      // Late probe: guarantee at least one trade in a grind-up / flat window.
      if (trades === 0 && scoredSeq >= PROBE_AFTER_BAR && !probeUsed) {
        probeUsed = true;
        trades += 1;
        entryClose = c;
        const half = state.cash / 2n;
        if (half < MIN_NOTIONAL) return [];
        console.error(`probe buy seq=${state.seq} close=${c} notional=${half}`);
        return [{ side: 'buy', symbol, notional_quote_units: half, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }

      const lower = trades === 0 && scoredSeq >= PROBE_AFTER_BAR ? b.lowerProbe : b.lower;
      if (c < lower) {
        trades += 1;
        entryClose = c;
        if (state.cash < MIN_NOTIONAL) return [];
        console.error(`buy seq=${state.seq} close=${c} notional=${state.cash}`);
        return [{ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Holding: stop-loss first, then the upper-band exit.
    if (entryClose !== null && c < entryClose * (1 - STOP_FRACTION)) {
      const entry = entryClose;
      lastStopSeq = state.seq;
      entryClose = null;
      console.error(`stop sell seq=${state.seq} close=${c} entry=${entry}`);
      return [{ side: 'sell', symbol, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (c >= b.upper) {
      entryClose = null;
      console.error(`band sell seq=${state.seq} close=${c}`);
      return [{ side: 'sell', symbol, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
