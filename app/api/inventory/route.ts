import { env } from "cloudflare:workers";

const seedItems = [
  ["KH10", "正常库存", 11],
  ["KH8", "正常库存", 17],
  ["H3 10.0", "正常库存", 7],
  ["H3 125", "正常库存", 1],
  ["H1 5.0", "正常库存", 5],
  ["H3 15.0", "正常库存", 4],
  ["CQ7 S", "正常库存", 190],
  ["CQ7 M", "正常库存", 35],
  ["CQ7 M V6+", "正常库存", 7],
  ["EQ4800 S", "积存库存", 3],
  ["JAM 440", "积存库存", 8],
] as const;

type RuntimeEnv = { DB: D1Database };

function db() {
  return (env as unknown as RuntimeEnv).DB;
}

let databaseReady: Promise<void> | undefined;

function ensureDatabase() {
  if (!databaseReady) {
    databaseReady = initializeDatabase().catch((error) => {
      databaseReady = undefined;
      throw error;
    });
  }
  return databaseReady;
}

async function initializeDatabase() {
  const database = db();
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS inventory (
      sku TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      on_hand INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    database.prepare(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sales_rep TEXT NOT NULL,
      customer TEXT NOT NULL,
      phone TEXT,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'pending',
      address TEXT,
      planned_date TEXT,
      driver TEXT,
      delivered_at TEXT,
      note TEXT
    )`),
    database.prepare(`CREATE TABLE IF NOT EXISTS arrivals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_text TEXT NOT NULL,
      items_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    database.prepare(`CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
  ]);

  const count = await database.prepare("SELECT COUNT(*) AS count FROM inventory").first<{ count: number }>();
  if (!count?.count) {
    await database.batch(
      [
        ...seedItems.map(([sku, category, quantity]) =>
          database.prepare("INSERT INTO inventory (sku, category, on_hand) VALUES (?, ?, ?)").bind(sku, category, quantity),
        ),
        database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
          .bind("系统", "初始化库存", `共 ${seedItems.length} 个型号，合计 288`),
      ],
    );
  }
}

export async function GET() {
  await ensureDatabase();
  const database = db();
  const [inventory, orders, logs] = await Promise.all([
    database.prepare(`
      SELECT
        i.sku,
        i.category,
        i.on_hand,
        COALESCE(SUM(CASE WHEN o.status IN ('pending', 'scheduled') THEN o.quantity ELSE 0 END), 0) AS pending,
        i.on_hand - COALESCE(SUM(CASE WHEN o.status IN ('pending', 'scheduled') THEN o.quantity ELSE 0 END), 0) AS available
      FROM inventory i
      LEFT JOIN orders o ON i.sku = o.sku
      GROUP BY i.sku, i.category, i.on_hand
      ORDER BY CASE i.category WHEN '正常库存' THEN 0 ELSE 1 END, i.rowid
    `).all(),
    database.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 200").all(),
    database.prepare("SELECT * FROM operations ORDER BY id DESC LIMIT 300").all(),
  ]);
  return Response.json({ inventory: inventory.results, orders: orders.results, logs: logs.results });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const body = await request.json() as Record<string, unknown>;
  const database = db();

  if (body.action === "sale") {
    const sku = String(body.sku || "");
    const quantity = Number(body.quantity);
    const available = await database.prepare(`
      SELECT i.on_hand - COALESCE(SUM(CASE WHEN o.status IN ('pending', 'scheduled') THEN o.quantity ELSE 0 END), 0) AS available
      FROM inventory i LEFT JOIN orders o ON i.sku = o.sku WHERE i.sku = ? GROUP BY i.on_hand
    `).bind(sku).first<{ available: number }>();
    if (!quantity || quantity < 1) return error("销售数量必须大于 0");
    if (!available || quantity > available.available) return error(`可销售库存不足，目前只剩 ${available?.available ?? 0}`);
    const salesRep = String(body.salesRep || "");
    const customer = String(body.customer || "");
    await database.batch([
      database.prepare(`
        INSERT INTO orders (sales_rep, customer, phone, sku, quantity, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(salesRep, customer, String(body.phone || ""), sku, quantity, String(body.note || "")),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind(salesRep, "销售预留", `${customer} · ${sku} × ${quantity}`),
    ]);
    return Response.json({ ok: true });
  }

  if (body.action === "schedule") {
    const orderId = Number(body.orderId);
    await database.prepare(`
      UPDATE orders SET status = 'scheduled', address = ?, planned_date = ?, driver = ? WHERE id = ? AND status = 'pending'
    `).bind(String(body.address || ""), String(body.plannedDate || ""), String(body.driver || "司机"), orderId).run();
    const order = await database.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<Record<string, unknown>>();
    if (!order) return error("找不到这个销售单", 404);
    await database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
      .bind("采购", "安排送货", `${order.customer} · ${order.sku} × ${order.quantity} · ${order.planned_date}`).run();
    const message = body.language === "en"
      ? [
        `Contact: ${order.customer}`,
        `Phone: ${order.phone || "Not provided"}`,
        `Items: ${order.sku} × ${order.quantity}`,
        `Note: ${order.note || "-"}`,
        `Address: ${order.address}`,
      ].join("\n")
      : [
        `联系人：${order.customer}`,
        `电话：${order.phone || "未提供"}`,
        `货物：${order.sku} × ${order.quantity}`,
        `备注：${order.note || "-"}`,
        `地址：${order.address}`,
      ].join("\n");
    return Response.json({ ok: true, message });
  }

  if (body.action === "deliver") {
    const orderId = Number(body.orderId);
    const order = await database.prepare("SELECT * FROM orders WHERE id = ? AND status = 'scheduled'")
      .bind(orderId).first<{ sku: string; quantity: number; customer: string; driver: string | null }>();
    if (!order) return error("这个任务已经处理或不存在");
    await database.batch([
      database.prepare("UPDATE inventory SET on_hand = on_hand - ?, updated_at = CURRENT_TIMESTAMP WHERE sku = ? AND on_hand >= ?")
        .bind(order.quantity, order.sku, order.quantity),
      database.prepare("UPDATE orders SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(orderId),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind(order.driver || "司机", "确认送达", `${order.customer} · ${order.sku} × ${order.quantity}`),
    ]);
    return Response.json({ ok: true });
  }

  if (body.action === "arrival") {
    const items = Array.isArray(body.items) ? body.items as Array<{ sku: string; quantity: number }> : [];
    if (!items.length) return error("没有可入库的项目");
    for (const item of items) {
      if (!item.sku || !Number.isInteger(item.quantity) || item.quantity < 1) return error("入库内容有误");
    }
    await database.batch([
      ...items.map((item) =>
        database.prepare(`
          INSERT INTO inventory (sku, category, on_hand, updated_at)
          VALUES (?, '正常库存', ?, CURRENT_TIMESTAMP)
          ON CONFLICT(sku) DO UPDATE SET
            on_hand = on_hand + excluded.on_hand,
            updated_at = CURRENT_TIMESTAMP
        `).bind(item.sku.trim(), item.quantity),
      ),
      database.prepare("INSERT INTO arrivals (raw_text, items_json) VALUES (?, ?)")
        .bind(String(body.rawText || ""), JSON.stringify(items)),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("采购", "新货入库", items.map((item) => `${item.sku} +${item.quantity}`).join("，")),
    ]);
    return Response.json({ ok: true });
  }

  return error("不支持的操作", 400);
}

function error(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}
