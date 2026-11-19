// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// The agent's smart account. The owner (a person) holds full control. The AI agent holds only a
// SESSION KEY, and the chain enforces what that key may do: a spend cap, an expiry, and a recipient
// allowlist. The agent signs a typed action; anyone may relay it (the agent needs no gas). A prompt
// injection that makes the agent sign "pay 0xBad 10,000" is refused here, on-chain, whatever the model did.

interface IERC20A {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract AgentAccount {
    struct Session {
        uint128 cap;
        uint128 spent;
        uint64 expiry;
        uint64 nonce;
        bool active;
    }

    uint8 public constant KIND_TRANSFER = 0;
    uint8 public constant KIND_CALL = 1;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant SESSION_ACTION_TYPEHASH =
        keccak256("SessionAction(uint8 kind,address target,uint256 amount,bytes32 dataHash,uint256 nonce,uint256 deadline)");
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    address public immutable owner;
    address public immutable token;
    mapping(address => Session) public sessions;
    mapping(address => mapping(address => bool)) private _allowed;

    event SessionGranted(address indexed key, uint256 cap, uint64 expiry, address[] recipients);
    event SessionRevoked(address indexed key);
    event SessionSpent(address indexed key, uint8 kind, address indexed target, uint256 amount, uint256 spentTotal, uint64 nonce);
    event OwnerExecuted(address indexed target, uint256 value, bytes32 dataHash);

    error NotOwner();
    error ZeroAddress();
    error KeyAlreadyUsed();
    error BadExpiry();
    error SessionNotActive();
    error SessionExpired();
    error ActionExpired();
    error BadSignature();
    error RecipientNotAllowed(address target);
    error OverCap(uint256 remaining, uint256 requested);
    error BadKind();
    error TokenCallForbidden();
    error TransferFailed();
    error CallFailed(bytes reason);

    constructor(address owner_, address token_) {
        if (owner_ == address(0) || token_ == address(0)) revert ZeroAddress();
        owner = owner_;
        token = token_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ── owner: grant / revoke a session key, or act directly ────────────────

    // One key, one session, forever: a key is never re-granted, so old signatures can never come back.
    function grantSession(address key, uint128 cap, uint64 expiry, address[] calldata recipients) external onlyOwner {
        if (key == address(0)) revert ZeroAddress();
        if (sessions[key].expiry != 0) revert KeyAlreadyUsed();
        if (expiry <= block.timestamp) revert BadExpiry();
        sessions[key] = Session({cap: cap, spent: 0, expiry: expiry, nonce: 0, active: true});
        for (uint256 i = 0; i < recipients.length; i++) {
            _allowed[key][recipients[i]] = true;
        }
        emit SessionGranted(key, cap, expiry, recipients);
    }

    function revokeSession(address key) external onlyOwner {
        sessions[key].active = false;
        emit SessionRevoked(key);
    }

    function execute(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit OwnerExecuted(target, value, keccak256(data));
        return ret;
    }

    // ── the agent: a signed, scoped action, relayed by anyone ───────────────

    function executeSession(
        address key,
        uint8 kind,
        address target,
        uint256 amount,
        bytes calldata data,
        uint256 deadline,
        bytes calldata signature
    ) external returns (bytes memory ret) {
        Session storage s = sessions[key];
        bytes32 digest = actionDigest(kind, target, amount, keccak256(data), s.nonce, deadline);
        // A junk signature recovers address(0). A caller who names key 0 gets past this line, but key 0 is
        // never granted (grantSession refuses it), so the next line stops it: no session, no spend.
        if (_recover(digest, signature) != key) revert BadSignature();
        if (!s.active) revert SessionNotActive();
        if (block.timestamp > s.expiry) revert SessionExpired();
        if (block.timestamp > deadline) revert ActionExpired();
        if (!_allowed[key][target]) revert RecipientNotAllowed(target);
        uint256 left = uint256(s.cap) - uint256(s.spent);
        if (amount > left) revert OverCap(left, amount);

        s.nonce += 1;
        s.spent += uint128(amount);

        if (kind == KIND_TRANSFER) {
            if (data.length != 0) revert BadKind();
            _call(token, abi.encodeWithSelector(IERC20A.transfer.selector, target, amount));
        } else if (kind == KIND_CALL) {
            if (target == token) revert TokenCallForbidden();
            _call(token, abi.encodeWithSelector(IERC20A.approve.selector, target, amount));
            bool ok;
            (ok, ret) = target.call(data);
            if (!ok) revert CallFailed(ret);
            _call(token, abi.encodeWithSelector(IERC20A.approve.selector, target, 0));
        } else {
            revert BadKind();
        }
        emit SessionSpent(key, kind, target, amount, s.spent, s.nonce);
    }

    // ── views ────────────────────────────────────────────────────────────────

    function isAllowed(address key, address recipient) external view returns (bool) {
        return _allowed[key][recipient];
    }

    function remaining(address key) external view returns (uint256) {
        Session storage s = sessions[key];
        if (!s.active || block.timestamp > s.expiry) return 0;
        return uint256(s.cap) - uint256(s.spent);
    }

    function actionDigest(uint8 kind, address target, uint256 amount, bytes32 dataHash, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(SESSION_ACTION_TYPEHASH, kind, target, amount, dataHash, nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("KarAgentAccount"), keccak256("1"), block.chainid, address(this)));
    }

    // ERC-1271: the account signs as its owner. This is how the ERC-8004 registry binds this account
    // as the agent's payment wallet (setAgentWallet).
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (_recover(hash, signature) == owner) return ERC1271_MAGIC;
        return 0xffffffff;
    }

    receive() external payable {}

    // ── internals ────────────────────────────────────────────────────────────

    function _call(address to, bytes memory data) private {
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    // ecrecover gives address(0) for a bad v or an unrecoverable signature. A malleated (high-s) copy of
    // a session signature is harmless: the action it signs consumes the nonce the first time it runs.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        return ecrecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
    }
}
