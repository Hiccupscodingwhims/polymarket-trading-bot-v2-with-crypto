// engine.js
import express from 'express';
import { load, save, state } from './state.js';
import { scan } from './scanner.js';
import { execute } from './executor.js';
import { monitor } from './monitor.js';

const config = {
  MAX_HOURS_TO_CLOSE: 4,
  MIN_PROBABILITY: 0.80,
  MAX_PROBABILITY: 0.96,
  MIN_LIQUIDITY_USD: 2,
  STOP_PROB_DROP: 0.25,
  PER_MARKET_CAP: 2
};

const MONITOR_INTERVAL = 1 * 60 * 1000; // 1 minute - check stops/resolutions
const SCAN_INTERVAL = 1 * 60 * 60 * 1000; // 1 hour - scan for new markets

// HTTP endpoint
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/state', (req, res) => {
  res.json({
    balance: state.wallet.balance,
    positions: state.positions.length,
    closedPositions: state.closedPositions.length,
    eventLocks: state.eventLocks.size,
    realizedPnL: state.closedPositions.reduce((sum, p) => sum + p.pnl, 0).toFixed(2),
    totalValue: (state.wallet.balance + state.positions.reduce((s, p) => s + p.cost, 0)).toFixed(2),
    openTrades: state.positions.map(p => ({
      slug: p.slug,
      side: p.side,
      entryPrice: p.entryPrice,
      size: p.size,
      cost: p.cost
    })),
    allClosedTrades: state.closedPositions.map(p => ({
      slug: p.slug,
      side: p.side,
      resolution: p.resolution,
      pnl: p.pnl.toFixed(2),
      closedAt: p.closedAt
    }))
  });
});

app.listen(PORT, () => {
  const url = process.env.RAILWAY_STATIC_URL 
    ? `https://${process.env.RAILWAY_STATIC_URL}/state`
    : `http://localhost:${PORT}/state`;
  console.log(`🌐 State endpoint: ${url}`);
});

async function monitorCycle() {
  try {
    await monitor(config);
    save();
  } catch (err) {
    console.error('❌ Monitor error:', err.message);
  }
}

async function scanCycle() {
  try {
    console.log(`\n[${new Date().toLocaleTimeString()}] Running scan cycle...`);
    console.log(`💰 Wallet: $${state.wallet.balance.toFixed(2)} | Positions: ${state.positions.length}`);

    const markets = await scan(config);
    console.log(`📊 Eligible markets: ${markets.length}`);

    if (markets.length > 0) {
      execute(markets, config);
    }

    save();
    
    console.log(`📊 State: Balance=$${state.wallet.balance.toFixed(2)} | Open=${state.positions.length} | Closed=${state.closedPositions.length} | Locks=${state.eventLocks.size}`);
  } catch (err) {
    console.error('❌ Scan cycle error:', err.message);
  }
}

try {
  load();
  console.log('🚀 Engine started');
  console.log(`💰 Starting balance: $${state.wallet.balance.toFixed(2)}`);
  console.log(`📦 Loaded ${state.positions.length} open positions`);
  console.log(`🔒 Locked events: ${state.eventLocks.size}`);
} catch (err) {
  console.error('❌ Failed to load state:', err.message);
  process.exit(1);
}

// Run initial scan
scanCycle().catch(err => {
  console.error('❌ Initial scan failed:', err);
});

// Start monitor loop (1 minute)
setInterval(() => {
  monitorCycle().catch(err => {
    console.error('❌ Monitor cycle failed:', err);
  });
}, MONITOR_INTERVAL);

// Start scan loop (1 hour)
setInterval(() => {
  scanCycle().catch(err => {
    console.error('❌ Scan cycle failed:', err);
  });
}, SCAN_INTERVAL);

process.stdin.resume();

console.log(`⏰ Monitor interval: ${MONITOR_INTERVAL / 1000}s (stop loss checks)`);
console.log(`⏰ Scan interval: ${SCAN_INTERVAL / 1000}s (new markets)`);
console.log('Press Ctrl+C to stop\n');