const RequestType = {
  Deposit: 0,
  Withdrawal: 1,
}

const requestType = Number(args[0])
const address = args[1]
const amount = args[2]

if (secrets.apiKey == "") {
  throw Error("CHAINALYSIS_API_KEY environment variable not set for Chainalysis API")
}

switch (requestType) {
  case RequestType.Deposit: {
    return checkDeposit(address)
  }
  case RequestType.Withdrawal: {
    return checkWithdrawal(address, amount)
  }
  default:
    throw new Error("Invalid request type")
}

async function checkDeposit(address) {
  const registerResponse = await Functions.makeHttpRequest({
    method: "POST",
    url: "https://api.chainalysis.com/api/risk/v2/entities",
    headers: { Token: secrets.apiKey },
    data: { address },
  })
  if (registerResponse.status !== 201) {
    throw Error(registerResponse.statusText || registerResponse.status)
  }

  const riskResponse = await Functions.makeHttpRequest({
    url: `https://api.chainalysis.com/api/risk/v2/entities/${address}`,
    headers: { Token: secrets.apiKey },
  })
  if (riskResponse.status !== 200) {
    throw Error(riskResponse.statusText || riskResponse.status)
  }

  const isCompliant = riskResponse.data.risk === "Low" ? 1 : 0

  return Functions.encodeUint256(isCompliant)
}

async function checkWithdrawal(address, amount) {
  const userId = "user" + generateRandomSequence()
  const attemptIdentifier = "attempt" + generateRandomSequence()
  const attemptTimestamp = new Date().toISOString().replace("Z", "")
  const assetAmount = amount / 10 ** 18

  const registrationResponse = await Functions.makeHttpRequest({
    method: "POST",
    url: `https://api.chainalysis.com/api/kyt/v2/users/${userId}/withdrawal-attempts`,
    headers: { Token: secrets.apiKey },
    data: {
      network: "Ethereum",
      asset: "ETH",
      address,
      attemptIdentifier,
      assetAmount,
      attemptTimestamp,
    },
  })
  if (registrationResponse.status !== 202) {
    throw Error(registrationResponse.statusText || registrationResponse.status)
  }
  const id = registrationResponse.data.externalId

  const exposuresResponse = await Functions.makeHttpRequest({
    url: `https://api.chainalysis.com/api/kyt/v2/withdrawal-attempts/${id}/exposures`,
    headers: { Token: secrets.apiKey },
  })
  if (exposuresResponse.status !== 200) {
    throw Error(exposuresResponse.statusText || exposuresResponse.status)
  }
  const hasDirectExposure = exposuresResponse.data.direct.name !== null

  const alertsResponse = await Functions.makeHttpRequest({
    url: `https://api.chainalysis.com/api/kyt/v2/withdrawal-attempts/${id}/alerts`,
    headers: { Token: secrets.apiKey },
  })
  if (alertsResponse.status !== 200) {
    throw Error(alertsResponse.statusText || alertsResponse.status)
  }
  const hasAlerts = alertsResponse.data.alerts.length > 0

  const isCompliant = !hasDirectExposure && !hasAlerts ? 1 : 0

  return Functions.encodeUint256(isCompliant)
}

function generateRandomSequence() {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let sequence = ""

  for (let i = 0; i < 5; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length)
    const randomChar = characters.charAt(randomIndex)
    sequence += randomChar
  }

  return sequence
}
