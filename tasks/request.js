const { networks } = require("../networks")

task("vault-request", "Initiates a request from a CompliantVault contract")
  .addParam("contract", "Address of the client contract to call")
  .addParam("amount", "Amount of ETH to deposit or withdraw")
  .addOptionalParam("deposit", "Flag indicating if deposit request should be made", false, types.boolean)
  .addOptionalParam("withdraw", "Flag indicating if withdraw request should be made", false, types.boolean)
  .addOptionalParam("requestgas", "Gas limit for calling the executeRequest function", 1_500_000, types.int)
  .setAction(async (taskArgs, hre) => {
    // A manual gas limit is required as the gas limit estimated by Ethers is not always accurate
    const overrides = {
      gasLimit: taskArgs.requestgas,
      gasPrice: networks[network.name].gasPrice,
    }

    if (network.name === "hardhat") {
      throw Error(
        'This command cannot be used on a local development chain.  Specify a valid network or simulate an Functions request locally with "npx hardhat functions-simulate".'
      )
    }

    // Get the required parameters
    const contractAddr = taskArgs.contract
    const amount = taskArgs.amount
    const deposit = taskArgs.deposit
    const withdraw = taskArgs.withdraw

    const compliantVaultFactory = await ethers.getContractFactory("CompliantVault")
    const compliantVaultContract = compliantVaultFactory.attach(contractAddr)

    console.log(`Submitting transaction for CompliantVault contract ${contractAddr} on network ${network.name}`)

    // Use a promise to wait & listen for the fulfillment event before returning
    await new Promise(async (resolve, reject) => {
      let requestId

      // Listen for request failure
      compliantVaultContract.on("RequestFailed", async (err) => {
        console.log(`Request failed: ${err}.\n`)
      })
      // Listen for approved deposit
      compliantVaultContract.on("DepositRequestFulfilled", async (_, requester, amount) => {
        console.log(
          `Deposit request for ${hre.ethers.utils.formatUnits(amount, "ether")} from ${requester} was fulfilled!\n`
        )
      })
      // Listen for cancelled deposit
      compliantVaultContract.on("DepositRequestCancelled", async (_, requester, amount) => {
        console.log(
          `Deposit request for ${hre.ethers.utils.formatUnits(amount, "ether")} from ${requester} was cancelled!\n`
        )
      })
      // Listen for approved withdraw
      compliantVaultContract.on("WithdrawalRequestFulfilled", async (_, requester, amount) => {
        console.log(
          `Withdrawal request for ${hre.ethers.utils.formatUnits(amount, "ether")} from ${requester} was fulfilled!\n`
        )
      })
      // Listen for cancelled withdraw
      compliantVaultContract.on("WithdrawalRequestCancelled", async (_, requester, amount) => {
        console.log(
          `Withdrawal request for ${hre.ethers.utils.formatUnits(amount, "ether")} from ${requester} was cancelled!\n`
        )
      })

      let requestTx

      if (deposit) {
        requestTx = await compliantVaultContract.requestDeposit({ value: amount, ...overrides })
      } else if (withdraw) {
        requestTx = await compliantVaultContract.requestWithdrawal(amount, overrides)
      }
      console.log("Waiting 2 blocks for transaction to be confirmed...")
      const requestTxReceipt = await requestTx.wait(2)
      console.log(
        `Transaction confirmed, see ${
          utils.getEtherscanURL(network.config.chainId) + "tx/" + requestTx.hash
        } for more details.\n`
      )
      requestId = requestTxReceipt.events[2].args.id
      console.log(
        `Request ${requestId} has been initiated. Waiting for fulfillment from the Decentralized Oracle Network...\n`
      )
    })
  })
