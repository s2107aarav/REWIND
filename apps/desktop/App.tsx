import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  Download,
  File,
  FileCheck2,
  FlaskConical,
  Folder,
  FolderOpen,
  GitBranch,
  HardDrive,
  History,
  LayoutDashboard,
  LoaderCircle,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  ShieldQuestion,
  Terminal,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import type {
  AppState,
  Explanation,
  FaultKind,
  FileRow,
  Progress,
  RecoveryState,
  Request,
  Scope,
} from "./api";
import "./style.css";
import { RecoverySuggestion } from "./RecoverySuggestion";
import { Laboratory, type RepairPlan } from "./Laboratory";
import type { RecoveryRecommendation } from "./api";
import {
  statusInfo,
  copyLabels,
  stateKeys,
  bytes,
  date,
  short,
  Status,
  Empty,
  SnapshotSelect,
  saveJSON,
} from "./ui";

type Screen =
  | "overview"
  | "timeline"
  | "frontier"
  | "lab"
  | "restore"
  | "evidence"
  | "settings";
type Diff = { added: string[]; removed: string[]; changed: string[] };
type Verification = {
  valid: boolean;
  files: number;
  bytes: number;
  errors: string[];
};
const nav = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "timeline", label: "Snapshot timeline", icon: History },
  { id: "frontier", label: "Recovery frontier", icon: GitBranch },
  { id: "lab", label: "Disaster laboratory", icon: FlaskConical },
  { id: "restore", label: "Verified restore", icon: ArrowDownToLine },
  { id: "evidence", label: "Evidence", icon: FileCheck2 },
  { id: "settings", label: "Settings & help", icon: Settings2 },
] as const;
export default function App() {
  const [screen, setScreen] = useState<Screen>("overview");
  const [scope, setScope] = useState<Scope>("original");
  const [data, setData] = useState<AppState>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState<Progress>();
  const [snapshotId, setSnapshotId] = useState("");
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<RecoveryState | "">("");
  const [explanation, setExplanation] = useState<Explanation>();
  const [explaining, setExplaining] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [setup, setSetup] = useState({ source: "", a: "", b: "" });
  const [connecting, setConnecting] = useState(false);
  const [captureLabel, setCaptureLabel] = useState("");
  const [diff, setDiff] = useState<Diff>();
  const [seed, setSeed] = useState(2409);
  const [faultKind, setFaultKind] = useState<FaultKind>("corrupt");
  const [faultBackend, setFaultBackend] = useState(0);
  const [faultHash, setFaultHash] = useState("");
  const [restoreParent, setRestoreParent] = useState("");
  const [restoreName, setRestoreName] = useState(
    `REWIND-recovery-${new Date().toLocaleDateString("en-CA")}`,
  );
  const [selective, setSelective] = useState(false);
  const [verification, setVerification] = useState<
    Record<string, Verification>
  >({});
  const [budget, setBudget] = useState("1048576");
  const [plan, setPlan] = useState<RepairPlan>();
  const [recommendation, setRecommendation] =
    useState<RecoveryRecommendation>();
  const loadVersion = useRef(0);
  const explanationVersion = useRef(0);
  const activeJob = useRef(0);
  const cancellationRequested = useRef(false);
  const bridge = window.rewind;
  const refresh = useCallback(
    async (targetScope: Scope = scope, reset = false) => {
      if (!bridge) {
        setError(
          "The desktop bridge is unavailable. Launch REWIND with npm run dev or npm start.",
        );
        setLoading(false);
        return;
      }
      const version = ++loadVersion.current;
      try {
        const next = await bridge.request({
          action: "state",
          scope: targetScope,
          offset: reset ? 0 : offset,
          search: reset ? "" : search,
          snapshotId: reset ? undefined : snapshotId || undefined,
          filter: reset ? undefined : filter || undefined,
        });
        if (version !== loadVersion.current) return;
        setData(next);
        setLoading(false);
        setSnapshotId((current) =>
          next.snapshots.some((snapshot) => snapshot.id === current)
            ? current
            : (next.snapshots[0]?.id ?? ""),
        );
      } catch (e) {
        if (version === loadVersion.current) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    },
    [bridge, scope, offset, search, snapshotId, filter],
  );
  useEffect(() => {
    if (busy) return;
    const timer = setTimeout(() => {
      void refresh();
    }, 120);
    return () => {
      clearTimeout(timer);
      loadVersion.current += 1;
    };
  }, [refresh, busy]);
  useEffect(() => bridge?.onProgress((p) => setProgress(p)), [bridge]);
  const run = async (
    label: string,
    request: Request,
    options?: { scope?: Scope; reset?: boolean; success?: string },
  ) => {
    if (busy || !bridge) return;
    setRecommendation(undefined);
    activeJob.current += 1;
    cancellationRequested.current = false;
    explanationVersion.current += 1;
    setExplanation(undefined);
    setExplaining(false);
    setPlan(undefined);
    setBusy(label);
    setError("");
    setNotice("");
    setProgress(undefined);
    try {
      await bridge.request<unknown>(request);
      if (request.action === "setup" || request.action === "demo") {
        setConnecting(false);
        setScreen("overview");
        setLoading(true);
      }
      const target = options?.scope ?? scope;
      if (target !== scope) setScope(target);
      if (options?.reset) {
        setOffset(0);
        setSearch("");
        setFilter("");
        setSnapshotId("");
        setPaths([]);
        setExplanation(undefined);
        setDiff(undefined);
      }
      await refresh(target, options?.reset);
      setNotice(
        cancellationRequested.current
          ? "The operation completed before cancellation took effect. Inspect the refreshed workspace for the committed result."
          : (options?.success ?? `${label} completed.`),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/cancel|abort/i.test(message)) {
        setNotice(
          "Operation cancelled. No completed result was reported; the refreshed workspace shows any persisted state.",
        );
        await refresh();
      } else setError(message);
    } finally {
      activeJob.current += 1;
      setBusy("");
      setProgress(undefined);
      cancellationRequested.current = false;
    }
  };
  const query = async <T,>(
    label: string,
    request: Request,
    apply: (v: T) => void,
  ) => {
    if (busy || !bridge) return;
    setRecommendation(undefined);
    activeJob.current += 1;
    cancellationRequested.current = false;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const result = await bridge.request<T>(request);
      if (!cancellationRequested.current) apply(result);
      if (
        request.action === "plan-recovery" ||
        request.action === "repair-plan"
      )
        await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      activeJob.current += 1;
      setBusy("");
      cancellationRequested.current = false;
    }
  };
  const clearExplanation = () => {
    explanationVersion.current += 1;
    setExplanation(undefined);
    setExplaining(false);
  };
  const changeSnapshot = (id: string) => {
    if (id !== snapshotId) setLoading(true);
    setSnapshotId(id);
    setOffset(0);
    setPaths([]);
    clearExplanation();
    setDiff(undefined);
  };
  const changeScope = (next: Scope) => {
    if (next === scope) return;
    setRecommendation(undefined);
    setLoading(true);
    setScope(next);
    setSnapshotId("");
    setOffset(0);
    setPaths([]);
    clearExplanation();
    setDiff(undefined);
    setFilter("");
    setSearch("");
    setPlan(undefined);
  };
  const inspect = async (row: Pick<FileRow, "snapshotId" | "path">) => {
    if (!bridge || busy) return;
    const version = ++explanationVersion.current;
    setExplaining(true);
    setError("");
    try {
      const next = await bridge.request<Explanation>({
        action: "explain",
        scope,
        snapshotId: row.snapshotId,
        path: row.path,
      });
      if (version === explanationVersion.current) setExplanation(next);
    } catch (e) {
      if (version === explanationVersion.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (version === explanationVersion.current) setExplaining(false);
    }
  };
  const inspectVersion = (id: string, path: string) => {
    changeSnapshot(id);
    void inspect({ snapshotId: id, path });
  };
  const cancel = async () => {
    const job = activeJob.current;
    cancellationRequested.current = true;
    try {
      await bridge.cancel();
      if (job === activeJob.current && busy)
        setNotice(
          "Cancellation requested. Waiting for a safe checkpoint; completed work may already be committed.",
        );
    } catch (e) {
      if (job === activeJob.current)
        setError(e instanceof Error ? e.message : String(e));
    }
  };
  const pick = async (apply: (path: string) => void) => {
    try {
      const folder = await bridge.pickFolder();
      if (folder) apply(folder);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const snapshots = data?.snapshots ?? [];
  const active = snapshots.find((s) => s.id === snapshotId) ?? snapshots[0];
  const activeId = active?.id ?? "";
  const totalVersions = snapshots.reduce(
    (n, s) => n + Object.values(s.counts ?? {}).reduce((a, b) => a + b, 0),
    0,
  );
  const verifiedVersions = snapshots.reduce(
    (n, s) => n + (s.counts?.VERIFIED_RECOVERABLE ?? 0),
    0,
  );
  const ratio = totalVersions ? verifiedVersions / totalVersions : 0;
  const latestReceipt = data?.receipts?.[0];
  const title = nav.find((n) => n.id === screen)?.label ?? "Overview";
  const navigate = (s: Screen) => {
    if (isBusy && connecting) return;
    setConnecting(false);
    setScreen(s);
    setError("");
    setNotice("");
  };
  const isBusy = !!busy;
  const selectedSet = new Set(paths);
  const togglePath = (path: string) =>
    setPaths((v) =>
      v.includes(path) ? v.filter((p) => p !== path) : [...v, path],
    );

  const fileTable = (selection = false) => (
    <div className="file-browser">
      <div className="table-tools">
        <div className="search">
          <Search size={15} />
          <input
            aria-label="Search files"
            placeholder="Find a file or folder…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        {screen === "frontier" && (
          <select
            aria-label="Recovery state filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as RecoveryState | "");
              setOffset(0);
            }}
          >
            <option value="">All recovery states</option>
            {stateKeys.map((k) => (
              <option value={k} key={k}>
                {statusInfo[k].label}
              </option>
            ))}
          </select>
        )}
        <span className="mono subtle">
          {data?.totalFiles.toLocaleString() ?? 0} entries
        </span>
      </div>
      {screen === "frontier" ? (
        <>
          <p className="matrix-caption">
            Rows are paths in the selected snapshot. Columns show the six newest
            snapshots; a dash means this path has no version recorded in that
            snapshot.
          </p>
          <div className="table-scroll">
            <table className="frontier-matrix">
              <thead>
                <tr>
                  <th>File / directory</th>
                  {snapshots.slice(0, 6).map((snapshot) => (
                    <th
                      key={snapshot.id}
                      className={
                        activeId === snapshot.id ? "active-column" : ""
                      }
                    >
                      <button
                        disabled={isBusy}
                        onClick={() => changeSnapshot(snapshot.id)}
                        title={`Select ${snapshot.label || snapshot.id} · ${date(snapshot.createdAt)}`}
                      >
                        <span>{snapshot.label || short(snapshot.id)}</span>
                        <code>{short(snapshot.id)}</code>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data?.files.map((file) => (
                  <tr key={file.path}>
                    <td>
                      <button
                        className="file-name"
                        onClick={() => void inspect(file)}
                      >
                        {file.type === "directory" ? (
                          <Folder size={15} />
                        ) : (
                          <File size={15} />
                        )}
                        <span>{file.path}</span>
                      </button>
                    </td>
                    {snapshots.slice(0, 6).map((snapshot) => {
                      const version = file.versions?.find(
                        (v) => v.snapshotId === snapshot.id,
                      );
                      return (
                        <td
                          key={snapshot.id}
                          className={
                            activeId === snapshot.id ? "active-column" : ""
                          }
                        >
                          {version ? (
                            <button
                              className={`matrix-cell ${statusInfo[version.state].color} ${explanation?.path === file.path && explanation.snapshotId === snapshot.id ? "inspected" : ""}`}
                              disabled={isBusy}
                              title={`${file.path} · ${snapshot.label || short(snapshot.id)} · ${statusInfo[version.state].label}${version.hash ? ` · SHA-256 ${version.hash}` : ""}`}
                              aria-label={`Explain ${file.path} in ${snapshot.label || short(snapshot.id)}: ${statusInfo[version.state].label}`}
                              onClick={() =>
                                inspectVersion(snapshot.id, file.path)
                              }
                            >
                              <i />
                              <span>{statusInfo[version.state].short}</span>
                            </button>
                          ) : (
                            <span
                              className="matrix-absent"
                              title="No recorded version of this path in this snapshot"
                              aria-label="No recorded version"
                            >
                              —
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="table-scroll">
          <table className="files-table">
            <thead>
              <tr>
                {selection && <th className="check-col">Use</th>}
                <th>File / directory</th>
                <th>Size</th>
                <th>Chunks</th>
                <th>Recovery state</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.files.map((file) => (
                <tr
                  key={`${file.snapshotId}:${file.path}`}
                  className={
                    explanation?.path === file.path ? "selected-row" : ""
                  }
                  onClick={() => void inspect(file)}
                >
                  {selection && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${file.path}`}
                        checked={selectedSet.has(file.path)}
                        disabled={
                          file.state !== "VERIFIED_RECOVERABLE" ||
                          file.type !== "file" ||
                          isBusy
                        }
                        onChange={() => togglePath(file.path)}
                      />
                    </td>
                  )}
                  <td>
                    <button
                      className="file-name"
                      onClick={(e) => {
                        e.stopPropagation();
                        void inspect(file);
                      }}
                    >
                      {file.type === "directory" ? (
                        <Folder size={15} />
                      ) : (
                        <File size={15} />
                      )}
                      <span>{file.path}</span>
                    </button>
                  </td>
                  <td className="mono">
                    {file.type === "directory" ? "—" : bytes(file.size)}
                  </td>
                  <td className="mono subtle">{file.chunks}</td>
                  <td>
                    <Status state={file.state} compact />
                  </td>
                  <td>
                    <ChevronRight size={14} className="subtle" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!data?.files.length && (
        <Empty icon={Search} title="No matching entries">
          Try another snapshot or clear the search and state filter.
        </Empty>
      )}
      <div className="pagination">
        <span>
          {data?.totalFiles
            ? `${offset + 1}–${Math.min(offset + (data.files.length || 0), data.totalFiles)} of ${data.totalFiles.toLocaleString()}`
            : "0 entries"}{" "}
          · 50 per page
        </span>
        <div>
          <button
            aria-label="Previous page"
            className="icon-button"
            disabled={offset === 0 || isBusy}
            onClick={() => setOffset((v) => Math.max(0, v - 50))}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            aria-label="Next page"
            className="icon-button"
            disabled={offset + 50 >= (data?.totalFiles ?? 0) || isBusy}
            onClick={() => setOffset((v) => v + 50)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
  const inspector = () => (
    <aside className="inspector">
      <div className="panel-heading">
        <span className="eyebrow">Dependency inspector</span>
        {explanation && (
          <button
            className="icon-button"
            aria-label="Close explanation"
            onClick={clearExplanation}
          >
            <X size={15} />
          </button>
        )}
      </div>
      {explaining ? (
        <div className="empty">
          <LoaderCircle size={24} className="spin" />
          <p>Reading dependency evidence…</p>
        </div>
      ) : explanation ? (
        <>
          <h3 className="break">{explanation.path}</h3>
          <Status state={explanation.state} />
          <p className="muted small">{explanation.reason}</p>
          <dl className="detail-list">
            <dt>Snapshot</dt>
            <dd className="mono">{short(explanation.snapshotId)}</dd>
            <dt>Whole-file SHA-256</dt>
            <dd className="mono hash">
              {explanation.hash ?? "Directory entry"}
            </dd>
          </dl>
          <div className="chunk-list">
            {explanation.chunks.map((chunk, index) => (
              <div className="chunk" key={`${chunk.hash}:${index}`}>
                <div className="chunk-top">
                  <span className="chunk-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <code title={chunk.hash}>{short(chunk.hash)}</code>
                  <span className="mono subtle">{bytes(chunk.size)}</span>
                </div>
                <div className="byte-range">
                  Bytes {chunk.start.toLocaleString()}–
                  {Math.max(chunk.start, chunk.end - 1).toLocaleString()} ·{" "}
                  {chunk.affectedVersions} dependent versions
                </div>
                <div className="copy-states">
                  {chunk.copies.map((copy) => (
                    <div
                      className={`copy ${copy.state === "VERIFIED_OK" ? "good" : copy.state === "NOT_YET_VERIFIED" ? "neutral" : copy.state === "BACKEND_UNAVAILABLE" || copy.state === "IO_ERROR" ? "warn" : "bad"}`}
                      key={copy.backend}
                    >
                      <HardDrive size={13} />
                      <span>{copy.backend}</span>
                      <strong>{copyLabels[copy.state]}</strong>
                      {copy.detail && <small>{copy.detail}</small>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {!!explanation.alternatives.length && (
            <section className="alternatives">
              <h4>Other versions of this path</h4>
              {explanation.alternatives.slice(0, 12).map((a) => (
                <button
                  key={a.snapshotId}
                  disabled={isBusy}
                  onClick={() => inspectVersion(a.snapshotId, explanation.path)}
                >
                  <code>{short(a.snapshotId)}</code>
                  <Status state={a.state} compact />
                  <ArrowUpRight size={13} />
                </button>
              ))}
            </section>
          )}
        </>
      ) : (
        <Empty icon={GitBranch} title="Follow the evidence">
          Choose a file version to inspect its chunk dependencies, physical
          copies, and recovery alternatives.
        </Empty>
      )}
    </aside>
  );
  const receipts = () => (
    <div className="receipt-list">
      {data?.receipts.length ? (
        data.receipts.map((receipt) => (
          <article className="receipt" key={receipt.id}>
            <div className="receipt-icon">
              <FileCheck2 size={21} />
            </div>
            <div className="receipt-body">
              <div className="receipt-title">
                <h3>{receipt.status}</h3>
                <span className="mono subtle">{date(receipt.createdAt)}</span>
              </div>
              <code className="break">{receipt.destination}</code>
              <p className="small muted">
                {receipt.files} files · {bytes(receipt.bytes)} · snapshot{" "}
                {short(receipt.snapshotId)}
              </p>
              {verification[receipt.id] && (
                <div
                  className={`verification ${verification[receipt.id].valid ? "good" : "bad"}`}
                >
                  <CheckCheck size={15} />
                  {verification[receipt.id].valid
                    ? `Independently verified ${verification[receipt.id].files} files / ${bytes(verification[receipt.id].bytes)}`
                    : `Verification failed: ${verification[receipt.id].errors.join("; ")}`}
                </div>
              )}
            </div>
            <div className="receipt-actions">
              <button
                className="button small-button"
                disabled={isBusy}
                onClick={() =>
                  void query<Verification>(
                    "Verifying restored output",
                    { action: "verify", id: receipt.id },
                    (v) =>
                      setVerification((old) => ({ ...old, [receipt.id]: v })),
                  )
                }
              >
                <ShieldCheck size={14} />
                Verify output
              </button>
              <button
                className="text-button"
                disabled={isBusy}
                onClick={() =>
                  void bridge
                    .openOutput(receipt.id)
                    .catch((e) => setError(String(e)))
                }
              >
                <FolderOpen size={14} />
                Open folder
              </button>
            </div>
          </article>
        ))
      ) : (
        <Empty icon={FileCheck2} title="No recovery receipts yet">
          A completed restore writes a machine-readable receipt after publishing
          and verifying its files.
        </Empty>
      )}
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
          aria-label="REWIND home"
        >
          <span className="brand-mark">
            <RotateCcw size={22} strokeWidth={2.6} />
          </span>
          <span>
            REWIND<span className="brand-period">.</span>
          </span>
        </a>
        <div className="sidebar-caption">RECOVERY, WITH EVIDENCE.</div>
        <nav aria-label="Main navigation">
          {nav.map((item, i) => (
            <button
              key={item.id}
              aria-label={item.label}
              title={item.label}
              className={`nav-item ${screen === item.id ? "active" : ""}`}
              disabled={!data?.ready || (isBusy && connecting)}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={17} strokeWidth={1.65} />
              <span>{item.label}</span>
              <span className="nav-index">0{i + 1}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-indicator">
            <span />
            LOCAL FIRST
          </div>
          <p>
            Your files stay here.
            <br />
            No accounts. No telemetry.
          </p>
          <div className="version">
            REWIND / 1.0 <span>DESKTOP</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span className="breadcrumb-root">
              <Database size={14} />
              Workspace
            </span>
            <span className="slash">/</span>
            <strong>
              {data?.repository
                ? `Repository ${short(data.repository.id)}`
                : "Getting started"}
            </strong>
          </div>
          <div className="topbar-actions">
            {data?.ready && !connecting && (
              <>
                <div className="scope-switch" aria-label="Repository scope">
                  <button
                    className={scope === "original" ? "active" : ""}
                    disabled={isBusy}
                    onClick={() => changeScope("original")}
                  >
                    Original
                  </button>
                  <button
                    className={scope === "lab" ? "active" : ""}
                    disabled={isBusy || !data.lab}
                    title={
                      !data.lab ? "Create a laboratory copy first" : undefined
                    }
                    onClick={() => changeScope("lab")}
                  >
                    <FlaskConical size={12} />
                    Lab
                  </button>
                </div>
                <button
                  className="button small-button"
                  disabled={isBusy}
                  onClick={() =>
                    void run("Deep verification", {
                      action: "scan",
                      scope,
                      deep: true,
                    })
                  }
                >
                  <ShieldCheck size={14} />
                  Deep scan
                </button>
              </>
            )}
            <div className="offline-badge">
              <i />
              Offline capable
            </div>
          </div>
        </header>
        <main>
          {error && (
            <div className="notice error" role="alert">
              <TriangleAlert size={17} />
              <div>
                <strong>Operation needs attention</strong>
                <p>{error}</p>
              </div>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {notice && (
            <div className="notice success" role="status">
              <Check size={16} />
              <span>{notice}</span>
              <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {isBusy && (
            <div className="operation-progress" role="status">
              <LoaderCircle size={17} className="spin" />
              <div>
                <strong>{busy}</strong>
                <span>
                  {progress?.phase}
                  {progress?.detail ? ` · ${progress.detail}` : ""}
                  {progress?.total
                    ? ` · ${progress.completed}/${progress.total}`
                    : ""}
                </span>
              </div>
              {progress?.total && (
                <progress value={progress.completed} max={progress.total} />
              )}
              <button className="text-button" onClick={() => void cancel()}>
                Cancel
              </button>
            </div>
          )}
          {loading ? (
            <div className="loading-page">
              <LoaderCircle size={25} className="spin" />
              <p>Opening local workspace…</p>
            </div>
          ) : !data?.ready || connecting ? (
            <section className="setup-page">
              {connecting && data?.ready && (
                <>
                  <button
                    className="text-button"
                    disabled={isBusy}
                    onClick={() => {
                      setConnecting(false);
                      setError("");
                      setNotice("");
                    }}
                  >
                    <ChevronLeft size={14} />
                    Return to current workspace
                  </button>
                  <div className="notice caution">
                    <FolderOpen size={17} />
                    <p>
                      Your current workspace stays connected until a new setup
                      or demo succeeds. Existing backups are preserved.
                    </p>
                  </div>
                </>
              )}
              <div className="eyebrow">
                YOUR FILES. YOUR HISTORY. YOUR PROOF.
              </div>
              <h1>
                Know what
                <br />
                survived<span className="accent">.</span>
              </h1>
              <p className="setup-intro">
                Incremental backups, visible dependencies, and verified
                recovery. Build a history you can inspect.
              </p>
              <div className="setup-demo">
                <div className="demo-illustration">
                  <Database size={25} />
                  <span />
                  <GitBranch size={29} />
                  <span />
                  <ShieldCheck size={26} />
                </div>
                <div>
                  <span className="eyebrow">START WITH REAL DATA</span>
                  <h2>Take REWIND for a test run.</h2>
                  <p>
                    A disposable seeded workspace. Three real snapshots, two
                    physical storage copies, and a safe disaster laboratory.
                  </p>
                </div>
                <button
                  className="button primary"
                  disabled={isBusy || !bridge}
                  onClick={() =>
                    void run(
                      "Creating demo workspace",
                      { action: "demo" },
                      {
                        scope: "original",
                        reset: true,
                        success:
                          "Demo workspace created with real snapshots. Open the laboratory to test recovery.",
                      },
                    )
                  }
                >
                  Create demo workspace
                  <ArrowRight size={16} />
                </button>
              </div>
              <div className="setup-custom">
                <div>
                  <span className="eyebrow">OR BRING YOUR OWN FOLDER</span>
                  <h2>Connect a local workspace</h2>
                  <p className="muted small">
                    Sources are read only. Backups must be outside the source
                    and separate from each other.
                  </p>
                </div>
                <div className="setup-paths">
                  {(
                    [
                      {
                        key: "source",
                        label: "Source folder",
                        detail: "The files you want to protect",
                      },
                      {
                        key: "a",
                        label: "Storage A",
                        detail: "First backup directory",
                      },
                      {
                        key: "b",
                        label: "Storage B",
                        detail: "Second backup directory",
                      },
                    ] as const
                  ).map((field) => (
                    <label key={field.key}>
                      <span>
                        {field.label}
                        <small>{field.detail}</small>
                      </span>
                      <button
                        className="path-picker"
                        disabled={isBusy || !bridge}
                        onClick={() =>
                          void pick((path) =>
                            setSetup((v) => ({ ...v, [field.key]: path })),
                          )
                        }
                      >
                        <FolderOpen size={16} />
                        <span>{setup[field.key] || "Choose folder"}</span>
                        <ChevronRight size={14} />
                      </button>
                    </label>
                  ))}
                </div>
                <div className="setup-footer">
                  <p>
                    <TriangleAlert size={15} />
                    Two directories on one disk do not protect against disk
                    failure.
                  </p>
                  <button
                    className="button"
                    disabled={isBusy || !setup.source || !setup.a || !setup.b}
                    onClick={() =>
                      void run(
                        "Connecting repository",
                        {
                          action: "setup",
                          source: setup.source,
                          roots: [setup.a, setup.b],
                        },
                        { scope: "original", reset: true },
                      )
                    }
                  >
                    Create repository
                    <ArrowRight size={15} />
                  </button>
                </div>
              </div>
              <p className="footnote">
                Live folder scans are not atomic filesystem snapshots.
                Unsupported entries are reported. No encryption, cloud services,
                or background sync.
              </p>
            </section>
          ) : (
            <>
              {scope === "lab" && (
                <div className="lab-banner">
                  <FlaskConical size={17} />
                  <strong>Simulation only</strong>
                  <span>
                    Original repositories untouched. You are inspecting a
                    physically isolated copy.
                  </span>
                  <code>{data.lab?.id ? short(data.lab.id) : ""}</code>
                </div>
              )}
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {scope === "lab"
                      ? "ISOLATED LABORATORY"
                      : "LOCAL RECOVERY CONSOLE"}{" "}
                    /{" "}
                    {String(nav.findIndex((n) => n.id === screen) + 1).padStart(
                      2,
                      "0",
                    )}
                  </div>
                  <h1>
                    {screen === "overview" ? (
                      <>
                        Your history.
                        <br className="mobile-break" />{" "}
                        <span className="muted-heading">Made recoverable.</span>
                      </>
                    ) : (
                      title
                    )}
                  </h1>
                  <p>
                    {
                      {
                        overview:
                          "Know what survived. Know why. Recover with evidence.",
                        timeline:
                          "Immutable captures. Real changes. A history built one chunk at a time.",
                        frontier:
                          "Every file version, every dependency, and the evidence behind its status.",
                        lab: "Break a copy safely. Follow the impact through your real backup history.",
                        restore:
                          "Reconstruct into a fresh destination. Verify every byte before success.",
                        evidence:
                          "Checks you can inspect. Results you can reproduce.",
                        settings:
                          "Understand the boundaries of your backup and recovery model.",
                      }[screen]
                    }
                  </p>
                </div>
                {screen === "overview" && (
                  <button
                    className="button primary"
                    disabled={isBusy || scope === "lab"}
                    title={
                      scope === "lab"
                        ? "Capture is only available on the original repository"
                        : undefined
                    }
                    onClick={() =>
                      void run(
                        "Capturing snapshot",
                        { action: "capture", label: captureLabel || undefined },
                        { reset: true },
                      )
                    }
                  >
                    <Plus size={16} />
                    Capture snapshot
                  </button>
                )}
              </div>
              {!!data.invalidMetadata.length && (
                <div className="notice error">
                  <TriangleAlert size={16} />
                  <div>
                    <strong>Storage metadata could not be fully trusted</strong>
                    <p>{data.invalidMetadata.join(" · ")}</p>
                  </div>
                </div>
              )}
              {screen === "overview" && (
                <>
                  <section className="metrics" aria-label="Storage accounting">
                    <div className="metric">
                      <span>Logical history</span>
                      <strong>{bytes(data.stats.logicalBytes)}</strong>
                      <small>All captured file bytes</small>
                    </div>
                    <div className="metric">
                      <span>Unique chunk data</span>
                      <strong>{bytes(data.stats.uniqueBytes)}</strong>
                      <small>
                        {data.stats.chunks.toLocaleString()} content-addressed
                        objects
                      </small>
                    </div>
                    <div className="metric">
                      <span>Deduplication savings</span>
                      <strong>
                        {(data.stats.dedupSavings * 100).toLocaleString(
                          undefined,
                          { maximumFractionDigits: 1 },
                        )}
                        <em>%</em>
                      </strong>
                      <small>Against naive full-copy history</small>
                    </div>
                    <div className="metric">
                      <span>Physical storage</span>
                      <strong>{bytes(data.stats.physicalBytes)}</strong>
                      <small>
                        Across both copies · metadata{" "}
                        {bytes(data.stats.metadataBytes)}
                      </small>
                    </div>
                  </section>
                  <div className="overview-grid">
                    <section className="panel recovery-summary">
                      <div className="section-title">
                        <div>
                          <span className="eyebrow">RECOVERY FRONTIER</span>
                          <h2>Prove it before you need it.</h2>
                        </div>
                        <button
                          className="icon-button"
                          aria-label="Open recovery frontier"
                          onClick={() => navigate("frontier")}
                        >
                          <ArrowUpRight size={20} />
                        </button>
                      </div>
                      <div className="recovery-summary-body">
                        <div
                          className="recovery-ring"
                          style={
                            {
                              "--ratio": `${ratio * 100}%`,
                            } as React.CSSProperties
                          }
                        >
                          <div>
                            <ShieldCheck size={21} />
                            <strong>
                              {totalVersions
                                ? `${Math.round(ratio * 100)}%`
                                : "—"}
                            </strong>
                            <span>verified versions</span>
                          </div>
                        </div>
                        <div className="recovery-summary-details">
                          <div className="latest-recovery">
                            <span>Newest fully verified snapshot</span>
                            <strong>
                              {data.newestVerified
                                ? short(data.newestVerified)
                                : "Not established"}
                            </strong>
                            <p>
                              {data.newestVerified
                                ? "All required chunks had a verified accessible copy at scan time."
                                : "Run deep verification to establish byte-level recoverability."}
                            </p>
                          </div>
                          <div className="version-tally">
                            <span className="good">
                              <i />
                              {verifiedVersions.toLocaleString()} verified
                            </span>
                            <span className="muted">
                              of {totalVersions.toLocaleString()} file versions
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="panel-bottom">
                        <Clock3 size={13} />
                        <span>
                          {data.scan
                            ? `${data.scan.deep ? "Full-byte" : "Quick metadata"} scan · ${date(data.scan.at)} · ${data.scan.durationMs.toFixed(0)} ms`
                            : "No health scan completed yet."}
                        </span>
                        <button
                          className="text-button"
                          disabled={isBusy}
                          onClick={() =>
                            void run("Deep verification", {
                              action: "scan",
                              scope,
                              deep: true,
                            })
                          }
                        >
                          Verify now
                          <ArrowRight size={13} />
                        </button>
                      </div>
                    </section>
                    <section className="panel replicas">
                      <div className="section-title">
                        <div>
                          <span className="eyebrow">STORAGE COPIES</span>
                          <h2>Two places. One history.</h2>
                        </div>
                        <HardDrive size={20} className="subtle" />
                      </div>
                      {data.repository?.roots.map((root, i) => (
                        <div className="replica" key={root}>
                          <span className="replica-letter">
                            {String.fromCharCode(65 + i)}
                          </span>
                          <div>
                            <strong>
                              Backend {String.fromCharCode(65 + i)}
                            </strong>
                            <code title={root}>{root}</code>
                          </div>
                        </div>
                      ))}
                      <p className="storage-caveat">
                        <TriangleAlert size={14} />
                        Separate directories are logical copies. Physical disk
                        independence is not established.
                      </p>
                    </section>
                  </div>
                  <section className="panel snapshots-panel">
                    <div className="section-title">
                      <div>
                        <span className="eyebrow">RECENT HISTORY</span>
                        <h2>Snapshots</h2>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => navigate("timeline")}
                      >
                        Explore timeline
                        <ArrowRight size={14} />
                      </button>
                    </div>
                    {snapshots.length ? (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Snapshot</th>
                              <th>Captured</th>
                              <th>Files</th>
                              <th>Logical size</th>
                              <th>Recovery evidence</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {snapshots.slice(0, 5).map((s, i) => (
                              <tr
                                key={s.id}
                                onClick={() => {
                                  changeSnapshot(s.id);
                                  navigate("frontier");
                                }}
                              >
                                <td>
                                  <div className="snapshot-name">
                                    <span className="timeline-node" />
                                    <strong>
                                      {s.label || `Snapshot ${short(s.id)}`}
                                    </strong>
                                    {i === 0 && (
                                      <span className="tiny-tag">LATEST</span>
                                    )}
                                  </div>
                                  <code className="subtle snapshot-digest">
                                    {short(s.id)}
                                  </code>
                                </td>
                                <td>{date(s.createdAt)}</td>
                                <td className="mono">
                                  {s.files.toLocaleString()}
                                </td>
                                <td className="mono">{bytes(s.bytes)}</td>
                                <td>
                                  <Status state={s.state} />
                                  {!!s.degraded?.length && (
                                    <div className="small warn">
                                      {s.degraded.length} metadata warning(s)
                                    </div>
                                  )}
                                </td>
                                <td>
                                  <button
                                    className="icon-button"
                                    aria-label={`Inspect ${s.label || short(s.id)}`}
                                    onClick={() => {
                                      changeSnapshot(s.id);
                                      navigate("frontier");
                                    }}
                                  >
                                    <ArrowUpRight size={16} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty icon={History} title="Your history starts here">
                        Capture the first snapshot to store your source files in
                        both backends.
                      </Empty>
                    )}
                  </section>
                </>
              )}
              {screen === "timeline" && (
                <>
                  <div className="action-strip">
                    <div className="field inline-field">
                      <label htmlFor="snapshot-label">Capture label</label>
                      <input
                        id="snapshot-label"
                        placeholder="Optional label for this capture"
                        value={captureLabel}
                        onChange={(e) => setCaptureLabel(e.target.value)}
                      />
                    </div>
                    <button
                      className="button primary"
                      disabled={isBusy || scope === "lab"}
                      onClick={() =>
                        void run(
                          "Capturing snapshot",
                          {
                            action: "capture",
                            label: captureLabel || undefined,
                          },
                          { reset: true },
                        )
                      }
                    >
                      <Plus size={15} />
                      Capture snapshot
                    </button>
                    {data.repository?.isDemo && (
                      <button
                        className="button"
                        disabled={isBusy || scope === "lab"}
                        onClick={() =>
                          void run(
                            "Editing demo source",
                            { action: "demo-edit" },
                            {
                              success:
                                "Demo source changed. Capture a snapshot to record the new version.",
                            },
                          )
                        }
                      >
                        <Zap size={14} />
                        Edit demo source
                      </button>
                    )}
                  </div>
                  <p className="footnote">
                    <CircleHelp size={13} />
                    Live directory captures detect obvious file changes but do
                    not provide an atomic filesystem view.
                  </p>
                  <div className="snapshot-strip">
                    {snapshots.map((s, i) => (
                      <button
                        key={s.id}
                        disabled={isBusy}
                        className={`snapshot-tile ${activeId === s.id ? "active" : ""}`}
                        onClick={() => changeSnapshot(s.id)}
                      >
                        <span className="tile-top">
                          <History size={14} />
                          <span>
                            {i === 0
                              ? "LATEST"
                              : `HISTORY ${snapshots.length - i}`}
                          </span>
                          <Status state={s.state} compact />
                        </span>
                        <strong>{s.label || short(s.id)}</strong>
                        <span>{date(s.createdAt)}</span>
                        <code>{short(s.id)}</code>
                        <small>
                          {s.files} files · {bytes(s.bytes)}
                        </small>
                      </button>
                    ))}
                  </div>
                  {active ? (
                    <>
                      <div className="section-title browser-heading">
                        <div>
                          <span className="eyebrow">SNAPSHOT CONTENTS</span>
                          <h2>{active.label || short(active.id)}</h2>
                        </div>
                        <button
                          className="button small-button"
                          disabled={
                            isBusy ||
                            snapshots.length < 2 ||
                            snapshots.findIndex((s) => s.id === activeId) >=
                              snapshots.length - 1
                          }
                          onClick={() => {
                            const index = snapshots.findIndex(
                              (s) => s.id === activeId,
                            );
                            const prior = snapshots[index + 1];
                            if (prior)
                              void query<Diff>(
                                "Comparing snapshots",
                                {
                                  action: "diff",
                                  scope,
                                  before: prior.id,
                                  after: activeId,
                                },
                                setDiff,
                              );
                          }}
                        >
                          <GitBranch size={14} />
                          Compare with previous
                        </button>
                      </div>
                      {diff && (
                        <section className="diff-results">
                          <div className="diff-heading">
                            <h3>File-level changes</h3>
                            <button
                              className="icon-button"
                              aria-label="Close diff"
                              onClick={() => setDiff(undefined)}
                            >
                              <X size={15} />
                            </button>
                          </div>
                          <div className="diff-columns">
                            {(["added", "changed", "removed"] as const).map(
                              (kind) => (
                                <div key={kind}>
                                  <h4
                                    className={
                                      kind === "added"
                                        ? "good"
                                        : kind === "removed"
                                          ? "bad"
                                          : "warn"
                                    }
                                  >
                                    {kind} <span>{diff[kind].length}</span>
                                  </h4>
                                  {diff[kind].slice(0, 100).map((path) => (
                                    <code className="break" key={path}>
                                      {path}
                                    </code>
                                  ))}
                                  {diff[kind].length > 100 && (
                                    <span className="small muted">
                                      Showing first 100 paths
                                    </span>
                                  )}
                                </div>
                              ),
                            )}
                          </div>
                          <p className="footnote">
                            Compared file metadata and content digests;
                            line-by-line text diff is not provided.
                          </p>
                        </section>
                      )}
                      <div className="browser-layout">
                        <section className="panel browser-panel">
                          {fileTable()}
                        </section>
                        {inspector()}
                      </div>
                    </>
                  ) : (
                    <Empty icon={History} title="No snapshots captured">
                      Capture your first snapshot from the original repository.
                    </Empty>
                  )}
                </>
              )}
              {screen === "frontier" && (
                <>
                  <RecoverySuggestion
                    recommendation={
                      recommendation?.scope === scope &&
                      recommendation.repositoryId === data.repository?.id &&
                      recommendation.scan.id === data.scan?.id
                        ? recommendation
                        : undefined
                    }
                    snapshots={snapshots}
                    busy={isBusy}
                    onAnalyze={() =>
                      void query<RecoveryRecommendation>(
                        "Analyzing recovery options",
                        { action: "plan-recovery", scope },
                        setRecommendation,
                      )
                    }
                    onSelect={changeSnapshot}
                  />
                  <div className="frontier-toolbar">
                    <SnapshotSelect
                      snapshots={snapshots}
                      value={activeId}
                      onChange={changeSnapshot}
                      disabled={isBusy}
                    />
                    <div className="toolbar-right">
                      <button
                        className="button small-button"
                        disabled={isBusy}
                        onClick={() =>
                          void run("Quick metadata analysis", {
                            action: "scan",
                            scope,
                            deep: false,
                          })
                        }
                      >
                        <Search size={14} />
                        Quick analysis
                      </button>
                      <button
                        className="button primary small-button"
                        disabled={isBusy}
                        onClick={() =>
                          void run("Deep verification", {
                            action: "scan",
                            scope,
                            deep: true,
                          })
                        }
                      >
                        <ShieldCheck size={14} />
                        Verify full bytes
                      </button>
                    </div>
                  </div>
                  <div className="legend">
                    {stateKeys.map((key) => (
                      <span key={key}>
                        <Status state={key} />
                      </span>
                    ))}
                  </div>
                  <p className="footnote">
                    Verified means readable and hash-checked under the latest
                    scan. Unknown preserves the possibility of an inaccessible
                    copy. Every scan is a point-in-time observation.
                  </p>
                  {active ? (
                    <>
                      <div className="snapshot-evidence">
                        <div>
                          <span className="eyebrow">SELECTED SNAPSHOT</span>
                          <strong>{active.label || short(active.id)}</strong>
                        </div>
                        <Status state={active.state} />
                        <div className="state-counts">
                          {stateKeys
                            .filter((key) => (active.counts?.[key] ?? 0) > 0)
                            .map((key) => (
                              <span className={statusInfo[key].color} key={key}>
                                {active.counts?.[key]}{" "}
                                {statusInfo[key].short.toLowerCase()}
                              </span>
                            ))}
                        </div>
                      </div>
                      <div className="browser-layout">
                        <section className="panel browser-panel">
                          {fileTable()}
                        </section>
                        {inspector()}
                      </div>
                    </>
                  ) : (
                    <Empty icon={GitBranch} title="No recovery frontier yet">
                      Capture a snapshot to establish file-version dependencies.
                    </Empty>
                  )}
                </>
              )}
              {screen === "lab" && (
                <Laboratory
                  seed={seed}
                  setSeed={setSeed}
                  run={run}
                  isBusy={isBusy}
                  snapshots={snapshots}
                  data={data}
                  scope={scope}
                  query={query}
                  faultKind={faultKind}
                  setFaultKind={setFaultKind}
                  faultBackend={faultBackend}
                  setFaultBackend={setFaultBackend}
                  faultHash={faultHash}
                  setFaultHash={setFaultHash}
                  changeScope={changeScope}
                  navigate={navigate}
                  totalVersions={totalVersions}
                  budget={budget}
                  setBudget={setBudget}
                  plan={plan}
                  setPlan={setPlan}
                />
              )}
              {screen === "restore" && (
                <>
                  <div className="restore-layout">
                    <section className="panel restore-config">
                      <div className="section-title">
                        <div>
                          <span className="eyebrow">
                            01 / CHOOSE YOUR HISTORY
                          </span>
                          <h2>Restore with evidence.</h2>
                        </div>
                        <ArrowDownToLine size={22} />
                      </div>
                      <label className="field">
                        Snapshot
                        <SnapshotSelect
                          snapshots={snapshots}
                          value={activeId}
                          onChange={changeSnapshot}
                          disabled={isBusy}
                        />
                      </label>
                      {active && (
                        <div className="restore-snapshot-state">
                          <Status state={active.state} />
                          <span className="small muted">
                            {active.files} files · {bytes(active.bytes)}
                          </span>
                        </div>
                      )}
                      <fieldset className="restore-mode">
                        <legend>Recovery selection</legend>
                        <label>
                          <input
                            type="radio"
                            name="restore-mode"
                            checked={!selective}
                            onChange={() => setSelective(false)}
                          />
                          <span>
                            <strong>Complete historical snapshot</strong>
                            <small>
                              Every file in the selected snapshot must be
                              recoverable.
                            </small>
                          </span>
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="restore-mode"
                            checked={selective}
                            onChange={() => setSelective(true)}
                          />
                          <span>
                            <strong>Selective file salvage</strong>
                            <small>
                              Choose verified file versions from this snapshot.
                            </small>
                          </span>
                        </label>
                      </fieldset>
                      <div className="form-divider" />
                      <span className="eyebrow">02 / A FRESH DESTINATION</span>
                      <label className="field">
                        Destination parent folder
                        <button
                          className="path-picker"
                          disabled={isBusy}
                          onClick={() => void pick(setRestoreParent)}
                        >
                          <FolderOpen size={15} />
                          <span>
                            {restoreParent || "Choose destination parent"}
                          </span>
                          <ChevronRight size={14} />
                        </button>
                      </label>
                      <label className="field">
                        New folder name
                        <input
                          value={restoreName}
                          onChange={(e) => setRestoreName(e.target.value)}
                          placeholder="recovered-files"
                        />
                      </label>
                      <p className="small muted">
                        REWIND creates a new child directory. Existing
                        destinations are rejected. Data is staged and fully
                        verified before publication.
                      </p>
                      <div className="restore-preview">
                        <span className="eyebrow">RESTORE PREVIEW</span>
                        <code className="break">
                          {restoreParent
                            ? `${restoreParent}/${restoreName}`
                            : "Choose a parent folder above"}
                        </code>
                        <p>
                          {selective
                            ? `${paths.length} selected verified file(s)`
                            : `Complete snapshot · ${active?.files ?? 0} files`}
                        </p>
                      </div>
                      <button
                        className="button primary full-width"
                        disabled={
                          isBusy ||
                          !activeId ||
                          !restoreParent ||
                          !restoreName ||
                          /[\\/]/.test(restoreName) ||
                          restoreName === "." ||
                          restoreName === ".." ||
                          (selective
                            ? !paths.length
                            : active?.state !== "VERIFIED_RECOVERABLE")
                        }
                        onClick={() =>
                          void run(
                            "Restoring and verifying files",
                            {
                              action: "restore",
                              scope,
                              snapshotId: activeId,
                              parent: restoreParent,
                              name: restoreName,
                              paths: selective ? paths : undefined,
                            },
                            {
                              success:
                                "Recovery published. The receipt records verified hashes and source copies; independently verify the output below.",
                            },
                          )
                        }
                      >
                        <ShieldCheck size={16} />
                        Restore & verify
                        <ArrowRight size={15} />
                      </button>
                      {!selective &&
                        active?.state !== "VERIFIED_RECOVERABLE" && (
                          <p className="small warn">
                            A full restore requires a verified complete
                            snapshot. Run a deep scan or choose selective
                            salvage.
                          </p>
                        )}
                    </section>
                    <div className="restore-support">
                      <section className="restore-steps">
                        <div>
                          <span>01</span>
                          <strong>Reconstruct</strong>
                          <p>
                            Read and hash each required chunk, falling back to a
                            valid alternate copy.
                          </p>
                        </div>
                        <div>
                          <span>02</span>
                          <strong>Verify</strong>
                          <p>
                            Recompute whole-file hashes and sizes in a fresh
                            staging directory.
                          </p>
                        </div>
                        <div>
                          <span>03</span>
                          <strong>Publish & record</strong>
                          <p>
                            Publish the recovered directory and write an atomic
                            recovery receipt.
                          </p>
                        </div>
                      </section>
                      <div className="notice caution">
                        <ShieldQuestion size={20} />
                        <p>
                          Receipts document checks. They are not cryptographic
                          attestations against a malicious environment.
                        </p>
                      </div>
                      {latestReceipt && (
                        <div className="latest-receipt">
                          <span className="eyebrow">MOST RECENT RECOVERY</span>
                          <h3>{latestReceipt.files} files recovered</h3>
                          <p className="mono break">
                            {latestReceipt.destination}
                          </p>
                          <button
                            className="text-button"
                            onClick={() =>
                              void bridge
                                .openOutput(latestReceipt.id)
                                .catch((e) => setError(String(e)))
                            }
                          >
                            Open output folder
                            <ArrowUpRight size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {selective && (
                    <>
                      <div className="section-title">
                        <div>
                          <span className="eyebrow">
                            SELECT VERIFIED FILE VERSIONS
                          </span>
                          <h2>{paths.length} files selected</h2>
                        </div>
                        <button
                          className="text-button"
                          onClick={() => setPaths([])}
                        >
                          Clear selection
                        </button>
                      </div>
                      <div className="browser-layout">
                        <section className="panel browser-panel">
                          {fileTable(true)}
                        </section>
                        {inspector()}
                      </div>
                      <p className="footnote">
                        This is a subset of one historical snapshot. A selective
                        restore may be application-inconsistent; it is not a
                        complete historical snapshot.
                      </p>
                    </>
                  )}
                  <section className="receipts-section">
                    <div className="section-title">
                      <div>
                        <span className="eyebrow">
                          VERIFIED RECOVERY RECORD
                        </span>
                        <h2>Recovery receipts</h2>
                      </div>
                    </div>
                    {receipts()}
                  </section>
                </>
              )}
              {screen === "evidence" && (
                <>
                  <section className="scan-evidence panel">
                    <div className="section-title">
                      <div>
                        <span className="eyebrow">
                          LATEST PHYSICAL OBSERVATION
                        </span>
                        <h2>
                          {data.scan?.deep
                            ? "Full-byte verification"
                            : data.scan
                              ? "Quick metadata analysis"
                              : "No completed scan"}
                        </h2>
                      </div>
                      <button
                        className="button"
                        disabled={isBusy}
                        onClick={() =>
                          void run("Deep verification", {
                            action: "scan",
                            scope,
                            deep: true,
                          })
                        }
                      >
                        <ShieldCheck size={15} />
                        Run full scan
                      </button>
                    </div>
                    {data.scan ? (
                      <>
                        <dl className="evidence-facts">
                          <div>
                            <dt>Scan time</dt>
                            <dd>{date(data.scan.at)}</dd>
                          </div>
                          <div>
                            <dt>Elapsed</dt>
                            <dd className="mono">
                              {data.scan.durationMs.toFixed(1)} ms
                            </dd>
                          </div>
                          <div>
                            <dt>Evidence scope</dt>
                            <dd>
                              {scope === "lab"
                                ? "Isolated laboratory"
                                : "Original repository"}
                            </dd>
                          </div>
                          <div>
                            <dt>Scan ID</dt>
                            <dd className="mono">{short(data.scan.id)}</dd>
                          </div>
                        </dl>
                        <div className="scan-counts">
                          {Object.entries(data.scan.counts).map(
                            ([key, value]) => (
                              <div key={key}>
                                <strong>{value.toLocaleString()}</strong>
                                <span>
                                  {key.replaceAll("_", " ").toLowerCase()}
                                </span>
                              </div>
                            ),
                          )}
                        </div>
                        <div className="panel-bottom">
                          <p>
                            Observation is point-in-time. Restore independently
                            rechecks bytes.
                          </p>
                          <button
                            className="text-button"
                            onClick={() =>
                              saveJSON(data.scan, "rewind-scan.json")
                            }
                          >
                            <Download size={13} />
                            Export scan
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="muted">
                        Run a deep scan to inspect real stored chunk bytes and
                        their hashes.
                      </p>
                    )}
                  </section>
                  <section className="receipts-section">
                    <div className="section-title">
                      <div>
                        <span className="eyebrow">
                          INDEPENDENTLY CHECKABLE OUTPUT
                        </span>
                        <h2>Recovery receipts</h2>
                      </div>
                    </div>
                    {receipts()}
                  </section>
                  <section className="panel evaluation-panel">
                    <div className="section-title">
                      <div>
                        <span className="eyebrow">REPRODUCIBLE EVALUATION</span>
                        <h2>Measured evidence</h2>
                      </div>
                      {data.evaluation !== undefined && (
                        <button
                          className="button small-button"
                          onClick={() =>
                            saveJSON(data.evaluation, "rewind-evaluation.json")
                          }
                        >
                          <Download size={13} />
                          Export JSON
                        </button>
                      )}
                    </div>
                    {data.evaluation !== undefined ? (
                      <>
                        <p className="small muted">
                          Actual harness output. Read the environment, fixture
                          seed, and scope before comparing timing or throughput.
                        </p>
                        <pre>{JSON.stringify(data.evaluation, null, 2)}</pre>
                      </>
                    ) : (
                      <div className="evaluation-empty">
                        <Terminal size={24} />
                        <div>
                          <h3>No evaluation report found</h3>
                          <p>
                            Run the seeded evaluation harness from the project
                            directory. It writes real timings and independent
                            oracle comparisons to{" "}
                            <code>results/summary.json</code>.
                          </p>
                          <code className="command">npm run evaluate</code>
                        </div>
                      </div>
                    )}
                  </section>
                </>
              )}
              {screen === "settings" && (
                <>
                  <section className="panel settings-paths">
                    <div className="section-title">
                      <div>
                        <span className="eyebrow">CONNECTED REPOSITORY</span>
                        <h2>Local storage configuration</h2>
                      </div>
                      <button
                        className="button small-button"
                        disabled={isBusy}
                        onClick={() => {
                          setSetup({ source: "", a: "", b: "" });
                          setError("");
                          setNotice("");
                          setConnecting(true);
                        }}
                      >
                        <FolderOpen size={14} />
                        Connect another workspace
                      </button>
                    </div>
                    <dl>
                      <dt>Repository ID</dt>
                      <dd className="mono">{data.repository?.id}</dd>
                      <dt>Source folder</dt>
                      <dd className="mono break">{data.repository?.source}</dd>
                      {data.repository?.roots.map((root, index) => (
                        <div className="settings-path-row" key={root}>
                          <dt>Backend {String.fromCharCode(65 + index)}</dt>
                          <dd className="mono break">{root}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="panel-bottom">
                      <p className="small muted">
                        SQLite is a derived index. Durable committed manifests
                        remain the source of truth.
                      </p>
                      <button
                        className="button small-button"
                        disabled={isBusy}
                        onClick={() =>
                          void run(
                            "Rebuilding SQLite catalog",
                            { action: "rebuild", scope },
                            {
                              success:
                                "Derived SQLite catalog rebuilt from committed storage metadata.",
                            },
                          )
                        }
                      >
                        <RotateCcw size={14} />
                        Rebuild catalog
                      </button>
                    </div>
                  </section>
                  <section className="help-grid">
                    <article>
                      <ShieldCheck size={22} />
                      <h2>Local by design.</h2>
                      <p>
                        Backup, verification, simulation, and restore work
                        without an account, backend service, paid API, or
                        internet connection. No telemetry is collected.
                      </p>
                    </article>
                    <article>
                      <HardDrive size={22} />
                      <h2>Copies are not failure domains.</h2>
                      <p>
                        Two directories on the same disk do not protect against
                        the disk failing. Put storage roots on independently
                        managed media for physical separation.
                      </p>
                    </article>
                    <article>
                      <Clock3 size={22} />
                      <h2>A scan is an observation.</h2>
                      <p>
                        Verified recovery means every required chunk was read
                        and hash-checked in the completed scan. It does not
                        guarantee future readability. Quick analysis cannot
                        prove byte integrity.
                      </p>
                    </article>
                    <article>
                      <TriangleAlert size={22} />
                      <h2>Know the limits.</h2>
                      <p>
                        Live source capture is not globally atomic. Symlinks and
                        unsupported filesystem objects are rejected or reported.
                        ACLs, xattrs, resource forks, and perfect filesystem
                        consistency are not preserved.
                      </p>
                    </article>
                  </section>
                  <section className="panel documentation">
                    <div>
                      <span className="eyebrow">ENGINEERING NOTES</span>
                      <h2>Trust the evidence, understand its limits.</h2>
                      <p>
                        SHA-256 detects accidental corruption when expected
                        digests are trusted. An attacker who rewrites both data
                        and trust anchors is outside this model. Backup data is
                        not encrypted. Abandoned immutable chunks may consume
                        storage; garbage collection is not exposed.
                      </p>
                    </div>
                    <div className="doc-list">
                      <span>
                        README.md<small>Install, run, and safe demo</small>
                      </span>
                      <span>
                        docs/ARCHITECTURE.md
                        <small>Formats and dependency model</small>
                      </span>
                      <span>
                        docs/DURABILITY_AND_LIMITS.md
                        <small>Publication, crashes, and boundaries</small>
                      </span>
                      <span>
                        docs/THREAT_MODEL.md
                        <small>Local trust and bridge protections</small>
                      </span>
                    </div>
                    <p className="footnote">
                      Documentation is bundled in the project. Folder
                      configuration changes require creating a new repository;
                      existing storage roots are never silently retargeted.
                    </p>
                  </section>
                  {data.warnings.length > 0 && (
                    <section className="panel warnings-panel">
                      <h2>Current repository warnings</h2>
                      {data.warnings.map((warning, index) => (
                        <p className="small warn" key={index}>
                          <TriangleAlert size={14} />
                          {warning}
                        </p>
                      ))}
                    </section>
                  )}
                </>
              )}
              <footer className="workspace-footer">
                <span>
                  <span className="footer-dot" />
                  LOCAL DATA · REAL CHECKS
                </span>
                <span>
                  {scope === "lab"
                    ? "ISOLATED SIMULATION"
                    : "ORIGINAL REPOSITORY"}
                  <span className="footer-separator">/</span>REWIND
                </span>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
