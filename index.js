// Raydium LP burn watcher (Helius WS - nem enhanced)
// - Burn log előszűrés (logsSubscribe Raydium AMM v4 + CPMM)
// - getTransaction(jsonParsed) -> inner Tokenkeg: Burn
// - LP mint + underlying mintek felismerése
// - Dexscreener market adatok (opcionális)
// - ÚJ: MIN_SOL_BURN küszöb -> csak a küszöb feletti esetek mennek ki TG-re

import WebSocket from "ws";
import http from "http";

// ==== ENV ====
const PORT = Number(process.env.PORT || 8080);
// Helius (nem enhanced):
//   RPC_HTTP = https://mainnet.helius-rpc.com/?api-key=XXXX
//   RPC_WSS  = wss://mainnet.helius-rpc.com/?api-key=XXXX
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

// Dexscreener engedélyezése (alapból ON) és SOL küszöb
const DEXS_ENABLED = process.env.DEXS_ENABLED !== "0";
const MIN_SOL_BURN = Number(process.env.MIN_SOL_BURN || 0); // pl. 0.5

// Program IDs
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT  = "So11111111111111111111111111111111111111112";

// Gyakori quote mint-ek (bővíthető)
const QUOTE_MINTS = new Set([
  // USDC
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  // USDT
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  // WSOL
  WSOL_MINT,
  // BONK (néha quote)
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
]);

// ==== logger ====
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ==== Health HTTP (Render health check) ====
http
  .createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
  })
  .listen(PORT, () => log(`HTTP up on :${PORT}`));

// ==== JSON-RPC helpers (Helius HTTP RPC) ====
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const r = await fetch(RPC_HTTP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function getParsedAccountInfo(pubkey) {
  return rpc("getParsedAccountInfo", [ pubkey, { commitment:"confirmed" } ]);
}
async function getTokenLargestAccounts(mint) {
  return rpc("getTokenLargestAccounts", [ mint, { commitment:"confirmed" } ]);
}
async function getTransaction(signature, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await rpc("getTransaction", [ signature, { encoding:"jsonParsed", maxSupportedTransactionVersion:0 } ]);
    } catch (e) {
      log(`getTransaction fail (${i+1}/${tries}):`, e.message);
      if (i < tries - 1) await new Promise(r=>setTimeout(r, 1500*(i+1)));
    }
  }
  return null;
}

// ==== Dexscreener helper ====
async function fetchDexsByToken(mint) {
  if (!DEXS_ENABLED) return null;
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const r = await fetch(url, { headers: { "accept": "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    pairs.sort((a,b) => {
      const ra = (a?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      const rb = (b?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      if (ra!==rb) return ra-rb;
      const la = a?.liquidity?.usd || 0;
      const lb = b?.liquidity?.usd || 0;
      return lb - la;
    });
    const p = pairs[0];
    if (!p) return null;
    return {
      tokenSymbol: p.baseToken?.symbol || p.baseToken?.address?.slice(0,4)+"…",
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      liquidityUsd: p.liquidity?.usd ? Number(p.liquidity.usd) : null,
      fdv: p.fdv ? Number(p.fdv) : null,
      mcap: p.marketCap ? Number(p.marketCap) : null,
      dex: p.dexId || "",
      pairUrl: p.url || ""
    };
  } catch { return null; }
}

// ==== Telegram (queue + throttle) ====
const tgQueue = []; let tgSending = false;
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  tgQueue.push(text); if (tgSending) return; tgSending = true;
  while (tgQueue.length) {
    const msg = tgQueue.shift();
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method:"POST", headers:{ "content-type":"application/json" },
        body: JSON.stringify({ chat_id:TG_CHAT_ID, text:msg, parse_mode:"HTML", disable_web_page_preview:false })
      });
      if (r.status === 429) {
        let wait = 3000;
        try { const jr = await r.json(); if (jr?.parameters?.retry_after) wait = jr.parameters.retry_after*1000; } catch {}
        await new Promise(res=>setTimeout(res, wait)); tgQueue.unshift(msg);
      } else {
        await new Promise(res=>setTimeout(res, 1200)); // ~1 msg / 1.2s
      }
    } catch (e) { log("TG error:", e.message); await new Promise(res=>setTimeout(res, 2000)); }
  }
  tgSending = false;
}

// ==== Rate limiter a getTransaction-re (max ~1/sec) ====
const sigQueue = []; const seenSig = new Set(); let workerRunning = false;
async function enqueueSignature(sig) {
  if (seenSig.has(sig)) return; seenSig.add(sig); sigQueue.push(sig);
  if (!workerRunning) {
    workerRunning = true;
    while (sigQueue.length) {
      const s = sigQueue.shift();
      await processSignature(s);
      await new Promise(r=>setTimeout(r, 1000)); // 1 tx / sec
    }
    workerRunning = false;
  }
}

// ==== utils ====
function ago(tsMs) {
  const s = Math.max(1, Math.floor((Date.now() - tsMs)/1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s/60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h/24); return `${d}d ago`;
}

// cache-ok parsed account infóra
const parsedCache = new Map();
async function getParsedCached(pubkey) {
  if (parsedCache.has(pubkey)) return parsedCache.get(pubkey);
  try {
    const info = await getParsedAccountInfo(pubkey);
    parsedCache.set(pubkey, info);
    return info;
  } catch (e) {
    parsedCache.set(pubkey, null);
    return null;
  }
}
async function isMintAccount(pubkey) {
  const info = await getParsedCached(pubkey);
  const d = info?.value?.data?.parsed;
  return d?.type === "mint" ? d : null;
}
async function tokenAccountInfo(pubkey) {
  const info = await getParsedCached(pubkey);
  const d = info?.value?.data?.parsed;
  return d?.type === "account" ? d?.info : null;
}

// ==== fő feldolgozás ====
async function processSignature(sig) {
  const tx = await getTransaction(sig);
  if (!tx) return;

  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap(x => x?.instructions || []);
  const all = [...top, ...inner];

  // Gyűjtsük a Raydium-instrukciók accountjait (LP és vaultok is itt vannak)
  const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM]);
  const rayAccounts = new Set();
  for (const ix of all) {
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid && rayPrograms.has(pid)) {
      const accs = (ix?.accounts || []).map(a => typeof a === "string" ? a : (a?.pubkey || a?.toString?.())).filter(Boolean);
      for (const a of accs) rayAccounts.add(a);
    }
  }

  // SPL Token: Burn + mint in rayAccounts -> LP burn
  let lpMint = null, burnAmount = 0;
  for (const ix of all) {
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid !== TOKENKEG) continue;
    const isBurn = ix?.parsed?.type === "burn" || ix?.instructionName === "Burn";
    if (!isBurn) continue;
    const mint = ix?.parsed?.info?.mint || ix?.mint;
    if (mint && rayAccounts.has(mint)) {
      lpMint = mint;
      burnAmount = Number(ix?.parsed?.info?.amount || ix?.amount || 0);
      break;
    }
  }
  if (!lpMint) return; // nem Raydium LP burn

  const blockTimeMs = tx?.blockTime ? tx.blockTime * 1000 : Date.now();

  // Mint info (LP supply + authorities + decimals)
  let supplyPost = 0, mintAuthNone = null, freezeNone = null, lpDecimals = 0;
  try {
    const info = await getParsedCached(lpMint);
    const d = info?.value?.data?.parsed?.info;
    if (d?.supply) supplyPost = Number(d.supply);
    if (d?.decimals != null) lpDecimals = Number(d.decimals) || 0;
    mintAuthNone = (d?.mintAuthority === null || d?.mintAuthority === undefined);
    freezeNone   = (d?.freezeAuthority === null || d?.freezeAuthority === undefined);
  } catch (e) { log("mint info err:", e.message); }
  const supplyPre = supplyPost + burnAmount;
  const share = supplyPre > 0 ? (burnAmount / supplyPre) : 0;

  // --- WSOL tartalék megkeresése a Raydium accountok közt ---
  // TokenAccount típusokat nézzük: amelyiknek mint == WSOL_MINT, onnan kiolvassuk a tokenAmount.amount-ot (raw)
  let wsolVaultAmountRaw = 0, wsolDecimals = 9;
  const MAX_CHECK = 25; let checked = 0;
  for (const a of rayAccounts) {
    if (checked >= MAX_CHECK) break;
    checked++;
    const acc = await tokenAccountInfo(a);
    if (!acc) continue;
    if (acc?.mint === WSOL_MINT) {
      const ta = acc?.tokenAmount;
      if (ta?.amount) wsolVaultAmountRaw = Number(ta.amount);
      if (ta?.decimals != null) wsolDecimals = Number(ta.decimals) || 9;
      break;
    }
  }
  const wsolVaultSOL = wsolVaultAmountRaw / Math.pow(10, wsolDecimals);
  const estSolOut = share * wsolVaultSOL; // a remove-liquidity SOL része (becslés)

  // ---- KÜSZÖB: ha a becsült SOL kisebb, nem küldünk értesítést ----
  if (MIN_SOL_BURN > 0 && estSolOut < MIN_SOL_BURN) {
    log(`skip (SOL < min): est ${estSolOut.toFixed(4)} SOL < ${MIN_SOL_BURN}`);
    return;
  }

  // --- Underlying token mint(ek) felismerése (Dexs-hez) ---
  const candidateMints = [];
  let uChecked = 0;
  for (const a of rayAccounts) {
    if (a === lpMint) continue;
    if (uChecked >= MAX_CHECK) break;
    uChecked++;
    const mintParsed = await isMintAccount(a);
    if (mintParsed) candidateMints.push(a);
    if (candidateMints.length >= 3) break;
  }
  const underlying = candidateMints.filter(m => m !== lpMint);
  let baseMint = null, quoteMint = null;
  if (underlying.length >= 2) {
    const [m1, m2] = underlying.slice(0,2);
    if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) { quoteMint = m1; baseMint = m2; }
    else if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) { quoteMint = m2; baseMint = m1; }
    else { baseMint = m1; quoteMint = m2; }
  }

  // Dexscreener adat (ha van baseMint)
  let dexs = null;
  if (DEXS_ENABLED && baseMint) {
    dexs = await fetchDexsByToken(baseMint);
  }

  // Top holders (LP mint)
  let holdersLines = [];
  try {
    const largest = await getTokenLargestAccounts(lpMint);
    const arr = Array.isArray(largest?.value) ? largest.value.slice(0, 3) : [];
    holdersLines = arr.map((x) => {
      const addr = x?.address || "";
      const amt  = Number(x?.amount || 0);
      const pct  = supplyPost > 0 ? ((amt / supplyPost) * 100) : 0;
      const short = addr ? `${addr.slice(0,4)}…${addr.slice(-4)}` : "–";
      return `├ ${short} | ${amt.toLocaleString()} | ${pct.toFixed(2)}%`;
    });
  } catch (e) { log("largest holders err:", e.message); }

  // Üzenet (kártya)
  const header     = "🔥 <b>Raydium LP Burn</b>";
  const whenLine   = `🕒 <b>Time:</b> ${new Date(blockTimeMs).toISOString()}  (${ago(blockTimeMs)})`;
  const burnPct    = supplyPre > 0 ? (share * 100) : 0;
  const burnLine   = `🔥 <b>Burn %:</b> ${burnPct.toFixed(2)}%`;
  const amountLP   = burnAmount / Math.pow(10, lpDecimals || 0);
  const amountLine = `💧 <b>Amount (LP):</b> ${amountLP.toLocaleString()}`;
  const solLine    = `🟡 <b>Est. SOL from LP:</b> ${estSolOut.toFixed(4)} SOL`;
  const lpLine     = `🧾 <b>LP Mint:</b> <code>${lpMint}</code>`;
  const pairLine   = baseMint
    ? `🔀 <b>Pair:</b> <code>${baseMint}</code> / ${quoteMint ? `<code>${quoteMint}</code>` : "?"}`
    : `🔀 <b>Pair:</b> n/a`;

  const secLines = [
    "🌐 <b>Security (LP):</b>",
    `├ Mint Authority: ${mintAuthNone === null ? "n/a" : (mintAuthNone ? "No ✅" : "Yes ❌")}`,
    `└ Freeze Authority: ${freezeNone === null ? "n/a" : (freezeNone ? "No ✅" : "Yes ❌")}`
  ];

  const holdersTitle = "👥 <b>Top Holders (LP):</b>";
  const holdersBlock = holdersLines.length ? holdersLines.join("\n") : "├ n/a";

  const priceBlock = dexs ? [
    "",
    "💹 <b>Market</b>",
    `├ Price: ${dexs.priceUsd != null ? `$${dexs.priceUsd}` : "n/a"}`,
    `├ Liquidity: ${dexs.liquidityUsd != null ? `$${dexs.liquidityUsd.toLocaleString()}` : "n/a"}`,
    `└ FDV/MC: ${dexs.fdv != null ? `$${dexs.fdv.toLocaleString()}` : (dexs.mcap != null ? `$${dexs.mcap.toLocaleString()}` : "n/a")}  (${dexs.dex || ""})`,
    dexs.pairUrl ? `${dexs.pairUrl}` : ""
  ] : [];

  const sigLine = `🔗 <a href="https://solscan.io/tx/${sig}">Solscan</a>`;

  const msg = [
    header,
    burnLine,
    whenLine,
    amountLine,
    solLine,
    lpLine,
    pairLine,
    "",
    ...secLines,
    "",
    holdersTitle,
    holdersBlock,
    ...priceBlock,
    "",
    sigLine
  ].join("\n");

  log(msg.replace(/<[^>]+>/g, ""));
  await sendTelegram(msg);
}

// ==== WebSocket (Helius WSS - nem enhanced) ====
let ws;
function wsSend(obj){ if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function subscribeLogs(programId, id){
  const msg = { jsonrpc:"2.0", id, method:"logsSubscribe", params:[ { mentions:[programId] }, { commitment:"confirmed" } ] };
  wsSend(msg);
}
function connectWS(){
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);
  ws.onopen = () => { log("WS open"); subscribeLogs(RAY_AMM_V4,1001); subscribeLogs(RAY_CPMM,1002); };
  ws.onmessage = async (ev) => {
    try {
      const data = JSON.parse(ev.data.toString());
      const res = data?.params?.result;
      const sig = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      if (!sig || logsArr.length === 0) return;

      // csak ha tényleg Burn log szerepel
      const hasBurnLog = logsArr.some(l => typeof l === "string" && /Instruction:\s*Burn/i.test(l));
      if (!hasBurnLog) return;

      await enqueueSignature(sig);
    } catch (e) { log("WS msg err:", e.message); }
  };
  ws.onclose  = () => { log("WS closed, reconnecting in 3s…"); setTimeout(connectWS, 3000); };
  ws.onerror  = (e) => { log("WS error:", e?.message || String(e)); };
}
connectWS();
