import { env } from "cloudflare:workers";
import { isEmailAddress, sendGmailSmtp } from "@/app/gmail-smtp";

const ADMIN_COOKIE = "inventory_admin";

type RuntimeEnv = {
  DB: D1Database;
  ADMIN_PASSWORD?: string;
  GMAIL_SMTP_USER?: string;
  GMAIL_SMTP_APP_PASSWORD?: string;
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
  delivery_time: string | null;
  driver: string | null;
  driver_email: string | null;
};

function db() {
  return (env as unknown as RuntimeEnv).DB;
}

function adminPassword() {
  return String((env as unknown as RuntimeEnv).ADMIN_PASSWORD || "");
}

function gmailSmtpSettings() {
  const runtimeEnv = env as unknown as RuntimeEnv;
  return {
    username: String(runtimeEnv.GMAIL_SMTP_USER || "").trim(),
    appPassword: String(runtimeEnv.GMAIL_SMTP_APP_PASSWORD || ""),
  };
}

function formatChineseDeliveryDate(value: string) {
  const match = value.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return value;
  return `${Number(match[1])}月${Number(match[2])}日`;
}

function isDeliveryTime(value: string) {
  return /^(09|1[0-7]):00$/.test(value);
}

function formatDeliveryTime(value: string) {
  if (!isDeliveryTime(value)) return "未提供";
  const hour = Number(value.slice(0, 2));
  return `${hour > 12 ? hour - 12 : hour}:00 ${hour >= 12 ? "PM" : "AM"}`;
}

type DeliveryEmailDetails = {
  driver: string;
  driverEmail: string;
  plannedDate: string;
  deliveryTime: string;
  customer: string;
  phone: string;
  address: string;
  note: string;
  items: Array<{ sku: string; quantity: number }>;
  correction?: boolean;
};

async function sendDeliveryEmail(details: DeliveryEmailDetails) {
  const deliveryDateText = formatChineseDeliveryDate(details.plannedDate);
  const subject = `E3 送货提醒 ${deliveryDateText}需要送货${details.correction ? " 修正" : ""}`;
  const text = [
    `Hello ${details.driver}，`,
    "",
    `送货日期：${deliveryDateText}`,
    `预计送达时间：${formatDeliveryTime(details.deliveryTime)}`,
    `客户名字：${details.customer}`,
    `客户电话：${details.phone || "未提供"}`,
    `送货地址：${details.address}`,
    `备注：${details.note || "无"}`,
    "---------------------",
    "配送物料：",
    ...details.items.map((item) => `${item.sku} × ${item.quantity}`),
    "",
    "系统链接：",
    "https://inventorymanage.percival-0ae.workers.dev/",
  ].join("\n");
  const smtp = gmailSmtpSettings();
  if (!smtp.username || !smtp.appPassword) {
    return { emailSent: false, emailError: "Gmail SMTP 尚未配置" };
  }
  try {
    await sendGmailSmtp({
      username: smtp.username,
      appPassword: smtp.appPassword,
      to: details.driverEmail,
      cc: ["kevin@e3energy.com.au"],
      subject,
      text,
    });
    return { emailSent: true, emailError: "" };
  } catch (smtpError) {
    return {
      emailSent: false,
      emailError: smtpError instanceof Error ? smtpError.message : "Gmail SMTP 发送失败",
    };
  }
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
      ordered_quantity INTEGER NOT NULL DEFAULT 0,
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
      delivery_time TEXT,
      driver TEXT,
      driver_email TEXT,
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
  if (!inventoryColumns.results.some((column) => column.name === "ordered_quantity")) {
    await database.prepare("ALTER TABLE inventory ADD COLUMN ordered_quantity INTEGER NOT NULL DEFAULT 0").run();
    const arrivalRows = await database.prepare("SELECT items_json FROM arrivals ORDER BY id")
      .all<{ items_json: string }>();
    const orderedBySku = new Map<string, number>();
    for (const row of arrivalRows.results) {
      try {
        const parsed = JSON.parse(row.items_json) as
          | Array<{ sku?: unknown; quantity?: unknown }>
          | { mode?: unknown; items?: unknown };
        const mode = !Array.isArray(parsed) && parsed.mode === "ordered" ? "ordered" : "received";
        const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
        for (const rawItem of items) {
          if (!rawItem || typeof rawItem !== "object") continue;
          const item = rawItem as { sku?: unknown; quantity?: unknown };
          const sku = String(item.sku || "").trim();
          const quantity = Number(item.quantity);
          if (!sku || !Number.isInteger(quantity) || quantity < 1) continue;
          const current = orderedBySku.get(sku) || 0;
          orderedBySku.set(sku, mode === "ordered" ? current + quantity : Math.max(0, current - quantity));
        }
      } catch {
        // Keep malformed legacy arrival records from blocking database startup.
      }
    }
    const backfillStatements = [...orderedBySku.entries()]
      .filter(([, quantity]) => quantity > 0)
      .map(([sku, quantity]) =>
        database.prepare("UPDATE inventory SET ordered_quantity = ? WHERE sku = ? AND status = '订购中'")
          .bind(quantity, sku),
      );
    if (backfillStatements.length) await database.batch(backfillStatements);
  }
  const orderColumns = await database.prepare("PRAGMA table_info(orders)").all<{ name: string }>();
  if (!orderColumns.results.some((column) => column.name === "order_group")) {
    await database.prepare("ALTER TABLE orders ADD COLUMN order_group TEXT").run();
  }
  if (!orderColumns.results.some((column) => column.name === "driver_email")) {
    await database.prepare("ALTER TABLE orders ADD COLUMN driver_email TEXT").run();
  }
  if (!orderColumns.results.some((column) => column.name === "delivery_time")) {
    await database.prepare("ALTER TABLE orders ADD COLUMN delivery_time TEXT").run();
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
  await database.prepare(`
    UPDATE inventory
    SET
      on_hand = on_hand + ordered_quantity,
      ordered_quantity = 0,
      updated_at = CURRENT_TIMESTAMP
    WHERE status <> '订购中' AND ordered_quantity > 0
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
        i.ordered_quantity + COALESCE(SUM(CASE WHEN o.status IN ('pending', 'scheduled') THEN o.quantity ELSE 0 END), 0) AS pending,
        i.on_hand - COALESCE(SUM(CASE WHEN o.status IN ('pending', 'scheduled') THEN o.quantity ELSE 0 END), 0) AS available
      FROM inventory i
      LEFT JOIN orders o ON i.sku = o.sku
      GROUP BY i.sku, i.category, i.status, i.on_hand, i.ordered_quantity
      ORDER BY CASE WHEN i.status = '订购中' THEN 0 ELSE 1 END, i.rowid
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
    if (!["充足", "积压", "低库存", "订购中"].includes(status)) return error("库存状态无效");
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
    const deliveryTime = String(body.deliveryTime || "").trim();
    if (!address) return error("请填写送货地址");
    if (!isDeliveryTime(deliveryTime)) return error("请选择 9:00 AM 至 5:00 PM 的预计送达时间");
    const orderGroup = crypto.randomUUID();
    await database.batch([
      ...items.map((item) =>
        database.prepare(`
          INSERT INTO orders (order_group, sales_rep, customer, phone, address, delivery_time, sku, quantity, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(orderGroup, salesRep, customer, String(body.phone || ""), address, deliveryTime, item.sku, item.quantity, String(body.note || "")),
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
    if (!["充足", "积压", "低库存", "订购中"].includes(status)) return error("库存状态无效");
    const item = await database.prepare(`
      SELECT sku, status, ordered_quantity
      FROM inventory
      WHERE sku = ?
    `).bind(sku).first<{ sku: string; status: string; ordered_quantity: number }>();
    if (!item) return error("找不到这个型号", 404);
    const receivedQuantity = status !== "订购中"
      ? item.ordered_quantity
      : 0;
    await database.batch([
      database.prepare(`
        UPDATE inventory
        SET
          status = ?,
          on_hand = on_hand + CASE WHEN ? <> '订购中' THEN ordered_quantity ELSE 0 END,
          ordered_quantity = CASE WHEN ? <> '订购中' THEN 0 ELSE ordered_quantity END,
          updated_at = CURRENT_TIMESTAMP
        WHERE sku = ?
      `).bind(status, status, status, sku),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("采购", "更改状态", `${sku} → ${status}${receivedQuantity ? ` · 入库 +${receivedQuantity}` : ""}`),
    ]);
    return Response.json({ ok: true, receivedQuantity });
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
    const address = String(body.address || "").trim();
    const plannedDate = String(body.plannedDate || "").trim();
    const driver = String(body.driver || "陈师傅").trim();
    const driverEmail = String(body.driverEmail || "cyp81183456@gmail.com").trim();
    if (!address || !plannedDate || !driver) return error("请完整填写送货安排");
    if (!isEmailAddress(driverEmail)) return error("请输入有效的司机邮箱");
    const itemText = orderRows.results.map((order) => `${order.sku} × ${order.quantity}`).join("，");
    await database.batch([
      ...orderIds.map((orderId) =>
        database.prepare(`
          UPDATE orders
          SET status = 'scheduled', address = ?, planned_date = ?, driver = ?, driver_email = ?
          WHERE id = ? AND status = 'pending'
        `).bind(address, plannedDate, driver, driverEmail, orderId),
      ),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("采购", "安排送货", `${firstOrder.customer} · ${itemText} · ${plannedDate}`),
    ]);
    const { emailSent, emailError } = await sendDeliveryEmail({
      driver,
      driverEmail,
      plannedDate,
      deliveryTime: firstOrder.delivery_time || "",
      customer: firstOrder.customer,
      phone: firstOrder.phone || "",
      address,
      note: firstOrder.note || "",
      items: orderRows.results,
    });
    await database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
      .bind("采购", emailSent ? "邮件通知" : "邮件失败", `${driver} · ${driverEmail} · ${firstOrder.customer}${emailError ? ` · ${emailError}` : ""}`)
      .run();
    return Response.json({ ok: true, emailSent, emailError });
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
    const deliveryTime = String(body.deliveryTime || "").trim();
    const driver = String(body.driver || "").trim();
    const driverEmail = String(body.driverEmail || "").trim();
    const salesRep = String(body.salesRep || "").trim();
    const note = String(body.note || "").trim();
    if (!customer || !address || !plannedDate || !driver || !driverEmail || !salesRep) return error("请完整填写任务内容");
    if (!isDeliveryTime(deliveryTime)) return error("请选择 9:00 AM 至 5:00 PM 的预计送达时间");
    if (!isEmailAddress(driverEmail)) return error("请输入有效的司机邮箱");

    const orderGroup = firstOrder.order_group || crypto.randomUUID();
    const itemText = items.map((item) => `${item.sku} × ${item.quantity}`).join("，");
    await database.batch([
      database.prepare(`DELETE FROM orders WHERE id IN (${placeholders}) AND status = 'scheduled'`).bind(...orderIds),
      ...items.map((item) =>
        database.prepare(`
          INSERT INTO orders (
            order_group, sales_rep, customer, phone, sku, quantity, created_at,
            status, address, planned_date, delivery_time, driver, driver_email, note
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)
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
          deliveryTime,
          driver,
          driverEmail,
          note,
        ),
      ),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind("采购", "修改任务", `${customer} · ${itemText} · ${plannedDate}`),
    ]);
    const { emailSent, emailError } = await sendDeliveryEmail({
      driver,
      driverEmail,
      plannedDate,
      deliveryTime,
      customer,
      phone,
      address,
      note,
      items,
      correction: true,
    });
    await database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
      .bind(
        "采购",
        emailSent ? "邮件通知" : "邮件失败",
        `${driver} · ${driverEmail} · ${customer} · 修正${emailError ? ` · ${emailError}` : ""}`,
      )
      .run();
    return Response.json({ ok: true, emailSent, emailError });
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
    const mode = body.mode === "ordered" ? "ordered" : "received";
    if (!items.length) return error("没有可入库的项目");
    for (const item of items) {
      if (!item.sku || !Number.isInteger(item.quantity) || item.quantity < 1 || !["电池", "太阳能板", "逆变器", "安装配件", "其他"].includes(item.category)) return error("入库内容有误");
    }
    const inventoryStatements = mode === "ordered"
      ? items.map((item) =>
        database.prepare(`
          INSERT INTO inventory (sku, category, status, on_hand, ordered_quantity, updated_at)
          VALUES (?, ?, '订购中', 0, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(sku) DO UPDATE SET
            category = excluded.category,
            status = '订购中',
            ordered_quantity = ordered_quantity + excluded.ordered_quantity,
            updated_at = CURRENT_TIMESTAMP
        `).bind(item.sku.trim(), item.category, item.quantity),
      )
      : items.map((item) =>
        database.prepare(`
          INSERT INTO inventory (sku, category, on_hand, ordered_quantity, updated_at)
          VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
          ON CONFLICT(sku) DO UPDATE SET
            on_hand = on_hand + excluded.on_hand,
            ordered_quantity = MAX(0, ordered_quantity - excluded.on_hand),
            category = excluded.category,
            updated_at = CURRENT_TIMESTAMP
        `).bind(item.sku.trim(), item.category, item.quantity),
      );
    await database.batch([
      ...inventoryStatements,
      database.prepare("INSERT INTO arrivals (raw_text, items_json) VALUES (?, ?)")
        .bind(String(body.rawText || ""), JSON.stringify({ mode, items })),
      database.prepare("INSERT INTO operations (actor, action, detail) VALUES (?, ?, ?)")
        .bind(
          "采购",
          mode === "ordered" ? "提交订购" : "新货入库",
          items.map((item) => `${item.sku} ${mode === "ordered" ? "×" : "+"}${item.quantity}`).join("，"),
        ),
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
