// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Fallmarket on-chain: a worker agent (ERC-8004 identity) lists a job it will do, the price, and the
// validator that must sign off its work. The market cleans itself: anyone may prune a listing that has
// expired, or whose worker's validated record (ERC-8004 Validation Registry, this listing's validator)
// has fallen below the bar. No admin, no keeper: the rule is the code.

interface IIdentityRegistryM {
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}

interface IValidationRegistryM {
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse);
}

contract Fallmarket {
    struct Listing {
        uint256 workerAgentId;
        address validator;
        uint256 price;
        uint64 expiry;
        bool active;
        string termsURI;
    }

    uint64 public constant MIN_SAMPLES = 2;
    uint8 public constant MIN_AVERAGE = 60;

    address public immutable identity;
    address public immutable validation;
    uint256 public listingCount;
    mapping(uint256 => Listing) private _listings;

    event Listed(uint256 indexed listingId, uint256 indexed workerAgentId, address indexed validator, uint256 price, uint64 expiry, string termsURI);
    event Delisted(uint256 indexed listingId, address indexed by, string reason);

    error ZeroAddress();
    error NotAuthorized();
    error ZeroPrice();
    error BadExpiry();
    error NoSuchListing();
    error NotActive();
    error NothingToPrune(uint64 count, uint8 averageResponse);

    constructor(address identity_, address validation_) {
        if (identity_ == address(0) || validation_ == address(0)) revert ZeroAddress();
        identity = identity_;
        validation = validation_;
    }

    function list(uint256 workerAgentId, address validator, uint256 price, uint64 expiry, string calldata termsURI)
        external
        returns (uint256 listingId)
    {
        if (!IIdentityRegistryM(identity).isAuthorizedOrOwner(msg.sender, workerAgentId)) revert NotAuthorized();
        if (validator == address(0)) revert ZeroAddress();
        if (price == 0) revert ZeroPrice();
        if (expiry <= block.timestamp) revert BadExpiry();
        listingId = ++listingCount;
        _listings[listingId] = Listing(workerAgentId, validator, price, expiry, true, termsURI);
        emit Listed(listingId, workerAgentId, validator, price, expiry, termsURI);
    }

    function delist(uint256 listingId) external {
        Listing storage l = _get(listingId);
        if (!IIdentityRegistryM(identity).isAuthorizedOrOwner(msg.sender, l.workerAgentId)) revert NotAuthorized();
        if (!l.active) revert NotActive();
        l.active = false;
        emit Delisted(listingId, msg.sender, "owner");
    }

    // Anyone may call. Removes a listing that is past its expiry, or whose worker has at least
    // MIN_SAMPLES answered validations from this listing's validator averaging below MIN_AVERAGE.
    function prune(uint256 listingId) external {
        Listing storage l = _get(listingId);
        if (!l.active) revert NotActive();
        if (block.timestamp > l.expiry) {
            l.active = false;
            emit Delisted(listingId, msg.sender, "expired");
            return;
        }
        address[] memory vs = new address[](1);
        vs[0] = l.validator;
        (uint64 count, uint8 avg) = IValidationRegistryM(validation).getSummary(l.workerAgentId, vs, "");
        if (count < MIN_SAMPLES || avg >= MIN_AVERAGE) revert NothingToPrune(count, avg);
        l.active = false;
        emit Delisted(listingId, msg.sender, "failed-validations");
    }

    function getListing(uint256 listingId)
        external
        view
        returns (uint256 workerAgentId, address validator, uint256 price, uint64 expiry, bool active, string memory termsURI)
    {
        Listing storage l = _get(listingId);
        return (l.workerAgentId, l.validator, l.price, l.expiry, l.active, l.termsURI);
    }

    function isLive(uint256 listingId) public view returns (bool) {
        Listing storage l = _listings[listingId];
        return l.active && block.timestamp <= l.expiry;
    }

    function _get(uint256 listingId) private view returns (Listing storage l) {
        l = _listings[listingId];
        if (l.validator == address(0)) revert NoSuchListing();
    }
}
