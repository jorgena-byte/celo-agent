const { ethers } = require('ethers');
const fetch = require('node-fetch');

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  CELO_RPC: 'https://forno.celo.org',
  SAFE_ADDRESS: '0xa7b0ceAD940056cc9aFe8034F1cc507A048be8CF',
  EXECUTOR_PRIVATE_KEY: 'ca156e18ebcd6709f5dd50dd041b7b96cf8e5a437a41598a7c333f20da5016ca',
  EXECUTOR_ADDRESS: '0xD896F9b50A80F20040E579A551E3CCbF326D6810',
  TELEGRAM_TOKEN: '8751112209:AAF600GfxRQtVzyOMYr6A8sthVyMWEGxljc',
  TELEGRAM_CHAT_ID: '2113323141',
  UNISWAP_ROUTER: '0x5615CDAb10dc425a742d643d949a7F474C01ABc2',

  // CELO strategy
  BUY_DROP_PCT: 5,
  SELL_RISE_PCT: 10,
  STOP_LOSS_PCT: 15,
  TRADE_SIZE_USD: 100,
  SELL_PORTION: 0.4,
  CHECK_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes

  // FX strategy
  FX_MIN_SPREAD_PCT: 0.5,
  FX_TRADE_SIZE_USD: 100,
};

const TOKENS = {
  CELO:  { address: '0x471EcE3750Da237f93B8E339c536989b8978a438', decimals: 18 },
  cUSD:  { address: '0x765DE816845861e75A25fCA122bb6898B8B1282a', decimals: 18 },
  cEUR:  { address: '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73', decimals: 18 },
  cREAL: { address: '0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787', decimals: 18 },
  USDT:  { address: '0x617f3112bf5397D0467D315cC709EF968D9ba546', decimals: 6  },
  USDC:  { address: '0xef4229c8c3250C675F21BCefa42f58EfbfF6002a', decimals: 6  },
};

// ============================================================
// SETUP
// ============================================================
const provider = new ethers.providers.JsonRpcProvider(CONFIG.CELO_RPC);
const executorWallet = new ethers.Wallet(CONFIG.EXECUTOR_PRIVATE_KEY, provider);

let baselinePrice = null;
let lastFxTrade = {};
let totalFxYield = 0;
let tradeHistory = [];

// ============================================================
// TELEGRAM
// ============================================================
async function sendTelegram(message) {
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch(e) {
    console.error('Telegram error:', e.message);
  }
}

// ============================================================
// PRICE FEEDS
// ============================================================
async function fetchCeloPrice() {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/celo/tokens/${TOKENS.CELO.address.toLowerCase()}`);
    const data = await res.json();
    return parseFloat(data?.data?.attributes?.price_usd || 0);
  } catch(e) {
    console.error('Price fetch error:', e.message);
    return null;
  }
}

async function fetchTokenPrice(symbol) {
  try {
    const addr = TOKENS[symbol].address.toLowerCase();
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/celo/tokens/${addr}`);
    const data = await res.json();
    return parseFloat(data?.data?.attributes?.price_usd || 0);
  } catch(e) { return null; }
}

async function fetchRealFxRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    return {
      EURUSD: 1 / data.rates.EUR,
      BRLUSD: 1 / data.rates.BRL,
    };
  } catch(e) {
    return { EURUSD: 1.08, BRLUSD: 0.19 };
  }
}

// ============================================================
// SAFE EXECUTION
// ============================================================
async function executeSafeSwap(fromSymbol, toSymbol, amount, extraSpread = 0) {
  console.log(`Executing Safe swap: ${amount} ${fromSymbol} → ${toSymbol}`);

  const fromToken = TOKENS[fromSymbol];
  const toToken = TOKENS[toSymbol];

  const amountInUnits = ethers.utils.parseUnits(amount.toString(), fromToken.decimals);

  const safeInterface = new ethers.utils.Interface([
    'function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) returns (bool success)'
  ]);

  const erc20Interface = new ethers.utils.Interface([
    'function approve(address spender, uint256 amount) returns (bool)'
  ]);

  const uniswapInterface = new ethers.utils.Interface([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)'
  ]);

  const safeContract = new ethers.Contract(CONFIG.SAFE_ADDRESS, safeInterface, executorWallet);

  // Approve
  const approveData = erc20Interface.encodeFunctionData('approve', [CONFIG.UNISWAP_ROUTER, amountInUnits]);
  const approveTx = await safeContract.execTransactionFromModule(fromToken.address, 0, approveData, 0, { gasLimit: 200000 });
  await approveTx.wait();
  console.log(`Approval confirmed: ${approveTx.hash}`);

  // Swap
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const swapData = uniswapInterface.encodeFunctionData('exactInputSingle', [{
    tokenIn: fromToken.address,
    tokenOut: toToken.address,
    fee: 3000,
    recipient: CONFIG.SAFE_ADDRESS,
    deadline,
    amountIn: amountInUnits,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0
  }]);

  const swapTx = await safeContract.execTransactionFromModule(CONFIG.UNISWAP_ROUTER, 0, swapData, 0, { gasLimit: 500000 });
  await swapTx.wait();
  console.log(`Swap confirmed: ${swapTx.hash}`);

  // Record trade
  // Estimate FX yield: amount * spread (passed in as extra param, default 0)
  const estimatedYield = amount * (extraSpread || 0);
  tradeHistory.unshift({
    timestamp: new Date().toISOString(),
    fromSymbol, toSymbol, amount,
    txHash: swapTx.hash,
    fxYield: estimatedYield
  });

  await sendTelegram(`✅ <b>AUTO TRADE EXECUTED</b>

🔄 ${amount} ${fromSymbol} → ${toSymbol}
🏦 From Safe wallet
🔗 <a href="https://celoscan.io/tx/${swapTx.hash}">View on CeloScan</a>`);

  return swapTx.hash;
}

// ============================================================
// CELO TRADING STRATEGY
// ============================================================
async function checkCeloStrategy() {
  const currentPrice = await fetchCeloPrice();
  if (!currentPrice) return;

  if (!baselinePrice) {
    baselinePrice = currentPrice;
    console.log(`Baseline price set: $${currentPrice.toFixed(4)}`);
    return;
  }

  const pctChange = ((currentPrice - baselinePrice) / baselinePrice) * 100;
  console.log(`CELO: $${currentPrice.toFixed(4)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}% from baseline)`);

  if (pctChange <= -CONFIG.STOP_LOSS_PCT) {
    console.log('Stop loss triggered!');
    await sendTelegram(`🛑 <b>STOP LOSS TRIGGERED</b>\nCELO dropped ${Math.abs(pctChange).toFixed(2)}%\nPrice: $${currentPrice.toFixed(4)}`);
    baselinePrice = currentPrice;
    return;
  }

  if (pctChange <= -CONFIG.BUY_DROP_PCT) {
    console.log(`Buy signal: CELO down ${Math.abs(pctChange).toFixed(2)}%`);
    const celoAmount = (CONFIG.TRADE_SIZE_USD / currentPrice).toFixed(4);
    await sendTelegram(`⚡ <b>BUY SIGNAL DETECTED</b>\nCELO down ${Math.abs(pctChange).toFixed(2)}%\nBuying ${celoAmount} CELO`);
    try {
      await executeSafeSwap('cUSD', 'CELO', CONFIG.TRADE_SIZE_USD);
      baselinePrice = currentPrice;
    } catch(e) {
      await sendTelegram(`❌ Trade failed: ${e.message}`);
    }
  } else if (pctChange >= CONFIG.SELL_RISE_PCT) {
    console.log(`Sell signal: CELO up ${pctChange.toFixed(2)}%`);
    await sendTelegram(`⚡ <b>SELL SIGNAL DETECTED</b>\nCELO up ${pctChange.toFixed(2)}%\nTaking partial profit`);
    try {
      const safeBalance = await provider.getBalance(CONFIG.SAFE_ADDRESS);
      const celoBalance = parseFloat(ethers.utils.formatEther(safeBalance));
      const sellAmount = (celoBalance * CONFIG.SELL_PORTION).toFixed(4);
      await executeSafeSwap('CELO', 'cUSD', sellAmount);
      baselinePrice = currentPrice;
    } catch(e) {
      await sendTelegram(`❌ Trade failed: ${e.message}`);
    }
  }
}

// ============================================================
// FX YIELD STRATEGY
// ============================================================
async function checkFxStrategy() {
  const fxRates = await fetchRealFxRates();

  const pairs = [
    { name: 'EURUSD', fromSym: 'cEUR', toSym: 'cUSD', realRate: fxRates.EURUSD },
    { name: 'BRLUSD', fromSym: 'cREAL', toSym: 'cUSD', realRate: fxRates.BRLUSD },
  ];

  for (const pair of pairs) {
    const fromPrice = await fetchTokenPrice(pair.fromSym);
    const toPrice = await fetchTokenPrice(pair.toSym);
    if (!fromPrice || !toPrice) continue;

    const onchainRate = fromPrice / toPrice;
    const spread = ((onchainRate - pair.realRate) / pair.realRate) * 100;
    const absSpread = Math.abs(spread);

    console.log(`FX ${pair.name}: onchain=${onchainRate.toFixed(5)} real=${pair.realRate.toFixed(5)} spread=${spread.toFixed(3)}%`);

    if (absSpread >= CONFIG.FX_MIN_SPREAD_PCT) {
      const now = Date.now();
      if (lastFxTrade[pair.name] && now - lastFxTrade[pair.name] < 30 * 60 * 1000) continue;
      lastFxTrade[pair.name] = now;

      const buySym = spread < 0 ? pair.fromSym : pair.toSym;
      const sellSym = spread < 0 ? pair.toSym : pair.fromSym;

      await sendTelegram(`💱 <b>FX OPPORTUNITY</b>\nPair: ${pair.fromSym}/${pair.toSym}\nSpread: ${absSpread.toFixed(3)}%\nAction: BUY ${buySym} with $${CONFIG.FX_TRADE_SIZE_USD}`);

      try {
        await executeSafeSwap(sellSym, buySym, CONFIG.FX_TRADE_SIZE_USD, absSpread / 100);
        totalFxYield += (CONFIG.FX_TRADE_SIZE_USD * absSpread) / 100;
      } catch(e) {
        await sendTelegram(`❌ FX trade failed: ${e.message}`);
      }
    }
  }
}

// ============================================================
// DAILY REPORT
// ============================================================
async function sendDailyReport() {
  const now = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toDateString();

  // Yesterday's trades
  const yTrades = tradeHistory.filter(t => new Date(t.timestamp).toDateString() === dateStr);

  // All-time totals
  const totalTrades = tradeHistory.length;
  const totalVolume = tradeHistory.reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  const totalYield  = tradeHistory.reduce((sum, t) => sum + (parseFloat(t.fxYield) || 0), 0);

  // Yesterday totals
  const yVolume = yTrades.reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  const yYield  = yTrades.reduce((sum, t) => sum + (parseFloat(t.fxYield) || 0), 0);

  // Current CELO price
  let celoPrice = 0;
  try { celoPrice = await fetchCeloPrice(); } catch(e) {}

  let report = `📊 <b>Daily Report — JA's Trading PA</b>\n`;
  report += `📅 ${dateStr}\n`;
  report += `⏰ Generated at 08:00 CET\n\n`;

  report += `<b>— Yesterday —</b>\n`;
  if (yTrades.length === 0) {
    report += `No trades executed yesterday.\n`;
  } else {
    report += `🔄 Total trades: ${yTrades.length}\n`;
    report += `💰 Total volume: $${yVolume.toFixed(2)}\n`;
    report += `📈 Total FX yield: $${yYield.toFixed(4)}\n\n`;
    report += `<b>Trade Log:</b>\n`;
    yTrades.forEach(t => {
      const time = new Date(t.timestamp).toTimeString().slice(0, 5);
      const yield_ = t.fxYield ? ` (+$${parseFloat(t.fxYield).toFixed(4)})` : '';
      report += `• ${time} — ${t.amount} ${t.fromSymbol} → ${t.toSymbol}${yield_}\n`;
    });
  }

  report += `\n<b>— All Time —</b>\n`;
  report += `🔄 Total trades: ${totalTrades}\n`;
  report += `💰 Total volume: $${totalVolume.toFixed(2)}\n`;
  report += `📈 Total FX yield: $${totalYield.toFixed(4)}\n`;
  if (celoPrice > 0) report += `💎 CELO price: $${celoPrice.toFixed(4)}\n`;

  await sendTelegram(report);
}

// ============================================================
// SCHEDULER
// ============================================================
function scheduleDaily8am(fn) {
  function msUntil8amCET() {
    // CET = UTC+1, CEST = UTC+2 (summer). Target 8:00 CET = 07:00 UTC
    const now = new Date();
    const next = new Date();
    next.setUTCHours(7, 0, 0, 0); // 07:00 UTC = 08:00 CET
    if (now >= next) next.setUTCDate(next.getUTCDate() + 1);
    const ms = next - now;
    const hrs = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    console.log(`Next daily report in ${hrs}h ${mins}m (at 08:00 CET)`);
    return ms;
  }
  setTimeout(() => { fn(); setInterval(fn, 24 * 60 * 60 * 1000); }, msUntil8amCET());
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('JA Trading Agent starting...');
  await sendTelegram('🤖 <b>JA Trading Agent started on server</b>\n✅ Running 24/7 — no browser needed!');

  // Run strategies every 5 minutes
  setInterval(async () => {
    await checkCeloStrategy();
    await checkFxStrategy();
  }, CONFIG.CHECK_INTERVAL_MS);

  // Run immediately on start
  await checkCeloStrategy();
  await checkFxStrategy();

  // Daily report at 8am
  scheduleDaily8am(sendDailyReport);

  console.log('Agent running. Press Ctrl+C to stop.');
}

main().catch(async (e) => {
  console.error('Fatal error:', e);
  await sendTelegram(`💥 <b>Agent crashed</b>\n${e.message}`);
  process.exit(1);
});
