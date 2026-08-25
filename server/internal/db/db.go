package db

import (
	"log"

	"kubehelm/server/internal/config"
	"kubehelm/server/internal/model"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Init 按驱动初始化 GORM，并执行 AutoMigrate（SQLite / MySQL 通用字段，避免方言冲突）
func Init(cfg *config.Config) *gorm.DB {
	var dialector gorm.Dialector
	switch cfg.DBDriver {
	case "mysql":
		dialector = mysql.Open(cfg.DBDSN)
	default:
		dialector = sqlite.Open(cfg.DBDSN)
	}

	database, err := gorm.Open(dialector, &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		log.Fatalf("db: open failed: %v", err)
	}
	if err := database.AutoMigrate(model.AllModels()...); err != nil {
		log.Fatalf("db: migrate failed: %v", err)
	}
	return database
}
