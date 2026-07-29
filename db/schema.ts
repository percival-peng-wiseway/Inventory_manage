import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const inventory = sqliteTable("inventory", {
  sku: text("sku").primaryKey(),
  category: text("category").notNull(),
  onHand: integer("on_hand").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  salesRep: text("sales_rep").notNull(),
  customer: text("customer").notNull(),
  phone: text("phone"),
  sku: text("sku").notNull(),
  quantity: integer("quantity").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  status: text("status").notNull().default("pending"),
  address: text("address"),
  plannedDate: text("planned_date"),
  driver: text("driver"),
  deliveredAt: text("delivered_at"),
  note: text("note"),
});

export const arrivals = sqliteTable("arrivals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  rawText: text("raw_text").notNull(),
  itemsJson: text("items_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
