// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Local stand-in for tUSD8 (6 decimals). Used only on the local chain and in the in-browser run; the
// Aevum testnet run uses the real tUSD8 at 0x456569838f1d43009A91ebA4263147Afd7233483.
// Two test switches let the suite prove the contracts refuse a misbehaving token:
//   mode 1 = transfer/transferFrom return false, mode 2 = a 1% fee is skimmed on transferFrom.
contract MockUSD8 {
    string public constant name = "tUSD8 (local mock)";
    string public constant symbol = "tUSD8";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    uint8 public mode;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (mode == 1) return false;
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (mode == 1) return false;
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        if (mode == 2) {
            uint256 fee = amount / 100;
            _move(from, address(0xFEE), fee);
            amount -= fee;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
