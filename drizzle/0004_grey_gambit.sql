ALTER TABLE `inventory` ADD `ordered_quantity` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
WITH `ordered_events` AS (
	SELECT
		json_extract(`item`.`value`, '$.sku') AS `sku`,
		SUM(
			CASE
				WHEN json_extract(`arrivals`.`items_json`, '$.mode') = 'ordered'
					THEN CAST(json_extract(`item`.`value`, '$.quantity') AS integer)
				ELSE -CAST(json_extract(`item`.`value`, '$.quantity') AS integer)
			END
		) AS `quantity`
	FROM `arrivals`
	JOIN json_each(
		CASE
			WHEN json_type(`arrivals`.`items_json`) = 'array' THEN `arrivals`.`items_json`
			ELSE json_extract(`arrivals`.`items_json`, '$.items')
		END
	) AS `item`
	GROUP BY json_extract(`item`.`value`, '$.sku')
)
UPDATE `inventory`
SET `ordered_quantity` = MAX(
	0,
	COALESCE((SELECT `quantity` FROM `ordered_events` WHERE `ordered_events`.`sku` = `inventory`.`sku`), 0)
)
WHERE `status` = '订购中';
