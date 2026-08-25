package model

// BuildRetentionGlobal 构建记录保留条数（平台级全局配置，单行 ID=1）。
// 每条流水线保留最近 N 条构建（含各阶段日志），超出部分在构建完成后自动清理。
// 默认值 10；通过 /api/settings/build-retention 读写。
type BuildRetentionGlobal struct {
	ID        uint   `gorm:"primarykey" json:"-"`
	Keep      int    `json:"keep"` // 每条流水线保留的最近构建条数（下限 1）
	UpdatedAt string `json:"updatedAt"`
}

// TableName 显式指定表名，避免 GORM 复数推断差异。
func (BuildRetentionGlobal) TableName() string { return "build_retention_global" }
