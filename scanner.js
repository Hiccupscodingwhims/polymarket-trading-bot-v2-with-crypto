// scanner.js
import fetch from 'node-fetch';
import { isEventLocked } from './state.js';

// Configuration
const BATCH_SIZE = 1; // Process 10 markets in parallel
const DELAY_BETWEEN_BATCHES = 5; // ms pause between batches (VPN-friendly) delay between each batch processing
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

  try {
    const discovery = await fetchAllEvents();
    console.log(`📥 Events: ${discovery.events.length}`);

    const { marketJobs } = collectMarketJobs(discovery.events);
    console.log(`📋 Markets to fetch: ${marketJobs.length}`);

    if (marketJobs.length === 0) {
      console.log(`📊 Scan: 0 eligible markets`);
      return [];
    }

    const { eligible, marketCounters } = await processMarketBatches(marketJobs, config);

    const totalTime = ((Date.now() - scanStart) / 1000).toFixed(1);
    const fetchSuccess = marketCounters.checked - marketCounters.fetchErrors;

    console.log(`📊 Scan complete: ${eligible.length} eligible (${totalTime}s)`);
    console.log(`   Markets fetched: ${fetchSuccess}/${marketCounters.checked} (${marketCounters.fetchErrors} failed)`);

    if (eligible.length > 0) {
      eligible.forEach((m, i) => {
        console.log(`   ${i + 1}. ${m.slug} ${m.side} @ ${m.bestAsk.toFixed(3)}`);
      });
    }

    return eligible;

  } catch (err) {
    console.error('❌ Scanner error:', err.message);
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

  for (let i = 0; i < marketJobs.length; i += BATCH_SIZE) {
    const batch = marketJobs.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(job => checkMarket(job, config))
    );

    for (const result of results) {
      counters.checked++;

      if (result.status === 'rejected') {
        counters.fetchErrors++;
        continue;
      }

      const { outcome, filters } = result.value;

      if (filters.timeFilter) counters.timeFilterCount++;
      if (filters.probFilter) counters.probFilterCount++;
      if (filters.liquidityFilter) counters.liquidityFilterCount++;
      if (filters.fetchError) counters.fetchErrors++;

      if (outcome) {
        eligible.push(outcome);
      }
    }

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
  const s = slug.toLowerCase();

  // always-skip patterns (global, non-token based)
  if (/15m|spl|1pt5|2pt5|3pt5|4pt5|win|lose|draw|super-bowl/.test(s)) {
    return true;
  }

  // hyphen-tight abbreviation matcher
  // matches: -abbr-, -abbr, abbr-
  const abbrRegex = /(?:^|-)(?:tien|lps|usa|partiz|oak|gauff|pain|col|190e|wca|jng|ajp|djere|afg|voc|akt1|crv1|gl|ydn1|gl1|svj|hood|syd|omega1|eer|mot|tac|wes|drg|z101|syd1|nyl|ie|mia|lbvc|faze|sabalen|invict1|vae|ske|lul|hv|not|hnames|b5|mile|ungd|juv|gh|sawangk|eng|ham|som|car|cfc1|glo|ad|ess|lei|kitcat|war|erie|mid|dep|wor|dur|67|ken|nor|mnm|yor|tty|eiq|cgaa|ivanov|sevasto|n5r|qlm|omit|ov|2mr|rad|202|rej|vvv|fro|lek|yak|par|sus|dv1|lan|der|ep3|min|sur|gla|vachero|haz|pt3|rscnj|ytigeres|psbev|clu|ober|prizmic|a1|hon|newgro|b2|win2|sas|kom|vit|spa|sou|din|dea|tor|pbks|uola|qat|bel|bar|ava|ska|sha|lin|roe|fae|los|ee1|ran|hig|basavar|joh|iusb|sfu|for|cha|gg3|cs1|tse|ben|khu|a2|nep|b1|ces|wss|ros|loyolo)(?:-|$)/;

  return abbrRegex.test(s);
}


function hoursUntil(iso) {
  return (new Date(iso) - Date.now()) / 36e5;
}

async function fetchAllEvents() {
  const events = [];
  let offset = 0;

  console.log(`   🔍 Fetching events from Polymarket API...`);

  while (true) {
    let batch;
    try {
      const url = `https://gamma-api.polymarket.com/events?closed=false&limit=100&offset=${offset}`;
      const res = await timeoutFetch(url, REQUEST_TIMEOUT);

      if (!res.ok) {
        console.log(`   ⚠️  API returned HTTP ${res.status}`);
        if (res.status === 429) {
          console.log(`   ⏳ Rate limited, waiting 60s...`);
          await delay(60000);
          continue;
        }
        break;
      }

      batch = await res.json();
    } catch (err) {
      console.log(`   ❌ Fetch failed at offset ${offset}: ${err.message}`);
      break;
    }

    if (!batch?.length) {
      console.log(`   ✅ Reached end of events (offset: ${offset})`);
      break;
    }

    const validEvents = batch
      .filter(e => e.markets?.length)
      .map(e => ({
        eventId: e.id,
        slug: e.slug,
        endDate: e.endDate,
        markets: e.markets.map(m => ({ id: m.id, slug: m.slug }))
      }));

    events.push(...validEvents);
    offset += 100;

    if (batch.length < 100) break;
  }

  console.log(`   ✅ Fetched ${events.length} events total`);
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