// Package logging 提供一个轻量的结构化日志器。
//
// 特性：按级别过滤、键值对字段（输出时按键排序）、敏感字段自动脱敏、
// 可选写入文件并在超过 8MB 时按时间戳轮转。日志行格式为
// “时间 级别 消息 key=value ...”。
package logging

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Level 是日志级别，值越小越详细。
type Level int

// 日志级别，从最详细到最安静。
const (
	LevelDebug  Level = iota // 调试
	LevelInfo                // 常规信息（默认）
	LevelWarn                // 警告
	LevelError               // 错误
	LevelSilent              // 关闭所有输出
)

// String 返回级别的大写名称，如 "INFO"。
func (l Level) String() string {
	switch l {
	case LevelDebug:
		return "DEBUG"
	case LevelInfo:
		return "INFO"
	case LevelWarn:
		return "WARN"
	case LevelError:
		return "ERROR"
	default:
		return "SILENT"
	}
}

// ParseLevel 把字符串解析为日志级别，接受 debug/info/warn(warning)/error/silent(off)，
// 无法识别时回落到 LevelInfo。
func ParseLevel(s string) Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return LevelDebug
	case "info", "":
		return LevelInfo
	case "warn", "warning":
		return LevelWarn
	case "error":
		return LevelError
	case "silent", "off":
		return LevelSilent
	}
	return LevelInfo
}

var sensitiveKeys = []string{
	"password", "passwd", "passphrase", "key", "keydata", "secret",
	"token", "authorization", "cookie", "privatekey",
}

func redact(key string, val any) string {
	k := strings.ToLower(key)
	for _, s := range sensitiveKeys {
		if strings.Contains(k, s) {
			return "***"
		}
	}
	return fmt.Sprint(val)
}

const maxFileSize = 8 << 20

// Logger 是一个并发安全的日志器。默认输出到 stdout，可通过 SetFile 追加文件输出。
type Logger struct {
	mu    sync.Mutex
	out   io.Writer
	file  *os.File
	path  string
	size  int64
	level Level
}

// New 创建一个写入 stdout 的日志器，仅输出不低于 level 的日志。
func New(level Level) *Logger {
	return &Logger{out: os.Stdout, level: level}
}

// SetFile 追加一个日志文件输出（目录自动创建，权限 0600）。
// path 为空时不做任何事。文件名变化时替换当前文件句柄。
func (l *Logger) SetFile(path string) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	var size int64
	if fi, err := f.Stat(); err == nil {
		size = fi.Size()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.file, l.path, l.size = f, path, size
	return nil
}

// Path 返回当前日志文件路径，未配置文件时为空字符串。
func (l *Logger) Path() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.path
}

// Close 关闭日志文件句柄。日志器仍可继续向 stdout 输出。
func (l *Logger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		_ = l.file.Close()
		l.file, l.path, l.size = nil, "", 0
	}
}

// Debug 记录调试级日志。kv 为交替的键值对。
func (l *Logger) Debug(msg string, kv ...any) { l.log(LevelDebug, msg, kv) }

// Info 记录信息级日志。
func (l *Logger) Info(msg string, kv ...any) { l.log(LevelInfo, msg, kv) }

// Warn 记录警告级日志。
func (l *Logger) Warn(msg string, kv ...any) { l.log(LevelWarn, msg, kv) }

// Error 记录错误级日志。
func (l *Logger) Error(msg string, kv ...any) { l.log(LevelError, msg, kv) }

func (l *Logger) log(level Level, msg string, kv []any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if level < l.level || l.level == LevelSilent {
		return
	}
	var sb strings.Builder
	sb.WriteString(time.Now().Format("2006-01-02 15:04:05.000"))
	sb.WriteByte(' ')
	sb.WriteString(level.String())
	sb.WriteByte(' ')
	sb.WriteString(msg)
	if len(kv) > 0 {
		n := len(kv) / 2
		fields := make([]string, 0, n)
		for i := 0; i+1 < len(kv); i += 2 {
			key := fmt.Sprint(kv[i])
			fields = append(fields, key+"="+quote(redact(key, kv[i+1])))
		}
		if len(kv)%2 == 1 {
			fields = append(fields, fmt.Sprint(kv[len(kv)-1])+"=")
		}
		sort.Strings(fields)
		for _, f := range fields {
			sb.WriteByte(' ')
			sb.WriteString(f)
		}
	}
	sb.WriteByte('\n')
	line := sb.String()
	_, _ = io.WriteString(l.out, line)
	l.writeFile(line)
}

func (l *Logger) writeFile(line string) {
	if l.file == nil {
		return
	}
	if l.size > maxFileSize {
		_ = l.file.Close()
		rotated := l.path + "." + time.Now().Format("150405")
		_ = os.Rename(l.path, rotated)
		f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			l.file, l.size = nil, 0
			return
		}
		l.file, l.size = f, 0
	}
	n, _ := io.WriteString(l.file, line)
	l.size += int64(n)
}

func quote(s string) string {
	if s == "" {
		return `""`
	}
	if strings.ContainsAny(s, " \t\"") {
		return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
	}
	return s
}

// DefaultFile 返回配置目录下约定的默认日志文件路径（<configDir>/logs/qxssh.log）。
func DefaultFile(configDir string) string {
	if configDir == "" {
		return ""
	}
	return filepath.Join(configDir, "logs", "qxssh.log")
}
