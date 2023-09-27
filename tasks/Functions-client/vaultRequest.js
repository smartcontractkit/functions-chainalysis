const { networks } = require("../../networks")
const utils = require("../utils")

task("functions-vault-request", "Initiates a request from a CompliantVault contract")
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
    const OracleFactory = await ethers.getContractFactory("contracts/dev/functions/FunctionsOracle.sol:FunctionsOracle")
    const oracle = await OracleFactory.attach(networks[network.name]["functionsOracleProxy"])
    const registryAddress = await oracle.getRegistry()
    const RegistryFactory = await ethers.getContractFactory(
      "contracts/dev/functions/FunctionsBillingRegistry.sol:FunctionsBillingRegistry"
    )
    const registry = await RegistryFactory.attach(registryAddress)

    const spinner = utils.spin({
      text: `Submitting transaction for CompliantVault contract ${contractAddr} on network ${network.name}`,
    })

    // Use a promise to wait & listen for the fulfillment event before returning
    await new Promise(async (resolve, reject) => {
      let requestId

      // Initiate the listeners before making the request
      // Listen for fulfillment errors
      oracle.on("UserCallbackError", async (eventRequestId, msg) => {
        if (requestId == eventRequestId) {
          spinner.fail(
            "Error encountered when calling fulfillRequest in client contract.\n" +
              "Ensure the fulfillRequest function in the client contract is correct and the --gaslimit is sufficient."
          )
          console.log(`${msg}\n`)
          resolve()
        }
      })
      oracle.on("UserCallbackRawError", async (eventRequestId, msg) => {
        if (requestId == eventRequestId) {
          spinner.fail("Raw error in contract request fulfillment. Please contact Chainlink support.")
          console.log(Buffer.from(msg, "hex").toString())
          resolve()
        }
      })
      // Listen for successful fulfillment, both must be true to be finished
      let billingEndEventReceived = false
      let ocrResponseEventReceived = false
      compliantVaultContract.on("RequestFulfilled", async (eventRequestId) => {
        // Ensure the fulfilled requestId matches the initiated requestId to prevent logging a response for an unrelated requestId
        if (eventRequestId !== requestId) {
          return
        }

        spinner.succeed(`Request ${requestId} fulfilled! Data has been written on-chain.\n`)

        ocrResponseEventReceived = true

        if (billingEndEventReceived) {
          resolve()
        }
      })
      // Listen for the BillingEnd event, log cost breakdown & resolve
      registry.on(
        "BillingEnd",
        async (
          eventRequestId,
          eventSubscriptionId,
          eventSignerPayment,
          eventTransmitterPayment,
          eventTotalCost,
          eventSuccess
        ) => {
          if (requestId == eventRequestId) {
            const baseFee = eventTotalCost.sub(eventTransmitterPayment)
            spinner.stop()
            console.log(`Actual amount billed to subscription:`)
            const costBreakdownData = [
              {
                Type: "Transmission cost:",
                Amount: `${hre.ethers.utils.formatUnits(eventTransmitterPayment, 18)} LINK`,
              },
              { Type: "Base fee:", Amount: `${hre.ethers.utils.formatUnits(baseFee, 18)} LINK` },
              { Type: "", Amount: "" },
              { Type: "Total cost:", Amount: `${hre.ethers.utils.formatUnits(eventTotalCost, 18)} LINK` },
            ]
            utils.logger.table(costBreakdownData)

            // Check for a successful request
            billingEndEventReceived = true
            if (ocrResponseEventReceived) {
              resolve()
            }
          }
        }
      )
      // Listen for request failure
      compliantVaultContract.on("RequestFailed", async (err) => {
        spinner.fail(`Request failed: ${err}.\n`)
      })
      // Listen for approved deposit
      compliantVaultContract.on("DepositRequestFulfilled", async (_, requester, amount) => {
        spinner.succeed(
          `Deposit request for ${hre.ethers.utils.formatUnits(amount, "ether")} from ${requester} was fulfilled!\n`
        )
      })
      // Listen for cancelled deposit
      compliantVaultContract.on("DepositRequestCancelled", async (_, requester, amount) => {
        spinner.fail(
          `Deposit request for ${hre.ethers.utils.formatUnits(amount, "ether")} from ${requester} was cancelled!\n`
        )
      })
      // Listen for approved withdraw
      compliantVaultContract.on("WithdrawalRequestFulfilled", async (_, requester, amount) => {
        spinner.succeed(
          `Withdrawal request for ${hre.ethers.utils.formatUnits(amount, "ether")} from ${requester} was fulfilled!\n`
        )
      })
      // Listen for cancelled withdraw
      compliantVaultContract.on("WithdrawalRequestCancelled", async (_, requester, amount) => {
        spinner.fail(
          `Withdrawal request for ${hre.ethers.utils.formatUnits(amount, "ether")} from ${requester} was cancelled!\n`
        )
      })

      let requestTx

      if (deposit) {
        requestTx = await compliantVaultContract.requestDeposit({ value: amount, ...overrides })
      } else if (withdraw) {
        requestTx = await compliantVaultContract.requestWithdrawal(amount, overrides)
      }
      spinner.start("Waiting 2 blocks for transaction to be confirmed...")
      const requestTxReceipt = await requestTx.wait(2)
      spinner.info(
        `Transaction confirmed, see ${
          utils.getEtherscanURL(network.config.chainId) + "tx/" + requestTx.hash
        } for more details.\n`
      )
      spinner.stop()
      requestId = requestTxReceipt.events[2].args.id
      spinner.start(
        `Request ${requestId} has been initiated. Waiting for fulfillment from the Decentralized Oracle Network...\n`
      )
    })
  })
