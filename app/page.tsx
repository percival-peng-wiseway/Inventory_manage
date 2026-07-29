"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type InventoryItem = {
  sku: string;
  category: string;
  on_hand: number;
  pending: number;
  available: number;
};

type Order = {
  id: number;
  sales_rep: string;
  customer: string;
  phone: string;
  sku: string;
  quantity: number;
  created_at: string;
  status: "pending" | "scheduled" | "delivered" | "cancelled";
  address: string | null;
  planned_date: string | null;
  driver: string | null;
  delivered_at: string | null;
  note: string | null;
};

type ParsedArrival = { sku: string; quantity: number; isNew: boolean };
type LogEntry = {
  id: number;
  actor: string;
  action: string;
  detail: string;
  created_at: string;
};
type ApiState = { inventory: InventoryItem[]; orders: Order[]; logs: LogEntry[] };
type View = "overview" | "sale" | "dispatch" | "arrival" | "driver" | "log";
type Language = "zh" | "en";

const initialState: ApiState = { inventory: [], orders: [], logs: [] };

export default function Home() {
  const [data, setData] = useState<ApiState>(initialState);
  const [view, setView] = useState<View>("overview");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [message, setMessage] = useState("");
  const [arrivalText, setArrivalText] = useState("");
  const [arrivalDraft, setArrivalDraft] = useState<ParsedArrival[]>([]);
  const [lang, setLang] = useState<Language>("zh");
  const [orderActor, setOrderActor] = useState("Sam");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState("all");
  const [sortBy, setSortBy] = useState("sku");
  const tr = (zh: string, en: string) => lang === "zh" ? zh : en;

  const refresh = async () => {
    const response = await fetch("/api/inventory", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取库存");
    setData(await response.json());
  };

  useEffect(() => {
    refresh()
      .catch(() => setToast("暂时无法读取库存，请刷新重试"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  useEffect(() => {
    if (!["Sam", "RuiHan", "Hogan", "Kevin"].includes(orderActor)) setOrderActor("Sam");
  }, [orderActor]);

  const notify = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 3200);
  };

  const mutate = async (body: unknown) => {
    setBusy(true);
    try {
      const response = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "操作失败");
      await refresh();
      return result;
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(
    () =>
      data.inventory.reduce(
        (sum, item) => ({
          onHand: sum.onHand + item.on_hand,
          pending: sum.pending + item.pending,
          available: sum.available + item.available,
        }),
        { onHand: 0, pending: 0, available: 0 },
      ),
    [data.inventory],
  );

  const waitingOrders = data.orders.filter((order) => order.status === "pending");
  const driverOrders = data.orders.filter((order) => order.status === "scheduled");
  const filteredInventory = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return data.inventory
      .filter((item) => !keyword || item.sku.toLowerCase().includes(keyword))
      .filter((item) => categoryFilter === "all" || item.category === categoryFilter)
      .filter((item) => {
        if (stockFilter === "low") return item.available <= 5;
        if (stockFilter === "normal") return item.available > 5;
        if (stockFilter === "pending") return item.pending > 0;
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "available-asc") return a.available - b.available;
        if (sortBy === "available-desc") return b.available - a.available;
        return a.sku.localeCompare(b.sku);
      });
  }, [data.inventory, search, categoryFilter, stockFilter, sortBy]);

  const handleSale = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await mutate({
        action: "sale",
        salesRep: orderActor,
        customer: form.get("customer"),
        phone: form.get("phone"),
        sku: form.get("sku"),
        quantity: Number(form.get("quantity")),
        note: form.get("note"),
      });
      event.currentTarget.reset();
      notify(tr("销售单已提交，库存已转为 Pending", "Order submitted and inventory reserved"));
      setView("overview");
    } catch (error) {
      notify(error instanceof Error ? error.message : "提交失败");
    }
  };

  const handleSchedule = async (event: FormEvent<HTMLFormElement>, order: Order) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await mutate({
        action: "schedule",
        orderId: order.id,
        address: form.get("address"),
        plannedDate: form.get("plannedDate"),
        driver: form.get("driver"),
        language: lang,
      });
      setMessage(result.message);
      notify(tr("送货已安排，司机消息已生成", "Delivery scheduled and driver message created"));
    } catch (error) {
      notify(error instanceof Error ? error.message : "安排失败");
    }
  };

  const parseArrival = () => {
    const aliases = data.inventory
      .map((item) => item.sku)
      .sort((a, b) => b.length - a.length);
    const parsedMap = new Map<string, ParsedArrival>();
    const segments = arrivalText.split(/[，,\n;；]+/).map((part) => part.trim()).filter(Boolean);

    for (const segment of segments) {
      const quantityMatch = segment.match(/(\d+)\s*(?:个|件|pcs?|units?)?\s*$/i);
      if (!quantityMatch) continue;
      const quantity = Number(quantityMatch[1]);
      let skuText = segment.slice(0, quantityMatch.index).trim()
        .replace(/^(?:今天|今日|新货|到货|入库|新增\s*sku|创建\s*sku|new\s*sku|received|receive|new\s*stock|stock)\s*/i, "")
        .replace(/\s*(?:到货|到了|入库|新增|加|有|arrived|received|add)\s*$/i, "")
        .replace(/[xX×:：]\s*$/, "")
        .trim();
      const compact = skuText.replace(/\s+/g, "").toLowerCase();
      const existingSku = aliases.find((sku) => compact === sku.replace(/\s+/g, "").toLowerCase());
      const sku = (existingSku || skuText.replace(/\s+/g, " ").toUpperCase()).trim();
      if (!sku || !quantity) continue;
      const current = parsedMap.get(sku);
      parsedMap.set(sku, {
        sku,
        quantity: (current?.quantity || 0) + quantity,
        isNew: !aliases.some((item) => item.toLowerCase() === sku.toLowerCase()),
      });
    }

    const parsed = [...parsedMap.values()];
    setArrivalDraft(parsed);
    if (!parsed.length) notify(tr("没有识别到型号和数量，例如：KH10 5，CQ7 S 20", "No SKU and quantity found. Try: KH10 5, CQ7 S 20"));
  };

  const confirmArrival = async () => {
    try {
      await mutate({ action: "arrival", rawText: arrivalText, items: arrivalDraft });
      setArrivalText("");
      setArrivalDraft([]);
      notify(tr("入库已确认，总库存已更新", "Stock received and inventory updated"));
      setView("overview");
    } catch (error) {
      notify(error instanceof Error ? error.message : "入库失败");
    }
  };

  const copyMessage = async () => {
    await navigator.clipboard.writeText(message);
    notify(tr("司机消息已复制", "Driver message copied"));
  };

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">仓</span>
          <div>
            <strong>简仓</strong>
            <small>{tr("库存管理", "Inventory")}</small>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="topbar-stats">
            <span>{tr("在库", "Stock")} <b>{loading ? "—" : totals.onHand}</b></span>
            <span>Pending <b>{loading ? "—" : totals.pending}</b></span>
          </div>
          <button className="lang-toggle" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
            {lang === "zh" ? "EN" : "中文"}
          </button>
        </div>
      </header>

      <nav className="nav-tabs" aria-label="主要功能">
        {([
          ["overview", tr("库存", "Inventory"), ""],
          ["sale", tr("销售下单", "New order"), ""],
          ["dispatch", tr("采购调度", "Dispatch"), waitingOrders.length ? String(waitingOrders.length) : ""],
          ["arrival", tr("新货入库", "Receive stock"), ""],
          ["driver", tr("司机任务", "Driver"), driverOrders.length ? String(driverOrders.length) : ""],
          ["log", tr("操作日志", "Activity log"), ""],
        ] as [View, string, string][]).map(([key, label, count]) => (
          <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
            <strong>{label}</strong>{count && <span className="nav-count">{count}</span>}
          </button>
        ))}
      </nav>

      <section className="workspace">
        {view === "overview" && (
          <>
            <div className="section-heading">
              <div><h2>{tr("库存", "Inventory")}</h2></div>
              <button className="primary small" onClick={() => setView("sale")}>＋ {tr("新建订单", "New order")}</button>
            </div>
            <div className="stats">
              <article><span>{tr("实际在库", "On hand")}</span><strong>{totals.onHand}</strong></article>
              <article className="amber"><span>Pending</span><strong>{totals.pending}</strong></article>
              <article className="green"><span>{tr("可销售", "Available")}</span><strong>{totals.available}</strong></article>
              <article><span>{tr("待送任务", "Deliveries")}</span><strong>{driverOrders.length}</strong></article>
            </div>
            <div className="table-card">
              <div className="filter-bar">
                <input
                  aria-label={tr("搜索型号", "Search SKU")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={tr("搜索型号…", "Search SKU…")}
                />
                <select aria-label={tr("类别", "Category")} value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                  <option value="all">{tr("全部类别", "All categories")}</option>
                  <option value="正常库存">{tr("正常库存", "Regular")}</option>
                  <option value="积存库存">{tr("积存库存", "Aged stock")}</option>
                </select>
                <select aria-label={tr("库存状态", "Stock status")} value={stockFilter} onChange={(event) => setStockFilter(event.target.value)}>
                  <option value="all">{tr("全部状态", "All status")}</option>
                  <option value="normal">{tr("正常", "In stock")}</option>
                  <option value="low">{tr("低库存", "Low stock")}</option>
                  <option value="pending">Pending</option>
                </select>
                <select aria-label={tr("排序", "Sort")} value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                  <option value="sku">{tr("型号排序", "Sort by SKU")}</option>
                  <option value="available-asc">{tr("可售：少到多", "Available: low to high")}</option>
                  <option value="available-desc">{tr("可售：多到少", "Available: high to low")}</option>
                </select>
              </div>
              <div className="table-title"><h3>{tr("全部型号", "All SKUs")}</h3><span>{filteredInventory.length} SKU</span></div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>{tr("型号", "SKU")}</th><th>{tr("类别", "Category")}</th><th>{tr("实际在库", "On hand")}</th><th>Pending</th><th>{tr("可销售", "Available")}</th><th>{tr("状态", "Status")}</th></tr></thead>
                  <tbody>
                    {filteredInventory.map((item) => (
                      <tr key={item.sku}>
                        <td><b>{item.sku}</b></td>
                        <td>{item.category === "正常库存" ? tr("正常库存", "Regular") : tr("积存库存", "Aged stock")}</td>
                        <td>{item.on_hand}</td>
                        <td className="pending-number">{item.pending}</td>
                        <td><b>{item.available}</b></td>
                        <td><span className={`stock-status ${item.available <= 5 ? "low" : ""}`}>{item.available <= 5 ? tr("低库存", "Low") : tr("正常", "OK")}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {view === "sale" && (
          <div className="form-layout">
            <div>
              <h2>{tr("下单", "New order")}</h2>
              <p className="muted">Sam · RuiHan · Hogan · Kevin</p>
            </div>
            <form className="panel form-grid" onSubmit={handleSale}>
              <label>{tr("下单人", "Created by")}<select value={orderActor} onChange={(event) => setOrderActor(event.target.value)} required><option>Sam</option><option>RuiHan</option><option>Hogan</option><option>Kevin</option></select></label>
              <label>{tr("客户", "Customer")}<input name="customer" placeholder="ABC Energy" required /></label>
              <label>{tr("电话", "Phone")}<input name="phone" placeholder="04xx xxx xxx" /></label>
              <label>{tr("型号", "SKU")}<select name="sku" required>{data.inventory.map((item) => <option key={item.sku}>{item.sku}</option>)}</select></label>
              <label>{tr("数量", "Quantity")}<input name="quantity" type="number" min="1" placeholder="0" required /></label>
              <label>{tr("备注", "Note")}<input name="note" placeholder={tr("选填", "Optional")} /></label>
              <button className="primary full" disabled={busy}>{tr("提交并设为 Pending", "Submit as Pending")}</button>
            </form>
          </div>
        )}

        {view === "dispatch" && (
          <>
            <div className="section-heading">
              <div><h2>{tr("安排送货", "Dispatch")}</h2></div>
            </div>
            {waitingOrders.length === 0 ? <Empty text={tr("没有待安排订单", "No orders to dispatch")} sub={tr("新订单会显示在这里。", "New orders will appear here.")} /> :
              <div className="order-list">{waitingOrders.map((order) => (
                <article className="order-card" key={order.id}>
                  <div className="order-summary">
                    <span className="order-id">#{String(order.id).padStart(4, "0")}</span>
                    <h3>{order.customer}</h3>
                    <p><b>{order.sku}</b> × {order.quantity}</p>
                    <small>{order.sales_rep === "采购" ? tr("采购", "Purchasing") : order.sales_rep} · {formatDate(order.created_at, lang)}</small>
                  </div>
                  <form className="dispatch-form" onSubmit={(event) => handleSchedule(event, order)}>
                    <label>{tr("送货地址", "Address")}<input name="address" placeholder={tr("完整地址", "Full address")} required /></label>
                    <label>{tr("送货日期", "Delivery date")}<input name="plannedDate" type="date" required /></label>
                    <label>{tr("司机", "Driver")}<select name="driver"><option value="司机">{tr("司机", "Driver")}</option></select></label>
                    <button className="primary" disabled={busy}>{tr("安排并生成消息", "Schedule & create message")}</button>
                  </form>
                </article>
              ))}</div>
            }
            {message && (
              <div className="message-box">
                <div><h3>{tr("司机消息", "Driver message")}</h3></div>
                <pre>{message}</pre>
                <button className="primary" onClick={copyMessage}>{tr("复制", "Copy")}</button>
              </div>
            )}
          </>
        )}

        {view === "arrival" && (
          <div className="arrival-layout">
            <div>
              <h2>{tr("新货入库", "Receive stock")}</h2>
              <p className="muted">{tr("输入到货内容，确认后入库。", "Enter received stock, then confirm.")}</p>
              <div className="example">{tr("例如：", "Example:")}<br /><b>KH10 5, CQ7 S 20, JAM 440 2</b></div>
            </div>
            <div className="panel">
              <label className="textarea-label">{tr("到货内容", "Received items")}<textarea value={arrivalText} onChange={(event) => setArrivalText(event.target.value)} placeholder={tr("输入型号和数量…", "Enter SKUs and quantities…")} /></label>
              <button className="secondary full" onClick={parseArrival} disabled={!arrivalText.trim()}>{tr("整理内容", "Parse items")}</button>
              {arrivalDraft.length > 0 && (
                <div className="confirm-box">
                  <div className="confirm-title"><h3>{tr("请确认", "Confirm")}</h3><span>{tr("尚未录入", "Not saved")}</span></div>
                  {arrivalDraft.map((item) => <div className="arrival-row" key={item.sku}><div><b>{item.sku}</b>{item.isNew && <em className="new-sku-badge">{tr("新 SKU", "New SKU")}</em>}</div><span>＋{item.quantity}</span></div>)}
                  <button className="primary full" onClick={confirmArrival} disabled={busy}>{tr("确认入库", "Confirm receipt")}</button>
                </div>
              )}
            </div>
          </div>
        )}

        {view === "driver" && (
          <>
            <div className="section-heading"><div><h2>{tr("司机任务", "Driver tasks")}</h2></div></div>
            {driverOrders.length === 0 ? <Empty text={tr("没有待送任务", "No deliveries")} sub={tr("新任务会显示在这里。", "New tasks will appear here.")} /> :
              <div className="driver-grid">{driverOrders.map((order) => (
                <article className="driver-card" key={order.id}>
                  <div className="driver-date"><span>{tr("送货日期", "Delivery date")}</span><strong>{order.planned_date || tr("待定", "TBC")}</strong></div>
                  <h3>{order.customer}</h3>
                  <p>{order.address}</p>
                  <div className="product-line"><b>{order.sku}</b><strong>× {order.quantity}</strong></div>
                  {order.phone && <a href={`tel:${order.phone}`}>{order.phone}</a>}
                  <button className="primary full" disabled={busy} onClick={async () => {
                    try {
                      await mutate({ action: "deliver", orderId: order.id });
                      notify(tr("已确认送达，实际库存已扣减", "Delivered and stock updated"));
                    } catch (error) {
                      notify(error instanceof Error ? error.message : "操作失败");
                    }
                  }}>{tr("确认送达", "Mark delivered")}</button>
                </article>
              ))}</div>
            }
          </>
        )}

        {view === "log" && (
          <>
            <div className="section-heading"><div><h2>{tr("操作日志", "Activity log")}</h2></div></div>
            <div className="table-card">
              <div className="table-scroll">
                <table>
                  <thead><tr><th>{tr("时间", "Time")}</th><th>{tr("操作人", "User")}</th><th>{tr("动作", "Action")}</th><th>{tr("内容", "Details")}</th></tr></thead>
                  <tbody>
                    {data.logs.length === 0 ? (
                      <tr><td colSpan={4} className="empty-row">{tr("暂无操作记录", "No activity yet")}</td></tr>
                    ) : data.logs.map((entry) => (
                      <tr key={entry.id}>
                        <td className="log-time">{formatDateTime(entry.created_at, lang)}</td>
                        <td><b>{translateLog(entry.actor, lang)}</b></td>
                        <td><span className="log-action">{translateLog(entry.action, lang)}</span></td>
                        <td>{entry.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

function Empty({ text, sub }: { text: string; sub: string }) {
  return <div className="empty"><span>✓</span><h3>{text}</h3><p>{sub}</p></div>;
}

function formatDate(value: string, lang: Language) {
  return new Date(value).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-AU", { month: "short", day: "numeric" });
}

function formatDateTime(value: string, lang: Language) {
  return new Date(`${value.replace(" ", "T")}Z`).toLocaleString(lang === "zh" ? "zh-CN" : "en-AU", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function translateLog(value: string, lang: Language) {
  if (lang === "zh") return value;
  const translations: Record<string, string> = {
    "采购": "Purchasing",
    "司机": "Driver",
    "系统": "System",
    "销售预留": "Order reserved",
    "安排送货": "Delivery scheduled",
    "确认送达": "Delivered",
    "新货入库": "Stock received",
    "初始化库存": "Inventory initialised",
  };
  return translations[value] || value;
}
