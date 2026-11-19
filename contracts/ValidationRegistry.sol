// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ERC-8004 Validation Registry (Draft), written for this build. Signatures and events follow the spec.
// An agent asks a named validator to check its work; only that validator can answer (0..100).
// The DocDec verifier answers here, so its verdict on a deliverable is public, signed and queryable.

interface IIdentityRegistryV {
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}

contract ValidationRegistry {
    struct Status {
        address validatorAddress;
        uint256 agentId;
        uint8 response;
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
    }

    event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash);
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    error NotAuthorized();
    error ZeroAddress();
    error EmptyHash();
    error AlreadyRequested();
    error UnknownRequest();
    error NotValidator();
    error ResponseOutOfRange();

    address private immutable _identity;
    mapping(bytes32 => Status) private _status;
    mapping(uint256 => bytes32[]) private _agentValidations;
    mapping(address => bytes32[]) private _validatorRequests;

    constructor(address identityRegistry_) {
        if (identityRegistry_ == address(0)) revert ZeroAddress();
        _identity = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return _identity;
    }

    // MUST be called by the owner or an operator of agentId (spec). A request hash is claimed once.
    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash) external {
        if (validatorAddress == address(0)) revert ZeroAddress();
        if (requestHash == bytes32(0)) revert EmptyHash();
        if (!IIdentityRegistryV(_identity).isAuthorizedOrOwner(msg.sender, agentId)) revert NotAuthorized();
        if (_status[requestHash].validatorAddress != address(0)) revert AlreadyRequested();
        Status storage s = _status[requestHash];
        s.validatorAddress = validatorAddress;
        s.agentId = agentId;
        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);
        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    // MUST be called by the validator named in the request. May be called again to update (spec).
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        Status storage s = _status[requestHash];
        if (s.validatorAddress == address(0)) revert UnknownRequest();
        if (msg.sender != s.validatorAddress) revert NotValidator();
        if (response > 100) revert ResponseOutOfRange();
        s.response = response;
        s.responseHash = responseHash;
        s.tag = tag;
        s.lastUpdate = block.timestamp;
        emit ValidationResponse(msg.sender, s.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate)
    {
        Status storage s = _status[requestHash];
        return (s.validatorAddress, s.agentId, s.response, s.responseHash, s.tag, s.lastUpdate);
    }

    // Answered validations only. validatorAddresses and tag are optional filters (empty = any).
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse)
    {
        bytes32[] storage hashes = _agentValidations[agentId];
        bytes32 tagHash = keccak256(bytes(tag));
        bool anyTag = bytes(tag).length == 0;
        uint256 total = 0;
        for (uint256 i = 0; i < hashes.length; i++) {
            Status storage s = _status[hashes[i]];
            if (s.lastUpdate == 0) continue;
            if (!anyTag && keccak256(bytes(s.tag)) != tagHash) continue;
            if (validatorAddresses.length > 0 && !_contains(validatorAddresses, s.validatorAddress)) continue;
            count += 1;
            total += s.response;
        }
        if (count > 0) averageResponse = uint8(total / count);
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }

    function _contains(address[] calldata list, address a) private pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == a) return true;
        }
        return false;
    }
}
