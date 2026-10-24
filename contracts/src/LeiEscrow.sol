// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC165} from "./interfaces/IERC165.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/// @title LeiEscrow - "LEI Gate": payments released only to verified legal entities
/// @notice A payer locks funds (native ETH or one ERC-20 chosen at deploy time) for a payee
///         that claims a Legal Entity Identifier (ISO 17442). A Chainlink CRE workflow checks
///         the LEI against the public GLEIF registry and delivers a DON-signed report via the
///         Keystone forwarder. Funds can only be released to the payee once the report says the
///         LEI is verified (entity ACTIVE, registration ISSUED, not past nextRenewalDate).
///         If verification fails, the payer can refund after `refundTimeout`.
contract LeiEscrow is IReceiver {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------
    enum Status {
        None,
        Pending,
        Released,
        Refunded
    }

    struct Invoice {
        address payer;
        address payee;
        uint256 amount;
        uint64 createdAt;
        Status status;
        bytes32 leiHash; // keccak256(bytes(lei)) - the report must match it
        string lei;
    }

    /// @notice Latest GLEIF verification snapshot written by the CRE workflow.
    struct Verification {
        bool verified;
        string entityStatus; // e.g. ACTIVE / INACTIVE / NOT_FOUND / INVALID_LEI_FORMAT
        string registrationStatus; // e.g. ISSUED / LAPSED / RETIRED / ...
        uint64 nextRenewalDate; // unix seconds (0 if unknown)
        string jurisdiction; // e.g. US-DE
        bytes32 legalNameHash; // keccak256(bytes(legalName))
        uint64 checkedAt; // unix seconds (DON time)
    }

    // ---------------------------------------------------------------------
    // Errors / events
    // ---------------------------------------------------------------------
    error NotOwner();
    error InvalidForwarder(address sender);
    error InvalidWorkflowOwner(address got, address expected);
    error InvalidPayee();
    error InvalidAmount();
    error InvalidLeiLength();
    error WrongValue();
    error TransferFailed();
    error UnknownInvoice(uint256 id);
    error NotPending(uint256 id);
    error LeiMismatch(uint256 id);
    error StaleReport(uint256 id);
    error NotVerified(uint256 id);
    error LeiExpired(uint256 id);
    error NotPayer();
    error AlreadyVerified(uint256 id);
    error RefundTooEarly(uint256 id, uint256 availableAt);

    event InvoiceCreated(uint256 indexed id, address indexed payer, address indexed payee, string lei, uint256 amount);
    event LeiVerificationRecorded(
        uint256 indexed id,
        bool verified,
        string entityStatus,
        string registrationStatus,
        uint64 nextRenewalDate,
        string jurisdiction,
        bytes32 legalNameHash,
        uint64 checkedAt
    );
    event Released(uint256 indexed id, address indexed payee, uint256 amount);
    event Refunded(uint256 indexed id, address indexed payer, uint256 amount);
    event ForwarderUpdated(address indexed previous, address indexed current);
    event ExpectedWorkflowOwnerUpdated(address indexed previous, address indexed current);
    event OwnershipTransferred(address indexed previous, address indexed current);

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------
    /// @notice ERC-20 used for escrow; address(0) = native ETH.
    address public immutable token;
    /// @notice Seconds after creation after which an unverified invoice can be refunded.
    uint64 public immutable refundTimeout;

    address public owner;
    /// @notice Keystone forwarder allowed to call onReport (simulation uses the MockKeystoneForwarder).
    address public forwarder;
    /// @notice Optional: if non-zero, the report metadata's workflowOwner must equal this.
    address public expectedWorkflowOwner;

    uint256 public nextInvoiceId = 1;
    mapping(uint256 => Invoice) private _invoices;
    mapping(uint256 => Verification) private _verifications;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address forwarder_, address token_, uint64 refundTimeout_) {
        owner = msg.sender;
        forwarder = forwarder_;
        token = token_;
        refundTimeout = refundTimeout_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ForwarderUpdated(address(0), forwarder_);
    }

    // ---------------------------------------------------------------------
    // Payer flow
    // ---------------------------------------------------------------------

    /// @notice Lock `amount` for `payee`, who claims to be the legal entity `lei`.
    /// @dev For native ETH escrows send exactly `amount` as msg.value; for ERC-20 escrows
    ///      approve this contract first. Full ISO 17442 checksum validation happens off-chain
    ///      in the CRE workflow; an invalid LEI simply never verifies.
    function create(address payee, string calldata lei, uint256 amount) external payable returns (uint256 id) {
        if (payee == address(0)) revert InvalidPayee();
        if (amount == 0) revert InvalidAmount();
        if (bytes(lei).length != 20) revert InvalidLeiLength();

        id = nextInvoiceId++;
        _invoices[id] = Invoice({
            payer: msg.sender,
            payee: payee,
            amount: amount,
            createdAt: uint64(block.timestamp),
            status: Status.Pending,
            leiHash: keccak256(bytes(lei)),
            lei: lei
        });

        if (token == address(0)) {
            if (msg.value != amount) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            _safeTransferFrom(msg.sender, address(this), amount);
        }

        emit InvoiceCreated(id, msg.sender, payee, lei, amount);
    }

    /// @notice Release funds to the payee. Callable by anyone; funds always go to the payee.
    function release(uint256 id) external {
        Invoice storage inv = _invoices[id];
        if (inv.status == Status.None) revert UnknownInvoice(id);
        if (inv.status != Status.Pending) revert NotPending(id);
        Verification storage v = _verifications[id];
        if (!v.verified) revert NotVerified(id);
        if (block.timestamp >= v.nextRenewalDate) revert LeiExpired(id);

        inv.status = Status.Released; // effects before interaction
        _payout(inv.payee, inv.amount);
        emit Released(id, inv.payee, inv.amount);
    }

    /// @notice Payer gets the funds back if the LEI is not verified after `refundTimeout`.
    function refund(uint256 id) external {
        Invoice storage inv = _invoices[id];
        if (inv.status == Status.None) revert UnknownInvoice(id);
        if (inv.status != Status.Pending) revert NotPending(id);
        if (msg.sender != inv.payer) revert NotPayer();
        if (_verifications[id].verified) revert AlreadyVerified(id);
        uint256 availableAt = uint256(inv.createdAt) + refundTimeout;
        if (block.timestamp < availableAt) revert RefundTooEarly(id, availableAt);

        inv.status = Status.Refunded;
        _payout(inv.payer, inv.amount);
        emit Refunded(id, inv.payer, inv.amount);
    }

    // ---------------------------------------------------------------------
    // CRE receiver
    // ---------------------------------------------------------------------

    /// @inheritdoc IReceiver
    /// @dev report = abi.encode(uint256 invoiceId, bytes32 leiHash, bool verified, string entityStatus,
    ///      string registrationStatus, uint64 nextRenewalDate, string jurisdiction, bytes32 legalNameHash,
    ///      uint64 checkedAt)
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert InvalidForwarder(msg.sender);

        address expected = expectedWorkflowOwner;
        if (expected != address(0)) {
            address wfOwner = _workflowOwner(metadata);
            if (wfOwner != expected) revert InvalidWorkflowOwner(wfOwner, expected);
        }

        (
            uint256 id,
            bytes32 leiHash,
            bool verified,
            string memory entityStatus,
            string memory registrationStatus,
            uint64 nextRenewalDate,
            string memory jurisdiction,
            bytes32 legalNameHash,
            uint64 checkedAt
        ) = abi.decode(report, (uint256, bytes32, bool, string, string, uint64, string, bytes32, uint64));

        Invoice storage inv = _invoices[id];
        if (inv.status == Status.None) revert UnknownInvoice(id);
        if (inv.status != Status.Pending) revert NotPending(id);
        if (inv.leiHash != leiHash) revert LeiMismatch(id);
        if (checkedAt < _verifications[id].checkedAt) revert StaleReport(id);

        _verifications[id] = Verification({
            verified: verified,
            entityStatus: entityStatus,
            registrationStatus: registrationStatus,
            nextRenewalDate: nextRenewalDate,
            jurisdiction: jurisdiction,
            legalNameHash: legalNameHash,
            checkedAt: checkedAt
        });

        emit LeiVerificationRecorded(
            id, verified, entityStatus, registrationStatus, nextRenewalDate, jurisdiction, legalNameHash, checkedAt
        );
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function getInvoice(uint256 id) external view returns (Invoice memory) {
        return _invoices[id];
    }

    function getVerification(uint256 id) external view returns (Verification memory) {
        return _verifications[id];
    }

    function isReleasable(uint256 id) external view returns (bool) {
        Verification storage v = _verifications[id];
        return _invoices[id].status == Status.Pending && v.verified && block.timestamp < v.nextRenewalDate;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------
    function setForwarder(address forwarder_) external onlyOwner {
        emit ForwarderUpdated(forwarder, forwarder_);
        forwarder = forwarder_;
    }

    function setExpectedWorkflowOwner(address workflowOwner_) external onlyOwner {
        emit ExpectedWorkflowOwnerUpdated(expectedWorkflowOwner, workflowOwner_);
        expectedWorkflowOwner = workflowOwner_;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev metadata layout: workflowId (32) | workflowName (10) | workflowOwner (20) | reportId (2)
    function _workflowOwner(bytes calldata metadata) internal pure returns (address wfOwner) {
        if (metadata.length < 62) return address(0);
        assembly {
            wfOwner := shr(96, calldataload(add(metadata.offset, 42)))
        }
    }

    function _payout(address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _safeCall(abi.encodeCall(IERC20.transfer, (to, amount)));
        }
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        _safeCall(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
    }

    /// @dev Accepts tokens that return nothing (USDT-style) or `true`.
    function _safeCall(bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed();
    }
}
