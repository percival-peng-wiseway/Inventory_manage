import { env } from "cloudflare:workers";

const seedItems = [
  ["KH10", "电池", 11, "充足"],
  ["KH8", "电池", 17, "充足"],
  ["H3 10.0", "电池", 7, "充足"],
  ["H3 125", "电池", 1, "低库存"],
  ["H1 5.0", "电池", 5, "低库存"],
  ["H3 15.0", "电池", 4, "低库存"],
  ["CQ7 S", "电池", 190, "充足"],
  ["CQ7 M", "电池", 35, "充足"],
  ["CQ7 M V6+", "电池", 7, "充足"],
  ["EQ4800 S", "电池", 3, "积压"],
  ["JAM 440", "电池", 8, "积压"],
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
      status TEXT NOT NULL DEFAULT '充足',
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

  const inventoryColumns = await database.prepare("PRAGMA table_info(inventory)").all<{ name: string }>();
  if (!inventoryColumns.results.some((column) => column.name === "status")) {
    await database.prepare("ALTER TABLE inventory ADD COLUMN status TEXT NOT NULL DEFAULT '充足'").run();
  }
  await database.prepare(`
    UPDATE inventory
    SET
      status = CASE
        WHEN category = '积存库存' THEN '积压'
        WHEN on_hand <= 5 THEN '低库存'
        ELSE '充足'
      END,
      category = '电池'
    WHERE category IN ('正常库存', '积存库存')
  `).run();

  const count = await database.prepare("SELECT COUNT(*) AS count FROM inventory").first<{ count: number }>();
  if (!count?.count) {
    await database.batch(
      [
        ...seedItems.map(([sku, category, quantity, status]) =>
          database.prepare("INSERT INTO inventory (sku, category, on_hand, status) VALUES (?, ?, ?, ?)").bind(sku, category, quantity, status),
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
        i.status,
        i.on_hand,
        COALESCE(SUM(CASE WHEN o.status IN ('pending', 'scheduled') THEN o.quantity ELSE 0 END), 0) AS pending,
        i.on_hand - COALESCE(SUM(CASE WHEN o.status IN ('pending', 'scheduled') THEN o.quantity ELSE 0 END), 0) AS available
      FROM inventory i
      LEFT JOIN orders o ON i.sku = o.sku
      GROUP BY i.sku, i.category, i.status, i.on_hand
      ORDER BY i.rowid
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
    const requestedItems = Array.isArray(body.items)
      ? body.items as Array<{ sku: string; quantity: number }>
      : [{ sku: String(body.sku || ""), quantity: Number(body.quantity) }];
    const merged = new Map<string, number>();
    for (const item of requestedItems) {
      const sku = String(item.sku || "").trim();
      const quantity = Number(item.quantity);
      if (!sku || !Number.isInteger(quantity) || quantity < 1) return error("商品型号或数量有误");
      merged.set(sku, (merged.get(sku) || 0) + quantity);
    }
    const items = [...merged.entries()].map(([sku, quantity]) => ({ sku, quantity }));
    if (!items.length) return error("请至少添加一个商品");

    for (const item of items) {
      const available = await database.prepare(`
        SELECT i.on_hand - COALESCE(SUM(CASE WHEN o.status IN ('pending', 'scheduled') THEN o.quantity ELSE 0 END), 0) AS available
        FROM inventory i LEFT JOIN orders o ON i.sku = o.sku WHERE i.sku = ? GROUP BY i.on_hand
      `).bind(item.sku).first<{ available: number }>();
      if (!available || item.quantity > available.available) {
        return error(`${item.sku} 可销售库存不足，目前只剩 ${available?.available ?? 0}`);
      }
    }

    const salesRep = String(body.salesRep || "");
    const customer = String(body.customer || "");
    await database.batch([
      ...items.map((item) =>
        database.prepare(`
          INSERT INTO orders (sales_rep, customer, phone, sku, quantity, note)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(salesRep, customer, String(body.phone || ""), item.sku, item.quantity, String(body.note || "")),
      ),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind(salesRep, "销售预留", `${customer} · ${items.map((item) => `${item.sku} × ${item.quantity}`).join("，")}`),
    ]);
    return Response.json({ ok: true });
  }

  if (body.action === "setStatus") {
    const sku = String(body.sku || "").trim();
    const status = String(body.status || "");
    if (!["充足", "积压", "低库存"].includes(status)) return error("库存状态无效");
    const item = await database.prepare("SELECT sku FROM inventory WHERE sku = ?").bind(sku).first();
    if (!item) return error("找不到这个型号", 404);
    await database.batch([
      database.prepare("UPDATE inventory SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE sku = ?").bind(status, sku),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("采购", "更改状态", `${sku} → ${status}`),
    ]);
    return Response.json({ ok: true });
  }

  if (body.action === "cancelOrder") {
    const orderId = Number(body.orderId);
    const order = await database.prepare("SELECT customer, sku, quantity FROM orders WHERE id = ? AND status = 'pending'")
      .bind(orderId).first<{ customer: string; sku: string; quantity: number }>();
    if (!order) return error("这个订单已经处理或不存在");
    await database.batch([
      database.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").bind(orderId),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("采购", "删除订单", `${order.customer} · ${order.sku} × ${order.quantity}`),
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
    const items = Array.isArray(body.items) ? body.items as Array<{ sku: string; quantity: number; category: string }> : [];
    if (!items.length) return error("没有可入库的项目");
    for (const item of items) {
      if (!item.sku || !Number.isInteger(item.quantity) || item.quantity < 1 || !["电池", "太阳能板", "安装配件", "其他"].includes(item.category)) return error("入库内容有误");
    }
    await database.batch([
      ...items.map((item) =>
        database.prepare(`
          INSERT INTO inventory (sku, category, on_hand, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(sku) DO UPDATE SET
            on_hand = on_hand + excluded.on_hand,
            category = excluded.category,
            updated_at = CURRENT_TIMESTAMP
        `).bind(item.sku.trim(), item.category, item.quantity),
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
