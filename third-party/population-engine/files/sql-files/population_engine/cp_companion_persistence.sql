-- Companion persistence table (v3): adds `name` and accessories — the shell's generated name
-- is snapshotted at recruit time and restored on recall, so companions keep
-- their identity across restarts (name/job/sex otherwise re-roll every boot).
CREATE TABLE IF NOT EXISTS `cp_companion_persistence` (
           `id`               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
           `owner_account_id` INT UNSIGNED  NOT NULL,
           `shell_index`      INT UNSIGNED  NOT NULL,          -- spawn index_ (char/account id - BASE) -> identity survives restart
           `name`             VARCHAR(24)   NOT NULL DEFAULT '',-- persistent display name (v2)
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
           `acc_l_nameid`     INT UNSIGNED  NOT NULL DEFAULT 0, -- accessory left (Goal 2)
           `acc_r_nameid`     INT UNSIGNED  NOT NULL DEFAULT 0, -- accessory right (Goal 2)
           `base_level`       SMALLINT      NOT NULL DEFAULT 99,
           `job_level`        SMALLINT      NOT NULL DEFAULT 70,
           `str_`             SMALLINT      NOT NULL DEFAULT 100,
           `agi_`             SMALLINT      NOT NULL DEFAULT 100,
           `vit_`             SMALLINT      NOT NULL DEFAULT 100,
           `intl_`            SMALLINT      NOT NULL DEFAULT 100,
           `dex_`             SMALLINT      NOT NULL DEFAULT 100,
           `luk_`             SMALLINT      NOT NULL DEFAULT 100,
           `map_id`           SMALLINT      NOT NULL DEFAULT 0, -- mapindex id of owner at recruit (recall target)
           `active`           TINYINT       NOT NULL DEFAULT 1, -- 1 = recalled on login; 0 = expelled/released (Goal 3)
           `favorite`         TINYINT       NOT NULL DEFAULT 0, -- 1 = owner favorited (friend list sort)
           `recruited_at`     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                          ON UPDATE CURRENT_TIMESTAMP,
           PRIMARY KEY (`id`),
           UNIQUE KEY `uk_index` (`shell_index`),
           KEY `idx_owner` (`owner_account_id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;