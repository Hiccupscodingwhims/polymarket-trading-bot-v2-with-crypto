// executor.js
import { state, addPosition, save } from './state.js';

export function execute(markets, config) {
  const { TOTAL_BUDGET, PER_MARKET_CAP } = config;
  const W = state.wallet.balance;
  const N = markets.length;
  
  if (N === 0 || W <= 0) return;

  const baseAlloc = W / N;
  const allocPerMarket = Math.min(baseAlloc, PER_MARKET_CAP);

  for (const m of markets) {
    // ✅ CHECK: Skip if event was already locked in this batch
    if (state.eventLocks.has(m.eventId)) {
      console.log(`⏭️  Skipping ${m.slug} - event ${m.eventId} already locked`);
      continue;
    }

    const price = m.bestAsk;
    const maxSize = Math.min(allocPerMarket / price, m.askSize);
    if (maxSize <= 0) continue;

    const cost = maxSize * price;
    if (cost > state.wallet.balance) continue;

    state.wallet.balance -= cost;
    
    addPosition({
      eventId: m.eventId,
      marketId: m.marketId,
      slug: m.slug,
      side: m.side,
      tokenId: m.tokenId,
      entryPrice: price,
      entryProb: m.probability,
      size: maxSize,
      cost,
      boughtAt: new Date().toISOString()
    });

    console.log(`✅ BUY ${m.slug} ${m.side} @ ${price} | Size: ${maxSize.toFixed(2)} | Cost: $${cost.toFixed(2)}`);
  }

  save();
}