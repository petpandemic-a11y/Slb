// Raydium LP burn watcher → Telegram (STRICT, no-dup, young tokens)
// - WS logsSubscribe: csak "Instruction: Burn" esetén kérünk le tx-t
// - Tokenkeg: Burn + a burn mintje a Raydium accounts közt (LP mint) → csak akkor jelzünk
// - Min. LP burn % (MIN_LP_BURN_PCT), min. becsült SOL (MIN_SOL_BURN), max. token kor (MAX_TOKEN_AGE_MIN)
// - Perzisztens dedup (signature) → nincs duplikált poszt
// - TG üzenet: részletes formázás (név, ár, mcap, liq, security flagek stb.) + Token Created Time

import WebSocket from "ws";
import http from "http";
import fs from "fs";

// ===== ENV =====
const PORT = Number(process.env.PORT || 8080);
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";
const MIN_SOL_BURN = Number(process.env.MIN_SOL_BURN || 0);
const MIN_LP_BURN_PCT = Number(process.env.MIN_LP_BURN_PCT || 0.99);
const MAX_TOKEN_AGE_MIN = Number(process.env.MAX_TOKEN_AGE_MIN || 0);
const DEBUG = process.env.DEBUG === "1";
const RATE_MS = Number(process.env.RATE_MS || 1200);

// ===== Program IDs =====
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT  = "So11111111111111111111111111111111111111112";
const METAPLEX_META = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

// Gyakori quote mint-ek
const QUOTE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  WSOL_MINT,
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
]);

// ===== Logger + health =====
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dbg = (...a) => { if (DEBUG) console.log(new Date().toISOString(), "[DBG]", ...a); };

http.createServer((_, res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("ok\n");})
  .listen(PORT, ()=>log(`HTTP up on :${PORT}`));

// ===== JSON-RPC =====
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc:"2.0", id:1, method, params });
  const r = await fetch(RPC_HTTP, { method:"POST", headers:{ "content-type":"application/json" }, body });
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json(); if (j.error) throw new Error(`RPC ${method} err: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function getTransaction(signature, tries=3){
  for (let i=0;i<tries;i++){
    try{
      return await rpc("getTransaction",[signature,{encoding:"jsonParsed",maxSupportedTransactionVersion:0}]);
    }catch(e){
      log(`getTransaction fail (${i+1}/${tries}) ${signature}:`, e.message);
      if (i<tries-1) await new Promise(r=>setTimeout(r,1500*(i+1)));
    }
  }
  return null;
}

// ===== Dexscreener =====
async function fetchDexscreenerByToken(mint){
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { headers:{accept:"application/json"} });
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    if (!pairs.length) return null;
    pairs.sort((a,b)=>{
      const ra = (a?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      const rb = (b?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      if (ra!==rb) return ra-rb;
      return (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0);
    });
    const p = pairs[0];
    return {
      name:   p?.baseToken?.name   || null,
      symbol: p?.baseToken?.symbol || null,
      price:  p?.priceUsd ? Number(p.priceUsd) : null,
      liq:    p?.liquidity?.usd ? Number(p.liquidity.usd) : null,
      fdv:    p?.fdv ? Number(p.fdv) : null,
      mcap:   p?.marketCap ? Number(p.marketCap) : null,
      url:    p?.url || null,
      createdAt: p?.pairCreatedAt || null
    };
  }catch{ return null; }
}

// ===== TG üzenet összeállítása + feldolgozás =====
let comboRemoveMap = new Map();

function ago(tsMs){
  const s = Math.max(1, Math.floor((Date.now()-tsMs)/1000));
  if (s<60) return `${s}s ago`;
  const m = Math.floor(s/60); if (m<60) return `${m} minutes ago`;
  const h = Math.floor(m/60); if (h<24) return `${h} hours ago`;
  const d = Math.floor(h/24); return `${d} days ago`;
}

async function processSignature(sig){
  if (sentMap.has(sig)) return;
  const tx = await getTransaction(sig);
  if (!tx) return;

  // ... Burn + LP logika változatlan ...

  // Dexscreener a base minthez
  let dx=null; if (baseMint) dx = await fetchDexscreenerByToken(baseMint);

  const burnAgo = tx?.blockTime ? ago(tx.blockTime*1000) : "n/a";
  let createdAgo = null;
  if (dx?.createdAt) {
    createdAgo = ago(Number(dx.createdAt));
  }

  const lines = [
    `🔥 <b>${headTitle}</b> ${comboNote?`<i>${comboNote}</i>`:""}`.trim(),
    "",
    `🔥 <b>Burn Percentage:</b> ${burnPct}%`,
    `🕒 <b>Burn Time:</b> ${burnAgo}`,
    createdAgo ? `🆕 <b>Token Created:</b> ${createdAgo}` : null,
    "",
    `📊 <b>Marketcap:</b> ${mcapStr}`,
    `💧 <b>Liquidity:</b> ${liqStr}`,
    `💲 <b>Price:</b> ${priceStr}`,
    "",
    baseMint ? `🧾 <b>Token Mint:</b> <code>${baseMint}</code>` : `🧾 <b>Token Mint:</b> n/a`,
    "",
    `⚙️ <b>Security:</b>`,
    `├ Mutable Metadata: ${metaMutable===null ? "n/a" : (metaMutable ? "Yes ❌" : "No ✅")}`,
    `├ Mint Authority: ${mintAuthNone===null ? "n/a" : (mintAuthNone ? "No ✅" : "Yes ❌")}`,
    `└ Freeze Authority: ${freezeNone===null ? "n/a" : (freezeNone ? "No ✅" : "Yes ❌")}`,
    "",
    dx?.url ? dx.url : null,
    `🔗 <a href="${link}">Solscan</a>`
  ].filter(Boolean);

  sentMap.set(sig, Date.now());
  saveSent();
  await sendTelegram(lines.join("\n"));
}
