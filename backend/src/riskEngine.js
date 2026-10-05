// ─────────────────────────────────────────────────────────────────
// ClarityPay Risk Engine — Uganda-specific scam detection
// ─────────────────────────────────────────────────────────────────

/**
 * Communication (transcript) signals — social-engineering indicators.
 * These match Ugandan vishing/safe-account scam language.
 */
const COMMUNICATION_SIGNALS = [
  {
    type: "IMPERSONATION",
    pattern: /fraud (department|officer|team)|security (team|officer|department)|calling from.*(bank|stanbic|dfcu|centenary|absa|equity|post bank)/i,
    label: "Caller impersonating a bank employee",
    score: 12,
    category: "COMMUNICATION"
  },
  {
    type: "ISOLATION",
    pattern: /don'?t (tell|inform|contact|call).*(anyone|family|daughter|son|husband|wife|relatives?)|keep.*(confidential|secret|between us)/i,
    label: "Caller requesting secrecy from family",
    score: 20,
    category: "COMMUNICATION"
  },
  {
    type: "URGENCY",
    pattern: /immediately|right now|without delay|urgent(ly)?|as soon as possible|this minute|quickly/i,
    label: "Urgency pressure detected",
    score: 18,
    category: "COMMUNICATION"
  },
  {
    type: "SAFE_ACCOUNT",
    pattern: /safe (account|number)|secure (account|number)|move.*(money|funds|savings)|your (account|money) (isn'?t safe|is at risk|will be lost)/i,
    label: "Safe-account narrative detected",
    score: 18,
    category: "COMMUNICATION"
  },
  {
    type: "STAY_ON_CALL",
    pattern: /stay on the (phone|line|call)|don'?t hang up|I'?ll (guide|walk|help) you|remain on/i,
    label: "Caller insisting to stay on call",
    score: 12,
    category: "COMMUNICATION"
  },
  {
    type: "SECRECY",
    pattern: /don'?t tell|please don'?t mention|confidential|don'?t discuss|keep this private/i,
    label: "Secrecy instruction detected",
    score: 20,
    category: "COMMUNICATION"
  },
  {
    type: "PAYMENT_INSTRUCTION",
    pattern: /send (the )?(money|funds|ugx|shillings)|transfer (the )?(money|funds|amount)|pay (this|that|the) (number|account)/i,
    label: "Direct payment instruction in communication",
    score: 5,
    category: "COMMUNICATION"
  }
];

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Analyse a transcript/communication string for social-engineering signals.
 */
function analyzeTranscript(transcript = "") {
  const signals = [];
  let score = 0;

  for (const item of COMMUNICATION_SIGNALS) {
    if (item.pattern.test(transcript)) {
      score += item.score;
      signals.push({
        type: item.type,
        category: item.category,
        label: item.label,
        score: item.score
      });
    }
  }

  return {
    communicationScore: clamp(score),
    signals
  };
}

/**
 * Analyse a transaction against the customer's behavioural profile.
 */
function analyzeTransaction(transaction, customer, beneficiary = null) {
  const signals = [];
  let score = 0;

  if (!transaction || !customer) {
    return { transactionScore: 0, signals };
  }

  const { amount, channel, deviceId, createdAt } = transaction;
  const maxNormal = customer.typicalTransferMax || 500000;

  // Amount significantly above typical maximum
  if (amount > maxNormal * 5) {
    signals.push({
      type: "LARGE_AMOUNT_CRITICAL",
      category: "TRANSACTION",
      label: "Amount is far above your normal transfers",
      score: 25
    });
    score += 25;
  } else if (amount > maxNormal * 2) {
    signals.push({
      type: "LARGE_AMOUNT",
      category: "TRANSACTION",
      label: "Amount is significantly above your typical transfers",
      score: 15
    });
    score += 15;
  }

  // New / unknown recipient
  if (!beneficiary || !beneficiary.trusted) {
    signals.push({
      type: "NEW_RECIPIENT",
      category: "TRANSACTION",
      label: "This recipient has never received money from you",
      score: 20
    });
    score += 20;
  }

  // Device not recognised (simple heuristic: deviceId contains "new")
  if (deviceId && deviceId.toLowerCase().includes("new")) {
    signals.push({
      type: "NEW_DEVICE",
      category: "DEVICE",
      label: "Transaction initiated from an unrecognised device",
      score: 15
    });
    score += 15;
  }

  // Unusual transaction time (outside 07:00–21:00 EAT)
  const hour = createdAt ? new Date(createdAt).getUTCHours() + 3 : new Date().getUTCHours() + 3; // rough EAT
  if (hour < 7 || hour >= 21) {
    signals.push({
      type: "UNUSUAL_TIME",
      category: "BEHAVIOUR",
      label: "Payment is outside your normal transaction hours (07:00–21:00)",
      score: 10
    });
    score += 10;
  }

  return {
    transactionScore: clamp(score),
    signals
  };
}

function riskLevel(score) {
  if (score >= 75) return "CRITICAL";
  if (score >= 50) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

/**
 * Combine transaction and communication scores.
 * Transaction is weighted at 60%, communication at 40%.
 */
function combineRisk({ transactionScore = 0, communicationScore = 0, aiScore = 0 }) {
  // If AI is available it can slightly nudge the communication weight
  const effectiveCommunication = aiScore > 0
    ? communicationScore * 0.35 + aiScore * 0.05
    : communicationScore * 0.40;

  const score = clamp(transactionScore * 0.60 + effectiveCommunication);
  return { riskScore: score, riskLevel: riskLevel(score) };
}

/**
 * Optional OpenAI analysis — gracefully degrades to rules if key is absent.
 */
async function optionalAIAnalysis(transcript, transaction, customer) {
  if (!process.env.OPENAI_API_KEY) {
    return { score: 0, signals: [], source: "rules-only" };
  }

  try {
    const OpenAI = require("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a financial safety classifier for a Ugandan bank. " +
            "Analyse communication for social-engineering signals common in Uganda: " +
            "safe-account scams, bank impersonation, urgency, secrecy, isolation. " +
            "Return JSON only: {\"score\": number 0-100, \"signals\": string[]}. " +
            "Do NOT decide if a person is truthful. Identify observable coercion, urgency, " +
            "secrecy, isolation, impersonation, or payment pressure. " +
            "Currency is UGX. All amounts are in Ugandan shillings."
        },
        {
          role: "user",
          content: JSON.stringify({ transcript, transaction, customer })
        }
      ]
    });

    const parsed = JSON.parse(response.choices[0].message.content || "{}");
    return {
      score: clamp(Number(parsed.score) || 0),
      signals: (Array.isArray(parsed.signals) ? parsed.signals : []).slice(0, 8),
      source: "openai"
    };
  } catch (err) {
    return { score: 0, signals: [], source: "rules-fallback", error: err.message };
  }
}

module.exports = {
  analyzeTranscript,
  analyzeTransaction,
  combineRisk,
  optionalAIAnalysis,
  riskLevel,
  COMMUNICATION_SIGNALS
};
