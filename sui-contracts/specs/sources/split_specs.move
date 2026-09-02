// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/// Machine-checked proofs of the two pure split functions, for the Sui Prover.
///
/// The property sweeps in `tests/split_property_tests.move` sample 6,000 points; these specs
/// cover *all* points — the prover discharges each `ensures` for every input satisfying the
/// `requires`, or produces a counterexample. The `requires` bounds mirror the values the
/// callers can actually pass: both bps parameters are asserted `<= 10_000` at their setters.
module projectx_social_specs::split_specs;

use projectx_social::creator;
use projectx_social::stake_vault;

#[spec_only]
use prover::prover::{ensures, requires};

#[spec(prove, target = projectx_social::creator::compute_split)]
fun compute_split_spec(
    gross: u64,
    fee_bps: u64,
    referral_share_bps: u64,
    has_referrer: bool,
): (u64, u64, u64) {
    requires(fee_bps <= 10_000);
    requires(referral_share_bps <= 10_000);

    let (creator_net, platform_net, referral_cut) =
        creator::compute_split(gross, fee_bps, referral_share_bps, has_referrer);

    // Conservation, exactly, at every input — the identity the module doc promises.
    ensures(creator_net + platform_net + referral_cut == gross);
    // Without a referrer nothing is carved out.
    ensures(has_referrer || referral_cut == 0);

    (creator_net, platform_net, referral_cut)
}

#[spec(prove, target = projectx_social::stake_vault::compute_yield_split)]
fun compute_yield_split_spec(gross: u64, fee_bps: u64, rebate_bps: u64): (u64, u64, u64) {
    requires(fee_bps <= 10_000);
    requires(rebate_bps <= 10_000);

    let (creator_cut, platform_cut, rebate_cut) =
        stake_vault::compute_yield_split(gross, fee_bps, rebate_bps);

    // Conservation, exactly, at every input.
    ensures(creator_cut + platform_cut + rebate_cut == gross);
    // A full rebate empties the creator's share — the perk is the creator's own yield.
    ensures(rebate_bps != 10_000 || creator_cut == 0);

    (creator_cut, platform_cut, rebate_cut)
}
