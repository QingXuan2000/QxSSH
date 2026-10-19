package config

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"

	_ "modernc.org/sqlite"
)

const (
	dbFile = "data.db"

	schemaVersion = 1

	metaMasterKey = "master_key"
	metaSchemaVer = "schema_version"
)

var errNoDB = errors.New("配置数据库不可用")

// schemaStatements 是建表语句集合，以 IF NOT EXISTS 保证幂等。
var schemaStatements = []string{
	`CREATE TABLE IF NOT EXISTS meta (
		key   TEXT PRIMARY KEY,
		value BLOB NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS hosts (
		id             TEXT PRIMARY KEY,
		ord            INTEGER NOT NULL DEFAULT 0,
		name           TEXT NOT NULL DEFAULT '',
		grp            TEXT NOT NULL DEFAULT '',
		address        TEXT NOT NULL DEFAULT '',
		port           INTEGER NOT NULL DEFAULT 22,
		username       TEXT NOT NULL DEFAULT '',
		auth_type      TEXT NOT NULL DEFAULT 'password',
		password       TEXT NOT NULL DEFAULT '',
		key_data       TEXT NOT NULL DEFAULT '',
		key_path       TEXT NOT NULL DEFAULT '',
		key_passphrase TEXT NOT NULL DEFAULT '',
		note           TEXT NOT NULL DEFAULT '',
		jump_host_id   TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE TABLE IF NOT EXISTS app_grants (
		app_id  TEXT NOT NULL,
		perm    TEXT NOT NULL,
		granted TEXT NOT NULL,
		PRIMARY KEY (app_id, perm)
	)`,

	// app_scopes 是应用细粒度权限授权映射表，遵循零默认权限原则，默认空集，由用户显式授权。
	`CREATE TABLE IF NOT EXISTS app_scopes (
		app_id     TEXT NOT NULL,
		scope      TEXT NOT NULL,
		granted    INTEGER NOT NULL,
		granted_by TEXT NOT NULL DEFAULT '',
		expires_at INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (app_id, scope)
	)`,

	// app_prefs 是应用专属私有偏好表，按应用严格隔离存储。
	`CREATE TABLE IF NOT EXISTS app_prefs (
		app_id TEXT NOT NULL,
		key    TEXT NOT NULL,
		value  TEXT NOT NULL,
		PRIMARY KEY (app_id, key)
	)`,

	`CREATE TABLE IF NOT EXISTS app_state (
		app_id   TEXT PRIMARY KEY,
		disabled INTEGER NOT NULL DEFAULT 0
	)`,

	// app_token_epoch 是「应用令牌世代」：每次整体撤销（禁用、卸载、按应用吊销、
	// 撤销权限）都会递增。令牌里携带签发时的世代号，校验时世代不符即视为已撤销，
	// 因此撤销不需要保存令牌本身，也不必逐条黑名单。
	`CREATE TABLE IF NOT EXISTS app_token_epoch (
		app_id TEXT PRIMARY KEY,
		epoch  INTEGER NOT NULL DEFAULT 0
	)`,

	// app_refresh 保存刷新令牌（不透明随机串）。刷新令牌是长期凭据，
	// 轮换时旧行置 revoked=1，重复使用已轮换的旧令牌即视为泄露信号。
	`CREATE TABLE IF NOT EXISTS app_refresh (
		token        TEXT PRIMARY KEY,
		app_id       TEXT NOT NULL,
		jti          TEXT NOT NULL,
		rot_from     TEXT NOT NULL DEFAULT '',
		exp          INTEGER NOT NULL,
		revoked      INTEGER NOT NULL DEFAULT 0,
		last_use     INTEGER NOT NULL DEFAULT 0,
		created_at   INTEGER NOT NULL DEFAULT 0,
		extra_scopes TEXT NOT NULL DEFAULT ''
	)`,

	`CREATE INDEX IF NOT EXISTS idx_app_refresh_app ON app_refresh (app_id)`,

	`CREATE TABLE IF NOT EXISTS prefs (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS schedules (
		id         TEXT PRIMARY KEY,
		app_id     TEXT NOT NULL,
		host       TEXT NOT NULL,
		name       TEXT NOT NULL DEFAULT '',
		argv       TEXT NOT NULL,
		cwd        TEXT NOT NULL DEFAULT '',
		cron       TEXT NOT NULL,
		enabled    INTEGER NOT NULL DEFAULT 1,
		created_at INTEGER NOT NULL DEFAULT 0,
		last_run   INTEGER NOT NULL DEFAULT 0,
		last_job   TEXT NOT NULL DEFAULT '',
		last_err   TEXT NOT NULL DEFAULT ''
	)`,

	`CREATE TABLE IF NOT EXISTS app_secrets (
		app_id     TEXT NOT NULL,
		key        TEXT NOT NULL,
		value      TEXT NOT NULL,
		updated_at INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (app_id, key)
	)`,
}

// dropStatements 清理历史版本遗留的废弃表/索引。
var dropStatements = []string{
	`DROP INDEX IF EXISTS audit_by_host`,
	`DROP INDEX IF EXISTS audit_by_app`,
	`DROP INDEX IF EXISTS audit_by_time`,
	`DROP INDEX IF EXISTS audit_archive_by_host`,
	`DROP TABLE IF EXISTS audit_archive`,
	`DROP TABLE IF EXISTS audit`,
}

// openDB 以 WAL、busy_timeout 等 pragma 打开（必要时创建）SQLite 数据库并建表。
func openDB(path string) (*sql.DB, error) {

	dsn := "file:" + filepath.ToSlash(path) +
		"?_pragma=busy_timeout(5000)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=synchronous(NORMAL)" +
		"&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}

	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("打开数据库 %s 失败: %w", path, err)
	}
	for _, stmt := range schemaStatements {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("建表失败: %w", err)
		}
	}
	for _, stmt := range dropStatements {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("清理废弃表失败: %w", err)
		}
	}
	// 兼容迁移：如果已有 app_refresh 表未含 extra_scopes 列，补齐该列
	_, _ = db.Exec("ALTER TABLE app_refresh ADD COLUMN extra_scopes TEXT NOT NULL DEFAULT ''")
	// 清理历史残留的临时授权数据（旧实现遗留的 consent_session，真·本次允许不再写入数据库）
	_, _ = db.Exec("DELETE FROM app_scopes WHERE granted_by = 'consent_session' OR expires_at > 0")
	return db, nil
}

func metaGet(db *sql.DB, key string) ([]byte, bool, error) {
	var v []byte
	err := db.QueryRow(`SELECT value FROM meta WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return v, true, nil
}

func metaSet(db *sql.DB, key string, val []byte) error {
	_, err := db.Exec(`INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, val)
	return err
}

func schemaTooNew(db *sql.DB) (int, bool, error) {
	raw, ok, err := metaGet(db, metaSchemaVer)
	if err != nil || !ok {
		return 0, false, err
	}
	var v int
	if _, err := fmt.Sscanf(string(raw), "%d", &v); err != nil {
		return 0, false, nil
	}
	return v, v > schemaVersion, nil
}

func ensureSchemaVersion(db *sql.DB) error {
	return metaSet(db, metaSchemaVer, []byte(fmt.Sprintf("%d", schemaVersion)))
}

// resolveMasterKey 读取数据库中的主密钥；不存在时随机生成 32 字节并持久化。
// 主密钥用于加密主机凭据与应用机密。
func resolveMasterKey(db *sql.DB) ([]byte, error) {
	if raw, ok, err := metaGet(db, metaMasterKey); err != nil {
		return nil, err
	} else if ok && len(raw) == 32 {
		return raw, nil
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := metaSet(db, metaMasterKey, key); err != nil {
		return nil, err
	}
	return key, nil
}

const insertHostSQL = `INSERT INTO hosts
	(id, ord, name, grp, address, port, username, auth_type, password, key_data, key_path, key_passphrase, note, jump_host_id)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		ord = excluded.ord, name = excluded.name, grp = excluded.grp,
		address = excluded.address, port = excluded.port, username = excluded.username,
		auth_type = excluded.auth_type, password = excluded.password,
		key_data = excluded.key_data, key_path = excluded.key_path,
		key_passphrase = excluded.key_passphrase, note = excluded.note,
		jump_host_id = excluded.jump_host_id`

const selectHostCols = `id, name, grp, address, port, username, auth_type,
	password, key_data, key_path, key_passphrase, note, jump_host_id`

func scanHost(rows interface{ Scan(...any) error }) (Host, error) {
	var h Host
	err := rows.Scan(&h.ID, &h.Name, &h.Group, &h.Address, &h.Port, &h.User,
		&h.AuthType, &h.Password, &h.KeyData, &h.KeyPath, &h.KeyPassphrase, &h.Note, &h.JumpHostID)
	return h, err
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func dbPath(dir string) string { return filepath.Join(dir, dbFile) }
