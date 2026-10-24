// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IReceiver} from "../../src/interfaces/IReceiver.sol";

/// @notice Mimics the KeystoneForwarder delivery step: ERC-165 check, then onReport(metadata, report).
///         (Signature verification of the DON is the real forwarder's job and is out of scope here.)
contract MockForwarder {
    error ReceiverNotSupported();

    function deliver(address receiver, bytes32 workflowId, bytes10 workflowName, address workflowOwner, bytes calldata report)
        external
    {
        if (!IReceiver(receiver).supportsInterface(type(IReceiver).interfaceId)) revert ReceiverNotSupported();
        bytes memory metadata = abi.encodePacked(workflowId, workflowName, workflowOwner, bytes2(0x0001));
        IReceiver(receiver).onReport(metadata, report);
    }
}
