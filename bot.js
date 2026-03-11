const { ethers } = require('ethers');
const fs = require('fs');
const http = require('http');

// Simple HTTP server to serve trades.json to the dashboard
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/trades') {
    try {
      const trades = fs.existsSync('/root/trading-bot/trades.json')
        ? fs.readFileSync('/root/trading-bot/trades.json', 'utf8')
        : '[]';
      res.end(trades);
    } catch(e) { res.end('[]'); }
  } else {
    res.end(JSON.stringify({ status: 'JA Trading Agent running' }));
  }
}).listen(3001, () => console.log('Trade API running on port 3001'));
const fetch = require('node-fetch');

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  CELO_RPC: 'https://forno.celo.org',
  SAFE_ADDRESS: '0xa7b0cead940056cc9afe8034f1cc507a048be8cf',
  EXECUTOR_PRIVATE_KEY: 'ca156e18ebcd6709f5dd50dd041b7b96cf8e5a437a41598a7c333f20da5016ca',
  EXECUTOR_ADDRESS: '0xd896f9b50a80f20040e579a551e3ccbf326d6810',
  TELEGRAM_TOKEN: '8751112209:AAF600GfxRQtVzyOMYr6A8sthVyMWEGxljc',
  TELEGRAM_CHAT_ID: '2113323141',
  UNISWAP_ROUTER: '0x5615CDAB10dC425A742D643D949a7f474c01Abc2',

  // CELO strategy
  BUY_DROP_PCT: 5,
  SELL_RISE_PCT: 10,
  STOP_LOSS_PCT: 15,
  TRADE_SIZE_USD: 5,
  SELL_PORTION: 0.4,
  CHECK_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes

  // FX strategy
  FX_MIN_SPREAD_PCT: 0.5,
  FX_TRADE_SIZE_USD: 100,
};

const TOKENS = {
  CELO:  { address: '0x471ece3750da237f93b8e339c536989b8978a438', decimals: 18 }, // CELO is ERC20 on Celo network
  cUSD:  { address: '0x765de816845861e75a25fca122bb6898b8b1282a', decimals: 18 },
  cEUR:  { address: '0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73', decimals: 18 },
  cREAL: { address: '0xe8537a3d056da446677b9e9d6c5db704eaab4787', decimals: 18 },
  USDT:  { address: '0x617f3112bf5397d0467d315cc709ef968d9ba546', decimals: 6  },
  USDC:  { address: '0xef4229c8c3250c675f21bcefa42f58efbff6002a', decimals: 6  },
  cKES:  { address: '0x456a3d042c0dbd3db53d5489e98dfb038553b0d0', decimals: 18 },
  cZAR:  { address: '0x4c35853a3b4e647fd266f4de678dcc8fec410bf6', decimals: 18 },
  cGHS:  { address: '0xfaea5f3404bba20d3cc2f8c4b0a888f55a3c7313', decimals: 18 },
  cNGN:  { address: '0xe2702bd97ee33c88c8f6f92da3b733608aa76f71', decimals: 18 },
  cCOP:  { address: '0x8a567e2ae79ca692bd748ab832081c45de4041ea', decimals: 18 },
  cGBP:  { address: '0xccf663b1ff11028f0b19058d0f7b674004a40746', decimals: 18 },
  WCELO: { address: '0x471ece3750da237f93b8e339c536989b8978a438', decimals: 18 }, // CELO is its own ERC20
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
      GBPUSD: 1 / data.rates.GBP,
      KESUSD: 1 / data.rates.KES,
      ZARUSD: 1 / data.rates.ZAR,
      NGNUSD: 1 / data.rates.NGN,
      COPUSD: 1 / data.rates.COP,
      GHSUSD: 1 / data.rates.GHS,
    };
  } catch(e) {
    return {
      EURUSD: 1.08, BRLUSD: 0.19, GBPUSD: 1.27,
      KESUSD: 0.0077, ZARUSD: 0.054, NGNUSD: 0.00065,
      COPUSD: 0.00024, GHSUSD: 0.067,
    };
  }
}

// ============================================================
// SAFE EXECUTION
// ============================================================
async function executeSafeSwap(fromSymbol, toSymbol, amount, extraSpread = 0) {
  console.log(`Executing swap: ${amount} ${fromSymbol} → ${toSymbol}`);

  const fromToken = TOKENS[fromSymbol];
  const toToken   = TOKENS[toSymbol];
  if (!fromToken || !toToken) throw new Error(`Unknown token: ${fromSymbol} or ${toSymbol}`);

  const provider = new ethers.providers.JsonRpcProvider(CONFIG.CELO_RPC);
  const wallet   = new ethers.Wallet(CONFIG.EXECUTOR_PRIVATE_KEY, provider);

  const erc20Abi = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function allowance(address,address) view returns (uint256)'
  ];

  const fromContract = new ethers.Contract(fromToken.address, erc20Abi, wallet);

  // Check balance
  const balance = await fromContract.balanceOf(wallet.address);
  const amountIn = ethers.utils.parseUnits(amount.toString(), fromToken.decimals);

  if (balance.lt(amountIn)) {
    throw new Error(`Insufficient ${fromSymbol} balance: have ${ethers.utils.formatUnits(balance, fromToken.decimals)}, need ${amount}`);
  }

  const routerAddress = CONFIG.UNISWAP_ROUTER;
  const routerAbi = [
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256)'
  ];
  const router = new ethers.Contract(routerAddress, routerAbi, wallet);

  // Approve
  const allowance = await fromContract.allowance(wallet.address, routerAddress);
  if (allowance.lt(amountIn)) {
    const approveTx = await fromContract.approve(routerAddress, ethers.constants.MaxUint256);
    await approveTx.wait();
    console.log('Approval confirmed:', approveTx.hash);
  }

  // Swap
  const params = {
    tokenIn:  fromToken.address,
    tokenOut: toToken.address,
    fee: 3000,
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 300,
    amountIn,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0
  };

  const swapTx = await router.exactInputSingle(params);
  await swapTx.wait();
  console.log('Swap confirmed:', swapTx.hash);

  await sendTelegram(`✅ <b>AUTO TRADE EXECUTED</b>\n\n🔄 ${amount} ${fromSymbol} → ${toSymbol}\n👛 Executor wallet\n🔗 <a href="https://celoscan.io/tx/${swapTx.hash}">View on CeloScan</a>`);

  // Log trade to file AND push to GitHub
  const trade = { pair: `${fromSymbol} → ${toSymbol}`, amount, hash: swapTx.hash, timestamp: new Date().toISOString(), status: 'success' };
  try {
    let trades = [];
    if (fs.existsSync('/root/trading-bot/trades.json')) {
      trades = JSON.parse(fs.readFileSync('/root/trading-bot/trades.json', 'utf8'));
    }
    trades.unshift(trade);
    const tradesJson = JSON.stringify(trades.slice(0, 200));
    fs.writeFileSync('/root/trading-bot/trades.json', tradesJson);
    // Push to GitHub so dashboard can read it over HTTPS
    await pushTradesToGitHub(tradesJson);
  } catch(e) { console.error('Trade log error:', e.message); }

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

  // Check executor CELO balance
  const provider = new ethers.providers.JsonRpcProvider(CONFIG.CELO_RPC);
  const wallet = new ethers.Wallet(CONFIG.EXECUTOR_PRIVATE_KEY, provider);
  const celoBalance = await provider.getBalance(wallet.address);
  const celoBalanceNum = parseFloat(ethers.utils.formatEther(celoBalance));

  if (celoBalanceNum < 2) {
    console.log(`Low CELO balance: ${celoBalanceNum.toFixed(2)} CELO — skipping FX trades`);
    return;
  }

  // Use CELO price to determine trade size in CELO
  const celoPrice = await fetchCeloPrice();
  const tradeUSD = CONFIG.FX_TRADE_SIZE_USD;
  const tradeCELO = (tradeUSD / celoPrice).toFixed(2);

  const pairs = [
    { name: 'EURUSD', stableSym: 'cEUR',  realRate: fxRates.EURUSD },
    { name: 'BRLUSD', stableSym: 'cREAL', realRate: fxRates.BRLUSD },
    { name: 'GBPUSD', stableSym: 'cGBP',  realRate: fxRates.GBPUSD },
    { name: 'KESUSD', stableSym: 'cKES',  realRate: fxRates.KESUSD },
    { name: 'ZARUSD', stableSym: 'cZAR',  realRate: fxRates.ZARUSD },
    { name: 'NGNUSD', stableSym: 'cNGN',  realRate: fxRates.NGNUSD },
    { name: 'COPUSD', stableSym: 'cCOP',  realRate: fxRates.COPUSD },
    { name: 'GHSUSD', stableSym: 'cGHS',  realRate: fxRates.GHSUSD },
  ];

  for (const pair of pairs) {
    const stablePrice = await fetchTokenPrice(pair.stableSym);
    if (!stablePrice) continue;

    // onchain rate: how many stablecoins per 1 USD (via CELO)
    const onchainRate = stablePrice / celoPrice * pair.realRate;
    const spread = ((onchainRate - 1) / 1) * 100;
    const absSpread = Math.abs(spread);

    console.log(`FX ${pair.name}: spread=${spread.toFixed(3)}%`);

    if (absSpread >= CONFIG.FX_MIN_SPREAD_PCT) {
      const now = Date.now();
      if (lastFxTrade[pair.name] && now - lastFxTrade[pair.name] < 30 * 60 * 1000) continue;
      lastFxTrade[pair.name] = now;

      // Buy the stable that is cheap (relative to real FX rate)
      const action = spread < 0 ? `BUY ${pair.stableSym} with ${tradeCELO} CELO` : `SELL ${pair.stableSym} for CELO`;

      await sendTelegram(`💱 <b>FX OPPORTUNITY</b>\nPair: ${pair.stableSym}/cUSD\nSpread: ${absSpread.toFixed(3)}%\nAction: ${spread < 0 ? 'BUY ' + pair.stableSym + ' with cUSD' : 'SELL ' + pair.stableSym + ' for cUSD'}`);

      try {
        const erc20 = ['function balanceOf(address) view returns (uint256)'];
        const cusdContract = new ethers.Contract(TOKENS['cUSD'].address, erc20, provider);
        const cusdBal = await cusdContract.balanceOf(wallet.address);
        const cusdBalNum = parseFloat(ethers.utils.formatUnits(cusdBal, 18));

        if (spread < 0) {
          // Stable is cheap vs real FX — buy it with cUSD
          if (cusdBalNum >= tradeUSD) {
            await executeSafeSwap('cUSD', pair.stableSym, tradeUSD);
          } else {
            console.log(`Low cUSD balance: ${cusdBalNum.toFixed(2)} — skipping`);
          }
        } else {
          // Stable is expensive vs real FX — sell it back to cUSD
          const stableToken = TOKENS[pair.stableSym];
          if (!stableToken) continue;
          const stableContract = new ethers.Contract(stableToken.address, erc20, provider);
          const bal = await stableContract.balanceOf(wallet.address);
          const balNum = parseFloat(ethers.utils.formatUnits(bal, stableToken.decimals));
          if (balNum >= tradeUSD) {
            await executeSafeSwap(pair.stableSym, 'cUSD', tradeUSD);
          }
        }
        totalFxYield += (tradeUSD * absSpread) / 100;
      } catch(e) {
        await sendTelegram(`❌ FX trade failed: ${e.message}`);
      }
    }
  }
}


// ============================================================
// DAILY REPORT
// ============================================================
async function pushTradesToGitHub(tradesJson) {
  try {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
    if (!GITHUB_TOKEN) return;
    const encoded = Buffer.from(tradesJson).toString('base64');
    // Get current file SHA
    const getRes = await fetch('https://api.github.com/repos/jorgena-byte/celo-agent/contents/trades.json', {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    const getData = await getRes.json();
    const sha = getData.sha;
    // Update file
    await fetch('https://api.github.com/repos/jorgena-byte/celo-agent/contents/trades.json', {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'update trades', content: encoded, sha })
    });
    console.log('Trades pushed to GitHub');
  } catch(e) { console.error('GitHub push error:', e.message); }
}

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
    report += `💵 Capital per trade: $${CONFIG.FX_TRADE_SIZE_USD}\n`;
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
  report += `👛 Executor: ${CONFIG.EXECUTOR_ADDRESS}\n`;
  report += `🔗 CeloScan: https://celoscan.io/address/${CONFIG.EXECUTOR_ADDRESS}`;

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
