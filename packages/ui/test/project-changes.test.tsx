import React from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectChanges } from "../src/components/project/ProjectChanges.js";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("../src/components/project/PlanningGraph.js", () => ({ usePlanningProjects: () => ({ data: { projects: [{ id: "demo", name: "Demo" }] }, error: null }) }));
afterEach(() => { vi.unstubAllGlobals(); });
const state = { repository: "/copies/demo", head: "a".repeat(40), branch: "main", identity: { name: "Test Author", email: "test@example.invalid" },
  changes: [{ path: "selected.txt", status: " M" }, { path: "other.txt", status: "M " }], fingerprint: "fingerprint" };
function setup(commitError = false) {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") return { ok: !commitError, json: async () => commitError ? { error: "project_git_stale", message: "Refresh the project status before committing." } : { commit: "b".repeat(40), remainingChanges: 1 } };
    return { ok: true, json: async () => url.includes("/diff?") ? { path: "selected.txt", diff: "+reviewed change" } : state };
  });
  vi.stubGlobal("fetch", fetch);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ProjectChanges projectId="demo" /></QueryClientProvider>);
  return fetch;
}
describe("project commit workflow", () => {
  it("reviews a diff and commits only selected paths with the observed state", async () => {
    const fetch = setup();
    await screen.findByLabelText("Include selected.txt");
    fireEvent.click(screen.getByRole("button", { name: "selected.txt" }));
    await screen.findByText("+reviewed change");
    fireEvent.click(screen.getByLabelText("Include selected.txt"));
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "Save reviewed change" } });
    fireEvent.change(screen.getByLabelText("Operator token"), { target: { value: "fixture-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit 1 selected file" }));
    await screen.findByText(`Local commit created: ${"b".repeat(40)}`);
    const request = fetch.mock.calls.find(call => call[1]?.method === "POST")!;
    expect(request[0]).toBe("/api/project-git/demo/commit");
    expect(JSON.parse(request[1]!.body as string)).toEqual({ message: "Save reviewed change", paths: ["selected.txt"], expectedHead: state.head, expectedFingerprint: state.fingerprint });
    expect(request[1]!.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer fixture-token" });
  });
  it("keeps stale-state failures visible and never displays commit success", async () => {
    setup(true);
    await screen.findByLabelText("Include selected.txt");
    fireEvent.click(screen.getByLabelText("Include selected.txt"));
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "Save change" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit 1 selected file" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Refresh the project status"));
    expect(screen.queryByText(/Local commit created:/)).toBeNull();
  });
});
