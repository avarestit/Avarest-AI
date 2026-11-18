-- ============================================================================
-- AVAREST ONE — STAGING CREDIT RESERVATION & ADMIN AUTHORIZATION HARDENING (v3)
-- Forward-only migration layered on top of 0001 and 0002.
-- Target: Staging (wdbtszlcdliwacvztmjl). Never run directly on Production
-- without staging verification and explicit release approval.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CREDIT RESERVATIONS TABLE (Reserve -> Finalize/Reconcile -> Release/Expire)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.credit_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL,
  feature TEXT NOT NULL CHECK (
    feature IN ('chat', 'chat_stream', 'research', 'coder', 'agent_immediate', 'agent_approval')
  ),
  provider_id TEXT,
  model_id TEXT,
  reserved_amount NUMERIC(14, 4) NOT NULL CHECK (reserved_amount > 0),
  actual_amount NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (actual_amount >= 0),
  uncollected_amount NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (uncollected_amount >= 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (
    status IN ('reserved', 'finalized', 'released', 'expired')
  ),
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_credit_reservations_user_ref UNIQUE (user_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_credit_reservations_status_expires
  ON public.credit_reservations (status, expires_at)
  WHERE status = 'reserved';

CREATE INDEX IF NOT EXISTS idx_credit_reservations_user_status
  ON public.credit_reservations (user_id, status, created_at DESC);

ALTER TABLE public.credit_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credit_reservations_owner_or_admin_select ON public.credit_reservations;
CREATE POLICY credit_reservations_owner_or_admin_select ON public.credit_reservations
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_admin());

-- Disallow direct client DML; all reservation state transitions execute via
-- service_role-only SECURITY DEFINER RPCs.
REVOKE INSERT, UPDATE, DELETE ON public.credit_reservations FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. INTERNAL HELPER: RECONCILE EXPIRED RESERVATIONS FOR A LOCKED USER ACCOUNT
-- Caller MUST already hold FOR UPDATE lock on public.credit_accounts for p_user_id.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._reconcile_user_expired_reservations(
  p_user_id UUID,
  p_current_balance NUMERIC,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
  next_balance NUMERIC,
  reconciled_count INTEGER,
  refunded_total NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_res RECORD;
  v_bal NUMERIC := ROUND(COALESCE(p_current_balance, 0), 4);
  v_count INTEGER := 0;
  v_refunded NUMERIC := 0;
  v_limit INTEGER := GREATEST(1, LEAST(COALESCE(p_limit, 100), 1000));
BEGIN
  FOR v_res IN
    SELECT cr.id, cr.reference_id, cr.reserved_amount, cr.reason
    FROM public.credit_reservations cr
    WHERE cr.user_id = p_user_id
      AND cr.status = 'reserved'
      AND cr.expires_at <= NOW()
    ORDER BY cr.created_at ASC
    LIMIT v_limit
    FOR UPDATE
  LOOP
    v_bal := ROUND(v_bal + v_res.reserved_amount, 4);
    v_refunded := ROUND(v_refunded + v_res.reserved_amount, 4);
    v_count := v_count + 1;

    UPDATE public.credit_reservations
    SET status = 'expired',
        actual_amount = 0,
        uncollected_amount = 0,
        released_at = NOW(),
        updated_at = NOW()
    WHERE id = v_res.id;

    INSERT INTO public.credit_ledger (user_id, delta, balance_after, reason, reference_id)
    VALUES (
      p_user_id,
      ROUND(v_res.reserved_amount, 4),
      v_bal,
      'Expired reservation reconciled: ' || v_res.reason,
      'resv:' || v_res.reference_id || ':expire'
    )
    ON CONFLICT (user_id, reference_id) WHERE reference_id IS NOT NULL DO NOTHING;
  END LOOP;

  IF v_count > 0 THEN
    UPDATE public.credit_accounts
    SET balance = v_bal,
        updated_at = NOW()
    WHERE user_id = p_user_id;
  END IF;

  RETURN QUERY SELECT v_bal, v_count, v_refunded;
END;
$$;

REVOKE ALL ON FUNCTION public._reconcile_user_expired_reservations(UUID, NUMERIC, INTEGER)
  FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. ATOMIC RESERVE CREDITS RPC (Service-Role Only, Expired Idempotency Handling)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_credits(
  p_user_id UUID,
  p_amount NUMERIC,
  p_feature TEXT,
  p_reason TEXT,
  p_reference_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 300,
  p_provider_id TEXT DEFAULT NULL,
  p_model_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  reservation_id UUID,
  status TEXT,
  reserved_amount NUMERIC,
  actual_amount NUMERIC,
  balance_after NUMERIC,
  deduplicated BOOLEAN,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role TEXT;
  v_reserve NUMERIC;
  v_ttl INTEGER;
  v_current NUMERIC;
  v_next NUMERIC;
  v_existing public.credit_reservations%ROWTYPE;
  v_rec RECORD;
  v_new_id UUID;
  v_expires TIMESTAMPTZ;
BEGIN
  v_caller_role := COALESCE(auth.role(), '');
  IF v_caller_role <> 'service_role' AND CURRENT_USER NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Forbidden: reserve_credits requires service_role authorization';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID is required';
  END IF;

  IF p_reference_id IS NULL OR LENGTH(TRIM(p_reference_id)) = 0 THEN
    RAISE EXCEPTION 'Reference ID is required for idempotent reservation';
  END IF;

  v_reserve := ROUND(COALESCE(p_amount, 0), 4);
  IF v_reserve <= 0 THEN
    RAISE EXCEPTION 'Reservation amount must be strictly positive';
  END IF;

  v_ttl := GREATEST(10, LEAST(COALESCE(p_ttl_seconds, 300), 3600));

  SELECT ca.balance INTO v_current
  FROM public.credit_accounts ca
  WHERE ca.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit account not found';
  END IF;

  SELECT * INTO v_rec
  FROM public._reconcile_user_expired_reservations(p_user_id, v_current, 100);
  v_current := COALESCE(v_rec.next_balance, v_current);

  SELECT * INTO v_existing
  FROM public.credit_reservations cr
  WHERE cr.user_id = p_user_id
    AND cr.reference_id = p_reference_id
  FOR UPDATE;

  IF FOUND THEN
    RETURN QUERY SELECT
      v_existing.id,
      v_existing.status,
      v_existing.reserved_amount,
      v_existing.actual_amount,
      v_current,
      TRUE,
      v_existing.expires_at;
    RETURN;
  END IF;

  IF v_current < v_reserve THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  v_next := ROUND(v_current - v_reserve, 4);
  IF v_next < 0 THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  v_expires := NOW() + make_interval(secs => v_ttl);

  UPDATE public.credit_accounts
  SET balance = v_next,
      updated_at = NOW()
  WHERE user_id = p_user_id;

  INSERT INTO public.credit_reservations (
    user_id,
    reference_id,
    feature,
    provider_id,
    model_id,
    reserved_amount,
    actual_amount,
    uncollected_amount,
    status,
    reason,
    expires_at
  )
  VALUES (
    p_user_id,
    p_reference_id,
    p_feature,
    p_provider_id,
    p_model_id,
    v_reserve,
    0,
    0,
    'reserved',
    p_reason,
    v_expires
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.credit_ledger (user_id, delta, balance_after, reason, reference_id)
  VALUES (
    p_user_id,
    -v_reserve,
    v_next,
    'Reserved: ' || p_reason,
    'resv:' || p_reference_id || ':reserve'
  )
  ON CONFLICT (user_id, reference_id) WHERE reference_id IS NOT NULL DO NOTHING;

  RETURN QUERY SELECT
    v_new_id,
    'reserved'::TEXT,
    v_reserve,
    0::NUMERIC,
    v_next,
    FALSE,
    v_expires;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_credits(UUID, NUMERIC, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_credits(UUID, NUMERIC, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT)
  TO service_role;

-- ----------------------------------------------------------------------------
-- 4. ATOMIC FINALIZE RESERVATION RPC (Co-transactional Expiry Reconciliation)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_credit_reservation(
  p_user_id UUID,
  p_reference_id TEXT,
  p_actual_amount NUMERIC,
  p_reason TEXT DEFAULT NULL
)
RETURNS TABLE (
  reservation_id UUID,
  status TEXT,
  reserved_amount NUMERIC,
  actual_amount NUMERIC,
  uncollected_amount NUMERIC,
  balance_after NUMERIC,
  deduplicated BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role TEXT;
  v_current NUMERIC;
  v_next NUMERIC;
  v_res public.credit_reservations%ROWTYPE;
  v_actual NUMERIC;
  v_refund NUMERIC;
  v_extra_needed NUMERIC;
  v_collect NUMERIC;
  v_uncollected NUMERIC := 0;
  v_settled_actual NUMERIC;
  v_rec RECORD;
BEGIN
  v_caller_role := COALESCE(auth.role(), '');
  IF v_caller_role <> 'service_role' AND CURRENT_USER NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Forbidden: finalize_credit_reservation requires service_role authorization';
  END IF;

  IF p_user_id IS NULL OR p_reference_id IS NULL OR LENGTH(TRIM(p_reference_id)) = 0 THEN
    RAISE EXCEPTION 'User ID and Reference ID are required';
  END IF;

  IF p_actual_amount IS NULL OR p_actual_amount < 0 THEN
    RAISE EXCEPTION 'Actual credit amount must be non-negative';
  END IF;

  SELECT ca.balance INTO v_current
  FROM public.credit_accounts ca
  WHERE ca.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit account not found';
  END IF;

  SELECT * INTO v_rec
  FROM public._reconcile_user_expired_reservations(p_user_id, v_current, 100);
  v_current := COALESCE(v_rec.next_balance, v_current);

  SELECT * INTO v_res
  FROM public.credit_reservations cr
  WHERE cr.user_id = p_user_id
    AND cr.reference_id = p_reference_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESERVATION_NOT_FOUND';
  END IF;

  IF v_res.status = 'finalized' THEN
    RETURN QUERY SELECT
      v_res.id,
      v_res.status,
      v_res.reserved_amount,
      v_res.actual_amount,
      v_res.uncollected_amount,
      v_current,
      TRUE;
    RETURN;
  END IF;

  -- Fix: Co-transactional expired reservation finalization attempt reconciliation (no transaction rollback)
  IF v_res.status = 'reserved' AND v_res.expires_at <= NOW() THEN
    v_current := ROUND(v_current + v_res.reserved_amount, 4);
    UPDATE public.credit_accounts
    SET balance = v_current,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    UPDATE public.credit_reservations
    SET status = 'expired',
        actual_amount = 0,
        uncollected_amount = 0,
        released_at = NOW(),
        updated_at = NOW()
    WHERE id = v_res.id;

    INSERT INTO public.credit_ledger (user_id, delta, balance_after, reason, reference_id)
    VALUES (
      p_user_id,
      ROUND(v_res.reserved_amount, 4),
      v_current,
      'Expired reservation finalized attempt reconciled: ' || v_res.reason,
      'resv:' || p_reference_id || ':expire'
    )
    ON CONFLICT (user_id, reference_id) WHERE reference_id IS NOT NULL DO NOTHING;

    RETURN QUERY SELECT
      v_res.id,
      'expired'::TEXT,
      v_res.reserved_amount,
      0::NUMERIC,
      0::NUMERIC,
      v_current,
      TRUE;
    RETURN;
  END IF;

  IF v_res.status IN ('released', 'expired') THEN
    RETURN QUERY SELECT
      v_res.id,
      v_res.status,
      v_res.reserved_amount,
      v_res.actual_amount,
      v_res.uncollected_amount,
      v_current,
      TRUE;
    RETURN;
  END IF;

  v_actual := ROUND(p_actual_amount, 4);
  v_next := v_current;

  IF v_actual <= v_res.reserved_amount THEN
    v_refund := ROUND(v_res.reserved_amount - v_actual, 4);
    v_settled_actual := v_actual;
    v_uncollected := 0;
    IF v_refund > 0 THEN
      v_next := ROUND(v_current + v_refund, 4);
      UPDATE public.credit_accounts
      SET balance = v_next,
          updated_at = NOW()
      WHERE user_id = p_user_id;

      INSERT INTO public.credit_ledger (user_id, delta, balance_after, reason, reference_id)
      VALUES (
        p_user_id,
        v_refund,
        v_next,
        COALESCE(NULLIF(TRIM(p_reason), ''), v_res.reason) || ' (unused reservation released)',
        'resv:' || p_reference_id || ':release_unused'
      )
      ON CONFLICT (user_id, reference_id) WHERE reference_id IS NOT NULL DO NOTHING;
    END IF;
  ELSE
    v_extra_needed := ROUND(v_actual - v_res.reserved_amount, 4);
    v_collect := LEAST(v_current, v_extra_needed);
    v_uncollected := ROUND(v_extra_needed - v_collect, 4);
    v_next := ROUND(v_current - v_collect, 4);
    v_settled_actual := ROUND(v_res.reserved_amount + v_collect, 4);
    IF v_collect > 0 THEN
      UPDATE public.credit_accounts
      SET balance = v_next,
          updated_at = NOW()
      WHERE user_id = p_user_id;

      INSERT INTO public.credit_ledger (user_id, delta, balance_after, reason, reference_id)
      VALUES (
        p_user_id,
        -v_collect,
        v_next,
        COALESCE(NULLIF(TRIM(p_reason), ''), v_res.reason) || ' (usage overage settled)',
        'resv:' || p_reference_id || ':overage'
      )
      ON CONFLICT (user_id, reference_id) WHERE reference_id IS NOT NULL DO NOTHING;
    END IF;
  END IF;

  UPDATE public.credit_reservations
  SET status = 'finalized',
      actual_amount = v_settled_actual,
      uncollected_amount = v_uncollected,
      finalized_at = NOW(),
      updated_at = NOW()
  WHERE id = v_res.id;

  RETURN QUERY SELECT
    v_res.id,
    'finalized'::TEXT,
    v_res.reserved_amount,
    v_settled_actual,
    v_uncollected,
    v_next,
    FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_credit_reservation(UUID, TEXT, NUMERIC, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_credit_reservation(UUID, TEXT, NUMERIC, TEXT)
  TO service_role;

-- ----------------------------------------------------------------------------
-- 5. ATOMIC RELEASE RESERVATION RPC (On Provider Failure or Stream Cancellation)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_credit_reservation(
  p_user_id UUID,
  p_reference_id TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS TABLE (
  reservation_id UUID,
  status TEXT,
  reserved_amount NUMERIC,
  refunded_amount NUMERIC,
  balance_after NUMERIC,
  deduplicated BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role TEXT;
  v_current NUMERIC;
  v_next NUMERIC;
  v_res public.credit_reservations%ROWTYPE;
BEGIN
  v_caller_role := COALESCE(auth.role(), '');
  IF v_caller_role <> 'service_role' AND CURRENT_USER NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Forbidden: release_credit_reservation requires service_role authorization';
  END IF;

  IF p_user_id IS NULL OR p_reference_id IS NULL OR LENGTH(TRIM(p_reference_id)) = 0 THEN
    RAISE EXCEPTION 'User ID and Reference ID are required';
  END IF;

  SELECT ca.balance INTO v_current
  FROM public.credit_accounts ca
  WHERE ca.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit account not found';
  END IF;

  SELECT * INTO v_res
  FROM public.credit_reservations cr
  WHERE cr.user_id = p_user_id
    AND cr.reference_id = p_reference_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESERVATION_NOT_FOUND';
  END IF;

  IF v_res.status IN ('released', 'expired', 'finalized') THEN
    RETURN QUERY SELECT
      v_res.id,
      v_res.status,
      v_res.reserved_amount,
      0::NUMERIC,
      v_current,
      TRUE;
    RETURN;
  END IF;

  v_next := ROUND(v_current + v_res.reserved_amount, 4);

  UPDATE public.credit_accounts
  SET balance = v_next,
      updated_at = NOW()
  WHERE user_id = p_user_id;

  UPDATE public.credit_reservations
  SET status = 'released',
      actual_amount = 0,
      uncollected_amount = 0,
      released_at = NOW(),
      updated_at = NOW()
  WHERE id = v_res.id;

  INSERT INTO public.credit_ledger (user_id, delta, balance_after, reason, reference_id)
  VALUES (
    p_user_id,
    ROUND(v_res.reserved_amount, 4),
    v_next,
    COALESCE(NULLIF(TRIM(p_reason), ''), 'Released reservation: ' || v_res.reason),
    'resv:' || p_reference_id || ':release'
  )
  ON CONFLICT (user_id, reference_id) WHERE reference_id IS NOT NULL DO NOTHING;

  RETURN QUERY SELECT
    v_res.id,
    'released'::TEXT,
    v_res.reserved_amount,
    v_res.reserved_amount,
    v_next,
    FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.release_credit_reservation(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_credit_reservation(UUID, TEXT, TEXT)
  TO service_role;

-- ----------------------------------------------------------------------------
-- 6. EXPIRED RESERVATION RECONCILIATION RPC (Deadlock-Free Account-First Locking)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_expired_credit_reservations(
  p_user_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
  reconciled_count INTEGER,
  refunded_total NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role TEXT;
  v_target_user RECORD;
  v_acct_balance NUMERIC;
  v_rec RECORD;
  v_total_count INTEGER := 0;
  v_total_refunded NUMERIC := 0;
  v_limit INTEGER := GREATEST(1, LEAST(COALESCE(p_limit, 100), 1000));
BEGIN
  v_caller_role := COALESCE(auth.role(), '');
  IF v_caller_role <> 'service_role' AND CURRENT_USER NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Forbidden: reconcile_expired_credit_reservations requires service_role authorization';
  END IF;

  IF p_user_id IS NOT NULL THEN
    SELECT ca.balance INTO v_acct_balance
    FROM public.credit_accounts ca
    WHERE ca.user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN QUERY SELECT 0, 0::NUMERIC;
      RETURN;
    END IF;

    SELECT * INTO v_rec
    FROM public._reconcile_user_expired_reservations(p_user_id, v_acct_balance, v_limit);
    RETURN QUERY SELECT COALESCE(v_rec.reconciled_count, 0), COALESCE(v_rec.refunded_total, 0::NUMERIC);
    RETURN;
  END IF;

  FOR v_target_user IN
    SELECT DISTINCT cr.user_id
    FROM public.credit_reservations cr
    WHERE cr.status = 'reserved'
      AND cr.expires_at <= NOW()
    ORDER BY cr.user_id
    LIMIT v_limit
  LOOP
    SELECT ca.balance INTO v_acct_balance
    FROM public.credit_accounts ca
    WHERE ca.user_id = v_target_user.user_id
    FOR UPDATE;

    IF FOUND THEN
      SELECT * INTO v_rec
      FROM public._reconcile_user_expired_reservations(v_target_user.user_id, v_acct_balance, v_limit);
      v_total_count := v_total_count + COALESCE(v_rec.reconciled_count, 0);
      v_total_refunded := ROUND(v_total_refunded + COALESCE(v_rec.refunded_total, 0::NUMERIC), 4);
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_total_count, v_total_refunded;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_expired_credit_reservations(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_expired_credit_reservations(UUID, INTEGER)
  TO service_role;

-- ----------------------------------------------------------------------------
-- 7. ATOMIC FIRST-ADMIN BOOTSTRAP RPC (Transaction Advisory Lock)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bootstrap_admin(
  p_email TEXT,
  p_full_name TEXT DEFAULT 'Platform Administrator',
  p_initial_credits NUMERIC DEFAULT 1000
)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  full_name TEXT,
  role TEXT,
  created_at TIMESTAMPTZ,
  is_created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role TEXT;
  v_admin_count INTEGER;
  v_target_id UUID;
  v_is_created BOOLEAN := FALSE;
BEGIN
  v_caller_role := COALESCE(auth.role(), '');
  IF v_caller_role <> 'service_role' AND CURRENT_USER NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Forbidden: bootstrap_admin requires service_role authorization';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('avarest_admin_bootstrap_lock'));

  SELECT COUNT(*)::INTEGER INTO v_admin_count
  FROM public.profiles
  WHERE role IN ('admin', 'super_admin');

  IF v_admin_count > 0 THEN
    RAISE EXCEPTION 'ADMIN_ALREADY_EXISTS';
  END IF;

  SELECT id INTO v_target_id
  FROM public.profiles
  WHERE email = LOWER(TRIM(p_email));

  IF FOUND THEN
    UPDATE public.profiles
    SET role = 'super_admin',
        full_name = COALESCE(NULLIF(TRIM(p_full_name), ''), full_name),
        updated_at = NOW()
    WHERE id = v_target_id;
  ELSE
    v_target_id := gen_random_uuid();
    v_is_created := TRUE;
    INSERT INTO public.profiles (id, email, full_name, role, active_plan, created_at, updated_at)
    VALUES (v_target_id, LOWER(TRIM(p_email)), COALESCE(NULLIF(TRIM(p_full_name), ''), 'Platform Administrator'), 'super_admin', 'enterprise', NOW(), NOW());

    INSERT INTO public.credit_accounts (user_id, balance, monthly_allowance)
    VALUES (v_target_id, p_initial_credits, p_initial_credits)
    ON CONFLICT (user_id) DO NOTHING;

    INSERT INTO public.credit_ledger (user_id, delta, balance_after, reason, reference_id)
    VALUES (v_target_id, p_initial_credits, p_initial_credits, 'Initial admin bootstrap credit grant', 'bootstrap:' || v_target_id)
    ON CONFLICT (user_id, reference_id) WHERE reference_id IS NOT NULL DO NOTHING;
  END IF;

  RETURN QUERY
  SELECT p.id, p.email, p.full_name, p.role, p.created_at, v_is_created
  FROM public.profiles p
  WHERE p.id = v_target_id;
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_admin(TEXT, TEXT, NUMERIC)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_admin(TEXT, TEXT, NUMERIC)
  TO service_role;

-- ----------------------------------------------------------------------------
-- 8. HARDEN COMPATIBILITY deduct_credits RPC (Strict service_role Only + Reconcile)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deduct_credits(
  p_user_id UUID,
  p_amount NUMERIC,
  p_reason TEXT,
  p_ref TEXT DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role TEXT;
  v_current NUMERIC;
  v_next NUMERIC;
  v_existing_balance NUMERIC;
  v_rec RECORD;
BEGIN
  v_caller_role := COALESCE(auth.role(), '');
  IF v_caller_role <> 'service_role' AND CURRENT_USER NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Forbidden: deduct_credits requires service_role authorization';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Deduction amount must be strictly positive';
  END IF;

  IF p_ref IS NOT NULL THEN
    SELECT cl.balance_after INTO v_existing_balance
    FROM public.credit_ledger cl
    WHERE cl.user_id = p_user_id
      AND cl.reference_id = p_ref
    LIMIT 1;

    IF FOUND THEN
      RETURN v_existing_balance;
    END IF;
  END IF;

  SELECT ca.balance INTO v_current
  FROM public.credit_accounts ca
  WHERE ca.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit account not found';
  END IF;

  SELECT * INTO v_rec
  FROM public._reconcile_user_expired_reservations(p_user_id, v_current, 100);
  v_current := COALESCE(v_rec.next_balance, v_current);

  IF v_current < p_amount THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  v_next := ROUND(v_current - p_amount, 4);
  IF v_next < 0 THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  UPDATE public.credit_accounts
  SET balance = v_next,
      updated_at = NOW()
  WHERE user_id = p_user_id;

  INSERT INTO public.credit_ledger (user_id, delta, balance_after, reason, reference_id)
  VALUES (p_user_id, -ROUND(p_amount, 4), v_next, p_reason, p_ref);

  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.deduct_credits(UUID, NUMERIC, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_credits(UUID, NUMERIC, TEXT, TEXT)
  TO service_role;
