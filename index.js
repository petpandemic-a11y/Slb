// index.js — Raydium LP burn watcher (RELAXED + mini-cache középút)

import WebSocket from "ws";
import http from "http";

// ===== ENV =====
const PORT = Number(process.env.PORT || 10000);

// Helius / Solana RPC
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";

// Telegram
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

// Tuning
const STRICT_LP_MATCH   = (process.env.STRICT_LP_MATCH ?? "false").toLowerCase() === "true";
const CACHE_WINDOW_MIN  = Number(process.env.CACHE_WINDOW_MIN || 5);  // perc
const CACHE_MIN_FREQ    = Number(process.env.CACHE_MIN_FREQ   || 3);  // min. megjelenés a windowban
const RATE_TX_PER_SEC   = Math.max(0.2, Number(process.env.RATE_TX_PER_SEC || 1.0)); // 1 tx / sec alap

// Program IDs
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// ===== Logger =====
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dbg = (...a) => console.log(new Date().toISOString(), "[DBG]", ...a);

// ===== Health HTTP (Render) =====
http
  .createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
  })
  .listen(PORT, () => log(`HTTP up on :${PORT}`));

// ===== JSON-RPC helpers =====
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
      dbg(`getTransaction fail (${i + 1}/${tries}):`, e.message);
      if (i < tries - 1) {
        await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      } else {
        return null;
      }
    }
  }
}

// ===== Telegram (queue + throttle) =====
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
        let wait = 2500;
        try {
          const jr = await r.json();
          if (jr?.parameters?.retry_after) wait = (jr.parameters.retry_after * 1000) | 0;
        } catch {}
        await new Promise((r) => setTimeout(r, wait));
        tgQueue.unshift(msg); // retry
      } else {
        await new Promise((r) => setTimeout(r, 1100));
      }
    } catch (e) {
      dbg("TG error:", e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  tgSending = false;
}

// ===== Signature worker (rate-limit) =====
const sigQueue = [];
const seenSig = new Set();
let workerRunning = false;

async function enqueueSignature(sig, src) {
  if (!sig || seenSig.has(sig)) return;
  seenSig.add(sig);
  sigQueue.push({ sig, src });
  if (!workerRunning) {
    workerRunning = true;
    const delay = Math.max(1000 / RATE_TX_PER_SEC, 250);
    while (sigQueue.length) {
      const { sig, src } = sigQueue.shift();
      await processSignature(sig, src);
      await new Promise((r) => setTimeout(r, delay));
    }
    workerRunning = false;
  }
}

// ===== Raydium mini-cache =====

// Map<mint, {ts:number, freq:number}>
const rayMintCache = new Map();

function cacheBump(addr) {
  const now = Date.now();
  const it = rayMintCache.get(addr);
  if (it) {
    it.ts = now;
    it.freq = (it.freq || 0) + 1;
  } else {
    rayMintCache.set(addr, { ts: now, freq: 1 });
  }
}

function cachePrune() {
  const maxAge = CACHE_WINDOW_MIN * 60 * 1000;
  const now = Date.now();
  for (const [k, v] of rayMintCache.entries()) {
    if (now - (v.ts || 0) > maxAge) rayMintCache.delete(k);
  }
}

function cacheAccepts(mint) {
  cachePrune();
  const it = rayMintCache.get(mint);
  if (!it) return false;
  return it.freq >= CACHE_MIN_FREQ;
}

// ===== Core processing =====
async function processSignature(sig, sourceTag = "") {
  const tx = await getTransaction(sig);
  if (!tx) return;

  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap((x) => x?.instructions || []);
  const all   = [...top, ...inner];

  // 1) Gyűjtsünk MINDEN Raydium accountot (cache-hez is!)
  const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM]);
  const rayAccounts = new Set();
  for (const ix of all) {
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid && rayPrograms.has(pid)) {
      const accs = (ix?.accounts || [])
        .map((a) => (typeof a === "string" ? a : (a?.pubkey || a?.toString?.())))
        .filter(Boolean);
      for (const a of accs) {
        rayAccounts.add(a);
        cacheBump(a); // mini-cache: minden Raydium-account növeli a saját „nyomát”
      }
    }
  }

  // 2) Keressünk SPL Token Burn/BurnChecked utasításokat
  const burns = [];
  for (const ix of all) {
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid !== TOKENKEG) continue;

    const type = ix?.parsed?.type?.toLowerCase?.() || ix?.instructionName?.toLowerCase?.();
    if (type === "burn" || type === "burnchecked") {
      const info  = ix?.parsed?.info || {};
      const mint  = info.mint || ix?.mint;
      const amt   = info.amount || ix?.amount; // raw (base units)
      const owner = info?.owner || info?.authority;
      if (mint) {
        burns.push({ mint, amount: amt, owner });
      }
    }
  }

  if (burns.length === 0) {
    dbg("skip: no burn in tx", sig.slice(0, 8));
    return;
  }

  // 3) Döntés burnönként: same-tx LP match, különben mini-cache
  for (const b of burns) {
    const { mint, amount } = b;

    // A) same-tx LP-mint?
    if (rayAccounts.has(mint)) {
      await announce(sig, mint, amount, tx, "same-tx");
      return; // egy tx-ből egy jelzés elég
    }

    // B) ha strict, itt vége
    if (STRICT_LP_MATCH) {
      dbg("no LP mint match (strict)", mint);
      continue;
    }

    // C) mini-cache: gyakori Raydium-nyom a windowban?
    if (cacheAccepts(mint)) {
      await announce(sig, mint, amount, tx, "cache");
      return;
    } else {
      dbg("skip: mint has no recent Raydium footprint", mint);
    }
  }
}

// Jelentés (TG)
async function announce(sig, mint, amountRaw, tx, how) {
  const when = tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "";
  const solscan = `https://solscan.io/tx/${sig}`;

  const title = "Solana LP Burns\nRaydium LP Burn";
  const lines = [
    `<b>${title}</b>`,
    `🔥 Burn Percentage: 100.00%`,
    `🕒 Burn Time: ${when || "n/a"}`,
    `📄 Token Mint: <code>${mint}</code>`,
    amountRaw ? `🔥 Amount (raw): ${amountRaw}` : null,
    ``,
    `🔗 <a href="${solscan}">Solscan</a>`,
    how ? `<i>source: ${how}</i>` : null
  ].filter(Boolean);

  const msg = lines.join("\n");
  log(`[ALERT] ${how} | mint=${mint} | sig=${sig}`);
  await sendTelegram(msg);
}

// ===== WebSocket (Helius) =====
let ws;

function wsSend(obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function subscribeLogs(programId, id) {
  wsSend({
    jsonrpc: "2.0",
    id,
    method: "logsSubscribe",
    params: [{ mentions: [programId] }, { commitment: "confirmed" }]
  });
}

function connectWS() {
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);

  ws.onopen = () => {
    log("WS open");

    // 1) Raydium AMM v4 + CPMM — mindig gyűjtjük a cache-hez
    subscribeLogs(RAY_AMM_V4, 1001);
    subscribeLogs(RAY_CPMM,   1002);

    // 2) Token Program — csak akkor sorolunk be, ha a logban Burn/BurnChecked
    subscribeLogs(TOKENKEG,   1003);
  };

  ws.onmessage = async (ev) => {
    try {
      const data = JSON.parse(ev.data.toString());
      const res = data?.params?.result;
      if (!res) return;

      const sig     = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      const logStr  = logsArr.join("\n");

      // Token Program csatorna: csak Burn logra
      const isTokenStream = (res?.value?.programId === TOKENKEG);
      if (isTokenStream) {
        const hasBurnLog = /Instruction:\s*Burn(?:Checked)?/i.test(logStr);
        if (hasBurnLog) {
          return enqueueSignature(sig, "token-burn-log");
        }
        return; // token stream, de nem burn
      }

      // Raydium csatorna: minden tx-t feldolgozunk (cache-hez is kell)
      const isRayStream = (res?.value?.programId === RAY_AMM_V4 || res?.value?.programId === RAY_CPMM);
      if (isRayStream) {
        // Raydiumból is jöhet burn ugyanabban a tx-ben → feldolgozzuk
        // (Ha nincs benne burn, a processSignature úgyis "skip: no burn" és közben a cache-et frissíti.)
        return enqueueSignature(sig, "ray-stream");
      }

    } catch (e) {
      dbg("WS msg err:", e.message);
    }
  };

  ws.onclose = () => {
    log("WS closed, reconnecting in 3s…");
    setTimeout(connectWS, 3000);
  };

  ws.onerror = (e) => {
    dbg("WS error:", e?.message || String(e));
  };
}

connectWS();
