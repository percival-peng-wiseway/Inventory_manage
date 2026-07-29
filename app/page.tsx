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

type ParsedArrival = { sku: string; quantity: number };
type LogEntry = {
  id: number;
  actor: string;
  action: string;
  detail: string;
  created_at: string;
};
type ApiState = { inventory: InventoryItem[]; orders: Order[]; logs: LogEntry[] };
type View = "overview" | "sale" | "dispatch" | "arrival" | "driver" | "log";

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

  const handleSale = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await mutate({
        action: "sale",
        salesRep: form.get("salesRep"),
        customer: form.get("customer"),
        phone: form.get("phone"),
        sku: form.get("sku"),
        quantity: Number(form.get("quantity")),
        note: form.get("note"),
      });
      event.currentTarget.reset();
      notify("销售单已提交，库存已转为 Pending");
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
      });
      setMessage(result.message);
      notify("送货已安排，司机消息已生成");
    } catch (error) {
      notify(error instanceof Error ? error.message : "安排失败");
    }
  };

  const parseArrival = () => {
    const normalized = arrivalText.replace(/\n/g, "，");
    const aliases = data.inventory
      .map((item) => item.sku)
      .sort((a, b) => b.length - a.length);
    const parsed: ParsedArrival[] = [];

    for (const sku of aliases) {
      const escaped = sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
      const match = normalized.match(
        new RegExp(`${escaped}\\s*(?:到货|到了|入库|新增|加|有)?\\s*[xX×:]?\\s*(\\d+)`, "i"),
      );
      if (match) parsed.push({ sku, quantity: Number(match[1]) });
    }

    setArrivalDraft(parsed);
    if (!parsed.length) notify("没有识别到型号和数量，请用例如：KH10 5，CQ7 S 20");
  };

  const confirmArrival = async () => {
    try {
      await mutate({ action: "arrival", rawText: arrivalText, items: arrivalDraft });
      setArrivalText("");
      setArrivalDraft([]);
      notify("入库已确认，总库存已更新");
      setView("overview");
    } catch (error) {
      notify(error instanceof Error ? error.message : "入库失败");
    }
  };

  const copyMessage = async () => {
    await navigator.clipboard.writeText(message);
    notify("司机消息已复制");
  };

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">仓</span>
          <div>
            <strong>简仓</strong>
            <small>库存管理</small>
          </div>
        </div>
        <div className="topbar-stats">
          <span>在库 <b>{loading ? "—" : totals.onHand}</b></span>
          <span>Pending <b>{loading ? "—" : totals.pending}</b></span>
        </div>
      </header>

      <nav className="nav-tabs" aria-label="主要功能">
        {([
          ["overview", "库存", ""],
          ["sale", "销售下单", ""],
          ["dispatch", "采购调度", waitingOrders.length ? String(waitingOrders.length) : ""],
          ["arrival", "新货入库", ""],
          ["driver", "司机任务", driverOrders.length ? String(driverOrders.length) : ""],
          ["log", "操作日志", ""],
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
              <div><h2>库存</h2></div>
              <button className="primary small" onClick={() => setView("sale")}>＋ 新建销售单</button>
            </div>
            <div className="stats">
              <article><span>实际在库</span><strong>{totals.onHand}</strong><small>仓库现有数量</small></article>
              <article className="amber"><span>Pending</span><strong>{totals.pending}</strong><small>已售但未送达</small></article>
              <article className="green"><span>可销售</span><strong>{totals.available}</strong><small>扣除所有预留</small></article>
              <article><span>待送任务</span><strong>{driverOrders.length}</strong><small>司机需要处理</small></article>
            </div>
            <div className="table-card">
              <div className="table-title"><h3>全部型号</h3><span>{data.inventory.length} 个 SKU</span></div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>型号</th><th>类别</th><th>实际在库</th><th>Pending</th><th>可销售</th><th>状态</th></tr></thead>
                  <tbody>
                    {data.inventory.map((item) => (
                      <tr key={item.sku}>
                        <td><b>{item.sku}</b></td>
                        <td>{item.category}</td>
                        <td>{item.on_hand}</td>
                        <td className="pending-number">{item.pending}</td>
                        <td><b>{item.available}</b></td>
                        <td><span className={`stock-status ${item.available <= 5 ? "low" : ""}`}>{item.available <= 5 ? "低库存" : "正常"}</span></td>
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
              <h2>销售下单</h2>
              <p className="muted">提交后自动占用可售库存。</p>
            </div>
            <form className="panel form-grid" onSubmit={handleSale}>
              <label>销售员<select name="salesRep" required><option>销售1</option><option>销售2</option></select></label>
              <label>客户名称<input name="customer" placeholder="例如：ABC Energy" required /></label>
              <label>联系电话<input name="phone" placeholder="04xx xxx xxx" /></label>
              <label>产品型号<select name="sku" required>{data.inventory.map((item) => <option key={item.sku}>{item.sku}</option>)}</select></label>
              <label>销售数量<input name="quantity" type="number" min="1" placeholder="0" required /></label>
              <label>备注<input name="note" placeholder="选填" /></label>
              <button className="primary full" disabled={busy}>确认销售并设为 Pending</button>
            </form>
          </div>
        )}

        {view === "dispatch" && (
          <>
            <div className="section-heading">
              <div><h2>安排送货</h2></div>
            </div>
            {waitingOrders.length === 0 ? <Empty text="目前没有等待安排的销售单" /> :
              <div className="order-list">{waitingOrders.map((order) => (
                <article className="order-card" key={order.id}>
                  <div className="order-summary">
                    <span className="order-id">#{String(order.id).padStart(4, "0")}</span>
                    <h3>{order.customer}</h3>
                    <p><b>{order.sku}</b> × {order.quantity}</p>
                    <small>{order.sales_rep} · {formatDate(order.created_at)}</small>
                  </div>
                  <form className="dispatch-form" onSubmit={(event) => handleSchedule(event, order)}>
                    <label>送货地址<input name="address" placeholder="完整地址" required /></label>
                    <label>计划送货日期<input name="plannedDate" type="date" required /></label>
                    <label>司机<select name="driver"><option>司机</option></select></label>
                    <button className="primary" disabled={busy}>安排送货并生成消息</button>
                  </form>
                </article>
              ))}</div>
            }
            {message && (
              <div className="message-box">
                <div><p className="eyebrow">可复制给司机</p><h3>送货消息已生成</h3></div>
                <pre>{message}</pre>
                <button className="primary" onClick={copyMessage}>复制消息</button>
              </div>
            )}
          </>
        )}

        {view === "arrival" && (
          <div className="arrival-layout">
            <div>
              <h2>新货入库</h2>
              <p className="muted">输入到货内容，确认后入库。</p>
              <div className="example">例如：<br /><b>今天 KH10 到了 5，CQ7 S 20，JAM 440 2</b></div>
            </div>
            <div className="panel">
              <label className="textarea-label">描述这次到货<textarea value={arrivalText} onChange={(event) => setArrivalText(event.target.value)} placeholder="输入到货型号和数量…" /></label>
              <button className="secondary full" onClick={parseArrival} disabled={!arrivalText.trim()}>整理入库内容</button>
              {arrivalDraft.length > 0 && (
                <div className="confirm-box">
                  <div className="confirm-title"><h3>请采购确认</h3><span>尚未录入</span></div>
                  {arrivalDraft.map((item) => <div className="arrival-row" key={item.sku}><b>{item.sku}</b><span>＋{item.quantity}</span></div>)}
                  <button className="primary full" onClick={confirmArrival} disabled={busy}>确认无误，正式入库</button>
                </div>
              )}
            </div>
          </div>
        )}

        {view === "driver" && (
          <>
            <div className="section-heading"><div><h2>司机任务</h2></div></div>
            {driverOrders.length === 0 ? <Empty text="目前没有待送任务" /> :
              <div className="driver-grid">{driverOrders.map((order) => (
                <article className="driver-card" key={order.id}>
                  <div className="driver-date"><span>计划送货</span><strong>{order.planned_date || "待定"}</strong></div>
                  <h3>{order.customer}</h3>
                  <p>{order.address}</p>
                  <div className="product-line"><b>{order.sku}</b><strong>× {order.quantity}</strong></div>
                  {order.phone && <a href={`tel:${order.phone}`}>{order.phone}</a>}
                  <button className="primary full" disabled={busy} onClick={async () => {
                    try {
                      await mutate({ action: "deliver", orderId: order.id });
                      notify("已确认送达，实际库存已扣减");
                    } catch (error) {
                      notify(error instanceof Error ? error.message : "操作失败");
                    }
                  }}>确认已送达</button>
                </article>
              ))}</div>
            }
          </>
        )}

        {view === "log" && (
          <>
            <div className="section-heading"><div><h2>操作日志</h2></div></div>
            <div className="table-card">
              <div className="table-scroll">
                <table>
                  <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>内容</th></tr></thead>
                  <tbody>
                    {data.logs.length === 0 ? (
                      <tr><td colSpan={4} className="empty-row">暂无操作记录</td></tr>
                    ) : data.logs.map((entry) => (
                      <tr key={entry.id}>
                        <td className="log-time">{formatDateTime(entry.created_at)}</td>
                        <td><b>{entry.actor}</b></td>
                        <td><span className="log-action">{entry.action}</span></td>
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

function Empty({ text }: { text: string }) {
  return <div className="empty"><span>✓</span><h3>{text}</h3><p>新任务出现时会显示在这里。</p></div>;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function formatDateTime(value: string) {
  return new Date(`${value.replace(" ", "T")}Z`).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
