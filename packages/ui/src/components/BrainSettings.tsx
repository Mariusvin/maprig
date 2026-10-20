import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { terminalAuthHeaders } from "./mission-control/missionControlAuth.js";
import { useHostSelection } from "../hooks/useHosts.js";

type ProviderId = "openai" | "claude";
type PlanMode = "save" | "apply";
type OperationStatus = "completed" | "incomplete" | "failed" | "running";

interface BrainAccount {
  name: string;
  active: boolean;
  loginPresent: boolean;
}

interface BrainModel {
  id: string;
  label: string;
}

interface BrainProvider {
  id: ProviderId;
  label: string;
  runtime: string;
  accounts: BrainAccount[];
  activeAccount: string;
  models: BrainModel[];
  efforts: string[];
  available: boolean;
  issue?: string;
}

interface BrainSettingsResponse {
  seat: {
    rigId: string;
    logicalId: string;
    sessionName: string;
    runtime: string;
    model: string | null;
    effort: string | null;
  };
  running: { model: string | null; effort: string | null };
  providers: BrainProvider[];
}

interface BrainPlan {
  planId: string;
  expiresAt: string;
  affectedSeats: string[];
  sharedAccount: boolean;
  providerChange: boolean;
  newConversation: boolean;
  summary: string;
}

interface BrainOperation {
  status: OperationStatus;
  phase: string;
  message?: string;
  error?: string;
}

interface BrainForm {
  provider: ProviderId | "";
  account: string;
  model: string;
  customModel: string;
  effort: string;
}

interface BrainSettingsProps {
  rigId: string;
  logicalId: string;
}

const inputClass = "min-h-9 w-full border border-outline-variant bg-surface-lowest px-2 font-mono text-xs text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary";
const labelClass = "font-mono text-xs text-on-surface-variant";
const secondaryButtonClass = "min-h-9 border border-outline-variant px-3 font-mono text-xs text-on-surface hover:bg-surface-low disabled:cursor-not-allowed disabled:opacity-50";
const primaryButtonClass = "min-h-9 border border-on-surface bg-on-surface px-3 font-mono text-xs text-background hover:bg-on-surface/90 disabled:cursor-not-allowed disabled:opacity-50";

const BRAIN_ERROR_MESSAGES: Record<string, string> = {
  account_not_signed_in: "The selected account is not signed in. Sign in to that account, then try again.",
  seat_working_or_unknown: "This seat is still working or its state is unknown. Check the seat and retry when it is idle.",
  preview_expired: "This preview has expired. Create a new preview before applying changes.",
  settings_changed: "Brain settings changed after this preview. Refresh the status and create a new preview.",
  brain_operation_in_progress: "A Brain settings operation is already in progress. Check its status before starting another.",
  provider_or_account_requires_apply: "Provider or account changes take effect when applied to a running seat, not on the next resume.",
  conversation_unavailable: "A new conversation could not be started for this seat. Check the seat status and try again.",
  native_processes_still_running: "The provider is still running native processes. Wait for them to finish, then retry.",
  seat_must_be_running: "This action requires the seat to be running. Start the seat and try again.",
  unsupported_effort: "This provider does not support the selected effort. Choose another effort or use the provider default.",
};

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const code = typeof record.code === "string"
      ? record.code
      : typeof record.error === "string"
        ? record.error
        : "";
    if (BRAIN_ERROR_MESSAGES[code]) return BRAIN_ERROR_MESSAGES[code]!;
    if (typeof record.message === "string" && record.message.trim()) return record.message;
    if (typeof record.error === "string" && record.error.trim()) return record.error;
  }
  return `HTTP ${status}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}host=local`, init);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(errorMessage(body, response.status));
  return body as T;
}

function brainUrl(rigId: string, logicalId: string): string {
  return `/api/brain/${encodeURIComponent(rigId)}/${encodeURIComponent(logicalId)}`;
}

function selectedProviderForRuntime(providers: BrainProvider[], runtime: string): BrainProvider | undefined {
  return providers.find((provider) => provider.runtime === runtime || provider.id === runtime);
}

function formForSeat(data: BrainSettingsResponse): BrainForm {
  const provider = selectedProviderForRuntime(data.providers, data.seat.runtime);
  const savedModel = data.seat.model ?? "";
  const modelInCatalog = provider?.models.some((model) => model.id === savedModel) ?? false;
  return {
    provider: provider?.id ?? "",
    account: provider?.activeAccount ?? "",
    model: modelInCatalog ? savedModel : "",
    customModel: savedModel && !modelInCatalog ? savedModel : "",
    effort: data.seat.effort ?? "",
  };
}

function isTerminalOperation(status: OperationStatus | undefined): boolean {
  return status === "completed" || status === "incomplete" || status === "failed";
}

export function BrainSettings({ rigId, logicalId }: BrainSettingsProps) {
  const host = useHostSelection();
  const queryClient = useQueryClient();
  const settingsKey = ["rig", rigId, "brain", logicalId] as const;
  const [form, setForm] = useState<BrainForm>({
    provider: "",
    account: "",
    model: "",
    customModel: "",
    effort: "",
  });
  const [preview, setPreview] = useState<{ mode: PlanMode; plan: BrainPlan } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const operationStorageKey = `openrig.brainOperation:${rigId}:${logicalId}`;
  const [operationId, setOperationId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(operationStorageKey); } catch { return null; }
  });
  useEffect(() => {
    try {
      if (operationId) sessionStorage.setItem(operationStorageKey, operationId);
      else sessionStorage.removeItem(operationStorageKey);
    } catch { /* Status tracking still works when browser storage is unavailable. */ }
  }, [operationId, operationStorageKey]);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  const settingsQuery = useQuery({
    queryKey: settingsKey,
    queryFn: async () => {
      const settings = await requestJson<BrainSettingsResponse>(brainUrl(rigId, logicalId));
      if (!settings?.seat || !settings.running || !Array.isArray(settings.providers)) {
        throw new Error("Brain settings could not be read. Refresh status to try again.");
      }
      return settings;
    },
    enabled: host.known && host.isLocal,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const operationQuery = useQuery({
    queryKey: ["brain-operation", operationId],
    queryFn: () => requestJson<BrainOperation>(`/api/brain/operations/${encodeURIComponent(operationId!)}`),
    enabled: operationId !== null && host.known && host.isLocal,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      if (query.state.error || isTerminalOperation(query.state.data?.status)) return false;
      return 1_000;
    },
  });

  useEffect(() => {
    if (settingsQuery.data) setForm(formForSeat(settingsQuery.data));
  }, [settingsQuery.dataUpdatedAt]);

  const refreshedOperation = useRef<string | null>(null);
  useEffect(() => {
    if (!isTerminalOperation(operationQuery.data?.status) || settingsQuery.isFetching || !settingsQuery.data || refreshedOperation.current === operationId) return;
    refreshedOperation.current = operationId;
    void queryClient.invalidateQueries({ queryKey: ["rig", rigId] });
  }, [operationQuery.data?.status, operationId, settingsQuery.isFetching, settingsQuery.dataUpdatedAt, queryClient, rigId]);

  const data = settingsQuery.data;
  const provider = data?.providers.find((candidate) => candidate.id === form.provider);
  const baselineProvider = data ? selectedProviderForRuntime(data.providers, data.seat.runtime) : undefined;
  const baselineAccount = baselineProvider?.activeAccount ?? "";
  const selectedAccount = provider?.accounts.find((account) => account.name === form.account);
  const isCurrentProviderAccount =
    !!baselineProvider && form.provider === baselineProvider.id && form.account === baselineAccount;
  const operationStatus = operationQuery.data?.status;
  const operationPending = operationId !== null && !isTerminalOperation(operationStatus);
  const busy = isPlanning || isApplying || operationPending;
  const editingLocked = busy || preview !== null;
  const canSubmit = !!provider && provider.available && !!form.account && !!selectedAccount?.loginPresent && !editingLocked;
  const canSave = canSubmit && isCurrentProviderAccount;

  if (!host.known) {
    return (
      <section aria-labelledby="brain-settings-title" className="border border-outline-variant">
        <h2 id="brain-settings-title" className="border-b border-outline-variant px-3 py-2 font-mono text-sm font-bold">Brain settings</h2>
        <p className="px-3 py-3 font-mono text-xs text-on-surface-variant">Checking selected host...</p>
      </section>
    );
  }

  if (!host.isLocal) {
    return (
      <section aria-labelledby="brain-settings-title" data-testid="brain-settings-remote-readonly" className="border border-outline-variant">
        <h2 id="brain-settings-title" className="border-b border-outline-variant px-3 py-2 font-mono text-sm font-bold">Brain settings</h2>
        <p className="px-3 py-3 font-mono text-xs text-on-surface-variant">Read-only - remote host. Brain settings can only be changed on the local host.</p>
      </section>
    );
  }

  const resetForm = () => {
    if (data) setForm(formForSeat(data));
  };

  const beginPlan = async (mode: PlanMode) => {
    if (!data || !provider || !canSubmit || (mode === "save" && !canSave)) return;
    setPlanError(null);
    setPreview(null);
    setOperationId(null);
    setIsPlanning(true);
    const selectedModel = form.customModel.trim() || form.model || null;
    try {
      const nextPlan = await requestJson<BrainPlan>(`${brainUrl(rigId, logicalId)}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...terminalAuthHeaders() },
        body: JSON.stringify({
          provider: provider.id,
          account: form.account,
          model: selectedModel,
          effort: form.effort || null,
          mode,
        }),
      });
      setPreview({ mode, plan: nextPlan });
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Could not create a plan.");
    } finally {
      setIsPlanning(false);
    }
  };

  const confirmPlan = async () => {
    if (!preview || isApplying) return;
    setPlanError(null);
    setIsApplying(true);
    try {
      const result = await requestJson<{ operationId: string }>(`${brainUrl(rigId, logicalId)}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...terminalAuthHeaders() },
        body: JSON.stringify({ planId: preview.plan.planId, acknowledge: true }),
      });
      setPreview(null);
      setOperationId(result.operationId);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "Could not apply this plan.");
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <section aria-labelledby="brain-settings-title" data-testid="brain-settings" className="border border-outline-variant">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant px-3 py-2">
        <h2 id="brain-settings-title" className="font-mono text-sm font-bold">Brain settings</h2>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => { setPlanError(null); void settingsQuery.refetch(); }}
          disabled={settingsQuery.isFetching || busy || preview !== null}
        >
          Refresh status
        </button>
      </div>

      {settingsQuery.error && (
        <div role="alert" className="border-b border-error px-3 py-2 font-mono text-xs text-error">
          {settingsQuery.error.message}
        </div>
      )}

      {settingsQuery.isPending ? (
        <p className="px-3 py-3 font-mono text-xs text-on-surface-variant">Loading brain settings...</p>
      ) : data ? (
        <>
          <dl className="grid grid-cols-[minmax(8rem,0.7fr)_minmax(0,1.3fr)] font-mono text-xs">
            <dt className="border-b border-outline-variant px-3 py-2 text-on-surface-variant">Session</dt>
            <dd className="border-b border-outline-variant px-3 py-2 text-on-surface">{data.seat.sessionName}</dd>
            <dt className="border-b border-outline-variant px-3 py-2 text-on-surface-variant">Saved model</dt>
            <dd className="border-b border-outline-variant px-3 py-2 text-on-surface">{data.seat.model ?? "Provider default"}</dd>
            <dt className="border-b border-outline-variant px-3 py-2 text-on-surface-variant">Saved effort</dt>
            <dd className="border-b border-outline-variant px-3 py-2 text-on-surface">{data.seat.effort ?? "Provider default"}</dd>
            <dt className="border-b border-outline-variant px-3 py-2 text-on-surface-variant">Running model</dt>
            <dd className="border-b border-outline-variant px-3 py-2 text-on-surface">{data.running.model ?? "Not yet observed"}</dd>
            <dt className="border-b border-outline-variant px-3 py-2 text-on-surface-variant">Running effort</dt>
            <dd className="border-b border-outline-variant px-3 py-2 text-on-surface">{data.running.effort ?? "Not yet observed"}</dd>
          </dl>

          {provider && (
            <div className="border-b border-outline-variant px-3 py-2 font-mono text-xs text-on-surface-variant">
              <p>Active account: {provider.activeAccount || "none"}</p>
              {form.account && (
                <p className="mt-1">
                  Selected account login: {selectedAccount ? selectedAccount.loginPresent ? "available" : "missing" : "not listed"}
                </p>
              )}
            </div>
          )}

          <div className="grid gap-x-4 gap-y-3 px-3 py-3 sm:grid-cols-2">
            <label className="grid gap-1" htmlFor="brain-provider">
              <span className={labelClass}>Provider</span>
              <select
                id="brain-provider"
                className={inputClass}
                value={form.provider}
                disabled={editingLocked}
                onChange={(event) => {
                  const providerId = event.currentTarget.value;
                  const nextProvider = data.providers.find((candidate) => candidate.id === providerId);
                  setForm((current) => ({
                    ...current,
                    provider: nextProvider?.id ?? "",
                    account: nextProvider?.activeAccount ?? "",
                    model: "",
                    customModel: "",
                    effort: "",
                  }));
                }}
              >
                <option value="">Choose provider</option>
                {data.providers.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}{candidate.available ? "" : " - unavailable"}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1" htmlFor="brain-account">
              <span className={labelClass}>Account</span>
              <select
                id="brain-account"
                className={inputClass}
                value={form.account}
                disabled={editingLocked || !provider}
                onChange={(event) => {
                  const account = event.currentTarget.value;
                  setForm((current) => ({ ...current, account }));
                }}
              >
                <option value="">Select account</option>
                {provider?.activeAccount && !provider.accounts.some((account) => account.name === provider.activeAccount) && (
                  <option value={provider.activeAccount}>{provider.activeAccount} - active</option>
                )}
                {provider?.accounts.map((account) => (
                  <option key={account.name} value={account.name}>
                    {account.name}{account.active ? " - active" : ""}{account.loginPresent ? "" : " - login missing"}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid gap-1">
              <label className={labelClass} htmlFor="brain-model">Model</label>
              <select
                id="brain-model"
                className={inputClass}
                value={form.model}
                disabled={editingLocked || !provider}
                onChange={(event) => {
                  const model = event.currentTarget.value;
                  setForm((current) => ({ ...current, model, customModel: "" }));
                }}
              >
                <option value="">Provider default</option>
                {provider?.models.map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                ))}
              </select>
              <p className="font-mono text-[10px] text-on-surface-variant">Available models can vary by account.</p>
              <label className={labelClass} htmlFor="brain-custom-model">Custom model ID (optional)</label>
              <input
                type="text"
                id="brain-custom-model"
                className={inputClass}
                value={form.customModel}
                disabled={editingLocked || !provider}
                onChange={(event) => {
                  const customModel = event.currentTarget.value;
                  setForm((current) => ({ ...current, customModel, model: "" }));
                }}
                placeholder="Custom model ID (optional)"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <label className="grid gap-1" htmlFor="brain-effort">
              <span className={labelClass}>Effort</span>
              <select
                id="brain-effort"
                className={inputClass}
                value={form.effort}
                disabled={editingLocked || !provider}
                onChange={(event) => {
                  const effort = event.currentTarget.value;
                  setForm((current) => ({ ...current, effort }));
                }}
              >
                <option value="">Provider default</option>
                {provider?.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
          </div>

          {provider && (!provider.available || provider.issue) && (
            <p role="alert" className="mx-3 mb-3 border border-error px-3 py-2 font-mono text-xs text-error">
              {provider.issue || "This provider is unavailable."}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant px-3 py-3">
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => { resetForm(); setPlanError(null); setPreview(null); }}
              disabled={editingLocked}
            >
              Reset changes
            </button>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => { void beginPlan("save"); }}
              disabled={!canSave || isPlanning || isApplying}
            >
              Save for next resume
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => { void beginPlan("apply"); }}
              disabled={!canSubmit || isPlanning || isApplying}
            >
              Preview and apply
            </button>
          </div>

          {planError && <p role="alert" className="border-t border-error px-3 py-2 font-mono text-xs text-error">{planError}</p>}

          {preview && (
            <div aria-label="Plan preview" className="border-t border-outline-variant px-3 py-3 font-mono text-xs">
              <h3 className="font-bold text-on-surface">Plan preview</h3>
              <p className="mt-2 text-on-surface">{preview.plan.summary}</p>
              <dl className="mt-2 grid grid-cols-[minmax(8rem,0.7fr)_minmax(0,1.3fr)]">
                <dt className="border-t border-outline-variant py-2 text-on-surface-variant">Affected seats</dt>
                <dd className="border-t border-outline-variant py-2 text-on-surface">{preview.plan.affectedSeats.length > 0 ? preview.plan.affectedSeats.join(", ") : "None listed"}</dd>
                <dt className="border-t border-outline-variant py-2 text-on-surface-variant">Shared account</dt>
                <dd className="border-t border-outline-variant py-2 text-on-surface">{preview.plan.sharedAccount ? "This account is shared across the affected seats." : "No shared account impact."}</dd>
                <dt className="border-t border-outline-variant py-2 text-on-surface-variant">Provider change</dt>
                <dd className="border-t border-outline-variant py-2 text-on-surface">{preview.plan.providerChange ? "Provider will change." : "Provider stays the same."}</dd>
                <dt className="border-t border-outline-variant py-2 text-on-surface-variant">Conversation</dt>
                <dd className="border-t border-outline-variant py-2 text-on-surface">{preview.plan.newConversation ? "A new conversation will be started." : "No new conversation is required."}</dd>
                <dt className="border-t border-outline-variant py-2 text-on-surface-variant">Plan expires</dt>
                <dd className="border-t border-outline-variant py-2 text-on-surface">{preview.plan.expiresAt}</dd>
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={primaryButtonClass}
                  onClick={() => { void confirmPlan(); }}
                  disabled={isApplying || isPlanning}
                >
                  {preview.mode === "save" ? "Confirm save for next resume" : "Confirm apply"}
                </button>
                <button
                  type="button"
                  className={secondaryButtonClass}
                  onClick={() => { setPreview(null); setPlanError(null); }}
                  disabled={isApplying}
                >
                  Cancel preview
                </button>
              </div>
            </div>
          )}

          {operationId && (
            <div className="border-t border-outline-variant px-3 py-3 font-mono text-xs" aria-live="polite">
              {operationQuery.error ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p role="alert" className="text-error">Unable to refresh operation status: {operationQuery.error.message}</p>
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={() => { void operationQuery.refetch(); }}
                    disabled={operationQuery.isFetching}
                  >
                    Check status
                  </button>
                </div>
              ) : operationQuery.data ? (
                <p role="status" className={operationQuery.data.status === "failed" || operationQuery.data.status === "incomplete" ? "text-error" : "text-on-surface"}>
                  <span className="font-bold">{operationQuery.data.status}</span>
                  <span className="ml-2">{operationQuery.data.message || operationQuery.data.error || operationQuery.data.phase}</span>
                </p>
              ) : (
                <p role="status" className="text-on-surface-variant">Starting operation status check...</p>
              )}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
