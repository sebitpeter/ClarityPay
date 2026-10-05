'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─── Types ────────────────────────────────────────────────────────
type Customer = {
  id: string;
  name: string;
  phone: string;
  age: number;
  balance: number;
  typicalTransferMin: number;
  typicalTransferMax: number;
  transactions: Transaction[];
  beneficiaries: Beneficiary[];
  trustedContacts: TrustedContact[];
};

type Beneficiary = {
  id: string;
  name: string;
  accountOrPhone: string;
  channel: string;
  trusted: boolean;
};

type TrustedContact = {
  id: string;
  name: string;
  relationship: string;
  phone: string;
  enabled: boolean;
};

type Transaction = {
  id: string;
  amount: number;
  currency: string;
  channel: string;
  recipientName: string;
  recipientRef: string;
  paymentReason: string;
  riskScore: number;
  riskLevel: string;
  status: string;
  createdAt: string;
};

type RiskSignal = {
  type: string;
  category: string;
  label: string;
  score: number;
};

type RiskResult = {
  riskScore: number;
  riskLevel: string;
  communicationScore: number;
  transactionScore: number;
  signals: RiskSignal[];
  source?: string;
};

type AuditEvent = {
  id: string;
  eventType: string;
  description: string;
  createdAt: string;
  transactionId?: string;
};

type Analytics = {
  simulated: boolean;
  screened: number;
  suspicious: number;
  highRisk: number;
  paused: number;
  protected: number;
  avgInterventionMs: number;
  byChannel: Record<string, number>;
  byRiskLevel: Record<string, number>;
  signalFrequency: Record<string, number>;
};

type TranscriptLine = {
  time: string;
  text: string;
  isNew: boolean;
};

type Screen =
  | "dashboard"
  | "send"
  | "simulation"
  | "audit"
  | "analytics"
  | "settings";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

// ─── Formatters ───────────────────────────────────────────────────
function ugx(amount: number) {
  return "UGX " + Math.round(amount).toLocaleString("en-UG");
}

function relDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString("en-UG", { day: "numeric", month: "short" });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-UG", { hour: "2-digit", minute: "2-digit" });
}

function nowTime() {
  return new Date().toLocaleTimeString("en-UG", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ─── Risk helpers ─────────────────────────────────────────────────
function riskBadgeClass(level: string) {
  switch (level.toUpperCase()) {
    case "LOW":      return "badge badge-low";
    case "MEDIUM":   return "badge badge-medium";
    case "HIGH":     return "badge badge-high";
    case "CRITICAL": return "badge badge-critical";
    case "PAUSED":   return "badge badge-paused";
    default:         return "badge badge-low";
  }
}

function riskFillClass(level: string) {
  switch (level.toUpperCase()) {
    case "LOW":      return "risk-fill risk-fill-low";
    case "MEDIUM":   return "risk-fill risk-fill-medium";
    case "HIGH":     return "risk-fill risk-fill-high";
    case "CRITICAL": return "risk-fill risk-fill-critical";
    default:         return "risk-fill risk-fill-low";
  }
}

function signalItemClass(score: number) {
  if (score >= 18) return "signal-item signal-item-crit";
  if (score >= 12) return "signal-item signal-item-high";
  if (score >= 5)  return "signal-item signal-item-med";
  return "signal-item signal-item-low";
}

function statusDisplay(status: string) {
  switch (status) {
    case "COMPLETED":  return <span className="badge badge-green">Completed</span>;
    case "PAUSED":     return <span className="badge badge-paused">Safety Paused</span>;
    case "INTERCEPTED":return <span className="badge badge-critical">Intercepted</span>;
    case "FLAGGED":    return <span className="badge badge-high">Flagged</span>;
    case "RELEASED":   return <span className="badge badge-blue">Released</span>;
    case "CANCELLED":  return <span className="badge badge-medium">Cancelled</span>;
    default:           return <span className="badge badge-low">Pending</span>;
  }
}

// ─── Main App ─────────────────────────────────────────────────────
export default function ClarityPay() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [audits, setAudits] = useState<AuditEvent[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  // Live risk state (driven by SSE + simulation)
  const [risk, setRisk] = useState<RiskResult>({
    riskScore: 0,
    riskLevel: "LOW",
    communicationScore: 0,
    transactionScore: 0,
    signals: []
  });

  // Simulation state
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [simRunning, setSimRunning] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Send money flow state
  const [sendStep, setSendStep] = useState<"form" | "review" | "critical" | "paused" | "released">("form");
  const [lastTransaction, setLastTransaction] = useState<Transaction | null>(null);
  const [lastRisk, setLastRisk] = useState<RiskResult | null>(null);
  const [sendLoading, setSendLoading] = useState(false);
  const [explicitConfirm, setExplicitConfirm] = useState(false);
  const [notifyContact, setNotifyContact] = useState(false);

  // Send form
  const [form, setForm] = useState({
    channel: "MOBILE_MONEY",
    recipientRef: "+256 7XX XXX XXX",
    recipientName: "",
    amount: "4500000",
    paymentReason: "OTHER"
  });

  // Load initial data
  useEffect(() => {
    fetch(`${API}/api/customer`)
      .then(r => r.json())
      .then(setCustomer)
      .catch(() => {});

    fetch(`${API}/api/audit`)
      .then(r => r.json())
      .then(setAudits)
      .catch(() => {});
  }, []);

  // SSE stream
  useEffect(() => {
    const source = new EventSource(`${API}/api/events`);

    source.onmessage = (e) => {
      const data = JSON.parse(e.data);

      if (data.type === "risk") {
        setRisk(data.result);
      }

      if (data.type === "transcript") {
        const line: TranscriptLine = {
          time: nowTime(),
          text: data.line,
          isNew: true
        };
        setTranscriptLines(prev => {
          const updated = [...prev, line];
          // After a short delay, remove isNew flag
          setTimeout(() => {
            setTranscriptLines(curr =>
              curr.map((l, i) => i === updated.length - 1 ? { ...l, isNew: false } : l)
            );
          }, 800);
          return updated;
        });
        setRisk(data.result);
      }

      if (data.type === "audit") {
        setAudits(prev => [data.event, ...prev].slice(0, 50));
      }

      if (data.type === "hold") {
        setLastTransaction(data.transaction);
        setSendStep("paused");
      }
    };

    return () => source.close();
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [transcriptLines]);

  // Load analytics when on that screen
  useEffect(() => {
    if (screen === "analytics" && !analytics) {
      fetch(`${API}/api/analytics`)
        .then(r => r.json())
        .then(setAnalytics)
        .catch(() => {});
    }
  }, [screen, analytics]);

  // ── Send money handlers ────────────────────────────────────────
  async function handleSendSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSendLoading(true);

    // Include any transcript content from simulation
    const transcriptText = transcriptLines.map(l => l.text).join(" ");

    const res = await fetch(`${API}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Number(form.amount),
        channel: form.channel,
        recipientName: form.recipientName || "New Recipient",
        recipientRef: form.recipientRef,
        paymentReason: form.paymentReason,
        deviceId: "new-device-unknown",
        transcript: transcriptText
      })
    });

    const data = await res.json();
    setSendLoading(false);

    if (!res.ok) {
      alert(data.error || "Unable to create transaction");
      return;
    }

    setLastTransaction(data.transaction);
    setLastRisk(data.risk);

    if (data.risk.riskScore >= 50) {
      setSendStep("review");
    } else if (data.risk.riskScore >= 25) {
      setSendStep("review");
    } else {
      alert("Payment processed successfully. Risk level: LOW.");
      setSendStep("form");
    }
  }

  async function handleContactedYes() {
    setSendStep("critical");
  }

  async function handleActivateHold() {
    if (!lastTransaction) return;
    const res = await fetch(`${API}/api/transactions/${lastTransaction.id}/hold`, {
      method: "POST"
    });
    const data = await res.json();
    if (res.ok) {
      setLastTransaction(data.transaction);
      setNotifyContact(true);
      setSendStep("paused");
    }
  }

  async function handleRelease() {
    if (!lastTransaction) return;
    const res = await fetch(`${API}/api/transactions/${lastTransaction.id}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Customer confirmed after explicit warning" })
    });
    if (res.ok) {
      setSendStep("released");
    }
  }

  async function handleCancel() {
    if (!lastTransaction) return;
    await fetch(`${API}/api/transactions/${lastTransaction.id}/cancel`, { method: "POST" });
    setSendStep("form");
    setExplicitConfirm(false);
  }

  // ── Simulation ─────────────────────────────────────────────────
  async function startSimulation() {
    setScreen("simulation");
    setTranscriptLines([]);
    setRisk({ riskScore: 0, riskLevel: "LOW", communicationScore: 0, transactionScore: 0, signals: [] });
    setSimRunning(true);
    await fetch(`${API}/api/simulate-transcript`, { method: "POST" });
    setSimRunning(false);
  }

  // ── Memos ──────────────────────────────────────────────────────
  const todayTxs = useMemo(() => {
    if (!customer) return [];
    const today = new Date().toDateString();
    return customer.transactions.filter(tx =>
      new Date(tx.createdAt).toDateString() === today
    );
  }, [customer]);

  const todayTotal = useMemo(() =>
    todayTxs.reduce((s, tx) => s + tx.amount, 0), [todayTxs]);

  // ── Render helpers ─────────────────────────────────────────────
  const renderRiskMeter = (r: RiskResult) => (
    <div className="risk-meter">
      <div className="risk-score-row">
        <div>
          <div className="risk-score-label">Risk score</div>
          <div className="risk-score-num" style={{
            color: r.riskLevel === "CRITICAL" ? "var(--red)"
              : r.riskLevel === "HIGH" ? "var(--orange)"
              : r.riskLevel === "MEDIUM" ? "var(--amber)"
              : "var(--green)"
          }}>
            {r.riskScore}
          </div>
        </div>
        <span className={riskBadgeClass(r.riskLevel)}>{r.riskLevel}</span>
      </div>
      <div className="risk-track">
        <div
          className={riskFillClass(r.riskLevel)}
          style={{ width: `${r.riskScore}%` }}
        />
      </div>
      <div className="risk-track-labels"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
    </div>
  );

  const renderSignals = (signals: RiskSignal[]) => {
    if (signals.length === 0) return (
      <div style={{ fontSize: 13, color: "var(--muted)", padding: "12px 0" }}>
        No risk signals detected yet.
      </div>
    );
    return (
      <div className="signal-list">
        {signals.map((s, i) => (
          <div key={i} className={signalItemClass(s.score)}>
            <span>{s.score >= 18 ? "🔴" : s.score >= 10 ? "🟠" : "🟡"}</span>
            <span style={{ flex: 1 }}>{s.label}</span>
            {s.score > 0 && <span className="signal-score">+{s.score}</span>}
          </div>
        ))}
      </div>
    );
  };

  // ──────────────────────────────────────────────────────────────
  // SCREENS
  // ──────────────────────────────────────────────────────────────

  const renderDashboard = () => (
    <div style={{ display: "grid", gap: 20 }}>
      {/* Stats row */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Account balance</div>
          <div className="stat-value" style={{ fontSize: 22 }}>{ugx(customer?.balance || 12800000)}</div>
          <div className="stat-sub">Available funds</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Today&apos;s activity</div>
          <div className="stat-value" style={{ fontSize: 22 }}>{todayTxs.length}</div>
          <div className="stat-sub">{ugx(todayTotal)} transferred</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Protection status</div>
          <div style={{ marginTop: 8 }}>
            <span className="live-indicator">
              <span className="live-dot" />
              Protection active
            </span>
          </div>
          <div className="stat-sub" style={{ marginTop: 6 }}>ClarityPay monitoring</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Current risk level</div>
          <div style={{ marginTop: 8 }}>
            <span className={riskBadgeClass(risk.riskLevel)} style={{ fontSize: 14, padding: "5px 12px" }}>
              {risk.riskLevel}
            </span>
          </div>
          <div className="stat-sub" style={{ marginTop: 6 }}>Score: {risk.riskScore}/100</div>
        </div>
      </div>

      {/* Action cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div className="card" style={{ padding: 20, cursor: "pointer" }} onClick={() => { setSendStep("form"); setScreen("send"); }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>💸</div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Send Money</div>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Bank transfer or Mobile Money</div>
        </div>
        <div className="card" style={{ padding: 20, cursor: "pointer", border: "1px solid #fde68a" }} onClick={startSimulation}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🎯</div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Run Scam Simulation</div>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>See ClarityPay detect a live scam</div>
        </div>
      </div>

      {/* Customer profile */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Customer profile</div>
            <div className="card-subtitle">Simulated demo data</div>
          </div>
          <span className="badge badge-blue">Demo</span>
        </div>
        <div className="card-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
            {[
              { label: "Name", value: customer?.name || "Sarah Namusoke" },
              { label: "Age", value: customer?.age || 57 },
              { label: "Phone", value: customer?.phone || "+256 772 456789" },
              { label: "Typical transfer", value: `${ugx(customer?.typicalTransferMin || 20000)} – ${ugx(customer?.typicalTransferMax || 500000)}` },
              { label: "Trusted contact", value: customer?.trustedContacts?.[0]?.name || "Martha Namusoke" },
              { label: "Relationship", value: customer?.trustedContacts?.[0]?.relationship || "Daughter" }
            ].map(item => (
              <div key={item.label} style={{ padding: "12px", border: "1px solid var(--border)", borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>{item.label}</div>
                <div style={{ fontWeight: 700, marginTop: 4, fontSize: 13 }}>{item.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent transactions */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Recent transactions</div>
            <div className="card-subtitle">Last 10 payments</div>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="tx-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Recipient</th>
                <th>Channel</th>
                <th>Amount</th>
                <th>Risk</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(customer?.transactions || []).slice(0, 10).map(tx => (
                <tr key={tx.id}>
                  <td style={{ color: "var(--muted)", fontSize: 12 }}>{relDate(tx.createdAt)}</td>
                  <td className="tx-recipient">{tx.recipientName}</td>
                  <td>
                    <span className={tx.channel === "MOBILE_MONEY" ? "tx-channel tx-channel-mm" : "tx-channel tx-channel-bk"}>
                      {tx.channel === "MOBILE_MONEY" ? "Mobile Money" : "Bank"}
                    </span>
                  </td>
                  <td className="tx-amount">{ugx(tx.amount)}</td>
                  <td><span className={riskBadgeClass(tx.riskLevel)}>{tx.riskLevel}</span></td>
                  <td>{statusDisplay(tx.status)}</td>
                </tr>
              ))}
              {(customer?.transactions || []).length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--muted)", padding: 24 }}>No transactions yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="disclaimer">
        <span>⚠️</span>
        <span><strong>Prototype:</strong> This demonstration uses simulated customer, transaction and communication data. It is not connected to real financial accounts or payment networks.</span>
      </div>
    </div>
  );

  const renderSend = () => {
    if (sendStep === "form") {
      return (
        <div style={{ maxWidth: 520, margin: "0 auto", display: "grid", gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Send Money</div>
                <div className="card-subtitle">Bank transfer or Mobile Money — simulated</div>
              </div>
            </div>
            <div className="card-body">
              <form onSubmit={handleSendSubmit} style={{ display: "grid", gap: 16 }}>
                <div className="field">
                  <label>Payment channel</label>
                  <select
                    className="input select"
                    value={form.channel}
                    onChange={e => setForm(f => ({ ...f, channel: e.target.value }))}
                  >
                    <option value="MOBILE_MONEY">📱 Mobile Money</option>
                    <option value="BANK">🏦 Bank Transfer</option>
                  </select>
                </div>

                <div className="field">
                  <label>{form.channel === "MOBILE_MONEY" ? "Recipient phone number" : "Account number"}</label>
                  <input
                    className="input"
                    value={form.recipientRef}
                    onChange={e => setForm(f => ({ ...f, recipientRef: e.target.value }))}
                    placeholder={form.channel === "MOBILE_MONEY" ? "+256 7XX XXX XXX" : "Account number"}
                    required
                  />
                </div>

                <div className="field">
                  <label>Recipient name</label>
                  <input
                    className="input"
                    value={form.recipientName}
                    onChange={e => setForm(f => ({ ...f, recipientName: e.target.value }))}
                    placeholder="e.g. John Ssemwanga"
                  />
                  <span className="field-hint">Leave blank if unknown</span>
                </div>

                <div className="field">
                  <label>Amount (UGX)</label>
                  <input
                    className="input"
                    type="number"
                    min="1000"
                    value={form.amount}
                    onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                    placeholder="e.g. 500000"
                    required
                  />
                  <span className="field-hint">
                    {form.amount ? ugx(Number(form.amount)) : ""}
                  </span>
                </div>

                <div className="field">
                  <label>Payment reason</label>
                  <select
                    className="input select"
                    value={form.paymentReason}
                    onChange={e => setForm(f => ({ ...f, paymentReason: e.target.value }))}
                  >
                    <option value="FAMILY">Family / Personal</option>
                    <option value="RENT">Rent</option>
                    <option value="SCHOOL_FEES">School fees</option>
                    <option value="BUSINESS">Business</option>
                    <option value="UTILITIES">Utilities</option>
                    <option value="MEDICAL">Medical</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>

                <hr className="divider" />

                <button
                  type="submit"
                  className="btn btn-primary btn-lg btn-block"
                  disabled={sendLoading}
                >
                  {sendLoading ? "Analysing payment…" : "Continue →"}
                </button>
              </form>
            </div>
          </div>
        </div>
      );
    }

    if (sendStep === "review" && lastRisk) {
      return (
        <div style={{ maxWidth: 560, margin: "0 auto", display: "grid", gap: 16 }}>
          <div className="card" style={{
            border: `1px solid ${lastRisk.riskLevel === "CRITICAL" ? "var(--crit-border)" : lastRisk.riskLevel === "HIGH" ? "var(--high-border)" : "var(--med-border)"}`,
          }}>
            <div className={`modal-banner ${lastRisk.riskLevel === "CRITICAL" ? "modal-banner-critical" : lastRisk.riskLevel === "HIGH" ? "modal-banner-high" : ""}`}
              style={lastRisk.riskLevel === "MEDIUM" ? { background: "var(--med-bg)", color: "var(--amber)", borderBottom: "1px solid var(--med-border)" } : {}}
            >
              ⚠️ This payment looks unusual
            </div>
            <div className="card-body" style={{ display: "grid", gap: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{ugx(Number(form.amount))}</div>
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>to {form.recipientRef}</div>
                </div>
                <span className={riskBadgeClass(lastRisk.riskLevel)} style={{ fontSize: 13, padding: "6px 14px" }}>
                  {lastRisk.riskLevel} — {lastRisk.riskScore}/100
                </span>
              </div>

              {renderRiskMeter(lastRisk)}

              <hr className="divider" />

              <div style={{ fontWeight: 700, marginBottom: 8 }}>We noticed:</div>
              {renderSignals(lastRisk.signals)}

              <hr className="divider" />

              <div className="modal-question">
                Did someone contact you and ask you to make this payment?
              </div>

              <div className="modal-actions">
                <button
                  className="btn btn-danger btn-lg btn-block"
                  onClick={handleContactedYes}
                >
                  Yes, someone contacted me
                </button>
                <button
                  className="btn btn-lg btn-block"
                  style={{ background: "var(--surface2)" }}
                  onClick={() => setSendStep("form")}
                >
                  No — I initiated this myself
                </button>
              </div>

              <div className="info-box">
                <strong>Important:</strong> ClarityPay is not accusing you of being scammed. This payment is unusual compared to your normal behaviour. If you initiated this yourself for school fees, rent, medical costs or business, you can continue.
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (sendStep === "critical" && lastRisk) {
      return (
        <div style={{ maxWidth: 580, margin: "0 auto", display: "grid", gap: 16 }}>
          <div className="card" style={{ border: "1px solid var(--crit-border)" }}>
            <div className="modal-banner modal-banner-critical">
              🚨 Possible scam — please read carefully
            </div>
            <div className="card-body" style={{ display: "grid", gap: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>
                Someone may be trying to persuade you to move your money.
              </div>

              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--muted)" }}>Why we are concerned:</div>
              <div className="warning-list">
                {[
                  "The caller appears to be impersonating a bank employee",
                  "You were told to move money to a 'safe' account",
                  "You were asked to act immediately",
                  "You were told not to tell anyone",
                  "The caller is keeping you on the phone while you pay"
                ].map((item, i) => (
                  <div key={i} className="warning-item">
                    <span>🚩</span>
                    <span>{item}</span>
                  </div>
                ))}
              </div>

              <div style={{
                padding: "14px 16px",
                background: "#fef2f2",
                border: "1px solid var(--crit-border)",
                borderRadius: 10,
                fontWeight: 700,
                fontSize: 14,
                color: "var(--red)",
                lineHeight: 1.6
              }}>
                Your bank will <u>never</u> ask you to move money to a &quot;safe account&quot; simply because someone called you.
              </div>

              <div style={{ fontSize: 13, color: "var(--muted)" }}>
                Risk score: {lastRisk.riskScore}/100 — {lastRisk.riskLevel}
              </div>

              <hr className="divider" />

              <div className="modal-actions">
                <button className="btn btn-danger btn-lg btn-block" onClick={handleActivateHold}>
                  🛑 Pause this payment (recommended)
                </button>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <button className="btn btn-lg" onClick={() => setSendStep("form")}>
                    Cancel payment
                  </button>
                  <button
                    className="btn btn-lg"
                    style={{ background: "var(--surface2)", fontSize: 13 }}
                    onClick={() => {
                      setExplicitConfirm(false);
                      setSendStep("review");
                    }}
                  >
                    Review again
                  </button>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ justifySelf: "center", color: "var(--muted)", fontSize: 12 }}
                  onClick={() => setSendStep("released")}
                >
                  I understand and still want to continue →
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (sendStep === "released") {
      return (
        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          <div className="card" style={{ border: "1px solid #fde68a" }}>
            <div className="modal-banner" style={{ background: "#fffbeb", color: "#92400e", borderBottom: "1px solid #fde68a" }}>
              ⚠️ Continue after confirmation
            </div>
            <div className="card-body" style={{ display: "grid", gap: 16 }}>
              <div style={{ fontWeight: 600 }}>
                Before this payment is released, please confirm that you understand the risk.
              </div>

              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", padding: "14px", background: "var(--surface2)", borderRadius: 10, border: "1px solid var(--border)" }}>
                <input
                  type="checkbox"
                  checked={explicitConfirm}
                  onChange={e => setExplicitConfirm(e.target.checked)}
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                <span style={{ fontSize: 13, lineHeight: 1.6 }}>
                  I understand that this payment may be a scam. I have not been pressured by anyone on the phone. I am choosing to continue of my own free will.
                </span>
              </label>

              <div className="modal-actions">
                <button
                  className="btn btn-warning btn-lg btn-block"
                  disabled={!explicitConfirm}
                  onClick={handleRelease}
                >
                  Confirm payment — {ugx(Number(form.amount))}
                </button>
                <button className="btn btn-lg btn-block" onClick={() => { setSendStep("form"); setExplicitConfirm(false); }}>
                  Go back to dashboard
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (sendStep === "paused") {
      const contact = customer?.trustedContacts?.[0];
      return (
        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          <div className="card" style={{ border: "1px solid #fed7aa" }}>
            <div className="modal-banner" style={{ background: "#fff7ed", color: "#c2410c", borderBottom: "1px solid #fed7aa" }}>
              🟠 Payment paused for your protection
            </div>
            <div className="card-body" style={{ display: "grid", gap: 16, textAlign: "center" }}>
              <div style={{ fontSize: 36, marginTop: 8 }}>🛑</div>
              <div style={{ fontWeight: 800, fontSize: 20 }}>SAFETY PAUSED</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{ugx(Number(form.amount))}</div>
              <div style={{ fontSize: 13, color: "var(--muted)" }}>to {form.recipientRef}</div>

              <div style={{ padding: "14px", background: "var(--surface2)", borderRadius: 10, border: "1px solid var(--border)", textAlign: "left", fontSize: 13, lineHeight: 1.7, color: "var(--muted)" }}>
                We have temporarily paused this payment because several risk indicators were detected. Your money has not moved. No payment has been made.
              </div>

              {contact && (
                <div style={{ padding: "14px", background: "var(--green-lt)", borderRadius: 10, border: "1px solid var(--low-border)", textAlign: "left" }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "var(--green)" }}>✓ Safety contact notified (simulated)</div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                    A safety alert has been prepared for {contact.name} ({contact.relationship}). In a real deployment, this notification would be sent with your consent.
                  </div>
                </div>
              )}

              <hr className="divider" />

              <div style={{ display: "grid", gap: 10 }}>
                <button className="btn btn-primary btn-lg btn-block" onClick={() => { setScreen("dashboard"); setSendStep("form"); setExplicitConfirm(false); }}>
                  Return to dashboard
                </button>
                <button className="btn btn-lg btn-block" onClick={() => setScreen("audit")}>
                  View audit trail
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ color: "var(--muted)", fontSize: 12 }}
                  onClick={() => { setSendStep("released"); }}
                >
                  I still want to continue (review again) →
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return null;
  };

  const renderSimulation = () => (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,.9fr)", gap: 18 }}>
      {/* Left: transcript */}
      <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Live call transcript — simulated</div>
              <div className="card-subtitle">Demo scam scenario — not a real call recording</div>
            </div>
            {simRunning
              ? <span className="live-indicator"><span className="live-dot" /> Analysing</span>
              : <button className="btn btn-sm" onClick={startSimulation}>▶ Replay</button>
            }
          </div>
          <div className="card-body">
            <div className="disclaimer" style={{ marginBottom: 14 }}>
              <span>🔒</span>
              <span>ClarityPay does not record phone calls. This is a simulated transcript for demo purposes only.</span>
            </div>
            <div className="transcript-box" ref={transcriptRef}>
              {transcriptLines.length === 0 ? (
                <div style={{ color: "#64748b" }}>
                  Click &quot;Run Scam Simulation&quot; to stream the demo transcript line by line…
                </div>
              ) : (
                transcriptLines.map((line, i) => (
                  <div key={i} className={`transcript-line ${line.isNew ? "transcript-new" : ""}`}>
                    <span className="transcript-time">{line.time}</span>
                    <span className="transcript-text">&ldquo;{line.text}&rdquo;</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Score breakdown */}
        <div className="card">
          <div className="card-header"><div className="card-title">Risk breakdown — Why was this flagged?</div></div>
          <div className="card-body" style={{ display: "grid", gap: 14 }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>Communication risk</span>
                <span style={{ fontWeight: 800 }}>{risk.communicationScore}/100</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${risk.communicationScore}%`, background: "var(--orange)" }} />
              </div>
            </div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>Transaction risk</span>
                <span style={{ fontWeight: 800 }}>{risk.transactionScore}/100</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${risk.transactionScore}%`, background: "var(--brand)" }} />
              </div>
            </div>
            <hr className="divider" />
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              Final score = Transaction × 60% + Communication × 40%
            </div>
          </div>
        </div>
      </div>

      {/* Right: risk + signals */}
      <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
        <div className="card">
          <div className="card-header"><div className="card-title">Overall risk score</div></div>
          <div className="card-body">{renderRiskMeter(risk)}</div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Detected signals</div>
          </div>
          <div className="card-body">{renderSignals(risk.signals)}</div>
        </div>

        <div className="card" style={{ border: "1px solid #fde68a" }}>
          <div className="card-body">
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Next step</div>
            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.7, marginBottom: 14 }}>
              The simulation shows how ClarityPay would intercept this payment before it leaves Sarah&apos;s account.
            </div>
            <button
              className="btn btn-primary btn-block"
              onClick={() => { setSendStep("form"); setScreen("send"); }}
            >
              Try the Send Money flow →
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const renderAudit = () => (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Audit trail</div>
            <div className="card-subtitle">Every significant ClarityPay event is logged here</div>
          </div>
        </div>
        <div className="card-body">
          {audits.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>No events yet. Run the simulation or initiate a transfer.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="tx-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {audits.map(ev => (
                    <tr key={ev.id}>
                      <td style={{ color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>{fmtTime(ev.createdAt)}</td>
                      <td>
                        <span className="badge badge-blue" style={{ fontSize: 10 }}>{ev.eventType}</span>
                      </td>
                      <td style={{ fontSize: 13 }}>{ev.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <div className="disclaimer">
        <span>⚠️</span>
        <span>All audit events shown are from simulated prototype data. No real financial actions have been taken.</span>
      </div>
    </div>
  );

  const renderAnalytics = () => {
    const a = analytics;
    if (!a) return <div style={{ color: "var(--muted)", padding: 24 }}>Loading analytics…</div>;

    const total = Object.values(a.byRiskLevel).reduce((s, v) => s + v, 0);
    const signalEntries = Object.entries(a.signalFrequency).sort((x, y) => y[1] - x[1]);
    const maxSig = signalEntries[0]?.[1] || 1;

    const signalLabels: Record<string, string> = {
      NEW_RECIPIENT: "New recipient",
      LARGE_AMOUNT: "Unusually large amount",
      URGENCY: "Urgency pressure",
      SAFE_ACCOUNT: "Safe-account narrative",
      SECRECY: "Secrecy request",
      IMPERSONATION: "Bank impersonation",
      UNUSUAL_TIME: "Unusual transaction time"
    };

    return (
      <div style={{ display: "grid", gap: 16 }}>
        <div className="disclaimer">
          <span>📊</span>
          <span><strong>Simulated demo data.</strong> All numbers below are illustrative and do not reflect real transactions.</span>
        </div>

        <div className="stat-grid">
          {[
            { label: "Transactions screened", value: a.screened.toLocaleString(), sub: "Total analysed" },
            { label: "Suspicious transactions", value: a.suspicious, sub: "Risk ≥ MEDIUM" },
            { label: "High-risk transactions", value: a.highRisk, sub: "Risk ≥ HIGH" },
            { label: "Payments paused", value: a.paused, sub: "Safety holds activated" },
            { label: "Customers protected", value: a.protected, sub: "Interventions made" },
            { label: "Avg. intervention time", value: `${(a.avgInterventionMs / 1000).toFixed(1)}s`, sub: "From initiation to warning" }
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div className="stat-label">{s.label}</div>
              <div className="stat-value">{s.value}</div>
              <div className="stat-sub">{s.sub}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="card">
            <div className="card-header"><div className="card-title">Risk level distribution</div></div>
            <div className="card-body" style={{ display: "grid", gap: 10 }}>
              {[
                { key: "LOW", color: "var(--green)", label: "Low" },
                { key: "MEDIUM", color: "var(--amber)", label: "Medium" },
                { key: "HIGH", color: "var(--orange)", label: "High" },
                { key: "CRITICAL", color: "var(--red)", label: "Critical" }
              ].map(({ key, color, label }) => {
                const val = a.byRiskLevel[key] || 0;
                const pct = Math.round((val / total) * 100);
                return (
                  <div key={key} className="chart-row">
                    <span className="chart-label">{label}</span>
                    <div className="chart-bar-wrap">
                      <div className="chart-bar-fill" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <span className="chart-val">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div className="card-header"><div className="card-title">Payment channel breakdown</div></div>
            <div className="card-body" style={{ display: "grid", gap: 10 }}>
              {Object.entries(a.byChannel).map(([ch, pct]) => (
                <div key={ch} className="chart-row">
                  <span className="chart-label">{ch === "MOBILE_MONEY" ? "Mobile Money" : "Bank Transfer"}</span>
                  <div className="chart-bar-wrap">
                    <div className="chart-bar-fill" style={{ width: `${pct}%`, background: ch === "MOBILE_MONEY" ? "var(--green)" : "var(--brand)" }} />
                  </div>
                  <span className="chart-val">{pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">Most frequent scam indicators detected</div></div>
          <div className="card-body" style={{ display: "grid", gap: 10 }}>
            {signalEntries.map(([key, count]) => (
              <div key={key} className="chart-row">
                <span className="chart-label">{signalLabels[key] || key}</span>
                <div className="chart-bar-wrap">
                  <div className="chart-bar-fill" style={{ width: `${Math.round((count / maxSig) * 100)}%`, background: "var(--orange)" }} />
                </div>
                <span className="chart-val">{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderSettings = () => {
    const contact = customer?.trustedContacts?.[0];
    return (
      <div style={{ maxWidth: 560, display: "grid", gap: 16 }}>
        <div className="card">
          <div className="card-header">
            <div className="card-title">Safety contact</div>
          </div>
          <div className="card-body" style={{ display: "grid", gap: 14 }}>
            <div style={{ padding: "14px", background: "var(--surface2)", borderRadius: 10, border: "1px solid var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{contact?.name || "Martha Namusoke"}</div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{contact?.relationship || "Daughter"} · {contact?.phone || "+256 7XX XXX XXX"}</div>
                </div>
                <span className="badge badge-green">✓ Enabled</span>
              </div>
            </div>

            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.7, padding: "12px", background: "var(--brand-lt)", borderRadius: 10, border: "1px solid #bfdbfe" }}>
              <strong style={{ color: "var(--brand)" }}>Permission:</strong> ClarityPay will only notify this person when <em>you</em> request help with a high-risk payment. The notification does not include your full account details or transaction history.
            </div>

            <div className="disclaimer">
              <span>🔒</span>
              <span>In this prototype, all notifications are simulated. No real SMS or calls are made.</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">Trusted beneficiaries</div></div>
          <div className="card-body">
            {(customer?.beneficiaries || []).filter(b => b.trusted).map(b => (
              <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{b.name}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>{b.accountOrPhone} · {b.channel === "MOBILE_MONEY" ? "Mobile Money" : "Bank"}</div>
                </div>
                <span className="badge badge-green">Trusted</span>
              </div>
            ))}
          </div>
        </div>

        <div className="disclaimer">
          <span>⚠️</span>
          <span>This is prototype/simulated data. No real contacts or payment details are stored.</span>
        </div>
      </div>
    );
  };

  // ── Screen titles ──────────────────────────────────────────────
  const titles: Record<Screen, { title: string; sub: string }> = {
    dashboard:  { title: "Dashboard", sub: "Sarah Namusoke — Simulated account" },
    send:       { title: "Send Money", sub: "Bank transfer or Mobile Money" },
    simulation: { title: "Scam Simulation", sub: "Simulated demo — not a real call" },
    audit:      { title: "Audit Trail", sub: "ClarityPay event log" },
    analytics:  { title: "Analytics", sub: "Simulated demo data" },
    settings:   { title: "Settings", sub: "Safety contacts & trusted beneficiaries" }
  };

  const navItems: { key: Screen; icon: string; label: string }[] = [
    { key: "dashboard",  icon: "🏠", label: "Dashboard" },
    { key: "send",       icon: "💸", label: "Send Money" },
    { key: "simulation", icon: "🎯", label: "Scam Simulation" },
    { key: "audit",      icon: "📋", label: "Audit Trail" },
    { key: "analytics",  icon: "📊", label: "Analytics" },
    { key: "settings",   icon: "⚙️", label: "Settings" }
  ];

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-mark">CP</div>
          <span className="logo-name">ClarityPay</span>
          <span className="logo-tagline">A moment of clarity before you send.</span>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section">Main</div>
          {navItems.map(item => (
            <button
              key={item.key}
              className={`nav-item ${screen === item.key ? "active" : ""}`}
              onClick={() => {
                if (item.key === "simulation") {
                  startSimulation();
                } else {
                  setScreen(item.key);
                  if (item.key === "send") setSendStep("form");
                }
              }}
            >
              <span className="icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Prototype disclaimer</div>
          ClarityPay uses simulated data only. Not connected to real financial accounts or payment networks.
        </div>
      </aside>

      {/* Main */}
      <div className="main-content">
        <header className="topbar">
          <div>
            <div className="topbar-title">{titles[screen].title}</div>
            <div className="topbar-sub">{titles[screen].sub}</div>
          </div>
          <div className="topbar-actions">
            {risk.riskScore > 0 && (
              <span className={riskBadgeClass(risk.riskLevel)} style={{ fontSize: 12 }}>
                Risk: {risk.riskScore}/100
              </span>
            )}
            <button
              className="btn btn-primary btn-sm"
              onClick={() => { setSendStep("form"); setScreen("send"); }}
            >
              💸 Send Money
            </button>
            <button className="btn btn-sm" style={{ border: "1px solid #fde68a", color: "#92400e", background: "#fffbeb" }} onClick={startSimulation}>
              🎯 Run Simulation
            </button>
          </div>
        </header>

        <main className="page-body">
          {screen === "dashboard"  && renderDashboard()}
          {screen === "send"       && renderSend()}
          {screen === "simulation" && renderSimulation()}
          {screen === "audit"      && renderAudit()}
          {screen === "analytics"  && renderAnalytics()}
          {screen === "settings"   && renderSettings()}
        </main>
      </div>
    </div>
  );
}
