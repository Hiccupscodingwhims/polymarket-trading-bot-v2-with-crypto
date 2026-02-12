// websocket.js
import WebSocket from 'ws';
import { state, closePosition, save } from './state.js';
import { logTrade } from './logger.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const RECONNECT_DELAY = 5000;
const PING_INTERVAL = 10000;
const FEE_RATE = 0.00;

let ws = null;
let reconnectTimeout = null;
let pingInterval = null;
let isEnabled = false;

export function startWebSocket(config) {
  // Only start if we have positions
  if (state.positions.length > 0) {
    isEnabled = true;
    connect(config);
  } else {
    console.log('📡 WebSocket not started (no positions to monitor)');
  }
}

function connect(config) {
  if (!isEnabled) return;
  
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('🔌 WebSocket connected');
    subscribeAll();
    startPing();
  });

  ws.on('message', (data) => {
    handleMessage(data, config);
  });

  ws.on('close', () => {
    console.log('🔌 WebSocket disconnected, reconnecting in 5s...');
    stopPing();
    reconnectTimeout = setTimeout(() => connect(config), RECONNECT_DELAY);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

function startPing() {
  pingInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send('PING');
    }
  }, PING_INTERVAL);
}

function stopPing() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

function subscribeAll() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  
  const tokenIds = state.positions.map(p => p.tokenId);
  
  // Don't send empty subscription
  if (tokenIds.length === 0) {
    console.log('⚠️  No positions to subscribe to');
    return;
  }
  
  ws.send(JSON.stringify({
    assets_ids: tokenIds,
    type: "market"
  }));
  
  console.log(`📡 Subscribed to ${tokenIds.length} positions`);
}

function handleMessage(data, config) {
  try {
    const msg = JSON.parse(data);
    
    if (msg.event_type === 'book') {
      checkStopLossForToken(msg.asset_id, msg.bids, config);
    }
  } catch (err) {
    // Ignore parse errors
  }
}

function checkStopLossForToken(tokenId, bids, config) {
  const position = state.positions.find(p => p.tokenId === tokenId);
  if (!position || !bids?.length) return;

  const bestBid = Math.max(...bids.map(b => Number(b.price)));
  const priceDrop = (position.entryPrice - bestBid) / position.entryPrice;

  if (priceDrop >= config.STOP_PRICE_DROP) {
    console.log("Stop loss would have triggered for", position.slug, `| Entry: ${position.entryPrice.toFixed(3)} | Best Bid: ${bestBid.toFixed(3)} | Drop: ${(priceDrop * 100).toFixed(2)}%`);
    // executeStopLoss(position, bestBid);
  }
}

function executeStopLoss(position, bestBid) {
  const payout = position.size * bestBid;
  const pnl = payout - position.cost - payout * FEE_RATE;

  state.wallet.balance += payout;
  closePosition(position.id, 'STOP_LOSS', payout, pnl);
  
  logTrade(position, 'STOP_LOSS', payout, pnl);
  console.log(`🛑 STOP ${position.slug} | Entry: ${position.entryPrice.toFixed(3)} | Exit: ${bestBid.toFixed(3)} | P&L: $${pnl.toFixed(2)}`);
  
  save();
  
  // If no more positions, disconnect WebSocket
  if (state.positions.length === 0) {
    console.log('📡 All positions closed, disconnecting WebSocket');
    cleanup();
  }
}

export function subscribePosition(tokenId) {
  // Start WebSocket if this is the first position
  if (!isEnabled && !ws) {
    isEnabled = true;
    const config = { STOP_PRICE_DROP: 0.15 }; // Use from engine
    connect(config);
  } else if (ws?.readyState === WebSocket.OPEN) {
    subscribeAll();
  }
}

export function unsubscribePosition(tokenId) {
  // Handled by stop loss / resolution
}

export function cleanup() {
  isEnabled = false;
  stopPing();
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (ws) ws.close();
  ws = null;
}