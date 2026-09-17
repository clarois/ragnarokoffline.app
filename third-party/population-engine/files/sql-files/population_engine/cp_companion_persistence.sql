-- Companion persistence table.
-- Snapshots every recruited companion shell so it survives map-server and
-- machine restarts: the engine persists a row at recruit time (party_member_added
-- hook) and recalls all active rows for an owner on login (pc_loadpot hook).
-- `shell_index` is fixed per companion forever; char/account ids derive from it,
-- which is how recall re-identifies a shell without reusing the auto-increment pool.

CREATE TABLE IF NOT EXISTS `cp_companion_persistence` (
           `id`               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
           `owner_account_id` INT UNSIGNED  NOT NULL,
           `shell_index`      INT UNSIGNED  NOT NULL,          -- spawn index_ (char/account id - BASE) -> identity survives restart
           `job_id`           SMALLINT      NOT NULL DEFAULT 0,
           `sex`              TINYINT       NOT NULL DEFAULT 0, -- SEX_MALE/SEX_FEMALE
           `hair_style`       TINYINT       NOT NULL DEFAULT 1,
           `hair_color`       SMALLINT      NOT NULL DEFAULT 0,
           `cloth_color`      SMALLINT      NOT NULL DEFAULT 0,
           `garment_nameid`   INT UNSIGNED  NOT NULL DEFAULT 0,
           `option_`          INT UNSIGNED  NOT NULL DEFAULT 0,
           `weapon_nameid`    INT UNSIGNED  NOT NULL DEFAULT 0,
           `shield_nameid`    INT UNSIGNED  NOT NULL DEFAULT 0,
           `head_top_nameid`  INT UNSIGNED  NOT NULL DEFAULT 0,
           `head_mid_nameid`  INT UNSIGNED  NOT NULL DEFAULT 0,
           `head_bottom_nameid` INT UNSIGNED NOT NULL DEFAULT 0,
           `armor_nameid`     INT UNSIGNED  NOT NULL DEFAULT 0,
           `shoes_nameid`     INT UNSIGNED  NOT NULL DEFAULT 0,
           `base_level`       SMALLINT      NOT NULL DEFAULT 99,
           `job_level`        SMALLINT      NOT NULL DEFAULT 70,
           `str_`             SMALLINT      NOT NULL DEFAULT 100,
           `agi_`             SMALLINT      NOT NULL DEFAULT 100,
           `vit_`             SMALLINT      NOT NULL DEFAULT 100,
           `intl_`            SMALLINT      NOT NULL DEFAULT 100,
           `dex_`             SMALLINT      NOT NULL DEFAULT 100,
           `luk_`             SMALLINT      NOT NULL DEFAULT 100,
           `map_id`           SMALLINT      NOT NULL DEFAULT 0, -- mapindex id of owner at recruit (recall target)
           `active`           TINYINT       NOT NULL DEFAULT 1, -- 1 = recalled on login; 0 = released (Goal 3 sets this)
           `recruited_at`     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                          ON UPDATE CURRENT_TIMESTAMP,
           PRIMARY KEY (`id`),
           UNIQUE KEY `uk_index` (`shell_index`),
           KEY `idx_owner` (`owner_account_id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
