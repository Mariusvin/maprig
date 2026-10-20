import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlanningGraph, graphTrail, type PlanProject } from "../src/components/project/PlanningGraph.js";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate, Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@xyflow/react", () => ({ ReactFlow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, Background: () => null,
  Controls: () => null, Handle: () => null, Position: { Left: "left", Right: "right" }, useReactFlow: () => ({ fitView: () => {} }), useNodesInitialized: () => false }));
const item = (id: string, progress: number) => ({ id, title: `Task ${id}`, progress, status: "in_progress", position: { x: 0, y: 0 }, dependsOn: [] as string[] });
const project: PlanProject = { id: "example", name: "Example", rootGraphId: "root", graphs: [
  { id: "root", title: "Root", level: 1, nodes: [{ ...item("a", 44), childGraphId: "child", summary: "Preserved summary", references: [{ title: "Unsafe reference", url: "javascript:alert(1)" }] }, { ...item("b", 96), dependsOn: ["a"] }] },
  { id: "child", title: "Child", level: 2, parentNodeId: "a", nodes: [{ ...item("c", 73), childGraphId: "leaf" }] },
  { id: "leaf", title: "Leaf", level: 3, parentNodeId: "c", nodes: [] },
] };
afterEach(() => { vi.unstubAllGlobals(); navigate.mockReset(); });
function setup(node?: string, graph?: string) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/planning" ? { projects: [{ id: "example", name: "Example" }] } :
    { project, source: { readAt: "2026-10-20T10:00:00Z", path: "/project/.maproom/project.json", sha256: "a".repeat(64), mode: "linked" } } })));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PlanningGraph search={{ project: "example", graph, node }} /></QueryClientProvider>);
}
describe("planning graph navigation", () => {
  it("builds the full root-to-leaf breadcrumb", () => {
    expect(graphTrail(project, project.graphs[2]!).map(g => g.id)).toEqual(["root", "child", "leaf"]);
  });
  it("shows saved percentages and evidence, opens child graphs and disables unsafe reference URLs", async () => {
    setup("a");
    await screen.findByText("Preserved summary");
    expect(screen.getByText("in progress / 44%")).toBeTruthy();
    expect(screen.getByLabelText("Selected task progress").getAttribute("value")).toBe("44");
    expect(screen.getByText("Unsafe reference").closest("a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open L2 graph" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/project/plan", search: { project: "example", graph: "child" } });
  });
  it("navigates prerequisites without changing source progress", async () => {
    setup("b");
    await screen.findByText("in progress / 96%");
    fireEvent.click(screen.getAllByRole("button", { name: "Task a" })[0]!);
    expect(navigate).toHaveBeenCalledWith({ to: "/project/plan", search: { project: "example", graph: "root", node: "a" } });
    expect(project.graphs[0]!.nodes[1]!.progress).toBe(96);
  });
  it("shows a recovery action for a missing graph", async () => {
    setup(undefined, "missing");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Graph unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Return to root graph" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/project/plan", search: { project: "example" } });
  });
});
