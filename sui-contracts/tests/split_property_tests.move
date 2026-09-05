// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui · Co-authored-by: Claude
/// Adversarial sweeps over the two pure split functions.
///
/// The hand-picked-value tests prove the splits at inputs a person thought of; these prove them
/// at inputs nobody did. A deterministic LCG drives thousands of (gross, fee, share) triples
/// across the whole of u64 — the same sequence every run, so any failure reproduces — and each
/// triple asserts the conservation identity and the cross-properties the function docs promise.
/// The corners the generator is not guaranteed to hit are pinned by hand at the end.
#[test_only]
module projectx_social::split_property_tests;

use projectx_social::creator;
use projectx_social::stake_vault as sv;

const BPS: u64 = 10_000;
const U64_MAX: u64 = 18_446_744_073_709_551_615;
const TWO_POW_64: u128 = 18_446_744_073_709_551_616;

/// Knuth's 64-bit LCG, reduced mod 2^64 through u128 because Move aborts on overflow.
fun next(s: u64): u64 {
    ((((s as u128) * 6364136223846793005 + 1442695040888963407) % TWO_POW_64) as u64)
}

#[test]
fun the_flow_split_conserves_at_every_input() {
    let mut s = 42;
    let mut i = 0;
    while (i < 3_000) {
        s = next(s);
        let gross = s;
        s = next(s);
        let fee = s % (BPS + 1);
        s = next(s);
        let share = s % (BPS + 1);

        // Conservation, exactly, with a referrer present.
        let (c, p, r) = creator::compute_split(gross, fee, share, true);
        assert!(c + p + r == gross, 0);

        // Without a referrer nothing disappears: the carved share returns to the platform and
        // the creator's take is identical — the defect the `has_referrer` parameter exists to
        // prevent is the share migrating to the creator.
        let (c0, p0, r0) = creator::compute_split(gross, fee, share, false);
        assert!(r0 == 0, 1);
        assert!(c0 == c, 2);
        assert!(p0 == p + r, 3);

        i = i + 1;
    };

    // The corners.
    let (c, p, r) = creator::compute_split(U64_MAX, BPS, BPS, true);
    assert!(c == 0 && p == 0 && r == U64_MAX, 4);       // full fee, fully shared
    let (c1, p1, r1) = creator::compute_split(U64_MAX, 0, BPS, true);
    assert!(c1 == U64_MAX && p1 == 0 && r1 == 0, 5);    // no fee: nothing to share
    let (c2, p2, r2) = creator::compute_split(0, BPS, BPS, true);
    assert!(c2 == 0 && p2 == 0 && r2 == 0, 6);          // zero gross stays zero
    let (c3, p3, r3) = creator::compute_split(1, 1, 1, true);
    assert!(c3 + p3 + r3 == 1, 7);                       // one unit cannot vanish in the floors
}

#[test]
fun the_yield_split_conserves_at_every_input() {
    let mut s = 1337;
    let mut i = 0;
    while (i < 3_000) {
        s = next(s);
        let gross = s;
        s = next(s);
        let fee = s % (BPS + 1);
        s = next(s);
        let rebate = s % (BPS + 1);

        let (c, p, r) = sv::compute_yield_split(gross, fee, rebate);
        assert!(c + p + r == gross, 0);

        // The platform's cut is independent of the rebate: the perk is the creator's to give,
        // never the platform's to fund.
        let (_, p0, _) = sv::compute_yield_split(gross, fee, 0);
        assert!(p == p0, 1);

        // A full rebate empties the creator's share exactly — no dust strands with the creator.
        let (cf, pf, rf) = sv::compute_yield_split(gross, fee, BPS);
        assert!(cf == 0 && pf == p0 && cf + pf + rf == gross, 2);

        i = i + 1;
    };

    // The corners.
    let (c, p, r) = sv::compute_yield_split(U64_MAX, BPS, BPS);
    assert!(c == 0 && p == U64_MAX && r == 0, 3);       // the full fee leaves nothing to rebate
    let (c1, p1, r1) = sv::compute_yield_split(U64_MAX, 0, 0);
    assert!(c1 == U64_MAX && p1 == 0 && r1 == 0, 4);
    let (c2, p2, r2) = sv::compute_yield_split(1, 1, 1);
    assert!(c2 + p2 + r2 == 1, 5);
}
