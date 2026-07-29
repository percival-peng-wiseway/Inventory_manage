CREATE TABLE `arrivals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`raw_text` text NOT NULL,
	`items_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inventory` (
	`sku` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`on_hand` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sales_rep` text NOT NULL,
	`customer` text NOT NULL,
	`phone` text,
	`sku` text NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`address` text,
	`planned_date` text,
	`driver` text,
	`delivered_at` text,
	`note` text
);
