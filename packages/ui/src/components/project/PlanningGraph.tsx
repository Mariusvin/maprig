import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ReactFlow, Background, Controls, Handle, Position, useReactFlow, useNodesInitialized, type NodeProps, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./planning-graph.css";

export interface PlanNode {
  id: string; title: string; summary?: string; status: string; progress: number;
  position: { x: number; y: number }; dependsOn: string[]; childGraphId?: string;
  conclusion?: string; references?: Array<{ id?: string; title?: string; url?: string }>;
}
export interface PlanGraph { id: string; title: string; level: number; parentNodeId?: string; nodes: PlanNode[] }
export interface PlanProject { id: string; name: string; summary?: string; rootGraphId: string; graphs: PlanGraph[]; updatedAt?: string }
interface PlanResponse { project: PlanProject; source: { path: string; sha256: string; readAt: string; mode: string } }
export interface PlanSearch { project?: string; graph?: string; node?: string }

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  return body as T;
}
export function usePlanningProjects() {
  return useQuery({ queryKey: ["planning-projects"], queryFn: () => readJson<{ projects: Array<{ id: string; name: string }> }>("/api/planning"), refetchInterval: 10000 });
}
export function graphTrail(project: PlanProject, graph: PlanGraph): PlanGraph[] {
  const trail = [graph];
  const seen = new Set([graph.id]);
  while (trail[0]?.parentNodeId) {
    const parent = project.graphs.find(g => g.nodes.some(n => n.id === trail[0]!.parentNodeId));
    if (!parent || seen.has(parent.id)) break;
    trail.unshift(parent);
    seen.add(parent.id);
  }
  return trail;
}
const statusLabel = (value: string) => value.replaceAll("_", " ");
type FlowNode = Node<{ item: PlanNode }, "plan">;
function PlanGraphNode({ data, selected }: NodeProps<FlowNode>) {
  const n = data.item;
  return <div className={`plan-node ${selected ? "plan-node-selected" : ""}`} data-status={n.status}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <div className="plan-node-meta"><span>{statusLabel(n.status)}</span><strong>{n.progress}%</strong></div>
    <div className="plan-node-title">{n.title}</div>
    <progress aria-label={`${n.title} progress`} max={100} value={n.progress} />
    <div className="plan-node-footer">{n.childGraphId ? "Explore next level" : "Execution task"}</div>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
}
const nodeTypes = { plan: PlanGraphNode };
function FocusSelectedTask({ id }: { id?: string }) {
  const ready = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => { if (id && ready) void fitView({ nodes: [{ id }], padding: 0.3, minZoom: 0.5, maxZoom: 1 }); }, [id, ready, fitView]);
  return null;
}
const safeUrl = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//i.test(url);

export function PlanningGraph({ search }: { search: PlanSearch }) {
  const navigate = useNavigate();
  const catalog = usePlanningProjects();
  const projectId = search.project ?? catalog.data?.projects[0]?.id;
  const result = useQuery({ queryKey: ["planning", projectId], enabled: !!projectId,
    queryFn: () => readJson<PlanResponse>(`/api/planning/${encodeURIComponent(projectId!)}`), refetchInterval: 10000 });
  const project = result.data?.project;
  const graph = project?.graphs.find(g => g.id === (search.graph ?? project.rootGraphId));
  const selected = graph?.nodes.find(n => n.id === search.node);
  const nodes = useMemo<FlowNode[]>(() => graph?.nodes.map(n => ({ id: n.id, type: "plan", position: n.position, initialWidth: 280, initialHeight: 160,
    data: { item: n }, selected: n.id === search.node, ariaLabel: `${n.title}, ${n.progress}%, ${statusLabel(n.status)}` })) ?? [], [graph, search.node]);
  const edges = useMemo(() => graph?.nodes.flatMap(n => n.dependsOn.map(d => ({ id: `${d}:${n.id}`, source: d, target: n.id,
    style: { stroke: "#6600cc", strokeWidth: 1.5 }, markerEnd: { type: "arrowclosed" as const, color: "#6600cc" } }))) ?? [], [graph]);
  const go = (next: PlanSearch) => { void navigate({ to: "/project/plan", search: next }); };
  const error = catalog.error ?? result.error;
  return <main className="planning-workspace" data-testid="planning-workspace">
    <header className="plan-header">
      <div><div className="plan-eyebrow">PROJECT / PLANNING</div><h1>{project?.name ?? "Project plans"}</h1></div>
      <Link to="/project" search={{ view: "execution" }} className="plan-link">Execution workspace</Link>
    </header>
    <div className="plan-toolbar">
      <label>Project <select aria-label="Planning project" value={projectId ?? ""} onChange={event => go({ project: event.target.value })}>
        {!projectId && <option value="">Select project</option>}
        {catalog.data?.projects.map(p => <option key={p.id} value={p.id}>{p.id === project?.id ? project.name : p.name}</option>)}
      </select></label>
      <button type="button" onClick={() => { void catalog.refetch(); void result.refetch(); }} disabled={catalog.isFetching || result.isFetching}>Refresh</button>
      <span className="plan-sync" role="status">{error ? "Source unavailable" : result.isFetching ? "Reading source..." : project ? "Linked to Maproom / read only / checks every 10s" : ""}</span>
    </div>
    {error && <div role="alert" className="plan-error">{error.message}</div>}
    {!error && (catalog.isLoading || (!!projectId && result.isLoading)) && <p>Loading project plan...</p>}
    {!error && !catalog.isLoading && !projectId && <p>No linked plans. Register a project with a .maproom/project.json source in the workspace catalog.</p>}
    {project && <>
      {project.summary && <details className="plan-brief"><summary>Project brief and current checkpoint</summary><p className="plan-summary">{project.summary}</p></details>}
      {graph ? <>
        <nav className="plan-breadcrumb" aria-label="Graph levels">{graphTrail(project, graph).map((g, index) => <span key={g.id}>
          {index > 0 && <span aria-hidden="true"> / </span>}<button type="button" aria-current={g.id === graph.id ? "page" : undefined}
            onClick={() => go({ project: project.id, graph: g.id })}>L{g.level} {g.title}</button>
        </span>)}</nav>
        <div className="plan-graph-heading"><h2>{graph.title}</h2><span>{graph.nodes.length} nodes / {edges.length} dependencies</span></div>
        <div className="plan-layout">
          <section className="plan-canvas" aria-label={`Level ${graph.level} planning graph`}>
            <ReactFlow key={`${project.id}:${graph.id}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView
              fitViewOptions={{ padding: 0.15, minZoom: 0.45, maxZoom: 1 }} minZoom={0.08} maxZoom={1.6} nodesDraggable={false} nodesConnectable={false}
              onNodeClick={(_, n) => go({ project: project.id, graph: graph.id, node: n.id })}
              onNodeDoubleClick={(_, n) => { if (n.data.item.childGraphId) go({ project: project.id, graph: n.data.item.childGraphId }); }}>
              <Background color="#b8b6ae" gap={24} /><Controls showInteractive={false} /><FocusSelectedTask id={selected?.id} />
            </ReactFlow>
          </section>
          <aside className="plan-inspector" aria-label="Task inspector">
            {selected ? <>
              <div className="plan-eyebrow">{statusLabel(selected.status)} / {selected.progress}%</div>
              <h2>{selected.title}</h2><progress aria-label="Selected task progress" max={100} value={selected.progress} />
              <p>{selected.summary || "No summary recorded."}</p>
              {selected.childGraphId && <button className="plan-primary" type="button" onClick={() => go({ project: project.id, graph: selected.childGraphId })}>Open L{graph.level + 1} graph</button>}
              {selected.conclusion && <><h3>Completion evidence</h3><p>{selected.conclusion}</p></>}
              <h3>Prerequisites</h3>
              {selected.dependsOn.length === 0 ? <p>None at this level</p> : <ul>{selected.dependsOn.map(id => {
                const dependency = graph.nodes.find(n => n.id === id)!;
                return <li key={id}><button className="plan-link" onClick={() => go({ project: project.id, graph: graph.id, node: id })}>{dependency.title}</button> - {dependency.progress}% / {statusLabel(dependency.status)}</li>;
              })}</ul>}
              {!!selected.references?.length && <><h3>References</h3><ul>{selected.references.map((r, index) => <li key={r?.id ?? index}>{safeUrl(r?.url) ? <a href={r.url} target="_blank" rel="noreferrer">{r.title ?? r.url}</a> : r?.title ?? "Reference without a web link"}</li>)}</ul></>}
              <div className="plan-id">{selected.id}</div>
            </> : <><h2>Inspect a task</h2><p>Select a node to read its status, prerequisites and evidence. Open its next level to explore the work beneath it.</p><p>Arrows run from prerequisite to dependent task. Percentages retain the values recorded in Maproom.</p></>}
          </aside>
        </div>
        <details className="plan-task-index"><summary>Task index - {graph.nodes.length} nodes</summary><ul>{graph.nodes.map(n => <li key={n.id}>
          <button className="plan-link" onClick={() => go({ project: project.id, graph: graph.id, node: n.id })}>{n.title}</button>
          <span>{n.progress}% / {statusLabel(n.status)}</span>
          {n.childGraphId && <button onClick={() => go({ project: project.id, graph: n.childGraphId })}>Open L{graph.level + 1}</button>}
        </li>)}</ul></details>
      </> : <div role="alert" className="plan-error">Graph unavailable. <button onClick={() => go({ project: project.id })}>Return to root graph</button></div>}
      <footer className="plan-source">{project.graphs.length} graphs / {project.graphs.reduce((sum, g) => sum + g.nodes.length, 0)} nodes / source updated {project.updatedAt ?? "unknown"}<br />
        Read {result.data?.source.readAt} / SHA256 {result.data?.source.sha256.slice(0, 16)}<details><summary>Source location</summary>{result.data?.source.path}</details>
      </footer>
    </>}
  </main>;
}
