"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type InventoryItem = {
  sku: string;
  category: string;
  status: string;
  on_hand: number;
  pending: number;
  available: number;
};

type Order = {
  id: number;
  order_group: string | null;
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
type OrderGroup = { key: string; orders: Order[]; primary: Order };

type ParsedArrival = { sku: string; quantity: number; isNew: boolean; category: string };
type SaleItem = { sku: string; quantity: number };
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
  const [saleItems, setSaleItems] = useState<SaleItem[]>([{ sku: "", quantity: 1 }]);
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

  const waitingGroups = groupOrderRows(data.orders.filter((order) => order.status === "pending"));
  const driverGroups = groupOrderRows(data.orders.filter((order) => order.status === "scheduled"));
  const filteredInventory = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return data.inventory
      .filter((item) => !keyword || item.sku.toLowerCase().includes(keyword))
      .filter((item) => categoryFilter === "all" || item.category === categoryFilter)
      .filter((item) => stockFilter === "all" || item.status === stockFilter)
      .sort((a, b) => {
        if (sortBy === "available-asc") return a.available - b.available;
        if (sortBy === "available-desc") return b.available - a.available;
        return a.sku.localeCompare(b.sku);
      });
  }, [data.inventory, search, categoryFilter, stockFilter, sortBy]);

  const handleSale = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (saleItems.some((item) => !item.sku || item.quantity < 1)) {
      notify(tr("请完整填写所有商品", "Complete every item"));
      return;
    }
    try {
      await mutate({
        action: "sale",
        salesRep: orderActor,
        customer: form.get("customer"),
        phone: form.get("phone"),
        items: saleItems,
        note: form.get("note"),
      });
      event.currentTarget.reset();
      setSaleItems([{ sku: "", quantity: 1 }]);
      notify(tr("销售单已提交，库存已转为 Pending", "Order submitted and inventory reserved"));
      setView("overview");
    } catch (error) {
      notify(error instanceof Error ? error.message : "提交失败");
    }
  };

  const handleSchedule = async (event: FormEvent<HTMLFormElement>, group: OrderGroup) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await mutate({
        action: "schedule",
        orderIds: group.orders.map((order) => order.id),
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

  const cancelOrder = async (group: OrderGroup) => {
    if (!window.confirm(tr(`确定删除 ${group.primary.customer} 的订单？`, `Delete ${group.primary.customer}'s order?`))) return;
    try {
      await mutate({ action: "cancelOrder", orderIds: group.orders.map((order) => order.id) });
      notify(tr("订单已删除，Pending 库存已释放", "Order deleted and reserved stock released"));
    } catch (error) {
      notify(error instanceof Error ? error.message : tr("删除失败", "Delete failed"));
    }
  };

  const changeStatus = async (sku: string, status: string) => {
    try {
      await mutate({ action: "setStatus", sku, status });
      notify(tr("库存状态已更新", "Status updated"));
    } catch (error) {
      notify(error instanceof Error ? error.message : tr("更新失败", "Update failed"));
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
      const existingItem = data.inventory.find((item) => item.sku.toLowerCase() === sku.toLowerCase());
      parsedMap.set(sku, {
        sku,
        quantity: (current?.quantity || 0) + quantity,
        isNew: !existingItem,
        category: current?.category || existingItem?.category || "其他",
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
          ["dispatch", tr("采购调度", "Dispatch"), waitingGroups.length ? String(waitingGroups.length) : ""],
          ["arrival", tr("新货入库", "Receive stock"), ""],
          ["driver", tr("司机任务", "Driver"), driverGroups.length ? String(driverGroups.length) : ""],
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
              <article><span>{tr("待送任务", "Deliveries")}</span><strong>{driverGroups.length}</strong></article>
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
                  <option value="电池">{tr("电池", "Battery")}</option>
                  <option value="太阳能板">{tr("太阳能板", "Solar panel")}</option>
                  <option value="安装配件">{tr("安装配件", "Installation accessories")}</option>
                  <option value="其他">{tr("其他", "Other")}</option>
                </select>
                <select aria-label={tr("库存状态", "Stock status")} value={stockFilter} onChange={(event) => setStockFilter(event.target.value)}>
                  <option value="all">{tr("全部状态", "All status")}</option>
                  <option value="充足">{tr("充足", "Sufficient")}</option>
                  <option value="积压">{tr("积压", "Overstock")}</option>
                  <option value="低库存">{tr("低库存", "Low stock")}</option>
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
                        <td><span className={`category-badge ${categoryClass(item.category)}`}>{translateCategory(item.category, lang)}</span></td>
                        <td className="stock-number">{item.on_hand}</td>
                        <td className="stock-number pending-number">{item.pending}</td>
                        <td className="stock-number">{item.available}</td>
                        <td>
                          <select
                            className={`status-select ${statusClass(item.status)}`}
                            aria-label={`${item.sku} ${tr("状态", "status")}`}
                            value={item.status}
                            disabled={busy}
                            onChange={(event) => changeStatus(item.sku, event.target.value)}
                          >
                            <option value="充足">{tr("充足", "Sufficient")}</option>
                            <option value="积压">{tr("积压", "Overstock")}</option>
                            <option value="低库存">{tr("低库存", "Low stock")}</option>
                          </select>
                        </td>
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
              <label>{tr("备注", "Note")}<input name="note" placeholder={tr("选填", "Optional")} /></label>
              <div className="sale-items">
                <div className="sale-items-heading">
                  <h3>{tr("商品", "Items")}</h3>
                  <button
                    type="button"
                    className="add-line"
                    onClick={() => setSaleItems((items) => [...items, { sku: "", quantity: 1 }])}
                  >
                    ＋ {tr("添加商品", "Add item")}
                  </button>
                </div>
                {saleItems.map((line, index) => (
                  <div className="sale-item-row" key={index}>
                    <label>{tr("型号", "SKU")}
                      <select
                        value={line.sku}
                        required
                        onChange={(event) => setSaleItems((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, sku: event.target.value } : item))}
                      >
                        <option value="">{tr("选择型号", "Select SKU")}</option>
                        {data.inventory.map((item) => <option key={item.sku}>{item.sku}</option>)}
                      </select>
                    </label>
                    <label>{tr("数量", "Quantity")}
                      <input
                        type="number"
                        min="1"
                        value={line.quantity}
                        required
                        onChange={(event) => setSaleItems((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: Number(event.target.value) } : item))}
                      />
                    </label>
                    <button
                      type="button"
                      className="remove-line"
                      aria-label={tr("删除商品", "Remove item")}
                      disabled={saleItems.length === 1}
                      onClick={() => setSaleItems((items) => items.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button className="primary full" disabled={busy}>{tr("提交并设为 Pending", "Submit as Pending")}</button>
            </form>
          </div>
        )}

        {view === "dispatch" && (
          <>
            <div className="section-heading">
              <div><h2>{tr("安排送货", "Dispatch")}</h2></div>
            </div>
            {waitingGroups.length === 0 ? <Empty text={tr("没有待安排订单", "No orders to dispatch")} sub={tr("新订单会显示在这里。", "New orders will appear here.")} /> :
              <div className="order-list">{waitingGroups.map((group) => (
                <article className="order-card" key={group.key}>
                  <div className="order-summary">
                    <span className="order-id">#{String(group.primary.id).padStart(4, "0")}</span>
                    <h3>{group.primary.customer}</h3>
                    <div className="order-items-summary">
                      {group.orders.map((order) => <p key={order.id}><b>{order.sku}</b><span>× {order.quantity}</span></p>)}
                    </div>
                    <small>{group.primary.sales_rep} · {formatDate(group.primary.created_at, lang)}</small>
                  </div>
                  <form className="dispatch-form" onSubmit={(event) => handleSchedule(event, group)}>
                    <label>{tr("送货地址", "Address")}<input name="address" placeholder={tr("完整地址", "Full address")} required /></label>
                    <label>{tr("送货日期", "Delivery date")}<input name="plannedDate" type="date" required /></label>
                    <label>{tr("司机", "Driver")}<select name="driver"><option value="司机">{tr("司机", "Driver")}</option></select></label>
                    <div className="dispatch-actions">
                      <button className="primary" disabled={busy}>{tr("安排并生成消息", "Schedule & create message")}</button>
                      <button type="button" className="danger" disabled={busy} onClick={() => cancelOrder(group)}>{tr("删除", "Delete")}</button>
                    </div>
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
                  {arrivalDraft.map((item) => (
                    <div className="arrival-row" key={item.sku}>
                      <div><b>{item.sku}</b>{item.isNew && <em className="new-sku-badge">{tr("新 SKU", "New SKU")}</em>}</div>
                      <select
                        className="arrival-category"
                        aria-label={`${item.sku} ${tr("类别", "category")}`}
                        value={item.category}
                        onChange={(event) => setArrivalDraft((current) => current.map((row) => row.sku === item.sku ? { ...row, category: event.target.value } : row))}
                      >
                        <option value="电池">{tr("电池", "Battery")}</option>
                        <option value="太阳能板">{tr("太阳能板", "Solar panel")}</option>
                        <option value="安装配件">{tr("安装配件", "Installation accessories")}</option>
                        <option value="其他">{tr("其他", "Other")}</option>
                      </select>
                      <span>＋{item.quantity}</span>
                    </div>
                  ))}
                  <button className="primary full" onClick={confirmArrival} disabled={busy}>{tr("确认入库", "Confirm receipt")}</button>
                </div>
              )}
            </div>
          </div>
        )}

        {view === "driver" && (
          <>
            <div className="section-heading"><div><h2>{tr("司机任务", "Driver tasks")}</h2></div></div>
            {driverGroups.length === 0 ? <Empty text={tr("没有待送任务", "No deliveries")} sub={tr("新任务会显示在这里。", "New tasks will appear here.")} /> :
              <div className="driver-grid">{driverGroups.map((group) => (
                <article className="driver-card" key={group.key}>
                  <div className="driver-date"><span>{tr("送货日期", "Delivery date")}</span><strong>{group.primary.planned_date || tr("待定", "TBC")}</strong></div>
                  <h3>{group.primary.customer}</h3>
                  <p>{group.primary.address}</p>
                  <div className="product-lines">
                    {group.orders.map((order) => <div className="product-line" key={order.id}><b>{order.sku}</b><strong>× {order.quantity}</strong></div>)}
                  </div>
                  {group.primary.phone && <a href={`tel:${group.primary.phone}`}>{group.primary.phone}</a>}
                  <button className="primary full" disabled={busy} onClick={async () => {
                    try {
                      await mutate({ action: "deliver", orderIds: group.orders.map((order) => order.id) });
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
                        <td><span className={`log-action ${logActionClass(entry.action)}`}>{translateLog(entry.action, lang)}</span></td>
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

function groupOrderRows(orders: Order[]): OrderGroup[] {
  const groups = new Map<string, Order[]>();
  for (const order of orders) {
    const key = order.order_group || [
      "legacy",
      order.sales_rep,
      order.customer,
      order.phone || "",
      order.created_at,
      order.note || "",
    ].join(":");
    groups.set(key, [...(groups.get(key) || []), order]);
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, orders: rows, primary: rows[0] }));
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
    "更改类别": "Category changed",
    "更改状态": "Status changed",
    "删除订单": "Order deleted",
  };
  return translations[value] || value;
}

function logActionClass(action: string) {
  const classes: Record<string, string> = {
    "销售预留": "log-sale",
    "安排送货": "log-dispatch",
    "新货入库": "log-arrival",
    "确认送达": "log-delivered",
    "更改类别": "log-category",
    "更改状态": "log-category",
    "删除订单": "log-deleted",
    "初始化库存": "log-initial",
  };
  return classes[action] || "log-default";
}

function translateCategory(category: string, lang: Language) {
  if (lang === "zh") return category;
  const categories: Record<string, string> = {
    "电池": "Battery",
    "太阳能板": "Solar panel",
    "安装配件": "Installation accessories",
    "其他": "Other",
  };
  return categories[category] || category;
}

function categoryClass(category: string) {
  const classes: Record<string, string> = {
    "电池": "category-battery",
    "太阳能板": "category-solar",
    "安装配件": "category-accessory",
    "其他": "category-other",
  };
  return classes[category] || "category-other";
}

function statusClass(status: string) {
  if (status === "积压") return "status-overstock";
  if (status === "低库存") return "status-low";
  return "status-sufficient";
}
