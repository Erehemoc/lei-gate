// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC165} from "./IERC165.sol";

/// @title IReceiver - receives Chainlink CRE / Keystone reports
/// @notice Same interface as chainlink `keystone/interfaces/IReceiver.sol`.
///         The KeystoneForwarder verifies the DON signatures and then calls
///         `onReport(metadata, report)` on the receiver. The forwarder checks
///         ERC-165 support for this interface before delivering.
interface IReceiver is IERC165 {
    /// @param metadata abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner, bytes2 reportId)
    /// @param report   the workflow-defined report body (here: abi-encoded LEI verification result)
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
