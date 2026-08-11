import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);
const routeUrl = new URL("../app/api/inventory/route.ts", import.meta.url);
const cssUrl = new URL("../app/globals.css", import.meta.url);
const smtpUrl = new URL("../app/gmail-smtp.ts", import.meta.url);
const schemaUrl = new URL("../db/schema.ts", import.meta.url);
const smtpMigrationUrl = new URL("../drizzle/0005_green_marrow.sql", import.meta.url);
const deliveryTimeMigrationUrl = new URL("../drizzle/0006_purple_surge.sql", import.meta.url);
const wranglerUrl = new URL("../wrangler.jsonc", import.meta.url);
const orderedQuantityMigrationUrl = new URL("../drizzle/0004_grey_gambit.sql", import.meta.url);

test("receive-stock confirmation supports receipt and ordering", async () => {
  const page = await readFile(pageUrl, "utf8");

  assert.match(page, /type ArrivalMode = "received" \| "ordered"/);
  assert.match(page, /action: "arrival", mode: arrivalMode/);
  assert.match(page, /value="received"/);
  assert.match(page, /value="ordered"/);
  assert.match(page, /确认订购/);
  assert.match(page, /加入 Pending，不增加实际库存/);
});

test("new-order form keeps a stable form reference across the async request", async () => {
  const page = await readFile(pageUrl, "utf8");

  assert.match(page, /const formElement = event\.currentTarget;/);
  assert.match(page, /const form = new FormData\(formElement\);/);
  assert.match(page, /await mutate\([\s\S]*?formElement\.reset\(\);/);
  assert.doesNotMatch(page, /event\.currentTarget\.reset\(\)/);
});

test("on-order stock is pinned and uses the light-red status treatment", async () => {
  const [page, route, css] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(routeUrl, "utf8"),
    readFile(cssUrl, "utf8"),
  ]);

  assert.match(page, /orderingPriority[\s\S]*status === "订购中"/);
  assert.match(route, /ORDER BY CASE WHEN i\.status = '订购中' THEN 0 ELSE 1 END/);
  assert.match(page, /if \(status === "订购中"\) return "status-ordering"/);
  assert.match(css, /\.status-ordering\s*\{[^}]*background:\s*#fde8e6[^}]*border-color:\s*#efc1bc/);
});

test("ordering moves quantities through pending into on-hand stock", async () => {
  const [route, migration] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(orderedQuantityMigrationUrl, "utf8"),
  ]);

  assert.match(route, /VALUES \(\?, \?, '订购中', 0, \?, CURRENT_TIMESTAMP\)/);
  assert.match(route, /ordered_quantity = ordered_quantity \+ excluded\.ordered_quantity/);
  assert.match(route, /i\.ordered_quantity \+ COALESCE\(SUM[\s\S]*AS pending/);
  assert.match(route, /on_hand = on_hand \+ excluded\.on_hand/);
  assert.match(route, /ordered_quantity = MAX\(0, ordered_quantity - excluded\.on_hand\)/);
  assert.match(migration, /UPDATE `inventory`[\s\S]*SET `ordered_quantity` = MAX/);
  assert.match(migration, /json_extract\(`arrivals`\.`items_json`, '\$\.mode'\) = 'ordered'/);
});

test("direct status changes remain admin-only", async () => {
  const route = await readFile(routeUrl, "utf8");

  const setStatusBlock = route.match(/if \(body\.action === "setStatus"\)[\s\S]*?return Response\.json\(\{ ok: true, receivedQuantity \}\);/)?.[0] ?? "";
  assert.match(setStatusBlock, /if \(!await isAdminRequest\(request\)\) return error\("需要管理员权限", 403\)/);
  assert.match(setStatusBlock, /"订购中"/);
  assert.match(setStatusBlock, /on_hand = on_hand \+ CASE WHEN \? <> '订购中'/);
  assert.match(setStatusBlock, /ordered_quantity = CASE WHEN \? <> '订购中'[\s\S]*THEN 0/);
  assert.match(setStatusBlock, /return Response\.json\(\{ ok: true, receivedQuantity \}\)/);
  assert.match(route, /WHERE status <> '订购中' AND ordered_quantity > 0/);
});

test("admins can edit on-hand, pending, and available inventory values safely", async () => {
  const [page, route] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(routeUrl, "utf8"),
  ]);

  assert.match(route, /AS reserved/);
  const editInventoryBlock = route.match(/if \(body\.action === "editInventory"\)[\s\S]*?return Response\.json\(\{ ok: true \}\);/)?.[0] ?? "";
  assert.match(editInventoryBlock, /if \(!await isAdminRequest\(request\)\) return error\("需要管理员权限", 403\)/);
  assert.match(editInventoryBlock, /const pending = Number\(body\.pending\)/);
  assert.match(editInventoryBlock, /const available = Number\(body\.available\)/);
  assert.match(editInventoryBlock, /pending < reservedQuantity/);
  assert.match(editInventoryBlock, /available !== onHand - reservedQuantity/);
  assert.match(editInventoryBlock, /orderedQuantity = pending - reservedQuantity/);
  assert.match(editInventoryBlock, /ordered_quantity = \?/);
  assert.match(page, /name="onHand"[\s\S]*?value=\{editingInventory\.on_hand\}/);
  assert.match(page, /name="pending"[\s\S]*?value=\{editingInventory\.pending\}/);
  assert.match(page, /name="available"[\s\S]*?value=\{editingInventory\.available\}/);
  assert.match(page, /pending: Number\(form\.get\("pending"\)\)/);
  assert.match(page, /available: Number\(form\.get\("available"\)\)/);
});

test("dispatch stores the driver email and sends the preset order email through Gmail SMTP", async () => {
  const [page, route, smtp, schema, migration, wrangler] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(routeUrl, "utf8"),
    readFile(smtpUrl, "utf8"),
    readFile(schemaUrl, "utf8"),
    readFile(smtpMigrationUrl, "utf8"),
    readFile(wranglerUrl, "utf8"),
  ]);

  assert.match(page, /name="driverEmail" type="email"/);
  assert.match(page, /driverEmail: form\.get\("driverEmail"\)/);
  assert.match(page, /result\.emailSent/);
  assert.doesNotMatch(page, /className="message-box"/);
  assert.doesNotMatch(page, /copyMessage/);
  assert.match(route, /if \(!isEmailAddress\(driverEmail\)\) return error\("请输入有效的司机邮箱"\)/);
  assert.match(route, /driver_email = \?/);
  assert.match(route, /await sendGmailSmtp\(\{/);
  assert.match(route, /cc: \["kevin@e3energy\.com\.au"\]/);
  assert.match(route, /E3 送货提醒 \$\{deliveryDateText\}需要送货/);
  assert.match(route, /Hello \$\{details\.driver\}，/);
  assert.match(route, /送货日期：\$\{deliveryDateText\}/);
  assert.match(route, /客户名字：\$\{details\.customer\}/);
  assert.match(route, /配送物料：/);
  assert.match(route, /系统链接：/);
  assert.match(route, /https:\/\/inventorymanage\.percival-0ae\.workers\.dev\//);
  assert.match(page, /name="driver" defaultValue="陈师傅"/);
  assert.match(page, /name="driverEmail" type="email" autoComplete="email" defaultValue="cyp81183456@gmail\.com"/);
  assert.match(route, /body\.driver \|\| "陈师傅"/);
  assert.match(route, /body\.driverEmail \|\| "cyp81183456@gmail\.com"/);
  assert.match(route, /return Response\.json\(\{ ok: true, emailSent, emailError \}\)/);
  assert.match(smtp, /from "cloudflare:sockets"/);
  assert.match(smtp, /port: SMTP_PORT/);
  assert.match(smtp, /secureTransport: "on"/);
  assert.match(smtp, /AUTH LOGIN/);
  assert.match(smtp, /Cc: \$\{cc\.map/);
  assert.match(schema, /driverEmail: text\("driver_email"\)/);
  assert.match(migration, /ALTER TABLE `orders` ADD `driver_email` text/);
  assert.match(wrangler, /"GMAIL_SMTP_USER"/);
  assert.match(wrangler, /"GMAIL_SMTP_APP_PASSWORD"/);
});

test("task cards show notes and every edit sends a correction email", async () => {
  const [page, route, css] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(routeUrl, "utf8"),
    readFile(cssUrl, "utf8"),
  ]);

  assert.match(page, /className="driver-note"/);
  assert.match(page, /group\.primary\.note \|\| tr\("无", "None"\)/);
  assert.match(css, /\.driver-note\s*\{/);
  assert.match(route, /需要送货\$\{details\.correction \? " 修正" : ""\}/);
  const editTaskBlock = route.match(/if \(body\.action === "editTask"\)[\s\S]*?return Response\.json\(\{ ok: true, emailSent, emailError \}\);/)?.[0] ?? "";
  assert.match(editTaskBlock, /await sendDeliveryEmail\(\{/);
  assert.match(editTaskBlock, /correction: true/);
  assert.match(editTaskBlock, /emailSent \? "邮件通知" : "邮件失败"/);
  assert.match(page, /const result = await mutate\(\{[\s\S]*?action: "editTask"/);
  assert.match(page, /修正邮件已发送给司机/);
});

test("orders persist an estimated delivery time between 9 AM and 5 PM", async () => {
  const [page, route, schema, migration] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(routeUrl, "utf8"),
    readFile(schemaUrl, "utf8"),
    readFile(deliveryTimeMigrationUrl, "utf8"),
  ]);

  assert.match(page, /Array\.from\(\{ length: 9 \}/);
  assert.match(page, /name="deliveryTime" defaultValue="09:00" required/);
  assert.match(page, /deliveryTime: form\.get\("deliveryTime"\)/);
  assert.match(page, /group\.primary\.delivery_time/);
  assert.match(page, /editingTask\.primary\.delivery_time \|\| "09:00"/);
  assert.match(route, /\^\(09\|1\[0-7\]\):00\$/);
  assert.match(route, /INSERT INTO orders \(order_group, sales_rep, customer, phone, address, delivery_time, sku, quantity, note\)/);
  assert.match(route, /预计送达时间：\$\{formatDeliveryTime\(details\.deliveryTime\)\}/);
  assert.match(schema, /deliveryTime: text\("delivery_time"\)/);
  assert.match(migration, /ALTER TABLE `orders` ADD `delivery_time` text/);
});

test("delivery history lists all completed tasks and filters by completion date", async () => {
  const [page, route, css, schema] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(routeUrl, "utf8"),
    readFile(cssUrl, "utf8"),
    readFile(schemaUrl, "utf8"),
  ]);

  assert.match(page, /"driver" \| "history" \| "log"/);
  assert.match(page, /deliveryHistory: Order\[\]/);
  assert.match(page, /\["history", tr\("送货历史", "History"\)/);
  assert.match(page, /const \[historyStart, setHistoryStart\] = useState\(""\)/);
  assert.match(page, /const \[historyEnd, setHistoryEnd\] = useState\(""\)/);
  assert.match(page, /databaseTimestamp\(group\.primary\.delivered_at\)/);
  assert.match(page, /view === "history"/);
  assert.match(page, /type="date"[\s\S]*?value=\{historyStart\}/);
  assert.match(page, /type="date"[\s\S]*?value=\{historyEnd\}/);
  assert.match(page, /className="driver-grid history-grid"/);
  assert.match(route, /WHERE status = 'delivered' ORDER BY delivered_at DESC, id DESC/);
  assert.match(route, /deliveryHistory: deliveryHistory\.results/);
  assert.match(route, /CREATE INDEX IF NOT EXISTS idx_orders_status_delivered_at/);
  assert.match(schema, /index\("idx_orders_status_delivered_at"\)\.on\(table\.status, table\.deliveredAt\)/);
  assert.match(css, /\.history-filters\s*\{/);
  assert.match(css, /\.history-status\s*\{/);
});
