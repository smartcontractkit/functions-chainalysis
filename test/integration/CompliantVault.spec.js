const { expect } = require("chai")
const { ethers } = require("hardhat")
const { simulateScript } = require("@chainlink/functions-toolkit")

const requestConfig = require("../../Functions-request-config")

const compliantAddress = "00D5e13662BC4Fae4498669b1b797FBE4cCc3Bd7"
const nonCompliantAddress = "8589427373D6D84E98730D7795D8f6f8731FDA16"

const depositActionId = "0"
const withdrawActionId = "1"

const simulateRequestAndFulfill = async (oracleContract, clientAddress, requestId, requestConfig) => {
  const { responseBytesHexstring } = await simulateScript(requestConfig)
  return oracleContract.fulfillRequest(clientAddress, requestId, responseBytesHexstring)
}

describe("CompliantVault Integration Tests", async function () {
  let vault, mockFunctionsOracle, user

  beforeEach(async function () {
    ;[user] = await ethers.getSigners()

    // Deploy the Functions oracle mock contract
    const mockFunctionsOracleFactory = await ethers.getContractFactory("MockFunctionsOracle")
    mockFunctionsOracle = await mockFunctionsOracleFactory.deploy()

    // Deploy the client contract
    const oracleAddress = mockFunctionsOracle.address
    const donId = ethers.utils.formatBytes32String(1)
    const subscriptionId = 1
    const source = requestConfig.source
    const secrets = ethers.constants.HashZero
    const gasLimit = 300_000

    const vaultFactory = await ethers.getContractFactory("CompliantVault")
    vault = await vaultFactory.deploy(oracleAddress, donId, subscriptionId, source, secrets, gasLimit)
    await vault.deployTransaction.wait(1)
  })

  it("Deposit approved", async () => {
    // Initiate the request from the client contract
    const requestTx = await vault.requestDeposit({ value: "1000" })
    const requestTxReceipt = await requestTx.wait(1)
    const requestId = requestTxReceipt.events[0].args.id

    // Simulate request execution
    await simulateRequestAndFulfill(mockFunctionsOracle, vault.address, requestId, {
      ...requestConfig,
      args: [depositActionId, compliantAddress],
    })

    expect(await vault.balanceOf(user.address)).to.equal(1000)
  })

  it("Deposit rejected", async () => {
    // Initiate the request from the client contract
    const requestTx = await vault.requestDeposit({ value: "1000" })
    const requestTxReceipt = await requestTx.wait(1)
    const requestId = requestTxReceipt.events[0].args.id

    // Simulate request execution
    await simulateRequestAndFulfill(mockFunctionsOracle, vault.address, requestId, {
      ...requestConfig,
      args: [depositActionId, nonCompliantAddress],
    })

    expect(await vault.balanceOf(user.address)).to.equal(0)
  })

  it("Withdraw approved", async () => {
    // Initiate the deposit request from the client contract
    const depositRequestTx = await vault.requestDeposit({ value: "1000" })
    const depositRequestTxReceipt = await depositRequestTx.wait(1)
    const depositRequestId = depositRequestTxReceipt.events[0].args.id

    // Simulate deposit request execution
    await simulateRequestAndFulfill(mockFunctionsOracle, vault.address, depositRequestId, {
      ...requestConfig,
      args: [depositActionId, compliantAddress],
    })

    expect(await vault.balanceOf(user.address)).to.equal(1000)

    // Initiate the withdraw request from the client contract
    const withdrawRequestTx = await vault.requestWithdrawal("1000")
    const withdrawRequestTxReceipt = await withdrawRequestTx.wait(1)
    const withdrawRequestId = withdrawRequestTxReceipt.events[0].args.id

    // Simulate withdraw request execution
    await simulateRequestAndFulfill(mockFunctionsOracle, vault.address, withdrawRequestId, {
      ...requestConfig,
      args: [withdrawActionId, compliantAddress, "1000"],
    })

    expect(await vault.balanceOf(user.address)).to.equal(0)
  })

  it("Withdraw rejected", async () => {
    // Initiate the deposit request from the client contract
    const depositRequestTx = await vault.requestDeposit({ value: "1000" })
    const depositRequestTxReceipt = await depositRequestTx.wait(1)
    const depositRequestId = depositRequestTxReceipt.events[0].args.id

    // Simulate deposit request execution
    await simulateRequestAndFulfill(mockFunctionsOracle, vault.address, depositRequestId, {
      ...requestConfig,
      args: [depositActionId, compliantAddress],
    })

    expect(await vault.balanceOf(user.address)).to.equal(1000)

    // Initiate the withdraw request from the client contract
    const withdrawRequestTx = await vault.requestWithdrawal("1000")
    const withdrawRequestTxReceipt = await withdrawRequestTx.wait(1)
    const withdrawRequestId = withdrawRequestTxReceipt.events[0].args.id

    // Simulate withdraw request execution
    await simulateRequestAndFulfill(mockFunctionsOracle, vault.address, withdrawRequestId, {
      ...requestConfig,
      args: [withdrawActionId, nonCompliantAddress, "1000"],
    })

    expect(await vault.balanceOf(user.address)).to.equal(1000)
  })
})
