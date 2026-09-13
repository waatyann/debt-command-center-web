"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "@/lib/supabase";

type Tab = "home" | "debts" | "payments" | "plan" | "more";
type MoreView = "menu" | "budget" | "bills" | "report" | "goals" | "cloud" | "backup";

type Debt = {
  id: string;
  name: string;
  balance: number;
  initialBalance?: number;
  createdAt?: string;
  annualRate: number;
  minimumPayment: number;
  paymentDay: number;
};

type Payment = {
  id: string;
  debtId: string;
  debtName: string;
  date: string;
  amount: number;
  interest: number;
  principal: number;
  balanceAfter: number;
};

type Budget = {
  salary: number;
  sideIncome: number;
  otherIncome: number;
  rent: number;
  utilities: number;
  communication: number;
  food: number;
  insurance: number;
  transport: number;
  card: number;
  entertainment: number;
  otherExpense: number;
};

type Bill = {
  id: string;
  name: string;
  amount: number;
  day: number;
  category: string;
  paidMonth: string;
};

type AppSettings = {
  monthlyTarget: number;
  pinEnabled: boolean;
  pin: string;
};

type BackupData = {
  version: 3;
  exportedAt: string;
  debts: Debt[];
  payments: Payment[];
  budget: Budget;
  bills: Bill[];
  settings?: AppSettings;
};

const KEYS = {
  debts: "dcc_mobile_debts_v3",
  payments: "dcc_mobile_payments_v3",
  budget: "dcc_mobile_budget_v3",
  bills: "dcc_mobile_bills_v3",
  settings: "dcc_mobile_settings_v5",
};

const initialSettings: AppSettings = {
  monthlyTarget: 0,
  pinEnabled: false,
  pin: "",
};

const initialBudget: Budget = {
  salary: 0,
  sideIncome: 0,
  otherIncome: 0,
  rent: 0,
  utilities: 0,
  communication: 0,
  food: 0,
  insurance: 0,
  transport: 0,
  card: 0,
  entertainment: 0,
  otherExpense: 0,
};

const yen = (value: number) =>
  `${new Intl.NumberFormat("ja-JP").format(Math.max(0, Math.round(value)))}円`;

const numberValue = (value: string) =>
  Math.max(0, Number(value.replace(/,/g, "")) || 0);

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const localDateString = (date = new Date()) => {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
};

const currentMonthKey = () => localDateString().slice(0, 7);

const scopedStorageKey = (base: string, userId: string | null) => `${base}:${userId ?? "guest"}`;

function estimateMonthlyInterest(balance: number, annualRate: number) {
  return Math.max(0, Math.round(balance * (annualRate / 100) / 12));
}

function estimateMonths(balance: number, annualRate: number, payment: number) {
  if (balance <= 0) return 0;
  const monthlyRate = annualRate / 100 / 12;
  if (payment <= balance * monthlyRate) return Infinity;
  if (monthlyRate === 0) return Math.ceil(balance / payment);
  return Math.ceil(
    -Math.log(1 - (monthlyRate * balance) / payment) /
      Math.log(1 + monthlyRate)
  );
}

function payoffLabel(months: number) {
  if (!Number.isFinite(months)) return "返済額不足";
  if (months <= 0) return "完済";
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function daysUntilPayment(day: number) {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (target < today) target.setMonth(target.getMonth() + 1);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

function simulatePortfolio(
  source: Debt[],
  extraPayment: number,
  strategy: "avalanche" | "snowball"
) {
  let debts = source
    .filter((d) => d.balance > 0)
    .map((d) => ({ ...d, originalId: d.id }));
  let months = 0;
  let totalInterest = 0;
  const maxMonths = 1200;

  while (debts.some((d) => d.balance > 0.5) && months < maxMonths) {
    months += 1;
    let freedMinimum = 0;

    for (const debt of debts) {
      if (debt.balance <= 0.5) continue;
      const interest = debt.balance * (debt.annualRate / 100 / 12);
      totalInterest += interest;
      debt.balance += interest;
    }

    for (const debt of debts) {
      if (debt.balance <= 0.5) continue;
      const payment = Math.min(debt.minimumPayment, debt.balance);
      debt.balance -= payment;
      if (debt.balance <= 0.5) {
        freedMinimum += debt.minimumPayment;
        debt.balance = 0;
      }
    }

    let pool = extraPayment + freedMinimum;
    while (pool > 0.01) {
      const active = debts.filter((d) => d.balance > 0.5);
      if (!active.length) break;
      active.sort((a, b) =>
        strategy === "avalanche"
          ? b.annualRate - a.annualRate || a.balance - b.balance
          : a.balance - b.balance || b.annualRate - a.annualRate
      );
      const target = active[0];
      const applied = Math.min(pool, target.balance);
      target.balance -= applied;
      pool -= applied;
    }
  }

  return {
    months: months >= maxMonths ? Infinity : months,
    interest: Math.round(totalInterest),
  };
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("home");
  const [moreView, setMoreView] = useState<MoreView>("menu");
  const [debts, setDebts] = useState<Debt[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [budget, setBudget] = useState<Budget>(initialBudget);
  const [bills, setBills] = useState<Bill[]>([]);
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [locked, setLocked] = useState(false);
  const [unlockPin, setUnlockPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [purchaseAmount, setPurchaseAmount] = useState("3000");
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!supabaseConfigured);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConsent, setAuthConsent] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudMessage, setCloudMessage] = useState("未同期");
  const [lastCloudSync, setLastCloudSync] = useState("");
  const [scopeReady, setScopeReady] = useState(false);
  const [ready, setReady] = useState(false);

  const [debtModal, setDebtModal] = useState(false);
  const [paymentModal, setPaymentModal] = useState(false);
  const [billModal, setBillModal] = useState(false);
  const [editingDebtId, setEditingDebtId] = useState<string | null>(null);
  const [editingBillId, setEditingBillId] = useState<string | null>(null);

  const [debtForm, setDebtForm] = useState({
    name: "",
    balance: "",
    annualRate: "",
    minimumPayment: "",
    paymentDay: "",
  });
  const [paymentForm, setPaymentForm] = useState({
    debtId: "",
    date: localDateString(),
    amount: "",
    actualInterest: "",
  });
  const [billForm, setBillForm] = useState({
    name: "",
    amount: "",
    day: "",
    category: "固定費",
  });

  const [extraPayment, setExtraPayment] = useState("5000");
  const [strategy, setStrategy] = useState<"avalanche" | "snowball">("avalanche");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready || !authReady || !scopeReady) return;
    localStorage.setItem(scopedStorageKey(KEYS.debts, user?.id ?? null), JSON.stringify(debts));
  }, [debts, ready, authReady, scopeReady, user?.id]);
  useEffect(() => {
    if (!ready || !authReady || !scopeReady) return;
    localStorage.setItem(scopedStorageKey(KEYS.payments, user?.id ?? null), JSON.stringify(payments));
  }, [payments, ready, authReady, scopeReady, user?.id]);
  useEffect(() => {
    if (!ready || !authReady || !scopeReady) return;
    localStorage.setItem(scopedStorageKey(KEYS.budget, user?.id ?? null), JSON.stringify(budget));
  }, [budget, ready, authReady, scopeReady, user?.id]);
  useEffect(() => {
    if (!ready || !authReady || !scopeReady) return;
    localStorage.setItem(scopedStorageKey(KEYS.bills, user?.id ?? null), JSON.stringify(bills));
  }, [bills, ready, authReady, scopeReady, user?.id]);
  useEffect(() => {
    if (!ready || !authReady || !scopeReady) return;
    localStorage.setItem(scopedStorageKey(KEYS.settings, user?.id ?? null), JSON.stringify(settings));
  }, [settings, ready, authReady, scopeReady, user?.id]);

  useEffect(() => {
    if (!supabaseConfigured || !supabase) {
      setAuthReady(true);
      return;
    }

    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setUser(data.user ?? null);
      setAuthReady(true);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthReady(true);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!ready || !authReady) return;

    setScopeReady(false);
    const uid = user?.id ?? null;

    const read = <T,>(base: string, fallback: T): T => {
      try {
        const raw = localStorage.getItem(scopedStorageKey(base, uid));
        return raw ? (JSON.parse(raw) as T) : fallback;
      } catch {
        return fallback;
      }
    };

    const scopedDebts = read<Debt[]>(KEYS.debts, []);
    const scopedPayments = read<Payment[]>(KEYS.payments, []);
    const scopedBudget = read<Budget>(KEYS.budget, initialBudget);
    const scopedBills = read<Bill[]>(KEYS.bills, []);
    const scopedSettings = read<AppSettings>(KEYS.settings, initialSettings);

    setDebts(scopedDebts);
    setPayments(scopedPayments);
    setBudget({ ...initialBudget, ...scopedBudget });
    setBills(scopedBills);
    setSettings({ ...initialSettings, ...scopedSettings });
    setLocked(Boolean(scopedSettings.pinEnabled && scopedSettings.pin));
    setLastCloudSync("");
    setCloudMessage(uid ? "このアカウントの端末データを読み込みました。" : "ゲストモード");
    setScopeReady(true);
  }, [user?.id, authReady, ready]);

  const monthKey = currentMonthKey();
  const monthPayments = useMemo(
    () => payments.filter((p) => p.date.startsWith(monthKey)),
    [payments, monthKey]
  );

  const totalBalance = debts.reduce((sum, debt) => sum + debt.balance, 0);
  const totalMinimum = debts.reduce(
    (sum, debt) => sum + debt.minimumPayment,
    0
  );
  const estimatedInterest = debts.reduce(
    (sum, debt) =>
      sum + estimateMonthlyInterest(debt.balance, debt.annualRate),
    0
  );
  const paidThisMonth = monthPayments.reduce(
    (sum, payment) => sum + payment.amount,
    0
  );
  const principalThisMonth = monthPayments.reduce(
    (sum, payment) => sum + payment.principal,
    0
  );
  const interestThisMonth = monthPayments.reduce(
    (sum, payment) => sum + payment.interest,
    0
  );
  const principalRate = paidThisMonth
    ? Math.round((principalThisMonth / paidThisMonth) * 100)
    : 0;

  const incomeTotal =
    budget.salary + budget.sideIncome + budget.otherIncome;
  const expenseTotal =
    budget.rent +
    budget.utilities +
    budget.communication +
    budget.food +
    budget.insurance +
    budget.transport +
    budget.card +
    budget.entertainment +
    budget.otherExpense +
    totalMinimum;
  const budgetRemaining = incomeTotal - expenseTotal;

  const highestPriority = useMemo(() => {
    if (!debts.length) return null;
    return [...debts].sort(
      (a, b) => b.annualRate - a.annualRate || a.balance - b.balance
    )[0];
  }, [debts]);

  const nextDebtPayment = useMemo(() => {
    if (!debts.length) return null;
    return [...debts]
      .map((debt) => ({ debt, days: daysUntilPayment(debt.paymentDay) }))
      .sort((a, b) => a.days - b.days)[0];
  }, [debts]);

  const unpaidBills = bills.filter((bill) => bill.paidMonth !== monthKey);
  const unpaidBillsTotal = unpaidBills.reduce(
    (sum, bill) => sum + bill.amount,
    0
  );
  const nextBill = [...unpaidBills]
    .map((bill) => ({ bill, days: daysUntilPayment(bill.day) }))
    .sort((a, b) => a.days - b.days)[0];

  const normalSimulation = useMemo(
    () => simulatePortfolio(debts, 0, strategy),
    [debts, strategy]
  );
  const extra = numberValue(extraPayment);
  const extraSimulation = useMemo(
    () => simulatePortfolio(debts, extra, strategy),
    [debts, extra, strategy]
  );
  const reducedMonths =
    Number.isFinite(normalSimulation.months) &&
    Number.isFinite(extraSimulation.months)
      ? Math.max(0, normalSimulation.months - extraSimulation.months)
      : 0;
  const savedInterest = Math.max(
    0,
    normalSimulation.interest - extraSimulation.interest
  );

  const monthlyTarget = settings.monthlyTarget;
  const targetProgress = monthlyTarget > 0
    ? Math.min(100, Math.round((paidThisMonth / monthlyTarget) * 100))
    : 0;

  const purchase = numberValue(purchaseAmount);
  const purchaseSimulation = useMemo(
    () => simulatePortfolio(debts, purchase, "avalanche"),
    [debts, purchase]
  );
  const purchaseReducedMonths =
    Number.isFinite(normalSimulation.months) &&
    Number.isFinite(purchaseSimulation.months)
      ? Math.max(0, normalSimulation.months - purchaseSimulation.months)
      : 0;
  const purchaseSavedInterest = Math.max(
    0,
    normalSimulation.interest - purchaseSimulation.interest
  );

  const urgentItems = [
    ...(nextDebtPayment && nextDebtPayment.days <= 3
      ? [`${nextDebtPayment.debt.name}の返済まで${nextDebtPayment.days}日`]
      : []),
    ...(nextBill && nextBill.days <= 3
      ? [`${nextBill.bill.name}の支払いまで${nextBill.days}日`]
      : []),
  ];

  const historyMonths = useMemo(() => {
    const items: { key: string; label: string; principal: number; interest: number }[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      const records = payments.filter((p) => p.date.startsWith(key));
      items.push({
        key,
        label: `${date.getMonth() + 1}月`,
        principal: records.reduce((sum, p) => sum + p.principal, 0),
        interest: records.reduce((sum, p) => sum + p.interest, 0),
      });
    }
    return items;
  }, [payments]);

  const chartMax = Math.max(
    1,
    ...historyMonths.map((item) => item.principal + item.interest)
  );

  function openNewDebt() {
    if (debts.length >= 10) {
      alert("借入先は最大10件までです。");
      return;
    }
    setEditingDebtId(null);
    setDebtForm({
      name: "",
      balance: "",
      annualRate: "",
      minimumPayment: "",
      paymentDay: "",
    });
    setDebtModal(true);
  }

  function openEditDebt(debt: Debt) {
    setEditingDebtId(debt.id);
    setDebtForm({
      name: debt.name,
      balance: String(debt.balance),
      annualRate: String(debt.annualRate),
      minimumPayment: String(debt.minimumPayment),
      paymentDay: String(debt.paymentDay),
    });
    setDebtModal(true);
  }

  function saveDebt(event: FormEvent) {
    event.preventDefault();
    const previousDebt = debts.find((item) => item.id === editingDebtId);
    const enteredBalance = numberValue(debtForm.balance);
    const debt: Debt = {
      id: editingDebtId ?? uid(),
      name: debtForm.name.trim(),
      balance: enteredBalance,
      initialBalance: previousDebt?.initialBalance ?? enteredBalance,
      createdAt: previousDebt?.createdAt ?? localDateString(),
      annualRate: numberValue(debtForm.annualRate),
      minimumPayment: numberValue(debtForm.minimumPayment),
      paymentDay: Math.round(numberValue(debtForm.paymentDay)),
    };

    if (!debt.name || debt.minimumPayment <= 0) {
      alert("借入先名と最低返済額を入力してください。");
      return;
    }
    if (debt.paymentDay < 1 || debt.paymentDay > 31) {
      alert("支払日は1～31で入力してください。");
      return;
    }

    setDebts((current) =>
      editingDebtId
        ? current.map((item) => (item.id === editingDebtId ? debt : item))
        : [...current, debt]
    );
    setDebtModal(false);
  }

  function deleteDebt(debt: Debt) {
    if (
      !confirm(
        `${debt.name}を削除しますか？\n関連する返済記録も削除されます。`
      )
    )
      return;
    setDebts((current) => current.filter((item) => item.id !== debt.id));
    setPayments((current) =>
      current.filter((payment) => payment.debtId !== debt.id)
    );
  }

  function openPayment() {
    if (!debts.length) {
      alert("先に借金を登録してください。");
      setTab("debts");
      return;
    }
    setPaymentForm({
      debtId: debts[0].id,
      date: localDateString(),
      amount: "",
      actualInterest: "",
    });
    setPaymentModal(true);
  }

  function savePayment(event: FormEvent) {
    event.preventDefault();
    const debt = debts.find((item) => item.id === paymentForm.debtId);
    if (!debt) return;

    const amount = numberValue(paymentForm.amount);
    if (amount <= 0) {
      alert("返済額を入力してください。");
      return;
    }

    const estimated = estimateMonthlyInterest(
      debt.balance,
      debt.annualRate
    );
    const interest = paymentForm.actualInterest.trim()
      ? Math.min(amount, numberValue(paymentForm.actualInterest))
      : Math.min(amount, estimated);
    const principal = Math.max(0, amount - interest);
    const balanceAfter = Math.max(0, debt.balance - principal);

    const record: Payment = {
      id: uid(),
      debtId: debt.id,
      debtName: debt.name,
      date: paymentForm.date,
      amount,
      interest,
      principal,
      balanceAfter,
    };

    setPayments((current) => [record, ...current]);
    setDebts((current) =>
      current.map((item) =>
        item.id === debt.id ? { ...item, balance: balanceAfter } : item
      )
    );
    setPaymentModal(false);
  }

  function deletePayment(payment: Payment) {
    if (!confirm("この返済記録を削除し、元金を残高へ戻しますか？"))
      return;
    setPayments((current) =>
      current.filter((item) => item.id !== payment.id)
    );
    setDebts((current) =>
      current.map((debt) =>
        debt.id === payment.debtId
          ? { ...debt, balance: debt.balance + payment.principal }
          : debt
      )
    );
  }

  function openNewBill() {
    setEditingBillId(null);
    setBillForm({ name: "", amount: "", day: "", category: "固定費" });
    setBillModal(true);
  }

  function openEditBill(bill: Bill) {
    setEditingBillId(bill.id);
    setBillForm({
      name: bill.name,
      amount: String(bill.amount),
      day: String(bill.day),
      category: bill.category,
    });
    setBillModal(true);
  }

  function saveBill(event: FormEvent) {
    event.preventDefault();
    const bill: Bill = {
      id: editingBillId ?? uid(),
      name: billForm.name.trim(),
      amount: numberValue(billForm.amount),
      day: Math.round(numberValue(billForm.day)),
      category: billForm.category,
      paidMonth:
        bills.find((item) => item.id === editingBillId)?.paidMonth ?? "",
    };
    if (!bill.name || bill.amount <= 0 || bill.day < 1 || bill.day > 31) {
      alert("支払い名・金額・支払日を正しく入力してください。");
      return;
    }
    setBills((current) =>
      editingBillId
        ? current.map((item) => (item.id === editingBillId ? bill : item))
        : [...current, bill]
    );
    setBillModal(false);
  }

  function toggleBillPaid(bill: Bill) {
    setBills((current) =>
      current.map((item) =>
        item.id === bill.id
          ? { ...item, paidMonth: item.paidMonth === monthKey ? "" : monthKey }
          : item
      )
    );
  }

  function updateBudget(key: keyof Budget, value: string) {
    setBudget((current) => ({ ...current, [key]: numberValue(value) }));
  }

  function exportBackup() {
    const data: BackupData = {
      version: 3,
      exportedAt: new Date().toISOString(),
      debts,
      payments,
      budget,
      bills,
      settings,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `debt-command-backup-${localDateString()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as Partial<BackupData>;
        if (!Array.isArray(data.debts) || !Array.isArray(data.payments)) {
          throw new Error("invalid");
        }
        if (!confirm("現在のデータを、選択したバックアップで上書きしますか？"))
          return;
        setDebts(data.debts);
        setPayments(data.payments);
        setBudget({ ...initialBudget, ...(data.budget ?? {}) });
        setBills(Array.isArray(data.bills) ? data.bills : []);
        setSettings({ ...initialSettings, ...(data.settings ?? {}) });
        alert("バックアップを復元しました。");
      } catch {
        alert("バックアップファイルを読み込めませんでした。");
      } finally {
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  }


  const totalInitialBalance = debts.reduce(
    (sum, debt) => sum + (debt.initialBalance ?? debt.balance),
    0
  );
  const totalRepaidPrincipal = Math.max(0, totalInitialBalance - totalBalance);
  const overallProgress = totalInitialBalance > 0
    ? Math.min(100, Math.round((totalRepaidPrincipal / totalInitialBalance) * 100))
    : 0;
  const totalPaidAllTime = payments.reduce((sum, payment) => sum + payment.amount, 0);
  const totalPrincipalAllTime = payments.reduce((sum, payment) => sum + payment.principal, 0);
  const totalInterestAllTime = payments.reduce((sum, payment) => sum + payment.interest, 0);

  const monthlyReportRows = useMemo(() => {
    const grouped = new Map<string, { amount: number; principal: number; interest: number; count: number }>();
    payments.forEach((payment) => {
      const key = payment.date.slice(0, 7);
      const current = grouped.get(key) ?? { amount: 0, principal: 0, interest: 0, count: 0 };
      current.amount += payment.amount;
      current.principal += payment.principal;
      current.interest += payment.interest;
      current.count += 1;
      grouped.set(key, current);
    });
    return [...grouped.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, values]) => ({ month, ...values }));
  }, [payments]);

  function downloadText(filename: string, content: string, type = "text/csv;charset=utf-8") {
    const blob = new Blob(["\uFEFF" + content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportDebtsCsv() {
    const rows = [
      ["借入先", "現在残高", "登録時残高", "金利", "最低返済額", "支払日", "返済進捗"],
      ...debts.map((debt) => {
        const initial = debt.initialBalance ?? debt.balance;
        const progress = initial > 0 ? Math.round(((initial - debt.balance) / initial) * 100) : 0;
        return [
          debt.name,
          debt.balance,
          initial,
          debt.annualRate,
          debt.minimumPayment,
          debt.paymentDay,
          `${Math.max(0, Math.min(100, progress))}%`,
        ];
      }),
    ];
    downloadText(
      `debt-list-${localDateString()}.csv`,
      rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n")
    );
  }

  function exportPaymentsCsv() {
    const rows = [
      ["返済日", "借入先", "返済額", "元金", "利息", "返済後残高"],
      ...payments.map((payment) => [
        payment.date,
        payment.debtName,
        payment.amount,
        payment.principal,
        payment.interest,
        payment.balanceAfter,
      ]),
    ];
    downloadText(
      `payment-history-${localDateString()}.csv`,
      rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n")
    );
  }

  function buildCloudPayload() {
    return {
      version: 6,
      exportedAt: new Date().toISOString(),
      debts,
      payments,
      budget,
      bills,
      settings,
    };
  }

  async function signInOrUp(event: FormEvent) {
    event.preventDefault();
    if (!supabaseConfigured || !supabase) {
      alert("Supabaseの接続設定がまだ完了していません。");
      return;
    }
    if (!authEmail.trim() || authPassword.length < 8) {
      alert("メールアドレスと8文字以上のパスワードを入力してください。");
      return;
    }

    if (authMode === "signup" && !authConsent) {
      alert("利用規約とプライバシーポリシーへの同意が必要です。");
      return;
    }

    setCloudBusy(true);
    setCloudMessage("認証中…");
    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: authEmail.trim(),
          password: authPassword,
        });
        if (error) throw error;
        if (!data.session) {
          setCloudMessage("確認メールを送信しました。メール内のリンクを押してください。");
        } else {
          setCloudMessage("アカウントを作成しました。");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail.trim(),
          password: authPassword,
        });
        if (error) throw error;
        setCloudMessage("ログインしました。");
      }
      setAuthPassword("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "認証に失敗しました。";
      setCloudMessage(message);
      alert(`認証エラー：${message}`);
    } finally {
      setCloudBusy(false);
    }
  }

  async function deleteCloudData() {
    if (!supabase || !user) {
      alert("先にログインしてください。");
      return;
    }
    if (!confirm("クラウドに保存した借金・返済・家計データを削除しますか？")) return;
    if (!confirm("この操作は取り消せません。本当に削除しますか？")) return;

    setCloudBusy(true);
    setCloudMessage("クラウドデータを削除中…");
    try {
      const { error } = await supabase
        .from("user_app_data")
        .delete()
        .eq("user_id", user.id);

      if (error) throw error;
      setLastCloudSync("");
      setCloudMessage("クラウドデータを削除しました。");
      alert("クラウドに保存されていたアプリデータを削除しました。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "削除に失敗しました。";
      setCloudMessage(message);
      alert(`クラウド削除エラー：${message}`);
    } finally {
      setCloudBusy(false);
    }
  }

  async function signOutCloud() {
    if (!supabase) return;
    setScopeReady(false);
    await supabase.auth.signOut();
    setDebts([]);
    setPayments([]);
    setBudget(initialBudget);
    setBills([]);
    setSettings(initialSettings);
    setLocked(false);
    setCloudMessage("ログアウトしました。");
    setLastCloudSync("");
  }

  async function uploadToCloud() {
    if (!supabase || !user) {
      alert("先にログインしてください。");
      return;
    }
    setCloudBusy(true);
    setCloudMessage("クラウドへ保存中…");
    try {
      const { error } = await supabase
        .from("user_app_data")
        .upsert(
          {
            user_id: user.id,
            payload: buildCloudPayload(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        );
      if (error) throw error;
      const now = new Date().toLocaleString("ja-JP");
      setLastCloudSync(now);
      setCloudMessage(`保存完了：${now}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存に失敗しました。";
      setCloudMessage(message);
      alert(`クラウド保存エラー：${message}`);
    } finally {
      setCloudBusy(false);
    }
  }

  async function downloadFromCloud() {
    if (!supabase || !user) {
      alert("先にログインしてください。");
      return;
    }
    setCloudBusy(true);
    setCloudMessage("クラウドから読込中…");
    try {
      const { data, error } = await supabase
        .from("user_app_data")
        .select("payload, updated_at")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) throw error;
      if (!data?.payload) {
        alert("クラウドに保存されたデータはまだありません。");
        setCloudMessage("クラウドデータなし");
        return;
      }

      if (!confirm("この端末の現在データを、クラウドのデータで上書きしますか？")) {
        setCloudMessage("読込を中止しました。");
        return;
      }

      const payload = data.payload as {
        debts?: Debt[];
        payments?: Payment[];
        budget?: Budget;
        bills?: Bill[];
        settings?: AppSettings;
      };

      setDebts(Array.isArray(payload.debts) ? payload.debts : []);
      setPayments(Array.isArray(payload.payments) ? payload.payments : []);
      setBudget({ ...initialBudget, ...(payload.budget ?? {}) });
      setBills(Array.isArray(payload.bills) ? payload.bills : []);
      setSettings({ ...initialSettings, ...(payload.settings ?? {}) });

      const synced = data.updated_at
        ? new Date(data.updated_at).toLocaleString("ja-JP")
        : new Date().toLocaleString("ja-JP");
      setLastCloudSync(synced);
      setCloudMessage(`読込完了：${synced}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "読込に失敗しました。";
      setCloudMessage(message);
      alert(`クラウド読込エラー：${message}`);
    } finally {
      setCloudBusy(false);
    }
  }

  function saveGoalAndPin() {
    const pin = newPin.trim();
    if (settings.pinEnabled && pin && !/^\d{4}$/.test(pin)) {
      alert("PINは4桁の数字で入力してください。");
      return;
    }
    setSettings((current) => ({
      ...current,
      monthlyTarget: Math.max(0, current.monthlyTarget),
      pin: pin || current.pin,
    }));
    setNewPin("");
    alert("設定を保存しました。");
  }

  function togglePin(enabled: boolean) {
    if (enabled && !settings.pin && !/^\d{4}$/.test(newPin.trim())) {
      alert("先に4桁のPINを入力してください。");
      return;
    }
    setSettings((current) => ({
      ...current,
      pinEnabled: enabled,
      pin: enabled ? (newPin.trim() || current.pin) : current.pin,
    }));
    setNewPin("");
  }

  function unlockApp() {
    if (unlockPin === settings.pin) {
      setLocked(false);
      setUnlockPin("");
    } else {
      alert("PINが違います。");
      setUnlockPin("");
    }
  }

  function lockNow() {
    if (!settings.pinEnabled || !settings.pin) {
      alert("管理→目標・ロックからPINを設定してください。");
      return;
    }
    setLocked(true);
  }

  function resetAll() {
    if (!confirm("借金・返済・家計・支払日の全データを削除しますか？"))
      return;
    if (!confirm("本当に削除します。元に戻せません。")) return;
    setDebts([]);
    setPayments([]);
    setBudget(initialBudget);
    setBills([]);
    setSettings(initialSettings);
  }

  if (!ready) {
    return <main className="loading">データを読み込んでいます…</main>;
  }

  if (locked) {
    return (
      <main className="lockScreen">
        <div className="lockLogo">司</div>
        <span className="eyebrow">PRIVATE MODE</span>
        <h1>借金返済司令室</h1>
        <p>4桁のPINを入力してください。</p>
        <input
          autoFocus
          inputMode="numeric"
          maxLength={4}
          value={unlockPin}
          onChange={(e) => setUnlockPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          onKeyDown={(e) => {
            if (e.key === "Enter") unlockApp();
          }}
          placeholder="● ● ● ●"
        />
        <button onClick={unlockApp}>ロックを解除</button>
        <small>このロックは画面の簡易保護です。データ暗号化ではありません。</small>
      </main>
    );
  }

  const command =
    debts.length === 0
      ? "まず1件登録しろ。見えない借金は減らせない。"
      : budgetRemaining < 0
      ? `家計は毎月${yen(Math.abs(budgetRemaining))}不足する計算だ。追加返済より先に赤字を止めろ。`
      : highestPriority
      ? `追加返済は金利${highestPriority.annualRate}%の「${highestPriority.name}」を優先候補にしろ。`
      : "記録を続けろ。数字が積み上がれば判断が変わる。";

  return (
    <main className="appShell">
      <header className="topbar">
        <div className="brandMark">司</div>
        <div className="brandText">
          <small>Premium Web v3</small>
          <h1>借金返済司令室</h1>
        </div>
        <button
          className={`headerButton ${user ? "cloudOnline" : ""}`}
          onClick={() => { setTab("more"); setMoreView("cloud"); }}
        >
          {user ? "同期" : "クラウド"}
        </button>
        <button className="headerButton" onClick={lockNow}>
          ロック
        </button>
      </header>

      <section className="content">
        {tab === "home" && (
          <>
            <section className="hero">
              <div>
                <span className="eyebrow">COMMAND DASHBOARD</span>
                <h2>返済状況を、一画面で。</h2>
                <p>借金・返済・家計・支払日をまとめて判断する。</p>
              </div>
              <div className="ring" style={{ "--rate": `${principalRate * 3.6}deg` } as React.CSSProperties}>
                <strong>{principalRate}%</strong>
                <span>元金率</span>
              </div>
            </section>

            {urgentItems.length > 0 && (
              <article className="urgentAlert">
                <strong>支払日が迫っています</strong>
                {urgentItems.map((item) => <span key={item}>・{item}</span>)}
              </article>
            )}

            {monthlyTarget > 0 && (
              <article className="targetCard">
                <div>
                  <small>今月の返済目標</small>
                  <strong>{yen(paidThisMonth)} / {yen(monthlyTarget)}</strong>
                </div>
                <span>{targetProgress}%</span>
                <div className="targetTrack"><div style={{ width: `${targetProgress}%` }} /></div>
              </article>
            )}

            {debts.length === 0 && (
              <article className="empty">
                <strong>借金が登録されていません</strong>
                <p>最初の1件を登録すると、すべての機能が動き始めます。</p>
                <button onClick={openNewDebt}>借金を登録する</button>
              </article>
            )}

            <div className="summaryGrid">
              <Summary label="借金総額" value={yen(totalBalance)} tone="blue" note={`${debts.length}件`} />
              <Summary label="今月の返済" value={yen(paidThisMonth)} tone="blue" note={`${monthPayments.length}件`} />
              <Summary label="元金に回った額" value={yen(principalThisMonth)} tone="green" note={`${principalRate}%`} />
              <Summary label="支払った利息" value={yen(interestThisMonth)} tone="red" note={`推定月利息 ${yen(estimatedInterest)}`} />
            </div>

            <article className="commandCard">
              <div className="commandHead">
                <span>!</span>
                <div><small>本日の司令</small><strong>次にやることを決めろ</strong></div>
              </div>
              <p>{command}</p>
              <button onClick={openPayment}>返済を記録する</button>
            </article>

            <div className="twoColumn">
              <article className="miniPanel">
                <small>次の借金返済</small>
                <strong>{nextDebtPayment ? `${nextDebtPayment.days}日後` : "未登録"}</strong>
                <span>{nextDebtPayment ? `${nextDebtPayment.debt.name}・${yen(nextDebtPayment.debt.minimumPayment)}` : "借金一覧から登録"}</span>
              </article>
              <article className="miniPanel">
                <small>未払い予定</small>
                <strong>{yen(unpaidBillsTotal)}</strong>
                <span>{nextBill ? `${nextBill.bill.name}・${nextBill.days}日後` : "今月は登録なし"}</span>
              </article>
            </div>

            <article className={`budgetStatus ${budgetRemaining < 0 ? "danger" : ""}`}>
              <div><small>今月の家計見込み</small><strong>{budgetRemaining >= 0 ? `残り ${yen(budgetRemaining)}` : `不足 ${yen(Math.abs(budgetRemaining))}`}</strong></div>
              <button onClick={() => { setTab("more"); setMoreView("budget"); }}>家計を確認</button>
            </article>

            <section className="panel">
              <div className="panelTitle">
                <div><small>直近6か月</small><h3>元金と利息の推移</h3></div>
                <span>返済記録から自動作成</span>
              </div>
              <div className="chart">
                {historyMonths.map((item) => (
                  <div className="chartColumn" key={item.key}>
                    <div className="bars" title={`${item.label} 元金${yen(item.principal)} 利息${yen(item.interest)}`}>
                      <div className="interestBar" style={{ height: `${(item.interest / chartMax) * 100}%` }} />
                      <div className="principalBar" style={{ height: `${(item.principal / chartMax) * 100}%` }} />
                    </div>
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
              <div className="legend"><span className="greenDot" />元金 <span className="redDot" />利息</div>
            </section>
          </>
        )}

        {tab === "debts" && (
          <>
            <PageTitle eyebrow="DEBTS" title="借金一覧">
              <button className="primary" onClick={openNewDebt}>＋ 登録</button>
            </PageTitle>
            <article className="totalCard">
              <small>借金総額</small><strong>{yen(totalBalance)}</strong>
              <span>最低返済合計 {yen(totalMinimum)}・推定月間利息 {yen(estimatedInterest)}</span>
            </article>
            {debts.length === 0 ? (
              <article className="empty"><strong>登録なし</strong><p>右上の登録ボタンから追加してください。</p></article>
            ) : (
              <div className="cardList">
                {[...debts]
                  .sort((a, b) => b.annualRate - a.annualRate)
                  .map((debt, index) => (
                    <article className="debtCard" key={debt.id}>
                      <div className="cardTop">
                        <div className="company">{debt.name.slice(0, 1)}</div>
                        <div><strong>{debt.name}</strong><span>毎月{debt.paymentDay}日・優先度 {index + 1}</span></div>
                        {index === 0 && <em>高金利優先</em>}
                      </div>
                      <div className="stats">
                        <div><small>残高</small><strong>{yen(debt.balance)}</strong></div>
                        <div><small>金利</small><strong>{debt.annualRate}%</strong></div>
                        <div><small>最低返済</small><strong>{yen(debt.minimumPayment)}</strong></div>
                      </div>
                      <div className="estimatedRow">
                        <span>推定月間利息</span><strong>{yen(estimateMonthlyInterest(debt.balance, debt.annualRate))}</strong>
                      </div>
                      <div className="actions">
                        <button onClick={() => openEditDebt(debt)}>編集</button>
                        <button className="delete" onClick={() => deleteDebt(debt)}>削除</button>
                      </div>
                    </article>
                  ))}
              </div>
            )}
          </>
        )}

        {tab === "payments" && (
          <>
            <PageTitle eyebrow="PAYMENTS" title="返済記録">
              <button className="primary" onClick={openPayment}>＋ 記録</button>
            </PageTitle>
            <article className="breakdown">
              <small>今月の返済内訳</small>
              <strong>{yen(paidThisMonth)}</strong>
              <div className="split">
                <div style={{ width: `${principalRate}%` }} />
                <div style={{ width: `${100 - principalRate}%` }} />
              </div>
              <div className="splitLabels"><span>元金 {yen(principalThisMonth)}</span><span>利息 {yen(interestThisMonth)}</span></div>
            </article>
            {payments.length === 0 ? (
              <article className="empty"><strong>返済記録なし</strong><p>返済額を記録すると残高とグラフが更新されます。</p></article>
            ) : (
              <div className="cardList">
                {payments.map((payment) => {
                  const linkedDebt = debts.find((debt) => debt.id === payment.debtId);
                  const displayName =
                    payment.debtName ||
                    linkedDebt?.name ||
                    "借入先不明";

                  return (
                    <article className="paymentCard" key={payment.id}>
                      <div className="company">{displayName.slice(0, 1)}</div>
                      <div className="paymentInfo">
                        <strong>{displayName}・{yen(payment.amount)}</strong>
                        <span>{payment.date}｜元金 {yen(payment.principal)}｜利息 {yen(payment.interest)}</span>
                      </div>
                      <button className="textDelete" onClick={() => deletePayment(payment)}>削除</button>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}

        {tab === "plan" && (
          <>
            <PageTitle eyebrow="STRATEGY" title="返済戦略" />
            <article className="strategyCard">
              <label>毎月の追加返済額</label>
              <div className="moneyInput"><span>¥</span><input inputMode="numeric" value={extraPayment} onChange={(e) => setExtraPayment(e.target.value)} /></div>
              <div className="strategySwitch">
                <button className={strategy === "avalanche" ? "selected" : ""} onClick={() => setStrategy("avalanche")}>利息優先</button>
                <button className={strategy === "snowball" ? "selected" : ""} onClick={() => setStrategy("snowball")}>達成感優先</button>
              </div>
              <p>{strategy === "avalanche" ? "金利の高い借金から追加返済し、利息削減を狙います。" : "残高の少ない借金から完済し、件数を早く減らします。"}</p>
            </article>
            <div className="resultGrid">
              <Result label="完済短縮" value={`${reducedMonths}か月`} />
              <Result label="削減利息" value={yen(savedInterest)} />
              <Result label="通常完済" value={payoffLabel(normalSimulation.months)} />
              <Result label="追加後完済" value={payoffLabel(extraSimulation.months)} />
            </div>
            <article className="stopperCard">
              <div className="stopperHead">
                <div><small>支出ストッパー</small><h3>その買い物を、返済と比較する</h3></div>
              </div>
              <label>今使おうとしている金額</label>
              <div className="moneyInput">
                <span>¥</span>
                <input
                  inputMode="numeric"
                  value={purchaseAmount}
                  onChange={(e) => setPurchaseAmount(e.target.value)}
                />
              </div>
              <div className="stopperResult">
                <div><small>完済短縮の目安</small><strong>{purchaseReducedMonths}か月</strong></div>
                <div><small>削減利息の目安</small><strong>{yen(purchaseSavedInterest)}</strong></div>
              </div>
              <p>使うことを責める機能ではありません。使う未来と、返済へ回す未来を並べて判断する機能です。</p>
            </article>

            <article className="priorityCard">
              <small>追加返済の優先候補</small>
              <strong>{strategy === "avalanche" ? highestPriority?.name ?? "未登録" : [...debts].sort((a,b) => a.balance - b.balance)[0]?.name ?? "未登録"}</strong>
              <p>追加返済は最低返済とは別に、選択した戦略の優先先へ集中させます。</p>
            </article>
          </>
        )}

        {tab === "more" && (
          <>
            {moreView === "menu" && (
              <>
                <PageTitle eyebrow="TOOLS" title="管理機能" />
                <div className="menuList">
                  <button onClick={() => setMoreView("budget")}><span>家計</span><strong>収入・支出・返済余力</strong><em>›</em></button>
                  <button onClick={() => setMoreView("bills")}><span>支払日</span><strong>未払い予定を確認</strong><em>›</em></button>
                  <button onClick={() => setMoreView("report")}><span>分析</span><strong>返済レポート・進捗</strong><em>›</em></button>
                  <button onClick={() => setMoreView("goals")}><span>目標</span><strong>返済目標・PINロック</strong><em>›</em></button>
                  <button onClick={() => setMoreView("cloud")}><span>同期</span><strong>ログイン・クラウド保存</strong><em>›</em></button>
                  <button onClick={() => setMoreView("backup")}><span>保存</span><strong>端末バックアップ・復元</strong><em>›</em></button>
                </div>
              </>
            )}

            {moreView === "budget" && (
              <>
                <SubTitle title="今月の家計" onBack={() => setMoreView("menu")} />
                <div className="budgetSummary">
                  <div><small>収入</small><strong>{yen(incomeTotal)}</strong></div>
                  <div><small>支出＋最低返済</small><strong>{yen(expenseTotal)}</strong></div>
                  <div className={budgetRemaining < 0 ? "negative" : "positive"}><small>残額</small><strong>{budgetRemaining >= 0 ? yen(budgetRemaining) : `-${yen(Math.abs(budgetRemaining))}`}</strong></div>
                </div>
                <section className="formSection">
                  <h3>収入</h3>
                  <MoneyField label="給料" value={budget.salary} onChange={(v) => updateBudget("salary", v)} />
                  <MoneyField label="副収入" value={budget.sideIncome} onChange={(v) => updateBudget("sideIncome", v)} />
                  <MoneyField label="その他収入" value={budget.otherIncome} onChange={(v) => updateBudget("otherIncome", v)} />
                </section>
                <section className="formSection">
                  <h3>支出</h3>
                  <MoneyField label="家賃" value={budget.rent} onChange={(v) => updateBudget("rent", v)} />
                  <MoneyField label="水道光熱費" value={budget.utilities} onChange={(v) => updateBudget("utilities", v)} />
                  <MoneyField label="通信費" value={budget.communication} onChange={(v) => updateBudget("communication", v)} />
                  <MoneyField label="食費" value={budget.food} onChange={(v) => updateBudget("food", v)} />
                  <MoneyField label="保険料" value={budget.insurance} onChange={(v) => updateBudget("insurance", v)} />
                  <MoneyField label="交通費" value={budget.transport} onChange={(v) => updateBudget("transport", v)} />
                  <MoneyField label="カード支払い" value={budget.card} onChange={(v) => updateBudget("card", v)} />
                  <MoneyField label="娯楽費" value={budget.entertainment} onChange={(v) => updateBudget("entertainment", v)} />
                  <MoneyField label="その他支出" value={budget.otherExpense} onChange={(v) => updateBudget("otherExpense", v)} />
                  <div className="autoField"><span>借金最低返済</span><strong>{yen(totalMinimum)}</strong></div>
                </section>
              </>
            )}

            {moreView === "bills" && (
              <>
                <SubTitle title="支払日管理" onBack={() => setMoreView("menu")}>
                  <button className="primary" onClick={openNewBill}>＋ 登録</button>
                </SubTitle>
                <article className="totalCard"><small>今月の未払い</small><strong>{yen(unpaidBillsTotal)}</strong><span>{unpaidBills.length}件</span></article>
                {bills.length === 0 ? (
                  <article className="empty"><strong>支払い予定なし</strong><p>家賃、カード、通信費などの支払日を登録できます。</p></article>
                ) : (
                  <div className="cardList">
                    {[...bills].sort((a,b) => daysUntilPayment(a.day) - daysUntilPayment(b.day)).map((bill) => {
                      const paid = bill.paidMonth === monthKey;
                      const days = daysUntilPayment(bill.day);
                      return (
                        <article className={`billCard ${paid ? "paid" : days <= 3 ? "urgent" : days <= 7 ? "soon" : ""}`} key={bill.id}>
                          <button className="checkButton" onClick={() => toggleBillPaid(bill)}>{paid ? "✓" : ""}</button>
                          <div><strong>{bill.name}</strong><span>{bill.category}・毎月{bill.day}日・{paid ? "支払済み" : `${days}日後`}</span></div>
                          <strong>{yen(bill.amount)}</strong>
                          <button className="editText" onClick={() => openEditBill(bill)}>編集</button>
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            )}


            {moreView === "report" && (
              <>
                <SubTitle title="返済レポート" onBack={() => setMoreView("menu")} />
                <article className="reportHero">
                  <small>借金全体の返済進捗</small>
                  <strong>{overallProgress}%</strong>
                  <div className="reportProgress"><div style={{ width: `${overallProgress}%` }} /></div>
                  <span>{yen(totalRepaidPrincipal)}返済済み / 登録時 {yen(totalInitialBalance)}</span>
                </article>

                <div className="reportGrid">
                  <Result label="累計返済額" value={yen(totalPaidAllTime)} />
                  <Result label="累計元金" value={yen(totalPrincipalAllTime)} />
                  <Result label="累計利息" value={yen(totalInterestAllTime)} />
                  <Result label="現在残高" value={yen(totalBalance)} />
                </div>

                <section className="panel reportSection">
                  <div className="panelTitle">
                    <div><small>借入先別</small><h3>返済進捗</h3></div>
                  </div>
                  <div className="debtProgressList">
                    {debts.length === 0 ? (
                      <p className="reportEmpty">借金を登録すると表示されます。</p>
                    ) : debts.map((debt) => {
                      const initial = debt.initialBalance ?? debt.balance;
                      const progress = initial > 0
                        ? Math.max(0, Math.min(100, Math.round(((initial - debt.balance) / initial) * 100)))
                        : 0;
                      return (
                        <div className="debtProgressItem" key={debt.id}>
                          <div><strong>{debt.name}</strong><span>{progress}%・残り {yen(debt.balance)}</span></div>
                          <div className="smallProgress"><div style={{ width: `${progress}%` }} /></div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="panel reportSection">
                  <div className="panelTitle">
                    <div><small>月別集計</small><h3>返済履歴</h3></div>
                  </div>
                  <div className="monthlyRows">
                    {monthlyReportRows.length === 0 ? (
                      <p className="reportEmpty">返済を記録すると月別に集計されます。</p>
                    ) : monthlyReportRows.slice(0, 12).map((row) => (
                      <div className="monthlyRow" key={row.month}>
                        <div><strong>{row.month.replace("-", "年")}月</strong><span>{row.count}件</span></div>
                        <div><small>返済</small><strong>{yen(row.amount)}</strong></div>
                        <div><small>元金</small><strong className="greenText">{yen(row.principal)}</strong></div>
                        <div><small>利息</small><strong className="redText">{yen(row.interest)}</strong></div>
                      </div>
                    ))}
                  </div>
                </section>

                <div className="csvButtons">
                  <button className="secondaryLarge" onClick={exportDebtsCsv}>借金一覧をCSV出力</button>
                  <button className="secondaryLarge" onClick={exportPaymentsCsv}>返済履歴をCSV出力</button>
                </div>
              </>
            )}

            {moreView === "goals" && (
              <>
                <SubTitle title="目標・ロック" onBack={() => setMoreView("menu")} />
                <section className="formSection">
                  <h3>今月の返済目標</h3>
                  <MoneyField
                    label="目標返済額"
                    value={settings.monthlyTarget}
                    onChange={(value) =>
                      setSettings((current) => ({
                        ...current,
                        monthlyTarget: numberValue(value),
                      }))
                    }
                  />
                  <p className="settingNote">ホーム画面に目標達成率が表示されます。</p>
                </section>

                <section className="formSection">
                  <h3>簡易PINロック</h3>
                  <label className="pinField">
                    <span>新しい4桁PIN</span>
                    <input
                      inputMode="numeric"
                      maxLength={4}
                      value={newPin}
                      onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                      placeholder={settings.pin ? "変更する場合のみ入力" : "例：1234"}
                    />
                  </label>
                  <div className="pinActions">
                    <button
                      className={settings.pinEnabled ? "pinOn" : ""}
                      onClick={() => togglePin(true)}
                    >
                      PINロックを有効
                    </button>
                    <button onClick={() => togglePin(false)}>無効にする</button>
                  </div>
                  <p className="settingNote">アプリを他人に開かれにくくする簡易ロックです。保存データ自体を暗号化する機能ではありません。</p>
                </section>

                <button className="primaryLarge" onClick={saveGoalAndPin}>設定を保存</button>
                {settings.pinEnabled && (
                  <button className="secondaryLarge lockTestButton" onClick={lockNow}>今すぐロックを試す</button>
                )}
              </>
            )}

            {moreView === "cloud" && (
              <>
                <SubTitle title="クラウド同期" onBack={() => setMoreView("menu")} />

                {!supabaseConfigured ? (
                  <article className="cloudSetupCard">
                    <strong>クラウド接続はまだ未設定です</strong>
                    <p>同梱の「SETUP_CLOUD_JA.txt」を見ながら、SupabaseのURLと公開キーを設定してください。設定前でもローカル版として使えます。</p>
                    <span>現在：ローカル保存モード</span>
                  </article>
                ) : !authReady ? (
                  <article className="cloudSetupCard"><strong>認証状態を確認しています…</strong></article>
                ) : !user ? (
                  <form className="cloudAuthCard" onSubmit={signInOrUp}>
                    <span className="eyebrow">CLOUD ACCOUNT</span>
                    <h3>{authMode === "signin" ? "ログイン" : "新規アカウント作成"}</h3>
                    <label>
                      メールアドレス
                      <input
                        type="email"
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        placeholder="example@email.com"
                        required
                      />
                    </label>
                    <label>
                      パスワード
                      <input
                        type="password"
                        minLength={8}
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        placeholder="8文字以上"
                        required
                      />
                    </label>
                    {authMode === "signup" && (
                      <label className="consentRow">
                        <input
                          type="checkbox"
                          checked={authConsent}
                          onChange={(e) => setAuthConsent(e.target.checked)}
                        />
                        <span>
                          <a href="/terms" target="_blank" rel="noreferrer">利用規約</a>と
                          <a href="/privacy" target="_blank" rel="noreferrer">プライバシーポリシー</a>
                          に同意します
                        </span>
                      </label>
                    )}
                    <button className="primaryLarge" disabled={cloudBusy} type="submit">
                      {cloudBusy ? "処理中…" : authMode === "signin" ? "ログインする" : "アカウントを作成"}
                    </button>
                    <button
                      className="authSwitch"
                      type="button"
                      onClick={() => setAuthMode(authMode === "signin" ? "signup" : "signin")}
                    >
                      {authMode === "signin" ? "初めての方：新規登録へ" : "登録済みの方：ログインへ"}
                    </button>
                    <p className="cloudMessage">{cloudMessage}</p>
                  </form>
                ) : (
                  <>
                    <article className="cloudAccountCard">
                      <small>ログイン中</small>
                      <strong>{user.email ?? "メールアドレス未取得"}</strong>
                      <span>{lastCloudSync ? `最終同期：${lastCloudSync}` : "まだ同期していません"}</span>
                    </article>

                    <article className="cloudWarning">
                      <strong>同期の使い方</strong>
                      <p>この端末の最新データを残したいときは「クラウドへ保存」。別端末で同じ内容を開くときは「クラウドから読み込む」を押してください。</p>
                    </article>
                    <article className="cloudIsolation">
                      <strong>アカウント分離：有効</strong>
                      <p>端末内データもログイン中のユーザーごとに分けて保存します。</p>
                    </article>

                    <div className="cloudActions">
                      <button className="primaryLarge" disabled={cloudBusy} onClick={uploadToCloud}>
                        {cloudBusy ? "処理中…" : "この端末のデータをクラウドへ保存"}
                      </button>
                      <button className="secondaryLarge" disabled={cloudBusy} onClick={downloadFromCloud}>
                        クラウドからこの端末へ読み込む
                      </button>
                    </div>

                    <p className="cloudMessage">{cloudMessage}</p>
                    <button className="signOutButton" onClick={signOutCloud}>ログアウト</button>
                    <button className="cloudDeleteButton" disabled={cloudBusy} onClick={deleteCloudData}>
                      クラウド保存データを削除
                    </button>
                  </>
                )}
              </>
            )}

            {moreView === "backup" && (
              <>
                <SubTitle title="バックアップ" onBack={() => setMoreView("menu")} />
                <article className="infoCard">
                  <strong>データはこのブラウザ内に保存中</strong>
                  <p>ブラウザデータの削除やPC故障に備えて、定期的にバックアップしてください。</p>
                </article>
                <div className="backupActions">
                  <button className="primaryLarge" onClick={exportBackup}>バックアップを書き出す</button>
                  <button className="secondaryLarge" onClick={() => fileInputRef.current?.click()}>バックアップから復元</button>
                  <input ref={fileInputRef} hidden type="file" accept=".json,application/json" onChange={importBackup} />
                </div>
                <article className="dataCount">
                  <div><span>借金</span><strong>{debts.length}件</strong></div>
                  <div><span>返済記録</span><strong>{payments.length}件</strong></div>
                  <div><span>支払予定</span><strong>{bills.length}件</strong></div>
                </article>
                <button className="dangerLarge" onClick={resetAll}>すべてのデータを削除</button>
              </>
            )}
          </>
        )}
      </section>

      <nav className="bottomNav">
        <NavButton active={tab === "home"} icon="⌂" label="ホーム" onClick={() => setTab("home")} />
        <NavButton active={tab === "debts"} icon="▤" label="借金" onClick={() => setTab("debts")} />
        <NavButton active={tab === "payments"} icon="¥" label="返済" onClick={() => setTab("payments")} />
        <NavButton active={tab === "plan"} icon="↗" label="戦略" onClick={() => setTab("plan")} />
        <NavButton active={tab === "more"} icon="•••" label="管理" onClick={() => { setTab("more"); setMoreView("menu"); }} />
      </nav>

      {debtModal && (
        <Modal title={editingDebtId ? "借金を編集" : "借金を登録"} onClose={() => setDebtModal(false)}>
          <form className="modalForm" onSubmit={saveDebt}>
            <TextField label="借入先名" value={debtForm.name} onChange={(v) => setDebtForm({...debtForm, name: v})} placeholder="例：A社" />
            <TextField label="現在残高" value={debtForm.balance} onChange={(v) => setDebtForm({...debtForm, balance: v})} placeholder="480000" numeric />
            <TextField label="実質年率（％）" value={debtForm.annualRate} onChange={(v) => setDebtForm({...debtForm, annualRate: v})} placeholder="18" decimal />
            <TextField label="最低返済額" value={debtForm.minimumPayment} onChange={(v) => setDebtForm({...debtForm, minimumPayment: v})} placeholder="13000" numeric />
            <TextField label="毎月の支払日" value={debtForm.paymentDay} onChange={(v) => setDebtForm({...debtForm, paymentDay: v})} placeholder="27" numeric />
            <button className="primaryLarge" type="submit">保存する</button>
          </form>
        </Modal>
      )}

      {paymentModal && (
        <Modal title="返済を記録" onClose={() => setPaymentModal(false)}>
          <form className="modalForm" onSubmit={savePayment}>
            <label>借入先<select value={paymentForm.debtId} onChange={(e) => setPaymentForm({...paymentForm, debtId: e.target.value})}>{debts.map((debt) => <option key={debt.id} value={debt.id}>{debt.name}</option>)}</select></label>
            <label>返済日<input type="date" value={paymentForm.date} onChange={(e) => setPaymentForm({...paymentForm, date: e.target.value})} /></label>
            <TextField label="実際に支払った金額" value={paymentForm.amount} onChange={(v) => setPaymentForm({...paymentForm, amount: v})} placeholder="13000" numeric />
            <TextField label="実際の利息額（分かる場合）" value={paymentForm.actualInterest} onChange={(v) => setPaymentForm({...paymentForm, actualInterest: v})} placeholder="空欄なら推定" numeric />
            <p className="helper">利息が空欄の場合は、残高×年率÷12で概算します。</p>
            <button className="primaryLarge" type="submit">記録して残高を更新</button>
          </form>
        </Modal>
      )}

      <footer className="privacyFooter">
        <a href="/terms" target="_blank" rel="noreferrer">利用規約</a>
        <a href="/privacy" target="_blank" rel="noreferrer">プライバシーポリシー</a>
        <span>v8.0 / 計算結果は概算です</span>
      </footer>

      {billModal && (
        <Modal title={editingBillId ? "支払い予定を編集" : "支払い予定を登録"} onClose={() => setBillModal(false)}>
          <form className="modalForm" onSubmit={saveBill}>
            <TextField label="支払い名" value={billForm.name} onChange={(v) => setBillForm({...billForm, name: v})} placeholder="例：クレジットカード" />
            <TextField label="金額" value={billForm.amount} onChange={(v) => setBillForm({...billForm, amount: v})} placeholder="15000" numeric />
            <TextField label="毎月の支払日" value={billForm.day} onChange={(v) => setBillForm({...billForm, day: v})} placeholder="27" numeric />
            <label>カテゴリ<select value={billForm.category} onChange={(e) => setBillForm({...billForm, category: e.target.value})}><option>固定費</option><option>カード</option><option>税金</option><option>生活費</option><option>その他</option></select></label>
            <button className="primaryLarge" type="submit">保存する</button>
          </form>
        </Modal>
      )}
    </main>
  );
}

function Summary({ label, value, tone, note }: { label: string; value: string; tone: string; note: string }) {
  return <article className={`summary ${tone}`}><small>{label}</small><strong>{value}</strong><span>{note}</span></article>;
}

function Result({ label, value }: { label: string; value: string }) {
  return <article><small>{label}</small><strong>{value}</strong></article>;
}

function PageTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return <div className="pageTitle"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{children}</div>;
}

function SubTitle({ title, onBack, children }: { title: string; onBack: () => void; children?: React.ReactNode }) {
  return <div className="subTitle"><button onClick={onBack}>‹</button><h2>{title}</h2><div>{children}</div></div>;
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: string; label: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}><span>{icon}</span><small>{label}</small></button>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modalBackdrop" onMouseDown={onClose}><section className="modal" onMouseDown={(e) => e.stopPropagation()}><div className="modalHead"><h2>{title}</h2><button onClick={onClose}>×</button></div>{children}</section></div>;
}

function TextField({ label, value, onChange, placeholder, numeric, decimal }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; numeric?: boolean; decimal?: boolean }) {
  return <label>{label}<input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode={decimal ? "decimal" : numeric ? "numeric" : "text"} required={!placeholder?.includes("空欄")} /></label>;
}

function MoneyField({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return <label className="moneyField"><span>{label}</span><div><em>¥</em><input inputMode="numeric" value={value || ""} onChange={(e) => onChange(e.target.value)} placeholder="0" /></div></label>;
}
