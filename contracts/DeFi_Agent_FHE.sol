pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DeFiAgentFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public batchClosed;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted state for a user
    struct UserPortfolioState {
        euint32 totalValueEncrypted; // Encrypted total portfolio value
        euint32 riskPreferenceEncrypted; // Encrypted risk preference (e.g., 1-5)
        euint32 targetAllocation1Encrypted; // Encrypted target allocation for asset 1
        euint32 targetAllocation2Encrypted; // Encrypted target allocation for asset 2
        euint32 currentAllocation1Encrypted; // Encrypted current allocation for asset 1
        euint32 currentAllocation2Encrypted; // Encrypted current allocation for asset 2
    }
    mapping(address => UserPortfolioState) public userStates;

    // Encrypted aggregated results for a batch
    struct BatchAggregatedResults {
        euint32 totalValueSumEncrypted;
        euint32 riskPreferenceSumEncrypted;
        euint32 rebalanceAmount1Encrypted; // Encrypted amount to rebalance for asset 1
        euint32 rebalanceAmount2Encrypted; // Encrypted amount to rebalance for asset 2
    }
    mapping(uint256 => BatchAggregatedResults) public batchResults;

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event PortfolioDataSubmitted(address indexed user, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalValueSum, uint256 riskPreferenceSum, uint256 rebalanceAmount1, uint256 rebalanceAmount2);

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[owner] = true;
        emit ProviderAdded(owner);
        currentBatchId = 1; // Start with batch 1
        cooldownSeconds = 60; // Default 1 minute cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused) {
            paused = true;
            emit ContractPaused(msg.sender);
        } else {
            paused = false;
            emit ContractUnpaused(msg.sender);
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        // New batch is open by default, no need to set batchClosed[currentBatchId] = false explicitly
        emit BatchOpened(currentBatchId);
    }

    function closeCurrentBatch() external onlyOwner whenNotPaused {
        if (currentBatchId == 0 || batchClosed[currentBatchId]) revert BatchClosedOrInvalid();
        batchClosed[currentBatchId] = true;
        emit BatchClosed(currentBatchId);
    }

    function submitPortfolioData(
        euint32 totalValueEncrypted,
        euint32 riskPreferenceEncrypted,
        euint32 targetAllocation1Encrypted,
        euint32 targetAllocation2Encrypted,
        euint32 currentAllocation1Encrypted,
        euint32 currentAllocation2Encrypted
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batchClosed[currentBatchId]) revert BatchClosedOrInvalid();

        lastSubmissionTime[msg.sender] = block.timestamp;

        UserPortfolioState storage state = userStates[msg.sender];
        state.totalValueEncrypted = totalValueEncrypted;
        state.riskPreferenceEncrypted = riskPreferenceEncrypted;
        state.targetAllocation1Encrypted = targetAllocation1Encrypted;
        state.targetAllocation2Encrypted = targetAllocation2Encrypted;
        state.currentAllocation1Encrypted = currentAllocation1Encrypted;
        state.currentAllocation2Encrypted = currentAllocation2Encrypted;

        // Initialize batch results if this is the first submission for the batch
        BatchAggregatedResults storage results = batchResults[currentBatchId];
        if (!FHE.isInitialized(results.totalValueSumEncrypted)) {
            results.totalValueSumEncrypted = FHE.asEuint32(0);
            results.riskPreferenceSumEncrypted = FHE.asEuint32(0);
            results.rebalanceAmount1Encrypted = FHE.asEuint32(0);
            results.rebalanceAmount2Encrypted = FHE.asEuint32(0);
        }

        // Aggregate data (homomorphically)
        results.totalValueSumEncrypted = results.totalValueSumEncrypted.add(totalValueEncrypted);
        results.riskPreferenceSumEncrypted = results.riskPreferenceSumEncrypted.add(riskPreferenceEncrypted);

        // AI Logic (simplified): Calculate rebalance amounts based on target vs current allocations
        // This is a placeholder for more complex FHE logic
        euint32 diff1 = targetAllocation1Encrypted.sub(currentAllocation1Encrypted);
        euint32 diff2 = targetAllocation2Encrypted.sub(currentAllocation2Encrypted);
        results.rebalanceAmount1Encrypted = results.rebalanceAmount1Encrypted.add(diff1);
        results.rebalanceAmount2Encrypted = results.rebalanceAmount2Encrypted.add(diff2);

        emit PortfolioDataSubmitted(msg.sender, currentBatchId);
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused {
        if (batchClosed[batchId] == false) revert BatchClosedOrInvalid(); // Must be closed to decrypt
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        BatchAggregatedResults storage results = batchResults[batchId];
        _requireInitialized(results.totalValueSumEncrypted, "Batch results not initialized");

        // 1. Prepare Ciphertexts
        bytes32[] memory cts = new bytes32[](4);
        cts[0] = FHE.toBytes32(results.totalValueSumEncrypted);
        cts[1] = FHE.toBytes32(results.riskPreferenceSumEncrypted);
        cts[2] = FHE.toBytes32(results.rebalanceAmount1Encrypted);
        cts[3] = FHE.toBytes32(results.rebalanceAmount2Encrypted);

        // 2. Compute State Hash
        bytes32 stateHash = keccak256(abi.encode(cts, address(this)));

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });

        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // 5a. Replay Guard
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // 5b. State Verification
        // Rebuild cts array from current contract storage in the exact same order
        DecryptionContext memory context = decryptionContexts[requestId];
        BatchAggregatedResults storage results = batchResults[context.batchId];
        _requireInitialized(results.totalValueSumEncrypted, "Batch results not initialized during callback");

        bytes32[] memory currentCts = new bytes32[](4);
        currentCts[0] = FHE.toBytes32(results.totalValueSumEncrypted);
        currentCts[1] = FHE.toBytes32(results.riskPreferenceSumEncrypted);
        currentCts[2] = FHE.toBytes32(results.rebalanceAmount1Encrypted);
        currentCts[3] = FHE.toBytes32(results.rebalanceAmount2Encrypted);

        bytes32 currentStateHash = keccak256(abi.encode(currentCts, address(this)));
        if (currentStateHash != context.stateHash) revert StateMismatch();
        // Security: This ensures that the ciphertexts being decrypted are exactly those that were committed to
        // when the decryption was requested, preventing certain classes of attacks.

        // 5c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        // 5d. Decode & Finalize
        // Cleartexts are expected in the same order as cts
        uint256 totalValueSum = abi.decode(cleartexts[0:32], (uint256));
        uint256 riskPreferenceSum = abi.decode(cleartexts[32:64], (uint256));
        uint256 rebalanceAmount1 = abi.decode(cleartexts[64:96], (uint256));
        uint256 rebalanceAmount2 = abi.decode(cleartexts[96:128], (uint256));

        context.processed = true;
        decryptionContexts[requestId] = context; // Update storage

        emit DecryptionCompleted(requestId, context.batchId, totalValueSum, riskPreferenceSum, rebalanceAmount1, rebalanceAmount2);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage cipher, uint256 value) internal {
        if (!FHE.isInitialized(cipher)) {
            cipher = FHE.asEuint32(value);
        }
    }

    function _requireInitialized(euint32 cipher, string memory message) internal view {
        if (!FHE.isInitialized(cipher)) revert NotInitialized();
    }
}