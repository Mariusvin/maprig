import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readMissionControlBearerToken } from "../mission-control/missionControlAuth.js";
import { usePlanningProjects } from "./PlanningGraph.js";
import "./planning-graph.css";

interface GitStatus {
  repository: string; head: string | null; branch: string;
  identity: { name: string | null; email: string | null };
  changes: Array<{ path: string; status: string }>; fingerprint: string;
}
async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? result.error ?? `HTTP ${response.status}`);
  return result;
}
export function ProjectChanges({ projectId }: { projectId?: string }) {
  const catalog = usePlanningProjects();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = projectId ?? catalog.data?.projects[0]?.id;
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [token, setToken] = useState(() => readMissionControlBearerToken() ?? "");
  const [created, setCreated] = useState<string | null>(null);
  const status = useQuery({ queryKey: ["project-git", id], enabled: !!id,
    queryFn: () => json<GitStatus>(`/api/project-git/${encodeURIComponent(id!)}`) });
  const diff = useQuery({ queryKey: ["project-git-diff", id, preview, status.data?.fingerprint], enabled: !!id && !!preview,
    queryFn: () => json<{ path: string; diff: string }>(`/api/project-git/${encodeURIComponent(id!)}/diff?path=${encodeURIComponent(preview!)}`) });
  const available = status.data?.changes.map(change => change.path) ?? [];
  const paths = selected.filter(path => available.includes(path));
  const commit = useMutation({ mutationFn: async () => {
    if (!status.data) throw new Error("Load the current repository state first");
    return json<{ commit: string; remainingChanges: number }>(`/api/project-git/${encodeURIComponent(id!)}/commit`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}) },
      body: JSON.stringify({ message, paths, expectedHead: status.data.head, expectedFingerprint: status.data.fingerprint }),
    });
  }, onSuccess: result => {
    setCreated(result.commit); setSelected([]); setMessage(""); setPreview(null);
    void queryClient.invalidateQueries({ queryKey: ["project-git", id] });
  } });
  const error = status.error ?? catalog.error ?? commit.error;
  return <main className="planning-workspace" data-testid="project-changes">
    <header className="plan-header"><div><div className="plan-eyebrow">PROJECT / CHANGES</div><h1>Local commits</h1></div>
      <Link className="plan-link" to="/project/plan" search={{ project: id }}>Back to plan</Link></header>
    <div className="plan-toolbar"><label>Project <select aria-label="Commit project" value={id ?? ""} onChange={event => {
      setSelected([]); setPreview(null); setCreated(null); commit.reset();
      void navigate({ to: "/project/changes", search: { project: event.target.value } });
    }}>{catalog.data?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <button onClick={() => { setCreated(null); commit.reset(); void status.refetch(); }} disabled={status.isFetching || commit.isPending}>Refresh changes</button>
      {status.data && <span>{status.data.branch || "Detached HEAD"} / {status.data.head?.slice(0, 10) ?? "First commit"}</span>}</div>
    {error && <p className="plan-error" role="alert">{error.message}</p>}
    {created && <p className="changes-success" role="status">Local commit created: {created}</p>}
    {status.isLoading && <p>Reading repository changes...</p>}
    {status.data && <>
      <p className="changes-intro">Review the diff, select files and create a commit in this project's repository.</p>
      <div className="changes-layout"><section aria-label="Changed files" className="changes-files">
        <h2>Changed files / {status.data.changes.length}</h2>
        {status.data.changes.length === 0 ? <p>Working tree is clean.</p> : <>
          <button onClick={() => setSelected(paths.length === available.length ? [] : available)}>{paths.length === available.length ? "Clear selection" : "Select all files"}</button>
          <ul>{status.data.changes.map(change => <li key={change.path}>
            <input aria-label={`Include ${change.path}`} type="checkbox" checked={paths.includes(change.path)} onChange={event => setSelected(event.target.checked ? [...paths, change.path] : paths.filter(path => path !== change.path))} />
            <span className="changes-status">{change.status}</span><button className="plan-link" onClick={() => setPreview(change.path)}>{change.path}</button>
          </li>)}</ul></>}
      </section><section aria-label="Selected file diff" className="changes-diff"><h2>{preview ?? "File diff"}</h2>
        {diff.isLoading ? <p>Loading diff...</p> : diff.error ? <p role="alert" className="plan-error">{diff.error.message}</p> : preview ? <pre tabIndex={0}>{diff.data?.diff || "No textual diff available."}</pre> : <p>Select a filename to inspect its changes.</p>}
      </section></div>
      <form className="changes-form" onSubmit={event => { event.preventDefault(); setCreated(null); commit.mutate(); }}>
        <div><label htmlFor="commit-message">Commit message</label><textarea id="commit-message" rows={3} value={message} onChange={event => setMessage(event.target.value)} required placeholder="Describe this change" /></div>
        <div><label htmlFor="commit-token">Operator token</label><input id="commit-token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} />
          <p className="plan-sync">Used for this action. Enter the existing local operator token if required.</p></div>
        <div className="changes-submit"><span>Author: {status.data.identity.name ?? "Not configured"}{status.data.identity.email ? ` <${status.data.identity.email}>` : ""}</span>
          <button type="submit" className="plan-primary" disabled={commit.isPending || !paths.length || !message.trim() || !status.data.identity.name || !status.data.identity.email}>{commit.isPending ? "Creating commit..." : `Commit ${paths.length} selected ${paths.length === 1 ? "file" : "files"}`}</button></div>
      </form>
      <details className="plan-source"><summary>Repository location</summary>{status.data.repository}</details>
    </>}
  </main>;
}
