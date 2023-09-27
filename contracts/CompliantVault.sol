// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import {Functions, FunctionsClient} from "./dev/functions/FunctionsClient.sol";
import {ConfirmedOwner} from "@chainlink/contracts/src/v0.8/ConfirmedOwner.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title ETH Vault with Chainalysis screening
 * @notice Deposits and withdrawals are checked for compliance before processing
 * @notice This contract is a demonstration of using Functions
 * @notice NOT FOR PRODUCTION USE
 */
contract CompliantVault is FunctionsClient, ConfirmedOwner {
  using Functions for Functions.Request;

  string private constant DEPOSIT_ACTION_ID = "0";
  string private constant WITHDRAWAL_ACTION_ID = "1";

  mapping(address => uint256) private s_balances;
  mapping(bytes32 => PendingRequest) private s_pending;

  struct PendingRequest {
    address requester;
    uint256 amount;
    RequestType requestType;
  }

  enum RequestType {
    Deposit,
    Withdrawal
  }

  // CHAINLINK FUNCTIONS

  string private s_source;
  bytes private s_secrets;
  uint64 private s_subscriptionId;
  uint32 private s_gasLimit;

  // EVENTS

  event DepositRequest(bytes32 indexed requestId, address requester, uint256 amount);
  event WithdrawalRequest(bytes32 indexed requestId, address requester, uint256 amount);
  event DepositRequestFulfilled(bytes32 indexed requestId, address requester, uint256 amount);
  event WithdrawalRequestFulfilled(bytes32 indexed requestId, address requester, uint256 amount);
  event DepositRequestCancelled(bytes32 indexed requestId, address requester, uint256 amount);
  event WithdrawalRequestCancelled(bytes32 indexed requestId, address requester, uint256 amount);
  event RequestFailed(bytes message);
  event UnknownRequestType();
  event NoPendingRequest();

  // ERRORS

  error ZeroAmount();
  error InsufficientBalance();

  // CONSTRUCTOR

  /**
   * @notice Executes once when a contract is created to initialize state variables
   *
   * @param oracle The FunctionsOracle contract
   * @param subscriptionId The ID of the Functions billing subscription
   * @param source JavaScript source code
   * @param secrets Encrypted secrets
   * @param gasLimit Maximum amount of gas used to call back the client contract
   */
  constructor(
    address oracle,
    uint64 subscriptionId,
    string memory source,
    bytes memory secrets,
    uint32 gasLimit
  ) FunctionsClient(oracle) ConfirmedOwner(msg.sender) {
    s_subscriptionId = subscriptionId;
    s_source = source;
    s_secrets = secrets;
    s_gasLimit = gasLimit;
  }

  // EXTERNAL

  /**
   * @notice Request address screening from Chainalysis and deposit ETH into the vault
   *
   * @dev The amount deposited will be credited to the user's balance once the request is fulfilled.
   * If the address screening fails, the amount will be refunded to the user.
   */
  function requestDeposit() external payable {
    if (msg.value == 0) revert ZeroAmount();

    string[] memory args = new string[](2);
    args[0] = DEPOSIT_ACTION_ID;
    args[1] = Strings.toHexString(msg.sender);
    bytes32 requestId = executeRequest(s_source, s_secrets, args, s_subscriptionId, s_gasLimit);

    s_pending[requestId] = PendingRequest(msg.sender, msg.value, RequestType.Deposit);
    emit DepositRequest(requestId, msg.sender, msg.value);
  }

  /**
   * @notice Request withdrawal attempt checking from Chainalysis KYT and withdraw ETH from the vault
   *
   * @dev The amount withdrawn will be transferred to the user's address once the request is fulfilled.
   * If the address screening fails, the amount will remain in the vault.
   *
   * @param amount The amount of ETH to withdraw
   */
  function requestWithdrawal(uint256 amount) external {
    if (amount == 0) revert ZeroAmount();
    if (amount > s_balances[msg.sender]) revert InsufficientBalance();

    string[] memory args = new string[](3);
    args[0] = WITHDRAWAL_ACTION_ID;
    args[1] = Strings.toHexString(msg.sender);
    args[2] = Strings.toString(amount);
    bytes32 requestId = executeRequest(s_source, s_secrets, args, s_subscriptionId, s_gasLimit);

    s_pending[requestId] = PendingRequest(msg.sender, amount, RequestType.Withdrawal);
    emit WithdrawalRequest(requestId, msg.sender, amount);
  }

  /**
   * @notice Check user's balance in the vault
   */
  function balanceOf(address user) external view returns (uint256) {
    return s_balances[user];
  }

  // INTERNAL

  /**
   * @notice Process a deposit request once it has been fulfilled
   *
   * @param user The user who requested the deposit
   * @param amount The amount of ETH to deposit
   */
  function executeDeposit(address user, uint256 amount) internal {
    s_balances[user] += amount;
  }

  /**
   * @notice Process a withdrawal request once it has been fulfilled
   *
   * @param user The user who requested the withdrawal
   * @param amount The amount of ETH to withdraw
   */
  function executeWithdraw(address user, uint256 amount) internal {
    s_balances[user] -= amount;
    payable(user).transfer(amount);
  }

  /**
   * @notice Send a request to Chainlink Functions
   *
   * @param source JavaScript source code
   * @param secrets Encrypted secrets payload
   * @param args List of arguments accessible from within the source code
   * @param subscriptionId Funtions billing subscription ID
   * @param gasLimit Maximum amount of gas used to call the client contract's `handleOracleFulfillment` function
   * @return requestId Functions request ID
   */
  function executeRequest(
    string memory source,
    bytes memory secrets,
    string[] memory args,
    uint64 subscriptionId,
    uint32 gasLimit
  ) internal returns (bytes32 requestId) {
    Functions.Request memory req;
    req.initializeRequest(Functions.Location.Inline, Functions.CodeLanguage.JavaScript, source);
    if (secrets.length > 0) {
      req.addRemoteSecrets(secrets);
    }
    if (args.length > 0) req.addArgs(args);
    requestId = sendRequest(req, subscriptionId, gasLimit);
  }

  /**
   * @notice Callback that is invoked once the DON has resolved the request or hit an error
   *
   * @param requestId The request ID, returned by sendRequest()
   * @param response Aggregated response from the user code
   * @param err Aggregated error from the user code or from the execution pipeline
   * Either response or error parameter will be set, but never both
   */
  function fulfillRequest(bytes32 requestId, bytes memory response, bytes memory err) internal override {
    PendingRequest memory request = s_pending[requestId];
    if (request.requester == address(0)) {
      emit NoPendingRequest();
      return;
    }
    delete s_pending[requestId];
    if (err.length > 0) {
      emit RequestFailed(err);
      return;
    }
    if (request.requestType == RequestType.Deposit) {
      if (uint256(bytes32(response)) == 1) {
        executeDeposit(request.requester, request.amount);
        emit DepositRequestFulfilled(requestId, request.requester, request.amount);
      } else {
        payable(request.requester).transfer(request.amount);
        emit DepositRequestCancelled(requestId, request.requester, request.amount);
      }
    } else if (request.requestType == RequestType.Withdrawal) {
      if (uint256(bytes32(response)) == 1) {
        executeWithdraw(request.requester, request.amount);
        emit WithdrawalRequestFulfilled(requestId, request.requester, request.amount);
      } else {
        emit WithdrawalRequestCancelled(requestId, request.requester, request.amount);
      }
    } else {
      emit UnknownRequestType();
    }
  }

  // OWNER

  /**
   * @notice Allows the Functions oracle address to be updated
   *
   * @param oracle New oracle address
   */
  function updateOracleAddress(address oracle) external onlyOwner {
    setOracle(oracle);
  }

  /**
   * @notice Allows the Functions billing subscription ID to be updated
   *
   * @param subscriptionId New subscription ID
   */
  function updateSubscriptionId(uint64 subscriptionId) external onlyOwner {
    s_subscriptionId = subscriptionId;
  }

  /**
   * @notice Allows the Functions source code to be updated
   *
   * @param source New source code
   */
  function updateSource(string calldata source) external onlyOwner {
    s_source = source;
  }

  /**
   * @notice Allows the Functions encrypted secrets  to be updated
   *
   * @param secrets New encrypted secrets
   */
  function updateSecrets(bytes calldata secrets) external onlyOwner {
    s_secrets = secrets;
  }
}
