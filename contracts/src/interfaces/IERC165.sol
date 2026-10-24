// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Minimal ERC-165 interface (EIP-165).
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
