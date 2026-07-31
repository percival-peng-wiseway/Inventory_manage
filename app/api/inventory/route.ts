import { env } from "cloudflare:workers";

const ADMIN_COOKIE = "inventory_admin";

type RuntimeEnv = {
  DB: D1Database;
  ADMIN_PASSWORD?: string;
};
type OrderActionRow = {
  id: number;
  order_group: string | null;
  sales_rep: string;
  customer: string;
  phone: string | null;
  sku: string;
  quantity: number;
  created_at: string;
  note: string | null;
  address: string | null;
  planned_date: string | null;
  driver: string | null;
};

function db() {
  return (env as unknown as RuntimeEnv).DB;
}

function adminPassword() {
  return String((env as unknown as RuntimeEnv).ADMIN_PASSWORD || "");
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
      order_group TEXT,
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
  const orderColumns = await database.prepare("PRAGMA table_info(orders)").all<{ name: string }>();
  if (!orderColumns.results.some((column) => column.name === "order_group")) {
    await database.prepare("ALTER TABLE orders ADD COLUMN order_group TEXT").run();
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

}

export async function GET(request: Request) {
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
  return Response.json({
    inventory: inventory.results,
    orders: orders.results,
    logs: logs.results,
    admin: await isAdminRequest(request),
  });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const body = await request.json() as Record<string, unknown>;
  const database = db();

  if (body.action === "adminLogin") {
    const password = adminPassword();
    if (!password) return error("管理员密码尚未配置", 503);
    if (String(body.password || "") !== password) return error("管理员密码错误", 401);
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": `${ADMIN_COOKIE}=${await adminToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800` } },
    );
  }

  if (body.action === "adminLogout") {
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` } },
    );
  }

  if (body.action === "editInventory") {
    if (!await isAdminRequest(request)) return error("需要管理员权限", 403);
    const originalSku = String(body.originalSku || "").trim();
    const sku = String(body.sku || "").trim();
    const category = String(body.category || "");
    const status = String(body.status || "");
    const onHand = Number(body.onHand);
    if (!originalSku || !sku) return error("型号无效");
    if (!["电池", "太阳能板", "逆变器", "安装配件", "其他"].includes(category)) return error("库存类别无效");
    if (!["充足", "积压", "低库存"].includes(status)) return error("库存状态无效");
    if (!Number.isInteger(onHand) || onHand < 0) return error("实际库存必须是非负整数");

    const item = await database.prepare("SELECT sku FROM inventory WHERE sku = ?")
      .bind(originalSku).first<{ sku: string }>();
    if (!item) return error("找不到这个型号", 404);
    if (sku !== originalSku) {
      const duplicate = await database.prepare("SELECT sku FROM inventory WHERE sku = ?")
        .bind(sku).first<{ sku: string }>();
      if (duplicate) return error("新型号已经存在");
    }

    const reserved = await database.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS quantity
      FROM orders
      WHERE sku = ? AND status IN ('pending', 'scheduled')
    `).bind(originalSku).first<{ quantity: number }>();
    if (onHand < (reserved?.quantity || 0)) {
      return error(`实际库存不能低于已预留数量 ${reserved?.quantity || 0}`);
    }

    await database.batch([
      database.prepare(`
        UPDATE inventory
        SET sku = ?, category = ?, status = ?, on_hand = ?, updated_at = CURRENT_TIMESTAMP
        WHERE sku = ?
      `).bind(sku, category, status, onHand, originalSku),
      database.prepare("UPDATE orders SET sku = ? WHERE sku = ?").bind(sku, originalSku),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("管理员", "修改库存", `${originalSku} → ${sku} · ${category} · ${onHand} · ${status}`),
    ]);
    return Response.json({ ok: true });
  }

  if (body.action === "deleteSku") {
    if (!await isAdminRequest(request)) return error("需要管理员权限", 403);
    const sku = String(body.sku || "").trim();
    if (!sku) return error("型号无效");
    const activeOrders = await database.prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE sku = ? AND status IN ('pending', 'scheduled')",
    ).bind(sku).first<{ count: number }>();
    if (activeOrders?.count) return error("此型号仍有 Pending 或待送订单，暂时不能删除");
    const item = await database.prepare("SELECT sku FROM inventory WHERE sku = ?").bind(sku).first();
    if (!item) return error("找不到这个型号", 404);
    await database.batch([
      database.prepare("DELETE FROM inventory WHERE sku = ?").bind(sku),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("管理员", "删除型号", sku),
    ]);
    return Response.json({ ok: true });
  }

  if (body.action === "deleteLog") {
    if (!await isAdminRequest(request)) return error("需要管理员权限", 403);
    const logId = Number(body.logId);
    if (!Number.isInteger(logId) || logId < 1) return error("日志无效");
    await database.prepare("DELETE FROM operations WHERE id = ?").bind(logId).run();
    return Response.json({ ok: true });
  }

  if (body.action === "clearLogs") {
    if (!await isAdminRequest(request)) return error("需要管理员权限", 403);
    await database.prepare("DELETE FROM operations").run();
    return Response.json({ ok: true });
  }

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
    const address = String(body.address || "").trim();
    if (!address) return error("请填写送货地址");
    const orderGroup = crypto.randomUUID();
    await database.batch([
      ...items.map((item) =>
        database.prepare(`
          INSERT INTO orders (order_group, sales_rep, customer, phone, address, sku, quantity, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(orderGroup, salesRep, customer, String(body.phone || ""), address, item.sku, item.quantity, String(body.note || "")),
      ),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind(salesRep, "销售预留", `${customer} · ${items.map((item) => `${item.sku} × ${item.quantity}`).join("，")}`),
    ]);
    return Response.json({ ok: true });
  }

  if (body.action === "setStatus") {
    if (!await isAdminRequest(request)) return error("需要管理员权限", 403);
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
    const orderIds = readOrderIds(body);
    if (!orderIds.length) return error("找不到这个订单");
    const placeholders = orderIds.map(() => "?").join(",");
    const orderRows = await database.prepare(`SELECT * FROM orders WHERE id IN (${placeholders}) AND status = 'pending' ORDER BY id`)
      .bind(...orderIds).all<OrderActionRow>();
    if (orderRows.results.length !== orderIds.length) return error("这个订单已经处理或不存在");
    const firstOrder = orderRows.results[0];
    const itemText = orderRows.results.map((order) => `${order.sku} × ${order.quantity}`).join("，");
    await database.batch([
      ...orderIds.map((orderId) =>
        database.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").bind(orderId),
      ),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("采购", "删除订单", `${firstOrder.customer} · ${itemText}`),
    ]);
    return Response.json({ ok: true });
  }

  if (body.action === "cancelDelivery") {
    if (!await isAdminRequest(request)) return error("需要管理员权限", 403);
    const orderIds = readOrderIds(body);
    if (!orderIds.length) return error("找不到这个送货订单");
    const placeholders = orderIds.map(() => "?").join(",");
    const orderRows = await database.prepare(
      `SELECT * FROM orders WHERE id IN (${placeholders}) AND status = 'scheduled' ORDER BY id`,
    ).bind(...orderIds).all<OrderActionRow>();
    if (orderRows.results.length !== orderIds.length) return error("这个送货订单已经处理或不存在");

    const firstOrder = orderRows.results[0];
    const itemText = orderRows.results.map((order) => `${order.sku} × ${order.quantity}`).join("，");
    await database.batch([
      ...orderIds.map((orderId) =>
        database.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'").bind(orderId),
      ),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("管理员", "取消送货", `${firstOrder.customer} · ${itemText}`),
    ]);
    return Response.json({ ok: true });
  }

  if (body.action === "schedule") {
    const orderIds = readOrderIds(body);
    if (!orderIds.length) return error("找不到这个销售单", 404);
    const placeholders = orderIds.map(() => "?").join(",");
    const orderRows = await database.prepare(`SELECT * FROM orders WHERE id IN (${placeholders}) AND status = 'pending' ORDER BY id`)
      .bind(...orderIds).all<OrderActionRow>();
    if (orderRows.results.length !== orderIds.length) return error("这个销售单已经处理或不存在");
    const firstOrder = orderRows.results[0];
    const address = String(body.address || "");
    const plannedDate = String(body.plannedDate || "");
    const driver = String(body.driver || "司机");
    const itemText = orderRows.results.map((order) => `${order.sku} × ${order.quantity}`).join("，");
    await database.batch([
      ...orderIds.map((orderId) =>
        database.prepare(`
          UPDATE orders SET status = 'scheduled', address = ?, planned_date = ?, driver = ? WHERE id = ? AND status = 'pending'
        `).bind(address, plannedDate, driver, orderId),
      ),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("采购", "安排送货", `${firstOrder.customer} · ${itemText} · ${plannedDate}`),
    ]);
    const message = body.language === "en"
      ? [
        `Contact: ${firstOrder.customer}`,
        `Phone: ${firstOrder.phone || "Not provided"}`,
        `Items: ${orderRows.results.map((order) => `${order.sku} × ${order.quantity}`).join(", ")}`,
        `Note: ${firstOrder.note || "-"}`,
        `Address: ${address}`,
      ].join("\n")
      : [
        `联系人：${firstOrder.customer}`,
        `电话：${firstOrder.phone || "未提供"}`,
        `货物：${itemText}`,
        `备注：${firstOrder.note || "-"}`,
        `地址：${address}`,
      ].join("\n");
    return Response.json({ ok: true, message });
  }

  if (body.action === "editTask") {
    const orderIds = readOrderIds(body);
    if (!orderIds.length) return error("找不到这个任务");
    const placeholders = orderIds.map(() => "?").join(",");
    const orderRows = await database.prepare(
      `SELECT * FROM orders WHERE id IN (${placeholders}) AND status = 'scheduled' ORDER BY id`,
    ).bind(...orderIds).all<OrderActionRow>();
    if (orderRows.results.length !== orderIds.length) return error("这个任务已经处理或不存在");

    const requestedItems = Array.isArray(body.items)
      ? body.items as Array<{ sku: string; quantity: number }>
      : [];
    const merged = new Map<string, number>();
    for (const item of requestedItems) {
      const sku = String(item.sku || "").trim();
      const quantity = Number(item.quantity);
      if (!sku || !Number.isInteger(quantity) || quantity < 1) return error("商品型号或数量有误");
      merged.set(sku, (merged.get(sku) || 0) + quantity);
    }
    const items = [...merged.entries()].map(([sku, quantity]) => ({ sku, quantity }));
    if (!items.length) return error("请至少保留一个商品");

    for (const item of items) {
      const available = await database.prepare(`
        SELECT i.on_hand - COALESCE(SUM(
          CASE
            WHEN o.status IN ('pending', 'scheduled') AND o.id NOT IN (${placeholders}) THEN o.quantity
            ELSE 0
          END
        ), 0) AS available
        FROM inventory i
        LEFT JOIN orders o ON i.sku = o.sku
        WHERE i.sku = ?
        GROUP BY i.on_hand
      `).bind(...orderIds, item.sku).first<{ available: number }>();
      if (!available || item.quantity > available.available) {
        return error(`${item.sku} 可用库存不足，目前最多可安排 ${available?.available ?? 0}`);
      }
    }

    const firstOrder = orderRows.results[0];
    const customer = String(body.customer || "").trim();
    const phone = String(body.phone || "").trim();
    const address = String(body.address || "").trim();
    const plannedDate = String(body.plannedDate || "").trim();
    const driver = String(body.driver || "").trim();
    const salesRep = String(body.salesRep || "").trim();
    const note = String(body.note || "").trim();
    if (!customer || !address || !plannedDate || !driver || !salesRep) return error("请完整填写任务内容");

    const orderGroup = firstOrder.order_group || crypto.randomUUID();
    const itemText = items.map((item) => `${item.sku} × ${item.quantity}`).join("，");
    await database.batch([
      database.prepare(`DELETE FROM orders WHERE id IN (${placeholders}) AND status = 'scheduled'`).bind(...orderIds),
      ...items.map((item) =>
        database.prepare(`
          INSERT INTO orders (
            order_group, sales_rep, customer, phone, sku, quantity, created_at,
            status, address, planned_date, driver, note
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)
        `).bind(
          orderGroup,
          salesRep,
          customer,
          phone,
          item.sku,
          item.quantity,
          firstOrder.created_at,
          address,
          plannedDate,
          driver,
          note,
        ),
      ),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("采购", "修改任务", `${customer} · ${itemText} · ${plannedDate}`),
    ]);
    return Response.json({ ok: true });
  }

  if (body.action === "deliver") {
    const orderIds = readOrderIds(body);
    if (!orderIds.length) return error("找不到这个任务");
    const placeholders = orderIds.map(() => "?").join(",");
    const orderRows = await database.prepare(`SELECT * FROM orders WHERE id IN (${placeholders}) AND status = 'scheduled' ORDER BY id`)
      .bind(...orderIds).all<OrderActionRow>();
    if (orderRows.results.length !== orderIds.length) return error("这个任务已经处理或不存在");
    const firstOrder = orderRows.results[0];
    const itemText = orderRows.results.map((order) => `${order.sku} × ${order.quantity}`).join("，");
    await database.batch([
      ...orderRows.results.map((order) =>
        database.prepare("UPDATE inventory SET on_hand = on_hand - ?, updated_at = CURRENT_TIMESTAMP WHERE sku = ? AND on_hand >= ?")
          .bind(order.quantity, order.sku, order.quantity),
      ),
      ...orderIds.map((orderId) =>
        database.prepare("UPDATE orders SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP WHERE id = ?").bind(orderId),
      ),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind(firstOrder.driver || "司机", "确认送达", `${firstOrder.customer} · ${itemText}`),
    ]);
    return Response.json({ ok: true });
  }

  if (body.action === "arrival") {
    const items = Array.isArray(body.items) ? body.items as Array<{ sku: string; quantity: number; category: string }> : [];
    if (!items.length) return error("没有可入库的项目");
    for (const item of items) {
      if (!item.sku || !Number.isInteger(item.quantity) || item.quantity < 1 || !["电池", "太阳能板", "逆变器", "安装配件", "其他"].includes(item.category)) return error("入库内容有误");
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

function readOrderIds(body: Record<string, unknown>) {
  const rawIds = Array.isArray(body.orderIds) ? body.orderIds : [body.orderId];
  return [...new Set(rawIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

async function adminToken() {
  const password = adminPassword();
  if (!password) return "";
  const bytes = new TextEncoder().encode(`inventory-admin:${password}:local-session`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function isAdminRequest(request: Request) {
  const password = adminPassword();
  if (!password) return false;
  const cookie = request.headers.get("Cookie") || "";
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);
  return Boolean(token) && token === await adminToken();
}
