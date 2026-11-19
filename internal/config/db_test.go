package config

import (
	"os"
	"path/filepath"
	"testing"
)

// TestMasterKeyWrapRoundtrip 验证 Argon2id 包裹的往返与错误口令拒绝（QX-004）。
func TestMasterKeyWrapRoundtrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	blob, err := wrapMasterKey(key, "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	got, err := unwrapMasterKey(blob, "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(key) {
		t.Fatal("roundtrip mismatch")
	}
	if _, err := unwrapMasterKey(blob, "wrong"); err == nil {
		t.Fatal("wrong passphrase accepted")
	}
}

// TestResolveMasterKeyMigration 验证旧库内明文密钥迁移到独立文件、
// 二次加载、口令升级包裹与错误口令 fail-closed（QX-004）。
func TestResolveMasterKeyMigration(t *testing.T) {
	dir := t.TempDir()
	path := dbPath(dir)
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	old := make([]byte, 32)
	for i := range old {
		old[i] = byte(i + 1)
	}
	if err := metaSet(db, metaMasterKey, old); err != nil {
		t.Fatal(err)
	}

	t.Setenv(masterPassEnv, "")
	got, err := resolveMasterKey(db, path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(old) {
		t.Fatal("migration key mismatch")
	}
	if _, ok, _ := metaGet(db, metaMasterKey); ok {
		t.Fatal("legacy meta row not removed")
	}
	raw, err := os.ReadFile(filepath.Join(dir, masterKeyFile))
	if err != nil || len(raw) != 32 {
		t.Fatalf("key file: %v len=%d", err, len(raw))
	}

	// 二次加载走密钥文件。
	got2, err := resolveMasterKey(db, path)
	if err != nil || string(got2) != string(old) {
		t.Fatalf("reload: %v", err)
	}

	// 设置口令后裸文件自动升级包裹。
	t.Setenv(masterPassEnv, "test-pass")
	got3, err := resolveMasterKey(db, path)
	if err != nil || string(got3) != string(old) {
		t.Fatalf("upgrade: %v", err)
	}
	raw2, err := os.ReadFile(filepath.Join(dir, masterKeyFile))
	if err != nil || string(raw2[:len(masterWrapMagic)]) != masterWrapMagic {
		t.Fatalf("not wrapped after upgrade: %v", err)
	}

	// 错误口令 fail-closed。
	t.Setenv(masterPassEnv, "bad")
	if _, err := resolveMasterKey(db, path); err == nil {
		t.Fatal("wrong passphrase accepted")
	}

	// 无口令读包裹文件同样拒绝。
	t.Setenv(masterPassEnv, "")
	if _, err := resolveMasterKey(db, path); err == nil {
		t.Fatal("wrapped key accepted without passphrase")
	}
}
