// Package store 封装 SQLite 访问：连接参数、迁移、备份和各表的读写。
//
// 写连接只开一个（SQLite 同一时刻只允许一个写事务），读连接单独开一个池。
// 时间统一用 Unix 毫秒存储。
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/karllee830/OpenHane/server/migrations"
)

const FileName = "openhane.db"

type Store struct {
	w   *sql.DB // 写连接（唯一）
	r   *sql.DB // 读连接池
	dir string
	log *slog.Logger
	now func() time.Time
}

// ErrNotFound 表示记录不存在。
var ErrNotFound = errors.New("not found")

func dsn(path string, readOnly bool) string {
	q := []string{
		"_pragma=journal_mode(WAL)",
		"_pragma=synchronous(NORMAL)",
		"_pragma=foreign_keys(ON)",
		"_pragma=busy_timeout(5000)",
		"_pragma=temp_store(MEMORY)",
		"_txlock=immediate",
	}
	if readOnly {
		q = append(q, "_pragma=query_only(ON)")
	}
	return "file:" + path + "?" + strings.Join(q, "&")
}

// checkWritable 提前检查数据目录可写，给出比 SQLite 的「unable to open database file (14)」更明确的提示。
func checkWritable(dataDir string) error {
	f, err := os.CreateTemp(dataDir, ".writecheck-*")
	if err != nil {
		return fmt.Errorf("数据目录 %s 不可写（当前进程 uid=%d gid=%d）：%w\n"+
			"Docker 部署：以 root 启动容器（镜像默认），程序会自动修正目录属主后降权运行；"+
			"如果用 --user / user: 指定了用户，请把宿主机上的数据目录属主改成该用户", dataDir, os.Getuid(), os.Getgid(), err)
	}
	f.Close()
	return os.Remove(f.Name())
}

// Open 打开（或创建）数据目录下的数据库，并执行未完成的迁移。
func Open(ctx context.Context, dataDir string, log *slog.Logger) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	if err := checkWritable(dataDir); err != nil {
		return nil, err
	}
	path := filepath.Join(dataDir, FileName)
	w, err := sql.Open("sqlite", dsn(path, false))
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	w.SetConnMaxIdleTime(0)
	if err := w.PingContext(ctx); err != nil {
		w.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	s := &Store{w: w, dir: dataDir, log: log, now: time.Now}
	if err := s.migrate(ctx); err != nil {
		w.Close()
		return nil, err
	}
	r, err := sql.Open("sqlite", dsn(path, true))
	if err != nil {
		w.Close()
		return nil, err
	}
	r.SetMaxOpenConns(4)
	s.r = r
	return s, nil
}

func (s *Store) Close() error {
	return errors.Join(s.r.Close(), s.w.Close())
}

func (s *Store) nowMs() int64 { return s.now().UnixMilli() }

// SetClock 仅供测试使用。
func (s *Store) SetClock(now func() time.Time) { s.now = now }

// Ping 检查数据库是否可用（/readyz）。
func (s *Store) Ping(ctx context.Context) error {
	var one int
	return s.r.QueryRowContext(ctx, "SELECT 1").Scan(&one)
}

type migration struct {
	version int
	name    string
}

func listMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return nil, err
	}
	var out []migration
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		num, _, ok := strings.Cut(e.Name(), "_")
		v, err := strconv.Atoi(num)
		if !ok || err != nil || v <= 0 {
			return nil, fmt.Errorf("bad migration file name %q", e.Name())
		}
		out = append(out, migration{v, e.Name()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	for i, m := range out {
		if m.version != i+1 {
			return nil, fmt.Errorf("migration versions must be contiguous, got %q at position %d", m.name, i+1)
		}
	}
	return out, nil
}

// SchemaVersion 返回当前数据库的迁移版本。
func (s *Store) SchemaVersion(ctx context.Context) (int, error) {
	var v int
	err := s.w.QueryRowContext(ctx, "PRAGMA user_version").Scan(&v)
	return v, err
}

func (s *Store) migrate(ctx context.Context) error {
	all, err := listMigrations()
	if err != nil {
		return err
	}
	cur, err := s.SchemaVersion(ctx)
	if err != nil {
		return err
	}
	if cur > len(all) {
		return fmt.Errorf("数据库版本 %d 比本程序支持的 %d 更新：不支持降级，请使用更新的版本或从备份恢复", cur, len(all))
	}
	if cur == len(all) {
		return nil
	}
	if cur > 0 {
		// 迁移前自动备份（全新数据库不需要）
		out := filepath.Join(s.dir, "backups", fmt.Sprintf("pre-migrate-%d.db", cur))
		if err := s.Backup(ctx, out); err != nil {
			return fmt.Errorf("pre-migration backup: %w", err)
		}
		s.log.Info("database backed up before migration", "path", out)
	}
	for _, m := range all[cur:] {
		script, err := fs.ReadFile(migrations.FS, m.name)
		if err != nil {
			return err
		}
		tx, err := s.w.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(script)); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %s: %w", m.name, err)
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", m.version)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("migration %s: %w", m.name, err)
		}
		s.log.Info("database migrated", "version", m.version, "script", m.name)
	}
	return nil
}

// Backup 用 VACUUM INTO 生成一致的在线备份（不需要停服）。目标文件已存在时报错。
func (s *Store) Backup(ctx context.Context, out string) error {
	if err := os.MkdirAll(filepath.Dir(out), 0o700); err != nil {
		return err
	}
	if _, err := os.Stat(out); err == nil {
		return fmt.Errorf("backup target %s already exists", out)
	}
	_, err := s.w.ExecContext(ctx, "VACUUM INTO ?", out)
	return err
}

// DailyBackup 生成当天的自动备份（已存在则跳过），并只保留最近 keep 份。
func (s *Store) DailyBackup(ctx context.Context, keep int) error {
	if keep <= 0 {
		return nil
	}
	dir := filepath.Join(s.dir, "backups")
	out := filepath.Join(dir, "openhane-"+s.now().Format("20060102")+".db")
	if _, err := os.Stat(out); err != nil {
		if err := s.Backup(ctx, out); err != nil {
			return err
		}
	}
	matches, err := filepath.Glob(filepath.Join(dir, "openhane-*.db"))
	if err != nil {
		return err
	}
	sort.Strings(matches) // 文件名带日期，字典序即时间顺序
	for len(matches) > keep {
		if err := os.Remove(matches[0]); err != nil {
			return err
		}
		matches = matches[1:]
	}
	return nil
}

// Maintain 定期维护：更新查询计划统计、截断 WAL。
func (s *Store) Maintain(ctx context.Context) error {
	_, err := s.w.ExecContext(ctx, "PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);")
	return err
}

// ---------- server_meta ----------

func (s *Store) GetMeta(ctx context.Context, key string) (string, error) {
	var v string
	err := s.r.QueryRowContext(ctx, "SELECT value FROM server_meta WHERE key = ?", key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return v, err
}

// GetOrInitMeta 读取元数据；不存在时写入 init() 的结果。
func (s *Store) GetOrInitMeta(ctx context.Context, key string, init func() string) (string, error) {
	if _, err := s.w.ExecContext(ctx, "INSERT OR IGNORE INTO server_meta(key, value) VALUES(?, ?)", key, init()); err != nil {
		return "", err
	}
	var v string
	err := s.w.QueryRowContext(ctx, "SELECT value FROM server_meta WHERE key = ?", key).Scan(&v)
	return v, err
}

// SetMeta 写入（覆盖）元数据。
func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	_, err := s.w.ExecContext(ctx, "INSERT INTO server_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
	return err
}

func nullInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: v != 0} }

func nullStr(v string) sql.NullString { return sql.NullString{String: v, Valid: v != ""} }
