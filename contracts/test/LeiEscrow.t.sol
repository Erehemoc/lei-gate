// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {TestBase} from "./utils/Vm.sol";
import {MockERC20} from "./utils/MockERC20.sol";
import {MockForwarder} from "./utils/MockForwarder.sol";
import {LeiEscrow} from "../src/LeiEscrow.sol";
import {IReceiver} from "../src/interfaces/IReceiver.sol";
import {IERC165} from "../src/interfaces/IERC165.sol";

contract LeiEscrowTest is TestBase {
    string constant LEI_OK = "5493001KJTIIGC8Y1R12"; // Bloomberg Finance L.P. (ACTIVE / ISSUED)
    string constant LEI_LAPSED = "7N0UJMJLXD0MDT5D5086"; // ENSCO PLC (ACTIVE / LAPSED)
    uint64 constant TIMEOUT = 7 days;
    bytes32 constant WF_ID = keccak256("lei-check");
    bytes10 constant WF_NAME = bytes10("lei-check");

    event InvoiceCreated(uint256 indexed id, address indexed payer, address indexed payee, string lei, uint256 amount);
    event Released(uint256 indexed id, address indexed payee, uint256 amount);

    MockForwarder forwarder;
    LeiEscrow escrow; // native ETH escrow
    MockERC20 token;
    LeiEscrow tokenEscrow; // ERC-20 escrow

    address payer = address(0xA11CE);
    address payee = address(0xB0B);
    address stranger = address(0xBAD);
    address wfOwner = address(0xC0FFEE);

    function setUp() public {
        vm.warp(1_760_000_000); // ~Oct 2025
        forwarder = new MockForwarder();
        escrow = new LeiEscrow(address(forwarder), address(0), TIMEOUT);
        token = new MockERC20();
        tokenEscrow = new LeiEscrow(address(forwarder), address(token), TIMEOUT);
        vm.deal(payer, 100 ether);
        token.mint(payer, 1_000_000e6);
    }

    // ------------------------------------------------------------------ helpers
    function _create(uint256 amount) internal returns (uint256 id) {
        vm.prank(payer);
        id = escrow.create{value: amount}(payee, LEI_OK, amount);
    }

    function _report(uint256 id, string memory lei, bool verified, string memory es, string memory rs, uint64 renewal, uint64 checkedAt)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            id, keccak256(bytes(lei)), verified, es, rs, renewal, "US-DE", keccak256("Bloomberg Finance L.P."), checkedAt
        );
    }

    function _okReport(uint256 id) internal view returns (bytes memory) {
        return _report(id, LEI_OK, true, "ACTIVE", "ISSUED", uint64(block.timestamp + 90 days), uint64(block.timestamp));
    }

    function _deliver(LeiEscrow target, bytes memory report) internal {
        forwarder.deliver(address(target), WF_ID, WF_NAME, wfOwner, report);
    }

    // ------------------------------------------------------------------ ERC-165
    function test_SupportsReceiverInterface() public view {
        vm.assertTrue(escrow.supportsInterface(type(IReceiver).interfaceId), "IReceiver");
        vm.assertTrue(escrow.supportsInterface(type(IERC165).interfaceId), "IERC165");
        vm.assertFalse(escrow.supportsInterface(0xdeadbeef), "random");
    }

    // ------------------------------------------------------------------ create
    function test_CreateStoresInvoiceAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit InvoiceCreated(1, payer, payee, LEI_OK, 1 ether);
        uint256 id = _create(1 ether);

        vm.assertEq(id, 1, "id");
        LeiEscrow.Invoice memory inv = escrow.getInvoice(id);
        vm.assertEq(inv.payer, payer, "payer");
        vm.assertEq(inv.payee, payee, "payee");
        vm.assertEq(inv.amount, 1 ether, "amount");
        vm.assertEq(inv.lei, LEI_OK, "lei");
        vm.assertEq(inv.leiHash, keccak256(bytes(LEI_OK)), "leiHash");
        vm.assertEq(uint256(inv.status), uint256(LeiEscrow.Status.Pending), "status");
        vm.assertEq(address(escrow).balance, 1 ether, "escrow balance");
        vm.assertEq(escrow.nextInvoiceId(), 2, "next id");
    }

    function test_CreateRevertsOnBadInput() public {
        vm.startPrank(payer);
        vm.expectRevert(LeiEscrow.WrongValue.selector);
        escrow.create{value: 1}(payee, LEI_OK, 2);

        vm.expectRevert(LeiEscrow.InvalidLeiLength.selector);
        escrow.create{value: 1}(payee, "TOO-SHORT", 1);

        vm.expectRevert(LeiEscrow.InvalidPayee.selector);
        escrow.create{value: 1}(address(0), LEI_OK, 1);

        vm.expectRevert(LeiEscrow.InvalidAmount.selector);
        escrow.create{value: 0}(payee, LEI_OK, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ onReport access control
    function test_OnReportOnlyForwarder() public {
        uint256 id = _create(1 ether);
        bytes memory metadata = abi.encodePacked(WF_ID, WF_NAME, wfOwner, bytes2(0x0001));
        bytes memory report = _okReport(id);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.InvalidForwarder.selector, stranger));
        escrow.onReport(metadata, report);

        // payer / payee cannot self-verify either
        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.InvalidForwarder.selector, payee));
        escrow.onReport(metadata, report);

        vm.assertFalse(escrow.getVerification(id).verified, "still unverified");
    }

    function test_OnReportStoresAllFields() public {
        uint256 id = _create(1 ether);
        uint64 renewal = uint64(block.timestamp + 90 days);
        _deliver(escrow, _report(id, LEI_OK, true, "ACTIVE", "ISSUED", renewal, uint64(block.timestamp)));

        LeiEscrow.Verification memory v = escrow.getVerification(id);
        vm.assertTrue(v.verified, "verified");
        vm.assertEq(v.entityStatus, "ACTIVE", "entityStatus");
        vm.assertEq(v.registrationStatus, "ISSUED", "registrationStatus");
        vm.assertEq(uint256(v.nextRenewalDate), uint256(renewal), "nextRenewalDate");
        vm.assertEq(v.jurisdiction, "US-DE", "jurisdiction");
        vm.assertEq(v.legalNameHash, keccak256("Bloomberg Finance L.P."), "legalNameHash");
        vm.assertEq(uint256(v.checkedAt), block.timestamp, "checkedAt");
        vm.assertTrue(escrow.isReleasable(id), "releasable");
    }

    function test_OnReportRejectsLeiMismatch() public {
        uint256 id = _create(1 ether);
        // a valid report, but for a *different* LEI than the invoice was created with
        bytes memory report =
            _report(id, LEI_LAPSED, true, "ACTIVE", "ISSUED", uint64(block.timestamp + 1 days), uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.LeiMismatch.selector, id));
        _deliver(escrow, report);
    }

    function test_OnReportRejectsUnknownInvoice() public {
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.UnknownInvoice.selector, 42));
        _deliver(escrow, _okReport(42));
    }

    function test_OnReportRejectsStaleReport() public {
        uint256 id = _create(1 ether);
        _deliver(escrow, _okReport(id));
        bytes memory older = _report(
            id, LEI_OK, false, "INACTIVE", "RETIRED", uint64(block.timestamp + 1 days), uint64(block.timestamp - 1)
        );
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.StaleReport.selector, id));
        _deliver(escrow, older);
    }

    function test_ExpectedWorkflowOwnerEnforced() public {
        escrow.setExpectedWorkflowOwner(address(0x1234));
        uint256 id = _create(1 ether);
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.InvalidWorkflowOwner.selector, wfOwner, address(0x1234)));
        _deliver(escrow, _okReport(id));

        escrow.setExpectedWorkflowOwner(wfOwner);
        _deliver(escrow, _okReport(id));
        vm.assertTrue(escrow.getVerification(id).verified, "verified with right owner");
    }

    function test_AdminIsOwnerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(LeiEscrow.NotOwner.selector);
        escrow.setForwarder(stranger);
        vm.expectRevert(LeiEscrow.NotOwner.selector);
        escrow.setExpectedWorkflowOwner(stranger);
        vm.expectRevert(LeiEscrow.NotOwner.selector);
        escrow.transferOwnership(stranger);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ release
    function test_ReleaseRevertsBeforeVerification() public {
        uint256 id = _create(1 ether);
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.NotVerified.selector, id));
        escrow.release(id);
    }

    function test_ReleaseAfterVerificationPaysPayee() public {
        uint256 id = _create(1 ether);
        _deliver(escrow, _okReport(id));

        uint256 before = payee.balance;
        vm.expectEmit(true, true, false, true);
        emit Released(id, payee, 1 ether);
        vm.prank(stranger); // anyone can trigger; funds go to payee
        escrow.release(id);

        vm.assertEq(payee.balance - before, 1 ether, "payee paid");
        vm.assertEq(address(escrow).balance, 0, "escrow drained");
        vm.assertEq(uint256(escrow.getInvoice(id).status), uint256(LeiEscrow.Status.Released), "status");

        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.NotPending.selector, id));
        escrow.release(id);
        // late reports for a settled invoice are rejected
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.NotPending.selector, id));
        _deliver(escrow, _okReport(id));
    }

    function test_ReleaseBlockedWhenLeiLapsed() public {
        uint256 id = _create(1 ether);
        _deliver(
            escrow, _report(id, LEI_OK, false, "ACTIVE", "LAPSED", uint64(block.timestamp - 1 days), uint64(block.timestamp))
        );
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.NotVerified.selector, id));
        escrow.release(id);
        vm.assertFalse(escrow.isReleasable(id), "not releasable");
    }

    function test_NewerNegativeReportRevokesVerification() public {
        uint256 id = _create(1 ether);
        _deliver(escrow, _okReport(id));
        vm.warp(block.timestamp + 1 hours);
        _deliver(
            escrow,
            _report(id, LEI_OK, false, "INACTIVE", "RETIRED", uint64(block.timestamp + 1 days), uint64(block.timestamp))
        );
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.NotVerified.selector, id));
        escrow.release(id);
    }

    function test_ReleaseBlockedAfterRenewalDatePassed() public {
        uint256 id = _create(1 ether);
        _deliver(
            escrow, _report(id, LEI_OK, true, "ACTIVE", "ISSUED", uint64(block.timestamp + 1 days), uint64(block.timestamp))
        );
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.LeiExpired.selector, id));
        escrow.release(id);
    }

    // ------------------------------------------------------------------ refund
    function test_RefundPathAfterTimeout() public {
        uint256 id = _create(1 ether);
        _deliver(
            escrow, _report(id, LEI_OK, false, "ACTIVE", "LAPSED", uint64(block.timestamp - 1 days), uint64(block.timestamp))
        );

        uint256 availableAt = block.timestamp + TIMEOUT;
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.RefundTooEarly.selector, id, availableAt));
        escrow.refund(id);

        vm.warp(availableAt);
        vm.prank(stranger);
        vm.expectRevert(LeiEscrow.NotPayer.selector);
        escrow.refund(id);

        uint256 before = payer.balance;
        vm.prank(payer);
        escrow.refund(id);
        vm.assertEq(payer.balance - before, 1 ether, "refunded");
        vm.assertEq(uint256(escrow.getInvoice(id).status), uint256(LeiEscrow.Status.Refunded), "status");

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.NotPending.selector, id));
        escrow.refund(id);
    }

    function test_RefundWithoutAnyReportAfterTimeout() public {
        uint256 id = _create(1 ether);
        vm.warp(block.timestamp + TIMEOUT);
        vm.prank(payer);
        escrow.refund(id);
        vm.assertEq(address(escrow).balance, 0, "drained");
    }

    function test_RefundBlockedOnceVerified() public {
        uint256 id = _create(1 ether);
        _deliver(escrow, _okReport(id));
        vm.warp(block.timestamp + TIMEOUT + 1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(LeiEscrow.AlreadyVerified.selector, id));
        escrow.refund(id);
    }

    // ------------------------------------------------------------------ ERC-20 escrow
    function test_Erc20CreateReleaseAndRefund() public {
        vm.startPrank(payer);
        token.approve(address(tokenEscrow), type(uint256).max);
        vm.expectRevert(LeiEscrow.WrongValue.selector);
        tokenEscrow.create{value: 1}(payee, LEI_OK, 500e6);
        uint256 a = tokenEscrow.create(payee, LEI_OK, 500e6);
        uint256 b = tokenEscrow.create(payee, LEI_LAPSED, 250e6);
        vm.stopPrank();
        vm.assertEq(token.balanceOf(address(tokenEscrow)), 750e6, "locked");

        _deliver(tokenEscrow, _okReport(a));
        tokenEscrow.release(a);
        vm.assertEq(token.balanceOf(payee), 500e6, "payee got tokens");

        _deliver(
            tokenEscrow,
            _report(b, LEI_LAPSED, false, "ACTIVE", "LAPSED", uint64(block.timestamp - 1), uint64(block.timestamp))
        );
        vm.warp(block.timestamp + TIMEOUT);
        vm.prank(payer);
        tokenEscrow.refund(b);
        vm.assertEq(token.balanceOf(payer), 1_000_000e6 - 500e6, "payer refunded");
        vm.assertEq(token.balanceOf(address(tokenEscrow)), 0, "drained");
    }

    // ------------------------------------------------------------------ cross-language fixture
    /// @dev The bytes below are produced by the TypeScript workflow's `encodeVerificationReport`
    ///      (lei-check/src/report.ts, see lei-check/report.test.ts) to prove both sides agree on the ABI.
    function test_DecodesReportProducedByWorkflowEncoder() public {
        uint256 id = _create(1 ether); // id 1
        vm.warp(1_761_177_600); // 2025-10-23T00:00:00Z, same checkedAt as the TS fixture
        _deliver(escrow, TS_FIXTURE);
        LeiEscrow.Verification memory v = escrow.getVerification(id);
        vm.assertTrue(v.verified, "verified");
        vm.assertEq(v.entityStatus, "ACTIVE", "entityStatus");
        vm.assertEq(v.registrationStatus, "ISSUED", "registrationStatus");
        vm.assertEq(uint256(v.nextRenewalDate), 1_800_895_802, "nextRenewalDate 2027-01-25T16:50:02Z");
        vm.assertEq(v.jurisdiction, "US-DE", "jurisdiction");
        vm.assertEq(v.legalNameHash, keccak256("Bloomberg Finance L.P."), "legalNameHash");
        vm.assertEq(uint256(v.checkedAt), 1_761_177_600, "checkedAt");
        vm.assertTrue(escrow.isReleasable(id), "releasable");
    }

    bytes constant TS_FIXTURE = hex"000000000000000000000000000000000000000000000000000000000000000174cd7f8072a412ff0cb43f66a81c21754a90d5f53f4ff6b19b234fae667063c5000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000006b577d3a00000000000000000000000000000000000000000000000000000000000001a0156f0b889189d820f1cbcb3cf751ee5f16a10e662a47fa10bf63a2513f4ce8be0000000000000000000000000000000000000000000000000000000068f970000000000000000000000000000000000000000000000000000000000000000006414354495645000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064953535545440000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000555532d4445000000000000000000000000000000000000000000000000000000";
}
