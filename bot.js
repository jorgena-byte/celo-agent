'use strict';
const { ethers } = require('ethers');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  CELO_RPC:            'https://forno.celo.org',
  EXECUTOR_PRIVATE_KEY:'ca156e18ebcd6709f5dd50dd041b7b96cf8e5a437a41598a7c333f20da5016ca',
  EXECUTOR_ADDRESS:    '0xd896f9b50a80f20040e579a551e3ccbf326d6810',
  TELEGRAM_TOKEN:      '8751112209:AAF600GfxRQtVzyOMYr6A8sthVyMWEGxljc',
  TELEGRAM_CHAT_ID:    '2113323141',
  UNISWAP_ROUTER:      '0x5615CDAB10dC425A742D643D949a7f474c01Abc2',
  GITHUB_REPO:         'jorgena-byte/celo-agent',

  TRADE_SIZE_USD:      100,
  MIN_SPREAD_PCT:      0.5,
  MAX_SPREAD_PCT:      10,
  TRADE_COOLDOWN_MS:   30 * 60 * 1000,
  CHECK_INTERVAL_MS:   5 * 60 * 1000,
  DAILY_REPORT_HOUR:   8,
};

// ─── TOKENS ──────────────────────────────────────────────────────────────────
const TOKENS = {
  cUSD:  { address: '0x765de816845861e75a25fca122bb6898b8b1282a', decimals: 18 },
  cEUR:  { address: '0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73', decimals: 18 },
  cREAL: { address: '0xe8537a3d056da446677b9e9d6c5db704eaab4787', decimals: 18 },
};

// ─── STATE ───────────────────────────────────────────────────────────────────
const lastTrade = {};
let tradeLog = [];
let lastReportDate = '';

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function telegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

async function getCeloPrice() {
  const res = await fetch('https://api.geckoterminal.com/api/v2/networks/celo/tokens/0x471ece3750da237f93b8e339c536989b8978a438');
  const data = await res.json();
  return parseFloat(data.data.attributes.price_usd);
}

async function getTokenPrice(symbol) {
  const addr = TOKENS[symbol].address.toLowerCase();
  const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/celo/tokens/${addr}`);
  const data = await res.json();
  return parseFloat(data.data.attributes.price_usd);
}

async function getRealFxRates() {
  const res = await fetch('https://api.frankfurter.app/latest?from=USD');
  const data = await res.json();
  return {
    EURUSD: 1 / data.rates.EUR,
    BRLUSD: 1 / data.rates.BRL,
  };
}

async function getBalance(symbol) {
  const provider = new ethers.providers.JsonRpcProvider(CONFIG.CELO_RPC);
  const token = TOKENS[symbol];
  const contract = new ethers.Contract(token.address, ['function balanceOf(address) view returns (uint256)'], provider);
  const bal = await contract.balanceOf(CONFIG.EXECUTOR_ADDRESS);
  return parseFloat(ethers.utils.formatUnits(bal, token.decimals));
}

async function pushTradesToGitHub() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;
  try {
    const content = Buffer.from(JSON.stringify(tradeLog, null, 2)).toString('base64');
    const getRes = await fetch(`https://api.github.com/repos/${CONFIG.GITHUB_REPO}/contents/trades.json`, {
      headers: { Authorization: `token ${token}` }
    });
    const getData = await getRes.json();
    await fetch(`https://api.github.com/repos/${CONFIG.GITHUB_REPO}/contents/trades.json`, {
      method: 'PUT',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'update trades', content, sha: getData.sha }),
    });
    console.log('Trades pushed to GitHub');
  } catch (e) { console.error('GitHub push error:', e.message); }
}

// ─── SWAP ─────────────────────────────────────────────────────────────────────
async function swap(fromSymbol, toSymbol, amountUSD) {
  console.log(`Swapping ${amountUSD} ${fromSymbol} → ${toSymbol}`);
  const provider = new ethers.providers.JsonRpcProvider(CONFIG.CELO_RPC);
  const wallet = new ethers.Wallet(CONFIG.EXECUTOR_PRIVATE_KEY, provider);
  const fromToken = TOKENS[fromSymbol];
  const toToken   = TOKENS[toSymbol];

  const erc20 = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function allowance(address,address) view returns (uint256)',
  ];
  const fromContract = new ethers.Contract(fromToken.address, erc20, wallet);
  const amountIn = ethers.utils.parseUnits(amountUSD.toString(), fromToken.decimals);

  const balance = await fromContract.balanceOf(wallet.address);
  if (balance.lt(amountIn)) {
    throw new Error(`Insufficient ${fromSymbol}: have ${ethers.utils.formatUnits(balance, fromToken.decimals)}, need ${amountUSD}`);
  }

  const allowance = await fromContract.allowance(wallet.address, CONFIG.UNISWAP_ROUTER);
  if (allowance.lt(amountIn)) {
    const tx = await fromContract.approve(CONFIG.UNISWAP_ROUTER, ethers.constants.MaxUint256);
    await tx.wait();
    console.log('Approved');
  }

  const router = new ethers.Contract(CONFIG.UNISWAP_ROUTER, [
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)'
  ], wallet);

  const tx = await router.exactInputSingle({
    tokenIn:           fromToken.address,
    tokenOut:          toToken.address,
    fee:               3000,
    recipient:         wallet.address,
    deadline:          Math.floor(Date.now() / 1000) + 300,
    amountIn,
    amountOutMinimum:  0,
    sqrtPriceLimitX96: 0,
  });
  await tx.wait();
  console.log('Swap confirmed:', tx.hash);
  return tx.hash;
}

// ─── FX STRATEGY ─────────────────────────────────────────────────────────────
const FX_PAIRS = [
  { name: 'EURUSD', symbol: 'cEUR',  rateKey: 'EURUSD' },
  { name: 'BRLUSD', symbol: 'cREAL', rateKey: 'BRLUSD' },
];

async function checkFx() {
  let fxRates, celoPrice;
  try {
    [fxRates, celoPrice] = await Promise.all([getRealFxRates(), getCeloPrice()]);
  } catch (e) {
    console.error('Price fetch error:', e.message);
    return;
  }

  for (const pair of FX_PAIRS) {
    try {
      const onchainPrice = await getTokenPrice(pair.symbol);
      const realRate     = fxRates[pair.rateKey];
      const spread = ((onchainPrice - realRate) / realRate) * 100;
      const absSpread = Math.abs(spread);

      console.log(`FX ${pair.name}: onchain=$${onchainPrice.toFixed(5)} real=$${realRate.toFixed(5)} spread=${spread.toFixed(3)}%`);

      if (absSpread < CONFIG.MIN_SPREAD_PCT || absSpread > CONFIG.MAX_SPREAD_PCT) continue;

      const now = Date.now();
      if (lastTrade[pair.name] && now - lastTrade[pair.name] < CONFIG.TRADE_COOLDOWN_MS) {
        console.log(`${pair.name} on cooldown`);
        continue;
      }

      let fromSym, toSym;
      if (spread < 0) {
        fromSym = 'cUSD';
        toSym   = pair.symbol;
        const cusdBal = await getBalance('cUSD');
        if (cusdBal < CONFIG.TRADE_SIZE_USD) { console.log(`Low cUSD: ${cusdBal.toFixed(2)}`); continue; }
      } else {
        fromSym = pair.symbol;
        toSym   = 'cUSD';
        const bal = await getBalance(pair.symbol);
        if (bal < CONFIG.TRADE_SIZE_USD) { console.log(`Low ${pair.symbol}: ${bal.toFixed(2)}`); continue; }
      }

      await telegram(`💱 <b>FX TRADE</b>\n${CONFIG.TRADE_SIZE_USD} ${fromSym} → ${toSym}\nSpread: ${spread.toFixed(3)}%`);
      const hash = await swap(fromSym, toSym, CONFIG.TRADE_SIZE_USD);
      lastTrade[pair.name] = now;

      tradeLog.unshift({ pair: `${fromSym} → ${toSym}`, amount: CONFIG.TRADE_SIZE_USD, spread: spread.toFixed(3), hash, timestamp: new Date().toISOString() });
      if (tradeLog.length > 500) tradeLog = tradeLog.slice(0, 500);
      fs.writeFileSync('/root/trading-bot/trades.json', JSON.stringify(tradeLog, null, 2));

      await telegram(`✅ <b>CONFIRMED</b>\n${CONFIG.TRADE_SIZE_USD} ${fromSym} → ${toSym}\n🔗 <a href="https://celoscan.io/tx/${hash}">CeloScan</a>`);
      await pushTradesToGitHub();

    } catch (e) {
      console.error(`FX error (${pair.name}):`, e.message);
      await telegram(`❌ Trade failed (${pair.name}): ${e.message}`);
    }
  }
}

// ─── DAILY REPORT ────────────────────────────────────────────────────────────
async function dailyReport() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toDateString();

  const yTrades = tradeLog.filter(t => new Date(t.timestamp).toDateString() === dateStr);
  const yVolume = yTrades.reduce((s, t) => s + t.amount, 0);
  const allVolume = tradeLog.reduce((s, t) => s + t.amount, 0);

  let celoPrice = 0, cusdBal = 0, ceurBal = 0, crealBal = 0;
  try { celoPrice = await getCeloPrice(); } catch (e) {}
  try { cusdBal  = await getBalance('cUSD');  } catch (e) {}
  try { ceurBal  = await getBalance('cEUR');  } catch (e) {}
  try { crealBal = await getBalance('cREAL'); } catch (e) {}

  const tradeLines = yTrades.length > 0
    ? yTrades.map(t => `• ${new Date(t.timestamp).toTimeString().slice(0,5)} — ${t.pair} (${t.spread}% spread)`).join('\n')
    : '• No trades yesterday';

  await telegram(`📊 <b>Daily Report — JA's Trading PA</b>
📅 ${dateStr}
⏰ Generated at 08:00 CET

<b>— Yesterday —</b>
🔄 Trades: ${yTrades.length}
💰 Volume: $${yVolume.toFixed(2)}
💵 Capital per trade: $${CONFIG.TRADE_SIZE_USD}

<b>Trade Log:</b>
${tradeLines}

<b>— All Time —</b>
🔄 Total trades: ${tradeLog.length}
💰 Total volume: $${allVolume.toFixed(2)}

<b>— Balances —</b>
💵 cUSD: ${cusdBal.toFixed(2)}
🇪🇺 cEUR: ${ceurBal.toFixed(2)}
🇧🇷 cREAL: ${crealBal.toFixed(2)}
💎 CELO: $${celoPrice.toFixed(4)}

👛 <a href="https://celoscan.io/address/${CONFIG.EXECUTOR_ADDRESS}">CeloScan</a>`);
}

// ─── HTTP API ─────────────────────────────────────────────────────────────────
const http = require('http');
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(tradeLog));
}).listen(3001, () => console.log('Trade API running on port 3001'));

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('JA Trading Agent starting...');
  try {
    if (fs.existsSync('/root/trading-bot/trades.json')) {
      tradeLog = JSON.parse(fs.readFileSync('/root/trading-bot/trades.json', 'utf8'));
      console.log(`Loaded ${tradeLog.length} existing trades`);
    }
  } catch (e) { console.error('Could not load trades:', e.message); }

  await telegram('🤖 <b>JA Trading Agent started</b>\nMonitoring cEUR and cREAL FX pairs.');
  await tick();
  setInterval(tick, CONFIG.CHECK_INTERVAL_MS);
  console.log('Agent running. Press Ctrl+C to stop.');
}

async function tick() {
  const now = new Date();
  const cetHour = (now.getUTCHours() + 1) % 24;
  const today = now.toDateString();
  if (cetHour === CONFIG.DAILY_REPORT_HOUR && today !== lastReportDate) {
    lastReportDate = today;
    await dailyReport();
  }
  await checkFx();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
