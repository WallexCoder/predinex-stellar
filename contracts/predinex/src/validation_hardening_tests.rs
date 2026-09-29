#![cfg(test)]
extern crate std;
use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger, Address, Env, String};

struct TestCtx<'a> {
    env: Env,
    client: PredinexContractClient<'a>,
    admin: Address,
    user: Address,
    user_b: Address,
    token: Address,
}

fn setup() -> TestCtx<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let user_b = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let contract_id = env.register(PredinexContract, ());
    let client: PredinexContractClient<'static> = PredinexContractClient::new(&env, &contract_id);
    client.initialize(&token_id.address(), &admin, &admin);
    let token_admin = token::StellarAssetClient::new(&env, &token_id.address());
    token_admin.mint(&admin, &(MIN_CREATOR_DEPOSIT * 200));
    token_admin.mint(&user, &10_000);
    token_admin.mint(&user_b, &10_000);
    TestCtx {
        env,
        client,
        admin,
        user,
        user_b,
        token: token_id.address(),
    }
}

fn create_pool(ctx: &TestCtx<'_>) -> u32 {
    ctx.client.create_pool(
        &ctx.admin,
        &String::from_str(&ctx.env, "Market"),
        &String::from_str(&ctx.env, "Description"),
        &String::from_str(&ctx.env, "Yes"),
        &String::from_str(&ctx.env, "No"),
        &3600,
        &MIN_CREATOR_DEPOSIT,
        &None::<u64>,
    )
}

fn settle_pool(ctx: &TestCtx<'_>, pool_id: u32) {
    ctx.client
        .place_bet(&ctx.user, &pool_id, &0, &500, &None::<Address>);
    ctx.client
        .place_bet(&ctx.user_b, &pool_id, &1, &500, &None::<Address>);
    ctx.env.ledger().with_mut(|li| li.timestamp = 3601);
    ctx.client.settle_pool(&ctx.admin, &pool_id, &0);
}

#[test]
fn scheduled_pool_activates_at_open_time() {
    let ctx = setup();
    ctx.env.ledger().with_mut(|li| li.timestamp = 100);
    let pool_id = ctx.client.schedule_pool(
        &ctx.admin,
        &String::from_str(&ctx.env, "Future"),
        &String::from_str(&ctx.env, "Description"),
        &String::from_str(&ctx.env, "Yes"),
        &String::from_str(&ctx.env, "No"),
        &3600,
        &MIN_CREATOR_DEPOSIT,
        &200,
    );
    assert_eq!(ctx.client.get_scheduled_pools(&1, &10).len(), 1);
    assert_eq!(
        ctx.client.try_activate_scheduled_pool(&pool_id),
        Err(Ok(ContractError::PoolNotExpired))
    );
    ctx.env.ledger().with_mut(|li| li.timestamp = 200);
    ctx.client.activate_scheduled_pool(&pool_id);
    assert_eq!(
        ctx.client.get_pool(&pool_id).unwrap().status,
        PoolStatus::Open
    );
}

#[test]
fn scheduled_pool_cancel_and_horizon_validation() {
    let ctx = setup();
    ctx.env.ledger().with_mut(|li| li.timestamp = 1_000);
    let too_far = 1_000 + MAX_SCHEDULE_POOL_HORIZON_SECS + 1;
    let result = ctx.client.try_schedule_pool(
        &ctx.admin,
        &String::from_str(&ctx.env, "Future"),
        &String::from_str(&ctx.env, "Description"),
        &String::from_str(&ctx.env, "Yes"),
        &String::from_str(&ctx.env, "No"),
        &3600,
        &MIN_CREATOR_DEPOSIT,
        &too_far,
    );
    assert_eq!(result, Err(Ok(ContractError::DurationTooLong)));

    let pool_id = ctx.client.schedule_pool(
        &ctx.admin,
        &String::from_str(&ctx.env, "Future"),
        &String::from_str(&ctx.env, "Description"),
        &String::from_str(&ctx.env, "Yes"),
        &String::from_str(&ctx.env, "No"),
        &3600,
        &MIN_CREATOR_DEPOSIT,
        &(1_000 + MAX_SCHEDULE_POOL_HORIZON_SECS),
    );
    ctx.client.cancel_scheduled_pool(&ctx.admin, &pool_id);
    assert_eq!(
        ctx.client.get_pool(&pool_id).unwrap().status,
        PoolStatus::Cancelled
    );
    assert_eq!(ctx.client.get_scheduled_pools(&1, &10).len(), 0);
}

#[test]
fn scheduled_claim_executes_when_due_and_can_be_cancelled() {
    let ctx = setup();
    let pool_id = create_pool(&ctx);
    settle_pool(&ctx, pool_id);
    let claim_id = ctx.client.schedule_claim(&ctx.user, &pool_id, &4_000);
    match ctx.client.try_execute_scheduled_claims() {
        Err(Ok(ContractError::ScheduledClaimNotDue)) => {}
        other => panic!("expected ScheduledClaimNotDue, got {:?}", other.err()),
    }
    ctx.client.cancel_scheduled_claim(&ctx.user, &claim_id);
    assert_eq!(ctx.client.get_scheduled_claims(&1, &10).len(), 0);

    let claim_id_2 = ctx.client.schedule_claim(&ctx.user, &pool_id, &4_100);
    assert!(claim_id_2 > claim_id);
    ctx.env.ledger().with_mut(|li| li.timestamp = 4_100);
    let executed = ctx.client.execute_scheduled_claims();
    assert_eq!(executed.len(), 1);
    assert!(executed.get(0).unwrap().amount > 0);
}

#[test]
fn p1_user_claim_status_round_trips() {
    let ctx = setup();
    ctx.env.ledger().with_mut(|li| li.timestamp = 100);
    let pool_id = create_pool(&ctx);
    // place a bet so schedule_claim can succeed
    ctx.client
        .place_bet(&ctx.user, &pool_id, &0, &500, &None::<Address>);

    // schedule a claim and verify history contains a pending entry
    let _claim_id = ctx.client.schedule_claim(&ctx.user, &pool_id, &4_000);
    let history = ctx.client.get_user_claim_history(&ctx.user, &0, &10);
    let mut found = false;
    for i in 0..history.len() {
        let e = history.get(i).unwrap();
        if e.pool_id == pool_id {
            assert_eq!(e.status, super::UserClaimStatus::Pending);
            found = true;
            break;
        }
    }
    assert!(found, "expected pending history entry for scheduled claim");
}

/// Ignored: exceeds Soroban test environment footprint limit when processing
/// more than ~10 scheduled claims per invocation.
#[test]
#[ignore]
fn scheduled_claim_execution_is_capped_at_ten() {
    let ctx = setup();
    let mut pool_ids = std::vec::Vec::new();
    for i in 0..11u32 {
        let pool_id = ctx.client.create_pool(
            &ctx.admin,
            &String::from_str(&ctx.env, "Market"),
            &String::from_str(&ctx.env, "Description"),
            &String::from_str(&ctx.env, "Yes"),
            &String::from_str(&ctx.env, "No"),
            &3600,
            &MIN_CREATOR_DEPOSIT,
            &None::<u64>,
        );
        let amount = 100 + i as i128;
        ctx.client
            .place_bet(&ctx.user, &pool_id, &0, &amount, &None::<Address>);
        ctx.client
            .place_bet(&ctx.user_b, &pool_id, &1, &100, &None::<Address>);
        pool_ids.push(pool_id);
    }
    ctx.env.ledger().with_mut(|li| li.timestamp = 3601);
    for pool_id in pool_ids {
        ctx.client.settle_pool(&ctx.admin, &pool_id, &0);
        ctx.client.schedule_claim(&ctx.user, &pool_id, &4_000);
    }
    ctx.env.ledger().with_mut(|li| li.timestamp = 4_000);
    let executed = ctx.client.execute_scheduled_claims();
    assert_eq!(executed.len(), 10);
}

#[test]
fn treasury_withdrawal_rate_limit_blocks_and_resets() {
    let ctx = setup();
    let pool_id = create_pool(&ctx);
    settle_pool(&ctx, pool_id);
    ctx.client.claim_winnings(&ctx.user, &pool_id);
    let treasury = ctx.client.get_treasury_balance();
    assert!(treasury >= 20);
    ctx.client.set_treasury_withdraw_limit(&ctx.admin, &10, &60);
    ctx.client.withdraw_treasury(&ctx.admin, &10);
    assert_eq!(
        ctx.client.try_withdraw_treasury(&ctx.admin, &1),
        Err(Ok(ContractError::RateLimitExceeded))
    );
    ctx.env.ledger().with_mut(|li| li.timestamp += 60);
    ctx.client.withdraw_treasury(&ctx.admin, &1);
}

#[test]
fn boundary_validation_uses_consistent_errors() {
    let ctx = setup();
    assert_eq!(
        ctx.client
            .try_set_treasury_withdraw_limit(&ctx.admin, &-1, &60),
        Err(Ok(ContractError::InvalidRateLimitConfig))
    );
    assert_eq!(
        ctx.client.try_schedule_claim(&ctx.user, &999, &0),
        Err(Ok(ContractError::DurationTooShort))
    );
    assert_eq!(
        ctx.client.try_withdraw_treasury(&ctx.admin, &0),
        Err(Ok(ContractError::InvalidWithdrawalAmount))
    );
}

// ── rescue_tokens amount validation ──────────────────────────────────────────

/// A zero rescue is a pointless cross-contract transfer — reject it before the
/// token client is touched.
#[test]
fn rescue_tokens_rejects_zero_amount() {
    let ctx = setup();
    let recipient = Address::generate(&ctx.env);

    assert_eq!(
        ctx.client
            .try_rescue_tokens(&ctx.admin, &ctx.token, &recipient, &0),
        Err(Ok(ContractError::InvalidWithdrawalAmount))
    );
}

/// A negative rescue would be a reverse transfer — reject it outright.
#[test]
fn rescue_tokens_rejects_negative_amount() {
    let ctx = setup();
    let recipient = Address::generate(&ctx.env);
    let token_admin = token::StellarAssetClient::new(&ctx.env, &ctx.token);
    token_admin.mint(&recipient, &1_000);

    assert_eq!(
        ctx.client
            .try_rescue_tokens(&ctx.admin, &ctx.token, &recipient, &-1),
        Err(Ok(ContractError::InvalidWithdrawalAmount))
    );

    // The rejected call must not have moved anything.
    let token_client = token::Client::new(&ctx.env, &ctx.token);
    assert_eq!(token_client.balance(&recipient), 1_000);
}

/// The happy path is unaffected by the new guard: a positive amount still moves
/// from the contract balance to the recipient.
#[test]
fn rescue_tokens_transfers_positive_amount() {
    let ctx = setup();
    let recipient = Address::generate(&ctx.env);
    let token_admin = token::StellarAssetClient::new(&ctx.env, &ctx.token);
    token_admin.mint(&ctx.client.address, &500);

    ctx.client
        .rescue_tokens(&ctx.admin, &ctx.token, &recipient, &500);

    let token_client = token::Client::new(&ctx.env, &ctx.token);
    assert_eq!(token_client.balance(&recipient), 500);
    assert_eq!(token_client.balance(&ctx.client.address), 0);
}

/// Non-treasury callers are still rejected regardless of the amount.
#[test]
fn rescue_tokens_rejects_non_treasury_caller() {
    let ctx = setup();
    let recipient = Address::generate(&ctx.env);

    assert_eq!(
        ctx.client
            .try_rescue_tokens(&ctx.user, &ctx.token, &recipient, &100),
        Err(Ok(ContractError::Unauthorized))
    );
}

// ── #1273 — rescue_tokens must not treat a mid-refund-sweep pool as free ──────

/// #1273 — If a pool has been Cancelled but the refund sweep is still in
/// progress (cursor present after the first batch call), rescue_tokens must
/// count the remaining bettor escrow as a liability and refuse to rescue it.
///
/// Scenario:
///   • 26 bettors each stake 100 tokens  → 2 600 tokens held by the contract.
///   • One call to `refund_expired_pool` refunds bettors 0-24 (batch = 25).
///   • At this point the pool is Cancelled **and** the cursor key is present.
///   • `rescue_tokens(100)` must be rejected: the 100 tokens owed to bettor 26
///     are still outstanding.
#[test]
fn rescue_tokens_blocked_when_refund_sweep_in_progress() {
    let env = Env::default();
    env.mock_all_auths();
    // Unlimited budget: this test exercises multi-batch sweep behaviour
    // (26 bettors > REFUND_EXPIRED_BATCH_SIZE = 25), not gas efficiency.
    env.cost_estimate().budget().reset_unlimited();

    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let contract_id = env.register(PredinexContract, ());
    let client: PredinexContractClient<'static> = PredinexContractClient::new(&env, &contract_id);
    client.initialize(&token_id.address(), &admin, &admin);

    let token_admin = token::StellarAssetClient::new(&env, &token_id.address());
    let token_client = token::Client::new(&env, &token_id.address());

    // Fund the creator so it can cover MIN_CREATOR_DEPOSIT.
    token_admin.mint(&admin, &(MIN_CREATOR_DEPOSIT * 10));

    // Create a pool.
    let pool_id = client.create_pool(
        &admin,
        &soroban_sdk::String::from_str(&env, "Test"),
        &soroban_sdk::String::from_str(&env, "Desc"),
        &soroban_sdk::String::from_str(&env, "Yes"),
        &soroban_sdk::String::from_str(&env, "No"),
        &3_600u64,
        &MIN_CREATOR_DEPOSIT,
        &None::<u64>,
    );

    // 26 bettors — one more than REFUND_EXPIRED_BATCH_SIZE (25).
    let bet_amount: i128 = 100;
    let num_bettors: usize = 26;
    let mut bettors: alloc::vec::Vec<Address> = alloc::vec::Vec::new();
    for _ in 0..num_bettors {
        let bettor = Address::generate(&env);
        token_admin.mint(&bettor, &bet_amount);
        client.place_bet(&bettor, &pool_id, &0u32, &bet_amount, &None::<Address>);
        bettors.push(bettor);
    }

    // Expire the pool past the grace period.
    env.ledger().with_mut(|li| {
        li.timestamp = 3_601 + GRACE_PERIOD_SECS;
    });

    // First batch: refunds bettors 0-24, sets Cancelled + cursor = 25.
    client.refund_expired_pool(&pool_id);

    // Pool is now Cancelled but bettor 25 hasn't been refunded yet.
    // The cursor key is still present.  rescue_tokens must be blocked.
    let recipient = Address::generate(&env);
    // Mint a small surplus to the contract so the balance check can proceed.
    token_admin.mint(&client.address, &50);

    let result = client.try_rescue_tokens(&admin, &token_id.address(), &recipient, &50);
    assert!(
        result.is_err(),
        "rescue_tokens must be rejected while the refund sweep is in progress"
    );

    // Sanity: bettor 25's balance should still be 0 (not yet refunded).
    let last_bettor = &bettors[25];
    assert_eq!(
        token_client.balance(last_bettor),
        0,
        "bettor 26 must not have been refunded yet"
    );
}

/// #1273 — Once the sweep is complete (cursor removed), rescue_tokens must
/// succeed for amounts that are genuinely above the remaining liabilities.
///
/// This ensures the fix only blocks rescue during the in-flight window and
/// doesn't permanently lock funds after the sweep finishes.
#[test]
fn rescue_tokens_allowed_after_refund_sweep_complete() {
    let env = Env::default();
    env.mock_all_auths();
    // Unlimited budget: this test needs two full refund batches (26 bettors).
    env.cost_estimate().budget().reset_unlimited();

    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let contract_id = env.register(PredinexContract, ());
    let client: PredinexContractClient<'static> = PredinexContractClient::new(&env, &contract_id);
    client.initialize(&token_id.address(), &admin, &admin);

    let token_admin = token::StellarAssetClient::new(&env, &token_id.address());
    let token_client = token::Client::new(&env, &token_id.address());

    token_admin.mint(&admin, &(MIN_CREATOR_DEPOSIT * 10));

    let pool_id = client.create_pool(
        &admin,
        &soroban_sdk::String::from_str(&env, "Test"),
        &soroban_sdk::String::from_str(&env, "Desc"),
        &soroban_sdk::String::from_str(&env, "Yes"),
        &soroban_sdk::String::from_str(&env, "No"),
        &3_600u64,
        &MIN_CREATOR_DEPOSIT,
        &None::<u64>,
    );

    // 26 bettors.
    let bet_amount: i128 = 100;
    let num_bettors: usize = 26;
    for _ in 0..num_bettors {
        let bettor = Address::generate(&env);
        token_admin.mint(&bettor, &bet_amount);
        client.place_bet(&bettor, &pool_id, &0u32, &bet_amount, &None::<Address>);
    }

    env.ledger().with_mut(|li| {
        li.timestamp = 3_601 + GRACE_PERIOD_SECS;
    });

    // First batch (bettors 0-24 refunded, cursor = 25).
    client.refund_expired_pool(&pool_id);
    // Second batch (bettor 25 refunded, cursor removed — sweep complete).
    client.refund_expired_pool(&pool_id);

    // Now the sweep is done.  Any surplus minted to the contract should be
    // rescuable since all bettor claims have been paid.
    let surplus: i128 = 200;
    token_admin.mint(&client.address, &surplus);

    let recipient = Address::generate(&env);
    // rescue_tokens must succeed because no pending bettor escrow remains.
    client.rescue_tokens(&admin, &token_id.address(), &recipient, &surplus);

    assert_eq!(
        token_client.balance(&recipient),
        surplus,
        "surplus must reach the recipient once the sweep is complete"
    );
}

/// #1273 — A pool that was cancelled cleanly (no batching needed, i.e. zero or
/// very few bettors processed in one call so cursor was removed) must continue
/// to be treated as liability-free.  Regression guard: confirm the happy path
/// wasn't broken by the fix.
#[test]
fn rescue_tokens_allowed_for_small_pool_fully_cancelled() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let contract_id = env.register(PredinexContract, ());
    let client: PredinexContractClient<'static> = PredinexContractClient::new(&env, &contract_id);
    client.initialize(&token_id.address(), &admin, &admin);

    let token_admin = token::StellarAssetClient::new(&env, &token_id.address());
    let token_client = token::Client::new(&env, &token_id.address());

    token_admin.mint(&admin, &(MIN_CREATOR_DEPOSIT * 10));

    let pool_id = client.create_pool(
        &admin,
        &soroban_sdk::String::from_str(&env, "Small"),
        &soroban_sdk::String::from_str(&env, "Desc"),
        &soroban_sdk::String::from_str(&env, "Yes"),
        &soroban_sdk::String::from_str(&env, "No"),
        &3_600u64,
        &MIN_CREATOR_DEPOSIT,
        &None::<u64>,
    );

    // Only 3 bettors — well within one batch, so a single call fully refunds
    // them and clears the cursor.
    let bet_amount: i128 = 100;
    let mut bettors: alloc::vec::Vec<Address> = alloc::vec::Vec::new();
    for _ in 0..3 {
        let bettor = Address::generate(&env);
        token_admin.mint(&bettor, &bet_amount);
        client.place_bet(&bettor, &pool_id, &0u32, &bet_amount, &None::<Address>);
        bettors.push(bettor);
    }

    env.ledger().with_mut(|li| {
        li.timestamp = 3_601 + GRACE_PERIOD_SECS;
    });

    // Single call completes the sweep.
    client.refund_expired_pool(&pool_id);

    // All bettors refunded.
    for bettor in &bettors {
        assert_eq!(
            token_client.balance(bettor),
            bet_amount,
            "bettor must be fully refunded"
        );
    }

    // A surplus is rescuable.
    let surplus: i128 = 500;
    token_admin.mint(&client.address, &surplus);
    let recipient = Address::generate(&env);
    client.rescue_tokens(&admin, &token_id.address(), &recipient, &surplus);
    assert_eq!(token_client.balance(&recipient), surplus);
}