// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {TestBase} from "../test/utils/Vm.sol";
import {LeiEscrow} from "../src/LeiEscrow.sol";

/// @notice Deploys LeiEscrow.
///   FORWARDER       default 0x15fC6ae953E024d975e77382eEeC56A9101f9F88 = the Sepolia forwarder used by
///                   `cre workflow simulate --broadcast` (cre-cli cmd/workflow/simulate/chain/evm/supported_chains.go).
///                   For a deployed workflow, set the production Keystone forwarder for your chain instead.
///   TOKEN           ERC-20 address, or 0x0 for native ETH (default)
///   REFUND_TIMEOUT  seconds (default 7 days)
///
/// Dry run (no network):  forge script script/DeployLeiEscrow.s.sol
/// Real deployment:       forge script script/DeployLeiEscrow.s.sol --rpc-url $RPC --private-key $PK --broadcast
contract DeployLeiEscrow is TestBase {
    function run() external returns (LeiEscrow escrow) {
        address forwarder = vm.envOr("FORWARDER", address(0x15fC6ae953E024d975e77382eEeC56A9101f9F88));
        address token = vm.envOr("TOKEN", address(0));
        uint256 timeout = vm.envOr("REFUND_TIMEOUT", uint256(7 days));
        vm.startBroadcast();
        escrow = new LeiEscrow(forwarder, token, uint64(timeout));
        vm.stopBroadcast();
    }
}
