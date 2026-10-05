require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
const {
  analyzeTranscript,
  analyzeTransaction,
  combineRisk,
  optionalAIAnalysis
} = require("./riskEngine");

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT || 4000);

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000"
}));
app.use(express.json());

// ─── SSE broadcast ────────────────────────────────────────────────
const clients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
}

// ─── Audit helper ─────────────────────────────────────────────────
async function audit(eventType, description, transactionId = null, metadata = {}) {
  const item = await prisma.auditEvent.create({
    data: {
      eventType,
      description,
      transactionId: transactionId || null,
      metadata: JSON.stringify(metadata)
    }
  });
  broadcast({ type: "audit", event: item });
  return item;
}

// ─── Seed demo data ───────────────────────────────────────────────
async function seed() {
  const count = await prisma.customer.count();
  if (count > 0) return;

  const customer = await prisma.customer.create({
    data: {
      name: "Sarah Namusoke",
      phone: "+256 772 456789",
      age: 57,
      balance: 12800000,
      typicalTransferMin: 20000,
      typicalTransferMax: 500000,
      riskProfile: "STANDARD"
    }
  });

  // Trusted beneficiaries
  const martha = await prisma.beneficiary.create({
    data: {
      customerId: customer.id,
      name: "Martha Namusoke",
      accountOrPhone: "+256 700 123456",
      channel: "MOBILE_MONEY",
      trusted: true,
      firstUsedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 90)
    }
  });

  const david = await prisma.beneficiary.create({
    data: {
      customerId: customer.id,
      name: "David Kato",
      accountOrPhone: "+256 780 123456",
      channel: "MOBILE_MONEY",
      trusted: true,
      firstUsedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60)
    }
  });

  const grace = await prisma.beneficiary.create({
    data: {
      customerId: customer.id,
      name: "Grace Traders",
      accountOrPhone: "0102200078",
      channel: "BANK",
      trusted: true,
      firstUsedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 45)
    }
  });

  // Trusted contact
  await prisma.trustedContact.create({
    data: {
      customerId: customer.id,
      name: "Martha Namusoke",
      relationship: "Daughter",
      phone: "+256 700 123456",
      enabled: true
    }
  });

  // Seed normal historical transactions
  const normalTxs = [
    { amount: 100000, recipientName: "Martha Namusoke", recipientRef: "+256 700 123456", channel: "MOBILE_MONEY", paymentReason: "FAMILY", beneficiaryId: martha.id, daysAgo: 0, riskScore: 5, riskLevel: "LOW", status: "COMPLETED" },
    { amount: 250000, recipientName: "Grace Traders",   recipientRef: "0102200078",      channel: "BANK",         paymentReason: "BUSINESS", beneficiaryId: grace.id, daysAgo: 0, riskScore: 5, riskLevel: "LOW", status: "COMPLETED" },
    { amount: 80000,  recipientName: "David Kato",      recipientRef: "+256 780 123456", channel: "MOBILE_MONEY", paymentReason: "FAMILY",   beneficiaryId: david.id, daysAgo: 1, riskScore: 5, riskLevel: "LOW", status: "COMPLETED" },
    { amount: 50000,  recipientName: "Martha Namusoke", recipientRef: "+256 700 123456", channel: "MOBILE_MONEY", paymentReason: "FAMILY",   beneficiaryId: martha.id, daysAgo: 3, riskScore: 5, riskLevel: "LOW", status: "COMPLETED" },
    { amount: 500000, recipientName: "Grace Traders",   recipientRef: "0102200078",      channel: "BANK",         paymentReason: "BUSINESS", beneficiaryId: grace.id, daysAgo: 5, riskScore: 8, riskLevel: "LOW", status: "COMPLETED" },
    { amount: 150000, recipientName: "David Kato",      recipientRef: "+256 780 123456", channel: "MOBILE_MONEY", paymentReason: "FAMILY",   beneficiaryId: david.id, daysAgo: 7, riskScore: 5, riskLevel: "LOW", status: "COMPLETED" },
    { amount: 20000,  recipientName: "Martha Namusoke", recipientRef: "+256 700 123456", channel: "MOBILE_MONEY", paymentReason: "FAMILY",   beneficiaryId: martha.id, daysAgo: 9, riskScore: 5, riskLevel: "LOW", status: "COMPLETED" }
  ];

  for (const tx of normalTxs) {
    const txDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * tx.daysAgo);
    // Normal business hours
    txDate.setHours(10, 30, 0, 0);
    await prisma.transaction.create({
      data: {
        customerId: customer.id,
        beneficiaryId: tx.beneficiaryId,
        amount: tx.amount,
        currency: "UGX",
        channel: tx.channel,
        recipientName: tx.recipientName,
        recipientRef: tx.recipientRef,
        paymentReason: tx.paymentReason,
        deviceId: "device-primary",
        riskScore: tx.riskScore,
        riskLevel: tx.riskLevel,
        status: tx.status,
        createdAt: txDate
      }
    });
  }

  await audit("SYSTEM_INIT", "ClarityPay demo data seeded. Customer: Sarah Namusoke.", null, { customer: customer.name });
  console.log("✓ Demo data seeded for Sarah Namusoke");
}

// ─── Health ───────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "ClarityPay Uganda API", time: new Date().toISOString() });
});

// ─── Customer ─────────────────────────────────────────────────────
app.get("/api/customer", async (req, res) => {
  const customer = await prisma.customer.findFirst({
    include: {
      transactions: { orderBy: { createdAt: "desc" }, take: 20 },
      beneficiaries: true,
      trustedContacts: true
    }
  });
  res.json(customer);
});

// ─── Beneficiaries ────────────────────────────────────────────────
app.get("/api/beneficiaries", async (req, res) => {
  const customer = await prisma.customer.findFirst();
  if (!customer) return res.json([]);
  const beneficiaries = await prisma.beneficiary.findMany({
    where: { customerId: customer.id }
  });
  res.json(beneficiaries);
});

// ─── Audit log ────────────────────────────────────────────────────
app.get("/api/audit", async (req, res) => {
  const events = await prisma.auditEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 50
  });
  res.json(events);
});

// ─── Alerts ───────────────────────────────────────────────────────
app.get("/api/alerts", async (req, res) => {
  const alerts = await prisma.alert.findMany({
    orderBy: { createdAt: "desc" },
    take: 30
  });
  res.json(alerts);
});

// ─── SSE stream ───────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

// ─── Analyse transcript + transaction ────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { transcript = "", transaction } = req.body;
  const customer = await prisma.customer.findFirst();

  const transcriptResult = analyzeTranscript(transcript);
  const transactionResult = analyzeTransaction(transaction, customer);
  const ai = await optionalAIAnalysis(transcript, transaction, customer);

  const combined = combineRisk({
    communicationScore: transcriptResult.communicationScore,
    transactionScore: transactionResult.transactionScore,
    aiScore: ai.score
  });

  const allSignals = [
    ...transcriptResult.signals,
    ...transactionResult.signals,
    ...ai.signals.map(s => ({ type: "AI", category: "AI", label: s, score: 0 }))
  ];

  const result = {
    ...combined,
    signals: allSignals,
    communicationScore: transcriptResult.communicationScore,
    transactionScore: transactionResult.transactionScore,
    source: ai.source
  };

  broadcast({ type: "risk", result });
  res.json(result);
});

// ─── Scam simulation ─────────────────────────────────────────────
app.post("/api/simulate-transcript", async (req, res) => {
  const customer = await prisma.customer.findFirst();

  const lines = [
    "Hello madam, I'm calling from the bank's fraud department.",
    "We've detected suspicious activity on your account.",
    "Your money isn't safe in your account right now.",
    "We need you to move the money to a secure account immediately.",
    "Please don't tell anyone because this is confidential.",
    "You need to do this right now — it's very urgent.",
    "I'm going to stay on the phone and guide you through this.",
    "Send UGX 4,500,000 to this number to secure your funds."
  ];

  let transcript = "";

  for (let i = 0; i < lines.length; i++) {
    transcript += (i ? " " : "") + lines[i];

    const demoTx = {
      amount: 4500000,
      recipientName: "Unknown",
      recipientRef: "+256 7XX XXX XXX",
      channel: "MOBILE_MONEY",
      isNewRecipient: true,
      deviceId: "new-device-unknown",
      createdAt: new Date()
    };

    const transcriptResult = analyzeTranscript(transcript);
    const transactionResult = analyzeTransaction(demoTx, customer);
    const combined = combineRisk({
      communicationScore: transcriptResult.communicationScore,
      transactionScore: transactionResult.transactionScore
    });

    broadcast({
      type: "transcript",
      line: lines[i],
      lineIndex: i,
      transcript,
      result: {
        ...combined,
        signals: [...transcriptResult.signals, ...transactionResult.signals],
        communicationScore: transcriptResult.communicationScore,
        transactionScore: transactionResult.transactionScore
      }
    });

    await new Promise(resolve => setTimeout(resolve, 1100));
  }

  await audit("SIMULATION", "Scam-call simulation completed.", null, {
    customer: customer?.name,
    scenario: "Safe-account vishing scam"
  });

  res.json({ ok: true });
});

// ─── Create transaction ───────────────────────────────────────────
app.post("/api/transactions", async (req, res) => {
  const {
    amount,
    channel,
    recipientName,
    recipientRef,
    paymentReason = "OTHER",
    deviceId = "device-primary",
    transcript = ""
  } = req.body;

  const customer = await prisma.customer.findFirst({
    include: { beneficiaries: true }
  });

  if (!customer) return res.status(500).json({ error: "Customer profile not found" });

  const numAmount = Number(amount);

  // Check if beneficiary is known
  const existingBeneficiary = customer.beneficiaries.find(
    b => b.accountOrPhone === recipientRef || b.name.toLowerCase() === recipientName?.toLowerCase()
  );

  const transaction = {
    amount: numAmount,
    channel,
    recipientName,
    recipientRef,
    deviceId,
    createdAt: new Date()
  };

  const transcriptResult = analyzeTranscript(transcript);
  const transactionResult = analyzeTransaction(transaction, customer, existingBeneficiary);

  // Boost communication score if transcript has signals and transaction is also suspicious
  const combined = combineRisk({
    communicationScore: transcriptResult.communicationScore,
    transactionScore: transactionResult.transactionScore
  });

  // Merge and deduplicate signals
  const allSignals = [...transcriptResult.signals, ...transactionResult.signals];

  // Determine status
  let status = "PENDING";
  if (combined.riskScore >= 75) status = "INTERCEPTED";
  else if (combined.riskScore >= 50) status = "FLAGGED";

  const created = await prisma.transaction.create({
    data: {
      customerId: customer.id,
      beneficiaryId: existingBeneficiary?.id || null,
      amount: numAmount,
      currency: "UGX",
      channel,
      recipientName: recipientName || "Unknown",
      recipientRef: recipientRef || "",
      paymentReason,
      deviceId,
      riskScore: combined.riskScore,
      riskLevel: combined.riskLevel,
      status
    }
  });

  // Persist risk signals
  for (const sig of allSignals) {
    await prisma.riskSignal.create({
      data: {
        transactionId: created.id,
        category: sig.category,
        type: sig.type,
        score: sig.score,
        reason: sig.label
      }
    });
  }

  // Audit
  await audit(
    status === "PENDING" ? "TRANSACTION_CREATED" : "TRANSACTION_INTERCEPTED",
    status === "PENDING"
      ? `Transfer of UGX ${numAmount.toLocaleString()} created.`
      : `Suspicious transfer of UGX ${numAmount.toLocaleString()} intercepted before confirmation.`,
    created.id,
    { riskScore: combined.riskScore, riskLevel: combined.riskLevel }
  );

  broadcast({
    type: "risk",
    result: {
      ...combined,
      signals: allSignals,
      communicationScore: transcriptResult.communicationScore,
      transactionScore: transactionResult.transactionScore
    }
  });

  res.json({
    transaction: created,
    risk: {
      ...combined,
      signals: allSignals,
      communicationScore: transcriptResult.communicationScore,
      transactionScore: transactionResult.transactionScore
    }
  });
});

// ─── Pause / safety hold ──────────────────────────────────────────
app.post("/api/transactions/:id/hold", async (req, res) => {
  const transaction = await prisma.transaction.update({
    where: { id: req.params.id },
    data: { status: "PAUSED" },
    include: { customer: { include: { trustedContacts: true } } }
  });

  const trustedContact = transaction.customer.trustedContacts.find(tc => tc.enabled);

  // Simulated trusted-contact alert
  const alert = await prisma.alert.create({
    data: {
      customerId: transaction.customerId,
      transactionId: transaction.id,
      type: "TRUSTED_CONTACT",
      message: trustedContact
        ? `Safety alert — ${transaction.customer.name} has requested assistance with a potentially risky payment of UGX ${transaction.amount.toLocaleString()}. Please encourage ${transaction.customer.name} to contact their bank before proceeding.`
        : `Safety alert — ${transaction.customer.name} paused a high-risk transaction.`,
      status: "SIMULATED"
    }
  });

  await audit(
    "SAFETY_HOLD_ACTIVATED",
    `24-hour safety hold activated for UGX ${transaction.amount.toLocaleString()} transfer.`,
    transaction.id,
    { alertId: alert.id, trustedContact: trustedContact?.name || "none" }
  );

  broadcast({ type: "hold", transaction, alert });
  res.json({ transaction, alert });
});

// ─── Release hold ────────────────────────────────────────────────
app.post("/api/transactions/:id/release", async (req, res) => {
  const { reason = "" } = req.body;

  const transaction = await prisma.transaction.update({
    where: { id: req.params.id },
    data: { status: "RELEASED" }
  });

  await audit(
    "TRANSACTION_RELEASED",
    `Customer explicitly confirmed and released the paused transaction.`,
    transaction.id,
    { reason }
  );

  broadcast({ type: "released", transaction });
  res.json(transaction);
});

// ─── Cancel transaction ───────────────────────────────────────────
app.post("/api/transactions/:id/cancel", async (req, res) => {
  const transaction = await prisma.transaction.update({
    where: { id: req.params.id },
    data: { status: "CANCELLED" }
  });

  await audit(
    "TRANSACTION_CANCELLED",
    `Customer cancelled the transaction after safety warning.`,
    transaction.id
  );

  broadcast({ type: "cancelled", transaction });
  res.json(transaction);
});

// ─── Analytics (simulated demo data) ─────────────────────────────
app.get("/api/analytics", async (req, res) => {
  const [txCount, flaggedCount, pausedCount, highRiskCount] = await Promise.all([
    prisma.transaction.count(),
    prisma.transaction.count({ where: { riskLevel: { in: ["HIGH", "CRITICAL"] } } }),
    prisma.transaction.count({ where: { status: "PAUSED" } }),
    prisma.transaction.count({ where: { riskLevel: "CRITICAL" } })
  ]);

  // Mix real DB counts with padded simulated analytics for demo purposes
  res.json({
    simulated: true,
    screened: txCount + 1277,
    suspicious: flaggedCount + 44,
    highRisk: highRiskCount + 15,
    paused: pausedCount + 8,
    protected: pausedCount + 8,
    avgInterventionMs: 3200,
    byChannel: { MOBILE_MONEY: 68, BANK: 32 },
    byRiskLevel: { LOW: 1195, MEDIUM: 58, HIGH: 18, CRITICAL: pausedCount + 8 + highRiskCount },
    signalFrequency: {
      NEW_RECIPIENT: 34,
      LARGE_AMOUNT: 28,
      URGENCY: 22,
      SAFE_ACCOUNT: 17,
      SECRECY: 15,
      IMPERSONATION: 14,
      UNUSUAL_TIME: 11
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────
seed()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`ClarityPay Uganda API running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
