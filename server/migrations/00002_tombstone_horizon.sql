-- 墓碑清理水位：该用户 change_seq ≤ 此值的墓碑可能已被物理删除。
-- 客户端游标落在 (0, 水位) 之间时，增量同步会漏掉被清理的删除，必须全量重新拉取（设计文档 6.4）。

-- +goose Up
ALTER TABLE users ADD COLUMN tombstones_purged_through bigint NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE users DROP COLUMN tombstones_purged_through;
