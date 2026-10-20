import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useHostSelection } from "../src/hooks/useHosts.js";
import { BrainSettings } from "../src/components/BrainSettings.js";

vi.mock("../src/hooks/useHosts.js", () => ({ useHostSelection: vi.fn() }));

const useHostSelectionMock = vi.mocked(useHostSelection);
const fetchMock = vi.fn<typeof fetch>();

const brainSettings = {
  seat: {
    rigId: "rig-1",
    logicalId: "agent-1",
    sessionName: "agent-1@rig",
    runtime: "claude-code",
    model: "model-saved",
    effort: "high",
  },
  running: { model: "model-running", effort: "low" },
  providers: [
    {
      id: "openai" as const,
      label: "OpenAI",
      runtime: "codex",
      accounts: [
        { name: "ops-openai", active: true, loginPresent: true },
        { name: "backup-openai", active: false, loginPresent: false },
      ],
      activeAccount: "ops-openai",
      models: [{ id: "model-next", label: "Next model" }],
      efforts: ["low", "medium", "high"],
      available: true,
    },
    {
      id: "claude" as const,
      label: "Claude",
      runtime: "claude-code",
      accounts: [
        { name: "ops-claude", active: true, loginPresent: true },
        { name: "backup-claude", active: false, loginPresent: true },
      ],
      activeAccount: "ops-claude",
      models: [{ id: "model-saved", label: "Saved model" }],
      efforts: ["low", "medium", "high"],
      available: true,
    },
  ],
};

const plan = {
  planId: "plan-1",
  expiresAt: "2030-01-01T00:00:00Z",
  affectedSeats: ["agent-1", "agent-2"],
  sharedAccount: true,
  providerChange: true,
  newConversation: true,
  summary: "Update two seats and start a new conversation.",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderBrainSettings() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BrainSettings rigId="rig-1" logicalId="agent-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("openrig.terminalBearerToken", "terminal-test-token");
  useHostSelectionMock.mockReturnValue({ known: true, isLocal: true });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (input) => {
    const url = String(input).split("?")[0]!;
    if (url.endsWith("/api/brain/rig-1/agent-1")) return jsonResponse(brainSettings);
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BrainSettings", () => {
  it("shows saved and running values and resets edits to the seat settings", async () => {
    renderBrainSettings();

    expect((await screen.findByLabelText("Provider") as HTMLSelectElement).value).toBe("claude");
    expect(screen.getByText("model-saved")).toBeTruthy();
    expect(screen.getByText("model-running")).toBeTruthy();
    expect(screen.getByText("Active account: ops-claude")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openai" } });
    expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("ops-openai");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "model-next" } });
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "medium" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset changes" }));

    expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("claude");
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("model-saved");
    expect((screen.getByLabelText("Effort") as HTMLSelectElement).value).toBe("high");
  });

  it("marks unknown running observations and explains the resolved saved default", async () => {
    const unknownRunning = {
      ...brainSettings,
      seat: { ...brainSettings.seat, effort: null },
      running: { model: null, effort: null },
    };
    fetchMock.mockResolvedValue(jsonResponse(unknownRunning));

    renderBrainSettings();
    await screen.findByLabelText("Provider");

    expect(screen.getAllByText("Not yet observed")).toHaveLength(2);
    expect(screen.getByText("Saved effort").nextElementSibling?.textContent).toBe("Provider default");
  });

  it("previews changes and applies only after explicit confirmation, then polls to completion", async () => {
    const writes: Array<{ url: string; init: RequestInit }> = [];
    let operationReads = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input).split("?")[0]!;
      if (init?.method === "POST") {
        writes.push({ url, init });
        if (url.endsWith("/plan")) return jsonResponse(plan);
        if (url.endsWith("/apply")) return jsonResponse({ operationId: "operation-1" }, 202);
      }
      if (url.endsWith("/api/brain/operations/operation-1")) {
        operationReads += 1;
        return jsonResponse(operationReads === 1
          ? { status: "running", phase: "saving", message: "Saving configuration" }
          : { status: "completed", phase: "complete", message: "Brain settings applied" });
      }
      if (url.endsWith("/api/brain/rig-1/agent-1")) return jsonResponse(brainSettings);
      return jsonResponse({});
    });

    renderBrainSettings();
    fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "openai" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "model-next" } });
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "medium" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview and apply" }));

    expect(await screen.findByText("Affected seats")).toBeTruthy();
    expect(screen.getByText("agent-1, agent-2")).toBeTruthy();
    expect(screen.getByText(/shared account/i)).toBeTruthy();
    expect(screen.getByText("A new conversation will be started.")).toBeTruthy();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]!.init.body))).toMatchObject({
      provider: "openai",
      account: "ops-openai",
      model: "model-next",
      effort: "medium",
      mode: "apply",
    });
    expect(new Headers(writes[0]!.init.headers).get("Authorization")).toBe("Bearer terminal-test-token");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").some(([url]) => String(url).endsWith("/apply"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.url).toBe("/api/brain/rig-1/agent-1/apply");
    expect(JSON.parse(String(writes[1]!.init.body))).toEqual({ planId: "plan-1", acknowledge: true });
    expect(new Headers(writes[1]!.init.headers).get("Authorization")).toBe("Bearer terminal-test-token");
    expect(await screen.findByText("Brain settings applied", {}, { timeout: 3_000 })).toBeTruthy();
    expect(operationReads).toBeGreaterThanOrEqual(2);
  });

  it("supports save for next resume only when provider and account stay current", async () => {
    const writes: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse(plan);
      }
      return jsonResponse(brainSettings);
    });

    renderBrainSettings();
    await screen.findByLabelText("Provider");
    expect((screen.getByRole("button", { name: "Save for next resume" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openai" } });
    expect((screen.getByRole("button", { name: "Save for next resume" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude" } });
    fireEvent.click(screen.getByRole("button", { name: "Save for next resume" }));

    await screen.findByRole("button", { name: "Confirm save for next resume" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ provider: "claude", account: "ops-claude", mode: "save" });
  });

  it("sends a custom model ID when it is not in the provider catalogue", async () => {
    let planBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        planBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse(plan);
      }
      return jsonResponse(brainSettings);
    });

    renderBrainSettings();
    fireEvent.change(await screen.findByLabelText("Custom model ID (optional)"), { target: { value: "model-private" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview and apply" }));
    await screen.findByRole("button", { name: "Confirm apply" });

    expect(planBody).toMatchObject({ model: "model-private", mode: "apply" });
  });

  it("shows apply errors inline and retries only after another confirmation", async () => {
    let applyCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input).split("?")[0]!;
      if (init?.method === "POST" && url.endsWith("/plan")) return jsonResponse(plan);
      if (init?.method === "POST" && url.endsWith("/apply")) {
        applyCalls += 1;
        return jsonResponse({ error: "Apply service unavailable" }, 503);
      }
      return jsonResponse(brainSettings);
    });

    renderBrainSettings();
    await screen.findByLabelText("Provider");
    fireEvent.click(screen.getByRole("button", { name: "Preview and apply" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm apply" }));

    expect(await screen.findByText("Apply service unavailable")).toBeTruthy();
    expect(applyCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(applyCalls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }));
    expect(await screen.findByText("Apply service unavailable")).toBeTruthy();
    expect(applyCalls).toBe(2);
  });

  it.each([
    ["account_not_signed_in", "The selected account is not signed in. Sign in to that account, then try again."],
    ["seat_working_or_unknown", "This seat is still working or its state is unknown. Check the seat and retry when it is idle."],
    ["preview_expired", "This preview has expired. Create a new preview before applying changes."],
    ["settings_changed", "Brain settings changed after this preview. Refresh the status and create a new preview."],
    ["brain_operation_in_progress", "A Brain settings operation is already in progress. Check its status before starting another."],
    ["provider_or_account_requires_apply", "Provider or account changes take effect when applied to a running seat, not on the next resume."],
    ["conversation_unavailable", "A new conversation could not be started for this seat. Check the seat status and try again."],
    ["native_processes_still_running", "The provider is still running native processes. Wait for them to finish, then retry."],
    ["seat_must_be_running", "This action requires the seat to be running. Start the seat and try again."],
    ["unsupported_effort", "This provider does not support the selected effort. Choose another effort or use the provider default."],
  ])("explains the %s error in plain language", async (code, friendlyMessage) => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") return jsonResponse({ error: code }, 409);
      return jsonResponse(brainSettings);
    });

    renderBrainSettings();
    await screen.findByLabelText("Provider");
    fireEvent.click(screen.getByRole("button", { name: "Preview and apply" }));

    expect(await screen.findByText(friendlyMessage)).toBeTruthy();
    expect(screen.queryByText(code)).toBeNull();
  });

  it("offers an explicit status check after a polling error without reapplying", async () => {
    let applyCalls = 0;
    let statusCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input).split("?")[0]!;
      if (init?.method === "POST" && url.endsWith("/plan")) return jsonResponse(plan);
      if (init?.method === "POST" && url.endsWith("/apply")) {
        applyCalls += 1;
        return jsonResponse({ operationId: "operation-2" }, 202);
      }
      if (url.endsWith("/api/brain/operations/operation-2")) {
        statusCalls += 1;
        return statusCalls === 1
          ? jsonResponse({ error: "Status service unavailable" }, 503)
          : jsonResponse({ status: "completed", phase: "complete", message: "Operation complete" });
      }
      return jsonResponse(brainSettings);
    });

    renderBrainSettings();
    await screen.findByLabelText("Provider");
    fireEvent.click(screen.getByRole("button", { name: "Preview and apply" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm apply" }));

    expect(await screen.findByText(/Unable to refresh operation status/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check status" })).toBeTruthy();
    expect(applyCalls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(await screen.findByText("Operation complete")).toBeTruthy();
    expect(applyCalls).toBe(1);
  });

  it("gates remote hosts as read-only without fetching local brain data or mutating", () => {
    useHostSelectionMock.mockReturnValue({ known: true, isLocal: false });
    renderBrainSettings();

    expect(screen.getByText(/read-only.*remote host/i)).toBeTruthy();
    expect(fetchMock.mock.calls).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Preview and apply" })).toBeNull();
  });

  it("blocks local writes when the selected provider account has no login", async () => {
    const noPrimaryLogin = {
      ...brainSettings,
      providers: brainSettings.providers.map((provider) => provider.id === "claude"
        ? {
          ...provider,
          accounts: provider.accounts.map((account) => account.name === "ops-claude"
            ? { ...account, loginPresent: false }
            : account),
        }
        : provider),
    };
    fetchMock.mockResolvedValue(jsonResponse(noPrimaryLogin));

    renderBrainSettings();
    await screen.findByLabelText("Provider");
    expect((screen.getByRole("button", { name: "Preview and apply" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "backup-claude" } });
    expect((screen.getByRole("button", { name: "Preview and apply" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows read errors inline and requires an explicit refresh", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "Brain service unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse(brainSettings));

    renderBrainSettings();
    expect(await screen.findByText("Brain service unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect((await screen.findByLabelText("Provider") as HTMLSelectElement).value).toBe("claude");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

it("shows a readable error for an incomplete settings response", async () => {
  fetchMock.mockResolvedValue(jsonResponse({}));
  renderBrainSettings();
  expect((await screen.findByRole("alert")).textContent).toContain("Brain settings could not be read. Refresh status to try again.");
});

it("recovers the last operation after the panel is remounted", async () => {
  sessionStorage.setItem("openrig.brainOperation:rig-1:agent-1", "saved-operation");
  fetchMock.mockImplementation(async input => String(input).includes("/operations/")
    ? jsonResponse({status:"completed",phase:"complete",message:"Settings applied."})
    : jsonResponse(brainSettings));
  renderBrainSettings();
  expect(await screen.findByRole("status")).toBeTruthy();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("saved-operation"))).toBe(true);
});
it("refreshes saved values after an incomplete operation", async () => {
  sessionStorage.setItem("openrig.brainOperation:rig-1:agent-1", "incomplete-operation");
  let reads=0;
  fetchMock.mockImplementation(async input => {
    if(String(input).includes("/operations/")) return jsonResponse({status:"incomplete",phase:"resume",message:"Inspect saved settings."});
    reads++;
    return jsonResponse({...brainSettings,seat:{...brainSettings.seat,model:reads>1?"newly-saved":"old-saved"}});
  });
  renderBrainSettings();
  await waitFor(()=>expect(screen.getByText("Saved model", {selector:"dt"}).nextElementSibling?.textContent).toBe("newly-saved"));
});
it("pauses operation tracking while viewing a remote host", async () => {
  sessionStorage.setItem("openrig.brainOperation:rig-1:agent-1", "saved-operation");
  useHostSelectionMock.mockReturnValue({known:true,isLocal:false});
  renderBrainSettings();
  expect(await screen.findByTestId("brain-settings-remote-readonly")).toBeTruthy();
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(fetchMock.mock.calls).toHaveLength(0);
});
