-- 初始表结构。时间均为 Unix 毫秒。

-- 身份：只存公钥和必要元数据
CREATE TABLE identities (
  uid            TEXT PRIMARY KEY,                 -- base32(SHA-256(pubkey)) 前 20 位
  public_key     BLOB NOT NULL UNIQUE,             -- Ed25519 公钥，32 字节
  role           TEXT NOT NULL DEFAULT 'member'
                 CHECK (role IN ('admin', 'moderator', 'member')),
  last_nickname  TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  last_ip        TEXT,                             -- 受 privacy.store_ip 控制
  last_client    TEXT,                             -- 平台 / 版本
  note           TEXT                              -- 管理员备注
);
CREATE INDEX idx_identities_privileged ON identities(role) WHERE role <> 'member';

-- 权限令牌：只存哈希
CREATE TABLE privilege_tokens (
  id          TEXT PRIMARY KEY,                    -- 短 ID，用于列表展示和吊销
  token_hash  BLOB NOT NULL UNIQUE,                -- SHA-256(规范化后的令牌)
  role        TEXT NOT NULL CHECK (role IN ('admin', 'moderator')),
  max_uses    INTEGER NOT NULL DEFAULT 1,          -- 0 表示不限次数
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,                             -- NULL 表示不过期
  created_by  TEXT NOT NULL,                       -- uid 或 'system'
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  note        TEXT
);

-- 封禁：按 UID 或 IP 段
CREATE TABLE bans (
  id          INTEGER PRIMARY KEY,
  uid         TEXT,
  ip_cidr     TEXT,
  reason      TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,                             -- NULL 表示永久
  CHECK (uid IS NOT NULL OR ip_cidr IS NOT NULL)
);
CREATE INDEX idx_bans_uid ON bans(uid);

-- 服务器设置：键值 + JSON 值
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                       -- JSON
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

-- 聊天：只持久化主会议，临时房间的聊天只在内存
CREATE TABLE chat_messages (
  id           INTEGER PRIMARY KEY,
  room_id      TEXT NOT NULL,
  sender_uid   TEXT,
  sender_name  TEXT NOT NULL,
  body         TEXT NOT NULL,
  reply_to     INTEGER,
  created_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX idx_chat_room ON chat_messages(room_id, id);
CREATE INDEX idx_chat_created ON chat_messages(created_at);

-- 邀请码：免服务器密码入场，可附带权限令牌
CREATE TABLE invites (
  code        TEXT PRIMARY KEY,
  grants      TEXT NOT NULL DEFAULT '{}',          -- JSON：{bypass_password, token_id}
  max_uses    INTEGER NOT NULL DEFAULT 0,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- 审计日志
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  actor_uid  TEXT,                                 -- NULL 表示系统或 CLI
  action     TEXT NOT NULL,                        -- 如 token.redeem、user.set_role、settings.update
  target     TEXT,
  detail     TEXT,                                 -- JSON
  ip         TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);

-- 服务器元数据：server_id、创建时间等
CREATE TABLE server_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
