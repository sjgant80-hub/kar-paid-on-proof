// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Test-only ERC-721 receiver: answers onERC721Received with a configurable value (or reverts).
contract MockReceiver {
    bytes4 public answer = 0x150b7a02;
    bool public shouldRevert;

    function set(bytes4 a, bool r) external {
        answer = a;
        shouldRevert = r;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(!shouldRevert, "no");
        return answer;
    }
}
