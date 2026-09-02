// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/// Tests for `creator::compute_split` — the arithmetic every payment depends on.
///
/// This is a pure function, so it is tested exhaustively at the boundaries rather than through a
/// transaction scenario. Two properties matter, and both are asserted throughout:
///
/// > 1. creator_net + platform_net + referral_cut == gross, exactly, for all inputs.
/// > 2. The creator's share does not depend on whether a referrer exists.
#[test_only]
module projectx_social::split_tests;

use projectx_social::creator;

/// Property 1, as a helper, asserted for both referrer states so no case is tested in only one.
fun assert_conserves(gross: u64, fee_bps: u64, referral_share_bps: u64) {
    let (c1, p1, r1) = creator::compute_split(gross, fee_bps, referral_share_bps, true);
    assert!(c1 + p1 + r1 == gross, 0);

    let (c2, p2, r2) = creator::compute_split(gross, fee_bps, referral_share_bps, false);
    assert!(c2 + p2 + r2 == gross, 1);

    // Property 2: the creator is indifferent to referral.
    assert!(c1 == c2, 2);
    // And with no referrer, nothing is paid out as referral.
    assert!(r2 == 0, 3);
}

#[test]
fun zero_fee_gives_everything_to_the_creator() {
    let (c, p, r) = creator::compute_split(1_000_000, 0, 0, true);
    assert!(c == 1_000_000, 0);
    assert!(p == 0, 1);
    assert!(r == 0, 2);
}

#[test]
fun a_zero_gross_splits_into_zeroes() {
    // Guards against a division or subtraction that misbehaves at the origin.
    let (c, p, r) = creator::compute_split(0, 3_000, 5_000, true);
    assert!(c == 0 && p == 0 && r == 0, 0);
}

#[test]
fun ten_percent_of_a_round_number() {
    let (c, p, r) = creator::compute_split(1_000_000, 1_000, 0, true);
    assert!(c == 900_000, 0);
    assert!(p == 100_000, 1);
    assert!(r == 0, 2);
}

#[test]
/// The regression test for the defect this file's header describes.
///
/// With no referrer the referral share must stay with the platform. Paying it to the creator
/// conserves value and is still wrong — it silently gives away the platform's revenue on every
/// organic signup, which is most of them.
fun an_absent_referrer_leaves_the_share_with_the_platform() {
    let (c, p, r) = creator::compute_split(1_000_000, 1_000, 5_000, false);

    assert!(c == 900_000, 0); // creator unchanged
    assert!(p == 100_000, 1); // platform keeps the whole 10%, not 5%
    assert!(r == 0, 2);

    // Stated as a direct comparison against the referred case, because that is the confusion:
    // the platform's cut differs, the creator's does not.
    let (c_ref, p_ref, r_ref) = creator::compute_split(1_000_000, 1_000, 5_000, true);
    assert!(c_ref == c, 3);
    assert!(p_ref == 50_000, 4);
    assert!(r_ref == 50_000, 5);
    assert!(p_ref + r_ref == p, 6);
}

#[test]
fun the_referral_comes_out_of_the_platform_cut_not_the_creator() {
    let (c_without, p_without, r_without) = creator::compute_split(1_000_000, 1_000, 0, true);
    let (c_with, p_with, r_with) = creator::compute_split(1_000_000, 1_000, 5_000, true);

    assert!(c_with == c_without, 0); // creator untouched
    assert!(r_without == 0, 1);
    assert!(r_with == 50_000, 2); // half of the platform's 100_000
    assert!(p_with == 50_000, 3); // platform keeps the other half
    assert!(p_without == 100_000, 4);
    assert!(p_with + r_with == p_without, 5); // the cut was divided, not created
}

#[test]
fun rounding_never_loses_a_unit() {
    // 1 unit at 30% floors the platform fee to 0, so the creator keeps the whole unit. The
    // dangerous alternative is a scheme that rounds the fee up and leaves the creator at -1.
    let (c, p, r) = creator::compute_split(1, 3_000, 5_000, true);
    assert!(c == 1, 0);
    assert!(p == 0, 1);
    assert!(r == 0, 2);
    assert_conserves(1, 3_000, 5_000);
}

#[test]
fun awkward_amounts_still_conserve() {
    // Chosen to produce non-zero remainders in both divisions.
    assert_conserves(7, 333, 777);
    assert_conserves(99, 1, 1);
    assert_conserves(101, 2_999, 4_999);
    assert_conserves(12_345_678, 1_234, 5_678);
    assert_conserves(3, 9_999, 9_999);
    assert_conserves(1, 1, 1);
}

#[test]
fun conserves_across_a_sweep_of_amounts_and_rates() {
    // A cheap stand-in for property-based testing: walk amounts and rates together so the
    // remainders vary, rather than testing one amount against many rates.
    let mut gross = 1;
    while (gross < 100_000) {
        let mut fee = 0;
        while (fee <= 3_000) {
            assert_conserves(gross, fee, 0);
            assert_conserves(gross, fee, 5_000);
            assert_conserves(gross, fee, 3_333);
            fee = fee + 371; // a prime-ish step, so rates are not all round numbers
        };
        gross = gross * 3 + 1;
    };
}

#[test]
fun the_maximum_permitted_rates_behave() {
    // 30% platform fee, half of it referred — the most that can ever be taken from a payment.
    let (c, p, r) = creator::compute_split(1_000_000, 3_000, 5_000, true);
    assert!(c == 700_000, 0);
    assert!(p == 150_000, 1);
    assert!(r == 150_000, 2);
    // The creator keeps 70% at the worst legal setting. Asserted so that raising the compiled
    // ceiling has to change this test and therefore has to be noticed in review.
    assert!(c == 700_000, 3);
}

#[test]
fun large_amounts_do_not_overflow() {
    // The reason `compute_split` widens to u128 internally. At the maximum fee this multiplication
    // exceeds u64 well before the amounts here, so a narrow implementation aborts on this case.
    let big: u64 = 1_000_000_000_000_000_000; // 1e18
    assert_conserves(big, 3_000, 5_000);

    let (c, p, r) = creator::compute_split(big, 3_000, 5_000, true);
    assert!(p == 150_000_000_000_000_000, 0);
    assert!(r == 150_000_000_000_000_000, 1);
    assert!(c == 700_000_000_000_000_000, 2);
}

#[test]
fun the_largest_representable_amount_still_conserves() {
    // u64::MAX. If the intermediate were u64 this would abort rather than fail an assertion,
    // which is why it is worth a case of its own.
    let max: u64 = 18_446_744_073_709_551_615;
    assert_conserves(max, 3_000, 5_000);
    assert_conserves(max, 1, 1);
}
