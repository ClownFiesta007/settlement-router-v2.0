const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const chains = require("../chains.json");

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

async function main() {
  const treasury = process.env.TREASURY_ADDRESS;
  const max = process.env.MAX_PER_TOKEN || "0";
  if (!treasury) throw new Error("TREASURY_ADDRESS missing in .env");

  const wanted = (process.env.DEPLOY_CHAINS || "bsc")
    .split(",").map(s => s.trim()).filter(Boolean);

  const [deployer] = await hre.ethers.getSigners();
  console.log("deployer:", deployer.address, "balance:",
    hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)));

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });

  for (const slug of wanted) {
    const meta = chains.find(c => c.slug === slug);
    if (!meta) throw new Error(`unknown chain slug: ${slug}`);
    if (!hre.config.networks[slug]) {
      console.log(`skip ${slug}: no RPC_${meta.chainId} in .env`);
      continue;
    }
    const net = await hre.ethers.provider.getNetwork();
    if (BigInt(net.chainId) !== BigInt(meta.chainId)) {
      throw new Error(`${slug}: rpc says ${net.chainId}, chains.json says ${meta.chainId}`);
    }

    const F = await hre.ethers.getContractFactory("SettlementRouter");
    const c = await F.deploy(treasury, PERMIT2, max);
    await c.waitForDeployment();
    const addr = await c.getAddress();

    fs.writeFileSync(path.join(outDir, `${meta.chainId}.json`), JSON.stringify({
      chainId: meta.chainId, name: meta.name, slug: meta.slug,
      router: addr, permit2: PERMIT2, treasury, maxPerToken: max,
      deployer: deployer.address, deployedAt: new Date().toISOString()
    }, null, 2));
    console.log(`${meta.name.padEnd(14)} router ${addr}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
