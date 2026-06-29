export type MetaComplianceStatus = "safe" | "needs_review" | "blocked";

export type MetaComplianceIssue = {
  code: string;
  severity: "review" | "block";
  message: string;
  match?: string;
};

export type MetaComplianceResult = {
  status: MetaComplianceStatus;
  issues: MetaComplianceIssue[];
  safeText: string;
  disclaimer: string;
};

const disclaimer = "Результаты индивидуальны. Перед процедурой нужна консультация специалиста.";

const rules: Array<{
  code: string;
  severity: "review" | "block";
  pattern: RegExp;
  message: string;
}> = [
  {
    code: "personal_attribute_question",
    severity: "block",
    pattern: /\b(у вас|у тебя|ваши|твой|твоя|страдаете|болеете|есть ли у вас|хотите избавиться)\b/i,
    message: "Текст обращается к личным состояниям пользователя. Для Meta Ads это высокий риск.",
  },
  {
    code: "medical_condition_claim",
    severity: "block",
    pattern: /\b(акне|морщин|пигментац|заболеван|болезн|диагноз|лечение|вылечим|избавиться)\b/i,
    message: "Есть прямое утверждение о медицинском или эстетическом состоянии.",
  },
  {
    code: "guarantee",
    severity: "block",
    pattern: /\b(гарантируем|навсегда|100%|без риска|точный результат|результат гарантирован)\b/i,
    message: "Нельзя обещать гарантированный результат или отсутствие риска.",
  },
  {
    code: "before_after",
    severity: "block",
    pattern: /\b(до\/после|до и после|before\/after|результат до после)\b/i,
    message: "Формулировка похожа на before/after claim.",
  },
  {
    code: "aggressive_claim",
    severity: "review",
    pattern: /\b(срочно|только сегодня|последний шанс|успейте|лучший|самый эффективный)\b/i,
    message: "Агрессивное обещание или давление лучше смягчить перед запуском.",
  },
  {
    code: "missing_disclaimer",
    severity: "review",
    pattern: /^((?!консультац|индивидуальн|специалист).)*$/i,
    message: "Добавьте нейтральный дисклеймер о консультации специалиста.",
  },
];

function uniqueIssues(issues: MetaComplianceIssue[]) {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.code)) return false;
    seen.add(issue.code);
    return true;
  });
}

function rewriteText(text: string): string {
  const normalized = text
    .replace(/\bУ вас\b/gi, "Для клиентов")
    .replace(/\bу вас\b/gi, "для клиентов")
    .replace(/\bХотите избавиться от\b/gi, "Доступна консультация по вопросам")
    .replace(/\bхотите избавиться от\b/gi, "доступна консультация по вопросам")
    .replace(/\bизбавиться от\b/gi, "получить консультацию по вопросам")
    .replace(/\bгарантируем\b/gi, "помогаем подобрать")
    .replace(/\bнавсегда\b/gi, "")
    .replace(/\b100%\b/g, "")
    .replace(/\bбез риска\b/gi, "после консультации")
    .replace(/\bлечение\b/gi, "консультация")
    .replace(/\bвылечим\b/gi, "проведем консультацию")
    .replace(/\bдо\/после\b/gi, "индивидуальный план")
    .replace(/\s{2,}/g, " ")
    .trim();

  const safe = normalized || "Консультация специалиста в клинике. Подберем индивидуальный план после диагностики.";
  return safe.toLowerCase().includes("консультац") || safe.toLowerCase().includes("индивидуальн")
    ? `${safe}\n\n${disclaimer}`
    : `${safe}\n\nЗапишитесь на консультацию. ${disclaimer}`;
}

export function checkMetaCompliance(input: { text?: string; headline?: string; description?: string }): MetaComplianceResult {
  const text = [input.headline, input.text, input.description].filter(Boolean).join("\n").trim();
  const issues = uniqueIssues(
    rules.flatMap((rule) => {
      const match = text.match(rule.pattern);
      return match
        ? [
            {
              code: rule.code,
              severity: rule.severity,
              message: rule.message,
              match: match[0],
            },
          ]
        : [];
    }),
  );
  const hasBlocked = issues.some((issue) => issue.severity === "block");
  const hasReview = issues.some((issue) => issue.severity === "review");

  return {
    status: hasBlocked ? "blocked" : hasReview ? "needs_review" : "safe",
    issues,
    safeText: rewriteText(text),
    disclaimer,
  };
}
