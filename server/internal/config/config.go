package config

import (
	"os"
	"path/filepath"
)

// Config 从环境变量加载，支持本地 SQLite / 生产 MySQL 切换
type Config struct {
	Port        string
	DBDriver    string // sqlite | mysql
	DBDSN       string // sqlite: 文件路径; mysql: user:pass@tcp(host:port)/db?charset=utf8mb4&parseTime=True
	JWTSecret   string
	FrontendURL string
}

func Load() *Config {
	cfg := &Config{
		Port:        getenv("PORT", "8088"),
		DBDriver:    getenv("DB_DRIVER", "sqlite"),
		DBDSN:       getenv("DB_DSN", "kubehelm.db"),
		JWTSecret:   getenv("JWT_SECRET", "kubehelm-dev-secret-change-in-prod"),
		FrontendURL: getenv("FRONTEND_URL", "http://127.0.0.1:5173"),
	}
	// 相对 DB_DSN 始终基于可执行文件所在目录解析，避免「启动 CWD 不同 → 落到不同库文件」导致数据丢失
	cfg.DBDSN = resolveDSN(cfg.DBDSN)
	return cfg
}

// resolveDSN 把相对路径解析为「可执行文件目录 + 文件名」，绝对路径原样返回
func resolveDSN(dsn string) string {
	if dsn == "" {
		return dsn
	}
	if filepath.IsAbs(dsn) {
		return dsn
	}
	if exe, err := os.Executable(); err == nil {
		return filepath.Join(filepath.Dir(exe), dsn)
	}
	if abs, err := filepath.Abs(dsn); err == nil {
		return abs
	}
	return dsn
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
