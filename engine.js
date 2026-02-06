// engine.js
import { load, save, state } from './state.js';
import { scan } from './scanner.js';
import { execute } from './executor.js';
import { monitor } from './monitor.js';

const config = {
  MAX_HOURS_TO_CLOSE: 4,
  MIN_PROBABILITY: 0.85,
  MAX_PROBABILITY: 0.96,
  MIN_LIQUIDITY_USD: 3,
  STOP_PROB_DROP: 0.15,
  PER_MARKET_CAP: 2
};

const CYCLE_INTERVAL = 60 * 60 * 1000; // 2 minutes

async function cycle() {
  try {
    console.log(`\n[${new Date().toLocaleTimeString()}] Running cycle...`);
    console.log(`💰 Wallet: $${state.wallet.balance.toFixed(2)} | Positions: ${state.positions.length}`);

    console.log('👀 Monitoring positions...');
    await monitor(config);

    console.log('🔍 Starting scan...');
    const scanStart = Date.now();
    const markets = await scan(config);
    const scanDuration = ((Date.now() - scanStart) / 1000).toFixed(1);

    console.log(`⏱️  Scan took ${scanDuration}s`);
    console.log(`📊 Eligible markets: ${markets.length}`);

    if (markets.length > 0) {
      execute(markets, config);
    }

    save();
  } catch (err) {
    console.error('❌ Cycle error:', err.message);
  }
}

// Load state
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

// Run first cycle
cycle().catch(err => {
  console.error('❌ Initial cycle failed:', err);
});

// Schedule repeating cycles
setInterval(() => {
  cycle().catch(err => {
    console.error('❌ Cycle failed:', err);
  });
}, CYCLE_INTERVAL);

// Keep process alive
process.stdin.resume();

console.log(`⏰ Cycle interval: ${CYCLE_INTERVAL / 1000}s`);
console.log('Press Ctrl+C to stop\n');