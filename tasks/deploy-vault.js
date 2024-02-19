const path = require("path")
const process = require("process")
const { networks } = require("../networks")
const { SubscriptionManager, SecretsManager, createGist } = require("@chainlink/functions-toolkit")

const generateEncryptedGist = async (secrets, githubApiToken, networkConfig) => {
  const provider = new ethers.providers.JsonRpcProvider(networkConfig.url)
  const signer = new ethers.Wallet(networkConfig.accounts[0], provider)

  const secretsManager = new SecretsManager({
    signer: signer,
    functionsRouterAddress: networkConfig.functionsRouter,
    donId: networkConfig.functionsDonId,
  })
  await secretsManager.initialize()

  const encryptedSecretsObj = await secretsManager.encryptSecrets(secrets)

  console.log(`Creating gist...`)
  if (!githubApiToken) throw new Error("githubApiToken not provided - check your environment variables")

  const gistURL = await createGist(githubApiToken, JSON.stringify(encryptedSecretsObj))
  console.log(`Gist created ${gistURL}`)
  const encryptedSecretsUrls = await secretsManager.encryptSecretsUrls([gistURL])

  return encryptedSecretsUrls
}

const addConsumerToSubscription = async (subscriptionId, consumerAddress, networkConfig) => {
  const provider = new ethers.providers.JsonRpcProvider(networkConfig.url)
  const signer = new ethers.Wallet(networkConfig.accounts[0], provider)

  const subscriptionManager = new SubscriptionManager({
    signer,
    linkTokenAddress: networkConfig.linkToken,
    functionsRouterAddress: networkConfig.functionsRouter,
  })
  await subscriptionManager.initialize()

  const addConsumerTxReceipt = await subscriptionManager.addConsumer({
    subscriptionId,
    consumerAddress,
  })
  console.log(`\nConsumer added to Functions subscription ${subscriptionId}`)

  return addConsumerTxReceipt
}

task("functions-deploy-vault", "Deploys the CompliantVault contract")
  .addParam("subid", "Billing subscription ID used to pay for Functions requests")
  .addOptionalParam("verify", "Set to true to verify client contract", false, types.boolean)
  .addOptionalParam(
    "gaslimit",
    "Maximum amount of gas that can be used to call fulfillRequest in the client contract",
    250000,
    types.int
  )
  .addOptionalParam(
    "simulate",
    "Flag indicating if simulation should be run before making an on-chain request",
    true,
    types.boolean
  )
  .addOptionalParam(
    "configpath",
    "Path to Functions request config file",
    `${__dirname}/../../Functions-request-config.js`,
    types.string
  )
  .setAction(async (taskArgs) => {
    if (network.name === "hardhat") {
      throw Error(
        'This command cannot be used on a local hardhat chain.  Specify a valid network or simulate an FunctionsConsumer request locally with "npx hardhat functions-simulate".'
      )
    }

    if (taskArgs.gaslimit > 300000) {
      throw Error("Gas limit must be less than or equal to 300,000")
    }

    console.log(`Deploying CompliantVault contract to ${network.name}`)

    console.log("\n__Compiling Contracts__")
    await run("compile")

    const networkConfig = networks[network.name]
    const requestConfig = require(path.isAbsolute(taskArgs.configpath)
      ? taskArgs.configpath
      : path.join(process.cwd(), taskArgs.configpath))

    const encryptedSecrets = await generateEncryptedGist(
      requestConfig.secrets,
      process.env.GITHUB_API_TOKEN,
      networkConfig
    )
    const donIdBytes32 = ethers.utils.formatBytes32String(networkConfig.functionsDonId)

    const compliantVaultFactory = await ethers.getContractFactory("CompliantVault")
    const compliantVaultContract = await compliantVaultFactory.deploy(
      networkConfig.functionsRouter,
      donIdBytes32,
      taskArgs.subid,
      request.source,
      encryptedSecrets,
      taskArgs.gaslimit
    )

    console.log(`\nWaiting 1 block for transaction ${compliantVaultContract.deployTransaction.hash} to be confirmed...`)
    await compliantVaultContract.deployTransaction.wait(1)

    await addConsumerToSubscription(taskArgs.subid, compliantVaultContract.address, networkConfig)

    taskArgs.contract = compliantVaultContract.address

    const verifyContract = taskArgs.verify

    if (verifyContract && !!networks[network.name].verifyApiKey && networks[network.name].verifyApiKey !== "UNSET") {
      try {
        console.log("\nVerifying contract...")
        await compliantVaultContract.deployTransaction.wait(Math.max(6 - networks[network.name].confirmations, 0))
        await run("verify:verify", {
          address: compliantVaultContract.address,
          constructorArguments: [
            networkConfig.functionsRouter,
            donIdBytes32,
            taskArgs.subid,
            request.source,
            encryptedSecrets,
            taskArgs.gaslimit,
          ],
        })
        console.log("Contract verified")
      } catch (error) {
        if (!error.message.includes("Already Verified")) {
          console.log("Error verifying contract.  Delete the build folder and try again.")
          console.log(error)
        } else {
          console.log("Contract already verified")
        }
      }
    } else if (verifyContract) {
      console.log(
        "\nPOLYGONSCAN_API_KEY, ETHERSCAN_API_KEY or SNOWTRACE_API_KEY is missing. Skipping contract verification..."
      )
    }

    console.log(`\CompliantVault contract deployed to ${compliantVaultContract.address} on ${network.name}`)
  })
