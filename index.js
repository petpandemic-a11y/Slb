// index.js — Raydium LP burn watcher
// Jelent: Burn vagy Burn+RemoveLiquidity
// Nem jelent: csak RemoveLiquidity (Burn nélkül)

import WebSocket from "ws";
import http from "http";

// ===== ENV =====
const PORT = Number(process.env.PORT || 10000);
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

const RATE_TX_PER_SEC = Math.max(0.2, Number(process.env.RATE_TX_PER_SEC || 1.0)); // 1 tx / sec default

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

// ===== JSON-RPC helper =====
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
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      else return null;
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
        tgQueue.unshift(msg);
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

// ===== Core processing =====
async function processSignature(sig, src = "") {
  const tx = await getTransaction(sig);
  if (!tx) return;

  const top   = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap((x) => x?.instructions || []);
  const all   = [...top, ...inner];

  // 1) Burn-ek összegyűjtése (Token Program)
  const burns = [];
  for (const ix of all) {
    const pid = typeof ix?.programId === "string" ? ix.programId : null;
    if (pid !== TOKENKEG) continue;
    const t = (ix?.parsed?.type || ix?.instructionName || "").toLowerCase();
    if (t === "burn" || t === "burnchecked") {
      const info = ix?.parsed?.info || {};
      const mint = info?.mint || ix?.mint;
      const amt  = info?.amount || ix?.amount;
      if (mint) burns.push({ mint, amount: amt });
    }
  }

  // 2) RemoveLiquidity jelenlét a logokban
  const logs = tx?.meta?.logMessages || [];
  const hasRemoveLiq = logs.some((l) => /Remove\s*Liquidity/i.test(l));

  // 3) DÖNTÉS:
  //    - Ha VAN Burn → JELZÉS (akkor is, ha van mellette RemoveLiquidity)
  //    - Ha NINCS Burn, de van RemoveLiquidity → SKIP (nem jelez)
  //    - Ha egyik sincs → úgyse jutottunk idáig
  if (burns.length === 0) {
    if (hasRemoveLiq) {
      dbg(`RemoveLiquidity without Burn → skip (${sig.slice(0, 8)})`);
      return;
    }
    dbg(`no burn in tx → skip (${sig.slice(0, 8)})`);
    return;
  }

  // 4) Üzenet felépítése (egyszerű)
  const when = tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "n/a";
  const solscan = `https://solscan.io/tx/${sig}`;
  const title = `Solana LP Burns\nRaydium LP Burn${hasRemoveLiq ? " (+ RemoveLiquidity)" : ""}`;

  // Ha több burn is volt a tx-ben, az elsőt írjuk ki (ált. elég)
  const b = burns[0];

  const msg = [
    `<b>${title}</b>`,
    `🕒 Time: ${when}`,
    `🧾 Mint: <code>${b.mint}</code>`,
    b.amount ? `🔥 Amount (raw): ${b.amount}` : null,
    ``,
    `🔗 <a href="${solscan}">Solscan</a>`
  ].filter(Boolean).join("\n");

  log(`[ALERT] ${hasRemoveLiq ? "Burn+RemoveLiq" : "Burn"} | mint=${b.mint} | sig=${sig}`);
  await sendTelegram(msg);
}

// ===== WebSocket (Helius) — subscription-ID routing =====
let ws;
let rid = 2000;                                  // request id számláló
const pending = {};                              // reqId -> label
const subs    = { rayAmm: null, rayCpmm: null, token: null };  // label -> subId

function wsSend(obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function subscribeLogs(programId, label) {
  const id = ++rid;
  pending[id] = label;
  wsSend({
    jsonrpc: "2.0",
    id,
    method: "logsSubscribe",
    params: [{ mentions: [programId] }, { commitment: "confirmed" }]
  });
  dbg(`subscribe sent: ${label} -> reqId ${id}`);
}

function labelBySubId(subId) {
  for (const [k, v] of Object.entries(subs)) if (v === subId) return k;
  return null;
}

function connectWS() {
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);

  ws.onopen = () => {
    log("WS open");
    subscribeLogs(RAY_AMM_V4, "rayAmm");
    subscribeLogs(RAY_CPMM,   "rayCpmm");
    subscribeLogs(TOKENKEG,   "token");
  };

  ws.onmessage = async (ev) => {
    try {
      const data = JSON.parse(ev.data.toString());

      // 1) sub ACK
      if (data?.id && data?.result && pending[data.id]) {
        const label = pending[data.id];
        subs[label] = data.result;
        delete pending[data.id];
        dbg(`sub ack: ${label} -> subId ${subs[label]}`);
        return;
      }

      // 2) notification
      if (data?.method === "logsNotification") {
        const subId = data?.params?.subscription;
        const label = labelBySubId(subId);
        const res   = data?.params?.result;
        if (!label || !res) return;

        const sig     = res?.value?.signature;
        const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
        if (!sig || logsArr.length === 0) return;

        // Burn vagy RemoveLiquidity log kell, különben zaj
        const hasBurnLog = logsArr.some((l) => /Instruction:\s*Burn(?:Checked)?/i.test(l));
        const hasRemoveLiqLog = logsArr.some((l) => /Remove\s*Liquidity/i.test(l));
        if (!hasBurnLog && !hasRemoveLiqLog) return;

        dbg(`${label}: ${(hasBurnLog?"Burn":"")}${(hasRemoveLiqLog?" + RemoveLiq":"")} -> enqueue ${sig.slice(0,8)}`);
        return enqueueSignature(sig, label);
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
