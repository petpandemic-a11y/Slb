// Raydium LP burn watcher (Helius WS - nem enhanced, kreditkímélő + MIN_SOL_BURN + Dexscreener info)
// WS: logsSubscribe Raydium AMM v4 + CPMM -> signature + LOGS
//   -> csak akkor kérünk le tx-t, ha a LOG-okban tényleg "Instruction: Burn" van
// HTTP RPC: getTransaction(jsonParsed) -> inner Tokenkeg: Burn
// Jelzés: ha a Burn mint szerepel bármely Raydium-instrukció accounts közt (LP mint match)
// + MIN_SOL_BURN: becsült kivett SOL ez alatt -> SKIP
// + Dexscreener: ha sikerül base mintet találni, név/ár/likviditás/FDV

import WebSocket from "ws";
import http from "http";

// ==== ENV ====
const PORT = Number(process.env.PORT || 8080);
// Helius:
//   RPC_HTTP = https://mainnet.helius-rpc.com/?api-key=XXXX
//   RPC_WSS  = wss://mainnet.helius-rpc.com/?api-key=XXXX
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

// MIN SOL küszöb (pl. 0.5) – 0 vagy hiányzik: nincs szűrés
const MIN_SOL_BURN = Number(process.env.MIN_SOL_BURN || 0);

// Program IDs
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT  = "So11111111111111111111111111111111111111112";

// Gyakoribb quote mint-ek
const QUOTE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  WSOL_MINT,
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"  // BONK (néha quote)
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

async function getTransaction(signature, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await rpc("getTransaction", [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
      ]);
    } catch (e) {
      log(`getTransaction fail (${i + 1}/${tries}):`, e.message);
      if (i < tries - 1) {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1))); // backoff
      } else {
        return null;
      }
    }
  }
}

// ---- Parsed account info (cache-elve), kell a WSOL-vault és LP supply-hoz ----
async function getParsedAccountInfo(pubkey) {
  return rpc("getParsedAccountInfo", [pubkey, { commitment: "confirmed" }]);
}
const parsedCache = new Map();
async function getParsedCached(pubkey) {
  if (parsedCache.has(pubkey)) return parsedCache.get(pubkey);
  try {
    const info = await getParsedAccountInfo(pubkey);
    parsedCache.set(pubkey, info);
    return info;
  } catch {
    parsedCache.set(pubkey, null);
    return null;
  }
}
async function tokenAccountInfo(pubkey) {
  const info = await getParsedCached(pubkey);
  const d = info?.value?.data?.parsed;
  return d?.type === "account" ? d?.info : null;
}
async function isMintAccount(pubkey) {
  const info = await getParsedCached(pubkey);
  const d = info?.value?.data?.parsed;
  return d?.type === "mint" ? d?.info : null;
}

// ==== Dexscreener (ingyenes) ====
async function fetchDexscreenerByToken(baseMint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${baseMint}`, {
      headers: { accept: "application/json" }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    if (!pairs.length) return null;

    // Prefer Raydium + nagyobb likviditás
    pairs.sort((a, b) => {
      const ra = (a?.dexId || "").toLowerCase() === "raydium" ? 0 : 1;
      const rb = (b?.dexId || "").toLowerCase() === "raydium" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0);
    });

    const p = pairs[0];
    return {
      name: p?.baseToken?.name || null,
      symbol: p?.baseToken?.symbol || null,
      price: p?.priceUsd ? Number(p.priceUsd) : null,
      liq: p?.liquidity?.usd ? Number(p.liquidity.usd) : null,
      fdv: p?.fdv ? Number(p.fdv) : null,
      mcap: p?.marketCap ? Number(p.marketCap) : null,
      url: p?.url || null
    };
  } catch {
    return null;
  }
}

// ==== Telegram (queue + throttle) ====
const tgQueue = [];
let tgSending = false;
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  tgQueue.push(text);
  if (tgSending) return;
  tgSending = true;
  while (tgQueue.length) {
    const msg = tgQueue.shift();
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          text: msg,
          parse_mode: "HTML",
          disable_web_page_preview: false
        })
      });
      if (r.status === 429) {
        let wait = 3000;
        try {
          const jr = await r.json();
          if (jr?.parameters?.retry_after) wait = (jr.parameters.retry_after * 1000) | 0;
        } catch {}
        await new Promise((r) => setTimeout(r, wait));
        tgQueue.unshift(msg); // retry
      } else {
        await new Promise((r) => setTimeout(r, 1200)); // ~1 msg / 1.2s
      }
    } catch (e) {
      log("TG error:", e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  tgSending = false;
}

// ==== getTransaction RATE LIMITER (max ~1/sec) ====
const sigQueue = [];
const seenSig = new Set(); // dedup: egy signature-t csak egyszer dolgozunk fel
let workerRunning = false;

async function enqueueSignature(sig) {
  if (seenSig.has(sig)) return;
  seenSig.add(sig);
  sigQueue.push(sig);
  if (!workerRunning) {
    workerRunning = true;
    while (sigQueue.length) {
      const s = sigQueue.shift();
      await processSignature(s);
      await new Promise((r) => setTimeout(r, 1000)); // 1 tx / sec
    }
    workerRunning = false;
  }
}

// ---- Gyors baseMint-becslés Raydium accokból ----
function pickBaseMintFromSet(mints) {
  if (mints.size === 0) return null;
  // ha van pont 2, és az egyik "quote", akkor a másik a base
  if (mints.size === 2) {
    const arr = [...mints];
    const [m1, m2] = arr;
    if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) return m2;
    if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) return m1;
    // egyébként az elsőt tekintjük base-nek
    return arr[0];
  }
  // több jelölt: preferáljuk a NEM quote-okat
  for (const m of mints) {
    if (!QUOTE_MINTS.has(m)) return m;
  }
  // ha mind quote (ritka), vegyük az elsőt
  return [...mints][0];
}

async function processSignature(sig) {
  const tx = await getTransaction(sig);
  if (!tx) return;

  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap((x) => x?.instructions || []);
  const all = [...top, ...inner];

  // Raydium program accounts (LP mint is jellemzően itt szerepel)
  const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM]);
  const rayAccounts = new Set();
  for (const ix of all) {
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid && rayPrograms.has(pid)) {
      const accs = (ix?.accounts || [])
        .map((a) => (typeof a === "string" ? a : (a?.pubkey || a?.toString?.())))
        .filter(Boolean);
      for (const a of accs) rayAccounts.add(a);
    }
  }

  // SPL Token: Burn + mint in rayAccounts -> LP burn
  for (const ix of all) {
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid !== TOKENKEG) continue;

    const isBurn = ix?.parsed?.type === "burn" || ix?.instructionName === "Burn";
    if (!isBurn) continue;

    const lpMint = ix?.parsed?.info?.mint || ix?.mint;
    if (!lpMint) continue;
    if (!rayAccounts.has(lpMint)) continue; // nem Raydium LP mint

    // ---- ÚJ: MIN_SOL_BURN küszöb (becsült SOL kivét) ----
    // LP supply (post-burn) + LP decimals
    let supplyPostRaw = 0;
    let lpDecimals = 0;
    try {
      const info = await getParsedCached(lpMint);
      const m = info?.value?.data?.parsed?.info;
      if (m?.supply) supplyPostRaw = Number(m.supply);
      if (m?.decimals != null) lpDecimals = Number(m.decimals) || 0;
    } catch {}

    const burnAmountRaw = Number(ix?.parsed?.info?.amount || ix?.amount || 0);
    const supplyPreRaw = supplyPostRaw + burnAmountRaw;
    const share = supplyPreRaw > 0 ? burnAmountRaw / supplyPreRaw : 0;

    // WSOL-vault SOL mennyisége a Raydium acc-ok között (parsed token account)
    let wsolVaultAmountRaw = 0;
    let wsolDecimals = 9;
    const MAX_CHECK = 30;
    let checked = 0;
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
    const estSolOut = share * wsolVaultSOL;

    if (MIN_SOL_BURN > 0 && estSolOut < MIN_SOL_BURN) {
      log(`skip (est SOL ${estSolOut.toFixed(4)} < min ${MIN_SOL_BURN}) sig=${sig}`);
      return; // küszöb alatt: nincs üzenet
    }

    // ---- Base mint gyors becslés (olcsó, heurisztikus) ----
    const candidateMints = new Set();
    let seen = 0;
    for (const a of rayAccounts) {
      if (seen++ > 50) break;
      const mi = await isMintAccount(a);
      if (mi && a !== lpMint) candidateMints.add(a);
      const ta = await tokenAccountInfo(a);
      if (ta?.mint && ta.mint !== lpMint) candidateMints.add(ta.mint);
    }
    const baseMint = pickBaseMintFromSet(candidateMints);

    // ---- Dexscreener (csak ha van baseMint) ----
    let dx = null;
    if (baseMint) {
      dx = await fetchDexscreenerByToken(baseMint);
    }

    // ---- Üzenet (ha van Dexs adat, bő kártya; különben a régi, egyszerű) ----
    const when = tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "";
    const link = `https://solscan.io/tx/${sig}`;
    const burnLine = `Burn%: ${(share * 100).toFixed(2)}% | Est. SOL: ${estSolOut.toFixed(4)}`;

    if (dx) {
      const headTitle = dx.name && dx.symbol
        ? `${dx.name} (${dx.symbol})`
        : "Raydium LP Burn";

      const mcapStr = dx.mcap != null ? `$${dx.mcap.toLocaleString()}` :
                      dx.fdv  != null ? `$${dx.fdv.toLocaleString()}`  : "n/a";
      const liqStr  = dx.liq  != null ? `$${dx.liq.toLocaleString()}`  : "n/a";
      const priceStr= dx.price!= null ? `$${dx.price}` : "n/a";

      const msg = [
        `Solana LP Burns`,
        `<b>${headTitle}</b>`,
        "",
        `🔥 <b>${burnLine}</b>`,
        when ? `🕒 Time: ${when}` : null,
        "",
        `📊 <b>Marketcap:</b> ${mcapStr}`,
        `💧 <b>Liquidity:</b> ${liqStr}`,
        `💲 <b>Price:</b> ${priceStr}`,
        "",
        baseMint ? `🧾 <b>Base Mint:</b> <code>${baseMint}</code>` : null,
        `📜 <b>LP Mint:</b> <code>${lpMint}</code>`,
        "",
        dx.url ? dx.url : null,
        `🔗 <a href="${link}">Solscan</a>`
      ].filter(Boolean).join("\n");

      log(`TG card (Dexs) → ${headTitle} | ${burnLine} | sig=${sig}`);
      await sendTelegram(msg);
    } else {
      const msg = [
        "🔥 <b>Raydium LP BURN</b>",
        `Mint: <code>${lpMint}</code>`,
        `Amount: ${burnAmountRaw}`,
        `Est. SOL from LP: ${estSolOut.toFixed(4)} SOL`,
        when ? `Time: ${when}` : null,
        `Sig: <a href="${link}">${sig}</a>`
      ]
        .filter(Boolean)
        .join("\n");

      log(msg.replace(/<[^>]+>/g, ""));
      await sendTelegram(msg);
    }

    break; // elég egy találat/tx
  }
}

// ==== Plain WebSocket kliens (Helius WSS - nem enhanced) ====
let ws;

function wsSend(obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function subscribeLogs(programId, id) {
  // logsSubscribe -> Raydium programokat “említő” tx-ek LOGS + signature
  const msg = {
    jsonrpc: "2.0",
    id,
    method: "logsSubscribe",
    params: [{ mentions: [programId] }, { commitment: "confirmed" }]
  };
  wsSend(msg);
}

function connectWS() {
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);

  ws.onopen = () => {
    log("WS open");
    subscribeLogs(RAY_AMM_V4, 1001);
    subscribeLogs(RAY_CPMM, 1002);
  };

  ws.onmessage = async (ev) => {
    try {
      const data = JSON.parse(ev.data.toString());
      const res = data?.params?.result;
      const sig = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      if (!sig || logsArr.length === 0) return;

      // ---- AGRESSZÍV ELŐSZŰRÉS ----
      // Csak akkor dolgozunk tovább, ha a logokban tényleg szerepel:
      // "Program log: Instruction: Burn"
      const hasBurnLog = logsArr.some(
        (l) => typeof l === "string" && /Instruction:\s*Burn/i.test(l)
      );
      if (!hasBurnLog) return;

      // Tedd a signature-t a rate-limites queue-ba
      await enqueueSignature(sig);
    } catch (e) {
      log("WS msg err:", e.message);
    }
  };

  ws.onclose = () => {
    log("WS closed, reconnecting in 3s…");
    setTimeout(connectWS, 3000);
  };

  ws.onerror = (e) => {
    log("WS error:", e?.message || String(e));
  };
}

connectWS();
