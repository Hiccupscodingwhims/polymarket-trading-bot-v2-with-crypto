// scanner.js
import fetch from 'node-fetch';
import { isEventLocked } from './state.js';

// Configuration
const BATCH_SIZE = 1; // Process 10 markets in parallel
const DELAY_BETWEEN_BATCHES = 0; // ms pause between batches (VPN-friendly) delay between each batch processing
const REQUEST_TIMEOUT = 10000; // 10s timeout per request 

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timeoutFetch(url, ms) {
  return Promise.race([
    fetch(url),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), ms)
    )
  ]);
}

export async function scan(config) {
  const scanStart = Date.now();
  console.log('\n🔍 ============ STARTING SCAN ============');
  console.log(`   Config: ${config.MIN_PROBABILITY}-${config.MAX_PROBABILITY} prob, ${config.MAX_HOURS_TO_CLOSE}h window, $${config.MIN_LIQUIDITY_USD} min liq`);
  
  try {
    // Step 1: Fetch all events
    console.log('\n📡 Step 1/4: Fetching events from API...');
    const discovery = await fetchAllEvents();
    console.log(`✅ Fetched ${discovery.events.length} events`);
    
    // Step 2: Pre-filter events and collect markets
    console.log('\n🔄 Step 2/4: Pre-filtering events and collecting markets...');
    const { marketJobs, counters } = collectMarketJobs(discovery.events);
    
    console.log(`   Locked events skipped: ${counters.lockedCount}`);
    console.log(`   Slug pattern skipped: ${counters.skippedSlugCount}`);
    console.log(`   📋 Markets to check: ${marketJobs.length}`);
    
    if (marketJobs.length === 0) {
      console.log('\n⚠️  No markets to check after pre-filtering');
      logScanSummary(scanStart, counters, []);
      return [];
    }
    
    // Step 3: Process markets in parallel batches
    console.log(`\n⚡ Step 3/4: Processing ${marketJobs.length} markets (${BATCH_SIZE} at a time)...`);
    const { eligible, marketCounters } = await processMarketBatches(marketJobs, config);
    
    // Merge counters
    const finalCounters = {
      ...counters,
      ...marketCounters
    };
    
    // Step 4: Log summary
    console.log('\n📊 Step 4/4: Scan complete!');
    logScanSummary(scanStart, finalCounters, eligible);
    
    return eligible;
    
  } catch (err) {
    console.error('\n❌ SCANNER CRASHED:', err.message);
    console.error(err.stack);
    return [];
  }
}

function collectMarketJobs(events) {
  const marketJobs = [];
  let lockedCount = 0;
  let skippedSlugCount = 0;
  
  for (const event of events) {
    // Skip locked events
    if (isEventLocked(event.eventId)) {
      lockedCount++;
      continue;
    }
    
    // Collect markets from this event
    for (const m of event.markets) {
      if (shouldSkipMarket(m.slug)) {
        skippedSlugCount++;
        continue;
      }
      
      marketJobs.push({ event, market: m });
    }
  }
  
  return {
    marketJobs,
    counters: { lockedCount, skippedSlugCount }
  };
}

async function processMarketBatches(marketJobs, config) {
  const eligible = [];
  const counters = {
    checked: 0,
    timeFilterCount: 0,
    probFilterCount: 0,
    liquidityFilterCount: 0,
    fetchErrors: 0
  };
  
  const totalBatches = Math.ceil(marketJobs.length / BATCH_SIZE);
  let currentBatch = 0;
  
  for (let i = 0; i < marketJobs.length; i += BATCH_SIZE) {
    currentBatch++;
    const batch = marketJobs.slice(i, i + BATCH_SIZE);
    
    // Process batch in parallel
    const results = await Promise.allSettled(
      batch.map(job => checkMarket(job, config))
    );
    
    // Collect results
    for (const result of results) {
      counters.checked++;
      
      if (result.status === 'rejected') {
        counters.fetchErrors++;
        continue;
      }
      
      const { outcome, filters } = result.value;
      
      // Update filter counters
      if (filters.timeFilter) counters.timeFilterCount++;
      if (filters.probFilter) counters.probFilterCount++;
      if (filters.liquidityFilter) counters.liquidityFilterCount++;
      if (filters.fetchError) counters.fetchErrors++;
      
      // Add to eligible if found
      if (outcome) {
        eligible.push(outcome);
        console.log(`   ✅ ${outcome.slug}`);
        console.log(`      ${outcome.side} @ ${outcome.bestAsk.toFixed(3)} | Prob: ${outcome.probability.toFixed(3)} | ${outcome.hoursToClose.toFixed(1)}h | Liq: $${(outcome.bestAsk * outcome.askSize).toFixed(2)}`);
      }
    }
    
    // Progress update every 5 batches or on last batch
    if (currentBatch % 5 === 0 || currentBatch === totalBatches) {
      const progress = ((counters.checked / marketJobs.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - Date.now()) / 1000).toFixed(1);
      console.log(`   📊 Progress: ${counters.checked}/${marketJobs.length} (${progress}%) | Batch ${currentBatch}/${totalBatches} | Found: ${eligible.length}`);
    }
    
    // Delay between batches (except last one)
    if (i + BATCH_SIZE < marketJobs.length) {
      await delay(DELAY_BETWEEN_BATCHES);
    }
  }
  
  return { eligible, marketCounters: counters };
}

async function checkMarket(job, config) {
  const { event, market: m } = job;
  const filters = {
    timeFilter: false,
    probFilter: false,
    liquidityFilter: false,
    fetchError: false
  };
  
  try {
    // ============ STAGE 1: Market fetch + cheap filters ============
    const market = await fetchMarketBySlug(m.slug);
    
    if (!market?.outcomePrices || !market?.endDate) {
      filters.fetchError = true;
      return { outcome: null, filters };
    }
    
    // Time filter
    const hrs = hoursUntil(market.endDate);
    if (hrs <= 0 || hrs > config.MAX_HOURS_TO_CLOSE) {
      filters.timeFilter = true;
      return { outcome: null, filters };
    }
    
    // Parse prices and tokens
    const prices = JSON.parse(market.outcomePrices).map(Number);
    const tokens = JSON.parse(market.clobTokenIds);
    
    // Check probability BEFORE fetching orderbooks
    const eligibleSides = [];
    for (const side of ['YES', 'NO']) {
      const prob = side === 'YES' ? prices[0] : 1 - prices[0];
      
      if (prob >= config.MIN_PROBABILITY && prob <= config.MAX_PROBABILITY) {
        eligibleSides.push({
          side,
          prob,
          tokenId: tokens[side === 'YES' ? 0 : 1]
        });
      } else {
        filters.probFilter = true;
      }
    }
    
    // Skip orderbook fetch if no sides qualify
    if (eligibleSides.length === 0) {
      return { outcome: null, filters };
    }
    
    // ============ STAGE 2: Orderbook fetch only for qualified sides ============
    for (const { side, prob, tokenId } of eligibleSides) {
      let book;
      try {
        book = await fetchOrderbook(tokenId);
      } catch {
        filters.fetchError = true;
        continue;
      }
      
      if (!book.asks?.length) continue;
      
      const bestAsk = Math.min(...book.asks.map(a => Number(a.price)));
      
      if (bestAsk < config.MIN_PROBABILITY || bestAsk > config.MAX_PROBABILITY) {
        filters.probFilter = true;
        continue;
      }
      
      const size = book.asks
        .filter(a => Number(a.price) === bestAsk)
        .reduce((s, a) => s + Number(a.size), 0);
      
      const liquidity = bestAsk * size;
      
      if (liquidity < config.MIN_LIQUIDITY_USD) {
        filters.liquidityFilter = true;
        continue;
      }
      
      // Found eligible market!
      return {
        outcome: {
          eventId: event.eventId,
          marketId: market.id,
          slug: m.slug,
          side,
          tokenId,
          probability: prob,
          bestAsk,
          askSize: size,
          hoursToClose: hrs,
          endDate: market.endDate
        },
        filters
      };
    }
    
    return { outcome: null, filters };
    
  } catch (err) {
    filters.fetchError = true;
    return { outcome: null, filters };
  }
}

function shouldSkipMarket(slug) {
  return /15m|spl|1pt5|2pt5|3pt5|4pt5|win|lose|draw/.test(slug);
}

function hoursUntil(iso) {
  return (new Date(iso) - Date.now()) / 36e5;
}

async function fetchAllEvents() {
  console.log('   Fetching event batches...');
  const events = [];
  let offset = 0;
  let pageCount = 0;
  
  while (true) {
    let batch;
    try {
      const res = await timeoutFetch(
        `https://gamma-api.polymarket.com/events?closed=false&limit=100&offset=${offset}`,
        REQUEST_TIMEOUT
      );
      
      if (!res.ok) {
        console.log(`   ⚠️  HTTP ${res.status} at offset ${offset}`);
        if (res.status === 429) {
          console.log('   🚫 Rate limited - waiting 60s...');
          await delay(60000);
          continue;
        }
        break;
      }
      
      batch = await res.json();
    } catch (err) {
      console.log(`   ⚠️  Failed at offset ${offset}: ${err.message}`);
      break;
    }
    
    if (!batch?.length) break;
    
    // Filter events with markets
    const validEvents = batch
      .filter(e => e.markets?.length)
      .map(e => ({
        eventId: e.id,
        slug: e.slug,
        endDate: e.endDate,
        markets: e.markets.map(m => ({ id: m.id, slug: m.slug }))
      }));
    
    events.push(...validEvents);
    pageCount++;
    
    // Progress update every 10 pages
    if (pageCount % 10 === 0) {
      console.log(`   ... fetched ${events.length} events (${pageCount} pages)`);
    }
    
    offset += 100;
    
    // Stop if we got less than 100 (last page)
    if (batch.length < 100) break;
  }
  
  console.log(`   ✅ Total events fetched: ${events.length} (${pageCount} pages)`);
  return { events };
}

async function fetchMarketBySlug(slug) {
  const res = await timeoutFetch(
    `https://gamma-api.polymarket.com/markets?slug=${slug}`,
    REQUEST_TIMEOUT
  );
  const data = await res.json();
  return data[0];
}

async function fetchOrderbook(tokenId) {
  const res = await timeoutFetch(
    `https://clob.polymarket.com/book?token_id=${tokenId}`,
    REQUEST_TIMEOUT
  );
  return res.json();
}

function logScanSummary(scanStart, counters, eligible) {
  const totalTime = ((Date.now() - scanStart) / 1000).toFixed(1);
  
  console.log('\n📊 ============ SCAN SUMMARY ============');
  console.log(`   ⏱️  Total time: ${totalTime}s`);
  console.log(`   📥 Markets checked: ${counters.checked || 0}`);
  console.log('\n   Filter Results:');
  console.log(`   🔒 Locked events: ${counters.lockedCount}`);
  console.log(`   ⏰ Time filter (>${counters.MAX_HOURS_TO_CLOSE || '?'}h): ${counters.timeFilterCount}`);
  console.log(`   🎯 Slug patterns skipped: ${counters.skippedSlugCount}`);
  console.log(`   📊 Probability filter: ${counters.probFilterCount}`);
  console.log(`   💧 Liquidity filter: ${counters.liquidityFilterCount}`);
  console.log(`   ❌ Fetch errors: ${counters.fetchErrors}`);
  console.log(`\n   ✅ ELIGIBLE MARKETS: ${eligible.length}`);
  
  if (eligible.length > 0) {
    console.log('\n   Found markets:');
    eligible.forEach((m, i) => {
      console.log(`   ${i + 1}. ${m.slug} (${m.side})`);
    });
  }
  
  console.log('========================================\n');
}