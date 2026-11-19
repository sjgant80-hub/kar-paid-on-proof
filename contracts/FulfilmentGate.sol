// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// FulfilmentGate: settlement that waits for proof.
//
// A buyer agent (its ERC-8004 agentWallet) escrows tUSD8 against a Fallmarket listing, committing to the
// question and to the exact source documents (sourcesRoot). The worker submits a deliverable: an answer
// made ONLY of phrases copied from those sources, each with byte offsets. The money moves only if BOTH:
//   1. the listing's validator (the DocDec verifier) has answered PASS for this exact deliverable in the
//      ERC-8004 Validation Registry, and
//   2. the chain itself re-runs the verbatim check: the sources hash to the committed root, and the
//      answer equals the cited byte ranges of those sources, joined by single spaces.
// Otherwise release() reverts and the escrow stays put; a FAIL verdict (or the deadline) refunds the buyer.
// What this proves: the answer's exact words sit at the stated offsets of the committed sources, and the
// named verifier signed off. It does not prove the answer is the best one, or that the sources are true.

interface IERC20G {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IIdentityRegistryG {
    function getAgentWallet(uint256 agentId) external view returns (address);
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}

interface IValidationRegistryG {
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate);
}

interface IFallmarketG {
    function isLive(uint256 listingId) external view returns (bool);
    function getListing(uint256 listingId)
        external
        view
        returns (uint256 workerAgentId, address validator, uint256 price, uint64 expiry, bool active, string memory termsURI);
}

contract FulfilmentGate {
    struct Claim {
        uint32 doc;
        uint32 start;
        uint32 end;
    }

    enum State {
        None,
        Open,
        Submitted,
        Released,
        Refunded
    }

    struct Job {
        uint256 listingId;
        uint256 buyerAgentId;
        uint256 workerAgentId;
        address buyer;
        address validator;
        uint256 amount;
        bytes32 questionHash;
        bytes32 sourcesRoot;
        bytes32 deliverableHash;
        uint64 deadline;
        State state;
    }

    uint8 public constant PASS = 100;
    uint64 public constant MAX_DURATION = 7 days;
    uint256 public constant MAX_DOCS = 16;
    uint256 public constant MAX_CLAIMS = 8;

    address public immutable token;
    address public immutable identity;
    address public immutable validation;
    address public immutable market;

    uint256 public jobCount;
    mapping(uint256 => Job) private _jobs;

    event JobOpened(uint256 indexed jobId, uint256 indexed listingId, uint256 indexed buyerAgentId, uint256 amount, bytes32 sourcesRoot, uint64 deadline);
    event DeliverableSubmitted(uint256 indexed jobId, bytes32 deliverableHash, bytes32 requestHash, string deliverableURI);
    event Released(uint256 indexed jobId, address indexed to, uint256 amount, bytes32 requestHash, uint256 claims);
    event Refunded(uint256 indexed jobId, address indexed to, uint256 amount, string reason);

    error ZeroAddress();
    error ListingNotLive();
    error NotAgentWallet();
    error EmptyHash();
    error BadDeadline();
    error NoSuchJob();
    error BadState();
    error PastDeadline();
    error NotAuthorized();
    error NotValidated(uint8 response);
    error BadSources();
    error SourcesMismatch();
    error DeliverableMismatch();
    error NoClaims();
    error BadClaim(uint256 index);
    error NotVerbatim();
    error WorkerWalletUnset();
    error NotRefundable();
    error TransferFailed();

    constructor(address token_, address identity_, address validation_, address market_) {
        if (token_ == address(0) || identity_ == address(0) || validation_ == address(0) || market_ == address(0)) {
            revert ZeroAddress();
        }
        token = token_;
        identity = identity_;
        validation = validation_;
        market = market_;
    }

    // ── 1. the buyer agent takes a job: escrow the listing price ────────────

    function openJob(uint256 listingId, uint256 buyerAgentId, bytes32 questionHash, bytes32 sourcesRoot, uint64 deadline)
        external
        returns (uint256 jobId)
    {
        if (!IFallmarketG(market).isLive(listingId)) revert ListingNotLive();
        if (IIdentityRegistryG(identity).getAgentWallet(buyerAgentId) != msg.sender) revert NotAgentWallet();
        if (questionHash == bytes32(0) || sourcesRoot == bytes32(0)) revert EmptyHash();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_DURATION) revert BadDeadline();
        jobId = ++jobCount;
        Job storage j = _jobs[jobId];
        (j.workerAgentId, j.validator, j.amount,,,) = IFallmarketG(market).getListing(listingId);
        j.listingId = listingId;
        j.buyerAgentId = buyerAgentId;
        j.buyer = msg.sender;
        j.questionHash = questionHash;
        j.sourcesRoot = sourcesRoot;
        j.deadline = deadline;
        j.state = State.Open;
        _pull(msg.sender, j.amount);
        emit JobOpened(jobId, listingId, buyerAgentId, j.amount, sourcesRoot, deadline);
    }

    // ── 2. the worker commits to its deliverable (may resubmit until released) ──

    function submit(uint256 jobId, bytes32 deliverableHash, string calldata deliverableURI) external {
        Job storage j = _get(jobId);
        if (j.state != State.Open && j.state != State.Submitted) revert BadState();
        if (block.timestamp > j.deadline) revert PastDeadline();
        if (!IIdentityRegistryG(identity).isAuthorizedOrOwner(msg.sender, j.workerAgentId)) revert NotAuthorized();
        if (deliverableHash == bytes32(0)) revert EmptyHash();
        j.deliverableHash = deliverableHash;
        j.state = State.Submitted;
        emit DeliverableSubmitted(jobId, deliverableHash, requestHashOf(jobId, deliverableHash), deliverableURI);
    }

    // ── 3. release on proof, or revert ──────────────────────────────────────

    function release(uint256 jobId, bytes[] calldata docs, bytes calldata answer, Claim[] calldata claims) external {
        Job storage j = _get(jobId);
        if (j.state != State.Submitted) revert BadState();
        bytes32 h = requestHashOf(jobId, j.deliverableHash);
        (bool ok, uint8 response) = _verdict(j, h);
        if (!ok || response < PASS) revert NotValidated(response);
        _checkGrounded(j, docs, answer, claims);
        address to = IIdentityRegistryG(identity).getAgentWallet(j.workerAgentId);
        if (to == address(0)) revert WorkerWalletUnset();
        j.state = State.Released;
        _push(to, j.amount);
        emit Released(jobId, to, j.amount, h, claims.length);
    }

    // ── 4. refund: the verifier said FAIL, or the deadline passed ──────────

    function refund(uint256 jobId) external {
        Job storage j = _get(jobId);
        if (j.state != State.Open && j.state != State.Submitted) revert BadState();
        string memory reason;
        if (block.timestamp > j.deadline) {
            reason = "deadline";
        } else {
            if (j.state != State.Submitted) revert NotRefundable();
            (bool ok, uint8 response) = _verdict(j, requestHashOf(jobId, j.deliverableHash));
            if (!ok || response >= PASS) revert NotRefundable();
            reason = "failed-validation";
        }
        j.state = State.Refunded;
        _push(j.buyer, j.amount);
        emit Refunded(jobId, j.buyer, j.amount, reason);
    }

    // ── views ────────────────────────────────────────────────────────────────

    function requestHashOf(uint256 jobId, bytes32 deliverableHash) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), jobId, deliverableHash));
    }

    function deliverableHashOf(bytes32 questionHash, bytes calldata answer, Claim[] calldata claims) public pure returns (bytes32) {
        return keccak256(abi.encode(questionHash, keccak256(answer), claims));
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _get(jobId);
    }

    // ── internals ────────────────────────────────────────────────────────────

    // ok = the job's own validator has answered, for the job's own worker; response = its 0..100 verdict.
    function _verdict(Job storage j, bytes32 h) private view returns (bool ok, uint8 response) {
        (address v, uint256 agentId, uint8 r,,, uint256 lastUpdate) = IValidationRegistryG(validation).getValidationStatus(h);
        ok = v == j.validator && agentId == j.workerAgentId && lastUpdate != 0;
        response = r;
    }

    function _checkGrounded(Job storage j, bytes[] calldata docs, bytes calldata answer, Claim[] calldata claims) private view {
        if (docs.length == 0 || docs.length > MAX_DOCS) revert BadSources();
        bytes32[] memory hs = new bytes32[](docs.length);
        for (uint256 i = 0; i < docs.length; i++) {
            hs[i] = keccak256(docs[i]);
        }
        if (keccak256(abi.encode(hs)) != j.sourcesRoot) revert SourcesMismatch();
        if (deliverableHashOf(j.questionHash, answer, claims) != j.deliverableHash) revert DeliverableMismatch();
        if (claims.length == 0 || claims.length > MAX_CLAIMS) revert NoClaims();
        bytes memory rebuilt = "";
        for (uint256 i = 0; i < claims.length; i++) {
            Claim calldata c = claims[i];
            if (c.doc >= docs.length || c.start >= c.end || c.end > docs[c.doc].length) revert BadClaim(i);
            if (i > 0) rebuilt = bytes.concat(rebuilt, " ");
            rebuilt = bytes.concat(rebuilt, docs[c.doc][c.start:c.end]);
        }
        if (keccak256(rebuilt) != keccak256(answer)) revert NotVerbatim();
    }

    function _get(uint256 jobId) private view returns (Job storage j) {
        j = _jobs[jobId];
        if (j.state == State.None) revert NoSuchJob();
    }

    // The balance delta is the only thing trusted: a reverted call, a `false` return, a fee skimmed on
    // transfer and a silent no-op all leave it short of `amount` (the price is never 0), so one check
    // covers them all. A separate return-value check here would be dead code behind this one.
    function _pull(address from, uint256 amount) private {
        uint256 before = IERC20G(token).balanceOf(address(this));
        (bool sent,) = token.call(abi.encodeWithSelector(IERC20G.transferFrom.selector, from, address(this), amount));
        sent;
        if (IERC20G(token).balanceOf(address(this)) - before != amount) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20G.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
