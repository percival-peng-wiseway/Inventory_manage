CREATE TABLE `stock_losses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sku` text NOT NULL,
	`quantity` integer NOT NULL,
	`reason` text NOT NULL,
	`actor` text DEFAULT '管理员' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_stock_losses_sku_created_at` ON `stock_losses` (`sku`,`created_at`);