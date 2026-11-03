/**
 * Panel data contract (foundation spec §§1.2/2.1) — Phase 4.
 *
 * The panel is a control-plane SURFACE, not a channel and never a
 * bypass: every action it offers is delegated to the same engines the
 * Telegram surface uses (the Approval Engine's hash-bound records, the
 * Governor's kill flag and ledger, the Vault Broker). This package
 * defines only the data shapes; the control plane implements them.
 * Nothing here can hold a secret value: vault data crosses this
 * contract as NAMES in one direction and as a one-way store call in
 * the other.
 */

export interface PanelStatusData {
  version: string;
  runtimeVersion?: string;
  killed: boolean;
  shield: {
    provisioned: boolean;
    required: boolean;
    /** The operator's recorded fail policy: "closed" | "open". */
    onUnavailable: string;
    baseUrl: string;
  };
  provider: { id: string; model: string };
  pendingApprovals: number;
  spendTodayUsd: number;
  spendMonthUsd: number;
}

export interface PanelLedgerData {
  /** Raw ledger entries (reserve/settle/refund), oldest first. */
  entries: Record<string, unknown>[];
  audit: {
    reserves: number;
    settles: number;
    refunds: number;
    openReservations: number;
    settledUsd: number;
    reconciles: boolean;
  };
  summary: {
    todayUsd: number;
    monthUsd: number;
    totalUsd: number;
    caps: Record<string, unknown>;
  };
}

export interface PanelShieldReceiptRef {
  receiptId: string;
  /** Public verification page for this receipt, when known. */
  verifyUrl?: string;
}

export interface PanelJobData {
  id: string;
  kind: string;
  state: string;
  createdAt: number;
  updatedAt: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  outcomeNote?: string;
  /** The settlement receipt id. "gus_rcpt_…" = local stub (Phase 0
   *  issuer, kept only where no Shield call applied); "rcpt_…" = a
   *  real, verifiable Agent-Shield receipt. */
  receiptId?: string;
  receiptVerifyUrl?: string;
  shieldReceipts: PanelShieldReceiptRef[];
}

export interface PanelApprovalData {
  id: string;
  jobId: string;
  /** Plain-language description of exactly what will happen. */
  summary: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
}

export interface PanelOnboardingStep {
  done: boolean;
  detail?: string;
}

export interface PanelOnboardingData {
  steps: {
    shield: PanelOnboardingStep;
    telegram: PanelOnboardingStep;
    provider: PanelOnboardingStep;
    caps: PanelOnboardingStep;
    firstJob: PanelOnboardingStep;
  };
  /** Pre-filled, editable starting points (plain numbers, USD). */
  suggestedCaps: { maxUsdPerTask: number; maxUsdPerDay: number; maxUsdPerMonth: number };
  currentProvider?: { provider: string; model: string; baseUrl?: string };
}

export interface PanelSkillData {
  name: string;
  verdict: string;
  installedAt: number;
}

export interface PanelActionResult {
  ok: boolean;
  detail: string;
}

export interface PanelBackend {
  status(): PanelStatusData;
  ledger(): PanelLedgerData;
  jobs(): PanelJobData[];
  approvals(): PanelApprovalData[];
  /** Resolve over the SAME approval engine + execution path the
   *  channel uses — the panel cannot widen, rebind, or forge. */
  resolveApproval(id: string, approve: boolean): Promise<PanelActionResult>;
  setKilled(on: boolean): Promise<PanelActionResult>;
  /** Names only — there is no read path for values, here either. */
  vaultNames(): string[];
  storeSecret(name: string, value: string): PanelActionResult;
  onboarding(): PanelOnboardingData;
  onboardingShield(payload: { onUnavailable?: string }): Promise<PanelActionResult>;
  onboardingTelegram(payload: { token?: string }): Promise<PanelActionResult>;
  onboardingProvider(payload: Record<string, unknown>): Promise<PanelActionResult>;
  onboardingCaps(payload: Record<string, unknown>): Promise<PanelActionResult>;
  onboardingFirstJob(): Promise<PanelActionResult & { jobId?: string }>;
  skills(): PanelSkillData[];
  installSkill(payload: { path?: string }): Promise<
    PanelActionResult & { verdict?: string; findings?: Record<string, unknown>[] }
  >;
}
