require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const chains = require("./chains.json");

const networks = { hardhat: {}, localhost: { url: "http://127.0.0.1:8545" } };
for (const c of chains) {
  if (!process.env[c.rpcEnv]) continue;
  networks[c.slug] = {
    url: process.env[c.rpcEnv],
    chainId: c.chainId,
    accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
  };
  if (c.gasPrice) networks[c.slug].gasPrice = Number(c.gasPrice);
}

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" }
  },
  networks,
  etherscan: {
    apiKey: {
      bscScan: process.env.ETHERSCAN_KEY || "",
      ethereum: process.env.ETHERSCAN_KEY || "",
      basescan: process.env.ETHERSCAN_KEY || "",
      arbiscan: process.env.ETHERSCAN_KEY || "",
      optimisticEthereum: process.env.ETHERSCAN_KEY || "",
      polygonscan: process.env.ETHERSCAN_KEY || "",
      snowtrace: process.env.ETHERSCAN_KEY || ""
    }
  }
};
