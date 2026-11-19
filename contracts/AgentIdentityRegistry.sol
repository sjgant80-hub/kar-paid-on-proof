// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ERC-8004 Identity Registry (Draft, eips.ethereum.org/EIPS/eip-8004), written for this build.
// Interfaces, events and the AgentWalletSet EIP-712 type follow the spec and the reference
// contracts (github.com/erc-8004/erc-8004-contracts, CC0 spec / MIT code) so ERC-8004 tools can read it.
// Differences from the reference: not upgradeable, no OpenZeppelin (Shanghai EVM: no MCOPY), ids start at 1.

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

contract AgentIdentityRegistry {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    string public constant name = "AgentIdentity";
    string public constant symbol = "AGENT";

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    error NotAuthorized();
    error NoSuchAgent();
    error ReservedKey();
    error ZeroAddress();
    error WrongFrom();
    error DeadlineExpired();
    error DeadlineTooFar();
    error BadSignature();
    error UnsafeRecipient();

    bytes32 private constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant RESERVED_KEY_HASH = keccak256("agentWallet");
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 public constant MAX_DEADLINE_DELAY = 5 minutes;

    uint256 public agentCount;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(uint256 => string) private _uris;
    mapping(uint256 => mapping(string => bytes)) private _metadata;
    mapping(uint256 => address) private _wallets;

    // ── registration ─────────────────────────────────────────────────────────

    function register() external returns (uint256 agentId) {
        agentId = _mintAgent("");
        emit Registered(agentId, "", msg.sender);
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _mintAgent(agentURI);
        emit Registered(agentId, agentURI, msg.sender);
    }

    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId) {
        agentId = _mintAgent(agentURI);
        for (uint256 i = 0; i < metadata.length; i++) {
            if (keccak256(bytes(metadata[i].metadataKey)) == RESERVED_KEY_HASH) revert ReservedKey();
            _metadata[agentId][metadata[i].metadataKey] = metadata[i].metadataValue;
            emit MetadataSet(agentId, metadata[i].metadataKey, metadata[i].metadataKey, metadata[i].metadataValue);
        }
        emit Registered(agentId, agentURI, msg.sender);
    }

    function _mintAgent(string memory agentURI) private returns (uint256 agentId) {
        agentId = ++agentCount;
        _owners[agentId] = msg.sender;
        _balances[msg.sender] += 1;
        _uris[agentId] = agentURI;
        emit Transfer(address(0), msg.sender, agentId);
        _wallets[agentId] = msg.sender;
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(msg.sender));
    }

    // ── agent URI + metadata ─────────────────────────────────────────────────

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _requireAuthorized(msg.sender, agentId);
        _uris[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function tokenURI(uint256 agentId) external view returns (string memory) {
        _requireExists(agentId);
        return _uris[agentId];
    }

    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        _requireExists(agentId);
        if (keccak256(bytes(metadataKey)) == RESERVED_KEY_HASH) return abi.encodePacked(_wallets[agentId]);
        return _metadata[agentId][metadataKey];
    }

    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external {
        _requireAuthorized(msg.sender, agentId);
        if (keccak256(bytes(metadataKey)) == RESERVED_KEY_HASH) revert ReservedKey();
        _metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    // ── the agent's payment wallet (reserved key `agentWallet`) ──────────────

    function getAgentWallet(uint256 agentId) external view returns (address) {
        _requireExists(agentId);
        return _wallets[agentId];
    }

    // The owner proves control of newWallet: an EIP-712 signature from an EOA, or ERC-1271 from a contract.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external {
        _requireAuthorized(msg.sender, agentId);
        if (newWallet == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (deadline > block.timestamp + MAX_DEADLINE_DELAY) revert DeadlineTooFar();
        bytes32 digest = walletDigest(agentId, newWallet, deadline);
        if (newWallet.code.length == 0) {
            if (_recover(digest, signature) != newWallet) revert BadSignature();
        } else {
            try IERC1271(newWallet).isValidSignature(digest, signature) returns (bytes4 magic) {
                if (magic != ERC1271_MAGIC) revert BadSignature();
            } catch {
                revert BadSignature();
            }
        }
        _wallets[agentId] = newWallet;
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(newWallet));
    }

    function unsetAgentWallet(uint256 agentId) external {
        _requireAuthorized(msg.sender, agentId);
        _wallets[agentId] = address(0);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", "");
    }

    function walletDigest(uint256 agentId, address newWallet, uint256 deadline) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, _owners[agentId], deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("ERC8004IdentityRegistry"), keccak256("1"), block.chainid, address(this))
        );
    }

    // ── ERC-721 ──────────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return _balances[owner];
    }

    function ownerOf(uint256 agentId) public view returns (address owner) {
        owner = _owners[agentId];
        if (owner == address(0)) revert NoSuchAgent();
    }

    function approve(address to, uint256 agentId) external {
        address owner = ownerOf(agentId);
        if (msg.sender != owner) {
            if (!_operatorApprovals[owner][msg.sender]) revert NotAuthorized();
        }
        _tokenApprovals[agentId] = to;
        emit Approval(owner, to, agentId);
    }

    function getApproved(uint256 agentId) external view returns (address) {
        _requireExists(agentId);
        return _tokenApprovals[agentId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) public view returns (bool) {
        address owner = ownerOf(agentId);
        if (spender == owner) return true;
        if (_operatorApprovals[owner][spender]) return true;
        address approved = _tokenApprovals[agentId];
        return approved != address(0) && approved == spender;
    }

    function transferFrom(address from, address to, uint256 agentId) public {
        if (to == address(0)) revert ZeroAddress();
        address owner = ownerOf(agentId);
        if (owner != from) revert WrongFrom();
        if (!isAuthorizedOrOwner(msg.sender, agentId)) revert NotAuthorized();
        delete _tokenApprovals[agentId];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[agentId] = to;
        // ERC-8004: the payment wallet does not travel with the identity; the new owner re-verifies one.
        _wallets[agentId] = address(0);
        emit Transfer(from, to, agentId);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", "");
    }

    function safeTransferFrom(address from, address to, uint256 agentId) external {
        safeTransferFrom(from, to, agentId, "");
    }

    function safeTransferFrom(address from, address to, uint256 agentId, bytes memory data) public {
        transferFrom(from, to, agentId);
        if (to.code.length > 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, agentId, data) returns (bytes4 ret) {
                if (ret != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }

    // ── internals ────────────────────────────────────────────────────────────

    function _requireExists(uint256 agentId) private view {
        if (_owners[agentId] == address(0)) revert NoSuchAgent();
    }

    function _requireAuthorized(address spender, uint256 agentId) private view {
        if (!isAuthorizedOrOwner(spender, agentId)) revert NotAuthorized();
    }

    // ecrecover returns address(0) for a bad v or an unrecoverable signature, and address(0) is never a
    // wallet we compare against. A malleated (high-s) signature only re-binds the wallet it signed for.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        return ecrecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
    }
}
