-- ============================================================================
-- AVAREST ONE — P0 SECURITY HARDENING & CORRECTIVE MIGRATION
-- Idempotent migration layered on top of 0001_initial_schema.sql.
-- Target: Staging first (avarest-ai-staging). Never run directly on Production
-- without staging verification and explicit release approval.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. HARDEN SECURITY DEFINER FUNCTIONS (search_path = '', qualified refs, grants)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role IN ('admin', 'super_admin')
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_org_member(org_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members om
    WHERE om.organization_id = org_id
      AND om.user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_org_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_member(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_org_admin(org_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members om
    WHERE om.organization_id = org_id
      AND om.user_id = auth.uid()
      AND om.member_role IN ('owner', 'admin')
  );
$$;

REVOKE ALL ON FUNCTION public.is_org_admin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_admin(UUID) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. HARDEN ATOMIC CREDIT DEDUCTION (Prevent arbitrary victim deduction & double spend)
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_user_ref_unique
  ON public.credit_ledger (user_id, reference_id)
  WHERE reference_id IS NOT NULL;

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
BEGIN
  v_caller_role := COALESCE(auth.role(), '');
  IF v_caller_role <> 'service_role' AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Forbidden: caller cannot deduct credits for another user';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Deduction amount must be strictly positive';
  END IF;

  -- Idempotency check when a reference ID is provided (prevents duplicate deduction on retry)
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

-- Server/backend service_role executes credit deductions; disallow arbitrary client RPC calls
REVOKE ALL ON FUNCTION public.deduct_credits(UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_credits(UUID, NUMERIC, TEXT, TEXT) TO service_role;

-- ----------------------------------------------------------------------------
-- 3. PREVENT SELF-ROLE & PLAN ESCALATION ON public.profiles
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_profile_sensitive_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
BEGIN
  v_role := COALESCE(auth.role(), '');
  -- Allow trusted backend service_role or direct PostgreSQL superuser migrations
  IF v_role = 'service_role' OR CURRENT_USER IN ('postgres', 'supabase_admin') THEN
    NEW.updated_at := NOW();
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Forbidden: profile id is immutable';
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Forbidden: only platform administrators via service_role can change user roles';
  END IF;

  IF NEW.active_plan IS DISTINCT FROM OLD.active_plan THEN
    RAISE EXCEPTION 'Forbidden: subscription plan changes must be verified server-side';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_profile_sensitive_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_protect_profile_sensitive_columns ON public.profiles;
CREATE TRIGGER trg_protect_profile_sensitive_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_sensitive_columns();

-- Auto-provision profile + initial credit account on Supabase Auth user signup
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, active_plan)
  VALUES (
    NEW.id,
    LOWER(COALESCE(NEW.email, '')),
    COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data ->> 'full_name'), ''), SPLIT_PART(COALESCE(NEW.email, 'user'), '@', 1)),
    'user',
    'free'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.credit_accounts (user_id, balance, monthly_allowance)
  VALUES (NEW.id, 100.0000, 100.0000)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- ----------------------------------------------------------------------------
-- 4. EXPLICIT SEPARATE RLS POLICIES (SELECT / INSERT / UPDATE / DELETE)
-- ----------------------------------------------------------------------------

-- PROFILES
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;

CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.is_admin());

CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id AND role = 'user' AND active_plan = 'free');

CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ORGANIZATIONS (previously missing policies in 0001)
DROP POLICY IF EXISTS organizations_select ON public.organizations;
DROP POLICY IF EXISTS organizations_insert ON public.organizations;
DROP POLICY IF EXISTS organizations_update ON public.organizations;
DROP POLICY IF EXISTS organizations_delete ON public.organizations;

CREATE POLICY organizations_select ON public.organizations
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR public.is_org_member(id) OR public.is_admin());

CREATE POLICY organizations_insert ON public.organizations
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY organizations_update ON public.organizations
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.is_org_admin(id))
  WITH CHECK (owner_id = auth.uid() OR public.is_org_admin(id));

CREATE POLICY organizations_delete ON public.organizations
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin());

-- ORGANIZATION MEMBERS (previously missing policies in 0001)
DROP POLICY IF EXISTS org_members_select ON public.organization_members;
DROP POLICY IF EXISTS org_members_insert ON public.organization_members;
DROP POLICY IF EXISTS org_members_update ON public.organization_members;
DROP POLICY IF EXISTS org_members_delete ON public.organization_members;

CREATE POLICY org_members_select ON public.organization_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_org_member(organization_id) OR public.is_admin());

CREATE POLICY org_members_insert ON public.organization_members
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_org_admin(organization_id)
    OR EXISTS (
      SELECT 1 FROM public.organizations o
      WHERE o.id = organization_id AND o.owner_id = auth.uid()
    )
  );

CREATE POLICY org_members_update ON public.organization_members
  FOR UPDATE TO authenticated
  USING (public.is_org_admin(organization_id))
  WITH CHECK (public.is_org_admin(organization_id));

CREATE POLICY org_members_delete ON public.organization_members
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.is_org_admin(organization_id));

-- PROJECTS
DROP POLICY IF EXISTS projects_owner_all ON public.projects;
CREATE POLICY projects_select ON public.projects
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR (organization_id IS NOT NULL AND public.is_org_member(organization_id)));
CREATE POLICY projects_insert ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND (organization_id IS NULL OR public.is_org_member(organization_id)));
CREATE POLICY projects_update ON public.projects
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR (organization_id IS NOT NULL AND public.is_org_admin(organization_id)))
  WITH CHECK (auth.uid() = user_id OR (organization_id IS NOT NULL AND public.is_org_admin(organization_id)));
CREATE POLICY projects_delete ON public.projects
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- CONVERSATIONS
DROP POLICY IF EXISTS conversations_owner_all ON public.conversations;
CREATE POLICY conversations_select ON public.conversations FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY conversations_insert ON public.conversations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY conversations_update ON public.conversations FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY conversations_delete ON public.conversations FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- MESSAGES
DROP POLICY IF EXISTS messages_owner_all ON public.messages;
CREATE POLICY messages_select ON public.messages FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY messages_insert ON public.messages FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY messages_delete ON public.messages FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- ATTACHMENTS
DROP POLICY IF EXISTS attachments_owner_all ON public.attachments;
CREATE POLICY attachments_select ON public.attachments FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY attachments_insert ON public.attachments FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY attachments_delete ON public.attachments FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- AGENTS, RUNS & APPROVALS
DROP POLICY IF EXISTS agents_owner_all ON public.agents;
CREATE POLICY agents_select ON public.agents FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY agents_insert ON public.agents FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY agents_update ON public.agents FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY agents_delete ON public.agents FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS agent_runs_owner_all ON public.agent_runs;
CREATE POLICY agent_runs_select ON public.agent_runs FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY agent_runs_insert ON public.agent_runs FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY agent_runs_update ON public.agent_runs FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS agent_approvals_owner_all ON public.agent_approvals;
CREATE POLICY agent_approvals_select ON public.agent_approvals FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY agent_approvals_insert ON public.agent_approvals FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY agent_approvals_update ON public.agent_approvals FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- RESEARCH REPORTS
DROP POLICY IF EXISTS research_reports_owner_all ON public.research_reports;
CREATE POLICY research_reports_select ON public.research_reports FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY research_reports_insert ON public.research_reports FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY research_reports_delete ON public.research_reports FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- KNOWLEDGE DOCUMENTS & CHUNKS
ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS storage_path TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_mode TEXT NOT NULL DEFAULT 'keyword_rank'
    CHECK (retrieval_mode IN ('keyword_rank', 'pgvector_hybrid'));

DROP POLICY IF EXISTS knowledge_docs_owner_all ON public.knowledge_documents;
CREATE POLICY knowledge_docs_select ON public.knowledge_documents FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY knowledge_docs_insert ON public.knowledge_documents FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY knowledge_docs_delete ON public.knowledge_documents FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS knowledge_chunks_owner_all ON public.knowledge_chunks;
CREATE POLICY knowledge_chunks_select ON public.knowledge_chunks FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY knowledge_chunks_insert ON public.knowledge_chunks FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY knowledge_chunks_delete ON public.knowledge_chunks FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- USER MEMORIES
DROP POLICY IF EXISTS user_memories_owner_all ON public.user_memories;
CREATE POLICY user_memories_select ON public.user_memories FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY user_memories_insert ON public.user_memories FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY user_memories_delete ON public.user_memories FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- CONNECTED ACCOUNTS
DROP POLICY IF EXISTS connected_accounts_owner_all ON public.connected_accounts;
CREATE POLICY connected_accounts_select ON public.connected_accounts FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY connected_accounts_insert ON public.connected_accounts FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY connected_accounts_update ON public.connected_accounts FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY connected_accounts_delete ON public.connected_accounts FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- AI PROVIDERS & MODELS (Enable RLS + Restrict initial release to 4 active providers)
ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_models ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_providers_read ON public.ai_providers;
CREATE POLICY ai_providers_read ON public.ai_providers FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS ai_providers_admin_write ON public.ai_providers;
CREATE POLICY ai_providers_admin_write ON public.ai_providers FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS ai_models_read ON public.ai_models;
CREATE POLICY ai_models_read ON public.ai_models FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS ai_models_admin_write ON public.ai_models;
CREATE POLICY ai_models_admin_write ON public.ai_models FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ROUTING POLICIES & FEATURE FLAGS (Split admin write policies cleanly)
DROP POLICY IF EXISTS routing_policies_admin ON public.routing_policies;
CREATE POLICY routing_policies_select ON public.routing_policies FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY routing_policies_admin_insert ON public.routing_policies FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY routing_policies_admin_update ON public.routing_policies FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY routing_policies_admin_delete ON public.routing_policies FOR DELETE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS feature_flags_admin_write ON public.feature_flags;
CREATE POLICY feature_flags_admin_insert ON public.feature_flags FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY feature_flags_admin_update ON public.feature_flags FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY feature_flags_admin_delete ON public.feature_flags FOR DELETE TO authenticated USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- 5. SEED INITIAL 4 ACTIVE PROVIDERS & DEFAULT ROUTING / FLAGS (IDEMPOTENT)
-- ----------------------------------------------------------------------------
INSERT INTO public.ai_providers (id, display_name, enabled) VALUES
  ('openai', 'OpenAI', TRUE),
  ('gemini', 'Google Gemini', TRUE),
  ('anthropic', 'Anthropic Claude', TRUE),
  ('deepseek', 'DeepSeek', TRUE),
  ('xai', 'xAI Grok (Disabled for Initial Release)', FALSE),
  ('llama', 'Meta Llama (Disabled for Initial Release)', FALSE)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  enabled = EXCLUDED.enabled,
  updated_at = NOW();

INSERT INTO public.ai_models (id, provider_id, display_name, capabilities, context_window, cost_tier, latency_tier, enabled) VALUES
  ('gemini-4-hydrogen', 'gemini', 'Gemini 4 Hydrogen', ARRAY['chat','streaming','coding','research','reasoning'], 1000000, 'standard', 'fast', TRUE),
  ('gemini-3.1-flash-lite', 'gemini', 'Gemini 3.1 Flash Lite', ARRAY['chat','streaming','research'], 1000000, 'economy', 'ultra_fast', TRUE),
  ('gpt-4o-mini', 'openai', 'GPT-4o Mini', ARRAY['chat','streaming','coding'], 128000, 'economy', 'ultra_fast', TRUE),
  ('gpt-4o', 'openai', 'GPT-4o', ARRAY['chat','streaming','coding','reasoning'], 128000, 'premium', 'fast', TRUE),
  ('claude-3-5-sonnet-latest', 'anthropic', 'Claude 3.5 Sonnet', ARRAY['chat','streaming','coding','reasoning'], 200000, 'premium', 'fast', TRUE),
  ('claude-3-5-haiku-latest', 'anthropic', 'Claude 3.5 Haiku', ARRAY['chat','streaming','coding'], 200000, 'economy', 'ultra_fast', TRUE),
  ('deepseek-chat', 'deepseek', 'DeepSeek V3', ARRAY['chat','streaming','coding','reasoning'], 64000, 'economy', 'fast', TRUE),
  ('deepseek-reasoner', 'deepseek', 'DeepSeek R1', ARRAY['chat','streaming','reasoning','coding'], 64000, 'standard', 'reasoning', TRUE)
ON CONFLICT (id) DO UPDATE SET
  provider_id = EXCLUDED.provider_id,
  display_name = EXCLUDED.display_name,
  capabilities = EXCLUDED.capabilities,
  context_window = EXCLUDED.context_window,
  cost_tier = EXCLUDED.cost_tier,
  latency_tier = EXCLUDED.latency_tier,
  enabled = EXCLUDED.enabled;

INSERT INTO public.feature_flags (key, enabled, description) VALUES
  ('streaming_chat', TRUE, 'Enable Server-Sent Events streaming in AI Chat'),
  ('model_comparison', TRUE, 'Allow side-by-side comparison of configured models'),
  ('deep_research_grounding', TRUE, 'Use Google Search Grounding for Deep Research when Gemini is configured'),
  ('human_approval_checkpoints', TRUE, 'Require explicit user approval for sensitive agent actions'),
  ('live_billing_checkout', FALSE, 'Disabled until payment processor credentials are approved')
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 6. PRIVATE SUPABASE STORAGE BUCKET & OWNER-ONLY RLS POLICIES
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'knowledge-documents',
  'knowledge-documents',
  FALSE,
  5242880,
  ARRAY['text/plain', 'text/markdown', 'text/csv', 'application/json']
)
ON CONFLICT (id) DO UPDATE SET
  public = FALSE,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS knowledge_bucket_select ON storage.objects;
DROP POLICY IF EXISTS knowledge_bucket_insert ON storage.objects;
DROP POLICY IF EXISTS knowledge_bucket_update ON storage.objects;
DROP POLICY IF EXISTS knowledge_bucket_delete ON storage.objects;

CREATE POLICY knowledge_bucket_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'knowledge-documents' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY knowledge_bucket_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'knowledge-documents' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY knowledge_bucket_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'knowledge-documents' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'knowledge-documents' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY knowledge_bucket_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'knowledge-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
