import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app/page.tsx", import.meta.url);
const routeUrl = new URL("../app/api/inventory/route.ts", import.meta.url);
const cssUrl = new URL("../app/globals.css", import.meta.url);

test("receive-stock confirmation supports receipt and ordering", async () => {
  const page = await readFile(pageUrl, "utf8");

  assert.match(page, /type ArrivalMode = "received" \| "ordered"/);
  assert.match(page, /action: "arrival", mode: arrivalMode/);
  assert.match(page, /value="received"/);
  assert.match(page, /value="ordered"/);
  assert.match(page, /确认订购/);
  assert.match(page, /不增加库存，标记为订购中/);
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

test("ordering preserves on-hand stock and direct status changes remain admin-only", async () => {
  const route = await readFile(routeUrl, "utf8");

  assert.match(route, /VALUES \(\?, \?, '订购中', 0, CURRENT_TIMESTAMP\)/);
  assert.match(route, /ON CONFLICT\(sku\) DO UPDATE SET[\s\S]*status = '订购中'/);
  assert.doesNotMatch(
    route.match(/const inventoryStatements = mode === "ordered"[\s\S]*?: items\.map/)?.[0] ?? "",
    /on_hand\s*=\s*on_hand\s*\+/,
  );

  const setStatusBlock = route.match(/if \(body\.action === "setStatus"\)[\s\S]*?return Response\.json\(\{ ok: true \}\);/)?.[0] ?? "";
  assert.match(setStatusBlock, /if \(!await isAdminRequest\(request\)\) return error\("需要管理员权限", 403\)/);
  assert.match(setStatusBlock, /"订购中"/);
});
